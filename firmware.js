// Offline firmware repository + OTA flashing for WLED nodes.
//
// Two halves, as designed:
//   1. Catalogue: what exists online (GitHub releases of wled/WLED). Refreshed
//      on demand, persisted to firmware/index.json so it is still usable when
//      the venue has no internet. Assets are downloaded into firmware/<tag>/
//      and become "local" (available offline).
//   2. Comparison: for each node, its platform (info.release, e.g.
//      "ESP32_Ethernet") and version (info.ver) are matched against the
//      catalogue -> latest stable / beta for that platform, whether an update
//      is available, and whether the matching .bin is already in the store.
//
// Flashing only ever uses a LOCAL file (multipart POST to http://<node>/update,
// the same mechanism as the WLED web UI / iOS app). Nodes are flashed one at a
// time to keep the Wi-Fi calm.
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { dataFile, codeFile, DATA_DIR, CODE_DIR } = require('./paths');

const REPO = 'wled/WLED';
const STORE = dataFile('firmware');
const INDEX = path.join(STORE, 'index.json');
const ASSET_RE = /^WLED_([^_]+)_(.+)\.bin$/; // WLED_<version>_<env>.bin (skip .bin.gz)

// ── Version helpers ──────────────────────────────────────────────────────────
function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?/.exec(String(v || ''));
  if (!m) return null;
  return { n: [+m[1], +m[2], +m[3]], pre: m[4] || null, s: `${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}` };
}
// >0 when a is newer than b. A release without pre-tag beats any pre-release of the same number.
function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] - B.n[i];
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  return String(A.pre || '').localeCompare(String(B.pre || ''));
}

// ── Catalogue (index.json) ───────────────────────────────────────────────────
// { refreshedAt, releases: [{tag, name, prerelease, publishedAt, assets: [{name, version, env, size, url}]}] }
let catalogue = { refreshedAt: null, releases: [] };
let lastRefreshError = '';

let indexMtime = 0;
// (Re)load index.json when it changed on disk: several servers (real fleet,
// mock/dev run) share the same store, so a refresh done by one is seen by all.
function loadIndex() {
  try {
    const mt = fs.statSync(INDEX).mtimeMs;
    if (mt === indexMtime) return;
    catalogue = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    indexMtime = mt;
  } catch { /* first run */ }
}
function saveIndex() {
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(catalogue, null, 2));
  try { indexMtime = fs.statSync(INDEX).mtimeMs; } catch { /* ignore */ }
}
function localPath(tag, asset) { return path.join(STORE, tag.replace(/[^\w.-]+/g, '_'), asset); }
function isLocal(tag, asset) {
  try { return fs.statSync(localPath(tag, asset)).size > 0; } catch { return false; }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wled-fleet', Accept: 'application/vnd.github+json' }, timeout: 15000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub HTTP ${res.statusCode}: ${d.slice(0, 120)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout GitHub')); });
  });
}

// Pull the release list from GitHub and merge it into the catalogue (releases
// already known are kept even if GitHub stops listing them).
async function refresh() {
  try {
    const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
    const byTag = new Map(catalogue.releases.map(r => [r.tag, r]));
    for (const r of list) {
      const assets = r.assets.map(a => {
        const m = ASSET_RE.exec(a.name);
        return m ? { name: a.name, version: m[1], env: m[2], size: a.size, url: a.browser_download_url } : null;
      }).filter(Boolean);
      byTag.set(r.tag_name, { tag: r.tag_name, name: r.name, prerelease: !!r.prerelease, publishedAt: r.published_at, assets });
    }
    catalogue.releases = [...byTag.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    catalogue.refreshedAt = Date.now();
    lastRefreshError = '';
    saveIndex();
  } catch (e) {
    lastRefreshError = e.message;
    throw e;
  }
}

// Register a hand-supplied .bin (custom build, vendor fork…) under the "local" tag.
function addLocal(filename, buffer) {
  const m = ASSET_RE.exec(filename);
  if (!m) throw new Error('nom attendu : WLED_<version>_<plateforme>.bin');
  const tag = 'local';
  fs.mkdirSync(path.dirname(localPath(tag, filename)), { recursive: true });
  fs.writeFileSync(localPath(tag, filename), buffer);
  let rel = catalogue.releases.find(r => r.tag === tag);
  if (!rel) { rel = { tag, name: 'Fichiers locaux', prerelease: false, publishedAt: new Date().toISOString(), assets: [], local: true }; catalogue.releases.unshift(rel); }
  rel.assets = rel.assets.filter(a => a.name !== filename);
  rel.assets.push({ name: filename, version: m[1], env: m[2], size: buffer.length, url: null });
  saveIndex();
}

// ── Downloads (online -> store) ──────────────────────────────────────────────
const downloads = new Map(); // "tag/asset" -> {status, received, size, error}

function follow(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('trop de redirections'));
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'wled-fleet' }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(follow(res.headers.location, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} sur ${url}`)); }
      resolve(res);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout téléchargement')); });
  });
}

async function download(tag, assetName) {
  const rel = catalogue.releases.find(r => r.tag === tag);
  const asset = rel && rel.assets.find(a => a.name === assetName);
  if (!asset) throw new Error(`asset inconnu ${tag}/${assetName}`);
  if (!asset.url) throw new Error('asset local, rien à télécharger');
  const key = `${tag}/${assetName}`;
  if (downloads.get(key) && downloads.get(key).status === 'downloading') return downloads.get(key);
  const st = { status: 'downloading', received: 0, size: asset.size, error: '' };
  downloads.set(key, st);
  const dest = localPath(tag, assetName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  (async () => {
    try {
      const res = await follow(asset.url);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest + '.part');
        res.on('data', c => { st.received += c.length; });
        res.pipe(out);
        out.on('finish', resolve); out.on('error', reject); res.on('error', reject);
      });
      const size = fs.statSync(dest + '.part').size;
      if (asset.size && size !== asset.size) throw new Error(`taille ${size} ≠ attendue ${asset.size}`);
      fs.renameSync(dest + '.part', dest);
      st.status = 'done';
      console.log(`firmware: ${key} téléchargé (${size} o)`);
    } catch (e) {
      st.status = 'error'; st.error = e.message;
      try { fs.unlinkSync(dest + '.part'); } catch { /* none */ }
      console.log(`firmware: ${key} ÉCHEC ${e.message}`);
    }
  })();
  return st;
}

function remove(tag, assetName) {
  try { fs.unlinkSync(localPath(tag, assetName)); } catch { /* absent */ }
  downloads.delete(`${tag}/${assetName}`);
}

// ── Comparison ───────────────────────────────────────────────────────────────
// Per platform (env): latest stable + latest pre-release known, with local state.
function latestFor(env) {
  let stable = null, pre = null;
  for (const r of catalogue.releases) {
    if (r.tag === 'local') continue;
    const a = r.assets.find(x => x.env === env);
    if (!a) continue;
    const cand = { tag: r.tag, asset: a.name, version: a.version, size: a.size, prerelease: r.prerelease, local: isLocal(r.tag, a.name) };
    if (r.prerelease) { if (!pre || cmpVer(cand.version, pre.version) > 0) pre = cand; }
    else if (!stable || cmpVer(cand.version, stable.version) > 0) stable = cand;
  }
  return { stable, pre };
}

// ── La plateforme d'un node qui ne la dit pas ──────────────────────────────
// WLED n'expose `info.release` que depuis la 0.15. Avant, le champ n'existe
// pas : la colonne Plateforme restait vide, « Dernière stable » affichait « ? »,
// et AUCUNE mise à jour n'était proposée — précisément sur les nodes qui en
// auraient le plus besoin. Le garde-fou du flash comparait lui aussi l'asset à
// un `release` absent et refusait tout.
//
// On la déduit donc de ce que ces firmwares annoncent quand même :
//
//   arch          "ESP32-C3", "ESP32-S3", "esp32"
//   getflash      taille du flash en octets
//   e32flashtext  mode du flash ("DIO", "QIO"…)
//
// ── Ce qu'on refuse de faire ──────────────────────────────────────────────
// Deviner quand c'est ambigu. Un esp32 nu peut être une build ESP32, ESP32_8M,
// ESP32_16M ou ESP32_Ethernet, et rien dans /json/info ne les départage — la
// preuve, un des QUADRI de la flotte tourne une build Ethernet en déclarant
// « aucun » comme type de carte. Envoyer la mauvaise build à un node PoE lui
// ferait perdre son réseau, et il faudrait aller le rechercher à la main.
// Quand ça ne se tranche pas, on rend null et on le dit.
const MB = 1024 * 1024;

function guessEnv(info) {
  const i = info || {};
  if (i.release) return { env: i.release, deduit: false, pourquoi: '' };
  const arch = String(i.arch || '');
  const flash = Number(i.getflash) || (Number(i.flash) ? Number(i.flash) * MB : 0);
  const mode = String(i.e32flashtext || '').toUpperCase();
  const mo = flash ? Math.round(flash / MB) : 0;

  // ESP32-C3 : une seule build 4 Mo côté WLED en dio, et c'est justement celle
  // que le platformio.ini d'amont désigne comme « requise pour les mises à jour
  // OTA depuis une version antérieure, qui utilisait dio ».
  if (/^ESP32-C3$/i.test(arch) && mo === 4 && (mode === 'DIO' || mode === '')) {
    return { env: 'ESP32-C3', deduit: true, pourquoi: `ESP32-C3, ${mo} Mo, mode ${mode || 'inconnu'}` };
  }
  // ESP32-S3 : les variantes se distinguent par la taille ET le mode. On ne
  // tranche que la 4 Mo qspi, la seule qui soit sans ambiguïté.
  if (/^ESP32-S3$/i.test(arch) && mo === 4 && mode !== 'OPI') {
    return { env: 'ESP32-S3_4M_qspi', deduit: true, pourquoi: `ESP32-S3, ${mo} Mo, qspi` };
  }
  return { env: null, deduit: false, pourquoi: arch ? `${arch}${mo ? ', ' + mo + ' Mo' : ''} : plusieurs builds possibles, à choisir à la main` : 'plateforme inconnue' };
}

// What the grid shows for one node.
function assess(info) {
  if (!info) return null;
  loadIndex();
  const g = guessEnv(info);
  const env = g.env, ver = info.ver;
  const { stable, pre } = latestFor(env);
  const fork = info.repo && info.repo !== REPO ? info.repo : null;
  return {
    env, ver, fork, envDeduit: g.deduit, envPourquoi: g.pourquoi,
    latest: stable ? stable.version : null,
    latestTag: stable ? stable.tag : null,
    latestLocal: stable ? stable.local : false,
    available: stable ? cmpVer(stable.version, ver) > 0 : null,
    pre: pre ? { version: pre.version, tag: pre.tag, local: pre.local } : null,
    status: !stable ? (env ? 'plateforme inconnue' : (g.pourquoi ? 'plateforme à choisir' : '?')) : cmpVer(stable.version, ver) > 0 ? (stable.local ? 'MAJ prête' : 'MAJ à télécharger') : cmpVer(stable.version, ver) < 0 ? 'plus récent que le dépôt' : 'à jour',
  };
}

// Public view of the catalogue for the UI: releases x assets with local flags,
// restricted (optionally) to the platforms present in the fleet.
function view(envsInUse) {
  loadIndex();
  return {
    repo: REPO,
    refreshedAt: catalogue.refreshedAt,
    lastRefreshError,
    store: STORE,
    downloads: Object.fromEntries(downloads),
    releases: catalogue.releases.map(r => ({
      tag: r.tag, name: r.name, prerelease: r.prerelease, publishedAt: r.publishedAt, isLocalTag: r.tag === 'local',
      assets: r.assets
        .filter(a => !envsInUse || envsInUse.has(a.env) || r.tag === 'local')
        .map(a => ({ ...a, local: isLocal(r.tag, a.name), inUse: !!(envsInUse && envsInUse.has(a.env)) })),
      assetCount: r.assets.length,
      localCount: r.assets.filter(a => isLocal(r.tag, a.name)).length,
    })),
  };
}

// ── OTA flash (store -> node) ────────────────────────────────────────────────
// onProgress(sentBytes, totalBytes) is called as the multipart body is pushed
// to the node (the ESP writes flash while receiving, so this IS the flash
// progress; WLED itself reports nothing until the final page).
function flashFile(ip, filePath, onProgress = () => {}, timeoutMs = 180000) {
  const [host, port] = ip.split(':');
  const data = fs.readFileSync(filePath);
  const boundary = '----wledfleet' + Date.now().toString(16);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="update"; filename="${path.basename(filePath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, data, tail]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: port ? +port : 80, method: 'POST', path: '/update', timeout: timeoutMs,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const text = d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
        if (/fail|error|lock|not allowed/i.test(text) && !/success/i.test(text)) return reject(new Error(text.slice(0, 200)));
        resolve(text.slice(0, 200));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout upload OTA')));
    req.on('error', reject);
    // push the body in 16 kB slices, waiting for the socket to drain, so that
    // progress reflects what the node has really accepted
    const CHUNK = 16384; let off = 0;
    const pump = () => {
      while (off < body.length) {
        const slice = body.subarray(off, Math.min(off + CHUNK, body.length));
        off += slice.length;
        const ok = req.write(slice);
        onProgress(off, body.length);
        if (!ok) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

module.exports = { loadIndex, refresh, download, remove, addLocal, assess, latestFor, view, localPath, isLocal, flashFile, cmpVer, guessEnv, ASSET_RE, catalogue: () => catalogue };
