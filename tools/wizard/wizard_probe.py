#!/usr/bin/env python3
"""Phase 0 tool: look at a WiFiman Wizard over BLE without knowing its protocol.

    python wizard_probe.py                       # scan 8 s, list devices (Wizard candidates flagged)
    python wizard_probe.py --address AA:BB:..    # connect, dump GATT, read what is readable,
                                                 # subscribe to every notify/indicate char and log frames
    python wizard_probe.py --address .. --write <char-uuid> <hex>   # then also write a command and watch
    python wizard_probe.py --address .. --seconds 120 --log wizard-probe.log

Output: human-readable on stderr, one JSON record per line in --log (default
wizard-probe.log next to this file): {"type":"gatt"|"read"|"notify"|"write",...}.
Replay a log through the decoder later: python wizard_decode.py wizard-probe.log

Requirements: pip install bleak ; Windows 10/11 or Linux (BlueZ) or macOS, a BLE
adapter, the Wizard switched on and NOT connected to the phone (BLE is one
connection at a time; turn the phone's Bluetooth off during the probe).
"""
import argparse
import asyncio
import json
import os
import sys
import time

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


def log_line(fh, rec):
    rec = {"t": int(time.time() * 1000), **rec}
    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    fh.flush()


def say(msg):
    print(msg, file=sys.stderr, flush=True)


async def scan(seconds):
    from bleak import BleakScanner
    say(f"scan BLE {seconds:.0f} s…")
    found = await BleakScanner.discover(timeout=seconds, return_adv=True)
    rows = []
    for address, (dev, adv) in found.items():
        name = dev.name or adv.local_name or ""
        likely = looks_like_wizard(address, name, adv.service_uuids)
        rows.append((likely, adv.rssi or -999, address, name, adv))
    rows.sort(key=lambda r: (not r[0], -r[1]))
    for likely, rssi, address, name, adv in rows:
        mfr = " ".join(f"{k:04x}:{v.hex()}" for k, v in (adv.manufacturer_data or {}).items())
        say(f"{'★' if likely else ' '} {address}  {rssi:4d} dBm  {name!r:32} svc={list(adv.service_uuids or [])} mfr={mfr}")
    if not rows:
        say("aucun périphérique BLE vu : adaptateur Bluetooth actif ? Wizard allumé (LED) et non connecté au téléphone ?")


def fmt_val(b: bytes):
    txt = b.decode("utf-8", "replace") if b else ""
    printable = all(32 <= c < 127 for c in b) if b else False
    return f"{b.hex()}" + (f"  '{txt}'" if printable else "")


async def find_device(address, seconds=60.0):
    """Wait for one advertisement (the Wizard advertises slowly, fixed scans miss it)."""
    import wizard_decode
    dev = await wizard_decode.find_device(address, timeout=seconds)
    if dev is None:
        say(f"{address} pas vu en {seconds:.0f} s d'écoute")
    return dev


async def probe(address, seconds, write, log_path):
    from bleak import BleakClient, BleakScanner
    dev = await find_device(address)
    if dev is None:
        say(f"{address} non trouvé (éteint ? déjà connecté au téléphone ?)")
        return 1
    fh = open(log_path, "a", encoding="utf-8")
    disconnected = asyncio.Event()

    def on_notify(char, data):
        data = bytes(data)
        say(f"  ⇦ {char.uuid} [{len(data):3d}] {data.hex()}")
        log_line(fh, {"type": "notify", "char": str(char.uuid), "handle": char.handle, "hex": data.hex()})

    async with BleakClient(dev, disconnected_callback=lambda _: disconnected.set(), timeout=20.0) as client:
        name = getattr(dev, "name", None)
        say(f"connecté à {name!r} {address}  mtu={getattr(client, 'mtu_size', '?')}")
        log_line(fh, {"type": "connected", "address": address, "name": name})
        subscribed = 0
        for svc in client.services:
            say(f"service {svc.uuid}  {svc.description}")
            log_line(fh, {"type": "gatt", "kind": "service", "uuid": str(svc.uuid), "description": svc.description})
            for ch in svc.characteristics:
                props = ",".join(ch.properties)
                say(f"   char {ch.uuid}  h={ch.handle}  [{props}]  {ch.description}")
                rec = {"type": "gatt", "kind": "char", "service": str(svc.uuid), "uuid": str(ch.uuid), "handle": ch.handle, "properties": ch.properties, "description": ch.description,
                       "descriptors": [{"uuid": str(d.uuid), "handle": d.handle} for d in ch.descriptors]}
                if "read" in ch.properties:
                    try:
                        v = bytes(await client.read_gatt_char(ch))
                        say(f"        read: {fmt_val(v)}")
                        rec["value"] = v.hex()
                    except Exception as e:
                        say(f"        read: ✗ {e}")
                        rec["readError"] = str(e)
                log_line(fh, rec)
                if "notify" in ch.properties or "indicate" in ch.properties:
                    try:
                        await client.start_notify(ch, on_notify)
                        subscribed += 1
                    except Exception as e:
                        say(f"        notify: ✗ {e}")
        say(f"{subscribed} caractéristique(s) en notification ; écoute {seconds:.0f} s (Ctrl+C pour arrêter)")
        if write:
            uuid, hexdata = write
            data = bytes.fromhex(hexdata)
            say(f"  ⇨ write {uuid} {data.hex()}")
            try:
                await client.write_gatt_char(uuid, data, response=True)
                log_line(fh, {"type": "write", "char": uuid, "hex": data.hex(), "ok": True})
            except Exception as e:
                say(f"  write ✗ {e}")
                log_line(fh, {"type": "write", "char": uuid, "hex": data.hex(), "ok": False, "error": str(e)})
        t0 = time.time()
        try:
            while time.time() - t0 < seconds and not disconnected.is_set():
                await asyncio.sleep(0.2)
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        if disconnected.is_set():
            say("déconnecté par le périphérique")
    log_line(fh, {"type": "end"})
    fh.close()
    say(f"journal : {log_path}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="probe a WiFiman Wizard over BLE")
    ap.add_argument("--address", help="BLE address to connect to (omit to scan)")
    ap.add_argument("--seconds", type=float, default=60.0, help="listen duration once connected (or scan duration)")
    ap.add_argument("--write", nargs=2, metavar=("CHAR_UUID", "HEX"), help="write a command after subscribing")
    ap.add_argument("--log", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "wizard-probe.log"))
    a = ap.parse_args()
    try:
        import bleak  # noqa: F401
    except ImportError:
        say("module 'bleak' absent : pip install bleak")
        return 2
    if not a.address:
        asyncio.run(scan(a.seconds if a.seconds != 60.0 else 8.0))
        return 0
    return asyncio.run(probe(a.address, a.seconds, a.write, a.log))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
