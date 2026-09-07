#!/usr/bin/env python3
"""Offline tests for wizard_decode.py (framing round trip, result mapping). No hardware, no bleak.

    python -m unittest test_wizard_decode      (from tools/wizard)
"""
import json
import struct
import unittest

import wizard_decode as w


def response_frame(seq, guid, body_obj, compress=False, status=200):
    header = {"type": "httpResponse", "id": guid, "timestamp": 1788597488000, "statusCode": status}
    body = json.dumps(body_obj).encode("utf-8")
    return w.encode_frame(seq, w._fragment(w.KIND_HEADER, w.FMT_JSON, json.dumps(header).encode()) + w._fragment(w.KIND_BODY, w.FMT_JSON, body, compress=compress))


class Framing(unittest.TestCase):
    def test_request_layout(self):
        f = w.make_request(5, "00000000-0000-0000-0000-000000000005", "GET", "/api/version")
        # frame length counts itself; packet = seq(2) + protocol(1) + binme
        self.assertEqual(struct.unpack(">H", f[:2])[0], len(f))
        self.assertEqual(f[2:5], b"\x00\x05\x03")
        self.assertEqual(f[5:9], bytes([w.KIND_HEADER, w.FMT_JSON, w.COMPRESSION_OFF, 0]))
        seq, header, body = w.decode_message(f[2:])
        self.assertEqual(seq, 5)
        self.assertEqual(header["type"], "httpRequest")
        self.assertEqual(header["path"], "/api/version")
        self.assertEqual(body, {})

    def test_reassembly_across_chunks(self):
        frame = response_frame(1, "x", {"results": []})
        asm = w.FrameAssembler()
        self.assertEqual(asm.feed(frame[:7]), [])
        packets = asm.feed(frame[7:])
        self.assertEqual(len(packets), 1)
        self.assertEqual(w.decode_message(packets[0])[1]["statusCode"], 200)

    def test_two_frames_in_one_chunk(self):
        chunk = response_frame(1, "a", {}) + response_frame(2, "b", {})
        packets = w.FrameAssembler().feed(chunk)
        self.assertEqual([w.decode_message(p)[0] for p in packets], [1, 2])

    def test_zlib_body(self):
        frame = response_frame(3, "c", {"results": [{"bssid": "aa:bb:cc:dd:ee:ff", "freq": "5180", "rssi": "-50", "bw": "2", "std": "0x08", "akm": "0x2"}]}, compress=True)
        nets = w.parse_frame(frame)
        self.assertEqual(len(nets), 1)
        self.assertEqual(nets[0]["width"], 80)
        self.assertEqual(nets[0]["std"], "ac")
        self.assertEqual(nets[0]["band"], "5g")


class Results(unittest.TestCase):
    def test_mapping(self):
        r = {"ssid": "ORFOLED", "bssid": "74FA2930C038", "freq": "2452", "ch": "9", "ch_s0": "9", "sbw": "1", "bw": "0",
             "nss": "2", "rssi": "-48", "mcs": "9", "std": "0x10", "akm": "0x2", "cipher": "0x8", "ch_util": "51", "sta_cnt": "3"}
        n = w.network_from_result(r)
        self.assertEqual(n["bssid"], "74:fa:29:30:c0:38")
        self.assertEqual((n["freq"], n["channel"], n["width"], n["signal"]), (2452, 9, 20, -48))
        self.assertEqual((n["band"], n["security"], n["std"]), ("2g", "WPA2-PSK", "ax"))
        self.assertEqual(n["stations"], 3)
        self.assertEqual(n["utilization"], 0.51)

    def test_security_flags(self):
        self.assertEqual(w.security_of(0), "open")
        self.assertEqual(w.security_of(1 << 10), "WPA3-SAE")
        self.assertEqual(w.security_of((1 << 1) | (1 << 10)), "WPA2/3-PSK")
        self.assertEqual(w.security_of((1 << 1) | (1 << 9) | (1 << 6)), "WPA2-PSK")   # + WPS, + FT
        self.assertEqual(w.security_of(1 << 22), "OWE")
        self.assertEqual(w.security_of(1 << 0), "WPA2-EAP")

    def test_rejects_garbage(self):
        self.assertIsNone(w.network_from_result({"bssid": "zz", "freq": "2412", "rssi": "-40"}))
        self.assertIsNone(w.network_from_result({"bssid": "aa:bb:cc:dd:ee:ff", "freq": "2412", "rssi": "0"}))
        self.assertEqual(w.networks_from_body(None), [])

    def test_real_firmware_body(self):
        # exactly what firmware 1.9.0 returns: BINARY body, one object per line, trailing comma
        raw = (b'{"scan_result":[\n'
               b'{"ssid":"WifiFlo","bssid":"94:83:c4:ab:b7:10","freq":"2437","ch":"6","ch_s0":"6","ch_s1":"0","sbw":"1","bw":"0","nss":"2","rssi":"-47","mcs":"11","tpc":"19","rtt":"0","ch_util":"0","sta_cnt":"0","std":"0x3d","akm":"0x4000002","cipher":"0x0010","sdr":"0x3fcf"},\n'
               b'{"ssid":"","bssid":"3a:17:b1:83:b0:89","freq":"5320","ch":"64","ch_s0":"50","ch_s1":"0","sbw":"3","bw":"3","nss":"4","rssi":"-85","mcs":"11","tpc":"16","rtt":"0","ch_util":"20","sta_cnt":"0","std":"0x1e","akm":"0x0402","cipher":"0x0010","sdr":"0x3fc0"},\n'
               b']}')
        nets = w.networks_from_body(raw)
        self.assertEqual(len(nets), 2)
        self.assertEqual((nets[0]["ssid"], nets[0]["std"], nets[0]["security"]), ("WifiFlo", "be", "WPA2/3-PSK"))
        self.assertEqual((nets[1]["ssid"], nets[1]["width"], nets[1]["band"], nets[1]["security"]), ("", 160, "5g", "WPA2/3-PSK"))
        self.assertEqual(w.networks_from_body(b'{"scan_result":[\n]}'), [])
        frame = w.encode_frame(9, w._fragment(w.KIND_HEADER, w.FMT_JSON, b'{"type":"httpResponse","id":"z","timestamp":1,"statusCode":200}') + w._fragment(w.KIND_BODY, w.FMT_BINARY, raw))
        self.assertEqual(len(w.parse_frame(frame)), 2)

    def test_scan_done_flag_is_a_string(self):
        self.assertEqual(w._int("1", 0), 1)
        self.assertEqual(w._int("0", 0), 0)
        self.assertEqual(w._int(None, 0), 0)


if __name__ == "__main__":
    unittest.main()
