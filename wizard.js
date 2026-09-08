// WiFiman Wizard (Ubiquiti WM-W) as a MOBILE RF probe (roadmap Phase 3, monitoring only).
//
// The antenna scan (ap.js) and the PC's Wi-Fi card (provision.js) both listen
// from a fixed point. The Wizard is a pocket 802.11 scanner (MediaTek MT7931AN,
// 2.4 + 5 GHz, receive-only) that streams over Bluetooth LE: carried around the
// stage it shows what a node would hear at THAT spot. Two uses:
//   - survey: walk, take named snapshots ("régie", "plateau jardin"…) that feed
//     the same channel plan as the antenna scan (ap.occupancy);
//   - live: keep it near a node during the show, follow the show SSID's RSSI
//     and the neighbours over time, raise findings in the antenna audit.
//
// Node has no BLE: tools/wizard/wizard_bridge.py (Python + bleak) does the BLE
// side and speaks NDJSON on its stdout; this module spawns it, keeps the
// per-BSSID history and exposes snapshots. `--mock` runs the bridge without
// hardware. The Wizard's BLE protocol (HTTP-style JSON over a small binary
// framing, docs/wizard-protocol.md) is implemented in tools/wizard/wizard_decode.py.
//
// The probe is OPTIONAL: wizard.json "enabled" gates the panel, the bridge and
// the auto-connect (installs that already had an address stay enabled).
//
//   node server.js --wizard-mock                     # bridge in mock mode at boot
//   wizard.json = { "enabled": true, "python": "python", "address": "AA:BB:…", "autoconnect": false }
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ap = require('./ap');
const { dataFile, codeFile, DATA_DIR, CODE_DIR } = require('./paths');

const BRIDGE = codeFile('tools', 'wizard', 'wizard_bridge.py');
let CONFIG_FILE = dataFile('wizard.json');
const SURVEY_FILE = dataFile('wizard-surveys.log');
const LIVE_FILE = dataFile('wizard-live.log');
const STALE_MS = 60000;        // a network not heard for a minute is out of the snapshot (we moved, or it went off)
const FORGET_MS = 15 * 60000;  // …and dropped from memory after 15 min
const SAMPLES = 180;           // per-BSSID RSSI history kept in RAM (~3 min at 1 Hz)
const LIVE_EVERY_MS = 5000;

// ── Config (wizard.json, git-ignored like ap.json) ───────────────────────────
let config = { enabled: null, python: null, address: null, name: null, autoconnect: false };
function setConfigFile(f) { CONFIG_FILE = path.isAbsolute(f) ? f : dataFile(f); }
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* none yet */ }
  if (config.enabled == null) config.enabled = !!config.address;   // before the toggle existed: a paired Wizard meant "in use"
  return config;
}
function saveConfig(patch) { config = { ...config, ...patch }; try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n'); } catch { /* read-only dir: keep in RAM */ } return config; }

// ── Python resolution: wizard.json "python", then what Windows / Linux usually have ──
// On Windows, `python`/`python3` are by default "App Execution Aliases" — tiny
// stub exes at %LOCALAPPDATA%\Microsoft\WindowsApps\ that, when NO real Python
// is installed, pop the Microsoft Store page instead of failing cleanly (bug
// reported 2026-09-07: "des fenêtres d'installation de python qui apparaissent
// souvent", and WiFiman never working since resolution always dead-ended on
// python.exe never gets used, `where` only looks the path up — running it
// resolvePython() with pythonCmd still null retries the same sweep every time).
// `py -3` (the real, install-time-only launcher.exe) is never one of these
// stubs, so it's tried first ; python/python3 are only ever RUN after `where`
// confirms the resolved path isn't a WindowsApps stub, which never happens.
let pythonCmd = null;   // ['python'] or ['py', '-3'] once found
let pythonError = '';
// node tools/prepare-python-embed.js (not run automatically — needs network + a
// system Python to drive pip) bundles a full, bleak-preinstalled Python next to
// the app ; when present (always, once desktop/build.rs picks it up into the
// exe) it's tried FIRST, so WiFiman needs no system Python install at all.
const BUNDLED_PYTHON = codeFile('tools', 'python-embed', 'python.exe');
function candidates() {
  const list = [];
  if (fs.existsSync(BUNDLED_PYTHON)) list.push([BUNDLED_PYTHON]);
  if (config.python) list.push(String(config.python).split(' ').filter(Boolean));
  if (process.platform === 'win32') list.push(['py', '-3'], ['python'], ['python3']);
  else list.push(['python3'], ['python'], ['py', '-3']);
  return list;
}
// `where`/`which` just look a name up on PATH ; unlike running it, this never
// triggers a Windows App Execution Alias's Store-redirect behaviour.
function resolveOnPath(name) {
  return new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [name], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      resolve(String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null);
    });
  });
}
async function isWindowsStoreStub(cmdName) {
  if (process.platform !== 'win32' || !/^python3?$/.test(cmdName)) return false;
  const found = await resolveOnPath(cmdName);
  if (!found) return true; // nothing on PATH at all: treat as unusable, no need to run it
  if (!/\\WindowsApps\\/i.test(found)) return false; // a real install elsewhere: safe to run
  try { return fs.statSync(found).size < 500000; } catch { return true; } // the stub is a few KB, a real python.exe is several MB
}
function tryPython(cmd) {
  return new Promise(resolve => {
    isWindowsStoreStub(cmd[0]).then(stub => {
      if (stub) return resolve(null);
      execFile(cmd[0], [...cmd.slice(1), '-c', 'import sys; print(sys.version.split()[0])'], { timeout: 8000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const v = String(out).trim();
        resolve(/^3\.(9|[1-9]\d)/.test(v) ? v : null); // bleak needs 3.9+
      });
    });
  });
}
async function resolvePython(force = false) {
  if (pythonCmd && !force) return pythonCmd;
  for (const c of candidates()) { const v = await tryPython(c); if (v) { pythonCmd = c; pythonVersion = v; pythonError = ''; return c; } }
  pythonCmd = null; pythonError = 'Python 3.9+ introuvable (wizard.json "python", ou python / py / python3 dans le PATH)';
  return null;
}
let pythonVersion = null;

// ── Dependencies: Python 3.9+ and the bleak module. Checked once (again on demand), installable from the page ──
let bleakVersion = null, bleakError = '', depsChecked = false, installing = false, installLog = '';
function run(cmd, args, timeout) {
  return new Promise(resolve => execFile(cmd, args, { timeout, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') })));
}
async function deps(force = false) {
  if (depsChecked && !force) return depsStatus();
  const py = await resolvePython(force);
  bleakVersion = null; bleakError = '';
  if (py) {
    const r = await run(py[0], [...py.slice(1), '-c', 'import bleak, importlib.metadata as m; print(m.version("bleak"))'], 15000);
    if (!r.err) bleakVersion = r.out.trim() || '?'; else bleakError = 'module Python « bleak » absent';
  }
  depsChecked = true;
  return depsStatus();
}
function depsStatus() { return { python: pythonCmd ? pythonCmd.join(' ') : null, pythonVersion, pythonError, bleak: bleakVersion, bleakError, ok: !!(pythonCmd && bleakVersion), installing, installLog }; }
// pip install --user bleak, with the Python found (or, on Windows without Python, winget installs Python first)
async function install() {
  if (installing) throw new Error('installation déjà en cours');
  installing = true; installLog = '';
  try {
    let py = await resolvePython(true);
    if (!py && process.platform === 'win32') {
      installLog += 'Python absent : installation par winget (Python.Python.3.12)…\n';
      const r = await run('winget', ['install', '-e', '--id', 'Python.Python.3.12', '--silent', '--accept-package-agreements', '--accept-source-agreements'], 600000);
      installLog += (r.out + r.errOut).slice(-1500) + '\n';
      py = await resolvePython(true);
      if (!py) throw new Error('Python toujours introuvable après winget : installer Python 3 depuis python.org puis réessayer');
    }
    if (!py) throw new Error(pythonError);
    installLog += `pip install --user bleak (${py.join(' ')})…\n`;
    const r = await run(py[0], [...py.slice(1), '-m', 'pip', 'install', '--user', '--upgrade', 'bleak'], 300000);
    installLog += (r.out + r.errOut).slice(-2000);
    if (r.err) throw new Error(`pip a échoué : ${(r.errOut || r.out).trim().split('\n').pop() || r.err.message}`);
    await deps(true);
    if (!bleakVersion) throw new Error('bleak installé mais toujours introuvable pour ' + py.join(' '));
    return depsStatus();
  } finally { installing = false; }
}

// ── Bridge process and its event stream ──────────────────────────────────────
let proc = null;
let st = { state: 'off', mode: null, error: '', bleak: null, device: null, startedAt: null, lastEventAt: null, events: 0, stderr: [] };
const nets = new Map(); // bssid+freq -> { bssid, ssid, freq, channel, width, signal, band, security, std, seenAt, firstSeenAt, min, max, samples: [[t, dBm], …] }
let nearNode = null;    // MAC of the WLED node the Wizard is sitting next to (live correlation), or null
let liveTimer = null;

function onEvent(ev) {
  st.lastEventAt = Date.now(); st.events++;
  if (ev.type === 'hello') { st.mode = ev.mode; st.bleak = ev.bleak; return; }
  if (ev.type === 'status') {
    st.state = ev.state;
    if (ev.state === 'connected') {
      st.error = '';
      st.device = { address: ev.address, name: ev.name || null, firmware: ev.firmware || null, battery: ev.battery ?? (st.device && st.device.address === ev.address ? st.device.battery : null), decoder: ev.decoder || null, manufacturer: ev.manufacturer || null, model: ev.model || null };
      if (ev.address && ev.address !== 'mock' && (ev.address !== config.address || (ev.name && ev.name !== config.name))) saveConfig({ address: ev.address, name: ev.name || config.name || null });
    }
    if (ev.state === 'scanning' || ev.state === 'connecting') st.device = st.device && st.device.address === ev.address ? st.device : { address: ev.address || null, name: ev.name || null };
    return;
  }
  if (ev.type === 'error') { st.error = ev.message || ev.code; if (ev.code === 'no_bleak' || ev.code === 'adapter') st.state = 'error'; return; }
  if (ev.type === 'network') {
    if (!ev.bssid || !ev.freq) return;
    const k = String(ev.bssid).toLowerCase() + ev.freq;
    const t = ev.t || Date.now();
    let n = nets.get(k);
    if (!n) { n = { bssid: String(ev.bssid).toLowerCase(), firstSeenAt: t, samples: [], min: null, max: null }; nets.set(k, n); }
    // center = centre channel number (ch_s0) from the decoder -> MHz, for the frequency view of wide channels
    const center = ev.center ? (ev.freq < 3000 ? 2407 + 5 * ev.center : 5000 + 5 * ev.center) : null;
    Object.assign(n, { ssid: ev.ssid || '', freq: ev.freq, channel: ev.channel || ap.chan2g(ev.freq) || Math.round((ev.freq - 5000) / 5), width: ev.width || 20, signal: ev.signal ?? null,
      band: ev.band || (ev.freq < 3000 ? '2g' : '5g'), security: ev.security || '', std: ev.std || '', seenAt: t,
      center, utilization: typeof ev.utilization === 'number' ? ev.utilization : null, stations: typeof ev.stations === 'number' ? ev.stations : null });
    if (ev.signal != null) {
      n.samples.push([t, ev.signal]); if (n.samples.length > SAMPLES) n.samples.shift();
      n.min = n.min == null ? ev.signal : Math.min(n.min, ev.signal); n.max = n.max == null ? ev.signal : Math.max(n.max, ev.signal);
    }
  }
}

async function start(opts = {}) {
  if (proc) throw new Error('bridge déjà lancé');
  const mock = !!opts.mock;
  if (!config.enabled && !mock) throw new Error('sonde Wizard désactivée : cocher « activer » dans Antenne > WiFiman Wizard');
  const address = mock ? null : (opts.address || config.address);
  if (!mock && !address) throw new Error('adresse BLE du Wizard inconnue : « Rechercher » puis choisir l\'appareil');
  const py = await resolvePython();
  if (!py) throw new Error(pythonError);
  const args = [...py.slice(1), BRIDGE, ...(mock ? ['--mock'] : ['--address', address, ...(opts.raw ? ['--raw'] : [])])];
  st = { state: 'starting', mode: mock ? 'mock' : 'ble', error: '', bleak: null, device: address ? { address } : null, startedAt: Date.now(), lastEventAt: null, events: 0, stderr: [] };
  proc = spawn(py[0], args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const p = proc;
  console.log(`wizard: ${py.join(' ')} ${args.slice(py.length - 1).join(' ')}`);
  readline.createInterface({ input: p.stdout }).on('line', line => { if (p !== proc) return; try { onEvent(JSON.parse(line)); } catch { /* not JSON: ignore */ } });
  readline.createInterface({ input: p.stderr }).on('line', line => { if (p !== proc) return; st.stderr.push(line.slice(0, 300)); if (st.stderr.length > 20) st.stderr.shift(); });
  p.on('error', e => { if (p !== proc) return; st.state = 'error'; st.error = `lancement Python : ${e.message}`; proc = null; stopLive(); });
  p.on('exit', (code, sig) => {
    if (p !== proc) return;
    proc = null; stopLive();
    if (st.state !== 'error') { st.state = 'stopped'; if (code && code !== 0 && !st.error) st.error = `bridge terminé (code ${code}${sig ? ', ' + sig : ''})${st.stderr.length ? ' : ' + st.stderr[st.stderr.length - 1] : ''}`; }
  });
  startLive();
  return status();
}

// One button: off -> enable, find the Wizard (saved address, else BLE discovery by Ubiquiti OUI /
// service UUID), connect, remember it ; on -> disconnect and disable.
let toggling = false;
async function toggle() {
  if (toggling) return status(); // a second click while the first one is still searching: ignored
  if (proc) { stop(); saveConfig({ enabled: false }); st.state = 'stopping'; return status(); }
  toggling = true;
  try {
  saveConfig({ enabled: true, autoconnect: true });
  const d = await deps();
  if (!d.ok) throw new Error(d.pythonError || d.bleakError);
  let address = config.address;
  if (!address) {
    st = { ...st, state: 'scanning', error: '' };
    const found = await devices(6);
    const w = found.find(x => x.likely);
    if (!w) { st.state = 'off'; st.error = 'Wizard non vu en Bluetooth'; throw new Error('Wizard non vu en Bluetooth : appuyer sur son bouton pour le réveiller, le garder à portée, et couper le Bluetooth du téléphone (une seule connexion à la fois)'); }
    address = w.address; saveConfig({ address, name: w.name || null });
  }
  return await start({ address });
  } finally { toggling = false; }
}
// synchronous, for process 'exit': no NDJSON goodbye, just do not leave a python behind
function kill() { const p = proc; if (!p) return; proc = null; try { p.kill(); } catch { /* ignore */ } }
function stop() {
  const p = proc; if (!p) return false;
  try { p.stdin.write('{"cmd":"quit"}\n'); } catch { /* already gone */ }
  setTimeout(() => { if (proc === p) { try { p.kill(); } catch { /* ignore */ } } }, 2500).unref();
  return true;
}

// One-shot BLE scan through the bridge: [{address, name, rssi, services, likely}]
function devices(timeoutSec = 6) {
  return new Promise((resolve, reject) => {
    resolvePython().then(py => {
      if (!py) return reject(new Error(pythonError));
      execFile(py[0], [...py.slice(1), BRIDGE, '--list', '--timeout', String(timeoutSec)], { timeout: (timeoutSec + 25) * 1000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out) => {
        const found = []; let error = null;
        for (const line of String(out || '').split('\n')) { try { const ev = JSON.parse(line); if (ev.type === 'device') found.push(ev); else if (ev.type === 'error') error = ev.message; } catch { /* ignore */ } }
        if (error && !found.length) return reject(new Error(error));
        if (err && !found.length) return reject(new Error(`recherche BLE : ${err.message}`));
        resolve(found.sort((a, b) => (b.likely - a.likely) || (b.rssi ?? -999) - (a.rssi ?? -999)));
      });
    });
  });
}

// ── Snapshot: what the Wizard hears right now, in the antenna scan's shape ───
function forget() { const now = Date.now(); for (const [k, n] of nets) if (now - n.seenAt > FORGET_MS) nets.delete(k); }
function heard(windowMs = STALE_MS) { forget(); const now = Date.now(); return [...nets.values()].filter(n => now - n.seenAt <= windowMs).sort((a, b) => (b.signal ?? -99) - (a.signal ?? -99)); }
// the show's 2.4 GHz radio as the antenna module knows it: frequency + BSSID (radio MAC) + SSID
function showRadio() {
  const s = ap.status();
  const r = (s.radios || []).find(x => !x.disabled && /2ghz/.test(x.bandCfg || '') && x.running) || (s.radios || []).find(x => !x.disabled && x.frequency && x.frequency < 3000);
  return r ? { iface: r.name, freq: r.frequency || null, bssid: (r.mac || '').toLowerCase() || null, ssid: r.ssid || null } : null;
}
function snapshot() {
  const list = heard();
  const show = showRadio();
  const plan = ap.occupancy(list, show ? show.freq : null);
  const now = Date.now();
  const networks = list.map(n => ({ bssid: n.bssid, ssid: n.ssid, freq: n.freq, channel: n.channel, channelStr: `${n.freq}${n.std ? '/' + n.std : ''}${n.width === 40 ? '/Ce' : n.width === 80 ? '/Ceee' : ''}`, width: n.width, signal: n.signal, band: n.band, security: n.security, std: n.std, min: n.min, max: n.max, ago: Math.round((now - n.seenAt) / 1000), samples: n.samples.length, center: n.center || null, utilization: n.utilization ?? null, stations: n.stations ?? null, isShow: !!(show && (n.bssid === show.bssid || (show.ssid && n.ssid === show.ssid && n.band === '2g'))) }));
  const showNet = networks.find(n => n.isShow) || null;
  const showRaw = showNet ? nets.get(showNet.bssid + showNet.freq) : null;
  return { at: now, source: 'wizard', ...plan, networks, show: show ? { ...show, seen: !!showNet, signal: showNet ? showNet.signal : null, series: showRaw ? showRaw.samples.slice(-120) : [] } : null };
}
// same BSSID heard by the antenna scan and by the Wizard: the difference tells how the spot compares to the antenna's own ears
function compare(apScan) {
  if (!apScan || !apScan.networks) return [];
  const mine = new Map(heard().map(n => [n.bssid + n.freq, n]));
  const out = [];
  for (const a of apScan.networks) { const w = mine.get(a.bssid + a.freq); if (w && a.signal != null && w.signal != null) out.push({ bssid: a.bssid, ssid: a.ssid || w.ssid, channel: a.channel, antenna: a.signal, wizard: w.signal, delta: w.signal - a.signal }); }
  return out.sort((x, y) => (y.wizard ?? -99) - (x.wizard ?? -99));
}

// ── Surveys: named snapshots, one JSON line each (like rf-scans.log) ─────────
function survey(label, extra = {}) {
  const s = snapshot();
  if (!s.networks.length) throw new Error('le Wizard n\'a rien entendu depuis une minute : rien à enregistrer');
  const rec = { at: s.at, label: String(label || '').trim().slice(0, 60) || `relevé ${new Date(s.at).toLocaleTimeString()}`, nearNode: extra.nearNode || nearNode || null, device: st.device ? st.device.address : null,
    ours: s.ours, recommended: s.recommended, candidates: s.candidates.map(c => [c.channel, Math.round(c.score * 100) / 100, c.networks]),
    show: s.show ? { bssid: s.show.bssid, ssid: s.show.ssid, signal: s.show.signal } : null,
    networks: s.networks.map(n => ({ bssid: n.bssid, ssid: n.ssid, freq: n.freq, channel: n.channel, width: n.width, signal: n.signal, min: n.min, max: n.max, band: n.band, std: n.std, security: n.security })) };
  fs.appendFileSync(SURVEY_FILE, JSON.stringify(rec) + '\n');
  return rec;
}
function surveys(n = 100) { try { return fs.readFileSync(SURVEY_FILE, 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function removeSurvey(at) {
  const keep = surveys(100000).filter(r => r.at !== Number(at));
  fs.writeFileSync(SURVEY_FILE, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  return keep.length;
}

// ── Waterfall: time × frequency, strongest RSSI heard per 5 MHz bin, one row every 5 s (RAM, ~1 h) ──
// A network covers [center - width/2, center + width/2]; a bin keeps the loudest network over it.
// Networks stay in a row as long as they are in the snapshot (STALE_MS), which smooths the
// Wizard's channel-by-channel scan cycle. -128 = nothing heard.
const WATER_ROWS = 720;
const WATER_BANDS = { g2: [2400, 2495], g5: [5150, 5875] };
const water = [];
function waterRow() {
  const list = heard();
  const row = { t: Date.now() };
  for (const [band, [lo, hi]] of Object.entries(WATER_BANDS)) {
    const n = (hi - lo) / 5; const bins = new Array(n).fill(-128);
    for (const x of list) {
      if (x.signal == null || x.freq < lo || x.freq > hi) continue;
      const c = x.center || x.freq, w = x.width || 20;
      const i0 = Math.max(0, Math.floor((c - w / 2 - lo) / 5)), i1 = Math.min(n - 1, Math.ceil((c + w / 2 - lo) / 5) - 1);
      for (let i = i0; i <= i1; i++) if (x.signal > bins[i]) bins[i] = x.signal;
    }
    row[band] = bins;
  }
  water.push(row); if (water.length > WATER_ROWS) water.shift();
}
// rows encoded compactly: two hex digits per bin (dBm + 128), ".." when nothing was heard
const hexBins = bins => bins.map(v => v === -128 ? '..' : (v + 128).toString(16).padStart(2, '0')).join('');
function waterfall(n = 360) {
  return { every: LIVE_EVERY_MS, bands: WATER_BANDS, rows: water.slice(-n).map(r => ({ t: r.t, g2: hexBins(r.g2), g5: hexBins(r.g5) })) };
}

// ── Live journal: one compact line every 5 s while connected (Phase 3 history) ──
function startLive() {
  stopLive();
  liveTimer = setInterval(() => {
    if (st.state !== 'connected') return;
    waterRow();
    const s = snapshot(); if (!s.networks.length) return;
    fs.appendFile(LIVE_FILE, JSON.stringify({ t: s.at, ours: s.ours, show: s.show ? s.show.signal : null, networks: s.networks.length, near: nearNode, occ: s.candidates.map(c => Math.round(c.score * 100) / 100) }) + '\n', () => {});
  }, LIVE_EVERY_MS);
  liveTimer.unref();
}
function stopLive() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }
function liveHistory(n = 720) { try { return fs.readFileSync(LIVE_FILE, 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }

// ── Findings merged into the antenna audit (server.js /api/ap) ───────────────
// nodeRssi(mac) -> what the WLED node itself reports (info.wifi.rssi), for the "near a node" correlation.
function audit(nodeRssi) {
  const f = [];
  if (st.state !== 'connected') return f;
  const add = (level, title, detail, fix) => f.push({ level, title, detail, fix: fix || '', source: 'wizard' });
  const s = snapshot();
  if (!s.networks.length) return f;
  const where = nearNode ? `près du node ${nearNode}` : 'à l\'endroit du Wizard';
  if (s.show) {
    if (!s.show.seen) add('warn', `Wizard : l'antenne (${s.show.ssid || s.show.bssid}) n'est pas entendue ${where}`, `Depuis une minute le Wizard ne voit pas le réseau du show en 2,4 GHz alors qu'il entend ${s.networks.length} réseau(x). Un node placé ici ne s'associerait pas, ou décrocherait.`, 'rapprocher / réorienter l\'antenne, ou en ajouter une');
    else if (s.show.signal < -75) add('warn', `Wizard : antenne reçue à ${s.show.signal} dBm ${where}`, 'Signal faible pour un ESP32 (même antenne 3 dBi que le Wizard) : débit bas, retransmissions, décrochages probables sous charge.', 'rapprocher / réorienter, ou ajouter une antenne');
    else if (s.show.signal < -68) add('info', `Wizard : antenne reçue à ${s.show.signal} dBm ${where}`, 'Signal moyen : correct au repos, à surveiller sous charge.', '');
  }
  if (s.ours) {
    const loudNear = s.networks.filter(n => !n.isShow && n.band === '2g' && n.signal != null && n.signal >= -60 && Math.abs(n.channel - s.ours) <= 4);
    for (const n of loudNear.slice(0, 3)) add('warn', `Wizard : réseau fort « ${n.ssid || n.bssid} » à ${n.signal} dBm sur le canal ${n.channel}`, `${n.channel === s.ours ? 'Sur ton canal' : `À ${Math.abs(n.channel - s.ours)} canal(aux) du tien (${s.ours})`} ${where} : il partage le temps d'antenne avec les nodes de cette zone${n.width === 40 ? ', et en 40 MHz' : ''}.`, s.recommended !== s.ours ? `mesurer ici puis passer au canal ${s.recommended} (le moins chargé vu d'ici)` : '');
    const wide = s.networks.filter(n => !n.isShow && n.band === '2g' && n.width === 40 && n.signal != null && n.signal >= -70 && Math.abs(n.channel - s.ours) <= 6);
    if (wide.length && !loudNear.some(n => n.width === 40)) add('info', `Wizard : ${wide.length} réseau(x) 40 MHz proche(s) du canal ${s.ours}`, `${wide.map(n => `${n.ssid || n.bssid} (${n.channel}, ${n.signal} dBm)`).join(', ')} : un réseau 40 MHz en 2,4 GHz occupe deux tiers de la bande.`, '');
    if (s.recommended && s.recommended !== s.ours) add('info', `Wizard : vu d'ici, canal ${s.recommended} moins chargé que ${s.ours}`, `Occupation ${((s.candidates.find(c => c.channel === s.recommended) || {}).score || 0).toFixed(2)} contre ${((s.occupancy.find(o => o.channel === s.ours) || {}).score || 0).toFixed(2)} ${where}. Le scan de l'antenne reste la référence : comparer les deux avant de changer.`, '');
  }
  if (nearNode && s.show && s.show.seen && typeof nodeRssi === 'function') {
    const r = nodeRssi(nearNode);
    if (r != null && Math.abs(r - s.show.signal) >= 12) add('info', `Wizard : node ${nearNode} à ${r} dBm, Wizard à côté à ${s.show.signal} dBm`, `Écart ${Math.abs(r - s.show.signal)} dB entre le node et le Wizard posé à côté : antenne du node masquée (boîtier, métal, LED), ou node mal placé par rapport à l'endroit mesuré.`, 'déplacer / dégager l\'antenne du node');
  }
  return f;
}

function setNear(mac) { nearNode = mac ? String(mac).toLowerCase().replace(/[^0-9a-f:]/g, '') || null : null; return nearNode; }

function hint() {
  if (!pythonCmd && depsChecked) return { level: 'bad', text: 'Python 3 manquant : bouton « Installer les prérequis »' };
  if (depsChecked && !bleakVersion) return { level: 'bad', text: 'module bleak manquant : bouton « Installer les prérequis »' };
  if (!proc) return config.enabled && st.error ? { level: 'warn', text: st.error } : { level: 'muted', text: config.enabled ? 'arrêté' : 'désactivé' };
  if (st.state === 'connected') return { level: 'ok', text: `connecté${st.device && st.device.name ? ' à ' + st.device.name : ''}${st.device && st.device.battery != null ? ' · batterie ' + st.device.battery + ' %' : ''}` };
  if (st.state === 'connecting' || st.state === 'scanning' || st.state === 'starting') return { level: 'info', text: st.error && /non vu/.test(st.error) ? 'Wizard non vu : appuyer sur son bouton pour le réveiller, couper le Bluetooth du téléphone… nouvel essai en cours' : 'recherche du Wizard en Bluetooth…' };
  if (st.state === 'disconnected') return { level: 'warn', text: st.error && /non vu/.test(st.error) ? 'Wizard non vu : appuyer sur son bouton pour le réveiller, couper le Bluetooth du téléphone… nouvel essai en cours' : 'déconnecté, reconnexion…' };
  if (st.state === 'error') return { level: 'bad', text: st.error || 'erreur' };
  if (st.state === 'stopping') return { level: 'muted', text: 'arrêt…' };
  return { level: 'muted', text: st.state };
}
function status() {
  return { enabled: !!config.enabled, running: !!proc, state: st.state, hint: hint(), deps: depsStatus(), mode: st.mode, error: st.error, bleak: st.bleak, device: st.device, startedAt: st.startedAt, lastEventAt: st.lastEventAt, events: st.events,
    python: pythonCmd ? pythonCmd.join(' ') : null, pythonVersion, pythonError, bridge: fs.existsSync(BRIDGE), config: { enabled: !!config.enabled, address: config.address, name: config.name, autoconnect: !!config.autoconnect, python: config.python || null }, nearNode, heard: heard().length, known: nets.size, stderr: st.stderr.slice(-3) };
}
function view(apLastScan) { return { ...status(), snapshot: snapshot(), compare: compare(apLastScan), surveys: surveys(50) }; }

module.exports = { setConfigFile, loadConfig, saveConfig, resolvePython, deps, install, toggle, start, stop, kill, devices, snapshot, compare, survey, surveys, removeSurvey, liveHistory, waterfall, audit, setNear, status, view, _onEvent: onEvent, _waterRow: waterRow };
