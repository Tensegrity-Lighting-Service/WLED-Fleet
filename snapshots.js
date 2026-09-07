// Fleet configuration snapshots: offline store + export/import + restore.
//
// A snapshot captures, for every reachable node, what WLED itself considers
// its configuration: cfg.json (GET /json/cfg) and presets.json
// (GET /presets.json), plus identity (name, MAC, IP, version, platform) and the
// live state. Files live in snapshots/<id>.json and are plain JSON, so they
// can be exported, mailed, versioned, and imported on another machine.
//
// Restore uses the same mechanism as WLED's own Security > Backup & Restore
// page: the file is uploaded to the node's filesystem through POST /upload
// (multipart, field "data", filename "/cfg.json" or "/presets.json"), then the
// node is rebooted so cfg.json is re-read. Nodes are matched by MAC first
// (IPs change), IP as a fallback.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = path.join(__dirname, 'snapshots');
const safeId = s => String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 80);

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }
function fileOf(id) { return path.join(DIR, safeId(id) + '.json'); }

function list() {
  ensureDir();
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    try {
      const st = fs.statSync(path.join(DIR, f));
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      return { id: f.replace(/\.json$/, ''), name: j.name || f, createdAt: j.createdAt || st.mtimeMs, imported: !!j.importedAt, nodes: (j.nodes || []).length, size: st.size,
        nodeNames: (j.nodes || []).map(n => n.name || n.ip) };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}
function load(id) {
  const j = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  if (!Array.isArray(j.nodes)) throw new Error('fichier de sauvegarde invalide');
  return j;
}
function remove(id) { try { fs.unlinkSync(fileOf(id)); } catch { /* absent */ } }

// Capture: getJson(ip, path) is the fleet server's HTTP helper (returns {json}).
async function capture(name, recs, getJson) {
  ensureDir();
  const createdAt = Date.now();
  const nodes = [];
  for (const rec of recs) {
    if (!rec.meta.online || !rec.info) continue;
    const ip = rec.meta.ip;
    const entry = { ip, mac: rec.info.mac, name: rec.info.name, ver: rec.info.ver, release: rec.info.release, state: rec.state, cfg: null, presets: null, error: '' };
    try { entry.cfg = (await getJson(ip, '/json/cfg', 5000)).json; } catch (e) { entry.error += `cfg: ${e.message} `; }
    try { entry.presets = (await getJson(ip, '/presets.json', 5000)).json; } catch (e) { entry.error += `presets: ${e.message} `; }
    nodes.push(entry);
  }
  const id = `${new Date(createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${safeId(name || 'flotte')}`;
  const snap = { format: 'wled-fleet-snapshot', version: 1, name: name || 'flotte', createdAt, nodes };
  fs.writeFileSync(fileOf(id), JSON.stringify(snap, null, 1));
  return { id, name: snap.name, createdAt, nodes: nodes.length, errors: nodes.filter(n => n.error).map(n => `${n.name || n.ip}: ${n.error}`) };
}

// Import a file produced by export (or hand-made with the same shape).
function importFile(buffer, filename) {
  ensureDir();
  let j;
  try { j = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('JSON illisible'); }
  if (j.format !== 'wled-fleet-snapshot' || !Array.isArray(j.nodes)) throw new Error('ce fichier n\'est pas une sauvegarde wled-fleet');
  j.importedAt = Date.now();
  const base = safeId(path.basename(String(filename || 'import'), '.json')) || 'import';
  let id = base, n = 1;
  while (fs.existsSync(fileOf(id))) id = `${base}_${++n}`;
  fs.writeFileSync(fileOf(id), JSON.stringify(j, null, 1));
  return { id, name: j.name, nodes: j.nodes.length };
}

// Which fleet node does a snapshot entry correspond to? MAC first, then IP.
function matchNode(entry, recs) {
  const mac = String(entry.mac || '').toLowerCase();
  return recs.find(r => r.info && r.info.mac && mac && r.info.mac.toLowerCase() === mac) || recs.find(r => r.meta.ip === entry.ip) || null;
}

// Compare a snapshot with the live fleet on the catalogue's cfg/state columns.
function diff(snap, recs, columns) {
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const cols = columns.filter(c => /^(cfg|state)\./.test(c.path) && c.watch !== false);
  return snap.nodes.map(entry => {
    const rec = matchNode(entry, recs);
    if (!rec) return { ip: entry.ip, mac: entry.mac, name: entry.name, present: false, changes: [] };
    const fake = { cfg: entry.cfg, state: entry.state };
    const changes = [];
    for (const c of cols) {
      const a = getPath(fake, c.path), b = getPath(rec, c.path);
      if (a === undefined && b === undefined) continue;
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ col: c.id, label: c.label, saved: a, live: b });
    }
    // LED outputs are not a column value but matter a lot for a restore
    const outA = JSON.stringify(((entry.cfg || {}).hw || {}).led && entry.cfg.hw.led.ins), outB = JSON.stringify(((rec.cfg || {}).hw || {}).led && rec.cfg.hw.led.ins);
    if (outA !== outB) changes.push({ col: 'outputs', label: 'Sorties LED', saved: rec.derived && rec.derived.outputs ? '(différent)' : '', live: rec.derived && rec.derived.outputs });
    return { ip: entry.ip, mac: entry.mac, name: entry.name, present: true, liveIp: rec.meta.ip, online: rec.meta.online, presetsSaved: !!entry.presets, changes };
  });
}

// Upload a file into the node's filesystem (WLED /upload, field "data").
function uploadFile(ip, filename, content, timeoutMs = 20000) {
  const [host, port] = ip.split(':');
  const data = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
  const boundary = '----wledfleet' + Date.now().toString(16);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: port ? +port : 80, method: 'POST', path: '/upload', timeout: timeoutMs,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode} ${d.slice(0, 120)}`)); else resolve(d.replace(/<[^>]+>/g, ' ').trim().slice(0, 120)); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout upload')));
    req.on('error', reject);
    req.end(body);
  });
}

// Restore selected entries of a snapshot onto their nodes.
// what = { cfg: true, presets: true }, reboot = true -> reboot after cfg
async function restore(snap, targets, what, reboot, recs, postJson, onProgress = () => {}) {
  const results = [];
  for (const key of targets) {
    const entry = snap.nodes.find(n => (n.mac && n.mac.toLowerCase() === String(key).toLowerCase()) || n.ip === key);
    if (!entry) { results.push({ key, ok: false, error: 'absent de la sauvegarde' }); continue; }
    const rec = matchNode(entry, recs);
    const r = { key, name: entry.name, ok: false, ip: rec ? rec.meta.ip : entry.ip, done: [], error: '' };
    if (!rec || !rec.meta.online) { r.error = 'node hors ligne / introuvable'; results.push(r); onProgress(r); continue; }
    try {
      if (what.presets && entry.presets) { await uploadFile(r.ip, '/presets.json', entry.presets); r.done.push('presets.json'); }
      if (what.cfg && entry.cfg) {
        // never push the Wi-Fi/Ethernet block of another machine by accident: keep the node's own network settings
        const cfg = JSON.parse(JSON.stringify(entry.cfg));
        if (what.keepNetwork !== false && rec.cfg) { cfg.nw = rec.cfg.nw; cfg.eth = rec.cfg.eth; cfg.ap = rec.cfg.ap; }
        await uploadFile(r.ip, '/cfg.json', cfg); r.done.push('cfg.json');
        if (reboot) { await postJson(r.ip, '/json/state', { rb: true }, 5000); r.done.push('reboot'); }
      }
      r.ok = true;
    } catch (e) { r.error = e.message; }
    results.push(r); onProgress(r);
  }
  return results;
}

module.exports = { list, load, remove, capture, importFile, diff, restore, matchNode, fileOf };
