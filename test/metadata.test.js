// metadata.js : le fichier /fleet.json déposé sur chaque node, et la
// reconstitution des fixtures. Les cas viennent des contraintes réelles : un
// node peut n'avoir jamais vu Fleet, renvoyer un fichier cassé, ou avoir été
// écrit par une version plus récente.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const md = require('../metadata');

test('aller-retour d\'un node complet', () => {
  const src = {
    format: 'wled-fleet-node', formatVersion: 1, group: 'Boule',
    outputs: [
      { i: 0, pin: '2', product: 'a0', fixture: 101, instance: 0 },
      { i: 1, pin: '3', product: 'a0', fixture: 101, instance: 36 },
    ],
  };
  const built = md.build(src);
  const back = md.parse(built);
  assert.strictEqual(back.group, 'Boule');
  assert.strictEqual(back.outputs.length, 2);
  assert.deepStrictEqual(
    back.outputs.map(o => [o.i, o.product, o.fixture, o.instance]),
    [[0, 'a0', 101, 0], [1, 'a0', 101, 36]]);
});

test('un node jamais vu par Fleet ne dit rien, et ne casse rien', () => {
  for (const bad of [undefined, null, '', 42, [], {}, { format: 'autre-chose' }]) {
    const m = md.parse(bad);
    assert.strictEqual(m.outputs.length, 0, `entrée ${JSON.stringify(bad)}`);
    assert.strictEqual(m.group, '');
  }
});

test('les valeurs par défaut ne sont pas écrites — le fichier reste petit', () => {
  const b = md.build({ outputs: [{ i: 0, product: 'a0', instance: 0, unused: false }] });
  assert.deepStrictEqual(b.outputs, [{ i: 0, product: 'a0' }],
    'instance 0 et « câblée » sont les défauts : les écrire ne sert à rien');
});

test('une sortie sans rien à dire est omise', () => {
  const b = md.build({ outputs: [{ i: 0 }, { i: 1, fixture: 7 }, { i: 2 }] });
  assert.deepStrictEqual(b.outputs.map(o => o.i), [1], 'seule la sortie renseignée est écrite');
});

test('un node sans aucune métadonnée n\'a pas besoin du fichier', () => {
  assert.strictEqual(md.isEmpty({ outputs: [{ i: 0 }, { i: 1 }] }), true);
  assert.strictEqual(md.isEmpty({ outputs: [{ i: 0, fixture: 1 }] }), false);
  assert.strictEqual(md.isEmpty({ group: 'Boule', outputs: [] }), false);
});

test('les clés d\'une version plus récente sont CONSERVÉES', () => {
  // un Fleet plus récent, ou un autre outil, a ajouté « zones »
  const src = { format: 'wled-fleet-node', formatVersion: 1, zones: [{ a: 1 }], outputs: [{ i: 0, fixture: 3 }] };
  const back = md.build(md.parse(src));
  assert.deepStrictEqual(back.zones, [{ a: 1 }], 'ne pas effacer ce qu\'on ne comprend pas');
  assert.strictEqual(back.outputs[0].fixture, 3);
});

test('parse est idempotent — régression : extra s\'imbriquait dans extra', () => {
  const src = { format: 'wled-fleet-node', zones: [1], outputs: [{ i: 0, fixture: 3 }] };
  const once = md.parse(src), twice = md.parse(md.parse(src));
  assert.deepStrictEqual(twice.extra, once.extra, 'reparser ne doit rien perdre ni imbriquer');
  assert.deepStrictEqual(once.extra, { zones: [1] });
});

test('valeurs illisibles ignorées sans faire tomber la sortie', () => {
  const [o] = md.parse({ outputs: [{ i: 0, product: 'TROPLONG', fixture: 'abc', instance: 5 }] }).outputs;
  assert.strictEqual(o.product, null, 'un id produit fait 2 caractères');
  assert.strictEqual(o.fixture, null, 'un numéro non numérique est ignoré');
  assert.strictEqual(o.instance, 5, 'le reste de la sortie survit');
});

test('le pin est mémorisé pour détecter un réordonnancement fait hors de Fleet', () => {
  const b = md.build({ outputs: [{ i: 0, pin: '2', fixture: 1 }] });
  assert.strictEqual(b.outputs[0].pin, '2');
});

test('une fixture se reconstitue par numéro, triée par instance', () => {
  const outs = [
    { ip: '10.0.0.2', len: 36, fixture: 101, instance: 36 },
    { ip: '10.0.0.1', len: 36, fixture: 101, instance: 0 },
    { ip: '10.0.0.1', len: 12, fixture: null },
  ];
  const fx = md.fixtures(outs);
  assert.strictEqual(fx.length, 1, 'une sortie sans fixture n\'appartient à aucune');
  assert.strictEqual(fx[0].id, 101);
  assert.deepStrictEqual(fx[0].members.map(m => m.instance), [0, 36]);
  assert.strictEqual(fx[0].pixels, 72);
});

test('une fixture sur deux nodes est signalée : plages disjointes', () => {
  const [fx] = md.fixtures([
    { ip: '10.0.0.1', len: 36, fixture: 7, instance: 0 },
    { ip: '10.0.0.2', len: 36, fixture: 7, instance: 36 },
  ]);
  assert.deepStrictEqual(fx.nodes, ['10.0.0.1', '10.0.0.2']);
  assert.strictEqual(fx.split, true, 'plusieurs points de patch à la console');
});

test('une fixture sur un seul node n\'est pas « split »', () => {
  const [fx] = md.fixtures([
    { ip: '10.0.0.1', len: 36, fixture: 7, instance: 0 },
    { ip: '10.0.0.1', len: 36, fixture: 7, instance: 36 },
  ]);
  assert.strictEqual(fx.split, false);
});

test('le prochain numéro de fixture proposé est le premier libre', () => {
  assert.strictEqual(md.nextFixtureId([{ fixture: 1 }, { fixture: 3 }, { fixture: null }]), 2);
  assert.strictEqual(md.nextFixtureId([]), 1);
});

test('le nom de fichier évite ceux auxquels WLED donne un sens', () => {
  assert.strictEqual(md.FILE, '/fleet.json');
  for (const reserved of ['/cfg.json', '/presets.json', '/palette0.json']) {
    assert.notStrictEqual(md.FILE, reserved, `${reserved} a un effet de bord dans WLED`);
  }
});
