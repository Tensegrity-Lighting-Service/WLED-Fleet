// wizard.js waterfall: rows of strongest RSSI per 5 MHz bin, built from bridge events (no hardware)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const wizard = require('../wizard');

const bin = (row, band, freq) => { const lo = band === 'g2' ? 2400 : 5150; const i = (freq - lo) / 5; const h = row[band].substr(i * 2, 2); return h === '..' ? null : parseInt(h, 16) - 128; };

test('a 20 MHz network on channel 6 fills 2427-2447 with its RSSI, nothing elsewhere', () => {
  wizard._onEvent({ type: 'network', t: Date.now(), bssid: 'aa:bb:cc:00:00:06', ssid: 'six', freq: 2437, channel: 6, width: 20, signal: -61 });
  wizard._waterRow();
  const w = wizard.waterfall(5);
  assert.strictEqual(w.every, 5000);
  const row = w.rows[w.rows.length - 1];
  assert.strictEqual(row.g2.length, 2 * (2495 - 2400) / 5);
  assert.strictEqual(bin(row, 'g2', 2427), -61);
  assert.strictEqual(bin(row, 'g2', 2442), -61);
  assert.strictEqual(bin(row, 'g2', 2412), null);
  assert.strictEqual(bin(row, 'g2', 2462), null);
  assert.ok(!/[0-9a-f]/.test(row.g5), '5 GHz row stays empty');
});

test('overlapping networks keep the loudest; a wide 5 GHz channel uses its centre', () => {
  const t = Date.now();
  wizard._onEvent({ type: 'network', t, bssid: 'aa:bb:cc:00:00:01', ssid: 'one', freq: 2412, channel: 1, width: 20, signal: -50 });
  wizard._onEvent({ type: 'network', t, bssid: 'aa:bb:cc:00:00:02', ssid: 'two', freq: 2417, channel: 2, width: 20, signal: -80 });
  wizard._onEvent({ type: 'network', t, bssid: 'aa:bb:cc:00:00:0b', ssid: 'eleven', freq: 2462, channel: 11, width: 20, signal: -85 });
  wizard._onEvent({ type: 'network', t, bssid: 'aa:bb:cc:00:00:24', ssid: 'wide', freq: 5180, channel: 36, width: 80, signal: -70, center: 42 });
  wizard._waterRow();
  const row = wizard.waterfall(1).rows[0];
  assert.strictEqual(bin(row, 'g2', 2412), -50, 'channel 1 wins where it overlaps channel 2');
  assert.strictEqual(bin(row, 'g2', 2462), -85, 'channel 11 alone on its bins');
  assert.strictEqual(bin(row, 'g2', 2477), null);
  assert.strictEqual(bin(row, 'g5', 5175), -70, '80 MHz around 5210 starts at 5170');
  assert.strictEqual(bin(row, 'g5', 5245), -70);
  assert.strictEqual(bin(row, 'g5', 5255), null);
  assert.strictEqual(bin(row, 'g5', 5165), null);
});

test('waterfall(n) returns the last n rows only', () => {
  for (let i = 0; i < 4; i++) wizard._waterRow();
  assert.strictEqual(wizard.waterfall(3).rows.length, 3);
});
