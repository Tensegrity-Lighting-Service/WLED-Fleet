// Métadonnées Fleet stockées SUR LE NODE — /fleet.json sur son système de fichiers
//
// Pourquoi un fichier, et pas un champ de la config :
//
//  - Les trois champs MQTT détournés (client id 40 car., device topic 32,
//    group topic 32) sont à l'étroit : 21 caractères libres mesurés sur la
//    flotte réelle, à partager entre profils, sorties non câblées et fixtures.
//    Ça ne tient pas, et c'est positionnel donc fragile.
//  - hw.led.ins[].text NE PERSISTE PAS sur une sortie numérique. Vérifié dans le
//    source WLED (v16.0.1) : cfg.cpp:1017 sérialise bus->getCustomText(), mais
//    bus_manager.h:148 renvoie une chaîne VIDE dans la classe de base, et
//    BusDigital ne la redéfinit pas. Seuls BusNetwork (où c'est l'hôte de
//    destination DDP/Art-Net — y écrire casserait la sortie) et BusPlaceholder
//    la stockent. Le champ ressort donc toujours vide sur un ruban.
//
// WLED expose son système de fichiers : POST /upload (multipart) écrit sur
// LittleFS (wled_server.cpp:206-217), et GET /<fichier> le ressert (:141).
// Un JSON structuré, de la place réelle, qui survit au redémarrage, et que
// n'importe quel outil peut relire d'un GET — sans passer par Fleet.
//
// Noms de fichiers à ne JAMAIS utiliser (WLED leur donne un sens) :
//   cfg.json      -> déclenche un redémarrage (wled_server.cpp:227)
//   presets.json  -> touche presetsModifiedTime
//   palette*.json -> recharge les palettes
// D'où « /fleet.json », neutre.
//
// PRINCIPE : ce fichier est un INDICE. hw.led.ins[] reste la vérité sur ce qui
// est câblé ; fleet.json dit ce que Fleet en pense (produit, fixture, ordre).
// Un node jamais vu par Fleet n'en a pas, et tout doit continuer à marcher.
'use strict';

const FILE = '/fleet.json';
const FORMAT = 'wled-fleet-node';
const FORMAT_VERSION = 1;

const isProductId = v => typeof v === 'string' && /^[0-9a-z]{2}$/.test(v);
const intOrNull = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };

// Une sortie est repérée par sa POSITION dans hw.led.ins, comme le reste de
// Fleet. On mémorise aussi son `pin` : si quelqu'un réordonne les sorties hors
// de Fleet, la position ment mais le pin permet de s'en rendre compte.
function normOutput(o, i) {
  const x = o || {};
  return {
    i,                                   // position dans hw.led.ins
    pin: typeof x.pin === 'string' ? x.pin : null,
    product: isProductId(x.product) ? x.product : null,
    fixture: intOrNull(x.fixture),       // Fixture ID console
    instance: intOrNull(x.instance) || 0,// décalage de la 1re instance dans la fixture
    order: intOrNull(x.order),           // ordre voulu par l'utilisateur
    unused: !!x.unused,                  // sortie déclarée non câblée
    note: typeof x.note === 'string' ? x.note.slice(0, 80) : '',
  };
}

// Lit ce qu'un node renvoie. Tolère tout : fichier absent, JSON cassé, version
// future — dans tous ces cas on retombe sur « ce node n'a rien à dire ».
function parse(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (d.format && d.format !== FORMAT) return empty();
  const outs = Array.isArray(d.outputs) ? d.outputs : [];
  return {
    format: FORMAT,
    formatVersion: Number(d.formatVersion) || FORMAT_VERSION,
    group: typeof d.group === 'string' ? d.group : '',
    updatedAt: Number(d.updatedAt) || 0,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy.slice(0, 40) : '',
    outputs: outs.map(normOutput),
    // Tout ce qu'une version plus récente aurait ajouté est conservé tel quel.
    // « extra » est lui-même réservé pour que parse() soit idempotent : sans ça,
    // parse(parse(x)) imbriquerait extra dans extra et perdrait les clés.
    extra: { ...(d.extra && typeof d.extra === 'object' && !Array.isArray(d.extra) ? d.extra : {}),
      ...Object.fromEntries(Object.entries(d).filter(([k]) => !RESERVED.includes(k))) },
  };
}
const RESERVED = ['format', 'formatVersion', 'group', 'updatedAt', 'updatedBy', 'outputs', 'extra'];
const empty = () => ({ format: FORMAT, formatVersion: FORMAT_VERSION, group: '', updatedAt: 0, updatedBy: '', outputs: [], extra: {} });

// Ce qu'on écrit sur le node. Les sorties sans rien à dire sont omises : un node
// dont aucune sortie n'est renseignée n'a pas besoin du fichier du tout.
function build(meta) {
  const m = parse(meta);
  const outputs = m.outputs
    .map(o => {
      const out = { i: o.i };
      if (o.pin) out.pin = o.pin;
      if (o.product) out.product = o.product;
      if (o.fixture !== null) out.fixture = o.fixture;
      if (o.instance) out.instance = o.instance;
      if (o.order !== null) out.order = o.order;
      if (o.unused) out.unused = true;
      if (o.note) out.note = o.note;
      return out;
    })
    .filter(o => Object.keys(o).length > 1); // « i » seul ne dit rien
  return { ...m.extra, format: FORMAT, formatVersion: FORMAT_VERSION, group: m.group, updatedAt: Date.now(), updatedBy: m.updatedBy, outputs };
}
const isEmpty = meta => { const b = build(meta); return !b.outputs.length && !b.group; };

// ── Fixtures ────────────────────────────────────────────────────────────────
// Une fixture n'est stockée nulle part en tant que telle : elle se RECONSTITUE
// en balayant les sorties qui partagent le même numéro, triées par instance.
// Rien de central, donc rien à resynchroniser, et un node lu seul reste
// compréhensible. Les membres peuvent vivre sur des nodes différents ; leurs
// plages d'adresses ne sont alors pas contiguës.
//
// outputs = [{ ip, node, index, len, fixture, instance, from, to }]
function fixtures(outputs) {
  const by = new Map();
  for (const o of outputs || []) {
    if (!Number.isFinite(o.fixture) || o.fixture === null) continue;
    if (!by.has(o.fixture)) by.set(o.fixture, []);
    by.get(o.fixture).push(o);
  }
  return [...by.entries()].map(([id, members]) => {
    members.sort((a, b) => (a.instance || 0) - (b.instance || 0));
    const nodes = [...new Set(members.map(m => m.ip))];
    return { id, members, nodes, pixels: members.reduce((n, m) => n + (m.len || 0), 0), split: nodes.length > 1 };
  }).sort((a, b) => a.id - b.id);
}

// premier numéro libre, proposé à l'utilisateur et modifiable
const nextFixtureId = outputs => {
  const used = new Set((outputs || []).map(o => o.fixture).filter(Number.isFinite));
  let n = 1; while (used.has(n)) n++; return n;
};

// ── Transport ───────────────────────────────────────────────────────────────
// Lecture : GET /fleet.json (WLED sert les fichiers de son FS,
// wled_server.cpp:141). Absent = node jamais vu par Fleet, ce n'est pas une
// erreur. Écriture : POST /upload en multipart, comme le fait déjà firmware.js
// pour l'OTA (wled_server.cpp:206). L'upload exige le PIN des réglages quand le
// node en a un : WLED répond alors 401, qu'on remonte en clair.
const http = require('http');

function read(ip, timeoutMs = 4000) {
  const [host, port] = String(ip).split(':');
  return new Promise(resolve => {
    const req = http.get({ host, port: port ? +port : 80, path: FILE, timeout: timeoutMs }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(empty()); // pas encore de métadonnées : normal
        if (res.statusCode !== 200) return resolve(empty());
        try { resolve(parse(JSON.parse(d))); } catch { resolve(empty()); } // fichier abîmé : on repart de zéro
      });
    });
    req.on('error', () => resolve(empty()));
    req.on('timeout', () => { req.destroy(); resolve(empty()); });
  });
}

function write(ip, meta, timeoutMs = 8000) {
  const [host, port] = String(ip).split(':');
  const data = Buffer.from(JSON.stringify(build(meta), null, 1));
  const boundary = '----wledfleet' + Date.now().toString(16);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${FILE.replace(/^\//, '')}"\r\nContent-Type: application/json\r\n\r\n`);
  const body = Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: port ? +port : 80, method: 'POST', path: '/upload', timeout: timeoutMs,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('node protégé par un PIN : le déverrouiller pour écrire ses métadonnées'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} en écrivant ${FILE} : ${String(d).slice(0, 120)}`));
        resolve({ ok: true, bytes: data.length });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout en écrivant ${FILE}`)));
    req.end(body);
  });
}

module.exports = { FILE, FORMAT, FORMAT_VERSION, parse, build, empty, isEmpty, fixtures, nextFixtureId, read, write };
