#!/usr/bin/env python3
"""WiFiman Wizard (Ubiquiti WM-W) BLE protocol: framing, API client and result decoder.

Established on the real device (firmware 1.9.0, API 1.0) during phase 0, see
../../docs/wizard-protocol.md. Nothing here is copied from Ubiquiti's code; this
is a clean-room description of what the device sends and accepts.

The Wizard speaks a small "HTTP over BLE" dialect (Ubiquiti's generic device
link, the same design as their other BLE-provisioned products):

    request  = GET|POST <path> + JSON body        response = status + JSON body
    events   = pushed by the device (scan done, periodic stats...)

wrapped in three thin binary layers on top of GATT:

    message  : header JSON {"type","id","timestamp","method","path","headers"} + body
               -> "binme" container: two fragments (HEADER, BODY), each
                  [kind u8][format u8][compression u8][0][length u32 BE][bytes]
    packet   : [sequence u16 BE][protocol u8 = 3][binme]          (no encryption)
    frame    : [length u16 BE, counts itself][packet]  chunked to the MTU on the
               write characteristic; notifications are re-assembled the same way.

Public surface used by wizard_bridge.py:
    SERVICE_UUID / CHAR_NOTIFY / CHAR_WRITE / CHAR_INFO
    identify(client) -> {"firmware", "model", ...}    battery(client) -> int|None
    Decoder(client, emit_raw, emit): start() / drain() / stop()
    parse_frame(bytes) -> [network]   (stateful: feed notifications in order)

Network dicts have the shape the rest of wled-fleet expects:
    {"bssid": "aa:bb:cc:dd:ee:ff", "ssid": "...", "freq": 2437, "channel": 6,
     "width": 20, "signal": -61, "band": "2g", "security": "WPA2-PSK", "std": "ax"}

    python wizard_decode.py wizard-probe.log              # replay a probe log
    python wizard_decode.py --address 74:FA:29:30:C0:38   # live test, prints networks
"""
import asyncio
import json
import re
import struct
import sys
import time
import uuid
import zlib

# ── GATT ─────────────────────────────────────────────────────────────────────
SERVICE_UUID = "e0373cc2-d3bc-4eac-9c6e-423d0fe5d738"   # advertised; a twin service db6930ca-… exposes the same pair
CHAR_WRITE = "9280f26c-a56f-43ea-b769-d5d732e1ac67"     # write (with response): frames PC -> Wizard
CHAR_NOTIFY = "d587c47f-ac6e-4388-a31c-e6cd380ba043"    # notify: frames Wizard -> PC (reads "12 34" idle)
CHAR_INFO = "dc272a22-43f2-416b-8fa5-63a071542fac"      # read: {"id","fwv","apiVersion","bv","sku"}
CHAR_GAP_FIRMWARE = "00002a26-0000-1000-8000-00805f9b34fb"
CHAR_GAP_NAME = "00002a00-0000-1000-8000-00805f9b34fb"       # "UWS-nnn" (the advertised name is a placeholder)

# ── API 1.0 paths (session id = the Wizard's BLE MAC, lowercase, no separators) ──
API_VERSION_PATH = "/api/version"
API_PREFIX = "/api/1.0/"
PATH_DEVICE = ""
PATH_STATS = "/stats"
PATH_PERIODIC_STATS = "/per_stats"
PATH_SETTINGS = "/settings"
PATH_FIRMWARE = "/fw"
PATH_BLUETOOTH = "/bt"
PATH_SCAN_START = "/wifi/trigger_scan"
PATH_SCAN_STOP = "/wifi/stop_scan"
PATH_SCAN_DONE = "/scan_done"           # event name (suffix)
PATH_SCAN_RESULT = "/wifi/get_scan_result"
PATH_PRIORITY = "/wifi/priority"
SUPPORTED_API = "1.0"
REQUEST_TIMEOUT = 60.0
START_CMD = ("POST", PATH_SCAN_START)   # kept as documentation for the bridge; see Decoder.start()
STOP_CMD = ("POST", PATH_SCAN_STOP)

# ── binme container ──────────────────────────────────────────────────────────
KIND_HEADER, KIND_BODY = 1, 2
FMT_JSON, FMT_STRING, FMT_BINARY = 1, 2, 3
COMPRESSION_OFF, COMPRESSION_ZLIB = 0, 1
PROTO_BINARY_MESSAGE = 3                 # 0 auth, 1 management, 2 all-join, 3 binary message


class ProtocolError(Exception):
    pass


def _fragment(kind, fmt, payload, compress=False):
    if compress:
        payload = zlib.compress(payload)
    return struct.pack(">BBBBI", kind, fmt, COMPRESSION_ZLIB if compress else COMPRESSION_OFF, 0, len(payload)) + payload


def _read_fragment(buf, pos, expected_kind):
    if len(buf) < pos + 8:
        raise ProtocolError("binme fragment header truncated")
    kind, fmt, comp, _res, length = struct.unpack_from(">BBBBI", buf, pos)
    if kind != expected_kind:
        raise ProtocolError(f"binme fragment kind {kind}, expected {expected_kind}")
    pos += 8
    payload = bytes(buf[pos:pos + length])
    if len(payload) != length:
        raise ProtocolError(f"binme fragment truncated ({len(payload)}/{length})")
    if comp == COMPRESSION_ZLIB:
        payload = zlib.decompress(payload)
    elif comp != COMPRESSION_OFF:
        raise ProtocolError(f"binme compression {comp} unknown")
    return fmt, payload, pos + length


def binme_pack(header: dict, body: bytes, body_fmt=FMT_JSON):
    hdr = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return _fragment(KIND_HEADER, FMT_JSON, hdr) + _fragment(KIND_BODY, body_fmt, body)


def binme_unpack(data: bytes):
    """-> (header dict, body bytes, body format)"""
    fmt, hdr, pos = _read_fragment(data, 0, KIND_HEADER)
    bfmt, body, _ = _read_fragment(data, pos, KIND_BODY)
    try:
        header = json.loads(hdr.decode("utf-8"))
    except ValueError as e:
        raise ProtocolError(f"header is not JSON: {e}")
    return header, body, bfmt


# ── packet + frame ───────────────────────────────────────────────────────────
def encode_frame(seq: int, message: bytes):
    packet = struct.pack(">HB", seq & 0xFFFF, PROTO_BINARY_MESSAGE) + message
    if len(packet) + 2 > 0xFFFF:
        raise ProtocolError("frame longer than 65535 bytes")
    return struct.pack(">H", len(packet) + 2) + packet


def decode_packet(packet: bytes):
    """-> (seq, protocol, payload)"""
    if len(packet) < 3:
        raise ProtocolError("packet shorter than 3 bytes")
    seq, proto = struct.unpack_from(">HB", packet, 0)
    return seq, proto, bytes(packet[3:])


class FrameAssembler:
    """Concatenates notification chunks and yields complete packets (length prefix stripped)."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, chunk: bytes):
        self.buf += chunk
        out = []
        while len(self.buf) >= 2:
            length = struct.unpack_from(">H", self.buf, 0)[0]
            if length == 0:            # padding, skip
                del self.buf[:2]
                continue
            if length < 2:
                raise ProtocolError(f"frame length {length}")
            if len(self.buf) < length:
                break
            out.append(bytes(self.buf[2:length]))
            del self.buf[:length]
        return out

    def reset(self):
        self.buf.clear()


def make_request(seq: int, guid: str, method: str, path: str, body=None):
    header = {"type": "httpRequest", "id": guid, "timestamp": int(time.time() * 1000), "method": method, "path": path, "headers": {}}
    raw = b"{}" if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    return encode_frame(seq, binme_pack(header, raw))


def decode_message(packet: bytes):
    """packet -> (seq, header dict, body object|bytes). JSON bodies are parsed; empty -> None."""
    seq, proto, payload = decode_packet(packet)
    if proto != PROTO_BINARY_MESSAGE:
        raise ProtocolError(f"packet protocol {proto}, expected {PROTO_BINARY_MESSAGE}")
    header, body, bfmt = binme_unpack(payload)
    if bfmt == FMT_JSON:
        text = body.decode("utf-8", "replace").strip()
        body = json.loads(text) if text else None
    elif bfmt == FMT_STRING:
        body = body.decode("utf-8", "replace")
    return seq, header, body


# ── scan result -> network dict ──────────────────────────────────────────────
WIDTH_MHZ = {0: 20, 1: 40, 2: 80, 3: 160, 4: 80}      # 4 = 80+80
STD_BITS = ((5, "be"), (4, "ax"), (3, "ac"), (2, "n"), (1, "a"), (0, "g"))
# akm: bit flags in the wpa_supplicant key-management order (u32 as hex "0x…")
AKM_EAP = (1 << 0) | (1 << 5)
AKM_PSK = (1 << 1) | (1 << 4) | (1 << 6) | (1 << 8)
AKM_NONE = (1 << 2) | (1 << 3)
AKM_EAP_SHA256 = (1 << 7) | (1 << 16) | (1 << 17) | (1 << 24)
AKM_WPS = 1 << 9
AKM_SAE = (1 << 10) | (1 << 11) | (1 << 26)
AKM_WAPI = (1 << 12) | (1 << 13)
AKM_OSEN = 1 << 15
AKM_FILS = (1 << 18) | (1 << 19) | (1 << 20) | (1 << 21)
AKM_OWE = 1 << 22
AKM_DPP = 1 << 23


def _int(v, default=None):
    try:
        return int(str(v).strip(), 0) if isinstance(v, str) and str(v).strip().lower().startswith("0x") else int(v)
    except (TypeError, ValueError):
        return default


def _hex(v):
    try:
        s = str(v).strip()
        return int(s, 16) if s.lower().startswith("0x") else int(s)
    except (TypeError, ValueError):
        return None


def chan_of(freq):
    if 2412 <= freq <= 2484:
        return 14 if freq == 2484 else round((freq - 2407) / 5)
    if freq >= 5925:
        return round((freq - 5950) / 5)
    return round((freq - 5000) / 5)


def band_of(freq):
    return "2g" if freq < 3000 else ("6g" if freq >= 5925 else "5g")


def security_of(akm, cipher=None):
    if akm is None:
        return None
    if akm & AKM_SAE:
        return "WPA2/3-PSK" if akm & AKM_PSK else "WPA3-SAE"     # mixed mode APs advertise both
    if akm & AKM_OWE:
        return "OWE"
    if akm & AKM_EAP_SHA256:
        return "WPA3-EAP"
    if akm & AKM_PSK:
        return "WPA2-PSK"
    if akm & AKM_EAP:
        return "WPA2-EAP"
    if akm & AKM_DPP:
        return "DPP"
    if akm & AKM_FILS:
        return "FILS"
    if akm & AKM_WAPI:
        return "WAPI"
    if akm & AKM_OSEN:
        return "OSEN"
    if akm & AKM_WPS:
        return "WPS"
    return "open"


def std_of(std_hex):
    if std_hex is None:
        return None
    b = std_hex & 0xFF
    for bit, name in STD_BITS:
        if b & (1 << bit):
            return name
    return None


def norm_bssid(s):
    h = "".join(c for c in str(s or "").lower() if c in "0123456789abcdef")
    if len(h) != 12:
        return None
    return ":".join(h[i:i + 2] for i in range(0, 12, 2))


def network_from_result(r: dict):
    """One entry of get_scan_result -> network dict, or None if unusable."""
    if not isinstance(r, dict):
        return None
    bssid = norm_bssid(r.get("bssid"))
    freq = _int(r.get("freq"))
    rssi = _int(r.get("rssi"))
    if bssid is None or freq is None or rssi is None or not (-100 < rssi < 0):
        return None
    channel = _int(r.get("ch")) or chan_of(freq)
    width = WIDTH_MHZ.get(_int(r.get("bw"), 0), 20)
    net = {
        "bssid": bssid,
        "ssid": (r.get("ssid") or "").strip("\x00"),
        "freq": freq,
        "channel": channel,
        "width": width,
        "signal": rssi,
        "band": band_of(freq),
        "security": security_of(_hex(r.get("akm")), _hex(r.get("cipher"))),
        "std": std_of(_hex(r.get("std"))),
    }
    # extras the UI may show one day (all optional)
    nss = _int(r.get("nss"))
    if nss:
        net["nss"] = nss
    util = _int(r.get("ch_util"))
    if util is not None and util >= 0:
        net["utilization"] = round(min(util, 100) / 100, 2)   # BSS load, the firmware gives 0..100
    sta = _int(r.get("sta_cnt"))
    if sta is not None and sta >= 0:
        net["stations"] = sta
    center = _int(r.get("ch_s0"))
    if center:
        net["center"] = center
    return net


_TRAILING_COMMA = re.compile(r",\s*([\]}])")


def loads_lenient(text):
    """The firmware writes its scan JSON by hand: one object per line and a trailing comma
    before the closing bracket. Strip that, then parse strictly."""
    if isinstance(text, (bytes, bytearray)):
        text = bytes(text).decode("utf-8", "replace")
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return json.loads(_TRAILING_COMMA.sub(r"\1", text))


def networks_from_body(body):
    """Body of get_scan_result (dict, or the raw bytes of a BINARY body) -> networks."""
    if isinstance(body, (bytes, bytearray, str)):
        try:
            body = loads_lenient(body)
        except ValueError:
            return []
    if not isinstance(body, dict):
        return []
    out = []
    for r in body.get("scan_result") or body.get("results") or []:
        n = network_from_result(r)
        if n:
            out.append(n)
    return out


# ── stateful replay helper (probe logs / --raw frames) ───────────────────────
_REPLAY = FrameAssembler()


def parse_frame(data: bytes):
    """Feed one notification; returns the networks of any scan result completed by it."""
    out = []
    try:
        packets = _REPLAY.feed(data)
    except ProtocolError:
        _REPLAY.reset()
        return out
    for p in packets:
        try:
            _seq, header, body = decode_message(p)
        except (ProtocolError, ValueError):
            continue
        if header.get("type") == "httpResponse":
            out.extend(networks_from_body(body))
    return out


# ── live session ─────────────────────────────────────────────────────────────
class WizardSession:
    """Request/response over the notify + write characteristics; events go to on_event(name, body)."""

    def __init__(self, client, on_event=None, on_raw=None, log=None):
        self.client = client
        self.on_event = on_event or (lambda name, body: None)
        self.on_raw = on_raw
        self.log = log or (lambda msg: None)
        self.asm = FrameAssembler()
        self.seq = 0
        self.guid_n = 0
        self.pending = {}
        self.loop = None
        self.session_id = None
        self.chunk = 20
        self.ch_notify = CHAR_NOTIFY
        self.ch_write = CHAR_WRITE

    async def start(self):
        self.loop = asyncio.get_running_loop()
        mtu = getattr(self.client, "mtu_size", None) or 23
        self.chunk = max(20, min(int(mtu) - 3, 509))
        self.ch_notify = resolve_char(self.client, CHAR_NOTIFY)
        self.ch_write = resolve_char(self.client, CHAR_WRITE)
        await self.client.start_notify(self.ch_notify, self._on_notify)

    async def stop(self):
        try:
            await self.client.stop_notify(self.ch_notify)
        except Exception:
            pass
        for fut in self.pending.values():
            if not fut.done():
                fut.cancel()
        self.pending.clear()

    def _on_notify(self, _char, data):
        data = bytes(data)
        if self.on_raw:
            self.on_raw(data)
        try:
            packets = self.asm.feed(data)
        except ProtocolError as e:
            self.log(f"frame error: {e}, buffer reset")
            self.asm.reset()
            return
        for p in packets:
            try:
                _seq, header, body = decode_message(p)
            except (ProtocolError, ValueError) as e:
                self.log(f"message error: {e} ({p[:32].hex()}…)")
                continue
            self._dispatch(header, body)

    def _dispatch(self, header, body):
        t = header.get("type")
        if t in ("httpResponse", "response", "error", "cmdResponse"):
            fut = self.pending.pop(header.get("id"), None)
            if fut is not None and not fut.done():
                if t == "error":
                    fut.set_exception(ProtocolError(f"device error {header.get('errorCode')}: {header.get('error')}"))
                else:
                    fut.set_result((header, body))
            else:
                self.log(f"unmatched {t} {header.get('id')}")
        elif t == "event":
            self.on_event(header.get("name") or "", body)
        elif t == "log":
            self.log(f"device log [{header.get('level')}] {body}")
        else:
            self.log(f"unexpected message type {t}")

    async def _write(self, frame: bytes):
        for i in range(0, len(frame), self.chunk):
            await self.client.write_gatt_char(self.ch_write, frame[i:i + self.chunk], response=True)

    async def request(self, method, path, body=None, timeout=REQUEST_TIMEOUT):
        """-> (status code, body). Raises ProtocolError / asyncio.TimeoutError."""
        guid = str(uuid.UUID(int=self.guid_n))
        self.guid_n += 1
        seq = self.seq
        self.seq = (self.seq + 1) & 0xFFFF
        fut = self.loop.create_future()
        self.pending[guid] = fut
        try:
            await self._write(make_request(seq, guid, method, path, body))
            header, rbody = await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(guid, None)
        status = header.get("statusCode", 200) if header.get("type") == "httpResponse" else (200 if not header.get("errorCode") else 500)
        return status, rbody

    def api(self, suffix):
        return API_PREFIX + (self.session_id or "") + suffix

    async def get(self, suffix, **kw):
        return await self.request("GET", self.api(suffix), **kw)

    async def post(self, suffix, body=None, **kw):
        return await self.request("POST", self.api(suffix), body, **kw)


_DECODERS = {}          # id(client) -> Decoder, so battery(client) can ask the live session


async def find_device(address, timeout=60.0, match=None):
    """Wait for one advertisement from the Wizard and return its BLEDevice (None on timeout).

    The Wizard advertises slowly (several seconds apart, longer right after a
    disconnect), so fixed-length discover() calls and WinRT's
    find_device_by_address() miss it; a detection callback is reliable."""
    from bleak import BleakScanner
    loop = asyncio.get_running_loop()
    found = loop.create_future()
    want = (address or "").lower()

    def on_adv(dev, adv):
        if found.done():
            return
        if (want and dev.address.lower() == want) or (match and match(dev, adv)):
            found.set_result(dev)

    async with BleakScanner(on_adv):
        try:
            return await asyncio.wait_for(found, timeout)
        except asyncio.TimeoutError:
            return None


def resolve_char(client, char_uuid, service_uuid=SERVICE_UUID):
    """The Wizard exposes the same characteristic UUIDs under two services: pick the one
    of the advertised service (bleak refuses an ambiguous UUID), else the first match."""
    first = None
    for svc in client.services:
        for ch in svc.characteristics:
            if str(ch.uuid).lower() == char_uuid.lower():
                if str(svc.uuid).lower() == service_uuid.lower():
                    return ch
                first = first or ch
    return first or char_uuid


async def _read_info(client):
    try:
        raw = bytes(await client.read_gatt_char(resolve_char(client, CHAR_INFO))).decode("utf-8", "replace").strip("\x00 ")
        return json.loads(raw) if raw.startswith("{") else {}
    except Exception:
        return {}


async def identify(client):
    """Static identity: the info characteristic (JSON) + GAP firmware string."""
    info = await _read_info(client)
    out = {"manufacturer": "Ubiquiti", "model": "WiFiman Wizard (WM-W)"}
    if info.get("fwv"):
        out["firmware"] = info["fwv"]
    else:
        try:
            out["firmware"] = bytes(await client.read_gatt_char(CHAR_GAP_FIRMWARE)).decode("utf-8", "replace").strip("\x00 ")
        except Exception:
            pass
    try:
        name = bytes(await client.read_gatt_char(CHAR_GAP_NAME)).decode("utf-8", "replace").strip("\x00 ")
        if name:
            out["name"] = name
    except Exception:
        pass
    if info.get("id"):
        out["deviceId"] = info["id"]
    if info.get("sku"):
        out["sku"] = info["sku"]
    if info.get("apiVersion"):
        out["apiVersion"] = info["apiVersion"]
    return out


async def battery(client):
    """Battery percent through the live session (GET /stats), None when no session is up."""
    dec = _DECODERS.get(id(client))
    if dec is None or dec.session.session_id is None:
        return None
    try:
        _st, stats = await dec.session.get(PATH_STATS, timeout=15)
        dec.update_stats(stats)
    except Exception:
        pass
    return dec.battery


class Decoder:
    """Drives one scan session: version check, trigger, scan_done events -> get_scan_result."""

    RETRIGGER_AFTER = 30.0      # s without a scan_done event -> trigger again

    def __init__(self, client, emit_raw=False, emit=None):
        self.client = client
        self.emit_raw = emit_raw
        self.emit = emit or (lambda obj: None)
        self.queue = []
        self.name = "wmw-api-1.0"
        self.battery = None
        self.stats = {}
        self.device = {}
        self.last_done = 0.0
        self.scanning = False
        self._fetching = False
        self.session = WizardSession(client, on_event=self._on_event,
                                     on_raw=(lambda d: self.emit({"type": "raw", "char": CHAR_NOTIFY, "hex": d.hex()})) if emit_raw else None,
                                     log=lambda m: self.emit({"type": "log", "message": m}))
        _DECODERS[id(client)] = self

    # -- device -> us --
    def _on_event(self, name, body):
        if name.endswith(PATH_SCAN_DONE):
            # the device sends the flag as a string ("1" done, "0" nothing found)
            done = isinstance(body, dict) and _int(body.get("scan_done"), 0) == 1
            self.last_done = time.time()
            if done and not self._fetching:
                asyncio.ensure_future(self._fetch_results())
        elif name.endswith(PATH_PERIODIC_STATS) or name.endswith(PATH_STATS):
            self.update_stats(body)
        elif name.endswith(PATH_SETTINGS) or name.endswith(PATH_FIRMWARE) or name.endswith(PATH_BLUETOOTH):
            pass
        else:
            self.emit({"type": "log", "message": f"event {name}: {json.dumps(body)[:200]}"})

    def update_stats(self, stats):
        if isinstance(stats, dict):
            self.stats = stats
            b = stats.get("battery")
            if isinstance(b, (int, float)) and 0 <= b <= 100:
                self.battery = int(b)

    async def _fetch_results(self):
        self._fetching = True
        try:
            status, body = await self.session.get(PATH_SCAN_RESULT, timeout=30)
            if status != 200:
                self.emit({"type": "error", "code": "decode", "message": f"get_scan_result -> {status}"})
                return
            self.queue.extend(networks_from_body(body))
        except asyncio.TimeoutError:
            self.emit({"type": "error", "code": "decode", "message": "get_scan_result: pas de réponse"})
        except Exception as e:
            self.emit({"type": "error", "code": "decode", "message": f"get_scan_result: {e}"})
        finally:
            self._fetching = False

    async def _trigger(self):
        status, _ = await self.session.post(PATH_SCAN_START, timeout=20)
        if status != 200:
            raise ProtocolError(f"trigger_scan -> {status}")
        self.scanning = True
        self.last_done = time.time()

    # -- bridge API --
    async def start(self):
        await self.session.start()
        info = await _read_info(self.client)
        sid = (info.get("id") or "").lower() or "".join(c for c in getattr(self.client, "address", "").lower() if c in "0123456789abcdef")
        self.session.session_id = sid
        status, ver = await self.session.request("GET", API_VERSION_PATH, timeout=20)
        if status != 200 or not isinstance(ver, dict):
            raise ProtocolError(f"/api/version -> {status} {ver!r}")
        if ver.get("apiVersion") != SUPPORTED_API:
            raise ProtocolError(f"API {ver.get('apiVersion')} non gérée (attendu {SUPPORTED_API})")
        try:
            _st, self.device = await self.session.get(PATH_DEVICE, timeout=20)
        except Exception as e:
            self.emit({"type": "log", "message": f"device: {e}"})
        try:
            _st, stats = await self.session.get(PATH_STATS, timeout=20)
            self.update_stats(stats)
        except Exception as e:
            self.emit({"type": "log", "message": f"stats: {e}"})
        await self._trigger()

    def drain(self):
        out, self.queue = self.queue, []
        if self.scanning and time.time() - self.last_done > self.RETRIGGER_AFTER and not self._fetching:
            self.last_done = time.time()
            asyncio.ensure_future(self._retrigger())
        return out

    async def _retrigger(self):
        try:
            await self._trigger()
            self.emit({"type": "log", "message": "scan relancé (pas d'événement scan_done)"})
        except Exception as e:
            self.emit({"type": "error", "code": "decode", "message": f"trigger_scan: {e}"})

    async def stop(self):
        self.scanning = False
        try:
            await self.session.post(PATH_SCAN_STOP, timeout=5)
        except Exception:
            pass
        await self.session.stop()
        _DECODERS.pop(id(self.client), None)


# ── CLI: replay a probe log, or a live test ──────────────────────────────────
def replay(path):
    n = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") not in ("notify", "raw"):
                continue
            for net in parse_frame(bytes.fromhex(rec["hex"])):
                n += 1
                print(json.dumps(net, ensure_ascii=False))
    print(f"# {n} réseau(x) décodé(s)", file=sys.stderr)


async def live(address, seconds, raw):
    from bleak import BleakClient

    def emit(obj):
        print(json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)

    dev = await find_device(address, timeout=90.0)
    if dev is None:
        print(f"# {address} non vu en BLE", file=sys.stderr)
        return
    async with BleakClient(dev, timeout=20.0) as client:
        print(f"# connecté, mtu={getattr(client, 'mtu_size', '?')}", file=sys.stderr)
        print(f"# identité : {await identify(client)}", file=sys.stderr)
        dec = Decoder(client, emit_raw=raw, emit=emit)
        await dec.start()
        print(f"# device={json.dumps(dec.device)} stats={json.dumps(dec.stats)}", file=sys.stderr)
        t0 = time.time()
        n = 0
        while time.time() - t0 < seconds:
            for net in dec.drain():
                n += 1
                print(json.dumps(net, ensure_ascii=False), flush=True)
            await asyncio.sleep(0.2)
        await dec.stop()
        print(f"# {n} réseau(x) en {seconds:.0f} s, batterie={dec.battery}", file=sys.stderr)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="WiFiman Wizard decoder: replay a probe log or run a live test")
    ap.add_argument("log", nargs="?", help="wizard-probe.log to replay")
    ap.add_argument("--address", help="live test against this BLE address")
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--raw", action="store_true", help="live: also print raw notifications")
    a = ap.parse_args()
    if a.address:
        asyncio.run(live(a.address, a.seconds, a.raw))
    elif a.log:
        replay(a.log)
    else:
        ap.print_help()
        sys.exit(2)
