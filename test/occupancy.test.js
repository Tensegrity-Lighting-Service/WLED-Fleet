// Channel-plan model shared by the antenna scan and the WiFiman Wizard
// (ap.js occupancy()). Run: npm test  (node --test)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { occupancy, chan2g } = require('../ap');

test('chan2g maps 2.4 GHz frequencies to channels, null elsewhere', () => {
  assert.equal(chan2g(2412), 1); assert.equal(chan2g(2437), 6); assert.equal(chan2g(2472), 13); assert.equal(chan2g(2484), 14);
  assert.equal(chan2g(5240), null); assert.equal(chan2g(null), null); assert.equal(chan2g(undefined), null);
});

test('empty environment: every channel scores 0, channel 1 recommended', () => {
  const p = occupancy([], null);
  assert.equal(p.occupancy.length, 13);
  assert.ok(p.occupancy.every(o => o.score === 0 && o.networks === 0 && o.strongest === null));
  assert.equal(p.recommended, 1);
  assert.equal(p.ours, null); assert.equal(p.ourFreq, null);
  assert.deepEqual(p.candidates.map(c => c.channel), [1, 6, 11, 13]);
  assert.equal(p.candidates[3].esp32Risk, true);
});

test('a loud 20 MHz network on 6 pollutes 2..10 with decreasing weight', () => {
  const p = occupancy([{ channel: 6, freq: 2437, signal: -30, width: 20 }], 2437);
  const s = Object.fromEntries(p.occupancy.map(o => [o.channel, o.score]));
  assert.equal(s[6], 1); // -30 dBm -> loud = 1, distance 0
  assert.ok(Math.abs(s[5] - 0.8) < 1e-9 && Math.abs(s[7] - 0.8) < 1e-9);
  assert.ok(Math.abs(s[2] - 0.2) < 1e-9 && Math.abs(s[10] - 0.2) < 1e-9);
  assert.equal(s[1], 0); assert.equal(s[11], 0);
  assert.equal(p.occupancy[5].networks, 1); assert.equal(p.occupancy[5].strongest, -30);
  assert.equal(p.ours, 6);
  assert.equal(p.candidates.find(c => c.channel === 6).ours, true);
  assert.equal(p.recommended, 1); // 1 and 11 tie at 0: the lowest wins (stable sort)
});

test('40 MHz widens the footprint to ±6 channels', () => {
  const p = occupancy([{ channel: 6, freq: 2437, signal: -30, width: 40 }], null);
  const s = Object.fromEntries(p.occupancy.map(o => [o.channel, o.score]));
  assert.ok(s[1] > 0 && s[12] > 0 && s[13] === 0);
});

test('signal below -90 dBm or missing weighs nothing; 5 GHz networks are ignored', () => {
  const p = occupancy([{ channel: 6, freq: 2437, signal: -95, width: 20 }, { channel: 6, freq: 2437, signal: null, width: 20 },
    { channel: 48, freq: 5240, signal: -20, width: 80 }], null);
  assert.ok(p.occupancy.every(o => o.score === 0));
  assert.equal(p.occupancy[5].networks, 2); // still counted as present on the channel
});

test('13 is never recommended even when it is the quietest', () => {
  const p = occupancy([[1, -40], [6, -40], [11, -50]].map(([c, sig]) => ({ channel: c, freq: 2407 + 5 * c, signal: sig, width: 20 })), 2412);
  assert.equal(p.candidates.find(c => c.channel === 13).score < p.candidates.find(c => c.channel === 11).score, true);
  assert.equal(p.recommended, 11);
});
