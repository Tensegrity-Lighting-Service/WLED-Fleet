// Access-point side of the picture (roadmap Phase 3, monitoring only).
//
// Target: MikroTik RouterOS 7 with the `wifi` package (wAP ax, hAP ax, cAP ax…)
// through its REST API (HTTP basic auth, /rest/...). Nothing is written to the
// router: every call is a GET or a read-only `monitor` command.
//
// Two layers:
//   - discovery: MNDP (MikroTik Neighbor Discovery, UDP 5678) finds the router
//     without credentials -> identity, board, version, IP. Enough to tell the
//     user "there is a MikroTik at X, give me its credentials".
//   - status: with credentials (ap.json or --ap-* flags) we poll system
//     resource, wifi interfaces (+monitor) and the registration table, then
//     correlate registered clients with WLED nodes by MAC address.
'use strict';

const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

let CONFIG_FILE = path.join(__dirname, 'ap.json');
// dev/mock runs keep their credentials apart from the real antenna's ap.json
function setConfigFile(f) { CONFIG_FILE = path.isAbsolute(f) ? f : path.join(__dirname, f); }

// ── Config: one credential set PER AP, keyed by host ─────────────────────────
// ap.json = { "active": "192.168.88.1", "interval": 5000,
//             "aps": { "192.168.88.1": { "user": "admin", "pass": "…", "https": false }, … } }
// (a legacy flat { host, user, pass } file is migrated on load.)
let store = { active: null, interval: 5000, aps: {} };
let config = null; // the ACTIVE ap, flattened: { host, user, pass, https, interval }

function activate() {
  const h = store.active;
  const a = h && store.aps[h];
  config = a ? { host: h, user: a.user, pass: a.pass || '', https: !!a.https, interval: store.interval || 5000 } : null;
  status = { ok: false, error: '', updatedAt: null, system: null, radios: [], clients: [] };
  return config;
}
function persist() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2) + '\n'); }

function loadConfig(flags = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (raw.aps) store = { active: raw.active || null, interval: raw.interval || 5000, aps: raw.aps };
    else if (raw.host && raw.user) store = { active: raw.host, interval: raw.interval || 5000, aps: { [raw.host]: { user: raw.user, pass: raw.pass || '', https: !!raw.https } } }; // migrate legacy
  } catch { /* no file yet */ }
  if (flags.host && flags.user) { // CLI --ap/--ap-user/--ap-pass adds/updates that AP and makes it active
    store.aps[flags.host] = { user: flags.user, pass: flags.pass !== undefined ? flags.pass : (store.aps[flags.host] || {}).pass || '', https: !!(store.aps[flags.host] || {}).https };
    store.active = flags.host;
  } else if (flags.host && store.aps[flags.host]) store.active = flags.host;
  if (!store.active && Object.keys(store.aps).length) store.active = Object.keys(store.aps)[0];
  return activate();
}

// Save credentials typed in the UI (ap.json is git-ignored), for THIS AP, and connect to it.
function saveConfig(c) {
  if (!c || !c.host || !c.user) throw new Error('IP et utilisateur requis');
  const host = String(c.host).trim();
  store.aps[host] = { user: String(c.user).trim(), pass: String(c.pass || ''), https: !!c.https };
  store.active = host;
  if (c.interval) store.interval = Number(c.interval) || 5000;
  persist();
  return activate();
}

// Switch to an already-saved AP without retyping its password.
function connect(host) {
  if (!store.aps[host]) throw new Error('antenne non enregistrée : saisir ses identifiants');
  store.active = host; persist();
  return activate();
}
function forget(host) { delete store.aps[host]; if (store.active === host) store.active = Object.keys(store.aps)[0] || null; persist(); return activate(); }
// hosts with saved credentials, active first, never exposing the password
const savedAps = () => Object.keys(store.aps).map(h => ({ host: h, user: store.aps[h].user, active: h === store.active }));
// showfile support: the whole antenna store (WITH passwords) in and out
const exportStore = () => JSON.parse(JSON.stringify(store));
function importStore(s) {
  if (!s || typeof s !== 'object' || !s.aps) throw new Error('bloc antennes invalide');
  store = { active: s.active || Object.keys(s.aps)[0] || null, interval: s.interval || 5000, aps: s.aps };
  persist();
  return activate();
}

// ── MNDP discovery (no credentials) ──────────────────────────────────────────
const discovered = new Map(); // ip -> {mac, identity, version, platform, board, iface, ipv4, seenAt}
let mndpSocket = null;

function parseMndp(msg, rinfo) {
  let off = 4; const r = { from: rinfo.address, seenAt: Date.now() };
  while (off + 4 <= msg.length) {
    const t = msg.readUInt16BE(off), l = msg.readUInt16BE(off + 2);
    const v = msg.subarray(off + 4, off + 4 + l); off += 4 + l;
    if (t === 1 && l === 6) r.mac = [...v].map(b => b.toString(16).padStart(2, '0')).join(':');
    else if (t === 5) r.identity = v.toString();
    else if (t === 7) r.version = v.toString();
    else if (t === 8) r.platform = v.toString();
    else if (t === 12) r.board = v.toString();
    else if (t === 16) r.iface = v.toString();
    else if (t === 17 && l === 4) r.ipv4 = [...v].join('.');
  }
  if (r.identity || r.board) discovered.set(rinfo.address, r);
}

let broadcastList = [];
const setBroadcasts = list => { broadcastList = list; trigger(); };
const trigger = () => { if (!mndpSocket) return; for (const b of broadcastList) mndpSocket.send(Buffer.from([0, 0, 0, 0]), 5678, b, () => {}); };
function startDiscovery(broadcasts) {
  if (mndpSocket) return;
  broadcastList = broadcasts;
  try {
    mndpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true }); // bound on every interface: survives a card change
    mndpSocket.on('message', parseMndp);
    mndpSocket.on('error', e => { console.log(`MNDP: ${e.message}`); mndpSocket = null; });
    mndpSocket.bind(5678, () => { mndpSocket.setBroadcast(true); trigger(); setInterval(trigger, 30000); });
  } catch (e) { console.log(`MNDP indisponible: ${e.message}`); }
}

// ── RouterOS REST client ─────────────────────────────────────────────────────
function rest(method, p, body, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!config) return reject(new Error('antenne non configurée'));
    const [host, port] = String(config.host).split(':');
    const mod = config.https ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = mod.request({
      host, port: port ? +port : (config.https ? 443 : 80), method, path: '/rest' + p, timeout: timeoutMs, rejectUnauthorized: false,
      headers: { Authorization: 'Basic ' + Buffer.from(`${config.user}:${config.pass || ''}`).toString('base64'), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('identifiants refusés (401)'));
        if (res.statusCode >= 400) return reject(new Error(`RouterOS HTTP ${res.statusCode}: ${d.slice(0, 160)}`));
        try { resolve(d ? JSON.parse(d) : null); } catch { reject(new Error('réponse RouterOS illisible')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout RouterOS')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Parsing helpers (RouterOS returns everything as strings) ─────────────────
const num = s => { if (s == null) return null; const m = /-?\d+(\.\d+)?/.exec(String(s)); return m ? Number(m[0]) : null; };
const rate = s => { // "144.4Mbps", "1.2Gbps", "6Mbps-ax" or raw bit/s ("65000000") -> Mbit/s
  if (s == null) return null; const m = /(-?\d+(?:\.\d+)?)\s*([GMk]?)bps/i.exec(String(s));
  if (!m) { const n = num(s); return n == null ? null : n >= 100000 ? Math.round(n / 10000) / 100 : n; }
  const v = Number(m[1]); return m[2].toUpperCase() === 'G' ? v * 1000 : m[2].toLowerCase() === 'k' ? v / 1000 : v;
};
const normMac = s => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
function uptimeSec(s) { // "1d2h3m4s" / "02:03:04"
  if (!s) return null; let t = 0; const re = /(\d+)([wdhms])/g; let m, any = false;
  while ((m = re.exec(s))) { any = true; t += +m[1] * { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[m[2]]; }
  if (any) return t;
  const p = String(s).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : null;
}

// ── Status poll ──────────────────────────────────────────────────────────────
// status = { ok, error, updatedAt, system: {...}, radios: [...], clients: [...] }
let status = { ok: false, error: '', updatedAt: null, system: null, radios: [], clients: [] };
let polling = false;

async function poll() {
  if (!config || polling) return status;
  polling = true;
  try {
    const [res, wifi, reg, ifaces, clock] = await Promise.all([
      rest('GET', '/system/resource'),
      rest('GET', '/interface/wifi'),
      rest('GET', '/interface/wifi/registration-table'),
      rest('GET', '/interface').catch(() => []),
      rest('GET', '/system/clock').catch(() => null),
    ]);
    // monitor gives live channel / peers per interface (read-only command)
    const radios = [];
    for (const w of wifi) {
      let mon = {};
      try { const r = await rest('POST', '/interface/wifi/monitor', { '.id': w['.id'], once: true, duration: '1' }); mon = Array.isArray(r) ? (r[0] || {}) : (r || {}); } catch { /* not all ifaces monitorable */ }
      const cfg = k => w[k] ?? w['configuration.' + k] ?? w['channel.' + k];
      const ifc = ifaces.find(i => i.name === w.name) || {};
      radios.push({
        id: w['.id'], name: w.name, ssid: cfg('ssid'), mode: cfg('mode'), master: w['master-interface'] || null,
        band: mon.channel || cfg('band') || w['channel.band'] || null,
        bandCfg: w['channel.band'] || null, freqCfg: w['channel.frequency'] || 'auto',
        frequency: num(mon.channel) || num(cfg('frequency')) || null,
        width: cfg('width') || null,
        txPower: num(mon['tx-power']) ?? num(cfg('tx-power')) ?? null,
        clients: num(mon['registered-peers']) ?? null,
        authorized: num(mon['authorized-peers']) ?? null,
        state: mon.state || (w.running === 'true' ? 'running' : w.disabled === 'true' ? 'disabled' : 'unknown'),
        mac: w['radio-mac'] || w['mac-address'] || null,
        disabled: w.disabled === 'true', running: w.running === 'true',
        country: cfg('country') || null, hideSsid: cfg('hide-ssid') === 'true', multicastEnhance: cfg('multicast-enhance') || null,
        auth: w['security.authentication-types'] || null, ft: w['security.ft'] === 'true',
        txPackets: num(ifc['tx-packet']), txErrors: num(ifc['tx-error']), rxPackets: num(ifc['rx-packet']), rxErrors: num(ifc['rx-error']), txDrops: num(ifc['tx-drop']),
      });
    }
    const clients = reg.map(c => {
      const [txp, rxp] = String(c.packets || '').split(',').map(num);
      const [txb, rxb] = String(c.bytes || '').split(',').map(num);
      const radio = radios.find(r => r.name === c.interface);
      return {
        mac: normMac(c['mac-address']), macFmt: String(c['mac-address'] || '').toLowerCase(), iface: c.interface, ssid: c.ssid || null,
        signal: num(c.signal), txRate: rate(c['tx-rate']), rxRate: rate(c['rx-rate']), uptime: uptimeSec(c.uptime),
        txBps: num(c['tx-bits-per-second']), rxBps: num(c['rx-bits-per-second']), // real throughput right now
        txPackets: txp ?? null, rxPackets: rxp ?? null, txBytes: txb ?? null, rxBytes: rxb ?? null,
        band: c.band || (radio ? radio.band : null), authType: c['auth-type'] || null,
      };
    });
    status = {
      ok: true, error: '', updatedAt: Date.now(),
      system: {
        board: res['board-name'], version: res.version, uptime: uptimeSec(res.uptime), cpuLoad: num(res['cpu-load']),
        freeMemory: num(res['free-memory']), totalMemory: num(res['total-memory']), arch: res['architecture-name'], platform: res.platform,
        clock: clock ? `${clock.date} ${clock.time}` : null,
      },
      radios, clients,
    };
    status.audit = audit(status);
  } catch (e) {
    status = { ...status, ok: false, error: e.message, updatedAt: Date.now() };
  } finally { polling = false; }
  return status;
}

// ── Automated audit: what looks improvable, from the data already polled ────
// Each finding: { level: 'bad' | 'warn' | 'info' | 'ok', title, detail, fix }
// (fix = what to change, in RouterOS words; nothing is applied by this tool)
const NON_OVERLAP_2G = [2412, 2437, 2462, 2472]; // channels 1, 6, 11, 13
function audit(st) {
  const f = [];
  const add = (level, title, detail, fix) => f.push({ level, title, detail, fix: fix || '' });
  for (const r of st.radios) {
    const is2g = /2ghz/.test(r.bandCfg || '') || (r.frequency && r.frequency < 3000);
    if (r.disabled) {
      if (!is2g) add('info', `${r.name} (5 GHz) désactivée`, 'Les ESP32 des nodes WLED ne font que du 2,4 GHz : l\'activer ne les aidera pas directement. En revanche, y basculer téléphones, PC et tout ce qui n\'est pas WLED libère le 2,4 GHz pour les nodes.', 'activer wifi2 avec le même SSID (ou un SSID dédié "ORFOLED-5G") pour les appareils non-WLED');
      else add('warn', `${r.name} désactivée`, 'La radio 2,4 GHz est coupée : aucun node WLED ne peut s\'associer.', 'activer wifi1');
      continue;
    }
    if (is2g) {
      if (r.frequency && !NON_OVERLAP_2G.includes(r.frequency)) add('warn', `Canal 2,4 GHz ${r.frequency} MHz (canal ${Math.round((r.frequency - 2407) / 5)}) chevauchant`, `En 20 MHz, seuls les canaux 1, 6, 11 (et 13 en Europe) ne se recouvrent pas. Un canal intermédiaire subit les interférences de deux canaux voisins à la fois. Plage autorisée actuelle : ${r.freqCfg}.`, 'channel.frequency = 2412,2437,2462 (ou 2472) et laisser la sélection automatique choisir le plus libre, ou fixer le canal mesuré le plus calme');
      if (r.width && r.width !== '20mhz') add('warn', `${r.name} en largeur ${r.width}`, 'En 2,4 GHz, 40 MHz occupe deux tiers de la bande et n\'apporte rien aux ESP32 (20 MHz seulement).', 'channel.width = 20mhz');
      if (r.txPower != null && r.txPower < 10) add('info', `Puissance TX ${r.txPower} dBm`, 'Faible. Sur un wAP ax, RouterOS déduit le gain d\'antenne (7 dBi) de la limite réglementaire (20 dBm PIRE en Europe) : 13 dBm est déjà le maximum légal, il n\'y a pas de marge.', '');
      if (r.multicastEnhance && r.multicastEnhance !== 'enabled') add('warn', 'multicast-enhance désactivé', 'Le multicast Wi‑Fi (E1.31 multicast, mDNS, découverte WLED) est émis au débit le plus bas et sans acquittement. multicast-enhance le convertit en unicast vers chaque client.', 'configuration.multicast-enhance = enabled');
    }
    if (r.ft) add('info', `${r.name} : 802.11r (fast transition) actif`, 'Les ESP32 sous WLED ne l\'exploitent pas, et certains firmwares ESP gèrent mal les AP qui l\'annoncent (associations qui échouent ou boucles de reconnexion). À désactiver si des nodes décrochent sans raison.', 'security.ft = no, security.ft-over-ds = no');
    if (/wpa3/.test(r.auth || '') && /wpa2/.test(r.auth || '')) add('info', `${r.name} : WPA2 + WPA3 mixte`, 'Fonctionne avec les ESP32 (WPA2). Si un node n\'arrive pas à s\'associer, passer en wpa2-psk seul lève le doute.', 'security.authentication-types = wpa2-psk');
    if (r.txPackets > 1000 && r.txErrors != null) {
      const pct = 100 * r.txErrors / r.txPackets;
      if (pct > 2) add(pct > 5 ? 'bad' : 'warn', `${r.name} : ${pct.toFixed(1)} % de trames émises en erreur`, `${r.txErrors} erreurs sur ${r.txPackets} trames depuis le démarrage : retransmissions épuisées, typique d'interférences ou de clients loin / à bas débit. Chaque erreur = une trame E1.31/DDP arrivée en retard ou perdue.`, 'changer de canal après mesure d\'occupation, rapprocher / réorienter, réduire le nombre d\'appareils non-WLED sur cette radio');
    }
    if (r.rxPackets > 1000 && r.rxErrors != null && 100 * r.rxErrors / r.rxPackets > 2) add('warn', `${r.name} : ${(100 * r.rxErrors / r.rxPackets).toFixed(1)} % de trames reçues en erreur`, 'Trames corrompues à la réception : interférences sur le canal ou clients trop faibles.', '');
    if (r.hideSsid) add('info', `${r.name} : SSID caché`, 'N\'apporte aucune sécurité et ralentit l\'association des ESP32 (probe actif obligatoire).', 'configuration.hide-ssid = no');
  }
  for (const c of st.clients) {
    const who = c.macFmt;
    if (c.signal != null && c.signal < -75) add('warn', `Client ${who} à ${c.signal} dBm`, 'Signal faible côté antenne : débit bas, retransmissions, décrochages probables.', 'rapprocher, dégager, ou ajouter une antenne');
    else if (c.signal != null && c.signal < -68) add('info', `Client ${who} à ${c.signal} dBm`, 'Signal moyen : correct au repos, à surveiller sous charge.', '');
    if (c.txBps > 200000 && c.txRate != null && c.txRate < 12) add('warn', `Client ${who} : ${c.txRate} Mbit/s sous charge`, `L'antenne lui parle à ${c.txRate} Mbit/s alors qu'elle lui envoie ${Math.round(c.txBps / 1000)} kbit/s : le lien est dégradé (trames longues, temps d'antenne mangé pour tout le monde).`, '');
  }
  if (st.system && st.system.clock && /^20(1|2[0-5])/.test(st.system.clock)) add('info', `Horloge du routeur : ${st.system.clock}`, 'Pas de NTP : les journaux et les certificats du routeur ont une date fausse. Sans conséquence pour le Wi‑Fi.', 'system/ntp/client set enabled=yes servers=pool.ntp.org');
  if (st.system && st.system.cpuLoad > 70) add('warn', `CPU routeur à ${st.system.cpuLoad} %`, 'Charge élevée : latence Wi‑Fi en hausse.', '');
  if (st.system && st.system.freeMemory != null && st.system.freeMemory < 16 * 1024 * 1024) add('warn', `RAM libre ${Math.round(st.system.freeMemory / 1048576)} MB`, 'Routeur proche de la saturation mémoire.', '');
  const running = st.radios.filter(r => !r.disabled);
  if (running.length === 1 && running[0].clients != null) add('ok', `${running[0].clients} client(s) sur ${running[0].name}`, `Une seule radio active, tout le trafic passe par ${running[0].band || ''} en ${running[0].width || ''}.`, '');
  return f;
}

// ── RF environment scan ──────────────────────────────────────────────────────
// `/interface/wifi/scan` lists the neighbouring networks a radio can hear.
// It is the ONE disruptive call of this module: the radio leaves its channel
// for the scan duration (a few seconds) and clients drop, then re-associate
// on their own (WLED does within ~5-10 s). Never run it during a show.
const SCAN_FILE = path.join(__dirname, 'rf-scans.log');
let lastScan = null;
let scanning = false;
// networks seen by any scan in the last 15 min (a WLED-AP beacons slowly and a
// 5 s scan can miss it: remembering it across scans makes pairing reliable)
const recent = new Map(); // bssid+freq -> {...network, seenAt}
const RECENT_MS = 15 * 60000;
const recentNetworks = () => { const now = Date.now(); for (const [k, v] of recent) if (now - v.seenAt > RECENT_MS) recent.delete(k); return [...recent.values()].sort((a, b) => (b.signal ?? -99) - (a.signal ?? -99)); };

const chan2g = f => (f >= 2412 && f <= 2484) ? (f === 2484 ? 14 : Math.round((f - 2407) / 5)) : null;

// ── 2.4 GHz channel plan from a list of neighbouring networks ────────────────
// Shared by every RF source (antenna scan here, WiFiman Wizard in wizard.js):
// nets = [{ channel, freq, signal, width }], oursFreq = the radio's current
// frequency (MHz) or null. Returns { ours, ourFreq, occupancy, candidates, recommended }.
// Occupancy per channel 1..13: every neighbour pollutes its own channel and, in
// 20 MHz, ±4 channels (weight decreasing with distance), scaled by how loud it
// is (-90 dBm -> 0, -30 dBm -> 1). Networks above 2.5 GHz are ignored.
function occupancy(nets, oursFreq) {
  const occ = {};
  for (let c = 1; c <= 13; c++) occ[c] = { channel: c, freq: 2407 + 5 * c, score: 0, networks: 0, strongest: null };
  for (const n of nets) {
    if (!n.channel || n.freq > 2500) continue;
    const loud = Math.max(0, Math.min(1, ((n.signal ?? -90) + 90) / 60));
    const span = n.width === 40 ? 6 : 4;
    for (let c = 1; c <= 13; c++) {
      const d = Math.abs(c - n.channel);
      if (d > span) continue;
      occ[c].score += loud * (1 - d / (span + 1));
      if (d === 0) { occ[c].networks++; if (occ[c].strongest == null || n.signal > occ[c].strongest) occ[c].strongest = n.signal; }
    }
  }
  // 13 is legal in Europe but many ESP32 builds run the SDK's "world" country
  // profile (channels 1-11) and never see an AP on 12/13: never recommend it.
  const ours = chan2g(oursFreq);
  const candidates = [1, 6, 11, 13].map(c => ({ ...occ[c], ours: ours === c, esp32Risk: c > 11 }));
  const best = candidates.filter(c => !c.esp32Risk).sort((a, b) => a.score - b.score)[0];
  return { ours, ourFreq: oursFreq ?? null, occupancy: Object.values(occ), candidates, recommended: best ? best.channel : null };
}

async function scan(iface, durationSec = 5) {
  if (!config) throw new Error('antenne non configurée');
  if (scanning) throw new Error('scan déjà en cours');
  scanning = true;
  const startedAt = Date.now();
  try {
    let raw;
    try { raw = await rest('POST', '/interface/wifi/scan', { numbers: iface, duration: `${durationSec}s` }, durationSec * 1000 + 15000); }
    catch (e) { raw = await rest('POST', '/interface/wifi/scan', { '.id': iface, duration: `${durationSec}s` }, durationSec * 1000 + 15000); }
    const rows = Array.isArray(raw) ? raw : [];
    // RouterOS reports every pass of the scan (".section"): keep one row per BSSID, the loudest
    const byBssid = new Map();
    for (const r of rows) {
      const chStr = r.channel || r.frequency || '';
      const freq = num(chStr);
      if (!freq) continue;
      const n = { bssid: String(r.address || r['mac-address'] || '').toLowerCase(), ssid: r.ssid || '', freq, channel: chan2g(freq) || Math.round((freq - 5000) / 5),
        channelStr: String(chStr), signal: num(r.sig ?? r.signal), width: /\/(Ce|eC|Ceee|eCee|eeCe|eeeC)/.test(String(chStr)) ? 40 : 20, std: (String(chStr).split('/')[1] || ''),
        security: r.security || '', stations: num(r['sta-count']) };
      const prev = byBssid.get(n.bssid + n.freq);
      if (!prev || (n.signal ?? -99) > (prev.signal ?? -99)) byBssid.set(n.bssid + n.freq, n);
    }
    const nets = [...byBssid.values()];
    for (const n of nets) recent.set(n.bssid + n.freq, { ...n, seenAt: startedAt });
    const ours = (status.radios.find(r => r.name === iface) || {}).frequency;
    const plan = occupancy(nets, ours);
    lastScan = { at: startedAt, iface, durationSec, ...plan, networks: nets.sort((a, b) => (b.signal ?? -99) - (a.signal ?? -99)), sampleKeys: rows[0] ? Object.keys(rows[0]) : [] };
    fs.appendFile(SCAN_FILE, JSON.stringify({ at: startedAt, iface, ours: lastScan.ours, recommended: lastScan.recommended, networks: nets.length, occupancy: plan.candidates.map(c => [c.channel, Math.round(c.score * 100) / 100]) }) + '\n', () => {});
    return lastScan;
  } finally { scanning = false; }
}
// The show's Wi-Fi as the antenna serves it (SSID + passphrase of the running
// 2.4 GHz radio). Used by the pairing to hand a new node its network without
// anyone typing the password. Never exposed through view().
let lastShow = null; // remembered so a transient loss of the antenna (Wi-Fi card off during a scan) does not blank it
async function showWifi() {
  if (!config) return null;
  try {
    const wifi = await rest('GET', '/interface/wifi');
    const cand = wifi.filter(w => w.disabled !== 'true' && (w['configuration.mode'] || 'ap') === 'ap');
    const w = cand.find(x => /2ghz/.test(x['channel.band'] || '')) || cand[0];
    if (!w) return lastShow;
    lastShow = { ssid: w['configuration.ssid'] || null, psk: w['security.passphrase'] || null, iface: w.name, at: Date.now(), stale: false };
    return lastShow;
  } catch (e) {
    return lastShow ? { ...lastShow, stale: true, error: e.message } : null;
  }
}

// ── The only write this module does: the 2.4 GHz channel plan of one radio ──
// spec = "2462" (fixed channel) or "2412,2437,2462" (RouterOS auto-selects among
// those). Applied with PATCH on the interface; the radio restarts on its new
// channel and clients re-associate on their own.
async function setChannel(iface, spec) {
  if (!config) throw new Error('antenne non configurée');
  if (!/^\d{4}(,\d{4})*$/.test(spec)) throw new Error('plage de fréquences invalide');
  const wifi = await rest('GET', '/interface/wifi');
  const w = wifi.find(x => x.name === iface);
  if (!w) throw new Error(`radio ${iface} introuvable`);
  const before = w['channel.frequency'] || 'auto';
  await rest('PATCH', `/interface/wifi/${w['.id']}`, { 'channel.frequency': spec });
  return { iface, before, after: spec };
}

// Show preset for a radio: a whitelist of settings we know are safe for ESP32
// clients. `patch` = { key: value } among SHOW_PRESET_KEYS; applied with one
// PATCH on the interface (the radio restarts, clients re-associate).
const SHOW_PRESET_KEYS = ['security.ft', 'security.ft-over-ds', 'security.authentication-types', 'security.management-protection', 'configuration.dtim-period', 'channel.frequency', 'channel.width', 'configuration.multicast-enhance', 'configuration.beacon-interval'];
async function radioSettings(iface) {
  if (!config) throw new Error('antenne non configurée');
  const wifi = await rest('GET', '/interface/wifi');
  const w = wifi.find(x => x.name === iface); if (!w) throw new Error(`radio ${iface} introuvable`);
  const out = { id: w['.id'], name: w.name };
  for (const k of SHOW_PRESET_KEYS) out[k] = w[k] === undefined ? null : w[k];
  return out;
}
async function applyRadio(iface, patch) {
  if (!config) throw new Error('antenne non configurée');
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) { if (!SHOW_PRESET_KEYS.includes(k)) throw new Error(`réglage refusé : ${k}`); clean[k] = String(v); }
  if (!Object.keys(clean).length) throw new Error('rien à appliquer');
  const cur = await radioSettings(iface);
  await rest('PATCH', `/interface/wifi/${cur.id}`, clean);
  return { iface, before: Object.fromEntries(Object.keys(clean).map(k => [k, cur[k]])), after: clean };
}

function scanHistory(n = 50) {
  try { return fs.readFileSync(SCAN_FILE, 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

// Per-node view: what the AP knows about this WLED node (matched by MAC).
function forNode(mac) {
  if (!status.ok || !mac) return null;
  const m = normMac(mac);
  const c = status.clients.find(x => x.mac === m);
  if (!c) return { seen: false };
  const radio = status.radios.find(r => r.name === c.iface);
  return { seen: true, iface: c.iface, band: radio ? radio.band : c.band, signal: c.signal, txRate: c.txRate, rxRate: c.rxRate, uptime: c.uptime, txPackets: c.txPackets, rxPackets: c.rxPackets, txKbps: c.txBps != null ? Math.round(c.txBps / 1000) : null, rxKbps: c.rxBps != null ? Math.round(c.rxBps / 1000) : null };
}

function view(fleetMacs) {
  const known = new Set((fleetMacs || []).map(normMac));
  return {
    configured: !!config,
    host: config ? config.host : null,
    user: config ? config.user : null,
    saved: savedAps(),
    lastScan, scanning, recentNetworks: recentNetworks(),
    discovered: [...discovered.values()].filter(d => Date.now() - d.seenAt < 5 * 60000),
    ...status,
    clients: status.clients.map(c => ({ ...c, isNode: known.has(c.mac) })),
  };
}

module.exports = { setConfigFile, loadConfig, saveConfig, connect, forget, exportStore, importStore, startDiscovery, setBroadcasts, poll, showWifi, forNode, view, scan, scanHistory, setChannel, radioSettings, applyRadio, occupancy, chan2g, SHOW_PRESET_KEYS, config: () => config, rest, status: () => status, lastScan: () => lastScan };
