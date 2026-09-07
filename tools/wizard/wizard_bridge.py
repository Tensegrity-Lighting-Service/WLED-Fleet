#!/usr/bin/env python3
"""WiFiman Wizard (Ubiquiti WM-W) -> wled-fleet bridge (roadmap Phase 3, mobile RF probe).

The Wizard is a battery-powered, receive-only 802.11 scanner (MediaTek
MT7931AN, 2.4 + 5 GHz) that streams what it hears over Bluetooth LE. Node has
no native BLE, so this helper does the BLE side with `bleak` (WinRT on
Windows, BlueZ on Linux, CoreBluetooth on macOS) and speaks NDJSON to the
fleet server (wizard.js spawns it and reads stdout line by line).

    python wizard_bridge.py --list                 # BLE devices around, one JSON per line
    python wizard_bridge.py --address AA:BB:...    # connect, stream networks (auto-reconnect)
    python wizard_bridge.py --mock                 # synthetic environment, no hardware, no bleak
    python wizard_bridge.py --address ... --raw    # also emit every raw notification (hex)

Events on stdout (one JSON object per line):
    {"type":"hello","version":1,"mode":"ble"|"mock","bleak":"0.22.3"|null}
    {"type":"status","state":"scanning|connecting|connected|disconnected|stopped","address":..,"name":..,"firmware":..,"battery":..,"decoder":..}
    {"type":"network","t":ms,"bssid":..,"ssid":..,"freq":MHz,"channel":n,"width":20|40|80,"signal":dBm,"band":"2g"|"5g","security":..,"std":..}
    {"type":"device","address":..,"name":..,"rssi":..,"services":[..]}      (--list)
    {"type":"raw","char":uuid,"hex":..}                                      (--raw)
    {"type":"error","code":"no_bleak|not_found|connect|decode|...","message":..}
Commands on stdin (one JSON object per line): {"cmd":"quit"} {"cmd":"disconnect"}

The proprietary BLE protocol is NOT public: everything the Wizard sends goes
through wizard_decode.py, which is filled in during the discovery phase
(see ../../docs/wizard-protocol.md). Until then a real connection reports
decoder="none" and only --raw frames come out; --mock exercises the whole
server/UI path without hardware.
"""
import argparse
import asyncio
import json
import os
import random
import sys
import threading
import time

try:
    import wizard_decode as decoder
except ImportError:  # launched through a path that is not on sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import wizard_decode as decoder

PROTOCOL_VERSION = 1
NAME_HINTS = ("wifiman", "wizard", "wm-w", "uws-", "ubnt", "ubiquiti")
# What the real device shows (probe of 2026-09-05, firmware 1.9.0): Ubiquiti OUI, the
# advertised name is a placeholder ("FF:FF:FF:FF:FF:FF"), the GAP name is "UWS-nnn",
# and the advertisement carries the Wizard's own service UUID.
UBNT_OUIS = ("74:fa:29", "24:5a:4c", "68:d7:9a", "e0:63:da", "f4:e2:c6", "78:8a:20", "80:2a:a8", "b4:fb:e4", "fc:ec:da", "d0:21:f9", "70:a7:41", "9c:05:d6", "ac:8b:a9", "28:70:4e", "e4:38:83")
WIZARD_SERVICE_UUID = "e0373cc2-d3bc-4eac-9c6e-423d0fe5d738"


def looks_like_wizard(address, name, service_uuids):
    n = (name or "").lower()
    return (any(h in n for h in NAME_HINTS)
            or (address or "").lower().startswith(UBNT_OUIS)
            or WIZARD_SERVICE_UUID in [str(u).lower() for u in (service_uuids or [])])

_out_lock = threading.Lock()


def emit(obj):
    """One JSON object per line on stdout, flushed immediately (the server reads a pipe)."""
    line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    try:
        with _out_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
    except (BrokenPipeError, OSError):  # the server is gone: nobody listens any more
        os._exit(0)


def now_ms():
    return int(time.time() * 1000)


def bleak_version():
    try:
        import bleak  # noqa: F401
        from importlib.metadata import version
        return version("bleak")
    except Exception:
        return None


# ── stdin command reader (thread, so it works the same with/without an event loop) ──
class Commands:
    def __init__(self):
        self.quit = threading.Event()
        self.disconnect = threading.Event()
        t = threading.Thread(target=self._loop, daemon=True)
        t.start()

    def _loop(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                c = json.loads(line)
            except ValueError:
                continue
            cmd = c.get("cmd")
            if cmd == "quit":
                self.quit.set()
                return
            if cmd == "disconnect":
                self.disconnect.set()
        # stdin closed = the server is gone: stop streaming
        self.quit.set()


# ── mock: a plausible 2.4 / 5 GHz neighbourhood that drifts a little ──────────
MOCK_NETS = [
    # bssid, ssid, freq, width, base dBm, security, std
    ("f4:1e:57:89:7f:45", "ORFOLED", 2452, 20, -48, "WPA2-PSK", "ax"),  # the show's antenna (mock-ap.js, channel 9)
    ("aa:bb:cc:00:00:01", "Voisin-1", 2412, 20, -70, "WPA2-PSK", "n"),
    ("aa:bb:cc:00:00:06", "Voisin-6", 2437, 20, -60, "WPA2-PSK", "ax"),
    ("aa:bb:cc:00:00:0b", "Voisin-11", 2462, 20, -85, "WPA2-PSK", "n"),
    ("aa:bb:cc:00:00:0c", "Box-Salle", 2437, 40, -66, "WPA2-PSK", "n"),
    ("aa:bb:cc:00:00:0d", "", 2417, 20, -78, "WPA2-PSK", "n"),  # hidden
    ("aa:bb:cc:00:00:0e", "Regie-Son", 2472, 20, -72, "WPA3-SAE", "ax"),
    ("aa:bb:cc:00:00:51", "Voisin-5G", 5240, 80, -62, "WPA2-PSK", "ac"),
    ("aa:bb:cc:00:00:52", "ORFOLED", 5240, 80, -55, "WPA2-PSK", "ax"),
]


def chan_of(freq):
    if 2412 <= freq <= 2484:
        return 14 if freq == 2484 else round((freq - 2407) / 5)
    return round((freq - 5000) / 5)


def run_mock(cmds, period=1.0):
    emit({"type": "hello", "version": PROTOCOL_VERSION, "mode": "mock", "bleak": bleak_version()})
    emit({"type": "status", "state": "connecting", "address": "mock", "name": "WiFiman Wizard (mock)"})
    time.sleep(0.4)
    battery = 87
    emit({"type": "status", "state": "connected", "address": "mock", "name": "WiFiman Wizard (mock)", "firmware": "mock", "battery": battery, "decoder": "mock"})
    walk = {n[0]: 0.0 for n in MOCK_NETS}
    tick = 0
    while not cmds.quit.is_set() and not cmds.disconnect.is_set():
        tick += 1
        t = now_ms()
        for bssid, ssid, freq, width, base, sec, std in MOCK_NETS:
            walk[bssid] = max(-12, min(12, walk[bssid] + random.uniform(-1.5, 1.5)))
            # the far neighbour on 11 fades in and out like a real distant AP
            if bssid.endswith(":0b") and tick % 7 in (3, 4):
                continue
            emit({"type": "network", "t": t, "bssid": bssid, "ssid": ssid, "freq": freq, "channel": chan_of(freq), "width": width,
                  "signal": int(round(base + walk[bssid])), "band": "2g" if freq < 3000 else "5g", "security": sec, "std": std})
        if tick % 30 == 0:
            battery = max(5, battery - 1)
            emit({"type": "status", "state": "connected", "address": "mock", "name": "WiFiman Wizard (mock)", "firmware": "mock", "battery": battery, "decoder": "mock"})
        time.sleep(period)
    emit({"type": "status", "state": "disconnected" if cmds.disconnect.is_set() else "stopped", "address": "mock"})


# ── real device through bleak ────────────────────────────────────────────────
async def ble_list(timeout):
    from bleak import BleakScanner
    emit({"type": "status", "state": "scanning", "timeout": timeout})
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for address, (dev, adv) in found.items():
        name = dev.name or adv.local_name or ""
        emit({"type": "device", "address": address, "name": name, "rssi": adv.rssi,
              "services": list(adv.service_uuids or []), "manufacturer": {str(k): v.hex() for k, v in (adv.manufacturer_data or {}).items()},
              "likely": looks_like_wizard(address, name, adv.service_uuids)})
    emit({"type": "status", "state": "stopped"})


async def ble_stream(address, cmds, raw, adapter_timeout=20.0):
    from bleak import BleakClient
    from bleak.exc import BleakError

    backoff = 2.0
    while not cmds.quit.is_set():
        cmds.disconnect.clear()
        emit({"type": "status", "state": "connecting", "address": address})
        try:
            # the Wizard advertises slowly (worse right after a disconnect): wait for one
            # advertisement instead of a fixed-length scan; accept another Wizard by
            # OUI / service UUID if the configured address never shows up
            dev = await decoder.find_device(address, timeout=adapter_timeout * 3,
                                            match=lambda d, a: looks_like_wizard(d.address, d.name or a.local_name, a.service_uuids))
            if dev is None:
                emit({"type": "error", "code": "not_found", "message": f"{address} non vu en BLE (Wizard éteint, hors de portée, ou déjà connecté à un téléphone ?)"})
                raise BleakError("not found")
            disconnected = asyncio.Event()

            def on_disc(_):
                disconnected.set()

            async with BleakClient(dev, disconnected_callback=on_disc, timeout=adapter_timeout) as client:
                info = await decoder.identify(client)
                dec = decoder.Decoder(client, emit_raw=raw, emit=emit)
                name = getattr(dev, "name", None)
                emit({"type": "status", "state": "connected", "address": address, "name": name, "decoder": dec.name, **info})
                if dec.name == "none":
                    emit({"type": "error", "code": "no_decoder", "message": "connecté, mais le protocole du Wizard n'est pas encore décodé : voir docs/wizard-protocol.md (phase 0)"})
                await dec.start()
                backoff = 2.0
                last_batt = time.time()
                while not cmds.quit.is_set() and not cmds.disconnect.is_set() and not disconnected.is_set():
                    for net in dec.drain():
                        emit({"type": "network", "t": now_ms(), **net})
                    if time.time() - last_batt > 60:
                        last_batt = time.time()
                        try:
                            b = await decoder.battery(client)
                            if b is not None:
                                emit({"type": "status", "state": "connected", "address": address, "name": name, "decoder": dec.name, "battery": b, **info})
                        except Exception:
                            pass
                    await asyncio.sleep(0.2)
                await dec.stop()
            emit({"type": "status", "state": "disconnected", "address": address})
            if cmds.disconnect.is_set() or cmds.quit.is_set():
                break
        except asyncio.CancelledError:
            raise
        except Exception as e:  # BleakError, OSError (adapter off), timeouts…
            emit({"type": "error", "code": "connect", "message": str(e)[:300]})
            emit({"type": "status", "state": "disconnected", "address": address})
        # reconnect unless told otherwise
        for _ in range(int(backoff * 5)):
            if cmds.quit.is_set() or cmds.disconnect.is_set():
                break
            await asyncio.sleep(0.2)
        if cmds.disconnect.is_set():
            break
        backoff = min(30.0, backoff * 1.6)
    emit({"type": "status", "state": "stopped", "address": address})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--list", action="store_true", help="list BLE devices and exit")
    ap.add_argument("--address", help="BLE address of the Wizard (from --list)")
    ap.add_argument("--mock", action="store_true", help="synthetic networks, no hardware")
    ap.add_argument("--raw", action="store_true", help="also emit raw notifications (hex)")
    ap.add_argument("--timeout", type=float, default=8.0, help="--list scan duration (s)")
    ap.add_argument("--period", type=float, default=1.0, help="--mock emission period (s)")
    a = ap.parse_args()

    cmds = Commands()
    if a.mock:
        run_mock(cmds, a.period)
        return 0
    bv = bleak_version()
    emit({"type": "hello", "version": PROTOCOL_VERSION, "mode": "ble", "bleak": bv})
    if bv is None:
        emit({"type": "error", "code": "no_bleak", "message": "module Python 'bleak' absent : pip install bleak"})
        return 2
    if a.list:
        try:
            asyncio.run(ble_list(a.timeout))
        except Exception as e:  # no adapter, Bluetooth off, BlueZ absent…
            emit({"type": "error", "code": "adapter", "message": f"adaptateur Bluetooth indisponible : {str(e)[:200] or type(e).__name__}"})
            return 3
        return 0
    if not a.address:
        emit({"type": "error", "code": "usage", "message": "--address requis (ou --list / --mock)"})
        return 2
    try:
        asyncio.run(ble_stream(a.address, cmds, a.raw))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
