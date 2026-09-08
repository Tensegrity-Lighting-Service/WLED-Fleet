// drivers.js : le catalogue de cartes.
//
// Une fiche de carte sert à répondre à une question que le node ne sait pas
// poser : ce budget de courant est-il réaliste pour ce matériel ? Elle doit donc
// pouvoir rester incomplète sans faire dire n'importe quoi à Fleet — c'est le
// fil rouge de ces cas.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const drv = require('../drivers');

const D = (board = {}) => ({ ref: { brand: 'QuinLED', model: 'Dig-Quad' }, board });
const NODE = (over = {}) => ({
  info: { arch: 'esp32', release: 'ESP32', ...(over.info || {}) },
  cfg: { hw: { led: { ins: over.ins || [{ pin: [16] }, { pin: [3] }] } } },
});

test('une fiche vide ne produit AUCUN constat', () => {
  // c'est la règle qui décide si les avertissements de Fleet seront lus. Un
  // premier driver saisi à moitié ne doit rien affirmer.
  assert.deepStrictEqual(drv.mismatches(drv.normDriver(D()), NODE()), []);
  assert.strictEqual(drv.normDriver(D()).board.outputs, 0, '0 = non renseigné');
});

test('la puce déclarée est confrontée à ce que le node répond', () => {
  const d = drv.normDriver(D({ mcu: 'esp32' }));
  assert.deepStrictEqual(drv.mismatches(d, NODE()), []);
  const m = drv.mismatches(d, NODE({ info: { arch: 'ESP32-C3' } }));
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].code, 'driver-mcu');
});

test('plus de sorties configurées que la carte n\'en a', () => {
  const m = drv.mismatches(drv.normDriver(D({ outputs: 1 })), NODE());
  assert.deepStrictEqual(m.map(x => x.code), ['driver-outputs']);
  assert.deepStrictEqual(drv.mismatches(drv.normDriver(D({ outputs: 4 })), NODE()), [], 'moins de sorties que la carte est normal');
});

test('le brochage est comparé par POSITION, et seulement là où il est déclaré', () => {
  // tout Fleet désigne une sortie par sa place dans hw.led.ins ; comparer par
  // GPIO donnerait des faux positifs dès qu'on réordonne les sorties.
  const d = drv.normDriver(D({ outputs: 4, pins: [{ gpio: [16] }, { gpio: [3] }, {}, {}] }));
  assert.deepStrictEqual(drv.mismatches(d, NODE()), []);
  const m = drv.mismatches(d, NODE({ ins: [{ pin: [16] }, { pin: [12] }] }));
  assert.deepStrictEqual(m.map(x => x.code), ['driver-pin']);
  assert.strictEqual(m[0].i, 1);
  // une position sans GPIO déclaré ne dit rien
  const partiel = drv.normDriver(D({ outputs: 4, pins: [{ gpio: [16] }] }));
  assert.deepStrictEqual(drv.mismatches(partiel, NODE({ ins: [{ pin: [16] }, { pin: [99] }] })), []);
});

test('un GPIO hors plage est écarté, pas conservé', () => {
  const d = drv.normDriver(D({ outputs: 2, pins: [{ gpio: [16, 99, -1, 16] }, { gpio: 'x' }] }));
  assert.deepStrictEqual(d.board.pins[0].gpio, [16], 'dédoublonné et borné à 0..48');
  assert.deepStrictEqual(d.board.pins[1].gpio, []);
});

test('les tensions d\'entrée sont des cases : une carte en accepte souvent deux', () => {
  const d = drv.normDriver(D({ inputVolts: [12, 5, 5, 99] }));
  assert.deepStrictEqual(d.board.inputVolts, [5, 12], 'dédoublonné, trié, hors catalogue écarté');
  assert.deepStrictEqual(drv.normDriver(D()).board.inputVolts, [], 'vide = non renseigné, jamais « c\'est bon »');
});

test('les courants sont en ampères ici, alors que WLED parle en milliampères', () => {
  const d = drv.normDriver(D({ maxA: 8, maxAPerOut: 2.5 }));
  assert.strictEqual(d.board.maxA, 8);
  assert.strictEqual(d.board.maxAPerOut, 2.5);
  assert.strictEqual(drv.normDriver(D()).board.maxA, null, 'non renseigné, pas zéro : zéro voudrait dire « ne laisse rien passer »');
});

test('la révision suit le matériel, pas le nom', () => {
  let { store, product } = drv.upsert({ drivers: [] }, D({ outputs: 4, maxA: 8 }));
  assert.strictEqual(product.rev, 1);
  ({ store, product } = drv.upsert(store, { ...D({ outputs: 4, maxA: 8 }), ref: { brand: 'QuinLED', model: 'Dig-Quad', note: 'v3' }, uid: product.uid }));
  assert.strictEqual(product.rev, 1);
  ({ product } = drv.upsert(store, { ...D({ outputs: 4, maxA: 16 }), uid: product.uid }));
  assert.strictEqual(product.rev, 2, 'doubler le courant admissible change ce qu\'on peut affirmer');
});

test('normaliser deux fois ne perd rien — l\'aller-retour du magasin', () => {
  const une = drv.normDriver(D({ mcu: 'esp32', outputs: 4, maxA: 8, inputVolts: [5, 12], pins: [{ gpio: [16], label: 'O1' }] }));
  assert.deepStrictEqual(drv.normDriver(une).board, une.board);
  assert.deepStrictEqual(drv.normStore({ drivers: [une] }).drivers[0].board, une.board);
});

test('une fiche illisible ne fait pas tomber le catalogue', () => {
  assert.strictEqual(drv.normStore({ drivers: [{ ref: {} }, D({ outputs: 2 })] }).drivers.length, 1);
  assert.deepStrictEqual(drv.normStore(null).drivers, []);
});

// ── Déduire les cartes de la flotte ────────────────────────────────────────
// Les cas viennent tous du relevé réel des 16 nodes : c'est là que se trouvent
// les pièges, pas dans un jeu de données inventé.
const N = (name, o) => ({ ip: '10.0.0.1', name, arch: 'esp32', release: 'ESP32_Ethernet', brand: 'WLED', product: 'FOSS', eth: 0, outputs: [[16], [12], [4]], ...o });

test('deux nodes du même modèle se regroupent malgré un Ethernet déclaré d\'un seul côté', () => {
  // relevé réel : les deux QUADRI tournent le MÊME build, mais JAR déclare
  // eth 13 et COUR 0, et leurs GPIO 3 et 4 sont intervertis. Les séparer
  // créerait deux fiches pour une seule carte — et le doublon serait durable,
  // puisque des nodes le porteraient.
  const [c, ...reste] = drv.guess([
    N('QUADRI_JAR', { eth: 13, outputs: [[16], [12], [2], [4]] }),
    N('QUADRI_COUR', { eth: 0, outputs: [[16], [12], [4], [2]] }),
  ]);
  assert.strictEqual(reste.length, 0, 'un seul modèle, pas deux');
  assert.strictEqual(c.nodes.length, 2);
  assert.strictEqual(c.board.eth, 13, 'un type déclaré quelque part l\'emporte sur « aucun »');
  assert.ok(c.ecarts.some(e => e.code === 'eth-partiel'), 'et l\'écart est signalé, pas avalé');
  assert.ok(c.ecarts.some(e => e.code === 'gpio-ordre'), 'le brochage interverti aussi');
});

test('le nom vient de la carte quand elle s\'annonce elle-même', () => {
  const [c] = drv.guess([N('CASQUE', { arch: 'ESP32-C3', release: '', brand: 'www.athom.tech', product: 'Athom_USB_Controller', outputs: [[10]] })]);
  assert.strictEqual(c.ref.brand, 'www.athom.tech');
  assert.strictEqual(c.ref.model, 'Athom_USB_Controller');
});

test('à défaut, le type d\'Ethernet de WLED nomme de vraies cartes', () => {
  const [c] = drv.guess([N('JAR', { eth: 13 })]);
  assert.strictEqual(c.ref.model, 'LILYGO T-ETH-POE');
});

test('sans rien pour la nommer, la fiche reste descriptive et à corriger', () => {
  const [c] = drv.guess([N('boule', { arch: 'ESP32-C3', release: '', eth: 0, outputs: [[10]] })]);
  assert.strictEqual(c.ref.model, 'ESP32-C3 · 1 sortie');
  assert.strictEqual(c.ref.source, 'à nommer');
});

test('des puces différentes ne se regroupent JAMAIS', () => {
  const g = drv.guess([N('a', { arch: 'ESP32-C3', outputs: [[10]] }), N('b', { arch: 'ESP32-S3', outputs: [[10]] })]);
  assert.strictEqual(g.length, 2);
});

test('rien d\'électrique n\'est inventé', () => {
  // une fiche qui prétendrait connaître les tensions ou le courant ferait dire
  // des faussetés au rapport de cohérence, alors que rien de tout cela n'existe
  // dans la configuration d'un node.
  const [c] = drv.guess([N('x')]);
  for (const champ of ['inputVolts', 'maxA', 'maxAPerOut', 'fused', 'levelShifter']) {
    assert.strictEqual(c.board[champ], undefined, `${champ} ne se déduit pas d'un node`);
  }
  // et la fiche normalisée qui en sort est bien vide de ce côté
  const fiche = drv.normDriver({ ref: { brand: '', model: 'X' }, board: c.board });
  assert.deepStrictEqual(fiche.board.inputVolts, []);
  assert.strictEqual(fiche.board.maxA, null);
});

test('un node sans aucune sortie câblée ne produit pas de fiche', () => {
  assert.deepStrictEqual(drv.guess([N('vide', { outputs: [] })]), []);
  assert.deepStrictEqual(drv.guess([]), []);
  assert.deepStrictEqual(drv.guess(null), []);
});

test('guess ne modifie pas ce qu\'on lui donne', () => {
  const src = [N('a'), N('b', { eth: 13 })];
  const avant = JSON.stringify(src);
  drv.guess(src);
  assert.strictEqual(JSON.stringify(src), avant);
});

test('les modèles les plus répandus arrivent en tête', () => {
  const g = drv.guess([
    N('seul', { arch: 'ESP32-S3', outputs: [[1]] }),
    N('a', { arch: 'ESP32-C3', outputs: [[10]] }), N('b', { arch: 'ESP32-C3', outputs: [[10]] }), N('c', { arch: 'ESP32-C3', outputs: [[10]] }),
  ]);
  assert.strictEqual(g[0].nodes.length, 3);
});
