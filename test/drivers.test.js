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
