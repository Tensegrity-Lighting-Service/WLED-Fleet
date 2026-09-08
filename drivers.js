// Catalogue de cartes — le « qui pilote ».
//
// Comme pour les alimentations, ce fichier décrit un MODÈLE : « QuinLED
// Dig-Quad », pas le boîtier accroché au portique. Ce qu'un exemplaire a de
// particulier — son adresse, son groupe, ce qui est branché dessus — vit sur le
// node lui-même, pas ici.
//
// ── Ce qu'une carte apporte que le node ne dit pas ────────────────────────
// WLED annonce sa puce (`info.arch`) et sa variante de build (`info.release`),
// mais rien du matériel autour : combien de sorties sont réellement câblées,
// sur quels GPIO, ce que le bornier et les pistes supportent, s'il y a un
// adaptateur de niveau. Ce sont pourtant ces limites-là qui décident si un
// budget de courant est réaliste ou fantaisiste — un `maxpwr` de 16 A sur une
// carte prévue pour 8 ne se voit nulle part aujourd'hui.
'use strict';

const { makeCatalog, num } = require('./catalog');
const { VOLTAGES, ETH_TYPES } = require('./columns');

const FORMAT = 'wled-fleet-drivers';
const FORMAT_VERSION = 1;
const NODE_FORMAT = 'wled-fleet-node-library';   // même fichier embarqué que les produits

const ampsOrNull = v => (v === null || v === undefined || v === '' ? null
  : (Number.isFinite(Number(v)) ? Math.min(200, Math.max(0, Math.round(Number(v) * 10) / 10)) : null));

// Le brochage, une entrée par sortie physique.
//
// Indexé par POSITION (`i`), jamais par GPIO : tout Fleet désigne une sortie par
// sa place dans hw.led.ins, et c'est ce qui permet de comparer le brochage
// déclaré ici au `pin` réellement lu sur le node — donc de repérer une carte mal
// identifiée ou un câblage qui a bougé.
function normPins(list, outputs) {
  const out = [];
  for (let i = 0; i < outputs; i++) {
    const p = (Array.isArray(list) ? list : [])[i] || {};
    out.push({
      i,
      // un tableau, comme hw.led.ins[].pin : certains types de bus en utilisent
      // deux (horloge + données)
      gpio: [...new Set((Array.isArray(p.gpio) ? p.gpio : [p.gpio]).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 48))],
      label: String(p.label || '').trim().slice(0, 20),
      // 3,3 V direct ou passé par un adaptateur : c'est la première chose qu'on
      // regarde quand un long câble donne des pixels qui scintillent
      level: p.level === '5v' ? '5v' : '3v3',
      maxA: ampsOrNull(p.maxA),
    });
  }
  return out;
}

function normBoard(x) {
  const b = x.board || {};
  // 0 = non renseigné. Une fiche vide ne doit produire AUCUN constat : sinon
  // le premier driver saisi à moitié fait dire à Fleet des choses fausses, et
  // plus personne ne lit ses avertissements.
  const outputs = num(b.outputs, 0, 0, 16);
  return {
    board: {
      // à rapprocher de info.arch et info.release, lus sur le node : une carte
      // déclarée ESP32 sur un node qui répond ESP32-C3 est une erreur de fiche
      mcu: String(b.mcu || '').trim().slice(0, 20),
      release: String(b.release || '').trim().slice(0, 30),
      // reprend la table de WLED, qui nomme déjà de vraies cartes
      eth: ETH_TYPES[Number(b.eth)] !== undefined ? Number(b.eth) : 0,
      outputs,
      pins: normPins(b.pins, outputs),
      // tensions d'entrée admises : une carte accepte souvent 5 ET 12 V, d'où
      // des cases et non un choix unique. Vide = non renseigné.
      inputVolts: [...new Set((Array.isArray(b.inputVolts) ? b.inputVolts : []).map(Number).filter(v => VOLTAGES.includes(v)))].sort((a, b2) => a - b2),
      // ce que le bornier, les pistes et le fusible laissent passer — en
      // ampères, alors que WLED raisonne en milliampères. La conversion se fait
      // à un seul endroit, dans le module de cohérence.
      maxA: ampsOrNull(b.maxA),
      maxAPerOut: ampsOrNull(b.maxAPerOut),
      fused: !!b.fused,
      levelShifter: !!b.levelShifter,
      // certaines cartes embarquent leur alimentation : elles n'ont alors pas
      // besoin d'être rattachées à une alimentation extérieure
      psuBuiltin: !!b.psuBuiltin,
      note: String(b.note || '').trim().slice(0, 120),
    },
  };
}

const substance = p => JSON.stringify(p.board);

const cat = makeCatalog({
  kind: 'driver',
  collection: 'drivers',
  format: FORMAT,
  formatVersion: FORMAT_VERSION,
  nodeFormat: NODE_FORMAT,
  fallbackSlug: 'carte',
  norm: normBoard,
  substance,
});

// Ce que le node répond correspond-il à la carte déclarée ? On ne conclut que
// sur ce qui est renseigné : une fiche incomplète ne doit pas produire de faux
// constats, seulement moins de constats.
function mismatches(driver, node) {
  const out = [];
  if (!driver || !node) return out;
  const b = driver.board;
  const info = node.info || {};
  const ins = (node.cfg && node.cfg.hw && node.cfg.hw.led && node.cfg.hw.led.ins) || [];
  if (b.mcu && info.arch && String(info.arch).toLowerCase() !== b.mcu.toLowerCase()) {
    out.push({ code: 'driver-mcu', msg: `carte déclarée ${b.mcu}, le node répond ${info.arch}` });
  }
  if (b.release && info.release && info.release !== b.release) {
    out.push({ code: 'driver-release', msg: `variante attendue ${b.release}, le node porte ${info.release}` });
  }
  if (b.outputs && ins.length > b.outputs) {
    out.push({ code: 'driver-outputs', msg: `${ins.length} sorties configurées pour une carte qui en a ${b.outputs}` });
  }
  // brochage : on compare position par position, et seulement là où la fiche
  // déclare quelque chose
  ins.forEach((bus, i) => {
    const want = b.pins[i]; if (!want || !want.gpio.length) return;
    const got = (bus.pin || []).map(Number);
    if (got.length && got[0] !== want.gpio[0]) {
      out.push({ code: 'driver-pin', i, msg: `sortie ${i + 1} sur GPIO ${got.join('/')}, la carte l'attend sur ${want.gpio.join('/')}` });
    }
  });
  return out;
}

module.exports = {
  FORMAT, FORMAT_VERSION, NODE_FORMAT,
  normDriver: cat.normOne, normStore: cat.normStore, upsert: cat.upsert, retire: cat.retire,
  resolve: cat.resolve, find: cat.resolve, revState: cat.revState,
  nodeSlice: cat.nodeSlice, parseNodeSlice: cat.parseNodeSlice, compareNodeSlice: cat.compareNodeSlice,
  label: cat.label, substance, normBoard, mismatches, catalog: cat,
};
