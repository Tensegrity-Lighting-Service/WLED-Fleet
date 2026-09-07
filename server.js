#!/usr/bin/env node
// wled-fleet - fleet manager for WLED nodes (Phase 1 of the roadmap).
//
// Discovers WLED nodes on the local /24 subnets (HTTP probe of /json/info),
// expands the list through each node's own /json/nodes (WLED UDP node list),
// polls info/state/cfg on an interval and serves a spreadsheet-like grid plus
// a small JSON API. Zero dependencies: Node.js stdlib only.
//
//   node server.js                      # auto-discover on every local /24
//   node server.js --subnet 192.168.88  # restrict the scan
//   node server.js --ip 192.168.88.81,192.168.88.82   # no scan, fixed list
//   node server.js --readonly           # refuse every write to the nodes
//
// Writes go through POST /json/cfg and POST /json/state on the node, with the
// partial-merge semantics WLED implements (only the keys present are applied).

'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { columns, groups } = require('./columns');
const firmware = require('./firmware');
const ap = require('./ap');
const snapshots = require('./snapshots');
const provision = require('./provision');
const wizard = require('./wizard');

// ── Settings: settings.json (standalone app) overridden by CLI flags ─────────
// settings.json = { "subnet": "192.168.88", "listen": "127.0.0.1:8792", "interval": 3000,
//                   "cfgInterval": 20000, "readonly": false, "otaParallel": 1 }
// (keys are the camelCase form of the CLI flags; "listen": "0.0.0.0:8792" opens the page to the LAN)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* none: CLI flags / defaults */ }
const args = process.argv.slice(2);
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function flag(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return settings[camel(name)] !== undefined ? settings[camel(name)] : def;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const LISTEN = String(flag('listen', '127.0.0.1:8792'));
const SUBNETS = flag('subnet', '') ? String(flag('subnet', '')).split(',').map(s => s.trim()).filter(Boolean) : null;
const FIXED_IPS = flag('ip', '') ? String(flag('ip', '')).split(',').map(s => s.trim()).filter(Boolean) : [];
const INTERVAL = Number(flag('interval', 3000));
const CFG_INTERVAL = Number(flag('cfg-interval', 20000));
const READONLY = flag('readonly', false) === true;
const RESTART_EXIT_CODE = 75; // the launcher (WLED-Fleet.cmd / WLED-Fleet.exe) restarts the server on this code
// Launched by the native window: if that process vanishes without closing us
// cleanly (killed from the task manager), stop instead of lingering hidden.
if (process.env.WLED_FLEET_PARENT_PID) {
  const ppid = Number(process.env.WLED_FLEET_PARENT_PID);
  setInterval(() => { try { process.kill(ppid, 0); } catch { console.log('fenêtre disparue, arrêt du serveur'); process.exit(0); } }, 2000).unref();
}
const KNOWN_FILE = path.join(__dirname, 'known-nodes.json');
// The launcher restarts the server silently after a crash: keep the reason on disk.
const ERROR_FILE = path.join(__dirname, 'server-errors.log');
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, err => {
  const line = `${new Date().toISOString()} ${ev}: ${(err && err.stack) || err}\n`;
  try { fs.appendFileSync(ERROR_FILE, line); } catch { /* ignore */ }
  console.error(line);
  if (ev === 'uncaughtException') process.exit(1);
});
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { return 'dev'; } })();

// ── HTTP helpers toward the nodes ────────────────────────────────────────────
function splitHost(ip) {
  const m = /^(.+?)(?::(\d+))?$/.exec(ip);
  return { host: m[1], port: m[2] ? Number(m[2]) : 80 };
}

function request(ip, method, urlPath, body, timeout = 2500) {
  const { host, port } = splitHost(ip);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host, port, method, path: urlPath, timeout,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const latency = Date.now() - t0;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}: ${text.slice(0, 200)}`));
        }
        try { resolve({ json: text ? JSON.parse(text) : null, latency }); }
        catch (e) { reject(new Error(`bad JSON from ${ip}${urlPath}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const getJson = (ip, p, timeout) => request(ip, 'GET', p, undefined, timeout);
const postJson = (ip, p, body, timeout) => request(ip, 'POST', p, body, timeout);

// ── Fleet state ──────────────────────────────────────────────────────────────
/** @type {Map<string, NodeRecord>} */
const fleet = new Map();
let scanning = false;
let lastScan = null;

function newRecord(ip) {
  return {
    meta: { ip, online: false, latency: null, lastSeen: null, lastSeenAgo: null, fails: 0, cfgUpdated: null, err: '', pending: 0, ota: null },
    info: null, state: null, cfg: null, derived: {},
  };
}

// The node group is WLED's own « Group topic » (Sync Interfaces > MQTT, cfg.if.mqtt.topics.group):
// a native, persistent, free-text field, inert while MQTT is off. « wled/all » (the default) = no group.
// meta.group mirrors it (and stands in for nodes whose cfg was never read).
const NO_GROUP = 'wled/all';
function groupFromCfg(rec) {
  const g = rec.cfg && rec.cfg.if && rec.cfg.if.mqtt && rec.cfg.if.mqtt.topics ? rec.cfg.if.mqtt.topics.group : undefined;
  if (typeof g !== 'string') return null;
  return g === NO_GROUP || !g.trim() ? '' : g.trim();
}
// Unused outputs (Fleet-only flag) are kept on the node too: MQTT device topic « wled/xxxxxx#u2.4 »
// (outputs 2 and 4 not wired). Read back as start indexes for the DMX plan.
function deviceTopic(rec) { const t = rec.cfg && rec.cfg.if && rec.cfg.if.mqtt && rec.cfg.if.mqtt.topics ? rec.cfg.if.mqtt.topics.device : undefined; return typeof t === 'string' ? t : null; }
function ignoredFromCfg(rec) {
  const t = deviceTopic(rec); if (t === null) return null;
  const m = /#u([0-9.]*)$/.exec(t); if (!m) return [];
  const ins = (rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
  return m[1].split('.').filter(Boolean).map(Number).filter(i => i >= 1 && ins[i - 1]).map(i => ins[i - 1].start);
}
function clientId(rec) { const c = rec.cfg && rec.cfg.if && rec.cfg.if.mqtt ? rec.cfg.if.mqtt.cid : undefined; return typeof c === 'string' ? c : null; }
function profilesFromCfg(rec) {
  const c = clientId(rec); if (c === null) return null;
  const m = /#p([0-9a-z.]*)$/.exec(c); if (!m) return [];
  const out = []; for (let i = 0; i + 1 < m[1].length + 1; i += 2) { const t = m[1].slice(i, i + 2); if (!t) break; out.push(t === '..' ? null : t); }
  return out;
}
// Fleet-only fields (group, ignored outputs, output↔profile links) are written straight to
// the node's MQTT config fields — no staging/Déployer for these. A node offline has nowhere
// to write to: the intent is kept in rec.meta.offlineQueue (persisted in known-nodes.json)
// and shown as if already applied (derive() below prefers it over the node's cached cfg);
// POST /api/node/:ip/offline-queue/apply|discard resolves it once the node is seen again.
function queueOffline(rec, field, value) { rec.meta.offlineQueue = { ...(rec.meta.offlineQueue || {}), [field]: value }; derive(rec); }
function unqueueOffline(rec, field) { if (!rec.meta.offlineQueue) return; delete rec.meta.offlineQueue[field]; if (!Object.keys(rec.meta.offlineQueue).length) rec.meta.offlineQueue = null; }
async function writeProfiles(rec, ids, source) {
  const c = clientId(rec); if (c === null) throw new Error('config du node non lue');
  const base = c.replace(/#p[0-9a-z.]*$/, '');
  let list = ids.map(x => (x && /^[0-9a-z]{2}$/.test(x) ? x : '..')); while (list.length && list[list.length - 1] === '..') list.pop();
  const next = list.length ? `${base}#p${list.join('')}` : base;
  if (next.length > 40) throw new Error('marqueur trop long pour le champ MQTT du node');
  if (next === c) { unqueueOffline(rec, 'outputProfiles'); rec.meta.outputProfiles = ids; return false; }
  if (!rec.meta.online) { queueOffline(rec, 'outputProfiles', ids); return 'queued'; }
  await postJson(rec.meta.ip, '/json/cfg', { if: { mqtt: { cid: next } } }, 8000);
  rec.cfg.if.mqtt.cid = next; rec.meta.outputProfiles = ids;
  recordChange(rec, 'outputs-profiles', c, next, source);
  unqueueOffline(rec, 'outputProfiles');
  return true;
}
async function writeIgnored(rec, starts, source) {
  const t = deviceTopic(rec); if (t === null) throw new Error('config du node non lue');
  const ins = (rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
  const idx = ins.map((b, i) => starts.includes(b.start) ? i + 1 : 0).filter(Boolean);
  const base = t.replace(/#u[0-9.]*$/, ''); const next = idx.length ? `${base}#u${idx.join('.')}` : base;
  if (next.length > 32) throw new Error('marqueur trop long pour le champ MQTT du node');
  if (next === t) { unqueueOffline(rec, 'ignoredOutputs'); rec.meta.ignoredOutputs = starts; return false; }
  if (!rec.meta.online) { queueOffline(rec, 'ignoredOutputs', starts); return 'queued'; }
  await postJson(rec.meta.ip, '/json/cfg', { if: { mqtt: { topics: { device: next } } } }, 8000);
  rec.cfg.if.mqtt.topics.device = next; rec.meta.ignoredOutputs = starts;
  recordChange(rec, 'outputs-unused', t, next, source);
  unqueueOffline(rec, 'ignoredOutputs');
  return true;
}
// write the group on the node (cfg partial merge keeps broker / user / password untouched)
async function writeGroup(rec, next, source) {
  const prev = rec.meta.group || '';
  if (next === prev) { unqueueOffline(rec, 'group'); return { changed: false }; }
  if (!rec.meta.online) { queueOffline(rec, 'group', next); return { changed: false, queued: true }; }
  await postJson(rec.meta.ip, '/json/cfg', { if: { mqtt: { topics: { group: next || NO_GROUP } } } }, 8000);
  rec.meta.group = next; if (rec.cfg && rec.cfg.if && rec.cfg.if.mqtt && rec.cfg.if.mqtt.topics) rec.cfg.if.mqtt.topics.group = next || NO_GROUP;
  recordChange(rec, 'group', prev, next, source);
  rec.meta.cfgUpdated = 0; // re-read the config soon
  unqueueOffline(rec, 'group');
  return { changed: true };
}
// applies every field kept in rec.meta.offlineQueue now that the node answers again ;
// partial failure keeps whatever didn't make it queued, for a retry
async function applyOfflineQueue(rec) {
  const q = rec.meta.offlineQueue; if (!q || !Object.keys(q).length) return { applied: [] };
  if (!rec.meta.online) throw new Error('toujours hors ligne');
  const applied = [];
  try {
    if (q.group !== undefined) { await writeGroup(rec, q.group, 'grille'); applied.push('groupe'); }
    if (q.ignoredOutputs !== undefined) { await writeIgnored(rec, q.ignoredOutputs, 'grille'); applied.push('sorties non utilisées'); }
    if (q.outputProfiles !== undefined) { await writeProfiles(rec, q.outputProfiles, 'grille'); applied.push('profils de sortie'); }
  } finally { saveKnown(); }
  return { applied };
}
// abandons the queued edits: the node's own current config wins back
function discardOfflineQueue(rec) { rec.meta.offlineQueue = null; derive(rec); saveKnown(); }
function derive(rec) {
  const { info, cfg } = rec;
  { const g = groupFromCfg(rec); if (g !== null) rec.meta.group = g; }
  { const ig = ignoredFromCfg(rec); if (ig !== null) rec.meta.ignoredOutputs = ig; }
  { const pr = profilesFromCfg(rec); if (pr !== null) rec.meta.outputProfiles = pr; }
  // an offline-queued edit displays as if already applied, until resolved (apply/discard)
  if (rec.meta.offlineQueue) {
    if (rec.meta.offlineQueue.group !== undefined) rec.meta.group = rec.meta.offlineQueue.group;
    if (rec.meta.offlineQueue.ignoredOutputs !== undefined) rec.meta.ignoredOutputs = rec.meta.offlineQueue.ignoredOutputs;
    if (rec.meta.offlineQueue.outputProfiles !== undefined) rec.meta.outputProfiles = rec.meta.offlineQueue.outputProfiles;
  }
  const d = {};
  if (info) {
    d.product = [info.brand, info.product].filter(Boolean).join(' ');
    if (info.fs) d.fs = `${info.fs.u} / ${info.fs.t} kB`;
    d.ledmaps = Array.isArray(info.maps) ? info.maps.length : null;
    d.segments = Array.isArray(info.leds && info.leds.seglc) ? info.leds.seglc.length : null;
    d.fw = firmware.assess(info);
    d.ap = ap.forNode(info.mac);
  }
  // DMX plan: how the console must address this node's pixels (E1.31 / Art-Net)
  d.dmx = dmxPlan(rec);
  // do name, mDNS and AP SSID agree? (WLED keeps them on two different settings pages)
  if (info && cfg && cfg.id) {
    const name = cfg.id.name || info.name || '';
    const mdns = String(cfg.id.mdns || '');
    const apSsid = cfg.ap ? String(cfg.ap.ssid || '') : null;
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const issues = [];
    if (mdns && norm(mdns) !== norm(name)) issues.push(`mDNS « ${mdns} »`);
    if (apSsid && norm(apSsid) !== norm(name)) issues.push(`AP « ${apSsid} »`);
    d.nameMismatch = issues.length ? `nom « ${name} » ≠ ${issues.join(' et ')}` : null;
  }
  if (cfg) {
    const { LED_TYPES, COLOR_ORDERS } = require('./columns');
    const ins = (cfg.hw && cfg.hw.led && cfg.hw.led.ins) || [];
    d.outputs = ins.map(b => {
      const t = LED_TYPES[b.type] || `type ${b.type}`;
      const o = COLOR_ORDERS[(b.order || 0) & 0x0f] || b.order;
      return `${(b.pin || []).join('/')}:${b.len} ${t} ${o}${b.rev ? ' rev' : ''}`;
    }).join(' | ');
    const nw = cfg.nw && cfg.nw.ins && cfg.nw.ins[0];
    if (nw) {
      const j = a => Array.isArray(a) ? a.join('.') : '';
      d.staticIp = j(nw.ip) === '0.0.0.0' ? 'DHCP' : j(nw.ip);
      d.gw = j(nw.gw);
    }
  }
  rec.derived = d;
}

// ── DMX plan ─────────────────────────────────────────────────────────────────
// WLED "Multi" modes: pixels are taken in order across consecutive universes,
// 170 RGB (510 ch) or 128 RGBW (512 ch) pixels per universe, starting at
// dmx.uni / dmx.addr. An output (a physical strip) therefore usually straddles
// two universes. This computes, per output, the universe.address of its first
// and last pixel, and per universe what it carries, so the console patch can
// be derived instead of guessed.
const DMX_MODES_PX = { 4: 3, 5: 3, 6: 4 }; // Multi RGB, Multi DRGB (1 ch dimmer first), Multi RGBW -> channels per pixel
function dmxPlan(rec) {
  const cfg = rec.cfg; if (!cfg || !cfg.if || !cfg.if.live || !cfg.hw || !cfg.hw.led) return null;
  const x = cfg.if.live.dmx || {};
  const mode = Number(x.mode), uni = Number(x.uni) || 1, addr = Number(x.addr) || 1;
  const chPerPx = DMX_MODES_PX[mode];
  const ignored = new Set(rec.meta.ignoredOutputs || []);
  const profs = rec.meta.outputProfiles || [];
  const outs = (cfg.hw.led.ins || []).map((b, i) => ({ i, profile: profs[i] || null, pin: (b.pin || []).join('/'), start: b.start, len: b.len, rgbw: [30, 31, 41, 44, 88].includes(b.type), ignored: ignored.has(b.start) }));
  const total = outs.reduce((a, o) => Math.max(a, o.start + o.len), 0);
  if (!chPerPx) return { mode, uni, addr, total, outputs: outs, multi: false, note: 'mode DMX non « Multi » : pas de mapping pixel par pixel' };
  const pxPerUni = Math.floor(512 / chPerPx); // 170 RGB / 128 RGBW
  const hasDimmer = mode === 5;
  // pixel index -> {universe, channel}: first universe starts at `addr` (and holds fewer pixels), next ones at 1
  const firstUniPx = Math.floor((512 - (addr - 1) - (hasDimmer ? 1 : 0)) / chPerPx);
  const locate = px => {
    if (px < firstUniPx) return { u: uni, ch: addr + (hasDimmer ? 1 : 0) + px * chPerPx };
    const rest = px - firstUniPx; return { u: uni + 1 + Math.floor(rest / pxPerUni), ch: 1 + (rest % pxPerUni) * chPerPx };
  };
  const fmt = l => `${l.u}.${l.ch}`;
  for (const o of outs) { if (!o.len) continue; const a = locate(o.start), b = locate(o.start + o.len - 1); o.from = fmt(a); o.to = `${b.u}.${b.ch + chPerPx - 1}`; o.universes = b.u - a.u + 1; o.straddles = b.u !== a.u; }
  const lastU = total ? locate(total - 1).u : uni;
  const universes = [];
  for (let u = uni; u <= lastU; u++) {
    const pxStart = u === uni ? 0 : firstUniPx + (u - uni - 1) * pxPerUni;
    const pxEnd = Math.min(total, u === uni ? firstUniPx : pxStart + pxPerUni) - 1;
    const carrying = outs.filter(o => o.len && o.start <= pxEnd && o.start + o.len - 1 >= pxStart);
    const carries = carrying.map(o => `sortie ${o.i + 1} (pin ${o.pin})${o.ignored ? ' (non comptée)' : ''}`);
    // a universe fed only by ignored outputs is greyed and excluded from conflict detection
    universes.push({ u, pxStart, pxEnd, px: pxEnd - pxStart + 1, channels: (pxEnd - pxStart + 1) * chPerPx + (u === uni && hasDimmer ? 1 : 0), carries, ignored: carrying.length > 0 && carrying.every(o => o.ignored) });
  }
  return { mode, chPerPx, pxPerUni, uni, addr, total, universesUsed: universes.length, firstUni: uni, lastUni: lastU, outputs: outs, universes, multi: true, hasDimmer };
}

// ── Change journal ───────────────────────────────────────────────────────────
// Every poll is diffed against the previous snapshot on the watched columns
// (columns.js: watch !== false). A change is tagged 'grille' when this server
// just wrote that cell, 'externe' otherwise (WLED UI, another tool, a preset…).
// a fixed --ip list (dev / mock runs) journals apart from the real fleet
const CHANGES_FILE = path.join(__dirname, FIXED_IPS.length ? 'changes-dev.log' : 'changes.log');
let changes = [];
const WATCHED = columns.filter(c => c.watch !== false && c.path.split('.')[0] !== 'meta');
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

function snapshot(rec) {
  const s = new Map();
  for (const c of WATCHED) s.set(c.id, JSON.stringify(getPath(rec, c.path)));
  return s;
}
function recordChange(rec, colId, oldV, newV, source) {
  const ev = { at: Date.now(), ip: rec.meta.ip, name: (rec.info && rec.info.name) || rec.meta.ip, col: colId, old: oldV, new: newV, source };
  changes.push(ev);
  if (changes.length > 2000) changes = changes.slice(-2000);
  fs.appendFile(CHANGES_FILE, JSON.stringify(ev) + '\n', () => {});
  console.log(`[${source}] ${ev.name} ${colId}: ${JSON.stringify(oldV)} -> ${JSON.stringify(newV)}`);
}
// fleet-level journal entry (not tied to one node)
function recordChangeFleet(text) {
  const ev = { at: Date.now(), ip: '', name: 'flotte', col: 'snapshot', old: null, new: text, source: 'sauvegarde' };
  changes.push(ev); fs.appendFile(CHANGES_FILE, JSON.stringify(ev) + '\n', () => {}); console.log(`[sauvegarde] ${text}`);
}
function diffSnapshot(rec, before, source) {
  for (const c of WATCHED) {
    const prev = before.get(c.id), cur = JSON.stringify(getPath(rec, c.path));
    if (prev === undefined || prev === cur) continue; // first poll or unchanged
    recordChange(rec, c.id, JSON.parse(prev), cur === undefined ? null : JSON.parse(cur), source);
  }
}
function loadChanges() {
  try {
    const lines = fs.readFileSync(CHANGES_FILE, 'utf8').trim().split('\n').slice(-500);
    changes = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no journal yet */ }
}

async function pollInfoState(rec, source = 'externe') {
  const ip = rec.meta.ip;
  const before = snapshot(rec);
  const wasOnline = rec.meta.online;
  const firstPoll = !rec.meta.lastSeen; // no "came online" event at startup
  try {
    const [i, s] = await Promise.all([getJson(ip, '/json/info'), getJson(ip, '/json/state')]);
    if (!i.json || !i.json.ver) throw new Error('not a WLED node');
    delete i.json.u; // usermod HTML snippets, useless here
    rec.info = i.json; rec.state = s.json;
    rec.meta.online = true; rec.meta.latency = i.latency; rec.meta.lastSeen = Date.now();
    rec.meta.fails = 0; rec.meta.err = ''; rec.meta.relocating = null;
    mergeByMac(rec);
    if (!rec.cfg || Date.now() - rec.meta.cfgUpdated > CFG_INTERVAL) await pollCfg(rec, null);
  } catch (e) {
    rec.meta.fails++;
    rec.meta.err = e.message;
    if (rec.meta.fails >= 2) rec.meta.online = false;
  }
  derive(rec);
  const ota = rec.meta.ota && ['flash', 'reboot'].includes(rec.meta.ota.status);
  const restoring = rec.meta.restoreUntil && Date.now() < rec.meta.restoreUntil; // changes right after a snapshot restore are ours
  if (!firstPoll && wasOnline !== rec.meta.online && !ota && !restoring) recordChange(rec, 'online', wasOnline, rec.meta.online, 'statut');
  diffSnapshot(rec, before, ota ? 'maj' : restoring && source === 'externe' ? 'restauration' : source);
}

// ── OTA queue: N nodes at a time (default 1), always from the local store ────
// Parallelism is a Wi-Fi airtime question, not a WLED one: Ethernet nodes can
// take a whole batch at once, Wi-Fi nodes are safer one or two at a time.
const otaQueue = [];
let otaWorkers = 0;
let otaParallel = Math.max(1, Number(flag('ota-parallel', 1)) || 1);

function enqueueOta(ip, tag, asset, parallel) {
  if (parallel) otaParallel = Math.max(1, Math.min(32, Number(parallel) || 1));
  if (READONLY) throw new Error('serveur en lecture seule (--readonly)');
  const rec = fleet.get(ip);
  if (!rec) throw new Error('node inconnu');
  if (!firmware.isLocal(tag, asset)) throw new Error(`${asset} n'est pas dans le dépôt local : le télécharger d'abord`);
  const m = firmware.ASSET_RE.exec(asset);
  if (rec.info && m && m[2] !== rec.info.release) throw new Error(`plateforme ${m[2]} ≠ ${rec.info.release} du node`);
  if (rec.cfg && rec.cfg.ota && rec.cfg.ota.lock) throw new Error('OTA verrouillé sur ce node (Sécurité > OTA lock)');
  if (rec.meta.ota && ['queued', 'flash', 'reboot'].includes(rec.meta.ota.status)) throw new Error('mise à jour déjà en cours');
  rec.meta.ota = { status: 'queued', tag, asset, from: rec.info && rec.info.ver, at: Date.now(), msg: '' };
  otaQueue.push(ip);
  runOta();
  return rec.meta.ota;
}

function runOta() {
  while (otaWorkers < otaParallel && otaQueue.length) otaWorker();
}

async function otaWorker() {
  otaWorkers++;
  try {
    while (otaQueue.length) {
      const ip = otaQueue.shift();
      const rec = fleet.get(ip);
      if (!rec || !rec.meta.ota) continue;
      const o = rec.meta.ota;
      try {
        o.status = 'flash'; o.at = Date.now(); o.sent = 0; o.total = 0;
        console.log(`OTA ${ip}: envoi ${o.asset}`);
        o.msg = await firmware.flashFile(ip, firmware.localPath(o.tag, o.asset), (sent, total) => { o.sent = sent; o.total = total; });
        o.status = 'reboot'; o.at = Date.now();
        // wait for the node to come back with a (hopefully) new version
        const deadline = Date.now() + 150000;
        let ok = false;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 4000));
          try {
            const i = await getJson(ip, '/json/info', 3000);
            if (i.json && i.json.ver && i.json.ver !== o.from) { ok = true; break; }
            if (i.json && i.json.ver && Date.now() - o.at > 60000) { ok = true; break; } // same version (re-flash), but back online
          } catch { /* still rebooting */ }
        }
        rec.meta.cfgUpdated = 0; // force cfg re-read
        await pollInfoState(rec, 'maj');
        o.status = ok ? 'done' : 'timeout'; o.to = rec.info && rec.info.ver; o.at = Date.now();
        // the version change itself is journaled by pollInfoState(rec, 'maj') above
        console.log(`OTA ${ip}: ${o.status} ${o.from} -> ${o.to}`);
      } catch (e) {
        o.status = 'error'; o.msg = e.message; o.at = Date.now();
        console.log(`OTA ${ip}: ÉCHEC ${e.message}`);
      }
    }
  } finally { otaWorkers--; }
}

// pollCfg(rec, source): source === null means the caller diffs (pollInfoState).
async function pollCfg(rec, source = 'externe') {
  const before = source ? snapshot(rec) : null;
  const c = await getJson(rec.meta.ip, '/json/cfg', 4000);
  rec.cfg = c.json;
  rec.meta.cfgUpdated = Date.now();
  derive(rec);
  if (before) diffSnapshot(rec, before, source);
}

let polling = false;
async function pollAll() {
  if (polling || maintenance) return; // paused while the Wi-Fi card is away (pairing / deep scan)
  polling = true;
  try {
    // nodes being flashed are polled by their OTA worker only (avoids two
    // concurrent diffs journaling the same change twice)
    const recs = [...fleet.values()].filter(r => !(r.meta.ota && ['flash', 'reboot'].includes(r.meta.ota.status)));
    // bounded concurrency: 8 nodes at a time
    for (let i = 0; i < recs.length; i += 8) {
      await Promise.all(recs.slice(i, i + 8).map(r => pollInfoState(r)));
    }
  } finally { polling = false; }
}

// ── Discovery ────────────────────────────────────────────────────────────────
function localIfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ iface: name, address: a.address, subnet: a.address.split('.').slice(0, 3).join('.') });
    }
  }
  return out;
}
function localSubnets() { return [...new Set(localIfaces().map(i => i.subnet))]; }
// a node is "foreign" when the fleet subnet is pinned and the node's IP is elsewhere
const isForeign = ip => !!(SUBNETS && !SUBNETS.includes(String(ip).split(':')[0].split('.').slice(0, 3).join('.')));

// ── Identify: flash a node full white for a few seconds, then restore ────────
// Saves /json/state, forces white at full brightness with live-override on
// (so it shows even under an E1.31 / DDP stream), restores the saved state
// after `ms`. Nothing is written to flash: /json/state is volatile.
const identifying = new Set();
async function identifyNode(ip, ms = 3000) {
  if (identifying.has(ip)) return { ok: true, already: true };
  const rec = fleet.get(ip);
  if (!rec) throw new Error('node inconnu');
  identifying.add(ip);
  try {
    const saved = (await getJson(ip, '/json/state', 3000)).json;
    const segs = (saved.seg || []).filter(s => s.stop > s.start).map(s => ({ id: s.id, on: true, bri: 255, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]], fx: 0, frz: false }));
    await postJson(ip, '/json/state', { on: true, bri: 255, tt: 0, lor: 1, seg: segs }, 3000);
    setTimeout(async () => {
      try {
        // WLED accepts its own state document back; drop read-only / runtime keys
        const back = { ...saved, tt: 0, lor: saved.lor || 0 };
        delete back.nl; delete back.udpn; delete back.ledmap; delete back.mainseg;
        back.seg = (saved.seg || []).map(s => { const c = { ...s }; delete c.len; delete c.n; delete c.set; return c; });
        await postJson(ip, '/json/state', back, 3000);
      } catch (e) { console.log(`identify ${ip}: état non rétabli (${e.message})`); }
      finally { identifying.delete(ip); }
    }, ms);
    return { ok: true, ms };
  } catch (e) { identifying.delete(ip); throw e; }
}

// ── Locate pixel: light only the last pixel of an output, rest of it light blue ──
// For counting a strip's real pixels: commandeers segment 0 for the output's
// exact start/len, live-override so it shows over any E1.31/DDP stream. Two
// plain solid-colour segments (0 = light blue, 1 = the single last pixel in
// white) — WLED's per-LED "i" override looked right on paper but a real
// round-trip against the emulator showed it has no visible effect (accepted,
// no error, pixel buffer unchanged), while two segments render exactly as
// intended (checked pixel-by-pixel via GET /json/live). One call starts
// (saves segment 0, and segment 1 if the node already had one), later calls
// with a new `len` just move the marker. A call with no follow-up for
// LOCATE_TIMEOUT_MS auto-restores, so leaving the tab never strands a node
// lit up. Nothing is written to flash.
const locating = new Map(); // ip -> { saved, seg0, seg1, seg1Existed, touchedSeg1, timer }
const LOCATE_TIMEOUT_MS = 90000;
async function setLocatePixel(ip, start, len) {
  len = Math.max(1, Math.min(4096, Math.round(len)));
  start = Math.max(0, Math.round(start));
  let session = locating.get(ip);
  if (!session) {
    const saved = (await getJson(ip, '/json/state', 3000)).json;
    const seg0 = (saved.seg || []).find(s => s.id === 0) || (saved.seg || [])[0];
    if (!seg0) throw new Error('aucun segment sur ce node');
    const seg1 = (saved.seg || []).find(s => s.id === 1) || null;
    session = { saved, seg0, seg1, seg1Existed: !!seg1, touchedSeg1: false };
    locating.set(ip, session);
  }
  clearTimeout(session.timer);
  const last = start + len - 1;
  const segs = [];
  if (len > 1) {
    segs.push({ id: session.seg0.id, start, stop: last, on: true, bri: 255, col: [[48, 96, 255], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 0, frz: false });
    segs.push({ id: 1, start: last, stop: last + 1, on: true, bri: 255, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 0, frz: false });
    session.touchedSeg1 = true;
  } else {
    segs.push({ id: session.seg0.id, start, stop: last + 1, on: true, bri: 255, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 0, frz: false });
  }
  await postJson(ip, '/json/state', { on: true, bri: 255, tt: 0, lor: 1, seg: segs }, 3000);
  session.timer = setTimeout(() => { stopLocatePixel(ip).catch(() => {}); }, LOCATE_TIMEOUT_MS);
  return { ok: true };
}
async function stopLocatePixel(ip) {
  const session = locating.get(ip); if (!session) return { ok: true, already: false };
  clearTimeout(session.timer);
  locating.delete(ip);
  const { saved, seg0, seg1, seg1Existed, touchedSeg1 } = session;
  const back = { ...saved, tt: 0, lor: saved.lor || 0 };
  delete back.nl; delete back.udpn; delete back.ledmap; delete back.mainseg;
  const strip = s => { const c = { ...s }; delete c.len; delete c.n; delete c.set; return c; };
  const segs = [strip(seg0)];
  if (touchedSeg1) segs.push(seg1Existed ? strip(seg1) : { id: 1, stop: 0 }); // stop:0 removes a segment we created
  back.seg = segs;
  await postJson(ip, '/json/state', back, 3000);
  return { ok: true };
}

// ── Free, logical IP for a new node ──────────────────────────────────────────
// Follows the IP block of the most similar existing nodes (by name), skips
// fleet IPs, the gateway, IPs in `taken` (other candidates of the same
// listing) and anything that answers on the network. Only the IP: the node's
// name is never touched by the pairing.
async function suggestFor(hint, taken) {
  hint = String(hint || '').toLowerCase();
  const recs = [...fleet.values()].filter(r => r.info && r.info.name);
  const base = n => String(n).replace(/[\s_-]*\d+$/, '');
  const fam = recs.filter(r => hint && base(r.info.name).toLowerCase().replace(/[\s_-]/g, '').includes(hint.replace(/[^a-z0-9]/g, '').slice(0, 5)));
  const pool = fam.length ? fam : recs;
  const used = new Set([...fleet.values()].map(r => r.meta.ip.split(':')[0]));
  const ips = pool.map(r => r.meta.ip.split('.').map(Number)).filter(a => a.length === 4);
  const subnet = ips.length ? ips[0].slice(0, 3).join('.') : (SUBNETS || localSubnets())[0];
  const start = ips.length ? Math.max(...ips.map(a => a[3])) + 1 : 100;
  let ip = null;
  for (let h = start; h < 250; h++) {
    const cand = `${subnet}.${h}`;
    if (used.has(cand) || taken.has(cand) || cand === `${subnet}.1`) continue;
    if (!(await probe(cand))) { ip = cand; break; }
  }
  return { ip, gw: `${subnet}.1`, sn: '255.255.255.0', basedOn: pool.slice(0, 3).map(r => `${r.info.name} ${r.meta.ip}`) };
}

// ── Relocate a foreign node into the fleet subnet ────────────────────────────
// Rewrites only ip/gw/sn of the node's first Wi-Fi profile. cfg.json never
// returns the PSK and WLED keeps it when the key is absent, so the node stays
// on its SSID. The whole nw.ins array is re-sent (WLED sizes it from the
// payload) with every other field untouched. Then reboot; the node comes back
// at its new address, where the fleet picks it up.
async function relocateNode(ip, target) {
  if (READONLY) throw new Error('serveur en lecture seule');
  const rec = fleet.get(ip);
  if (!rec || !rec.cfg || !rec.cfg.nw || !Array.isArray(rec.cfg.nw.ins) || !rec.cfg.nw.ins.length) throw new Error('config réseau du node inconnue (pas encore lue)');
  let ipA, gwA, snA;
  if (target.dhcp) { ipA = [0, 0, 0, 0]; gwA = [0, 0, 0, 0]; snA = [255, 255, 255, 0]; }
  else {
    ipA = String(target.ip).split('.').map(Number); gwA = (target.gw || `${target.ip.split('.').slice(0, 3).join('.')}.1`).split('.').map(Number); snA = (target.sn || '255.255.255.0').split('.').map(Number);
    if ([ipA, gwA, snA].some(a => a.length !== 4 || a.some(n => !(n >= 0 && n <= 255)))) throw new Error('IP / passerelle / masque invalides (ex. 192.168.88.84, ou DHCP)');
    if (target.ip === ip.split(':')[0]) throw new Error('le node a déjà cette adresse');
    if (fleet.has(target.ip)) throw new Error(`${target.ip} est déjà prise par ${(fleet.get(target.ip).info || {}).name || 'un node de la flotte'} — pour échanger deux IP, passer par une adresse intermédiaire`);
    if (await probe(target.ip)) throw new Error(`${target.ip} répond déjà sur le réseau`);
  }
  const ins = rec.cfg.nw.ins.map((e, i) => { const c = { ...e }; delete c.psk; if (i === 0) { c.ip = ipA; c.gw = gwA; c.sn = snA; } return c; });
  await postJson(ip, '/json/cfg', { nw: { ins } }, 6000);
  recordChange(rec, 'staticip', rec.derived.staticIp || null, target.dhcp ? 'DHCP' : target.ip, 'grille');
  try { await postJson(ip, '/json/state', { rb: true }, 4000); } catch { /* reboots before answering */ }
  if (target.dhcp) {
    // unknown next address: the row stays (identified by MAC), a scan 20 s later finds it and merges by MAC
    rec.meta.relocating = Date.now();
    setTimeout(() => { if (!FIXED_IPS.length) scan(); }, 20000);
    return { from: ip, to: 'DHCP' };
  }
  // follow the node: same record, new key, so selection / journal / last-known data survive
  fleet.delete(ip); rec.meta.ip = target.ip; rec.meta.fails = 0; fleet.set(target.ip, rec); saveKnown();
  setTimeout(() => pollInfoState(rec, 'grille'), 15000);
  return { from: ip, to: target.ip };
}

// ── Batch of IP moves (swaps allowed) ────────────────────────────────────────
// All nodes get their new address written first (no reboot), then all reboot
// together: a target still held by a node that moves away in the same batch is
// fine, the old address is released exactly when the new one is taken.
function ipPlanFor(rec, target) {
  if (target.dhcp) return { ipA: [0, 0, 0, 0], gwA: [0, 0, 0, 0], snA: [255, 255, 255, 0] };
  const ipA = String(target.ip).split('.').map(Number), gwA = (target.gw || `${target.ip.split('.').slice(0, 3).join('.')}.1`).split('.').map(Number), snA = (target.sn || '255.255.255.0').split('.').map(Number);
  if ([ipA, gwA, snA].some(a => a.length !== 4 || a.some(n => !(n >= 0 && n <= 255)))) throw new Error('IP / passerelle / masque invalides (ex. 192.168.88.84, ou DHCP)');
  return { ipA, gwA, snA };
}
async function relocateBatch(moves) {
  if (READONLY) throw new Error('serveur en lecture seule');
  const plan = [];
  const leaving = new Set(moves.map(m => m.ip.split(':')[0]));
  for (const m of moves) {
    const rec = fleet.get(m.ip);
    if (!rec || !rec.cfg || !rec.cfg.nw || !Array.isArray(rec.cfg.nw.ins) || !rec.cfg.nw.ins.length) throw new Error(`${m.ip} : config réseau pas encore lue`);
    const target = /^dhcp$/i.test(String(m.to)) ? { dhcp: true } : { ip: String(m.to).trim() };
    const p = ipPlanFor(rec, target);
    if (!target.dhcp) {
      if (target.ip === m.ip.split(':')[0]) throw new Error(`${m.ip} : a déjà cette adresse`);
      if (moves.filter(x => !/^dhcp$/i.test(String(x.to)) && String(x.to).trim() === target.ip).length > 1) throw new Error(`${target.ip} demandée par plusieurs nodes`);
      const holder = fleet.get(target.ip);
      if (holder && !leaving.has(target.ip)) throw new Error(`${target.ip} est déjà prise par ${(holder.info || {}).name || 'un node'} qui ne bouge pas — l'inclure dans le même déploiement pour échanger`);
      if (!holder && await probe(target.ip)) throw new Error(`${target.ip} répond déjà sur le réseau`);
    }
    plan.push({ rec, from: m.ip, target, ...p });
  }
  // phase 1: write everywhere, no reboot yet
  for (const p of plan) {
    const ins = p.rec.cfg.nw.ins.map((e, i) => { const c = { ...e }; delete c.psk; if (i === 0) { c.ip = p.ipA; c.gw = p.gwA; c.sn = p.snA; } return c; });
    await postJson(p.from, '/json/cfg', { nw: { ins } }, 6000);
    recordChange(p.rec, 'staticip', p.rec.derived.staticIp || null, p.target.dhcp ? 'DHCP' : p.target.ip, 'grille');
  }
  // phase 2: reboot all (best effort, they drop the connection while rebooting)
  await Promise.all(plan.map(p => postJson(p.from, '/json/state', { rb: true }, 4000).catch(() => {})));
  // phase 3: re-key the records so each row follows its node
  for (const p of plan) fleet.delete(p.from);
  for (const p of plan) {
    if (p.target.dhcp) { p.rec.meta.relocating = Date.now(); fleet.set(p.from, p.rec); continue; } // found again by scan + MAC merge
    p.rec.meta.ip = p.target.ip; p.rec.meta.fails = 0; fleet.set(p.target.ip, p.rec);
  }
  saveKnown();
  setTimeout(() => { plan.forEach(p => pollInfoState(p.rec, 'grille')); if (plan.some(p => p.target.dhcp) && !FIXED_IPS.length) scan(); }, 15000);
  return { moved: plan.map(p => ({ from: p.from, to: p.target.dhcp ? 'DHCP' : p.target.ip, name: (p.rec.info || {}).name })) };
}

// ── Identity by MAC: a node that comes back on another IP updates its row ─────
// Called after a successful poll. If another record carries the same MAC on a
// different IP, that older record is the same physical node before it moved
// (DHCP renewal, static IP change, relocation): merge into this one.
function mergeByMac(rec) {
  const mac = rec.info && rec.info.mac && rec.info.mac.toLowerCase();
  if (!mac) return;
  for (const [ip, other] of fleet) {
    if (other === rec || !other.info || !other.info.mac || other.info.mac.toLowerCase() !== mac) continue;
    // keep the live one; carry over what only the old row knew
    if (!rec.cfg && other.cfg) rec.cfg = other.cfg;
    if (!rec.meta.group && other.meta.group) rec.meta.group = other.meta.group;
    if (!rec.meta.ignoredOutputs && other.meta.ignoredOutputs) rec.meta.ignoredOutputs = other.meta.ignoredOutputs;
    fleet.delete(ip);
    recordChange(rec, 'ip', ip, rec.meta.ip, 'statut');
    console.log(`même node (MAC ${mac}) : ${ip} → ${rec.meta.ip}, ligne fusionnée`);
    saveKnown();
  }
}

const recentPcNets = new Map(); // Wi-Fi networks seen by the PC's card in the last 3 min (pairing list)
// Who can be a WLED: only Espressif chips run it. IEEE MA-L registry, Espressif
// entries only (tools/espressif-oui.json, 344 prefixes). A BSSID outside this
// list is NEVER a WLED; inside it is "probable" until verified by reading
// /json/info through its AP (POST /api/pair/test), which is the only proof.
const ESPRESSIF_OUIS = (() => { try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'tools', 'espressif-oui.json'), 'utf8')).ouis); } catch { return new Set(); } })();
const verifiedAps = new Map(); // ssid -> { info, at } once /json/info was read through that AP

// ── Maintenance window: the Wi-Fi card is busy elsewhere ─────────────────────
// On a Wi-Fi-only PC, a pairing or a deep Wi-Fi scan takes the fleet link
// away for 20-40 s. Rather than marking every node offline and flooding the
// journal, polling (nodes + antenna) is paused, then resumed once the PC is
// back on the fleet subnet.
let maintenance = null; // { reason, since }
function beginMaintenance(reason) {
  maintenance = { reason, since: Date.now() };
  console.log(`pause des relevés : ${reason}`);
}
async function endMaintenance() {
  // wait (up to 45 s) for an address on the fleet subnet before resuming
  for (let i = 0; i < 45; i++) { if (netStatus().onFleetSubnet) break; await new Promise(r => setTimeout(r, 1000)); }
  const st = netStatus();
  const took = maintenance ? Math.round((Date.now() - maintenance.since) / 1000) : 0;
  maintenance = null;
  console.log(`reprise des relevés (${took} s)${st.onFleetSubnet ? '' : ' — PC toujours hors du réseau de la flotte'}`);
  if (st.onFleetSubnet) { fleet.forEach(r => { r.meta.fails = 0; }); pollAll(); }
}
provision.setHooks({ onBegin: beginMaintenance, onEnd: endMaintenance });

// ── Network watcher: card change, cable out, new subnet ──────────────────────
// The PC's interfaces are re-read every 5 s. When they change (card swapped,
// DHCP lease on another subnet, cable pulled / plugged back), we log it,
// journal it, re-aim the MNDP broadcasts, and rescan as soon as the fleet
// subnet is reachable again. Nodes themselves are never forgotten: they just
// go offline (2 missed polls) and come back on their own.
let netSig = '';
function netStatus() {
  const ifs = localIfaces();
  const wanted = SUBNETS || ifs.map(i => i.subnet);
  // wired first: when the PC is on the fleet subnet by cable AND Wi-Fi, the cable is the one that matters
  const on = ifs.filter(i => wanted.includes(i.subnet)).sort((a, b) => /wi-?fi|wlan|sans fil/i.test(a.iface) - /wi-?fi|wlan|sans fil/i.test(b.iface));
  return { ifaces: ifs, subnets: wanted, onFleetSubnet: on.length > 0, fleetIface: on[0] || null };
}
function watchNetwork() {
  const st = netStatus();
  const sig = st.ifaces.map(i => `${i.iface}=${i.address}`).sort().join(',');
  if (sig === netSig) return;
  const first = netSig === '';
  netSig = sig;
  const desc = st.ifaces.map(i => `${i.iface} ${i.address}`).join(', ') || 'aucune interface';
  console.log(`réseau: ${desc}${st.onFleetSubnet ? '' : ` — PAS sur ${st.subnets.join('/')}`}`);
  if (maintenance) return; // expected while the Wi-Fi card is away: no journal noise, no rescan
  if (!first) recordChangeFleet(`réseau du PC : ${desc}${st.onFleetSubnet ? '' : ' (hors du réseau de la flotte)'}`);
  ap.setBroadcasts((SUBNETS || localSubnets()).map(s => s + '.255'));
  if (!first && st.onFleetSubnet) { fleet.forEach(r => { r.meta.fails = 0; }); pollAll(); if (!FIXED_IPS.length) scan(); }
}

async function probe(ip) {
  try {
    const r = await getJson(ip, '/json/info', 1500);
    return r.json && r.json.ver ? ip : null;
  } catch { return null; }
}

function addNode(ip) {
  if (!fleet.has(ip)) fleet.set(ip, newRecord(ip));
  return fleet.get(ip);
}

async function scan() {
  if (scanning) return { scanning: true };
  scanning = true;
  const t0 = Date.now();
  try {
    // fleet subnet(s) + every other subnet this PC sits on ("rescue" sweep):
    // a node whose static IP is wrong ends up there, still reachable, and
    // gets flagged foreign so it can be relocated from the grid
    const subnets = SUBNETS || localSubnets();
    const rescue = SUBNETS ? localSubnets().filter(s => !SUBNETS.includes(s)) : [];
    const targets = [];
    for (const s of [...subnets, ...rescue]) for (let h = 1; h < 255; h++) targets.push(`${s}.${h}`);
    const found = [];
    for (let i = 0; i < targets.length; i += 64) {
      const r = await Promise.all(targets.slice(i, i + 64).map(probe));
      r.forEach(ip => ip && found.push(ip));
    }
    found.forEach(addNode);
    // Expand through the WLED node list (UDP broadcast on port 65506): nodes on
    // other subnets or missed by the sweep show up here.
    for (const ip of [...fleet.keys()]) {
      try {
        const r = await getJson(ip, '/json/nodes', 2000);
        for (const n of (r.json && r.json.nodes) || []) {
          if (n.ip && !fleet.has(n.ip) && await probe(n.ip)) addNode(n.ip);
        }
      } catch { /* node offline or list disabled */ }
    }
    saveKnown();
    const foreign = [...fleet.values()].filter(r => isForeign(r.meta.ip)).map(r => r.meta.ip);
    lastScan = { at: Date.now(), ms: Date.now() - t0, subnets, rescue, found: found.length, total: fleet.size, foreign };
    console.log(`scan: ${lastScan.found} node(s) on ${subnets.join(', ')}${rescue.length ? ` (+ secours ${rescue.join(', ')})` : ''} in ${lastScan.ms} ms (fleet=${fleet.size}${foreign.length ? `, hors réseau: ${foreign.join(', ')}` : ''})`);
    pollAll();
    return lastScan;
  } finally { scanning = false; }
}

// known-nodes.json keeps, for every node, the LAST KNOWN info/state/cfg and
// when it was last seen: a node that is off (or on another site) still shows
// its whole row, greyed, with "vu il y a", instead of an empty line.
const knownEntries = () => [...fleet.values()].map(r => ({ ip: r.meta.ip, lastSeen: r.meta.lastSeen, info: r.info, state: r.state, cfg: r.cfg, ignoredOutputs: r.meta.ignoredOutputs || [], group: r.meta.group || '', offlineQueue: r.meta.offlineQueue || null }));
let declaredGroups = []; // Fleet-only group names, kept even when no node is in them
// LED profiles: what gets plugged on an output (type, colour order, pixels), reusable from the Sorties tab
const PROFILES_FILE = path.join(__dirname, 'led-profiles.json');
let ledProfiles = [];
const newProfileId = () => { const used = new Set(ledProfiles.map(x => x.id)); for (let n = 10; n < 1296; n++) { const id = n.toString(36).padStart(2, '0'); if (!used.has(id)) return id; } throw new Error('trop de profils'); };
function loadProfiles() {
  try { ledProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')).filter(x => x && x.name); } catch { ledProfiles = []; }
  let fix = false; for (const x of ledProfiles) if (!x.id || !/^[0-9a-z]{2}$/.test(x.id)) { x.id = newProfileId(); fix = true; } if (fix) saveProfiles();
}
function saveProfiles() { try { fs.writeFileSync(PROFILES_FILE, JSON.stringify(ledProfiles, null, 2)); } catch { /* ignore */ } }
function upsertProfile(b) {
  const name = String(b.name || '').trim().slice(0, 40); if (!name) throw new Error('nom vide');
  const prof = { name, type: Number(b.type), order: Number(b.order) || 0, len: Math.max(0, Number(b.len) || 0), perM: Number(b.perM) || null, note: String(b.note || '').slice(0, 80) };
  if (!Number.isFinite(prof.type)) throw new Error('type de LED manquant');
  const i = ledProfiles.findIndex(x => x.name.toLowerCase() === name.toLowerCase()); if (i >= 0) { prof.id = ledProfiles[i].id; ledProfiles[i] = prof; } else { prof.id = newProfileId(); ledProfiles.push(prof); }
  ledProfiles.sort((a, c) => a.name.localeCompare(c.name)); saveProfiles(); return prof;
}
loadProfiles();
const allGroups = () => [...new Set([...declaredGroups, ...[...fleet.values()].map(r => r.meta.group || '').filter(Boolean)])].sort((a, b) => a.localeCompare(b));
function saveKnown() {
  if (FIXED_IPS.length) return;
  try { fs.writeFileSync(KNOWN_FILE, JSON.stringify({ format: 'wled-fleet-known', savedAt: Date.now(), nodes: knownEntries(), groups: declaredGroups })); } catch { /* ignore */ }
}
function loadKnown() {
  let raw; try { raw = JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')); } catch { return; /* first run */ }
  const list = Array.isArray(raw) ? raw.map(ip => ({ ip })) : (raw.nodes || []); // legacy: plain IP list
  if (Array.isArray(raw.groups)) declaredGroups = raw.groups.filter(g => typeof g === 'string' && g);
  for (const e of list) {
    if (!e || !e.ip) continue;
    const r = addNode(e.ip);
    if (e.offlineQueue && typeof e.offlineQueue === 'object') r.meta.offlineQueue = e.offlineQueue; // edits made while this node was unreachable, not yet resolved
    if (e.info) { r.info = e.info; r.state = e.state || null; r.cfg = e.cfg || null; r.meta.lastSeen = e.lastSeen || null; r.meta.fails = 2; derive(r); }
    if (Array.isArray(e.ignoredOutputs)) r.meta.ignoredOutputs = e.ignoredOutputs; // Fleet-only: outputs not counted in the DMX plan
    if (typeof e.group === 'string' && e.group) r.meta.group = e.group; // Fleet-only: node group (zone, type…)
    if (r.meta.offlineQueue) { // offlineQueue overrides the two legacy fallbacks above too
      if (r.meta.offlineQueue.group !== undefined) r.meta.group = r.meta.offlineQueue.group;
      if (r.meta.offlineQueue.ignoredOutputs !== undefined) r.meta.ignoredOutputs = r.meta.offlineQueue.ignoredOutputs;
      if (r.meta.offlineQueue.outputProfiles !== undefined) r.meta.outputProfiles = r.meta.offlineQueue.outputProfiles;
    }
  }
}
setInterval(saveKnown, 60000).unref();

// remove nodes that are offline (optionally: not seen for more than `olderThanH` hours)
function purgeOffline(olderThanH) {
  const now = Date.now(), gone = [];
  for (const [ip, r] of fleet) {
    if (r.meta.online) continue;
    if (olderThanH && r.meta.lastSeen && now - r.meta.lastSeen < olderThanH * 3600000) continue;
    fleet.delete(ip); gone.push({ ip, name: r.info && r.info.name });
  }
  if (gone.length) { saveKnown(); recordChangeFleet(`purge : ${gone.map(g => g.name || g.ip).join(', ')} retiré(s) de la liste`); }
  return gone;
}

// ── Writes ───────────────────────────────────────────────────────────────────
function nest(dotted, value) {
  // 'if.live.dmx.uni' -> {if:{live:{dmx:{uni:value}}}}
  const keys = dotted.split('.');
  const root = {};
  let cur = root;
  keys.forEach((k, i) => { cur = cur[k] = (i === keys.length - 1) ? value : {}; });
  return root;
}

function coerce(col, raw) {
  switch (col.type) {
    case 'num': case 'enum': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`valeur numérique attendue (${raw})`);
      if (col.min !== undefined && n < col.min) throw new Error(`min ${col.min}`);
      if (col.max !== undefined && n > col.max) throw new Error(`max ${col.max}`);
      return n;
    }
    case 'bool': return raw === true || raw === 'true' || raw === 1 || raw === '1';
    default: return String(raw);
  }
}

async function writeCell(ip, colId, raw) {
  if (READONLY) throw new Error('serveur en lecture seule (--readonly)');
  const rec = fleet.get(ip);
  if (!rec) throw new Error('node inconnu');
  const col = columns.find(c => c.id === colId);
  if (!col || !col.write) throw new Error('colonne non modifiable');
  if (col.write.target === 'special') {
    const v = String(raw).trim();
    if (colId === 'staticip') {
      // IP fixe : réécrit ip/gw/sn du profil Wi-Fi, redémarre, et suit le node à sa nouvelle adresse
      const r = await relocateNode(ip, /^dhcp$/i.test(v) ? { dhcp: true } : { ip: v });
      return { ok: true, value: v, reboot: true, movedTo: r.to };
    }
    // ssid / gw : one field of the first Wi-Fi profile; the whole nw.ins array is re-sent without
    // psk (WLED keeps the stored password when the key is absent), then reboot
    if (!rec.cfg || !rec.cfg.nw || !Array.isArray(rec.cfg.nw.ins) || !rec.cfg.nw.ins.length) throw new Error('config réseau du node pas encore lue');
    const ins = rec.cfg.nw.ins.map(e => { const c = { ...e }; delete c.psk; return c; });
    if (colId === 'ssid') { if (!v) throw new Error('SSID vide'); ins[0].ssid = v; }
    else if (colId === 'gw') { const a = v.split('.').map(Number); if (a.length !== 4 || a.some(n => !(n >= 0 && n <= 255))) throw new Error('passerelle invalide'); ins[0].gw = a; }
    else throw new Error('colonne spéciale inconnue');
    rec.meta.pending++;
    try {
      await postJson(ip, '/json/cfg', { nw: { ins } }, 6000);
      recordChange(rec, colId, colId === 'ssid' ? rec.cfg.nw.ins[0].ssid : rec.derived.gw, v, 'grille');
      try { await postJson(ip, '/json/state', { rb: true }, 4000); } catch { /* reboots before answering */ }
      rec.meta.cfgUpdated = 0; setTimeout(() => pollInfoState(rec, 'grille'), 15000);
    } finally { rec.meta.pending--; }
    return { ok: true, value: v, reboot: true, rebooted: true };
  }
  const value = coerce(col, raw);
  // state.seg.N.field -> {seg:[{id:N, field}]} (WLED addresses segments by id in an array)
  const segM = col.write.target === 'state' && /^seg\.(\d+)\.(\w+)$/.exec(col.write.path);
  const body = segM ? { seg: [{ id: Number(segM[1]), [segM[2]]: value }] } : nest(col.write.path, value);
  rec.meta.pending++;
  try {
    if (col.write.target === 'cfg') {
      await postJson(ip, '/json/cfg', body, 5000);
      await pollCfg(rec, 'grille');
    } else {
      await postJson(ip, '/json/state', body, 5000);
      const before = snapshot(rec);
      const s = await getJson(ip, '/json/state');
      rec.state = s.json;
      diffSnapshot(rec, before, 'grille');
    }
  } finally { rec.meta.pending--; }
  return { ok: true, value, reboot: !!col.reboot };
}

// ── Antenna polling (started at boot if configured, or when the UI saves credentials)
let apTimer = null;
function startApPolling() {
  const c = ap.config(); if (!c) return;
  if (apTimer) clearInterval(apTimer);
  console.log(`antenne: ${c.host} (${c.user}) toutes les ${c.interval} ms`);
  const tick = async () => { if (maintenance) return; await ap.poll(); fleet.forEach(derive); };
  tick(); apTimer = setInterval(tick, c.interval);
}

// ── Web server ───────────────────────────────────────────────────────────────
const STATIC = path.join(__dirname, 'static');

function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length });
  res.end(b);
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readBody(req) {
  return readRaw(req).then(b => (b.length ? JSON.parse(b) : {}));
}
const envsInUse = () => new Set([...fleet.values()].map(r => r.info && r.info.release).filter(Boolean));
// RSSI a WLED node reports for itself (info.wifi.rssi), by MAC (any separator / case), or null
const nodeRssi = mac => { const m = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, ''); const rec = [...fleet.values()].find(r => r.info && r.info.mac && r.info.mac.toLowerCase().replace(/[^0-9a-f]/g, '') === m); return rec && rec.info.wifi && rec.info.wifi.rssi != null ? rec.info.wifi.rssi : null; };

function fleetPayload() {
  const now = Date.now();
  const nodes = [...fleet.values()].map(r => {
    r.meta.lastSeenAgo = r.meta.lastSeen ? Math.round((now - r.meta.lastSeen) / 1000) : null;
    return r;
  });
  nodes.forEach(n => { n.meta.foreign = isForeign(n.meta.ip); });
  return { updated: now, readonly: READONLY, scanning, lastScan, nodes, groups: allGroups(), net: netStatus(), maintenance };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  try {
    if (p === '/api/fleet') return send(res, 200, fleetPayload());
    if (p === '/api/columns') { const { LED_TYPES, COLOR_ORDERS } = require('./columns'); return send(res, 200, { columns, groups, ledTypes: LED_TYPES, colorOrders: COLOR_ORDERS }); }
    if ((m = /^\/api\/node\/([^/]+)\/outputs$/.exec(p)) && req.method === 'POST') {
      // LED outputs editor: WLED rebuilds hw.led.ins from the payload, so the WHOLE array is sent.
      // Only scalar fields we understand are taken from the UI; anything else on an existing bus is kept.
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec || !rec.cfg || !rec.cfg.hw || !rec.cfg.hw.led) return send(res, 400, { error: 'config du node pas encore lue' });
      const b = await readBody(req);
      if (!Array.isArray(b.ins) || !b.ins.length) return send(res, 400, { error: 'liste de sorties vide' });
      // previous buses by their start index: an edited row keeps the unknown fields of the bus it replaces
      const prevByStart = new Map((rec.cfg.hw.led.ins || []).map(e => [e.start, e]));
      const ins = [];
      for (let i = 0; i < b.ins.length; i++) {
        const u = b.ins[i];
        const pins = String(u.pin || '').split(/[\/,\s]+/).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 48);
        if (!pins.length) return send(res, 400, { error: `sortie ${i + 1} : pin invalide` });
        const len = Number(u.len), start = Number(u.start), type = Number(u.type), order = Number(u.order);
        if (!(len > 0 && len <= 4096)) return send(res, 400, { error: `sortie ${i + 1} : longueur invalide` });
        if (!(start >= 0)) return send(res, 400, { error: `sortie ${i + 1} : index de départ invalide` });
        const base = { ...(prevByStart.get(start) || {}) };
        ins.push({ ...base, pin: pins, type: Number.isFinite(type) ? type : (base.type ?? 22), order: Number.isFinite(order) ? order : (base.order ?? 0), start, len, rev: !!u.rev, skip: Number(u.skip) || 0 });
      }
      try {
        await postJson(ip, '/json/cfg', { hw: { led: { ins } } }, 8000);
        recordChange(rec, 'outputs', rec.derived.outputs, ins.map(x => `${x.pin.join('/')}:${x.start}+${x.len}`).join(' | '), 'grille');
        rec.meta.cfgUpdated = 0; await pollInfoState(rec, 'grille');
        return send(res, 200, { ok: true, outputs: rec.derived.outputs, total: rec.info && rec.info.leds && rec.info.leds.count });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if ((m = /^\/api\/node\/([^/]+)\/unify$/.exec(p)) && req.method === 'POST') {
      // align mDNS and AP SSID on the node's name (or on a new name if given); reboot needed for both
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec || !rec.info) return send(res, 404, { error: 'node inconnu' });
      const b = await readBody(req);
      const name = (b.name && String(b.name).trim()) || rec.info.name;
      const cfg = { id: { name, mdns: provision.hostnameSafe(name) }, ap: { ssid: name } };
      try {
        await postJson(ip, '/json/cfg', cfg, 6000);
        recordChange(rec, 'name', rec.info.name, name, 'grille');
        rec.meta.cfgUpdated = 0; await pollInfoState(rec, 'grille');
        if (b.reboot) { try { await postJson(ip, '/json/state', { rb: true }, 4000); } catch { /* reboots */ } }
        return send(res, 200, { ok: true, name, mdns: cfg.id.mdns, ap: name, rebooted: !!b.reboot });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if ((m = /^\/api\/node\/([^/]+)\/identify$/.exec(p)) && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await identifyNode(decodeURIComponent(m[1]), Math.min(15000, Math.max(500, Number(b.ms) || 3000)))); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if ((m = /^\/api\/node\/([^/]+)\/locate-pixel$/.exec(p)) && req.method === 'POST') {
      const ip = decodeURIComponent(m[1]);
      const b = await readBody(req);
      const start = Number(b.start), len = Number(b.len);
      if (!Number.isFinite(start) || !Number.isFinite(len) || len < 1) return send(res, 400, { error: 'sortie invalide' });
      try { return send(res, 200, await setLocatePixel(ip, start, len)); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if ((m = /^\/api\/node\/([^/]+)\/locate-pixel$/.exec(p)) && req.method === 'DELETE') {
      try { return send(res, 200, await stopLocatePixel(decodeURIComponent(m[1]))); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/nodes/relocate' && req.method === 'POST') {
      // several IP changes at once (swaps / rotations allowed): write all, reboot all
      const b = await readBody(req);
      if (!Array.isArray(b.moves) || !b.moves.length) return send(res, 400, { error: 'aucun déplacement' });
      try { return send(res, 200, await relocateBatch(b.moves)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if ((m = /^\/api\/node\/([^/]+)\/relocate$/.exec(p)) && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await relocateNode(decodeURIComponent(m[1]), b)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/settings' && req.method === 'GET') {
      return send(res, 200, {
        file: SETTINGS_FILE, settings,
        effective: { subnet: SUBNETS ? SUBNETS.join(',') : '', listen: LISTEN, interval: INTERVAL, cfgInterval: CFG_INTERVAL, readonly: READONLY, otaParallel },
        net: netStatus(), launcher: !!process.env.WLED_FLEET_LAUNCHER,
      });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      // validate, write settings.json, restart through the launcher so everything is re-read
      const b = await readBody(req);
      const next = {};
      const sub = String(b.subnet || '').trim();
      if (sub && !/^\d{1,3}\.\d{1,3}\.\d{1,3}(\s*,\s*\d{1,3}\.\d{1,3}\.\d{1,3})*$/.test(sub)) return send(res, 400, { error: 'sous-réseau attendu sous la forme 192.168.88 (plusieurs séparés par des virgules), ou vide = automatique' });
      if (sub) next.subnet = sub.replace(/\s+/g, '');
      const listen = String(b.listen || '127.0.0.1:8792').trim();
      if (!/^(\d{1,3}\.){3}\d{1,3}:\d{2,5}$/.test(listen)) return send(res, 400, { error: 'écoute attendue sous la forme ip:port, ex. 127.0.0.1:8792 ou 0.0.0.0:8792' });
      next.listen = listen;
      const iv = Number(b.interval), civ = Number(b.cfgInterval), par = Number(b.otaParallel);
      if (!(iv >= 1000 && iv <= 60000)) return send(res, 400, { error: 'intervalle état : 1000 à 60000 ms' });
      if (!(civ >= 5000 && civ <= 600000)) return send(res, 400, { error: 'intervalle cfg : 5000 à 600000 ms' });
      if (!(par >= 1 && par <= 32)) return send(res, 400, { error: 'parallélisme OTA : 1 à 32' });
      next.interval = iv; next.cfgInterval = civ; next.otaParallel = par; next.readonly = !!b.readonly;
      try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n'); } catch (e) { return send(res, 500, { error: `écriture settings.json : ${e.message}` }); }
      recordChangeFleet(`réglages enregistrés : ${JSON.stringify(next)}`);
      const restart = !!process.env.WLED_FLEET_LAUNCHER && b.restart !== false;
      send(res, 200, { ok: true, settings: next, restarting: restart });
      if (restart) { console.log('réglages modifiés, redémarrage'); setTimeout(() => process.exit(RESTART_EXIT_CODE), 300); }
      return;
    }
    if (p === '/api/open' && req.method === 'POST') {
      // open a URL in the system's default browser (the native window's WebView cannot):
      // this page itself, a tab in its own window, or a node's WLED UI
      const b = await readBody(req);
      const u = String(b.url || `http://127.0.0.1:${LISTEN.split(':')[1] || 8792}/`);
      if (!/^https?:\/\/[\w.:\-\/?#=&%+]*$/i.test(u)) return send(res, 400, { error: 'URL invalide' });
      try {
        require('child_process').execFile('cmd', ['/c', 'start', '', u.replace(/&/g, '^&')], { windowsHide: true }, () => {});
        return send(res, 200, { ok: true, url: u });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (p === '/api/about') return send(res, 200, { version: APP_VERSION, node: process.version, dir: __dirname, settingsFile: SETTINGS_FILE, settings, launcher: !!process.env.WLED_FLEET_LAUNCHER, pid: process.pid, uptime: Math.round(process.uptime()) });
    if (p === '/api/restart' && req.method === 'POST') {
      // reload edited source files: exit with the code the launcher restarts on
      if (!process.env.WLED_FLEET_LAUNCHER) return send(res, 409, { error: 'serveur lancé sans WLED-Fleet.cmd : le relancer à la main' });
      send(res, 200, { ok: true });
      console.log('redémarrage demandé depuis la page');
      setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
      return;
    }
    // ── fleet configuration snapshots (offline store, export / import / restore) ──
    // ── showfile: ONE file with everything the app knows (settings, antennas WITH
    // passwords, node list, config backups, firmware catalogue, optional journal),
    // optionally encrypted with a passphrase (scrypt + AES-256-GCM). The UI adds
    // its own column layout before saving the file.
    if (p === '/api/showfile' && req.method === 'POST') {
      const b = await readBody(req);
      const inc = b.include || {};
      const doc = {
        format: 'wledfleet-showfile', formatVersion: 1, app: APP_VERSION, exportedAt: new Date().toISOString(),
        settings, antennas: ap.exportStore(), knownNodes: knownEntries(), groups: declaredGroups, ledProfiles,
        snapshots: snapshots.list().map(s => { try { return snapshots.load(s.id); } catch { return null; } }).filter(Boolean),
        firmwareIndex: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'firmware', 'index.json'), 'utf8')); } catch { return null; } })(),
        journal: inc.journal ? changes.slice(-2000) : undefined,
        rfScans: inc.journal ? ap.scanHistory(200) : undefined,
        layout: b.layout || null,
      };
      let out = doc;
      if (b.passphrase) {
        const crypto = require('crypto');
        const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
        const key = crypto.scryptSync(String(b.passphrase), salt, 32);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
        out = { format: 'wledfleet-showfile-encrypted', formatVersion: 1, app: APP_VERSION, exportedAt: doc.exportedAt, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      }
      recordChangeFleet(`showfile exporté (${b.passphrase ? 'chiffré' : 'en clair'}, ${doc.snapshots.length} sauvegarde(s), ${doc.knownNodes.length} node(s))`);
      return send(res, 200, out);
    }
    if (p === '/api/showfile/import' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      let doc = b.file;
      if (!doc || typeof doc !== 'object') return send(res, 400, { error: 'fichier illisible' });
      if (doc.format === 'wledfleet-showfile-encrypted') {
        if (!b.passphrase) return send(res, 400, { error: 'ce showfile est chiffré : phrase secrète requise' });
        try {
          const crypto = require('crypto');
          const key = crypto.scryptSync(String(b.passphrase), Buffer.from(doc.salt, 'base64'), 32);
          const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
          d.setAuthTag(Buffer.from(doc.tag, 'base64'));
          doc = JSON.parse(Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]).toString('utf8'));
        } catch { return send(res, 400, { error: 'phrase secrète incorrecte ou fichier altéré' }); }
      }
      if (doc.format !== 'wledfleet-showfile') return send(res, 400, { error: 'ce n\'est pas un showfile WLED Fleet' });
      const what = { settings: true, antennas: true, nodes: true, snapshots: true, firmware: true, ...(b.what || {}) };
      const done = [];
      if (what.antennas && doc.antennas) { ap.importStore(doc.antennas); startApPolling(); done.push(`${Object.keys(doc.antennas.aps || {}).length} antenne(s)`); }
      if (what.nodes && Array.isArray(doc.knownNodes)) {
        if (Array.isArray(doc.groups)) declaredGroups = [...new Set([...declaredGroups, ...doc.groups.filter(g => typeof g === 'string' && g)])];
        if (Array.isArray(doc.ledProfiles)) { for (const x of doc.ledProfiles) { try { upsertProfile(x); } catch { /* skip */ } } }
        for (const e of doc.knownNodes) { const ip = typeof e === 'string' ? e : e.ip; if (!ip) continue; const r = addNode(ip); if (e.info && !r.info) { r.info = e.info; r.state = e.state || null; r.cfg = e.cfg || null; r.meta.lastSeen = e.lastSeen || null; r.meta.fails = 2; } if (typeof e.group === 'string' && e.group) r.meta.group = e.group; if (Array.isArray(e.ignoredOutputs)) r.meta.ignoredOutputs = e.ignoredOutputs; derive(r); }
        saveKnown(); pollAll(); done.push(`${doc.knownNodes.length} node(s)`);
      }
      if (what.snapshots && Array.isArray(doc.snapshots)) { let n = 0; for (const s of doc.snapshots) { try { snapshots.importFile(Buffer.from(JSON.stringify(s)), (s.name || s.id || 'snapshot') + '.json'); n++; } catch { /* skip bad one */ } } done.push(`${n} sauvegarde(s)`); }
      if (what.firmware && doc.firmwareIndex) { try { fs.mkdirSync(path.join(__dirname, 'firmware'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'firmware', 'index.json'), JSON.stringify(doc.firmwareIndex, null, 2)); done.push('catalogue firmware'); } catch { /* ignore */ } }
      let restart = false;
      if (what.settings && doc.settings) { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(doc.settings, null, 2) + '\n'); done.push('réglages'); restart = !!process.env.WLED_FLEET_LAUNCHER; } catch { /* ignore */ } }
      recordChangeFleet(`showfile importé : ${done.join(', ')}`);
      send(res, 200, { ok: true, done, layout: doc.layout || null, restarting: restart, exportedAt: doc.exportedAt, app: doc.app });
      if (restart) setTimeout(() => process.exit(RESTART_EXIT_CODE), 800);
      return;
    }
    if ((m = /^\/api\/node\/([^/]+)\/align-outputs$/.exec(p)) && req.method === 'POST') {
      // "one universe per output": move the START of every output to the next universe boundary
      // (170 RGB / 128 RGBW) and keep its real LED count. The pixel indexes left in the gap belong
      // to no output: WLED drives nothing there, power estimates stay right. The whole hw.led.ins
      // array is re-sent (WLED rebuilds it from the payload) with only start changed.
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec || !rec.cfg || !rec.derived.dmx || !rec.derived.dmx.multi) return send(res, 400, { error: 'node sans config lue ou pas en mode Multi' });
      const plan = rec.derived.dmx; const per = plan.pxPerUni;
      if (plan.addr !== 1) return send(res, 400, { error: `adresse DMX de départ ${plan.addr} : doit être 1 pour aligner un univers par sortie` });
      const ins = rec.cfg.hw.led.ins.map(b => ({ ...b }));
      let start = 0; const changes = [];
      for (const b of ins) { if (!b.len) continue; const slots = Math.ceil(b.len / per); const uniFrom = plan.uni + start / per; changes.push(`pin ${(b.pin || []).join('/')} : ${b.len} px, départ ${b.start} → ${start} (univers ${uniFrom}${slots > 1 ? '-' + (uniFrom + slots - 1) : ''})`); b.start = start; start += slots * per; }
      try {
        await postJson(ip, '/json/cfg', { hw: { led: { ins } } }, 8000);
        recordChange(rec, 'outputs', rec.derived.outputs, changes.join(' | '), 'grille');
        rec.meta.cfgUpdated = 0; await pollInfoState(rec, 'grille');
        return send(res, 200, { ok: true, changes, total: start });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/led-profiles' && req.method === 'GET') return send(res, 200, { profiles: ledProfiles });
    if (p === '/api/led-profiles' && req.method === 'POST') { const b = await readBody(req); try { return send(res, 200, { ok: true, profile: upsertProfile(b), profiles: ledProfiles }); } catch (e) { return send(res, 400, { error: e.message }); } }
    if ((m = /^\/api\/led-profiles\/([^/]+)$/.exec(p)) && req.method === 'DELETE') { const name = decodeURIComponent(m[1]); ledProfiles = ledProfiles.filter(x => x.name !== name); saveProfiles(); return send(res, 200, { ok: true, profiles: ledProfiles }); }
    if (p === '/api/groups' && req.method === 'POST') { // declare a group (may stay empty), or rename one
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40); if (!name) return send(res, 400, { error: 'nom vide' });
      const from = String(b.rename || '').trim();
      let n = 0; const skipped = [];
      if (from && from !== name) {
        for (const r of fleet.values()) if ((r.meta.group || '') === from) { try { await writeGroup(r, name, 'grille'); n++; } catch { skipped.push((r.info && r.info.name) || r.meta.ip); } }
        declaredGroups = declaredGroups.map(g => g === from ? name : g);
        recordChangeFleet(`groupe « ${from} » renommé « ${name} » (${n} node(s)${skipped.length ? `, ${skipped.length} hors ligne non modifié(s)` : ''})`);
      }
      if (!declaredGroups.includes(name)) declaredGroups.push(name);
      saveKnown(); return send(res, 200, { ok: true, groups: allGroups(), renamed: n, skipped });
    }
    if ((m = /^\/api\/groups\/([^/]+)$/.exec(p)) && req.method === 'DELETE') { // forget a group: its nodes become ungrouped
      const name = decodeURIComponent(m[1]); let n = 0; const skipped = [];
      for (const r of fleet.values()) if ((r.meta.group || '') === name) { try { await writeGroup(r, '', 'grille'); n++; } catch { skipped.push((r.info && r.info.name) || r.meta.ip); } }
      if (skipped.length) return send(res, 409, { error: `${skipped.length} node(s) hors ligne gardent le groupe (${skipped.join(', ')}) : le groupe est écrit sur le node`, ungrouped: n });
      declaredGroups = declaredGroups.filter(g => g !== name);
      recordChangeFleet(`groupe « ${name} » supprimé (${n} node(s) sans groupe)`);
      saveKnown(); return send(res, 200, { ok: true, groups: allGroups(), ungrouped: n });
    }
    if ((m = /^\/api\/node\/([^/]+)\/group$/.exec(p)) && req.method === 'POST') {
      // Group = the node's MQTT group topic (native WLED field). Written on the node, mirrored in meta.group.
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      const b = await readBody(req);
      const next = String(b.group == null ? '' : b.group).trim().slice(0, 32);
      let r; try { r = await writeGroup(rec, next, 'grille'); } catch (e) { return send(res, rec.meta.online ? 502 : 409, { error: e.message }); }
      if (next && !declaredGroups.includes(next)) declaredGroups.push(next);
      saveKnown();
      return send(res, 200, { ok: true, group: next, queued: !!(r && r.queued) });
    }
    if ((m = /^\/api\/node\/([^/]+)\/output-profile$/.exec(p)) && req.method === 'POST') {
      // remember which LED profile is plugged on output `index` (0-based) : written on the node (MQTT client id suffix)
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      const b = await readBody(req); const idx = Number(b.index); if (!Number.isInteger(idx) || idx < 0 || idx > 15) return send(res, 400, { error: 'index de sortie invalide' });
      const ids = (rec.meta.outputProfiles || []).slice(); while (ids.length <= idx) ids.push(null); ids[idx] = b.id ? String(b.id) : null;
      let r; try { r = await writeProfiles(rec, ids, 'grille'); } catch (e) { return send(res, rec.meta.online ? 502 : 409, { error: e.message }); }
      derive(rec); saveKnown();
      return send(res, 200, { ok: true, profiles: rec.meta.outputProfiles, queued: r === 'queued' });
    }
    if ((m = /^\/api\/node\/([^/]+)\/outputs-ignore$/.exec(p)) && req.method === 'POST') {
      // Fleet-only flag: outputs (by start index) that exist in WLED but are not physically used;
      // their universes are greyed and excluded from conflict detection. Nothing is written to the node.
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      const b = await readBody(req);
      const starts = (Array.isArray(b.starts) ? b.starts : []).map(Number).filter(Number.isFinite);
      let r; try { r = await writeIgnored(rec, starts, 'grille'); } catch (e) { return send(res, rec.meta.online ? 502 : 409, { error: e.message }); }
      derive(rec); saveKnown();
      return send(res, 200, { ok: true, ignored: rec.meta.ignoredOutputs, queued: r === 'queued' });
    }
    if ((m = /^\/api\/node\/([^/]+)\/offline-queue\/apply$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      try { return send(res, 200, { ok: true, ...(await applyOfflineQueue(rec)) }); }
      catch (e) { return send(res, rec.meta.online ? 502 : 409, { error: e.message }); }
    }
    if ((m = /^\/api\/node\/([^/]+)\/offline-queue\/discard$/.exec(p)) && req.method === 'POST') {
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      discardOfflineQueue(rec);
      return send(res, 200, { ok: true, group: rec.meta.group, ignored: rec.meta.ignoredOutputs, profiles: rec.meta.outputProfiles });
    }
    if (p === '/api/dmx-plan' && req.method === 'GET') {
      // fleet-wide plan + universe conflicts between nodes
      const nodes = [...fleet.values()].filter(r => r.derived && r.derived.dmx).map(r => ({ ip: r.meta.ip, name: r.info && r.info.name, group: r.meta.group || '', online: r.meta.online, live: r.info && r.info.live, lm: r.info && r.info.lm, lip: r.info && r.info.lip, plan: r.derived.dmx }));
      // conflicts only among universes that carry at least one counted (non-ignored) output
      const byUni = new Map();
      for (const n of nodes) for (const u of (n.plan.universes || [])) { if (u.ignored) continue; if (!byUni.has(u.u)) byUni.set(u.u, []); byUni.get(u.u).push(n.name || n.ip); }
      const conflicts = [...byUni.entries()].filter(([, l]) => l.length > 1).map(([u, l]) => ({ universe: u, nodes: l }));
      return send(res, 200, { nodes: nodes.sort((a, b) => (a.plan.uni || 0) - (b.plan.uni || 0)), conflicts, universesInUse: [...byUni.keys()].sort((a, b) => a - b) });
    }
    if (p === '/api/nodes/purge' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, { removed: purgeOffline(Number(b.olderThanH) || 0) });
    }
    if (p === '/api/snapshots' && req.method === 'GET') return send(res, 200, { snapshots: snapshots.list() });
    if (p === '/api/snapshots' && req.method === 'POST') {
      const { name } = await readBody(req);
      const r = await snapshots.capture(name, [...fleet.values()], getJson);
      recordChangeFleet(`sauvegarde « ${r.name} » : ${r.nodes} node(s)`);
      return send(res, 200, r);
    }
    if (p === '/api/snapshots/import' && req.method === 'POST') {
      const name = String(req.headers['x-filename'] || 'import.json');
      try { return send(res, 200, snapshots.importFile(await readRaw(req), name)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if ((m = /^\/api\/snapshots\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        let snap; try { snap = snapshots.load(id); } catch (e) { return send(res, 404, { error: e.message }); }
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', `attachment; filename="wled-fleet_${id}.json"`);
        return send(res, 200, snap);
      }
      if (req.method === 'DELETE') { snapshots.remove(id); return send(res, 200, { ok: true }); }
    }
    if ((m = /^\/api\/snapshots\/([^/]+)\/diff$/.exec(p)) && req.method === 'GET') {
      try { return send(res, 200, { nodes: snapshots.diff(snapshots.load(decodeURIComponent(m[1])), [...fleet.values()], columns) }); }
      catch (e) { return send(res, 404, { error: e.message }); }
    }
    if ((m = /^\/api\/snapshots\/([^/]+)\/restore$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const { targets, what, reboot } = await readBody(req);
      let snap; try { snap = snapshots.load(decodeURIComponent(m[1])); } catch (e) { return send(res, 404, { error: e.message }); }
      const results = await snapshots.restore(snap, targets || [], what || { cfg: true, presets: true }, reboot !== false, [...fleet.values()], postJson,
        r => { const rec = fleet.get(r.ip); if (rec) recordChange(rec, 'restore', null, r.ok ? r.done.join('+') : r.error, 'restauration'); });
      for (const r of results) { const rec = fleet.get(r.ip); if (rec) { rec.meta.cfgUpdated = 0; rec.meta.restoreUntil = Date.now() + 90000; } }
      setTimeout(pollAll, 4000);
      return send(res, 200, { results });
    }
    // ── access point ──
    if (p === '/api/ap' && req.method === 'GET') {
      const v = ap.view([...fleet.values()].map(r => r.info && r.info.mac).filter(Boolean));
      // fleet-level findings that need both sides (antenna + node config)
      v.audit = [...(v.audit || [])];
      for (const c of v.clients || []) {
        const rec = [...fleet.values()].find(r => r.info && r.info.mac && r.info.mac.toLowerCase() === c.mac);
        if (!rec) continue;
        if (/Ethernet/i.test(rec.info.release || '') && rec.cfg && rec.cfg.eth && Number(rec.cfg.eth.type) === 0) v.audit.push({ level: 'warn', title: `${rec.info.name} : firmware Ethernet mais associé en Wi‑Fi`, detail: `Le node tourne une build ESP32_Ethernet mais son type de carte Ethernet est « None » (cfg.eth.type = 0) : il passe par le Wi‑Fi (${c.signal} dBm). S'il a un port RJ45 câblé au GigaCore, configurer le bon type de carte dans WLED (Config > LED & Hardware > Ethernet) le sortira de l'air.`, fix: 'WLED : Ethernet type = celui de la carte (ex. QuinLED-ESP32, ESP32-POE…), puis redémarrage' });
        if (rec.info.wifi && rec.info.wifi.rssi != null && c.signal != null && Math.abs(rec.info.wifi.rssi - c.signal) >= 12) v.audit.push({ level: 'info', title: `${rec.info.name} : signal asymétrique`, detail: `Le node reçoit l'antenne à ${rec.info.wifi.rssi} dBm mais l'antenne ne le reçoit qu'à ${c.signal} dBm (écart ${Math.abs(rec.info.wifi.rssi - c.signal)} dB). Le node émet moins fort que l'antenne : c'est le sens node → antenne (acquittements) qui limite.`, fix: '' });
      }
      // what the WiFiman Wizard hears where it sits (live mode): findings from its side of the picture
      v.audit.push(...wizard.audit(nodeRssi));
      return send(res, 200, v);
    }
    // ── WiFiman Wizard: mobile RF probe over BLE (wizard.js + tools/wizard/wizard_bridge.py) ──
    if (p === '/api/wizard' && req.method === 'GET') return send(res, 200, wizard.view(ap.lastScan()));
    if (p === '/api/wizard/devices' && req.method === 'GET') {
      try { return send(res, 200, { devices: await wizard.devices(Math.min(20, Math.max(2, Number(url.searchParams.get('timeout')) || 6))) }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/wizard/connect' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await wizard.start({ address: b.address, mock: !!b.mock, raw: !!b.raw })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/wizard/disconnect' && req.method === 'POST') return send(res, 200, { stopped: wizard.stop() });
    if (p === '/api/wizard/toggle' && req.method === 'POST') { // the one WiFiman button
      try { return send(res, 200, await wizard.toggle()); } catch (e) { return send(res, 400, { error: e.message, ...wizard.status() }); }
    }
    if (p === '/api/wizard/install' && req.method === 'POST') { // pip install bleak (and Python via winget if missing)
      try { return send(res, 200, await wizard.install()); } catch (e) { return send(res, 400, { error: e.message, ...wizard.status().deps }); }
    }
    if (p === '/api/wizard/deps' && req.method === 'GET') return send(res, 200, await wizard.deps(url.searchParams.get('force') === '1'));
    if (p === '/api/wizard/survey' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, wizard.survey(b.label, { nearNode: b.nearNode })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/wizard/survey' && req.method === 'DELETE') { const b = await readBody(req); return send(res, 200, { left: wizard.removeSurvey(b.at) }); }
    if (p === '/api/wizard/surveys' && req.method === 'GET') return send(res, 200, { surveys: wizard.surveys(Number(url.searchParams.get('n')) || 100) });
    if (p === '/api/wizard/live' && req.method === 'GET') return send(res, 200, { live: wizard.liveHistory(Number(url.searchParams.get('n')) || 720) });
    if (p === '/api/wizard/waterfall' && req.method === 'GET') return send(res, 200, wizard.waterfall(Math.min(720, Number(url.searchParams.get('n')) || 360)));
    if (p === '/api/wizard/near' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, { nearNode: wizard.setNear(b.mac) }); }
    if (p === '/api/wizard/config' && req.method === 'POST') {
      const b = await readBody(req); const patch = {};
      if (b.enabled !== undefined) patch.enabled = !!b.enabled;
      if (b.autoconnect !== undefined) patch.autoconnect = !!b.autoconnect;
      if (b.python !== undefined) patch.python = String(b.python || '').trim() || null;
      if (b.address !== undefined) patch.address = String(b.address || '').trim() || null;
      const c = wizard.saveConfig(patch); if (b.python !== undefined) await wizard.resolvePython(true);
      if (b.enabled === false) wizard.stop();   // switching the probe off also stops a running bridge
      else if (b.enabled === true && c.autoconnect && c.address && !wizard.status().running) wizard.start({ address: c.address }).catch(e => console.log(`wizard: ${e.message}`));
      return send(res, 200, { config: c, ...wizard.status() });
    }
    if (p === '/api/ap/scan' && req.method === 'POST') {
      // disruptive on purpose (radio leaves its channel for a few seconds); only on explicit user click
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try { return send(res, 200, await ap.scan(b.iface || 'wifi1', Math.min(15, Math.max(2, Number(b.duration) || 5)))); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/ap/scans' && req.method === 'GET') return send(res, 200, { scans: ap.scanHistory() });
    // ── show preset for the antenna: current values vs recommended, apply the ticked ones ──
    const SHOW_PRESET = [
      { key: 'security.ft', want: 'false', why: '802.11r (fast transition) : inutile aux ESP32, certains firmwares décrochent quand l\'AP l\'annonce' },
      { key: 'security.ft-over-ds', want: 'false', why: 'complément du 802.11r' },
      { key: 'security.authentication-types', optional: true, want: 'wpa2-psk', why: 'WPA2 seul : ce que les ESP32 gèrent le mieux ; le mode mixte WPA2+WPA3 fait parfois échouer l\'association' },
      { key: 'security.management-protection', optional: true, want: 'disabled', why: '802.11w (PMF) : des ESP refusent l\'association si exigé' },
      { key: 'configuration.dtim-period', optional: true, want: '1', why: 'DTIM 1 : les clients ne dorment jamais entre deux balises, moins de trames perdues (à coupler avec veille Wi‑Fi = non sur les nodes)' },
      { key: 'channel.frequency', want: '2412,2437,2462', why: 'sélection automatique uniquement parmi les canaux 1 / 6 / 11 (non chevauchants) au lieu de la plage d\'usine 2446-2468' },
      { key: 'channel.width', want: '20mhz', why: '20 MHz : l\'ESP32 ne fait pas mieux, le 40 MHz double l\'exposition aux voisins' },
      { key: 'configuration.multicast-enhance', want: 'enabled', why: 'multicast converti en unicast acquitté (mDNS, E1.31 multicast, découverte WLED)' },
    ];
    if (p === '/api/ap/preset' && req.method === 'GET') {
      const iface = url.searchParams.get('iface') || 'wifi1';
      try {
        const cur = await ap.radioSettings(iface);
        const norm = v => v == null ? null : String(v).toLowerCase().replace(/\s+/g, '');
        const items = SHOW_PRESET.map(s => { const c = cur[s.key]; const ok = c == null ? (s.key === 'security.ft' || s.key === 'security.ft-over-ds' ? false : s.key === 'security.management-protection' || s.key === 'configuration.dtim-period' ? null : norm(c) === norm(s.want)) : norm(c) === norm(s.want); return { ...s, current: c, ok }; });
        return send(res, 200, { iface, items });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/ap/preset' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      const patch = {}; for (const k of (b.keys || [])) { const s = SHOW_PRESET.find(x => x.key === k); if (s) patch[k] = s.want; }
      try {
        const r = await ap.applyRadio(b.iface || 'wifi1', patch);
        recordChangeFleet(`antenne ${r.iface} préréglage show : ${Object.entries(r.after).map(([k, v]) => `${k} ${r.before[k] ?? 'défaut'} → ${v}`).join(' ; ')}`);
        setTimeout(async () => { await ap.poll(); fleet.forEach(derive); }, 8000);
        return send(res, 200, r);
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/ap/channel' && req.method === 'POST') {
      // FIRST and only write to the router: channel plan of one radio, on explicit user confirmation
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try {
        const r = await ap.setChannel(b.iface || 'wifi1', String(b.spec || ''));
        recordChangeFleet(`antenne ${r.iface} : channel.frequency ${r.before} → ${r.after}`);
        setTimeout(async () => { await ap.poll(); fleet.forEach(derive); }, 6000);
        return send(res, 200, r);
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // ── pairing of new nodes through the PC's Wi-Fi card ──
    if (p === '/api/pair/networks' && req.method === 'GET') {
      try {
        const fresh = await provision.wlanNetworks(url.searchParams.get('deep') === '1', url.searchParams.get('refresh') !== '0'); const st = await provision.wlanState();
        // a WLED-AP beacons slowly and a 4 s scan can miss it: remember every network seen by the
        // PC's card for 3 min (like the antenna's memory), mark the ones missing from this pass
        const nowMs = Date.now();
        for (const n of fresh) recentPcNets.set(n.bssid || n.ssid, { ...n, seenAt: nowMs });
        for (const [k, v] of recentPcNets) if (nowMs - v.seenAt > 3 * 60000) recentPcNets.delete(k);
        const nets = [...recentPcNets.values()].map(n => ({ ...n, stale: nowMs - n.seenAt > 1000, seenAgo: Math.round((nowMs - n.seenAt) / 1000) }));
        try { st.ipConfig = await provision.wlanIpConfig(); } catch { /* optional */ }
        // the antenna's last scan sees more than the PC's card (and refreshes on demand): merge it in
        const seen = new Set(nets.map(n => n.ssid));
        const apv = ap.view([]);
        for (const n of (apv.recentNetworks || [])) { // every network any antenna scan saw in the last 15 min
          if (seen.has(n.ssid)) continue;
          const open = !n.security || /none|open/i.test(n.security);
          nets.push({ ssid: n.ssid, auth: n.security || 'ouvert', open, signal: n.signal != null ? Math.max(0, Math.min(100, Math.round((n.signal + 90) * 2))) : null, bssid: n.bssid, channel: n.channel, candidate: open || /wled|pixy|liana|tournette/i.test(n.ssid), via: 'antenne', seenAt: n.seenAt });
          seen.add(n.ssid);
        }
        const apScan = apv.lastScan;
        // who looks like a WLED: name (WLED-AP, PIXY, Liana, Tournette, ESP…), open network,
        // or same chip maker as the fleet's own nodes (the AP's BSSID shares the node's OUI;
        // an ESP32 softAP MAC is the station MAC + 1)
        const fleetOuis = new Set([...fleet.values()].map(r => r.info && r.info.mac).filter(Boolean).map(m => m.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6)));
        const knownMacs = new Set([...fleet.values()].map(r => r.info && r.info.mac).filter(Boolean).map(m => m.toLowerCase().replace(/[^0-9a-f]/g, '')));
        // remember the result of a finished verification (test job reads /json/info through the AP)
        const job = provision.status();
        if (job && job.mode === 'test' && job.status === 'done' && job.result && job.result.info) verifiedAps.set(job.ssid, { info: job.result.info, at: job.startedAt });
        for (const n of nets) {
          const mac = String(n.bssid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
          n.oui = mac.slice(0, 6);
          n.espressif = ESPRESSIF_OUIS.has(n.oui);
          n.sameMaker = fleetOuis.has(n.oui);
          n.nameHint = /wled|pixy|liana|tournette|esp/i.test(n.ssid || '');
          const v = verifiedAps.get(n.ssid);
          n.verified = v ? { name: v.info.name, ver: v.info.ver, mac: v.info.mac, brand: v.info.brand, at: v.at } : null;
          // AP BSSID = station MAC + 1 on ESP32: is this the AP of a node we already know?
          if (mac.length === 12) { const sta = (BigInt('0x' + mac) - 1n).toString(16).padStart(12, '0'); n.knownNode = knownMacs.has(sta) ? [...fleet.values()].find(r => r.info && r.info.mac && r.info.mac.toLowerCase().replace(/[^0-9a-f]/g, '') === sta).info.name : null; }
          // identification levels: wled (proven) > espressif (probable) > autre (excluded: not an Espressif chip)
          n.ident = n.verified ? 'wled' : (n.espressif || n.knownNode) ? 'espressif' : (mac.length === 12 ? 'autre' : 'inconnu');
          n.candidate = n.ident !== 'autre';
        }
        nets.sort((a, b) => (b.candidate - a.candidate) || ((b.signal || 0) - (a.signal || 0)));
        // one proposed IP per candidate, all distinct, following the fleet's own numbering; a default key for everyone
        const taken = new Set();
        for (const n of nets) { n.key = n.open ? '' : 'wled1234'; if (!n.candidate) continue; const s = await suggestFor(n.ssid, taken); n.suggestedIp = s.ip; if (s.ip) taken.add(s.ip); }
        // the show network as the antenna serves it (password stays server-side)
        let show = null; try { const w = await ap.showWifi(); if (w) show = { ssid: w.ssid, hasPsk: !!w.psk, iface: w.iface, stale: !!w.stale }; } catch { /* antenna not configured */ }
        return send(res, 200, { networks: nets, pc: st, apScanAt: apScan ? apScan.at : null, show, apConfigured: !!ap.config() });
      } catch (e) { return send(res, 500, { error: `carte Wi‑Fi du PC : ${e.message}` }); }
    }
    if (p === '/api/pair/suggest' && req.method === 'GET') {
      return send(res, 200, await suggestFor(String(url.searchParams.get('ssid') || ''), new Set()));
    }
    if (p === '/api/pair/status' && req.method === 'GET') return send(res, 200, { job: provision.status() });
    if ((p === '/api/pair' || p === '/api/pair/test') && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try {
        // the show network comes from the antenna (SSID + passphrase), the caller only chooses the IP;
        // an explicit target {ssid, psk} is accepted as fallback when no antenna is configured
        let target = null;
        if (p === '/api/pair') {
          const w = await ap.showWifi().catch(() => null);
          if (w && w.ssid) target = { ssid: w.ssid, psk: w.psk || '', ip: b.ip || (b.target && b.target.ip) || '' };
          else if (b.target && b.target.ssid) target = { ssid: b.target.ssid, psk: b.target.psk || '', ip: b.target.ip || b.ip || '' };
          else return send(res, 400, { error: 'réseau du show inconnu : antenne non configurée' });
          // name only when typed by the user (the job skips it if identical to the node's own);
          // unify = align mDNS + AP SSID on the name, explicit checkbox
          if (b.name && String(b.name).trim()) target.name = String(b.name).trim();
          target.unify = !!b.unify;
        }
        const j = await provision.start({ ssid: b.ssid, key: b.key, target }, p === '/api/pair/test' ? 'test' : 'pair');
        if (target && target.ip) setTimeout(() => { addNode(target.ip); saveKnown(); pollAll(); }, 45000); // the node should be on the LAN by then
        return send(res, 202, { job: j });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/ap/raw' && req.method === 'GET') {
      // read-only passthrough to RouterOS (GET only, wifi/system/interface trees) for audits
      const rp = String(url.searchParams.get('path') || '');
      if (!/^\/(interface|system|ip\/(address|dhcp-server|neighbor)|routing)(\/|$)/.test(rp) || /\/(set|add|remove|enable|disable|scan|reset|reboot|upgrade)(\/|$)/.test(rp)) return send(res, 400, { error: 'chemin non autorisé (lecture seule)' });
      try { return send(res, 200, await ap.rest('GET', rp)); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/ap/config' && req.method === 'POST') {
      // credentials typed by the user in the Antenne panel -> ap.json, then poll right away
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      try { ap.saveConfig(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
      startApPolling();
      const st = await ap.poll(); fleet.forEach(derive);
      return send(res, st.ok ? 200 : 502, { ok: st.ok, error: st.error, host: ap.config().host });
    }
    if (p === '/api/ap/connect' && req.method === 'POST') {
      // switch to an AP whose credentials are already saved (no password retyped)
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try { ap.connect(b.host); } catch (e) { return send(res, 400, { error: e.message }); }
      startApPolling();
      const st = await ap.poll(); fleet.forEach(derive);
      return send(res, st.ok ? 200 : 502, { ok: st.ok, error: st.error, host: ap.config().host });
    }
    if (p === '/api/ap/forget' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      ap.forget(b.host); startApPolling(); fleet.forEach(derive);
      return send(res, 200, { ok: true });
    }
    // ── firmware repository ──
    if (p === '/api/firmware' && req.method === 'GET') {
      const all = url.searchParams.get('all') === '1';
      const v = firmware.view(all ? null : envsInUse());
      v.envsInUse = [...envsInUse()];
      v.readonly = READONLY;
      v.otaParallel = otaParallel;
      v.nodes = [...fleet.values()].map(r => ({ ip: r.meta.ip, name: r.info && r.info.name, online: r.meta.online, fw: r.derived.fw, otaLock: !!(r.cfg && r.cfg.ota && r.cfg.ota.lock), ota: r.meta.ota }));
      return send(res, 200, v);
    }
    if (p === '/api/firmware/refresh' && req.method === 'POST') {
      try { await firmware.refresh(); } catch (e) { return send(res, 502, { error: `GitHub injoignable : ${e.message}` }); }
      fleet.forEach(derive);
      return send(res, 200, { ok: true, refreshedAt: firmware.catalogue().refreshedAt, releases: firmware.catalogue().releases.length });
    }
    if (p === '/api/firmware/download' && req.method === 'POST') {
      const { tag, asset, forFleet } = await readBody(req);
      const started = [];
      if (forFleet) {
        // every asset of that release matching a platform present in the fleet
        const rel = firmware.catalogue().releases.find(r => r.tag === tag);
        if (!rel) return send(res, 404, { error: 'release inconnue' });
        for (const a of rel.assets) if (envsInUse().has(a.env) && !firmware.isLocal(tag, a.name)) { await firmware.download(tag, a.name); started.push(a.name); }
      } else {
        await firmware.download(tag, asset); started.push(asset);
      }
      return send(res, 202, { started });
    }
    if (p === '/api/firmware/delete' && req.method === 'POST') {
      const { tag, asset } = await readBody(req);
      firmware.remove(tag, asset); fleet.forEach(derive);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/firmware/upload' && req.method === 'POST') {
      const name = path.basename(String(req.headers['x-filename'] || ''));
      const buf = await readRaw(req);
      try { firmware.addLocal(name, buf); } catch (e) { return send(res, 400, { error: e.message }); }
      fleet.forEach(derive);
      return send(res, 200, { ok: true, name, size: buf.length });
    }
    if ((m = /^\/api\/node\/([^/]+)\/update$/.exec(p)) && req.method === 'POST') {
      const { tag, asset, parallel } = await readBody(req);
      try { return send(res, 202, enqueueOta(decodeURIComponent(m[1]), tag, asset, parallel)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/changes') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, { now: Date.now(), events: changes.filter(e => e.at > since).slice(-500) });
    }
    if (p === '/api/scan' && req.method === 'POST') { scan(); return send(res, 202, { started: true }); }
    if (p === '/api/nodes' && req.method === 'POST') {
      const { ip } = await readBody(req);
      if (!ip) return send(res, 400, { error: 'ip manquante' });
      if (!(await probe(ip))) return send(res, 404, { error: `${ip} ne répond pas comme un node WLED` });
      addNode(ip); saveKnown(); pollAll();
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/nodes\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      fleet.delete(decodeURIComponent(m[1])); saveKnown();
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/node\/([^/]+)\/cfg$/.exec(p))) {
      const ip = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        const r = await getJson(ip, '/json/cfg', 5000);
        const name = ((fleet.get(ip) || {}).info || {}).name || ip;
        res.setHeader('Content-Disposition', `attachment; filename="wled-cfg-${name.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json"`);
        return send(res, 200, r.json);
      }
      if (req.method === 'POST') {
        if (READONLY) return send(res, 403, { error: 'lecture seule' });
        const body = await readBody(req);
        const r = await postJson(ip, '/json/cfg', body, 8000);
        const rec = fleet.get(ip); if (rec) await pollCfg(rec, 'grille');
        return send(res, 200, { ok: true, reply: r.json });
      }
    }
    if ((m = /^\/api\/node\/([^/]+)\/cell$/.exec(p)) && req.method === 'POST') {
      const { col, value } = await readBody(req);
      return send(res, 200, await writeCell(decodeURIComponent(m[1]), col, value));
    }
    if ((m = /^\/api\/node\/([^/]+)\/reboot$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      await postJson(decodeURIComponent(m[1]), '/json/state', { rb: true }, 5000);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'route inconnue' });

    // static
    const file = path.join(STATIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(STATIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
const [lh, lp] = LISTEN.split(':');
server.listen(Number(lp), lh, () => {
  console.log(`wled-fleet ${READONLY ? '(lecture seule) ' : ''}- http://${LISTEN}/`);
  // --ip = explicit fixed list: no scan and no known-nodes.json (so a mock/dev
  // run never mixes with the real fleet remembered from a previous run).
  if (FIXED_IPS.length) FIXED_IPS.forEach(addNode);
  if (!FIXED_IPS.length) loadKnown();
  loadChanges();
  firmware.loadIndex();
  console.log(`dépôt firmware: ${firmware.catalogue().releases.length} release(s) connue(s)${firmware.catalogue().refreshedAt ? ', catalogue du ' + new Date(firmware.catalogue().refreshedAt).toLocaleString() : ' (jamais rafraîchi)'}`);
  if (fleet.size) console.log(`nodes connus: ${[...fleet.keys()].join(', ')}`);
  pollAll();
  if (!FIXED_IPS.length) scan();
  setInterval(pollAll, INTERVAL);
  // antenna: MNDP discovery always on (no credentials), REST polling when configured
  ap.startDiscovery((SUBNETS || localSubnets()).map(s => s + '.255'));
  watchNetwork(); setInterval(watchNetwork, 5000);
  if (flag('ap-config', '')) ap.setConfigFile(String(flag('ap-config', ''))); else if (FIXED_IPS.length) ap.setConfigFile('ap-dev.json');
  const apCfg = ap.loadConfig({ host: flag('ap', ''), user: flag('ap-user', ''), pass: flag('ap-pass', undefined) === true ? '' : flag('ap-pass', undefined) });
  if (apCfg) startApPolling();
  else console.log('antenne: non configurée (formulaire dans le panneau Antenne, ap.json, ou --ap <ip> --ap-user --ap-pass)');
  // WiFiman Wizard: bridge in mock mode on --wizard-mock, else auto-connect if wizard.json says so
  if (FIXED_IPS.length) wizard.setConfigFile('wizard-dev.json');
  const wz = wizard.loadConfig();
  wizard.deps().then(d => console.log(`wizard: ${d.ok ? `Python ${d.pythonVersion} + bleak ${d.bleak}` : (d.pythonError || d.bleakError) + ' (bouton « Installer les prérequis » dans Antenne, ou tools\\install-shortcuts.ps1)'}`)).catch(() => {});
  if (flag('wizard-mock', false) === true) wizard.start({ mock: true }).catch(e => console.log(`wizard (mock): ${e.message}`));
  else if (!wz.enabled) console.log('wizard: sonde désactivée (bouton WiFiman dans Antenne)');
  else if (wz.autoconnect && wz.address) wizard.start({ address: wz.address }).catch(e => console.log(`wizard: ${e.message}`));
  else console.log(`wizard: ${wz.address ? `connu (${wz.address}), connexion depuis le panneau Antenne` : 'aucun appareil enregistré (panneau Antenne > Wizard > Rechercher)'}`);
});
process.on('exit', () => wizard.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
