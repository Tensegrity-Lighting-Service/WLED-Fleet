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

// ── Déduire les cartes de ce qui est déjà en ligne ─────────────────────────
// Saisir une fiche par carte quand la flotte les décrit déjà serait du travail
// pour rien. WLED annonce sa puce, sa variante de build, son type d'Ethernet et
// le GPIO de chaque sortie : de quoi reconnaître un MODÈLE, pas de quoi le
// qualifier électriquement — ça, ça vient de la fiche constructeur.
//
// ── Le piège, rencontré sur la vraie flotte ───────────────────────────────
// Deux nodes qui portent la MÊME carte peuvent se présenter différemment. Les
// deux QUADRI tournent le même build « ESP32_Ethernet », mais l'un déclare
// eth = 13 (LILYGO T-ETH-POE) et l'autre 0 (aucun), et leurs GPIO 3 et 4 sont
// intervertis. Une signature naïve créerait donc deux fiches pour un seul
// modèle — et ce doublon-là est durable, puisque des nodes le porteraient.
//
// D'où deux règles : le regroupement ignore l'ORDRE des GPIO et le type
// d'Ethernet, et tout ce qui diffère à l'intérieur d'un groupe est RENDU, pour
// que la décision reste à l'utilisateur. Rien n'est créé sans validation.
const NO_BRAND = new Set(['wled', 'foss', '']);          // ce que le build générique annonce

// Un node tel que le serveur le résume : ce qu'on peut lire sans rien supposer.
//   { ip, name, arch, release, brand, product, eth, outputs: [[gpio…], …] }
function guess(nodes) {
  const groups = new Map();
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    const outs = (Array.isArray(n && n.outputs) ? n.outputs : [])
      .map(p => [...new Set((Array.isArray(p) ? p : [p]).map(Number).filter(Number.isInteger))]);
    if (!outs.length) continue;                          // rien de câblé : rien à déduire
    const mcu = String((n.arch) || '').trim();
    const release = String((n.release) || '').trim();
    // clé volontairement insensible à l'ordre des sorties et muette sur eth
    const key = [mcu, release, outs.length, outs.map(g => g.join('/')).sort().join(',')].join('|');
    if (!groups.has(key)) groups.set(key, { key, mcu, release, outputs: outs.length, vus: [] });
    groups.get(key).vus.push({
      ip: n.ip || '', name: String(n.name || n.ip || '').trim(),
      eth: Number.isInteger(Number(n.eth)) ? Number(n.eth) : 0,
      brand: String(n.brand || '').trim(), product: String(n.product || '').trim(),
      gpio: outs,
    });
  }

  return [...groups.values()].map(g => {
    const ecarts = [];
    // Ethernet : « 0 » veut dire « pas configuré », pas « la carte n'en a
    // pas ». Un type déclaré quelque part dans le groupe l'emporte donc, et
    // l'écart est signalé — c'est peut-être un node resté en WiFi par erreur.
    const eths = [...new Set(g.vus.map(v => v.eth))];
    const eth = eths.find(e => e !== 0) || 0;
    if (eths.length > 1) {
      const sans = g.vus.filter(v => v.eth === 0).map(v => v.name);
      ecarts.push({ code: 'eth-partiel', msg: `${ETH_TYPES[eth] || 'Ethernet'} déclaré sur ${g.vus.length - sans.length} node(s), aucun sur ${sans.join(', ')}` });
    }
    // Brochage : on retient l'arrangement le plus répandu, et on dit lesquels
    // en sortent. Interverti n'est pas faux — mais ça se sait.
    const parOrdre = new Map();
    for (const v of g.vus) {
      const k = v.gpio.map(x => x.join('/')).join(',');
      if (!parOrdre.has(k)) parOrdre.set(k, []);
      parOrdre.get(k).push(v);
    }
    const ordres = [...parOrdre.entries()].sort((a, b) => b[1].length - a[1].length);
    const gpio = ordres[0][1][0].gpio;
    if (ordres.length > 1) {
      ecarts.push({ code: 'gpio-ordre', msg: 'brochage dans un autre ordre sur ' + ordres.slice(1).map(([k, vs]) => `${vs.map(v => v.name).join(', ')} (${k})`).join(' · ') });
    }
    // Le nom : d'abord ce que la carte dit d'elle-même — certaines s'annoncent
    // vraiment (Athom). Sinon la table Ethernet de WLED, qui nomme de vraies
    // cartes. Sinon un libellé descriptif, à corriger à la main.
    const nomme = g.vus.find(v => !NO_BRAND.has(v.brand.toLowerCase()) && v.product);
    const ref = nomme ? { brand: nomme.brand, model: nomme.product, source: 'la carte se nomme elle-même' }
      : eth && ETH_TYPES[eth] ? { brand: '', model: ETH_TYPES[eth], source: 'type Ethernet déclaré' }
        : { brand: '', model: `${g.mcu || 'carte'} · ${g.outputs} sortie${g.outputs > 1 ? 's' : ''}`, source: 'à nommer' };

    return {
      key: g.key, ref,
      board: {
        mcu: g.mcu, release: g.release, eth, outputs: g.outputs,
        pins: gpio.map((gp, i) => ({ i, gpio: gp })),
        // rien d'électrique : ce n'est nulle part dans la configuration d'un
        // node, et une fiche à moitié remplie qui prétendrait le contraire
        // ferait dire des faussetés au rapport de cohérence
      },
      nodes: g.vus.map(v => v.name),
      ecarts,
    };
  }).sort((a, b) => b.nodes.length - a.nodes.length);
}

module.exports = {
  FORMAT, FORMAT_VERSION, NODE_FORMAT,
  normDriver: cat.normOne, normStore: cat.normStore, upsert: cat.upsert, retire: cat.retire,
  resolve: cat.resolve, find: cat.resolve, revState: cat.revState,
  nodeSlice: cat.nodeSlice, parseNodeSlice: cat.parseNodeSlice, compareNodeSlice: cat.compareNodeSlice,
  label: cat.label, substance, normBoard, mismatches, guess, catalog: cat,
};
