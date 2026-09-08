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
const dmx = require('./dmx');
const metadata = require('./metadata');
const library = require('./library');
const github = require('./github');
const drivers = require('./drivers');
const psus_ = require('./psus');
const power = require('./power');
const firmware = require('./firmware');
const ap = require('./ap');
const snapshots = require('./snapshots');
const provision = require('./provision');
const wizard = require('./wizard');
const { dataFile, codeFile, DATA_DIR, CODE_DIR } = require('./paths');

// ── Settings: settings.json (standalone app) overridden by CLI flags ─────────
// settings.json = { "subnet": "192.168.88", "listen": "127.0.0.1:8792", "interval": 3000,
//                   "cfgInterval": 20000, "readonly": false, "otaParallel": 1 }
// (keys are the camelCase form of the CLI flags; "listen": "0.0.0.0:8792" opens the page to the LAN)
const SETTINGS_FILE = dataFile('settings.json');
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
const KNOWN_FILE = dataFile('known-nodes.json');
// The launcher restarts the server silently after a crash: keep the reason on disk.
const ERROR_FILE = dataFile('server-errors.log');
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, err => {
  const line = `${new Date().toISOString()} ${ev}: ${(err && err.stack) || err}\n`;
  try { fs.appendFileSync(ERROR_FILE, line); } catch { /* ignore */ }
  console.error(line);
  if (ev === 'uncaughtException') process.exit(1);
});
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(codeFile('package.json'), 'utf8')).version; } catch { return 'dev'; } })();

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
// Sorties non utilisées : POSITIONS (0-based) dans hw.led.ins, jamais l'index de
// départ. Le marqueur sur le node est déjà positionnel (#u1.3 = sorties 1 et 3) ;
// c'est Fleet qui traduisait en index de départ, et ⚡ Autopatch change justement
// les départs — le drapeau sautait alors sur une autre sortie (corrigé 2026-09-08).
function ignoredFromCfg(rec) {
  const t = deviceTopic(rec); if (t === null) return null;
  const m = /#u([0-9.]*)$/.exec(t); if (!m) return [];
  const ins = (rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
  return m[1].split('.').filter(Boolean).map(Number).filter(i => i >= 1 && ins[i - 1]).map(i => i - 1);
}
// tolère l'ancienne écriture (index de départ) encore présente dans known-nodes.json
// ou dans une intention hors ligne enregistrée avant la mise à jour
function normalizeIgnored(list, ins) {
  return [...new Set((list || []).map(Number).filter(Number.isFinite).map(v => {
    if (v >= 0 && v < ins.length) return v;              // déjà une position
    const i = ins.findIndex(b => b.start === v); return i >= 0 ? i : null; // legacy : index de départ
  }).filter(v => v !== null))].sort((a, b) => a - b);
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
async function writeIgnored(rec, list, source) {
  const t = deviceTopic(rec); if (t === null) throw new Error('config du node non lue');
  const ins = (rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
  const positions = normalizeIgnored(list, ins);
  const idx = positions.map(i => i + 1);
  const base = t.replace(/#u[0-9.]*$/, ''); const next = idx.length ? `${base}#u${idx.join('.')}` : base;
  if (next.length > 32) throw new Error('marqueur trop long pour le champ MQTT du node');
  if (next === t) { unqueueOffline(rec, 'ignoredOutputs'); rec.meta.ignoredOutputs = positions; return false; }
  if (!rec.meta.online) { queueOffline(rec, 'ignoredOutputs', positions); return 'queued'; }
  await postJson(rec.meta.ip, '/json/cfg', { if: { mqtt: { topics: { device: next } } } }, 8000);
  rec.cfg.if.mqtt.topics.device = next; rec.meta.ignoredOutputs = positions;
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
    if (rec.meta.offlineQueue.ignoredOutputs !== undefined) rec.meta.ignoredOutputs = normalizeIgnored(rec.meta.offlineQueue.ignoredOutputs, (cfg && cfg.hw && cfg.hw.led && cfg.hw.led.ins) || []);
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
// Toute l'arithmétique vit dans dmx.js (testée par test/dmx.test.js) ; ici on ne
// fait que lui passer ce que le node a dit de lui.
const DMX_MODES_PX = dmx.MODES_PX;
function dmxPlan(rec) {
  const cfg = rec.cfg; if (!cfg || !cfg.if || !cfg.if.live || !cfg.hw || !cfg.hw.led) return null;
  const x = cfg.if.live.dmx || {};
  // ce que le node dit de lui-même, remis à plat par position
  const byPos = [];
  for (const o of (rec.meta.nodeMeta && rec.meta.nodeMeta.outputs) || []) byPos[o.i] = o;
  const plan = dmx.plan({ mode: x.mode, uni: x.uni, addr: x.addr, ins: cfg.hw.led.ins || [], ignored: rec.meta.ignoredOutputs || [], profiles: rec.meta.outputProfiles || [], meta: byPos });
  // Ce que chaque sortie a de différent de la fiche qu'elle revendique. Calculé
  // ici et non dans l'interface : c'est une information du modèle, un satellite
  // doit y avoir accès aussi. Le node fait foi — l'écart est constaté, jamais
  // corrigé d'autorité.
  const ins = cfg.hw.led.ins || [];
  for (const o of plan.outputs) {
    const prod = library.resolve(libraryStore, o.profile);
    o.deviation = prod ? library.deviations(prod, ins[o.i] || {}) : null;
    o.productLabel = prod ? library.label(prod) : null;
  }
  return plan;
}

// ── Change journal ───────────────────────────────────────────────────────────
// Every poll is diffed against the previous snapshot on the watched columns
// (columns.js: watch !== false). A change is tagged 'grille' when this server
// just wrote that cell, 'externe' otherwise (WLED UI, another tool, a preset…).
// a fixed --ip list (dev / mock runs) journals apart from the real fleet
const CHANGES_FILE = dataFile(FIXED_IPS.length ? 'changes-dev.log' : 'changes.log');
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
        // le node est revenu : s'il a perdu ses métadonnées Fleet en route, on les repose
        if (ok) await restoreNodeMeta(rec, 'maj');
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
  // Les métadonnées Fleet vivent dans un fichier du node (voir metadata.js).
  // On les relit avec la config et on en garde une copie : c'est elle qui
  // permet de les remettre si le node revient nu d'une mise à jour, et
  // d'afficher les fixtures d'un node hors ligne.
  try {
    const m = await metadata.read(rec.meta.ip, 3000);
    rec.meta.nodeMeta = m;
    if (m.outputs.length || m.group) rec.meta.nodeMetaSeen = m; // dernière copie NON VIDE, c'est elle qu'on restaure
    // la bibliothèque embarquée n'est lue que si le node a des marqueurs : un
    // node nu n'a rien à décrire, inutile de lui demander un second fichier
    if (m.outputs.some(o => o.product)) {
      const slice = library.parseNodeSlice(await metadata.readFile(rec.meta.ip, library.NODE_FILE, 3000));
      if (slice) rec.meta.nodeLib = slice;
    }
  } catch { /* le node ne répond pas sur ce point : on garde la copie précédente */ }
  derive(rec);
  if (before) diffSnapshot(rec, before, source);
}

// Après une mise à jour, si le node revient sans ses métadonnées alors qu'on en
// avait une copie, on les repose. Le cas se produit quand le système de fichiers
// a été reformaté — WLED le fait au démarrage si le montage échoue
// (wled.cpp: WLED_FS.begin(true) sur ESP32), typiquement après un changement de
// schéma de partitions. Une mise à jour normale n'écrit que la partition
// applicative et n'y touche pas ; ce filet ne sert donc que dans le mauvais cas,
// mais c'est précisément là qu'on serait content de l'avoir.
// Fusionne ce que la grille envoie dans le /fleet.json du node, sans jamais
// jeter ce qu'on n'a pas édité : les clés d'une version plus récente, la note,
// le groupe. `ins` sert à réenregistrer le GPIO de chaque sortie, qui permettra
// plus tard de repérer un réordonnancement fait en dehors de Fleet.
async function writeNodeMeta(rec, list, ins) {
  const cur = metadata.parse(rec.meta.nodeMeta || metadata.empty());
  const byPos = new Map(cur.outputs.map(o => [o.i, o]));
  for (const u of list) {
    const i = Number(u.i); if (!Number.isInteger(i) || i < 0) continue;
    const prev = byPos.get(i) || { i };
    byPos.set(i, { ...prev, i,
      pin: ((ins[i] || {}).pin || []).join('/') || prev.pin || null,
      // `undefined` = « la grille n'a pas d'avis » ; `null` = « efface »
      ...(u.product === undefined ? {} : { product: u.product }),
      ...(u.prev === undefined ? {} : { prev: u.prev }),
      ...(u.fixture === undefined ? {} : { fixture: u.fixture }),
      ...(u.instance === undefined ? {} : { instance: u.instance }),
    });
  }
  const next = metadata.parse({ ...cur, outputs: [...byPos.values()].sort((a, b) => a.i - b.i) });
  await metadata.write(rec.meta.ip, next, 8000);
  rec.meta.nodeMeta = next;
  if (!metadata.isEmpty(next)) rec.meta.nodeMetaSeen = next;
  await writeNodeLibrary(rec, next);
  derive(rec);
}

// La fiche complète des produits que ce node cite, posée à côté de ses
// marqueurs. Écrite dans le même geste, sinon elle décrit un état que les
// marqueurs ne désignent plus. L'échec n'est pas fatal : le node reste
// exploitable avec ses seuls marqueurs, il est juste moins autonome.
async function writeNodeLibrary(rec, meta) {
  const markers = (meta.outputs || []).map(o => o.product).filter(Boolean);
  const slice = library.nodeSlice(libraryStore, markers);
  const pw = meta.power || {};
  // La carte et le modèle d'alimentation aussi : sans eux, un node lu sur un
  // poste neuf dirait « alimenté par 7e3f… » sans que personne ne sache ce que
  // c'est. C'est le même problème que les produits, et la même réponse.
  Object.assign(slice, drivers.nodeSlice(driverStore, [pw.driver].filter(Boolean)));
  const inst = powerPlan.psus.find(x => x.uid === pw.psu);
  Object.assign(slice, psus_.nodeSlice(psuStore, [inst && inst.model].filter(Boolean)));
  // et l'exemplaire lui-même, qui n'est dans aucun catalogue puisqu'il est
  // propre à ce montage
  if (inst) slice.powerNodes = [{ uid: inst.uid, label: inst.label, model: inst.model, location: inst.location }];
  if (!slice.products.length && !slice.drivers.length && !slice.psus.length) return;   // rien à décrire
  slice.format = library.NODE_FORMAT;
  try {
    await metadata.writeFile(rec.meta.ip, library.NODE_FILE, slice, 8000);
    rec.meta.nodeLib = slice;
  } catch (e) {
    console.log(`${rec.meta.ip}: bibliothèque embarquée non écrite (${e.message})`);
  }
}

// Le rattachement d'un node, écrit sur le node lui-même. `undefined` = « la
// grille n'a pas d'avis » ; `null` = « détache ». La distinction compte :
// enregistrer un formulaire où le champ carte est absent ne doit pas effacer la
// carte déclarée.
async function writeNodePower(rec, b) {
  const cur = metadata.parse(rec.meta.nodeMeta || metadata.empty());
  const next = metadata.parse({ ...cur, power: {
    psu: b.psu === undefined ? cur.power.psu : b.psu,
    rail: b.rail === undefined ? cur.power.rail : b.rail,
    driver: b.driver === undefined ? cur.power.driver : b.driver,
  } });
  await metadata.write(rec.meta.ip, next, 8000);
  rec.meta.nodeMeta = next;
  if (!metadata.isEmpty(next)) rec.meta.nodeMetaSeen = next;
  await writeNodeLibrary(rec, next);
  derive(rec);
}

async function restoreNodeMeta(rec, reason = 'maj') {
  const saved = rec.meta.nodeMetaSeen;
  if (!saved || metadata.isEmpty(saved)) return null;
  let now;
  try { now = await metadata.read(rec.meta.ip, 3000); } catch { return null; }
  if (!metadata.isEmpty(now)) return null;                    // toujours là : rien à faire
  try {
    await metadata.write(rec.meta.ip, saved, 8000);
    rec.meta.nodeMeta = saved;
    recordChange(rec, 'fleet-meta', 'perdues', 'restaurées depuis la copie de Fleet', reason);
    console.log(`${rec.meta.ip}: métadonnées Fleet restaurées après ${reason}`);
    return true;
  } catch (e) {
    console.log(`${rec.meta.ip}: restauration des métadonnées impossible (${e.message})`);
    return false;
  }
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

// ── Locate pixel: compter les vrais pixels d'un ruban, en direct ─────────────
// Les index de pixels WLED appartiennent au bus que la VRAIE config hw.led.ins
// désigne : un simple segment ne peut pas montrer « et si cette sortie avait
// plus de pixels ? » au-delà de sa longueur déclarée, car ces index-là sont
// physiquement câblés sur la sortie SUIVANTE (constaté en direct : dépasser la
// limite allumait le ruban d'à côté, au lieu de déplacer le repère).
//
// D'où le principe (revu le 2026-09-08) : à l'activation, la sortie est portée
// UNE FOIS à une longueur d'exploration (probeLen) qui couvre tout le ruban, et
// n'y bouge plus de la session. Le nombre de pixels « candidat » n'est alors
// plus qu'un découpage en trois zones colorées — en dessous du repère, le
// repère, au-delà — envoyées en un seul /json/state.
//
// Ce que ça règle, par construction :
//  - plus aucun pixel orphelin. Avant, chaque changement réécrivait la longueur
//    du bus ; en descendant, les pixels qui en sortaient n'étaient plus pilotés
//    du tout et gardaient leur dernière couleur pour toujours — le repère
//    descendait mais le ruban ne raccourcissait jamais à l'œil.
//  - beaucoup plus réactif : plus de /json/cfg ni d'attente de 200 ms à chaque
//    frappe, et WLED écrit cfg.json en flash à chaque cfg — on passe d'une
//    écriture par frappe à deux par session.
//  - on voit où le ruban continue (3e couleur), ce qui aide à trouver sa fin.
//
// Les sorties collées suivantes sont décalées du même delta pendant la session
// (leurs rubans restent éteints), et tout est restauré à l'identique à l'arrêt.
// Sans nouvelle commande pendant LOCATE_TIMEOUT_MS, la restauration part toute
// seule : quitter l'onglet ne laisse jamais un node en plan.
//
// `rev` (le drapeau « inversée » de la sortie, hw.led.ins[i].rev) : WLED remappe
// l'index de bus i sur la position physique L-1-i avant le driver, avec L = la
// longueur DU BUS — donc probeLen ici, pas la longueur d'origine. Le pixel
// physique n°k est ainsi `start + probe - k`, et les trois zones sont l'image
// miroir exacte du cas normal. Comme probeLen ne bouge pas de la session, cette
// correspondance reste stable pendant qu'on compte.
// (L'émulateur ne simule pas ce remap de bus, les faux nodes non plus : c'est le
// seul point qui demande une vérification sur un vrai ruban inversé. Signaler si
// le repère tombe au mauvais bout du fil.)
const locating = new Map(); // ip -> { savedState, seg0..2, seg{1,2}Existed, touchedSeg{1,2}, savedIns, outIndex, origStart, origLen, probeLen, timer }
const LOCATE_TIMEOUT_MS = 90000;
const LOCATE_MAX_PROBE = 2048; // garde-fou mémoire ESP32
const LOCATE_DEFAULT = { hi: [255, 255, 255], lo: [48, 96, 255], over: [58, 10, 0], bri: 255 };
// "#rrggbb" -> [r,g,b] ; toute valeur douteuse retombe sur la couleur d'origine
function hexRgb(v, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const probeFor = origLen => Math.min(LOCATE_MAX_PROBE, Math.max(200, origLen * 2));

async function setLocatePixel(ip, outIndex, len, rev, opts = {}) {
  const rec = fleet.get(ip);
  if (!rec) throw new Error('node inconnu');
  let session = locating.get(ip);
  let wroteCfg = false;
  if (!session) {
    const ins = rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins;
    if (!Array.isArray(ins) || !ins[outIndex]) throw new Error('config des sorties non lue');
    const savedState = (await getJson(ip, '/json/state', 3000)).json;
    const seg0 = (savedState.seg || []).find(s => s.id === 0) || (savedState.seg || [])[0];
    if (!seg0) throw new Error('aucun segment sur ce node');
    const byId = i => (savedState.seg || []).find(s => s.id === i) || null;
    session = {
      savedState, seg0, seg1: byId(1), seg1Existed: !!byId(1), touchedSeg1: false,
      seg2: byId(2), seg2Existed: !!byId(2), touchedSeg2: false,
      savedIns: ins.map(b => ({ ...b })), outIndex, origStart: ins[outIndex].start, origLen: ins[outIndex].len,
      probeLen: 0,
    };
    locating.set(ip, session);
  }
  clearTimeout(session.timer);

  // Longueur d'exploration : le bus couvre TOUT le ruban pendant la session, écrite
  // une seule fois. C'est ce qui garantit qu'aucun pixel ne peut rester allumé en
  // sortant de la chaîne — il n'en sort jamais — et ça évite une écriture flash du
  // cfg.json du node à chaque frappe.
  let probe = Math.round(Number(opts.probe) || 0) || session.probeLen || probeFor(session.origLen);
  probe = Math.max(1, Math.min(LOCATE_MAX_PROBE, probe));
  len = Math.max(1, Math.min(probe, Math.round(len)));
  if (probe !== session.probeLen) {
    const orig = session.savedIns;
    const ins = orig.map(b => ({ ...b }));
    const delta = probe - session.origLen;
    ins[session.outIndex].len = probe;
    if (delta !== 0) { // décale les sorties collées, comme avant, pour ne rien chevaucher
      let boundary = orig[session.outIndex].start + orig[session.outIndex].len;
      for (let i = session.outIndex + 1; i < orig.length; i++) {
        if (orig[i].start !== boundary) break; // trou dans la disposition d'origine : la chaîne s'arrête
        ins[i].start = orig[i].start + delta;
        boundary = orig[i].start + orig[i].len;
      }
    }
    await postJson(ip, '/json/cfg', { hw: { led: { ins } } }, 8000);
    await new Promise(r => setTimeout(r, 200)); // le bus se réinitialise après un changement de longueur
    session.probeLen = probe;
    wroteCfg = true;
  }

  // Trois zones, calculées dans l'ordre PHYSIQUE du fil. Avec rev, WLED remappe
  // l'index de bus i sur la position physique (probe-1-i) : le pixel physique n°k
  // est donc `start + probe - k`, et les zones sont l'image miroir du cas normal.
  const hi = hexRgb(opts.hi, LOCATE_DEFAULT.hi), lo = hexRgb(opts.lo, LOCATE_DEFAULT.lo), over = hexRgb(opts.over, LOCATE_DEFAULT.over);
  const bri = Math.max(1, Math.min(255, Math.round(Number(opts.bri)) || LOCATE_DEFAULT.bri));
  const s = session.origStart;
  const zones = rev
    ? [ // miroir : le repère est en bas des index, le « au-dessus » avant lui
      { from: s, to: s + probe - len, col: over },            // au-delà du compte
      { from: s + probe - len, to: s + probe - len + 1, col: hi }, // le repère
      { from: s + probe - len + 1, to: s + probe, col: lo },   // en dessous
    ]
    : [
      { from: s, to: s + len - 1, col: lo },
      { from: s + len - 1, to: s + len, col: hi },
      { from: s + len, to: s + probe, col: over },
    ];
  const used = zones.filter(z => z.to > z.from);
  // seg0 d'abord, puis deux ids libres : si le node n'a pas de segment 0, seg0.id
  // peut valoir 1 ou 2 et il ne faut pas l'écraser avec un doublon
  const ids = [session.seg0.id, ...[1, 2, 3].filter(i => i !== session.seg0.id)].slice(0, 3);
  const segs = used.map((z, i) => ({ id: ids[i], start: z.from, stop: z.to, on: true, bri, col: [z.col, [0, 0, 0], [0, 0, 0]], fx: 0, sx: 0, frz: false }));
  // les segments qu'on a créés mais qui ne servent plus (len = 1, ou len = probe) sont retirés
  for (let i = used.length; i < ids.length; i++) segs.push({ id: ids[i], stop: 0 });
  // tout id autre que seg0 sur lequel on écrit — y compris pour le supprimer — doit
  // être restauré à l'arrêt, sinon on laisserait détruit un segment de l'utilisateur
  if (ids.includes(1)) session.touchedSeg1 = true;
  if (ids.includes(2)) session.touchedSeg2 = true;
  await postJson(ip, '/json/state', { on: true, bri: 255, tt: 0, lor: 1, seg: segs }, 3000);
  session.timer = setTimeout(() => { stopLocatePixel(ip).catch(() => {}); }, LOCATE_TIMEOUT_MS);
  return { ok: true, probe, len, wroteCfg };
}
async function stopLocatePixel(ip) {
  const session = locating.get(ip); if (!session) return { ok: true, already: false };
  clearTimeout(session.timer);
  locating.delete(ip);
  const { savedState, seg0, seg1, seg1Existed, touchedSeg1, seg2, seg2Existed, touchedSeg2, savedIns } = session;
  try { await postJson(ip, '/json/cfg', { hw: { led: { ins: savedIns } } }, 8000); } catch (e) { console.log(`locate-pixel ${ip}: sorties non restaurées (${e.message})`); }
  await new Promise(r => setTimeout(r, 200));
  const back = { ...savedState, tt: 0, lor: savedState.lor || 0 };
  delete back.nl; delete back.udpn; delete back.ledmap; delete back.mainseg;
  const strip = s => { const c = { ...s }; delete c.len; delete c.n; delete c.set; return c; };
  const segs = [strip(seg0)];
  if (touchedSeg1) segs.push(seg1Existed ? strip(seg1) : { id: 1, stop: 0 }); // stop:0 supprime un segment qu'on a créé
  if (touchedSeg2) segs.push(seg2Existed ? strip(seg2) : { id: 2, stop: 0 });
  back.seg = segs;
  await postJson(ip, '/json/state', back, 3000);
  const rec = fleet.get(ip);
  if (rec) { rec.meta.cfgUpdated = 0; pollInfoState(rec, 'grille').catch(() => {}); } // re-sync the fleet's cached cfg with the restored reality
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
const ESPRESSIF_OUIS = (() => { try { return new Set(JSON.parse(fs.readFileSync(codeFile('tools', 'espressif-oui.json'), 'utf8')).ouis); } catch { return new Set(); } })();
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
const knownEntries = () => [...fleet.values()].map(r => ({ ip: r.meta.ip, lastSeen: r.meta.lastSeen, info: r.info, state: r.state, cfg: r.cfg, ignoredOutputs: r.meta.ignoredOutputs || [], group: r.meta.group || '', offlineQueue: r.meta.offlineQueue || null, nodeMeta: r.meta.nodeMetaSeen || null }));
let declaredGroups = []; // Fleet-only group names, kept even when no node is in them
// ── Bibliothèque de produits LED ─────────────────────────────────────────────
// Le fichier reste 'led-profiles.json' : il est migré en place au chargement
// (tableau nu = v1, identifiants courts = v2). Chaque produit reçoit un uuid,
// et son ancien identifiant court est CONSERVÉ comme `legacyId` — les nodes
// déjà patchés continuent donc de désigner le bon produit sans être réécrits.
const PROFILES_FILE = dataFile('led-profiles.json');
let libraryStore = { products: [] };
function loadLibrary() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { /* pas encore de fichier */ }
  const was = raw && raw.formatVersion;
  libraryStore = library.migrate(raw);
  if (libraryStore.products.length && was !== library.FORMAT_VERSION) {
    saveLibrary();
    console.log(`bibliothèque : ${libraryStore.products.length} produit(s) migré(s) en v${library.FORMAT_VERSION}, anciens identifiants conservés`);
  }
}
// écriture atomique : un plantage en cours d'écriture ne doit pas laisser un
// catalogue tronqué là où l'ancien code écrivait directement par-dessus
function saveLibrary() {
  try {
    const tmp = PROFILES_FILE + '.part';
    fs.writeFileSync(tmp, JSON.stringify(libraryStore, null, 2));
    fs.renameSync(tmp, PROFILES_FILE);
  } catch { /* ignore */ }
}
loadLibrary();

// ── Les deux autres catalogues ──────────────────────────────────────────────
// Fichiers séparés, et non un seul qui les porterait tous les trois : chaque
// enregistrement réécrit son fichier en entier, et un fichier abîmé ne doit pas
// emporter les deux autres catalogues avec lui.
const DRIVERS_FILE = dataFile('drivers.json');
const PSUS_FILE = dataFile('psus.json');
// Un seul chargeur pour les deux : même mécanique, mêmes pièges, et un seul
// endroit à corriger le jour où l'écriture doit changer.
function loadCat(file, cat, empty) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return empty; }
  try { return cat.normStore(raw); } catch { return empty; }
}
function saveCat(file, store) {
  try {
    const tmp = file + '.part';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
}
let driverStore = loadCat(DRIVERS_FILE, drivers, { drivers: [] });
let psuStore = loadCat(PSUS_FILE, psus_, { psus: [] });

// Les trois catalogues vus d'un seul endroit : chaque route les désigne par leur
// nom plutôt que de répéter trois fois la même logique.
const CATS = {
  products: { cat: library, file: PROFILES_FILE, collection: 'products', get store() { return libraryStore; }, set store(v) { libraryStore = v; } },
  drivers: { cat: drivers, file: DRIVERS_FILE, collection: 'drivers', get store() { return driverStore; }, set store(v) { driverStore = v; } },
  psus: { cat: psus_, file: PSUS_FILE, collection: 'psus', get store() { return psuStore; }, set store(v) { psuStore = v; } },
};

// Enregistrer un catalogue désigné par son nom : les produits ont leur écriture
// historique, les deux autres passent par saveCat.
const saveKind = kind => { if (kind === 'products') saveLibrary(); else saveCat(CATS[kind].file, CATS[kind].store); };

// Quels nodes portent quel driver, quelle alimentation. Sans ce relevé, on ne
// sait ni ce qu'on peut retirer sans casse, ni ce qui n'est rattaché à rien.
function catUsage(kind) {
  if (kind === 'products') return productUsage();
  const by = {};
  const c = CATS[kind]; if (!c) return by;
  for (const rec of fleet.values()) {
    const pw = (rec.meta.nodeMeta && rec.meta.nodeMeta.power) || {};
    const uid = kind === 'drivers' ? pw.driver : pw.psu;
    if (!uid) continue;
    const it = c.cat.resolve(c.store, uid);
    const key = it ? it.uid : uid;                     // marqueur inconnu : gardé tel quel
    (by[key] = by[key] || []).push({ ip: rec.meta.ip, name: (rec.info && rec.info.name) || rec.meta.ip, rail: pw.rail || null });
  }
  return by;
}

// ── Le plan d'alimentation ──────────────────────────────────────────────────
// Les EXEMPLAIRES posés sur le plateau, par opposition aux modèles du
// catalogue. Propre au spectacle, donc jamais dans le dépôt partagé — mais
// dans le showfile, puisqu'il décrit ce montage-là.
const POWER_FILE = dataFile('power-plan.json');
let powerPlan = (() => {
  try { return power.normPlan(JSON.parse(fs.readFileSync(POWER_FILE, 'utf8'))); } catch { return power.normPlan(null); }
})();
const savePlan = () => saveCat(POWER_FILE, powerPlan);

// Ce que le module de cohérence attend : un budget par node, et les
// exemplaires avec la liste des nodes qui les désignent.
function powerAudit() {
  const nodes = [];
  for (const rec of fleet.values()) {
    const led = (rec.cfg && rec.cfg.hw && rec.cfg.hw.led) || null;
    if (!led || !Array.isArray(led.ins)) continue;
    const meta = rec.meta.nodeMeta || metadata.empty();
    const byPos = []; for (const o of meta.outputs) byPos[o.i] = o;
    const driver = drivers.resolve(driverStore, (meta.power && meta.power.driver) || null);
    nodes.push({
      ip: rec.meta.ip, name: (rec.info && rec.info.name) || rec.meta.ip, driver,
      online: !!rec.meta.online,
      power: meta.power || { psu: null, rail: null, driver: null },
      budget: power.nodeBudget({
        maxpwr: led.maxpwr, ins: led.ins, ignored: rec.meta.ignoredOutputs || [], driver,
        product: i => library.resolve(libraryStore, (byPos[i] || {}).product),
      }),
    });
  }
  // un exemplaire rassemble les nodes qui le désignent — au niveau node, ou par
  // une sortie qui déclare autre chose que son node
  const psus = powerPlan.psus.map(inst => ({
    ...inst,
    model: psus_.resolve(psuStore, inst.model),
    rail: null,
    nodes: nodes.filter(n => n.power.psu === inst.uid).map(n => n.ip),
  }));
  return power.audit({ psus, nodes });
}

// Le corps commun des routes de catalogue. Les trois types se comportent
// pareil ; seul leur contenu diffère.
function catView(kind) {
  const c = CATS[kind];
  const { VOLTAGES, ETH_TYPES } = require('./columns');
  return { ...c.store, usage: catUsage(kind), voltages: VOLTAGES, ethTypes: ETH_TYPES, readonly: READONLY };
}
function catUpsert(res, kind, body) {
  if (READONLY) return send(res, 403, { error: 'lecture seule' });
  const c = CATS[kind];
  try {
    const r = c.cat.upsert(c.store, { ...body, updatedBy: ghConf.login || body.updatedBy || '' });
    c.store = r.store; saveCat(c.file, c.store); autoSyncSoon();
    return send(res, 200, { ok: true, item: r.product, ...c.store });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
function catRetire(res, kind, uid) {
  if (READONLY) return send(res, 403, { error: 'lecture seule' });
  const c = CATS[kind];
  try {
    const it = c.cat.resolve(c.store, uid);
    // ce que personne ne déclare et qui n'a jamais été publié peut disparaître ;
    // le reste est marqué retiré, sinon les marqueurs déjà posés ne désignent
    // plus rien
    const purge = it ? !(catUsage(kind)[it.uid] || []).length : false;
    c.store = c.cat.retire(c.store, uid, { purge });
    saveCat(c.file, c.store);
    return send(res, 200, { ok: true, purged: purge, ...c.store });
  } catch (e) { return send(res, 400, { error: e.message }); }
}

// ── Dépôt partagé de la bibliothèque ────────────────────────────────────────
// Le jeton d'écriture vit dans son propre fichier, JAMAIS dans le showfile ni
// dans l'archive publiée : c'est un secret d'une autre classe que les mots de
// passe d'antenne, il donne accès en écriture à un dépôt.
//
// Deux façons de s'authentifier :
//
//   'gh'    on demande son jeton à GitHub CLI À CHAQUE USAGE. Rien de sensible
//           n'est stocké par Fleet — le secret reste dans le trousseau de
//           l'OS, là où gh l'a mis, et révoquer la session gh suffit à couper
//           l'accès. C'est le mode à préférer quand gh est installé.
//   'token' un jeton saisi à la main, écrit dans ce fichier. Nécessaire quand
//           gh n'est pas là, mais le secret est alors en clair sur le disque.
const GITHUB_FILE = dataFile(FIXED_IPS.length ? 'github-dev.json' : 'github.json');
let ghConf = { repo: '', token: '', source: 'gh', login: '', branch: 'main', lastSyncAt: 0, lastError: '' };
// La connexion est FAITE UNE FOIS. Le fichier vit dans le dossier de données
// (Documents\WLED Fleet), pas à côté du code : il survit donc aussi bien à un
// redémarrage qu'à une mise à jour de l'application, qui remplace le code.
// Un jeton d'OAuth App n'expire pas de lui-même ; on ne redemande la connexion
// que si GitHub finit par le refuser.
function loadGithub() {
  try {
    const raw = JSON.parse(fs.readFileSync(GITHUB_FILE, 'utf8'));
    ghConf = { ...ghConf, ...raw, token: unprotect(raw.token) };
  } catch { /* pas encore configuré */ }
}
function saveGithub() {
  try {
    const t = GITHUB_FILE + '.part';
    fs.writeFileSync(t, JSON.stringify({ ...ghConf, token: protect(ghConf.token) }, null, 2));
    fs.renameSync(t, GITHUB_FILE);
  } catch { /* ignore */ }
}

// ── L'application GitHub, et comment elle se met à jour ────────────────────
// Le `client_id` d'une OAuth App n'est pas un secret : il voyage avec
// l'application, c'est prévu. Il est donc compilé dans l'installeur — aucune
// dépendance extérieure à installer pour se connecter.
//
// Mais un client_id peut devoir changer sans qu'on republie tout le monde :
// application recréée, organisation renommée, portée revue. Fleet va donc lire
// périodiquement `github-app.json` dans son propre dépôt public, et retient ce
// qu'il y trouve. Le dépôt public est déjà la source de ses mises à jour ; ça
// n'ajoute pas de point de confiance.
//
// L'ordre est : ce qu'on a appris en ligne, sinon la valeur compilée. Une
// panne de réseau ne peut donc pas empêcher de se connecter.
const DEFAULT_CLIENT_ID = '';        // renseigné à la création de l'OAuth App
const APP_MANIFEST = { repo: 'Tensegrity-Lighting-Service/WLED-Fleet', path: 'github-app.json' };
const APP_MANIFEST_INTERVAL = 24 * 60 * 60 * 1000;
const ghClientId = () => ghConf.clientId || DEFAULT_CLIENT_ID;

async function refreshGithubApp() {
  try {
    const r = await github.request('GET', `/repos/${APP_MANIFEST.repo}/contents/${APP_MANIFEST.path}`, {});
    if (r.error) return;                                   // absent : on garde ce qu'on a
    const doc = JSON.parse(Buffer.from(r.json.content || '', 'base64').toString('utf8'));
    const id = String(doc.clientId || '').trim();
    if (id && id !== ghConf.clientId) {
      ghConf.clientId = id; saveGithub();
      console.log(`application GitHub : client_id mis à jour depuis ${APP_MANIFEST.repo}`);
    }
  } catch { /* réseau, JSON abîmé : la valeur compilée reste utilisable */ }
}

// ── Le jeton au repos ───────────────────────────────────────────────────────
// Sous Windows, DPAPI chiffre pour le compte utilisateur courant : le fichier
// recopié ailleurs ne se déchiffre pas. C'est un composant du système, pas une
// dépendance à installer. Si ça échoue (autre OS, PowerShell verrouillé), on
// retombe sur du clair plutôt que de perdre la connexion.
const DPAPI_PREFIX = 'dpapi:';
function protect(secret) {
  if (process.platform !== 'win32' || !secret) return secret;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `ConvertTo-SecureString -String $input -AsPlainText -Force | ConvertFrom-SecureString`],
    { input: secret, encoding: 'utf8', timeout: 10000 }).trim();
    return out ? DPAPI_PREFIX + out : secret;
  } catch { return secret; }
}
function unprotect(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(DPAPI_PREFIX)) return stored || '';
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = $input | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`],
    { input: stored.slice(DPAPI_PREFIX.length), encoding: 'utf8', timeout: 10000 }).trim();
  } catch { return ''; }        // chiffré pour un autre compte : inutilisable, pas fatal
}

// ── Le jeton, demandé à GitHub CLI plutôt que stocké ────────────────────────
// `gh auth token` lit le trousseau de l'OS. On l'interroge à chaque
// synchronisation : Fleet n'écrit alors aucun secret sur le disque, et le
// jeton suit la session gh — s'y déconnecter coupe l'accès sans avoir à
// nettoyer quoi que ce soit ici.
//
// Court cache : une synchronisation enchaîne plusieurs requêtes, et lancer un
// processus par requête serait inutilement lent.
const { execFileSync } = require('child_process');
let ghCliCache = { token: '', at: 0 };
function ghCliToken() {
  if (ghCliCache.token && Date.now() - ghCliCache.at < 60000) return ghCliCache.token;
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  if (!token) throw new Error('GitHub CLI n\'a pas rendu de jeton');
  ghCliCache = { token, at: Date.now() };
  return token;
}
// Le jeton effectif, quelle que soit la source. Ne JAMAIS le renvoyer par l'API.
function ghToken() {
  if (ghConf.source === 'gh') {
    try { return ghCliToken(); }
    catch { throw new Error('GitHub CLI indisponible ou déconnecté — lancer « gh auth login », ou se connecter depuis l\'onglet Bibliothèque'); }
  }
  return ghConf.token || '';
}
const ghHasAuth = () => (ghConf.source === 'gh' ? ghCliAvailable() : !!ghConf.token);
function ghCliAvailable() {
  try { return !!execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }).trim(); }
  catch { return false; }
}

// ── Connexion GitHub, en une fois ───────────────────────────────────────────
// Une seule connexion en cours à la fois : le code affiché n'a de sens que
// pour la demande qui l'a produit.
let ghDevice = null;
function ghLoggedIn(token, login, source) {
  ghConf.source = source; ghConf.token = source === 'gh' ? '' : token;
  ghConf.login = login || ''; ghConf.lastError = ''; ghDevice = null;
  saveGithub(); startAutoSync();
}
// Au démarrage : vérifier que le jeton gardé est toujours accepté. Un jeton
// révoqué doit se voir tout de suite, pas au premier essai de publication.
async function checkGithubAuth() {
  if (!ghConf.token && ghConf.source !== 'gh') return;
  try { const me = await github.whoami(ghToken()); ghConf.login = me.login; ghConf.lastError = ''; saveGithub(); }
  catch (e) {
    // 401 = jeton révoqué ou expiré : on l'oublie, il ne servira plus
    if (/jeton/i.test(e.message)) { ghConf.token = ''; ghConf.login = ''; ghConf.lastError = 'connexion GitHub expirée — se reconnecter'; saveGithub(); }
  }
}

// Ce que l'interface a le droit de voir : de quoi savoir si c'est configuré et
// reconnaître le jeton, jamais le jeton.
const githubView = () => ({
  repo: ghConf.repo, branch: ghConf.branch || 'main',
  source: ghConf.source || 'gh', login: ghConf.login || '',
  hasToken: ghHasAuth(), tail: ghConf.source === 'token' && ghConf.token ? `…${ghConf.token.slice(-4)}` : '',
  lastSyncAt: ghConf.lastSyncAt || 0, lastError: ghConf.lastError || '',
  auto: ghConf.auto !== false, autoBusy: ghBusy,
  // en attente de publication, les trois catalogues confondus : le badge doit
  // dire qu'il reste quelque chose à pousser, pas seulement des produits
  pending: Object.keys(CATS).reduce((s, k) => s + CATS[k].store[CATS[k].collection].filter(p => p.dirty && !p.retired).length, 0),
});

// ── Synchronisation automatique ─────────────────────────────────────────────
// Tant que Fleet reste un outil interne, tenir le catalogue à jour à la main
// est une corvée qu'on oublie — et un catalogue oublié fait des marqueurs qui
// ne résolvent plus. On tire au démarrage puis régulièrement, et on publie ce
// qui a changé ici.
//
// C'est acceptable UNIQUEMENT parce que la publication ne peut rien écraser :
// sur collision, la version en ligne devient la base et la nôtre repart
// au-dessus (voir github.js). Sans cette garantie, une publication automatique
// serait le meilleur moyen d'effacer le travail d'un collègue en silence.
//
// À revoir le jour où le logiciel sort d'ici : un utilisateur qui ne connaît
// pas le dépôt ne doit pas y publier sans l'avoir demandé.
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000;
let ghBusy = false, ghAutoTimer = null;

async function autoSync(reason = 'périodique') {
  if (READONLY || ghBusy) return;
  if (!ghConf.repo || ghConf.auto === false) return;
  ghBusy = true;
  try {
    // Les TROIS catalogues, pas seulement les produits : un driver ou une alim
    // qui reste sur un poste ne vaut rien, et c'est justement ce que le dépôt
    // partagé est censé résoudre.
    const stores = { products: libraryStore, drivers: driverStore, psus: psuStore };
    const r = await github.pull(ghConf.repo, stores, { token: ghToken(), branch: ghConf.branch });
    const touched = new Set();
    let n = 0;
    for (const remote of r.fetched) {
      const c = CATS[remote.kind]; if (!c) continue;          // type inconnu : laissé au dépôt
      const norm = x => c.cat.catalog.normOne(x);
      const mine = c.cat.resolve(c.store, remote.uid);
      if (!mine) { c.store[c.collection].push(norm({ ...remote, dirty: false })); n++; touched.add(remote.kind); continue; }
      // ce qui est modifié ici et pas encore publié n'est jamais écrasé par le
      // dépôt : la publication juste après saura se replacer au-dessus
      if (mine.dirty && c.cat.substance(mine) !== c.cat.substance(remote)) continue;
      Object.assign(mine, norm({ ...remote, dirty: false })); n++; touched.add(remote.kind);
    }
    let pushed = 0;
    if (ghHasAuth()) {
      for (const kind of Object.keys(CATS)) {
        const c = CATS[kind];
        for (const item of c.store[c.collection].filter(x => x.dirty && !x.retired)) {
          const res = await github.publish(ghConf.repo, item, { token: ghToken(), branch: ghConf.branch, space: kind });
          Object.assign(item, c.cat.catalog.normOne({ ...res.product, origin: 'library', dirty: false }), { blobSha: res.sha || null });
          if (res.action !== 'skip' && res.action !== 'adopt') { pushed++; touched.add(kind); }
        }
      }
    }
    for (const kind of touched) { CATS[kind].store = CATS[kind].cat.normStore(CATS[kind].store); saveKind(kind); }
    ghConf.lastSyncAt = Date.now(); ghConf.lastError = '';
    saveGithub();
    if (n || pushed) console.log(`bibliothèques (${reason}) : ${n} repris du dépôt, ${pushed} publié(s)`);
  } catch (e) {
    ghConf.lastError = e.message; saveGithub();
    console.log(`bibliothèque (${reason}) : ${e.message}`);
  } finally { ghBusy = false; }
}
// après une modification locale : laisser le temps d'enchaîner plusieurs
// enregistrements avant d'aller voir GitHub, sinon on commite trois fois pour
// une seule séance d'édition
let ghSoon = null;
const autoSyncSoon = () => {
  if (READONLY || !ghConf.repo || ghConf.auto === false) return;
  clearTimeout(ghSoon); ghSoon = setTimeout(() => autoSync('après édition'), 5000);
};
function startAutoSync() {
  clearInterval(ghAutoTimer);
  if (!ghConf.repo || ghConf.auto === false) return;
  setTimeout(() => autoSync('démarrage'), 3000);
  ghAutoTimer = setInterval(() => autoSync('périodique'), AUTO_SYNC_INTERVAL);
}
// forme attendue par l'ancien point d'entrée et par les anciens showfiles
const legacyProfiles = () => libraryStore.products.filter(p => !p.retired).map(p => ({
  id: p.uid, legacyId: p.legacyId, name: library.label(p), type: p.led.type, order: p.led.order,
  len: (p.presets.find(x => x.default) || p.presets[0] || {}).px || 0,
  // toutes les longueurs de la fiche, pas seulement celle par défaut : sans
  // elles, une sortie réglée sur une AUTRE longueur type ne se reconnaissait
  // plus dans son propre produit
  lens: p.presets.map(x => x.px),
  perM: p.led.perM, note: p.ref.note,
}));
// quelles sorties de la flotte utilisent quel produit — sert au badge, au
// panneau « utilisé par » de l'éditeur, et au garde-fou avant de retirer.
// Indexé par uid : un node encore marqué à l'ancien identifiant court est
// résolu ici, donc il compte bien dans les usages du produit.
function productUsage() {
  const by = {};
  for (const rec of fleet.values()) {
    const meta = rec.meta.nodeMeta; if (!meta) continue;
    const ins = (rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
    for (const o of meta.outputs) {
      if (!o.product) continue;
      const p = library.resolve(libraryStore, o.product);
      const key = p ? p.uid : o.product;                   // marqueur inconnu : gardé tel quel, jamais effacé
      (by[key] = by[key] || []).push({
        ip: rec.meta.ip, name: (rec.info && rec.info.name) || rec.meta.ip, index: o.i,
        len: (ins[o.i] || {}).len || 0,
        rev: o.prev, revState: library.revState(p, o.prev),
      });
    }
  }
  return by;
}
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
    // dernière copie connue des métadonnées du node : sert à les afficher hors
    // ligne, et à les remettre si le node revient nu d'une mise à jour
    if (e.nodeMeta) { r.meta.nodeMetaSeen = metadata.parse(e.nodeMeta); r.meta.nodeMeta = r.meta.nodeMetaSeen; }
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
const STATIC = codeFile('static');

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
    // @api État complet de la flotte : un objet par node avec info, state,
    // cfg, les colonnes dérivées et les métadonnées Fleet. C'est la lecture
    // principale, celle que la grille rafraîchit en boucle.
    if (p === '/api/fleet') return send(res, 200, fleetPayload());
    // @api Vocabulaire de l'application : définition des colonnes, groupes
    // déclarés, et les tables WLED (types de LED, ordres des couleurs,
    // échanges du blanc, types à canal blanc, consommations par pixel
    // courantes, et les bornes du firmware pour les champs de courant).
    if (p === '/api/columns') { const { LED_TYPES, COLOR_ORDERS, WHITE_SWAPS, WHITE_SWAP_TYPES, LED_MA_PRESETS, LED_MA_MAX, PSU_MA_MIN, PSU_MA_MAX, MA_FOR_ESP } = require('./columns'); return send(res, 200, { columns, groups, ledTypes: LED_TYPES, colorOrders: COLOR_ORDERS, whiteSwaps: WHITE_SWAPS, whiteSwapTypes: WHITE_SWAP_TYPES, ledMaPresets: LED_MA_PRESETS, ledMaMax: LED_MA_MAX, psuMaMin: PSU_MA_MIN, psuMaMax: PSU_MA_MAX, maForEsp: MA_FOR_ESP }); }
    // @api Écrit les sorties LED du node. Le bloc hw.led.ins est renvoyé
    // ENTIER — WLED le reconstruit — et les champs non gérés par Fleet sont
    // hérités par position. Accepte un tableau `meta` optionnel, écrit dans
    // /fleet.json APRÈS les réglages.
    if ((m = /^\/api\/node\/([^/]+)\/outputs$/.exec(p)) && req.method === 'POST') {
      // LED outputs editor: WLED rebuilds hw.led.ins from the payload, so the WHOLE array is sent.
      // Only scalar fields we understand are taken from the UI; anything else on an existing bus is kept.
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec || !rec.cfg || !rec.cfg.hw || !rec.cfg.hw.led) return send(res, 400, { error: 'config du node pas encore lue' });
      const b = await readBody(req);
      if (!Array.isArray(b.ins) || !b.ins.length) return send(res, 400, { error: 'liste de sorties vide' });
      const prevIns = rec.cfg.hw.led.ins || [];
      const ins = [];
      for (let i = 0; i < b.ins.length; i++) {
        const u = b.ins[i];
        const pins = String(u.pin || '').split(/[\/,\s]+/).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 48);
        if (!pins.length) return send(res, 400, { error: `sortie ${i + 1} : pin invalide` });
        const len = Number(u.len), start = Number(u.start), type = Number(u.type), order = Number(u.order);
        if (!(len > 0 && len <= 4096)) return send(res, 400, { error: `sortie ${i + 1} : longueur invalide` });
        if (!(start >= 0)) return send(res, 400, { error: `sortie ${i + 1} : index de départ invalide` });
        // une ligne éditée hérite des champs inconnus du bus qu'elle remplace : par POSITION,
        // pas par index de départ — ⚡ Patcher renumérote les départs, et prevByStart faisait
        // alors hériter la ligne des réglages d'UNE AUTRE sortie (corrigé 2026-09-08).
        const base = { ...(prevIns[i] || {}) };
        // borné à 255 : le firmware relit ce champ dans un uint8_t
        // (cfg.cpp:241), donc 5000 ne serait pas refusé mais tronqué en
        // silence, et l'ABL freinerait d'après un chiffre inventé. Rien ne le
        // bornait jusqu'ici, ni ici ni dans l'interface.
        const ledma = Math.min(255, Number(u.ledma));
        // hw.led.ins[].order = (échange du blanc << 4) | ordre des couleurs : ne réécrire que
        // le quartet qu'on connaît, sinon le swap réglé dans WLED est effacé à chaque save.
        const wswap = Number(u.wswap);
        const lowNib = Number.isFinite(order) ? (order & 0x0f) : ((base.order ?? 0) & 0x0f);
        const highNib = Number.isFinite(wswap) ? (wswap & 0x0f) : (((base.order ?? 0) >> 4) & 0x0f);
        // Limite de courant PAR SORTIE. Elle n'agit que si la limite globale du
        // node vaut 0 — les deux régimes s'excluent (bus_manager.cpp:1449). WLED
        // l'expose par la case « Use per-output limiter », qui n'est pas stockée :
        // cocher revient à soumettre maxpwr global = 0 (settings_leds.htm:164).
        const omax = Number(u.omax);
        ins.push({ ...base, pin: pins, type: Number.isFinite(type) ? type : (base.type ?? 22), order: (highNib << 4) | lowNib, start, len, rev: !!u.rev, skip: Math.max(0, Number(u.skip) || 0), ledma: Number.isFinite(ledma) && ledma >= 0 ? ledma : (base.ledma ?? 55), ref: !!u.ref,
          ...(Number.isFinite(omax) && omax >= 0 ? { maxpwr: Math.min(65000, Math.round(omax)) } : {}) });
      }
      try {
        await postJson(ip, '/json/cfg', { hw: { led: { ins } } }, 8000);
        recordChange(rec, 'outputs', rec.derived.outputs, ins.map(x => `${x.pin.join('/')}:${x.start}+${x.len}`).join(' | '), 'grille');
        // Les métadonnées Fleet APRÈS les réglages, jamais avant : si l'écriture
        // du fichier échoue, le node porte des réglages sans marqueur — gênant
        // mais honnête. Dans l'autre sens il revendiquerait un produit dont il
        // n'a pas les réglages, ce qui est un mensonge durable.
        let metaWarn = '';
        if (Array.isArray(b.meta)) {
          try { await writeNodeMeta(rec, b.meta, ins); }
          catch (e) { metaWarn = `réglages écrits, mais métadonnées non enregistrées : ${e.message}`; }
        }
        rec.meta.cfgUpdated = 0; await pollInfoState(rec, 'grille');
        return send(res, 200, { ok: true, outputs: rec.derived.outputs, total: rec.info && rec.info.leds && rec.info.leds.count, warn: metaWarn });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Aligne le nom mDNS et le SSID du point d'accès du node sur son nom
    // (ou sur un nouveau nom). Demande un redémarrage du node.
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
    // @api Fait clignoter le node quelques secondes pour le repérer
    // physiquement, puis remet son état d'origine.
    if ((m = /^\/api\/node\/([^/]+)\/identify$/.exec(p)) && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await identifyNode(decodeURIComponent(m[1]), Math.min(15000, Math.max(500, Number(b.ms) || 3000)))); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Repérage d'un pixel : allonge temporairement la sortie à son
    // maximum et éclaire trois zones (avant, marqueur, après) pour compter
    // sur le ruban. La longueur d'origine est toujours rétablie à l'arrêt.
    if ((m = /^\/api\/node\/([^/]+)\/locate-pixel$/.exec(p)) && req.method === 'POST') {
      // real hw.led.ins length change (see setLocatePixel), always restored on stop —
      // still refused in lecture seule like any other write to a node's config
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]);
      const b = await readBody(req);
      const index = Number(b.index), len = Number(b.len);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(len) || len < 1) return send(res, 400, { error: 'sortie invalide' });
      const opts = { hi: b.hi, lo: b.lo, over: b.over, bri: b.bri, probe: b.probe };
      try { return send(res, 200, await setLocatePixel(ip, index, len, !!b.rev, opts)); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Arrête le repérage et rétablit la longueur et l'état d'origine de
    // la sortie.
    if ((m = /^\/api\/node\/([^/]+)\/locate-pixel$/.exec(p)) && req.method === 'DELETE') {
      try { return send(res, 200, await stopLocatePixel(decodeURIComponent(m[1]))); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Change l'adresse IP de plusieurs nodes d'un coup, échanges et
    // rotations compris : toutes les écritures d'abord, tous les redémarrages
    // ensuite.
    if (p === '/api/nodes/relocate' && req.method === 'POST') {
      // several IP changes at once (swaps / rotations allowed): write all, reboot all
      const b = await readBody(req);
      if (!Array.isArray(b.moves) || !b.moves.length) return send(res, 400, { error: 'aucun déplacement' });
      try { return send(res, 200, await relocateBatch(b.moves)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Change l'adresse IP fixe d'un node, puis le redémarre.
    if ((m = /^\/api\/node\/([^/]+)\/relocate$/.exec(p)) && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await relocateNode(decodeURIComponent(m[1]), b)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Réglages du serveur : le fichier settings.json, les valeurs
    // effectives (sous-réseaux, écoute, intervalles, lecture seule) et l'état
    // réseau du poste.
    if (p === '/api/settings' && req.method === 'GET') {
      return send(res, 200, {
        file: SETTINGS_FILE, settings,
        effective: { subnet: SUBNETS ? SUBNETS.join(',') : '', listen: LISTEN, interval: INTERVAL, cfgInterval: CFG_INTERVAL, readonly: READONLY, otaParallel },
        net: netStatus(), launcher: !!process.env.WLED_FLEET_LAUNCHER,
      });
    }
    // @api Valide et écrit settings.json, puis redémarre le serveur par le
    // lanceur pour que tout soit relu.
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
    // @api Ouvre une URL dans le navigateur du système. La fenêtre native ne
    // sait pas ouvrir d'onglet elle-même.
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
    // @api Version de l'application, version de Node, dossiers de code et de
    // données, PID et temps de fonctionnement.
    if (p === '/api/about') return send(res, 200, { version: APP_VERSION, node: process.version, dir: CODE_DIR, dataDir: DATA_DIR, settingsFile: SETTINGS_FILE, settings, launcher: !!process.env.WLED_FLEET_LAUNCHER, pid: process.pid, uptime: Math.round(process.uptime()) });
    // @api Redémarre le serveur pour relire les fichiers source. Refusé si le
    // serveur n'a pas été lancé par le lanceur.
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
    // @api Exporte un showfile : groupes, sorties non câblées, les trois
    // bibliothèques, le plan d'alimentation, les métadonnées des nodes et les
    // réglages retenus. Jamais de secrets.
    if (p === '/api/showfile' && req.method === 'POST') {
      const b = await readBody(req);
      const inc = b.include || {};
      const doc = {
        // v2 : ajout de `drivers`, `psus` et `powerPlan`. Purement additif — un
        // Fleet antérieur ignore ces clés et lit le reste comme avant, un Fleet
        // récent trouve simplement un plan vide dans un showfile v1.
        format: 'wledfleet-showfile', formatVersion: 2, app: APP_VERSION, exportedAt: new Date().toISOString(),
        // `library` porte le catalogue complet (avec ses identifiants) ;
        // `ledProfiles` reste pour qu'une version antérieure sache encore lire
        // ce showfile.
        settings, antennas: ap.exportStore(), knownNodes: knownEntries(), groups: declaredGroups,
        library: libraryStore, ledProfiles: legacyProfiles(),
        // Les modèles voyagent avec le montage : sans eux, un showfile rouvert
        // sur un autre poste désigne des drivers et des alims que ce poste ne
        // connaît pas, et le rapport de cohérence ne conclut plus rien.
        drivers: driverStore, psus: psuStore,
        // Le plan, lui, n'existe QUE là : « Alim jardin » ne veut rien dire dans
        // le dépôt partagé, donc le showfile est son seul véhicule.
        powerPlan,
        snapshots: snapshots.list().map(s => { try { return snapshots.load(s.id); } catch { return null; } }).filter(Boolean),
        firmwareIndex: (() => { try { return JSON.parse(fs.readFileSync(dataFile('firmware', 'index.json'), 'utf8')); } catch { return null; } })(),
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
    // @api Importe un showfile. Les identifiants des fiches — produits,
    // drivers, alimentations — et leurs révisions sont conservés tels quels,
    // sinon les marqueurs déjà posés sur les nodes désigneraient autre chose.
    // Les catalogues et le plan d'alimentation sont FUSIONNÉS, jamais
    // remplacés : importer le showfile d'un autre plateau n'efface rien d'ici.
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
        // La bibliothèque est fusionnée en HONORANT les identifiants. C'est la
        // régression que ça corrige : l'ancien import passait par upsertProfile,
        // qui ignorait l'id reçu et en réattribuait un — les nodes du showfile
        // gardaient alors des marqueurs qui, sur ce poste, désignaient un autre
        // produit.
        const incoming = doc.library ? library.normStore(doc.library).products : library.migrate(doc.ledProfiles || []).products;
        for (const p of incoming) {
          try { libraryStore = library.upsert(libraryStore, p).store; } catch { /* produit illisible : ignoré */ }
        }
        if (incoming.length) { saveLibrary(); done.push(`${incoming.length} produit(s) LED`); }
        // Drivers et alimentations : même règle que les produits, et pour la
        // même raison — les nodes de ce showfile portent leurs uid.
        for (const kind of ['drivers', 'psus']) {
          const c = CATS[kind];
          let n = 0;
          for (const it of (doc[kind] ? c.cat.normStore(doc[kind])[c.collection] : [])) {
            try { c.store = c.cat.upsert(c.store, it).store; n++; } catch { /* fiche illisible : ignorée */ }
          }
          if (n) { saveKind(kind); done.push(`${n} ${kind === 'drivers' ? 'driver(s)' : 'alimentation(s)'}`); }
        }
        // Le plan d'alimentation est fusionné exemplaire par exemplaire, pas
        // remplacé : importer le showfile d'un autre plateau ne doit pas faire
        // disparaître les alims déjà décrites ici.
        if (doc.powerPlan) {
          let n = 0;
          for (const inst of power.normPlan(doc.powerPlan).psus) {
            try { powerPlan = power.planUpsert(powerPlan, inst, require('crypto').randomUUID()).plan; n++; } catch { /* ignorée */ }
          }
          if (n) { savePlan(); done.push(`${n} alimentation(s) du plateau`); }
        }
        for (const e of doc.knownNodes) { const ip = typeof e === 'string' ? e : e.ip; if (!ip) continue; const r = addNode(ip); if (e.info && !r.info) { r.info = e.info; r.state = e.state || null; r.cfg = e.cfg || null; r.meta.lastSeen = e.lastSeen || null; r.meta.fails = 2; } if (typeof e.group === 'string' && e.group) r.meta.group = e.group; if (Array.isArray(e.ignoredOutputs)) r.meta.ignoredOutputs = e.ignoredOutputs; derive(r); }
        saveKnown(); pollAll(); done.push(`${doc.knownNodes.length} node(s)`);
      }
      if (what.snapshots && Array.isArray(doc.snapshots)) { let n = 0; for (const s of doc.snapshots) { try { snapshots.importFile(Buffer.from(JSON.stringify(s)), (s.name || s.id || 'snapshot') + '.json'); n++; } catch { /* skip bad one */ } } done.push(`${n} sauvegarde(s)`); }
      if (what.firmware && doc.firmwareIndex) { try { fs.mkdirSync(dataFile('firmware'), { recursive: true }); fs.writeFileSync(dataFile('firmware', 'index.json'), JSON.stringify(doc.firmwareIndex, null, 2)); done.push('catalogue firmware'); } catch { /* ignore */ } }
      let restart = false;
      if (what.settings && doc.settings) { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(doc.settings, null, 2) + '\n'); done.push('réglages'); restart = !!process.env.WLED_FLEET_LAUNCHER; } catch { /* ignore */ } }
      recordChangeFleet(`showfile importé : ${done.join(', ')}`);
      send(res, 200, { ok: true, done, layout: doc.layout || null, restarting: restart, exportedAt: doc.exportedAt, app: doc.app });
      if (restart) setTimeout(() => process.exit(RESTART_EXIT_CODE), 800);
      return;
    }
    // (supprimé 2026-09-08) POST /api/node/:ip/align-outputs — « ≡ univers entiers ».
    // Il écrivait sur le node dès la confirmation alors que ⚡ Autopatch, qui calculait la
    // même chose, se contentait de remplir les champs : deux chemins pour un seul geste,
    // dont un qui court-circuitait « Enregistrer les modifications ». Tout passe désormais
    // par ⚡ Patcher côté page (stratégie « une sortie = un univers »), donc par le bouton
    // Enregistrer, avec le récapitulatif des nodes touchés avant écriture.
    // ── Bibliothèque de produits LED ──────────────────────────────────────
    // Remplace /api/led-profiles : identité structurée, tous les réglages du
    // produit, plusieurs longueurs types, et des identifiants qui ne bougent
    // plus (voir library.js).
    // ── La chaîne électrique ──────────────────────────────────────────────
    // @api Le rapport de cohérence électrique : pour chaque alimentation posée
    // sur le plateau, sa capacité, la somme des budgets des nodes qu'elle
    // nourrit, et les constats. Plus les nodes rattachés à rien — la seule
    // liste que personne ne peut produire autrement. Les seuils et
    // l'arithmétique de l'ABL sont dans power.js, vérifiés dans le firmware.
    if (p === '/api/power' && req.method === 'GET') {
      return send(res, 200, { ...powerAudit(), plan: powerPlan, catalogue: psuStore.psus, drivers: driverStore.drivers });
    }
    // @api Crée ou met à jour un EXEMPLAIRE d'alimentation : son libellé, le
    // modèle du catalogue qu'il suit, et où il se trouve. Propre au spectacle —
    // « Alim jardin » ne veut rien dire sur un autre poste — donc jamais publié
    // dans le dépôt partagé, mais présent dans le showfile.
    if (p === '/api/power/psu' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try {
        const r = power.planUpsert(powerPlan, b, require('crypto').randomUUID());
        powerPlan = r.plan; savePlan();
        return send(res, 200, { ok: true, psu: r.psu, plan: powerPlan });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Retire un exemplaire d'alimentation. Les nodes qui le désignent sont
    // renvoyés : c'est à l'utilisateur de les rattacher ailleurs, on ne les
    // détache pas d'autorité.
    if ((m = /^\/api\/power\/psu\/([0-9a-z][0-9a-z-]{1,39})$/.exec(p)) && req.method === 'DELETE') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const orphelins = [...fleet.values()]
        .filter(r => r.meta.nodeMeta && r.meta.nodeMeta.power && r.meta.nodeMeta.power.psu === m[1])
        .map(r => ({ ip: r.meta.ip, name: (r.info && r.info.name) || r.meta.ip }));
      try { powerPlan = power.planRemove(powerPlan, m[1]); savePlan(); return send(res, 200, { ok: true, plan: powerPlan, orphelins }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Rattache un node : quelle alimentation le nourrit, sur quel rail, et
    // quelle carte il est. Écrit dans son /fleet.json, donc le node se raconte
    // ensuite tout seul — y compris sur un autre poste.
    if ((m = /^\/api\/node\/([^/]+)\/power$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const rec = fleet.get(decodeURIComponent(m[1])); if (!rec) return send(res, 404, { error: 'node inconnu' });
      if (!rec.meta.online) return send(res, 409, { error: 'node hors ligne' });
      const b = await readBody(req);
      try { await writeNodePower(rec, b); return send(res, 200, { ok: true, power: rec.meta.nodeMeta.power }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    // ── Drivers et alimentations ──────────────────────────────────────────
    // Même mécanique que les produits (catalog.js) : uuid stable, révisions,
    // retrait sans effacement. Le travail est fait par catView / catUpsert /
    // catRetire ; les routes restent écrites une par une pour que chaque point
    // d'entrée soit visible dans docs/api.md, et non caché derrière une boucle.
    //
    // @api Catalogue de cartes : pour chaque modèle, son brochage, ses tensions
    // d'entrée et ses courants admissibles, plus la liste des nodes qui le
    // déclarent. Sert à dire si un budget de courant est réaliste pour ce
    // matériel — ce que le node lui-même ne sait pas.
    if (p === '/api/drivers' && req.method === 'GET') return send(res, 200, catView('drivers'));
    // @api Propose une fiche de carte par modèle distinct reconnu dans la
    // flotte, d'après la puce, la variante de build, le type d'Ethernet et le
    // brochage. Rien n'est créé : les écarts à l'intérieur d'un groupe sont
    // rendus pour que l'utilisateur tranche, et les caractéristiques
    // électriques restent à saisir — elles ne sont nulle part sur un node.
    if (p === '/api/drivers/guess' && req.method === 'GET') {
      const vus = [];
      for (const rec of fleet.values()) {
        const i = rec.info || {}, cfg = rec.cfg || {};
        const ins = ((cfg.hw && cfg.hw.led && cfg.hw.led.ins) || []).filter(Boolean);
        vus.push({
          ip: rec.meta.ip, name: i.name || rec.meta.ip,
          arch: i.arch, release: i.release, brand: i.brand, product: i.product,
          eth: (cfg.eth || {}).type,
          outputs: ins.map(o => o.pin || []),
        });
      }
      const cands = drivers.guess(vus);
      // ce qui correspond déjà à une fiche du catalogue n'a pas à être reproposé
      const connus = driverStore.drivers.filter(x => !x.retired)
        .map(x => [x.board.mcu, x.board.release, x.board.outputs, x.board.pins.map(pp => pp.gpio.join('/')).sort().join(',')].join('|'));
      return send(res, 200, { candidates: cands.filter(c => !connus.includes(c.key)), nodes: vus.length });
    }
    // @api Crée ou met à jour une carte. L'uid est frappé à la création et ne
    // change jamais ; la révision monte quand le matériel change, pas quand on
    // corrige le nom.
    if (p === '/api/drivers/item' && req.method === 'POST') return catUpsert(res, 'drivers', await readBody(req));
    // @api Retire une carte. Marquée retirée — jamais effacée — dès qu'un node
    // la déclare, pour que son marqueur garde un sens.
    if ((m = /^\/api\/drivers\/item\/([0-9a-z][0-9a-z-]{1,39})$/.exec(p)) && req.method === 'DELETE') return catRetire(res, 'drivers', m[1]);
    // @api Catalogue d'alimentations : tension, ampères et watts (liés par la
    // tension), rails, taux d'usage conseillé, plus les nodes rattachés. Décrit
    // un MODÈLE, jamais un exemplaire — l'exemplaire vit sur le node.
    if (p === '/api/psus' && req.method === 'GET') return send(res, 200, catView('psus'));
    // @api Crée ou met à jour une alimentation. Ampères et watts sont
    // réconciliés par la tension ; `basis` retient lequel a été saisi, pour que
    // changer la tension sache quelle grandeur tenir constante.
    if (p === '/api/psus/item' && req.method === 'POST') return catUpsert(res, 'psus', await readBody(req));
    // @api Retire une alimentation, selon les mêmes règles que les cartes.
    if ((m = /^\/api\/psus\/item\/([0-9a-z][0-9a-z-]{1,39})$/.exec(p)) && req.method === 'DELETE') return catRetire(res, 'psus', m[1]);
    // @api Catalogue de produits LED, avec pour chaque produit le relevé des
    // sorties qui l'utilisent et l'état de leur révision (à jour, en retard,
    // en avance, inconnue).
    if (p === '/api/library' && req.method === 'GET') {
      const { LED_TYPES, COLOR_ORDERS, WHITE_SWAPS, WHITE_SWAP_TYPES, LED_MA_PRESETS, LED_MA_MAX, PSU_MA_MIN, PSU_MA_MAX, MA_FOR_ESP } = require('./columns');
      return send(res, 200, { ...libraryStore, usage: productUsage(), ledTypes: LED_TYPES, colorOrders: COLOR_ORDERS, whiteSwaps: WHITE_SWAPS, whiteSwapTypes: WHITE_SWAP_TYPES, ledMaPresets: LED_MA_PRESETS, ledMaMax: LED_MA_MAX, psuMaMin: PSU_MA_MIN, psuMaMax: PSU_MA_MAX, maForEsp: MA_FOR_ESP, readonly: READONLY });
    }
    // @api Crée ou met à jour un produit. L'uid est frappé à la création et
    // ne change jamais ; la révision monte quand les réglages changent, pas
    // quand le nom change.
    if (p === '/api/library/product' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' }); // manquait sur /api/led-profiles
      const b = await readBody(req);
      try { const r = library.upsert(libraryStore, { ...b, updatedBy: ghConf.login || b.updatedBy || '' }); libraryStore = r.store; saveLibrary(); autoSyncSoon(); return send(res, 200, { ok: true, product: r.product, ...libraryStore }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Retire un produit. Il est marqué retiré — jamais effacé — dès
    // qu'une sortie de la flotte le référence, pour que son marqueur garde un
    // sens.
    if ((m = /^\/api\/library\/product\/([0-9a-z][0-9a-z-]{1,39})$/.exec(p)) && req.method === 'DELETE') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      // par identifiant, pas par nom : l'ancien DELETE indexait par nom sensible
      // à la casse alors que l'upsert dédoublonnait sans casse
      try {
        const prod = library.resolve(libraryStore, m[1]);
        // un produit qu'aucune sortie n'utilise et qui n'a jamais été publié
        // peut disparaître pour de bon ; les autres sont seulement marqués
        // retirés, sinon les marqueurs déjà posés ne désignent plus rien
        const purge = prod ? !(productUsage()[prod.uid] || []).length : false;
        libraryStore = library.retire(libraryStore, m[1], { purge });
        saveLibrary();
        return send(res, 200, { ok: true, purged: purge, ...libraryStore });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // compatibilité : l'ancien point d'entrée, le temps qu'un showfile ancien passe
    // @api État du dépôt partagé : quel dépôt, quelle branche, si un jeton est
    // enregistré (ses 4 derniers caractères seulement, JAMAIS le jeton), la
    // dernière synchronisation et le nombre de produits pas encore publiés.
    if (p === '/api/library/remote' && req.method === 'GET') return send(res, 200, githubView());
    // @api Enregistre le dépôt partagé, la branche, et la façon de
    // s'authentifier. Un jeton saisi à la main n'est jamais renvoyé ensuite ;
    // envoyer une chaîne vide l'efface.
    if (p === '/api/library/remote' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      if (b.repo !== undefined) ghConf.repo = String(b.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      if (b.branch !== undefined) ghConf.branch = String(b.branch || 'main').trim() || 'main';
      if (b.source !== undefined) ghConf.source = b.source === 'token' ? 'token' : 'gh';
      if (b.token !== undefined) { ghConf.token = String(b.token || '').trim(); if (ghConf.token) ghConf.source = 'token'; }
      if (b.auto !== undefined) ghConf.auto = !!b.auto;
      if (ghConf.repo && !/^[\w.-]+\/[\w.-]+$/.test(ghConf.repo)) return send(res, 400, { error: 'dépôt attendu sous la forme « proprietaire/depot »' });
      ghConf.lastError = ''; saveGithub(); startAutoSync();
      return send(res, 200, githubView());
    }
    // @api Démarre la connexion GitHub. Renvoie un code court et l'adresse où
    // le saisir : c'est le « device flow », qui ne demande aucun logiciel
    // extérieur ni aucun secret embarqué. La connexion est ensuite gardée, y
    // compris après une mise à jour de l'application.
    if (p === '/api/library/login/start' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      try {
        const d = await github.deviceStart(ghClientId());
        ghDevice = { ...d, startedAt: Date.now() };
        return send(res, 200, { userCode: d.userCode, url: d.url, expiresIn: d.expiresIn, interval: d.interval });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Interroge l'avancement de la connexion. Répond `pending` tant que le
    // code n'a pas été validé sur github.com — ce n'est pas une erreur, c'est
    // l'attente normale.
    if (p === '/api/library/login/poll' && req.method === 'POST') {
      if (!ghDevice) return send(res, 409, { error: 'aucune connexion en cours' });
      try {
        const r = await github.devicePoll(ghClientId(), ghDevice.deviceCode);
        if (r.pending) return send(res, 200, { pending: true, ...(r.slowDown ? { interval: r.slowDown } : {}) });
        const me = await github.whoami(r.token);
        ghLoggedIn(r.token, me.login, 'device');
        return send(res, 200, { ok: true, ...githubView() });
      } catch (e) { ghDevice = null; return send(res, 502, { error: e.message }); }
    }
    // @api Se déconnecte : le jeton gardé est effacé. Le dépôt et les réglages
    // restent, seule l'identité s'en va.
    if (p === '/api/library/logout' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      ghConf.token = ''; ghConf.login = ''; ghConf.lastError = ''; ghDevice = null;
      saveGithub(); return send(res, 200, githubView());
    }
    // @api Se connecte par GitHub CLI, quand il est installé : Fleet lui
    // demande son jeton au moment de s'en servir et n'en stocke aucun. Voie
    // secondaire — la connexion normale ne dépend d'aucun logiciel extérieur.
    if (p === '/api/library/login/cli' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      try {
        const me = await github.whoami(ghCliToken());
        ghLoggedIn('', me.login, 'gh');
        return send(res, 200, { ok: true, ...githubView() });
      } catch (e) {
        return send(res, 409, { error: `${e.message}. Installer GitHub CLI (https://cli.github.com) puis lancer « gh auth login », ou utiliser la connexion normale.` });
      }
    }
    // @api Tire le dépôt partagé (jamais destructif), les trois catalogues.
    // Une fiche modifiée localement et pas encore publiée n'est PAS écrasée :
    // elle est signalée comme divergente, à publier — c'est la publication qui
    // saura se replacer au-dessus de la version en ligne.
    if (p === '/api/library/pull' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      if (!ghConf.repo) return send(res, 400, { error: 'aucun dépôt partagé configuré' });
      try {
        const stores = { products: libraryStore, drivers: driverStore, psus: psuStore };
        const r = await github.pull(ghConf.repo, stores, { token: ghToken(), branch: ghConf.branch });
        const added = [], updated = [], kept = [], touched = new Set();
        for (const remote of r.fetched) {
          const c = CATS[remote.kind]; if (!c) continue;      // type inconnu : laissé au dépôt
          const norm = x => c.cat.catalog.normOne(x);
          const mine = c.cat.resolve(c.store, remote.uid);
          if (!mine) { c.store[c.collection].push(norm({ ...remote, dirty: false })); added.push(c.cat.label(remote)); touched.add(remote.kind); continue; }
          // une fiche retouchée ici et pas encore publiée ne se fait pas écraser
          // par le dépôt : ce serait perdre le travail local sans un mot
          if (mine.dirty && c.cat.substance(mine) !== c.cat.substance(remote)) { kept.push(c.cat.label(mine)); continue; }
          Object.assign(mine, norm({ ...remote, dirty: false }));
          updated.push(c.cat.label(remote)); touched.add(remote.kind);
        }
        for (const kind of touched) { CATS[kind].store = CATS[kind].cat.normStore(CATS[kind].store); saveKind(kind); }
        ghConf.lastSyncAt = Date.now(); ghConf.lastError = ''; saveGithub();
        if (added.length || updated.length) recordChangeFleet(`bibliothèques : ${added.length} fiche(s) ajoutée(s), ${updated.length} mise(s) à jour depuis ${ghConf.repo}`);
        return send(res, 200, { ok: true, added, updated, kept, unchanged: r.unchanged.length, ...githubView() });
      } catch (e) { ghConf.lastError = e.message; saveGithub(); return send(res, 502, { error: e.message }); }
    }
    // @api Publie vers le dépôt partagé : une fiche si `uid` est donné (dans le
    // catalogue `kind`, produits par défaut), sinon tout ce qui a changé
    // localement dans les trois. Rien n'est jamais écrasé — sur collision, la
    // version en ligne devient la base et la nôtre repart au-dessus, de sorte
    // qu'aucun numéro de révision ne désigne deux contenus.
    if (p === '/api/library/publish' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      if (!ghConf.repo) return send(res, 400, { error: 'aucun dépôt partagé configuré' });
      if (!ghHasAuth()) return send(res, 400, { error: 'pas connecté à GitHub : la publication demande un droit d\'écriture' });
      const b = await readBody(req);
      const kinds = b.kind && CATS[b.kind] ? [b.kind] : Object.keys(CATS);
      const todo = [];
      for (const kind of kinds) {
        const c = CATS[kind];
        const items = b.uid ? [c.cat.resolve(c.store, b.uid)].filter(Boolean)
          : c.store[c.collection].filter(x => x.dirty && !x.retired);
        for (const item of items) todo.push({ kind, c, item });
      }
      if (!todo.length) return send(res, 200, { ok: true, done: [], note: 'rien à publier' });
      const done = [], failed = [], touched = new Set();
      for (const { kind, c, item } of todo) {
        try {
          const r = await github.publish(ghConf.repo, item, { token: ghToken(), branch: ghConf.branch, space: kind });
          // ce que le dépôt a accepté fait foi : on s'aligne dessus, y compris
          // quand notre révision a été replacée au-dessus d'une autre
          Object.assign(item, c.cat.catalog.normOne({ ...r.product, origin: 'library', dirty: false }), { blobSha: r.sha || null });
          done.push({ uid: item.uid, kind, label: c.cat.label(item), action: r.action, rev: item.rev });
          touched.add(kind);
        } catch (e) { failed.push({ uid: item.uid, kind, label: c.cat.label(item), error: e.message }); }
      }
      for (const kind of touched) { CATS[kind].store = CATS[kind].cat.normStore(CATS[kind].store); saveKind(kind); }
      ghConf.lastSyncAt = Date.now(); ghConf.lastError = failed.length ? failed[0].error : ''; saveGithub();
      const rebased = done.filter(x => x.action === 'rebase');
      if (done.length) recordChangeFleet(`bibliothèques : ${done.length} fiche(s) publiée(s) vers ${ghConf.repo}${rebased.length ? `, dont ${rebased.length} replacée(s) au-dessus d'une version en ligne` : ''}`);
      return send(res, failed.length && !done.length ? 502 : 200, { ok: !failed.length, done, failed, ...githubView() });
    }
    // @api Ce que les nodes portent de la bibliothèque : chaque node cite les
    // produits de ses sorties, avec leur fiche complète et leur révision. Le
    // rapprochement dit, produit par produit, si le node est à jour, en retard,
    // en avance, inconnu de ce poste, ou divergent — même révision, réglages
    // différents, deux postes hors ligne ayant fait monter le même numéro.
    if (p === '/api/library/nodes' && req.method === 'GET') {
      const nodes = [];
      for (const rec of fleet.values()) {
        const slice = rec.meta.nodeLib; if (!slice) continue;
        const items = library.compareNodeSlice(libraryStore, slice).filter(x => x.state !== 'same');
        if (items.length) nodes.push({ ip: rec.meta.ip, name: (rec.info && rec.info.name) || rec.meta.ip, online: !!rec.meta.online, savedAt: slice.savedAt, items });
      }
      return send(res, 200, { nodes });
    }
    // @api Récupère dans le catalogue local un produit porté par un node —
    // celui d'un node revenu d'ailleurs, ou d'un poste dont la bibliothèque
    // était en avance. Jamais automatique : recopier sans demander effacerait
    // silencieusement la version locale.
    if (p === '/api/library/adopt' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      const rec = fleet.get(String(b.ip || '')); if (!rec) return send(res, 404, { error: 'node inconnu' });
      const slice = rec.meta.nodeLib; if (!slice) return send(res, 404, { error: 'ce node ne porte pas de bibliothèque' });
      const np = slice.products.find(x => x.uid === b.uid);
      if (!np) return send(res, 404, { error: 'produit absent de la copie de ce node' });
      try {
        // l'uid ET la révision sont repris tels quels : adopter, ce n'est pas
        // créer une version de plus, c'est se mettre au niveau du node
        const mine = library.resolve(libraryStore, np.uid);
        const r = library.upsert(libraryStore, { ...np, rev: Math.max(np.rev, mine ? mine.rev : 0) });
        // upsert incrémente quand les réglages diffèrent : on remet la révision
        // du node, sinon ce poste repartirait aussitôt « en avance » sur lui
        r.product.rev = np.rev;
        libraryStore = r.store; saveLibrary();
        recordChangeFleet(`produit « ${library.label(np)} » (rev ${np.rev}) repris depuis ${(rec.info && rec.info.name) || rec.meta.ip}`);
        return send(res, 200, { ok: true, product: r.product });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Ancienne forme du catalogue, à plat. Conservée le temps qu'un
    // showfile ancien passe ; utiliser /api/library.
    if (p === '/api/led-profiles' && req.method === 'GET') return send(res, 200, { profiles: legacyProfiles() });

    // ── Métadonnées d'un node (/fleet.json) ───────────────────────────────
    // @api Métadonnées Fleet lues sur le node (/fleet.json), et la dernière
    // copie non vide qu'en a gardée Fleet.
    if ((m = /^\/api\/node\/([^/]+)\/meta$/.exec(p)) && req.method === 'GET') {
      const rec = fleet.get(decodeURIComponent(m[1])); if (!rec) return send(res, 404, { error: 'node inconnu' });
      return send(res, 200, { meta: rec.meta.nodeMeta || metadata.empty(), saved: rec.meta.nodeMetaSeen || null });
    }
    // écrire seulement les métadonnées, sans toucher aux sorties : c'est le cas
    // quand on n'a changé qu'un numéro de fixture. Renvoyer tout hw.led.ins
    // ferait reconstruire les bus par WLED pour rien.
    // @api Écrit les métadonnées Fleet du node sans toucher à sa
    // configuration LED. Fusionne : les clés inconnues et les sorties non
    // citées sont conservées.
    if ((m = /^\/api\/node\/([^/]+)\/meta$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      if (!rec.meta.online) return send(res, 409, { error: 'node hors ligne' });
      const b = await readBody(req);
      if (!Array.isArray(b.outputs)) return send(res, 400, { error: 'liste de sorties attendue' });
      const ins = (rec.cfg && rec.cfg.hw && rec.cfg.hw.led && rec.cfg.hw.led.ins) || [];
      try { await writeNodeMeta(rec, b.outputs, ins); return send(res, 200, { ok: true, meta: rec.meta.nodeMeta }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Repose les métadonnées sur un node revenu nu, à partir de la copie
    // gardée par Fleet. Ne fait rien si le node a encore les siennes.
    if ((m = /^\/api\/node\/([^/]+)\/meta\/restore$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const rec = fleet.get(decodeURIComponent(m[1])); if (!rec) return send(res, 404, { error: 'node inconnu' });
      if (!rec.meta.online) return send(res, 409, { error: 'node hors ligne' });
      const r = await restoreNodeMeta(rec, 'grille');
      return send(res, 200, { ok: r !== false, restored: r === true, reason: r === null ? 'rien à restaurer (le node a déjà ses métadonnées, ou Fleet n\'en a pas de copie)' : '' });
    }
    // @api Déclare un groupe, éventuellement vide, ou en renomme un — le
    // groupe est le topic MQTT de groupe, écrit sur chaque node concerné.
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
    // @api Oublie un groupe : ses nodes redeviennent sans groupe.
    if ((m = /^\/api\/groups\/([^/]+)$/.exec(p)) && req.method === 'DELETE') { // forget a group: its nodes become ungrouped
      const name = decodeURIComponent(m[1]); let n = 0; const skipped = [];
      for (const r of fleet.values()) if ((r.meta.group || '') === name) { try { await writeGroup(r, '', 'grille'); n++; } catch { skipped.push((r.info && r.info.name) || r.meta.ip); } }
      if (skipped.length) return send(res, 409, { error: `${skipped.length} node(s) hors ligne gardent le groupe (${skipped.join(', ')}) : le groupe est écrit sur le node`, ungrouped: n });
      declaredGroups = declaredGroups.filter(g => g !== name);
      recordChangeFleet(`groupe « ${name} » supprimé (${n} node(s) sans groupe)`);
      saveKnown(); return send(res, 200, { ok: true, groups: allGroups(), ungrouped: n });
    }
    // @api Change le groupe d'un node. C'est un champ WLED natif (topic MQTT
    // de groupe), écrit sur le node et recopié dans son enregistrement.
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
    // @api Ancien marqueur de produit par sortie, écrit dans le client id
    // MQTT. Conservé pour les nodes anciens ; les nouveaux passent par
    // /api/node/:ip/meta.
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
    // @api Déclare, par POSITION dans hw.led.ins, les sorties qui existent
    // dans WLED mais ne sont pas câblées. Elles ne réservent aucun canal et
    // ne peuvent donc pas créer de conflit.
    if ((m = /^\/api\/node\/([^/]+)\/outputs-ignore$/.exec(p)) && req.method === 'POST') {
      // Fleet-only flag: outputs (by POSITION in hw.led.ins) that exist in WLED but are not
      // physically used; the channels they'd occupy are not reserved, so they never raise a
      // conflict. `starts` (ancienne écriture par index de départ) est encore accepté.
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      const b = await readBody(req);
      const list = (Array.isArray(b.indexes) ? b.indexes : Array.isArray(b.starts) ? b.starts : []).map(Number).filter(Number.isFinite);
      let r; try { r = await writeIgnored(rec, list, 'grille'); } catch (e) { return send(res, rec.meta.online ? 502 : 409, { error: e.message }); }
      derive(rec); saveKnown();
      return send(res, 200, { ok: true, ignored: rec.meta.ignoredOutputs, queued: r === 'queued' });
    }
    // @api Applique à un node redevenu joignable les écritures mises en
    // attente pendant son absence.
    if ((m = /^\/api\/node\/([^/]+)\/offline-queue\/apply$/.exec(p)) && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      try { return send(res, 200, { ok: true, ...(await applyOfflineQueue(rec)) }); }
      catch (e) { return send(res, rec.meta.online ? 502 : 409, { error: e.message }); }
    }
    // @api Abandonne les écritures en attente pour ce node.
    if ((m = /^\/api\/node\/([^/]+)\/offline-queue\/discard$/.exec(p)) && req.method === 'POST') {
      const ip = decodeURIComponent(m[1]); const rec = fleet.get(ip);
      if (!rec) return send(res, 404, { error: 'node inconnu' });
      discardOfflineQueue(rec);
      return send(res, 200, { ok: true, group: rec.meta.group, ignored: rec.meta.ignoredOutputs, profiles: rec.meta.outputProfiles });
    }
    // @api Plan DMX de toute la flotte : pour chaque sortie l'univers et le
    // canal de son premier et de son dernier pixel, plus les conflits entre
    // nodes, détectés au canal près.
    if (p === '/api/dmx-plan' && req.method === 'GET') {
      // plan de toute la flotte + conflits entre nodes, au canal près (voir dmx.js)
      const nodes = [...fleet.values()].filter(r => r.derived && r.derived.dmx).map(r => ({ ip: r.meta.ip, name: r.info && r.info.name, group: r.meta.group || '', online: r.meta.online, live: r.info && r.info.live, lm: r.info && r.info.lm, lip: r.info && r.info.lip, plan: r.derived.dmx }));
      const conflicts = dmx.conflicts(nodes.map(n => ({ name: n.name || n.ip, plan: n.plan })));
      const inUse = [...new Set(nodes.flatMap(n => (n.plan.occupancy || []).map(iv => iv.u)))].sort((a, b) => a - b);
      return send(res, 200, { nodes: nodes.sort((a, b) => (a.plan.uni || 0) - (b.plan.uni || 0)), conflicts, universesInUse: inUse });
    }
    // @api Oublie les nodes vus pour la dernière fois il y a plus de N
    // heures.
    if (p === '/api/nodes/purge' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, { removed: purgeOffline(Number(b.olderThanH) || 0) });
    }
    // @api Liste des sauvegardes de flotte.
    if (p === '/api/snapshots' && req.method === 'GET') return send(res, 200, { snapshots: snapshots.list() });
    // @api Prend une sauvegarde de la flotte : config, presets et fichiers
    // Fleet de chaque node joignable.
    if (p === '/api/snapshots' && req.method === 'POST') {
      const { name } = await readBody(req);
      const r = await snapshots.capture(name, [...fleet.values()], getJson);
      recordChangeFleet(`sauvegarde « ${r.name} » : ${r.nodes} node(s)`);
      return send(res, 200, r);
    }
    // @api Importe un fichier de sauvegarde produit ailleurs.
    if (p === '/api/snapshots/import' && req.method === 'POST') {
      const name = String(req.headers['x-filename'] || 'import.json');
      try { return send(res, 200, snapshots.importFile(await readRaw(req), name)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api GET lit une sauvegarde (`?download=1` pour la télécharger), DELETE
    // la supprime.
    if ((m = /^\/api\/snapshots\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        let snap; try { snap = snapshots.load(id); } catch (e) { return send(res, 404, { error: e.message }); }
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', `attachment; filename="wled-fleet_${id}.json"`);
        return send(res, 200, snap);
      }
      if (req.method === 'DELETE') { snapshots.remove(id); return send(res, 200, { ok: true }); }
    }
    // @api Compare une sauvegarde à l'état actuel de la flotte, colonne par
    // colonne.
    if ((m = /^\/api\/snapshots\/([^/]+)\/diff$/.exec(p)) && req.method === 'GET') {
      try { return send(res, 200, { nodes: snapshots.diff(snapshots.load(decodeURIComponent(m[1])), [...fleet.values()], columns) }); }
      catch (e) { return send(res, 404, { error: e.message }); }
    }
    // @api Restaure tout ou partie d'une sauvegarde sur les nodes choisis.
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
    // @api Vue de l'antenne : radios, clients associés, historique de scan,
    // et les constats qui demandent de croiser l'antenne avec la config des
    // nodes.
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
    // @api État de la sonde WiFi Bluetooth (WiFiman) et sa dernière lecture,
    // rapprochée du dernier scan de l'antenne.
    if (p === '/api/wizard' && req.method === 'GET') return send(res, 200, wizard.view(ap.lastScan()));
    // @api Liste les sondes Bluetooth à portée.
    if (p === '/api/wizard/devices' && req.method === 'GET') {
      try { return send(res, 200, { devices: await wizard.devices(Math.min(20, Math.max(2, Number(url.searchParams.get('timeout')) || 6))) }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Se connecte à une sonde WiFi Bluetooth.
    if (p === '/api/wizard/connect' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await wizard.start({ address: b.address, mock: !!b.mock, raw: !!b.raw })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Coupe la liaison avec la sonde.
    if (p === '/api/wizard/disconnect' && req.method === 'POST') return send(res, 200, { stopped: wizard.stop() });
    // @api Connecte ou déconnecte la sonde — le bouton unique du panneau.
    if (p === '/api/wizard/toggle' && req.method === 'POST') { // the one WiFiman button
      try { return send(res, 200, await wizard.toggle()); } catch (e) { return send(res, 400, { error: e.message, ...wizard.status() }); }
    }
    // @api Installe les dépendances de la sonde (bleak, et Python si absent).
    if (p === '/api/wizard/install' && req.method === 'POST') { // pip install bleak (and Python via winget if missing)
      try { return send(res, 200, await wizard.install()); } catch (e) { return send(res, 400, { error: e.message, ...wizard.status().deps }); }
    }
    // @api État des dépendances de la sonde. `?force=1` refait la
    // vérification.
    if (p === '/api/wizard/deps' && req.method === 'GET') return send(res, 200, await wizard.deps(url.searchParams.get('force') === '1'));
    // @api Enregistre un relevé de site à l'endroit courant, sous un libellé.
    if (p === '/api/wizard/survey' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, wizard.survey(b.label, { nearNode: b.nearNode })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Supprime un relevé de site, désigné par son horodatage.
    if (p === '/api/wizard/survey' && req.method === 'DELETE') { const b = await readBody(req); return send(res, 200, { left: wizard.removeSurvey(b.at) }); }
    // @api Les N derniers relevés de site.
    if (p === '/api/wizard/surveys' && req.method === 'GET') return send(res, 200, { surveys: wizard.surveys(Number(url.searchParams.get('n')) || 100) });
    // @api Historique des mesures en direct de la sonde.
    if (p === '/api/wizard/live' && req.method === 'GET') return send(res, 200, { live: wizard.liveHistory(Number(url.searchParams.get('n')) || 720) });
    // @api Cascade des canaux 2,4 GHz sur les N dernières lectures.
    if (p === '/api/wizard/waterfall' && req.method === 'GET') return send(res, 200, wizard.waterfall(Math.min(720, Number(url.searchParams.get('n')) || 360)));
    // @api Déclare près de quel node se trouve la sonde, pour rapporter ses
    // mesures à ce point.
    if (p === '/api/wizard/near' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, { nearNode: wizard.setNear(b.mac) }); }
    // @api Réglages de la sonde : activation, connexion automatique, chemin
    // de Python.
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
    // @api Lance un scan des canaux sur une radio de l'antenne. Perturbant
    // par nature — la radio quitte son canal quelques secondes — donc jamais
    // automatique.
    if (p === '/api/ap/scan' && req.method === 'POST') {
      // disruptive on purpose (radio leaves its channel for a few seconds); only on explicit user click
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try { return send(res, 200, await ap.scan(b.iface || 'wifi1', Math.min(15, Math.max(2, Number(b.duration) || 5)))); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Historique des scans de canaux.
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
    // @api Réglages recommandés pour une radio en configuration show,
    // comparés aux valeurs actuelles.
    if (p === '/api/ap/preset' && req.method === 'GET') {
      const iface = url.searchParams.get('iface') || 'wifi1';
      try {
        const cur = await ap.radioSettings(iface);
        const norm = v => v == null ? null : String(v).toLowerCase().replace(/\s+/g, '');
        const items = SHOW_PRESET.map(s => { const c = cur[s.key]; const ok = c == null ? (s.key === 'security.ft' || s.key === 'security.ft-over-ds' ? false : s.key === 'security.management-protection' || s.key === 'configuration.dtim-period' ? null : norm(c) === norm(s.want)) : norm(c) === norm(s.want); return { ...s, current: c, ok }; });
        return send(res, 200, { iface, items });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Applique les réglages recommandés cochés sur la radio.
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
    // @api Écrit le plan de canaux d'une radio de l'antenne, sur confirmation
    // explicite.
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
    // @api Réseaux WiFi vus par la carte du poste, avec l'état de
    // l'association. Les points d'accès WLED balisent lentement : ceux déjà
    // vus sont mémorisés pour ne pas disparaître d'un scan à l'autre.
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
    // @api Propose un nom et une adresse pour un node repéré par le SSID de
    // son point d'accès.
    if (p === '/api/pair/suggest' && req.method === 'GET') {
      return send(res, 200, await suggestFor(String(url.searchParams.get('ssid') || ''), new Set()));
    }
    // @api État du travail d'appairage en cours.
    if (p === '/api/pair/status' && req.method === 'GET') return send(res, 200, { job: provision.status() });
    // @api Appaire un node : le poste rejoint son point d'accès, écrit le
    // réseau du show (SSID et clé venus de l'antenne), puis revient.
    // /api/pair/test fait le même trajet sans rien écrire.
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
    // @api Lecture brute de RouterOS pour les audits. GET seulement, et
    // limité aux arbres interface, system, ip et routing.
    if (p === '/api/ap/raw' && req.method === 'GET') {
      // read-only passthrough to RouterOS (GET only, wifi/system/interface trees) for audits
      const rp = String(url.searchParams.get('path') || '');
      if (!/^\/(interface|system|ip\/(address|dhcp-server|neighbor)|routing)(\/|$)/.test(rp) || /\/(set|add|remove|enable|disable|scan|reset|reboot|upgrade)(\/|$)/.test(rp)) return send(res, 400, { error: 'chemin non autorisé (lecture seule)' });
      try { return send(res, 200, await ap.rest('GET', rp)); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    // @api Enregistre les identifiants de l'antenne saisis dans le panneau,
    // puis interroge l'antenne aussitôt.
    if (p === '/api/ap/config' && req.method === 'POST') {
      // credentials typed by the user in the Antenne panel -> ap.json, then poll right away
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      try { ap.saveConfig(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
      startApPolling();
      const st = await ap.poll(); fleet.forEach(derive);
      return send(res, st.ok ? 200 : 502, { ok: st.ok, error: st.error, host: ap.config().host });
    }
    // @api Choisit la carte réseau locale par laquelle joindre l'antenne
    // (REST et MNDP), quand Windows en préfère une autre.
    if (p === '/api/ap/bind' && req.method === 'POST') {
      // which local NIC to use to reach the antenna (REST + MNDP) — e.g. the PC
      // has an iPhone personal-hotspot adapter that Windows prefers over the
      // card actually wired/associated to the show's MikroTik
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      const addr = String(b.address || '').trim();
      if (addr && !localIfaces().some(i => i.address === addr)) return send(res, 400, { error: 'carte réseau inconnue' });
      ap.setBindAddress(addr);
      const st = await ap.poll(); fleet.forEach(derive);
      return send(res, 200, { ok: true, bindAddress: addr || null, apOk: st.ok, apError: st.error });
    }
    // @api Bascule sur une antenne dont les identifiants sont déjà
    // enregistrés.
    if (p === '/api/ap/connect' && req.method === 'POST') {
      // switch to an AP whose credentials are already saved (no password retyped)
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      try { ap.connect(b.host); } catch (e) { return send(res, 400, { error: e.message }); }
      startApPolling();
      const st = await ap.poll(); fleet.forEach(derive);
      return send(res, st.ok ? 200 : 502, { ok: st.ok, error: st.error, host: ap.config().host });
    }
    // @api Oublie une antenne et ses identifiants.
    if (p === '/api/ap/forget' && req.method === 'POST') {
      if (READONLY) return send(res, 403, { error: 'lecture seule' });
      const b = await readBody(req);
      ap.forget(b.host); startApPolling(); fleet.forEach(derive);
      return send(res, 200, { ok: true });
    }
    // ── firmware repository ──
    // @api Dépôt de firmwares : catalogue GitHub mémorisé, fichiers .bin déjà
    // téléchargés, et les plateformes réellement présentes dans la flotte.
    if (p === '/api/firmware' && req.method === 'GET') {
      const all = url.searchParams.get('all') === '1';
      const v = firmware.view(all ? null : envsInUse());
      v.envsInUse = [...envsInUse()];
      v.readonly = READONLY;
      v.otaParallel = otaParallel;
      v.nodes = [...fleet.values()].map(r => ({ ip: r.meta.ip, name: r.info && r.info.name, online: r.meta.online, fw: r.derived.fw, otaLock: !!(r.cfg && r.cfg.ota && r.cfg.ota.lock), ota: r.meta.ota }));
      return send(res, 200, v);
    }
    // @api Rafraîchit le catalogue des versions depuis GitHub.
    if (p === '/api/firmware/refresh' && req.method === 'POST') {
      try { await firmware.refresh(); } catch (e) { return send(res, 502, { error: `GitHub injoignable : ${e.message}` }); }
      fleet.forEach(derive);
      return send(res, 200, { ok: true, refreshedAt: firmware.catalogue().refreshedAt, releases: firmware.catalogue().releases.length });
    }
    // @api Télécharge un firmware dans le dépôt local. `forFleet` prend d'un
    // coup tous les fichiers de la version qui correspondent aux plateformes
    // présentes.
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
    // @api Supprime un firmware du dépôt local.
    if (p === '/api/firmware/delete' && req.method === 'POST') {
      const { tag, asset } = await readBody(req);
      firmware.remove(tag, asset); fleet.forEach(derive);
      return send(res, 200, { ok: true });
    }
    // @api Ajoute au dépôt local un firmware fourni à la main (nom du fichier
    // dans l'en-tête X-Filename).
    if (p === '/api/firmware/upload' && req.method === 'POST') {
      const name = path.basename(String(req.headers['x-filename'] || ''));
      const buf = await readRaw(req);
      try { firmware.addLocal(name, buf); } catch (e) { return send(res, 400, { error: e.message }); }
      fleet.forEach(derive);
      return send(res, 200, { ok: true, name, size: buf.length });
    }
    // @api Met un node à jour en OTA depuis le dépôt local, en file
    // d'attente.
    if ((m = /^\/api\/node\/([^/]+)\/update$/.exec(p)) && req.method === 'POST') {
      const { tag, asset, parallel } = await readBody(req);
      try { return send(res, 202, enqueueOta(decodeURIComponent(m[1]), tag, asset, parallel)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // @api Journal des changements observés sur la flotte depuis un
    // horodatage, qu'ils viennent de Fleet ou d'ailleurs.
    if (p === '/api/changes') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, { now: Date.now(), events: changes.filter(e => e.at > since).slice(-500) });
    }
    // @api Lance un balayage du ou des sous-réseaux à la recherche de nodes.
    if (p === '/api/scan' && req.method === 'POST') { scan(); return send(res, 202, { started: true }); }
    // @api Ajoute un node par son adresse, après avoir vérifié qu'il répond.
    if (p === '/api/nodes' && req.method === 'POST') {
      const { ip } = await readBody(req);
      if (!ip) return send(res, 400, { error: 'ip manquante' });
      if (!(await probe(ip))) return send(res, 404, { error: `${ip} ne répond pas comme un node WLED` });
      addNode(ip); saveKnown(); pollAll();
      return send(res, 200, { ok: true });
    }
    // @api Oublie un node : Fleet cesse de l'interroger et de l'afficher.
    // Rien n'est écrit sur le node.
    if ((m = /^\/api\/nodes\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      fleet.delete(decodeURIComponent(m[1])); saveKnown();
      return send(res, 200, { ok: true });
    }
    // @api GET renvoie la configuration WLED brute du node ; POST y applique
    // une modification partielle.
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
    // @api Écrit une seule cellule de la grille sur le node — le chemin de la
    // colonne et la valeur.
    if ((m = /^\/api\/node\/([^/]+)\/cell$/.exec(p)) && req.method === 'POST') {
      const { col, value } = await readBody(req);
      return send(res, 200, await writeCell(decodeURIComponent(m[1]), col, value));
    }
    // @api Redémarre le node.
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
loadGithub();
startAutoSync();
// la connexion gardée est vérifiée une fois, et le client_id rafraîchi
setTimeout(() => { checkGithubAuth(); refreshGithubApp(); }, 2000);
setInterval(refreshGithubApp, APP_MANIFEST_INTERVAL);
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
