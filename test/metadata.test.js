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
  const [o] = md.parse({ outputs: [{ i: 0, product: 'PAS UN ID', fixture: 'abc', instance: 5 }] }).outputs;
  assert.strictEqual(o.product, null, 'un marqueur ne contient ni espace ni majuscule');
  assert.strictEqual(o.fixture, null, 'un numéro non numérique est ignoré');
  assert.strictEqual(o.instance, 5, 'le reste de la sortie survit');
});

test('le marqueur de produit est opaque : uuid ou ancien id court', () => {
  // Fleet écrit des uuid depuis la v3 du catalogue, mais des nodes patchés avant
  // portent encore un identifiant à 2 caractères. Les deux doivent survivre à un
  // aller-retour, sinon une simple relecture effacerait le marqueur.
  const uid = '7c1a8f3e-2b40-4d11-9a55-0e6f2c9b7d31';
  const b = md.build({ outputs: [{ i: 0, product: uid, prev: 4 }, { i: 1, product: '0a' }] });
  assert.strictEqual(b.outputs[0].product, uid);
  assert.strictEqual(b.outputs[1].product, '0a');
});

test('la révision du produit voyage avec le marqueur', () => {
  // c'est ce qui permet de dire « ce node a été patché avec la rev 3, le
  // catalogue est en rev 5 » au lieu de supposer que le nom suffit.
  const uid = '7c1a8f3e-2b40-4d11-9a55-0e6f2c9b7d31';
  const b = md.build({ outputs: [{ i: 0, product: uid, prev: 3 }] });
  assert.strictEqual(b.outputs[0].prev, 3);
  assert.strictEqual(md.parse(b).outputs[0].prev, 3);
  const orphan = md.build({ outputs: [{ i: 0, prev: 3, fixture: 1 }] });
  assert.strictEqual(orphan.outputs[0].prev, undefined, 'sans produit, une révision ne veut rien dire');
});

test('un champ vidé DISPARAÎT, il ne devient pas zéro', () => {
  // Number(null) et Number('') valent 0 : sans garde, retirer une sortie de sa
  // fixture la déclarait dans une « fixture 0 » qui n'existe nulle part, et
  // relire le fichier réinventait un ordre d'affichage à chaque tour.
  const once = md.build({ outputs: [{ i: 0, pin: '2', fixture: 101 }] });
  assert.strictEqual(once.outputs[0].order, undefined, 'aucun ordre n\'a été demandé');
  const twice = md.build(md.parse(once));
  assert.strictEqual(twice.outputs[0].order, undefined, 'un aller-retour n\'en invente pas non plus');
  assert.strictEqual(twice.outputs[0].fixture, 101);
  const cleared = md.build({ outputs: [{ i: 0, pin: '2', fixture: null, product: 'ab' }] });
  assert.strictEqual(cleared.outputs[0].fixture, undefined, 'fixture retirée = clé absente, pas 0');
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

// ── v2 : le rattachement électrique ────────────────────────────────────────
test('le bloc power vit au premier rang, pas dans extra', () => {
  // `extra` est la boîte de ce que Fleet ne connaît PAS, et build() l'étale en
  // tête SANS validation. Y ranger ce que Fleet écrit lui-même mentirait sur sa
  // fonction — et un satellite doit trouver le rattachement dans le schéma.
  const uid = '8f97e081-6f2f-4133-bd38-ec7a91f2439b';
  const b = md.build({ power: { psu: uid, rail: 'A', driver: 'ab' } });
  assert.deepStrictEqual(b.power, { psu: uid, rail: 'A', driver: 'ab' });
  assert.strictEqual(b.formatVersion, 2);
  assert.strictEqual(md.parse(b).extra.power, undefined, 'jamais recopié dans extra');
});

test('un rail sans alimentation ne désigne rien, et n\'est pas écrit', () => {
  assert.strictEqual(md.build({ power: { rail: 'A' } }).power, undefined);
  assert.strictEqual(md.build({ power: { psu: 'ab', rail: 'A' } }).power.rail, 'A');
});

test('une sortie peut avoir son alimentation à elle, et elle l\'emporte', () => {
  // le cas des grandes structures dont deux rubans partent sur un autre circuit
  const b = md.build({ power: { psu: 'aa' }, outputs: [{ i: 0, psu: 'bb', rail: 'B' }] });
  assert.strictEqual(b.power.psu, 'aa');
  assert.strictEqual(b.outputs[0].psu, 'bb');
  assert.strictEqual(b.outputs[0].rail, 'B');
});

test('une v1 donne un power vide, pas une erreur', () => {
  const v1 = { format: 'wled-fleet-node', formatVersion: 1, group: 'Boule', outputs: [{ i: 0, product: 'ab' }] };
  const m = md.parse(v1);
  assert.deepStrictEqual(m.power, { psu: null, rail: null, driver: null });
  assert.strictEqual(md.build(m).power, undefined, 'et rien n\'est ajouté au fichier');
  assert.strictEqual(md.build(m).outputs[0].product, 'ab', 'le reste survit');
});

test('un node qui n\'a QUE du power n\'est pas considéré comme vide', () => {
  // sinon la restauration après reformatage le laisserait tomber
  assert.strictEqual(md.isEmpty(md.parse({ power: { psu: 'ab' } })), false);
  assert.strictEqual(md.isEmpty(md.empty()), true);
});
