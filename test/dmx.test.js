// dmx.js : l'arithmétique du patch. Les cas viennent de la vraie flotte (boules de
// 36 px tassées dans un univers, lianes de 170 px) et des deux bugs corrigés le
// 2026-09-08 : conflits comparés au seul numéro d'univers, et capacité du premier
// univers supposée pleine même quand l'adresse de départ n'est pas 1.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dmx = require('../dmx');

const node = (name, uni, addr, lens, opts = {}) => {
  let start = opts.starts ? null : 0;
  const ins = lens.map((len, i) => {
    const s = opts.starts ? opts.starts[i] : start;
    if (!opts.starts) start += len;
    return { pin: [String(2 + i)], start: s, len, type: 22 };
  });
  return { name, plan: dmx.plan({ mode: opts.mode || 4, uni, addr, ins, ignored: opts.ignored || [] }) };
};

test('adresse console d\'une boule de 36 px (Multi RGB)', () => {
  const p = dmx.plan({ mode: 4, uni: 121, addr: 109, ins: [{ pin: [2], start: 0, len: 36, type: 22 }] });
  assert.strictEqual(p.outputs[0].from, '121.109');
  assert.strictEqual(p.outputs[0].to, '121.216', '36 px × 3 canaux = 108 canaux, 109 à 216');
  assert.strictEqual(p.outputs[0].universes, 1);
});

test('deux nodes qui se partagent un univers à des adresses distinctes ne sont PAS en conflit', () => {
  // le faux positif qui empêchait de tasser 4 boules par univers
  const a = node('boule 02', 121, 109, [36]);
  const b = node('boule 03', 121, 217, [36]);
  assert.strictEqual(a.plan.outputs[0].to, '121.216');
  assert.strictEqual(b.plan.outputs[0].from, '121.217');
  assert.deepStrictEqual(dmx.conflicts([a, b]), [], 'collées au canal près : aucun conflit');
});

test('un vrai recouvrement de canaux est signalé, avec sa plage', () => {
  const a = node('boule 02', 121, 109, [36]); // 109 → 216
  const b = node('boule 03', 121, 200, [36]); // 200 → 307
  const c = dmx.conflicts([a, b]);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].universe, 121);
  assert.strictEqual(c[0].from, 200);
  assert.strictEqual(c[0].to, 216, 'seuls 200→216 se marchent dessus');
  assert.deepStrictEqual(c[0].nodes.sort(), ['boule 02', 'boule 03']);
});

test('quatre boules de 36 px tiennent dans un univers sans conflit', () => {
  const boules = [1, 109, 217, 325].map((addr, i) => node(`boule ${i + 1}`, 121, addr, [36]));
  assert.deepStrictEqual(dmx.conflicts(boules), []);
  assert.strictEqual(boules[3].plan.outputs[0].to, '121.432');
});

test('une sortie « non utilisée » ne réserve aucun canal', () => {
  // le cas des quadri : sorties 3 et 4 débranchées, un autre node occupe ces univers
  const jar = node('QUADRI_JAR', 191, 1, [170, 170, 170, 170], { ignored: [2, 3] });
  const cour = node('QUADRI_COUR', 193, 1, [170, 170, 170, 170]);
  assert.deepStrictEqual(dmx.conflicts([jar, cour]), [], 'les univers 193-194 sont libérés par les sorties décochées');
  // les mêmes sorties rebranchées : le conflit réapparaît
  const jarFull = node('QUADRI_JAR', 191, 1, [170, 170, 170, 170]);
  assert.ok(dmx.conflicts([jarFull, cour]).length >= 1, 'sans le drapeau, 193 et 194 sont bien en conflit');
});

test('les sorties non utilisées sont repérées par POSITION, pas par index de départ', () => {
  // ⚡ Patcher renumérote les départs : un drapeau par index de départ change de ligne
  const ins = [{ pin: [2], start: 0, len: 200, type: 22 }, { pin: [3], start: 340, len: 170, type: 22 }, { pin: [4], start: 680, len: 170, type: 22 }];
  const p = dmx.plan({ mode: 4, uni: 1, addr: 1, ins, ignored: [2] });
  assert.strictEqual(p.outputs[2].ignored, true, 'la 3e sortie est la sortie décochée');
  assert.strictEqual(p.outputs[1].ignored, false);
});

test('le premier univers porte moins de pixels quand l\'adresse n\'est pas 1', () => {
  const L = dmx.locator(4, 121, 109);
  assert.strictEqual(L.pxPerUni, 170);
  assert.strictEqual(L.firstUniPx, 134, '(512 - 108) / 3 arrondi en bas');
  assert.deepStrictEqual(L.locate(134), { u: 122, ch: 1 }, 'le pixel 134 ouvre l\'univers suivant');
});

test('« démarre sur un début d\'univers » ne se calcule pas au modulo', () => {
  // le test  start % 170 === 0  marquait  ▲ à cheval  une sortie parfaitement alignée
  assert.strictEqual(dmx.startsUniverse(134, 4, 109), true, '134 = début de l\'univers 122');
  assert.strictEqual(dmx.startsUniverse(170, 4, 109), false, '170 tombe au milieu de l\'univers 122');
  // à l'adresse 1, les deux façons de calculer coïncident
  assert.strictEqual(dmx.startsUniverse(170, 4, 1), true);
  assert.strictEqual(dmx.startsUniverse(171, 4, 1), false);
});

test('une liane de 4 × 170 px occupe exactement 4 univers pleins', () => {
  const p = node('QUADRI', 193, 1, [170, 170, 170, 170], { starts: [0, 170, 340, 510] }).plan;
  assert.strictEqual(p.universesUsed, 4);
  assert.deepStrictEqual(p.outputs.map(o => o.from), ['193.1', '194.1', '195.1', '196.1']);
  assert.deepStrictEqual(p.outputs.map(o => o.to), ['193.510', '194.510', '195.510', '196.510']);
  assert.ok(p.outputs.every(o => o.aligned && !o.straddles));
});

test('des sorties chaînées (pixels qui se suivent) forment une plage continue', () => {
  // tournette int + ext : 2 × 36 px collés = une seule fixture de 72 px à la console
  const p = node('Tournette', 121, 1, [36, 36]).plan;
  assert.strictEqual(p.outputs[0].from, '121.1');
  assert.strictEqual(p.outputs[0].to, '121.108');
  assert.strictEqual(p.outputs[1].from, '121.109', 'la 2e sortie reprend au canal suivant, sans trou');
  assert.strictEqual(p.outputs[1].to, '121.216');
});

test('Multi RGBW : 128 px par univers et le blanc compté', () => {
  const p = dmx.plan({ mode: 6, uni: 5, addr: 1, ins: [{ pin: [2], start: 0, len: 128, type: 30 }] });
  assert.strictEqual(p.pxPerUni, 128);
  assert.strictEqual(p.outputs[0].to, '5.512');
  assert.strictEqual(p.outputs[0].universes, 1);
});

test('Multi DRGB : le canal de dimmer appartient au node', () => {
  const p = dmx.plan({ mode: 5, uni: 3, addr: 10, ins: [{ pin: [2], start: 0, len: 4, type: 22 }] });
  assert.strictEqual(p.hasDimmer, true);
  assert.strictEqual(p.outputs[0].from, '3.11', 'les pixels commencent après le canal de dimmer');
  assert.strictEqual(p.occupancy[0].from, 10, 'mais la réservation part du canal de dimmer');
});

test('mode non « Multi » : pas de mapping pixel par pixel', () => {
  const p = dmx.plan({ mode: 1, uni: 1, addr: 1, ins: [{ pin: [2], start: 0, len: 36, type: 22 }] });
  assert.strictEqual(p.multi, false);
  assert.match(p.note, /Multi/);
});

test('une sortie à cheval sur deux univers est signalée comme telle', () => {
  const p = dmx.plan({ mode: 4, uni: 10, addr: 1, ins: [{ pin: [2], start: 0, len: 200, type: 22 }] });
  assert.strictEqual(p.outputs[0].straddles, true);
  assert.strictEqual(p.outputs[0].universes, 2);
  assert.strictEqual(p.outputs[0].from, '10.1');
  assert.strictEqual(p.outputs[0].to, '11.90', '30 pixels débordent sur l\'univers 11 : 30 × 3 = 90 canaux');
});
