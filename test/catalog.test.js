// catalog.js : la mécanique commune aux trois catalogues de Fleet.
//
// Ces cas s'appuient sur un type INVENTÉ, pas sur les produits LED. C'est
// volontaire : test/library.test.js couvre déjà les produits, et le refaire ici
// ne prouverait pas que le module est générique. Ce qu'on veut fixer, ce sont
// les quatre règles qui protègent ce qui est écrit sur les nodes, quel que soit
// le type de l'objet catalogué.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeCatalog, isUid, slugify, normRef } = require('../catalog');

// un type de test : une pièce quelconque avec deux réglages
const widgets = makeCatalog({
  kind: 'widget', collection: 'widgets',
  format: 'test-widgets', formatVersion: 1, nodeFormat: 'test-widgets-node',
  fallbackSlug: 'widget',
  norm: x => ({ spec: { taille: Number(x.spec && x.spec.taille) || 1, couleur: String((x.spec && x.spec.couleur) || 'noir') } }),
  substance: p => JSON.stringify(p.spec),
});
// un second type, pour vérifier qu'ils ne se marchent pas dessus
const gadgets = makeCatalog({
  kind: 'gadget', collection: 'gadgets',
  format: 'test-gadgets', formatVersion: 1, nodeFormat: 'test-gadgets-node',
  norm: x => ({ spec: { poids: Number(x.spec && x.spec.poids) || 0 } }),
  substance: p => JSON.stringify(p.spec),
});

const W = (model, extra = {}) => ({ ref: { brand: 'Acme', model }, spec: { taille: 3, couleur: 'noir' }, ...extra });

test('chaque entrée reçoit un uuid, et un uuid retiré ne revient pas', () => {
  let { store, product: a } = widgets.upsert({ widgets: [] }, W('A'));
  assert.ok(isUid(a.uid));
  const uidA = a.uid;
  store = widgets.retire(store, uidA, { purge: true });
  const { product: b } = widgets.upsert(store, W('B'));
  assert.notStrictEqual(b.uid, uidA);
});

test('deux catalogues de types différents ne se marchent pas dessus', () => {
  // un magasin ne lit QUE sa propre collection : ranger les trois catalogues
  // dans un même fichier ou un même dépôt ne doit rien mélanger.
  const mixte = { widgets: [W('A')], gadgets: [{ ref: { brand: 'Acme', model: 'G' }, spec: { poids: 7 } }] };
  const w = widgets.normStore(mixte), g = gadgets.normStore(mixte);
  assert.strictEqual(w.widgets.length, 1);
  assert.strictEqual(g.gadgets.length, 1);
  assert.strictEqual(w.gadgets, undefined, 'le magasin des widgets ne recopie pas les gadgets');
  assert.strictEqual(w.widgets[0].spec.couleur, 'noir');
  assert.strictEqual(g.gadgets[0].spec.poids, 7);
  assert.notStrictEqual(w.widgets[0].uid, g.gadgets[0].uid);
});

test('une fiche qui arrive d\'ailleurs GARDE sa révision', () => {
  // le défaut : upsert écrasait la révision à 1 pour toute entrée inconnue.
  // Un showfile ou un node porteur d'une fiche en rev 7 la voyait redémarrer à
  // 1 sur ce poste, qui se croyait alors à jour pendant que tous les nodes
  // déjà patchés se signalaient en avance — sans aucun moyen de résorber
  // l'écart.
  const venue = { ...W('A'), uid: 'a4e1c2d0-1111-4222-8333-444455556666', rev: 7 };
  const { product } = widgets.upsert({ widgets: [] }, venue);
  assert.strictEqual(product.uid, venue.uid, 'l\'identifiant reçu fait foi');
  assert.strictEqual(product.rev, 7);
  // et une création ordinaire, elle, démarre bien à 1
  assert.strictEqual(widgets.upsert({ widgets: [] }, W('B')).product.rev, 1);
});

test('la révision suit la substance DU TYPE, pas un champ imposé', () => {
  let { store, product } = widgets.upsert({ widgets: [] }, W('A'));
  assert.strictEqual(product.rev, 1);
  // changer un réglage : la révision monte
  ({ store, product } = widgets.upsert(store, { ...W('A', { spec: { taille: 9, couleur: 'noir' } }), uid: product.uid }));
  assert.strictEqual(product.rev, 2);
  // changer seulement la référence commerciale : elle ne monte pas
  ({ product } = widgets.upsert(store, { ...W('A bis', { spec: { taille: 9, couleur: 'noir' }, ref: { brand: 'Acme', model: 'A bis', note: 'renommé' } }), uid: product.uid }));
  assert.strictEqual(product.rev, 2, 'renommer ne doit pas signaler « en retard » à ce qui est déjà installé');
});

test('le slug est figé, et l\'ancien identifiant survit au renommage', () => {
  let { store, product } = widgets.upsert({ widgets: [{ ...W('Truc'), legacyId: '0a' }] }, W('Truc'));
  const first = store.widgets.find(x => x.legacyId === '0a');
  assert.ok(first, 'l\'entrée portant un ancien identifiant est conservée');
  ({ product } = widgets.upsert(store, { ...W('Autre nom'), uid: first.uid }));
  assert.strictEqual(product.slug, first.slug, 'le slug est le nom de fichier : le déplacer casserait le dépôt');
  assert.strictEqual(product.legacyId, '0a', 'des nodes portent encore ce marqueur');
});

test('un marqueur ancien résout aussi bien qu\'un uuid', () => {
  const store = widgets.normStore({ widgets: [{ ...W('Truc'), legacyId: '0a' }] });
  const p = store.widgets[0];
  assert.strictEqual(widgets.resolve(store, '0a'), p);
  assert.strictEqual(widgets.resolve(store, p.uid), p);
  assert.strictEqual(widgets.resolve(store, 'inconnu'), null);
  assert.strictEqual(widgets.resolve(store, null), null);
});

test('retirer : conservé s\'il vient du dépôt, purgeable s\'il est local', () => {
  let store = widgets.normStore({ widgets: [
    { ...W('Publie'), origin: 'library' }, { ...W('Brouillon'), origin: 'local' } ] });
  const pub = store.widgets.find(x => x.ref.model === 'Publie');
  const loc = store.widgets.find(x => x.ref.model === 'Brouillon');
  store = widgets.retire(store, pub.uid, { purge: true });
  assert.ok(widgets.resolve(store, pub.uid).retired, 'ce qui vient du dépôt est marqué retiré, jamais effacé');
  store = widgets.retire(store, loc.uid, { purge: true });
  assert.strictEqual(widgets.resolve(store, loc.uid), null);
  assert.throws(() => widgets.retire(store, 'jamais-vu'), /inconnu/);
});

test('revState : à jour, en retard, en avance, inconnu', () => {
  const p = { rev: 5 };
  assert.strictEqual(widgets.revState(p, 5), 'ok');
  assert.strictEqual(widgets.revState(p, 3), 'stale');
  assert.strictEqual(widgets.revState(p, 7), 'ahead', 'c\'est ce poste qui est en retard, ne rien écraser');
  assert.strictEqual(widgets.revState(null, 3), 'unknown');
  assert.strictEqual(widgets.revState(p, null), null, 'rien à comparer n\'est pas une erreur');
});

test('la copie embarquée ne contient que ce qui est cité, sans l\'état de synchro', () => {
  let { store, product: a } = widgets.upsert({ widgets: [] }, W('A'));
  let b; ({ store, product: b } = widgets.upsert(store, W('B')));
  ({ store } = widgets.upsert(store, W('C')));
  const slice = widgets.nodeSlice(store, [a.uid, b.uid, a.uid, null, 'inconnu']);
  assert.deepStrictEqual(slice.widgets.map(x => x.uid).sort(), [a.uid, b.uid].sort());
  assert.strictEqual(slice.widgets[0].dirty, undefined);
  assert.strictEqual(slice.widgets[0].blobSha, undefined);
  assert.strictEqual(slice.format, 'test-widgets-node');
});

test('une copie illisible, ou d\'un autre type, ne fait pas tomber la lecture', () => {
  for (const bad of [null, undefined, 42, {}, { format: 'test-gadgets-node' }]) {
    assert.strictEqual(widgets.parseNodeSlice(bad), null, JSON.stringify(bad));
  }
  const ok = widgets.parseNodeSlice({ format: 'test-widgets-node', widgets: [{ pas: 'valide' }] });
  assert.deepStrictEqual(ok.widgets, [], 'le cadre est valide, son contenu ne l\'est pas');
});

test('rapprochement : à jour, inconnu, plus récent, plus ancien, divergent', () => {
  const { store, product } = widgets.upsert({ widgets: [] }, W('A'));
  const slice = widgets.nodeSlice(store, [product.uid]);
  assert.strictEqual(widgets.compareNodeSlice(store, slice)[0].state, 'same');
  assert.strictEqual(widgets.compareNodeSlice({ widgets: [] }, slice)[0].state, 'absent');

  const avance = widgets.upsert(store, { ...W('A', { spec: { taille: 42, couleur: 'noir' } }), uid: product.uid }).store;
  assert.strictEqual(widgets.compareNodeSlice(store, widgets.nodeSlice(avance, [product.uid]))[0].state, 'newer');
  assert.strictEqual(widgets.compareNodeSlice(avance, slice)[0].state, 'older');

  // deux postes hors ligne ont fait monter 1 -> 2 sur des contenus différents :
  // le numéro ne départage plus rien, il faut le dire et non choisir
  const ici = widgets.upsert(store, { ...W('A', { spec: { taille: 7, couleur: 'noir' } }), uid: product.uid }).store;
  const ailleurs = widgets.upsert(store, { ...W('A', { spec: { taille: 8, couleur: 'noir' } }), uid: product.uid }).store;
  assert.strictEqual(widgets.resolve(ici, product.uid).rev, widgets.resolve(ailleurs, product.uid).rev);
  assert.strictEqual(widgets.compareNodeSlice(ici, widgets.nodeSlice(ailleurs, [product.uid]))[0].state, 'diverged');
});

test('une entrée sans marque ni modèle est refusée, et n\'emporte pas le magasin', () => {
  assert.throws(() => normRef({}), /marque ou modèle/);
  const st = widgets.normStore({ widgets: [{ ref: {} }, W('Bon')] });
  assert.strictEqual(st.widgets.length, 1, 'l\'entrée abîmée est écartée, le reste passe');
  assert.strictEqual(st.widgets[0].ref.model, 'Bon');
});

test('un magasin illisible rend un magasin vide, jamais une exception', () => {
  for (const bad of [null, undefined, 42, 'x', { widgets: 'non' }]) {
    assert.deepStrictEqual(widgets.normStore(bad).widgets, [], JSON.stringify(bad));
  }
});

test('slugify : accents, ponctuation, longueur', () => {
  assert.strictEqual(slugify('LEDpro Flex60'), 'ledpro-flex60');
  assert.strictEqual(slugify('Réglette 24V — n°2'), 'reglette-24v-n-2');
  assert.strictEqual(slugify(''), '');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
});
