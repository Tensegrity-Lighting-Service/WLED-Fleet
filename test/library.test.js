// library.js : le catalogue de produits. Les cas couvrent surtout ce qui,
// jusqu'ici, faisait mentir les marqueurs posés sur les nodes — recyclage des
// identifiants à la suppression, renumérotation à la migration, et le node
// resté six mois hors ligne qu'on croyait à jour parce que le nom collait.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../library');

const P = (brand, model, extra = {}) => ({ ref: { brand, model }, led: { type: 22, order: 3 }, presets: [{ px: 160 }], ...extra });

test('chaque produit reçoit un uuid, unique et jamais réutilisé', () => {
  // le vrai défaut d'avant : l'identifiant court d'un produit supprimé revenait
  // au suivant créé, et tous les nodes qui le portaient pointaient ailleurs.
  let { store, product: a } = lib.upsert({ products: [] }, P('X', 'A'));
  ({ store } = lib.upsert(store, P('X', 'B')));
  assert.ok(lib.isUid(a.uid), `« ${a.uid} » n'est pas un uuid`);
  const uidA = a.uid;
  store = lib.retire(store, uidA, { purge: true });
  const { product: c } = lib.upsert(store, P('X', 'C'));
  assert.notStrictEqual(c.uid, uidA, 'un uuid ne se réattribue pas');
  assert.strictEqual(lib.resolve(store, uidA), null, 'le produit purgé a bien disparu');
});

test('deux postes hors ligne ne peuvent pas frapper le même identifiant', () => {
  // c'est tout l'intérêt de l'uuid : plus d'allocateur central, donc plus de
  // compare-and-swap sur un index partagé, donc plus de conflit d'attribution.
  const a = lib.upsert({ products: [] }, P('X', 'A')).product;
  const b = lib.upsert({ products: [] }, P('X', 'A')).product;
  assert.notStrictEqual(a.uid, b.uid);
});

test('migration v1 : l\'ancien identifiant court devient legacyId', () => {
  // régression majeure : un showfile importé ailleurs renumérotait tout pendant
  // que les nodes gardaient les anciens identifiants.
  const v1 = [{ name: 'Lianes Led', type: 22, order: 3, len: 160, perM: null, note: '', id: '0a' }];
  const st = lib.migrate(v1);
  assert.strictEqual(st.products.length, 1);
  const p = st.products[0];
  assert.strictEqual(p.legacyId, '0a', '3 nodes portent « 0a » : le marqueur doit continuer de résoudre');
  assert.ok(lib.isUid(p.uid));
  assert.strictEqual(p.rev, 1);
  assert.strictEqual(p.led.type, 22);
  assert.strictEqual(p.led.order, 3);
  assert.deepStrictEqual(p.presets.map(x => x.px), [160], 'la longueur devient un preset');
  assert.strictEqual(p.presets[0].default, true);
  assert.strictEqual(p.ref.model, 'Lianes Led');
});

test('migration v2 : le champ id des identifiants courts est repris en legacyId', () => {
  const st = lib.normStore({ products: [{ id: '0a', ...P('X', 'A') }], burnedIds: ['0b'] });
  assert.strictEqual(st.products[0].legacyId, '0a');
  assert.ok(lib.isUid(st.products[0].uid));
  assert.strictEqual(st.burnedIds, undefined, 'plus rien à brûler : un uuid ne se réattribue pas');
});

test('un marqueur écrit avant la v3 résout toujours', () => {
  const st = lib.migrate([{ name: 'Lianes Led', type: 22, order: 3, len: 160, id: '0a' }]);
  const p = st.products[0];
  assert.strictEqual(lib.resolve(st, '0a'), p, 'le node n\'a pas été réécrit, son marqueur doit suffire');
  assert.strictEqual(lib.resolve(st, p.uid), p);
  assert.strictEqual(lib.resolve(st, 'inconnu'), null);
});

test('migration : l\'échange du blanc est extrait du quartet haut', () => {
  const st = lib.migrate([{ name: 'RGBW', type: 30, order: 0x21, len: 60, id: '0b' }]);
  assert.strictEqual(st.products[0].led.order, 1, 'quartet bas = ordre des couleurs');
  assert.strictEqual(st.products[0].led.wswap, 2, 'quartet haut = échange du blanc');
});

test('migrer deux fois ne rebat pas les identifiants', () => {
  const once = lib.migrate([{ name: 'A', type: 22, order: 0, len: 30, id: '0a' }]);
  const twice = lib.migrate(once);
  assert.deepStrictEqual(twice.products.map(p => p.uid), once.products.map(p => p.uid));
  assert.deepStrictEqual(twice.products.map(p => p.legacyId), ['0a']);
});

// ── Révisions ──────────────────────────────────────────────────────────────
test('la révision monte quand les RÉGLAGES changent', () => {
  let { store, product } = lib.upsert({ products: [] }, P('X', 'A'));
  assert.strictEqual(product.rev, 1);
  ({ store, product } = lib.upsert(store, { ...P('X', 'A', { led: { type: 22, order: 1 } }), uid: product.uid }));
  assert.strictEqual(product.rev, 2, 'changer l\'ordre des couleurs change ce qu\'on écrit sur un node');
  ({ product } = lib.upsert(store, { ...P('X', 'A', { led: { type: 22, order: 1 }, presets: [{ px: 160 }, { px: 300 }] }), uid: product.uid }));
  assert.strictEqual(product.rev, 3, 'ajouter une longueur type aussi');
});

test('la révision NE monte PAS pour un renommage ou une note', () => {
  // sinon tous les nodes déjà patchés se signalent « en retard » parce qu'on a
  // corrigé une faute de frappe dans le nom du produit.
  let { store, product } = lib.upsert({ products: [] }, P('LEDpro', 'Flex60'));
  const rev = product.rev;
  ({ product } = lib.upsert(store, { ...P('LEDpro', 'Flex60 v2', { ref: { brand: 'LEDpro', model: 'Flex60 v2', note: 'bobine 5 m' } }), uid: product.uid }));
  assert.strictEqual(product.rev, rev);
});

test('revState : à jour, en retard, en avance, inconnu', () => {
  const { product } = lib.upsert({ products: [] }, P('X', 'A'));
  const p5 = { ...product, rev: 5 };
  assert.strictEqual(lib.revState(p5, 5), 'ok');
  assert.strictEqual(lib.revState(p5, 3), 'stale', 'le node a été patché avec une version plus ancienne');
  // le node revient d'un poste dont la bibliothèque était en avance : ne SURTOUT
  // pas réappliquer, on écraserait des réglages plus récents que les nôtres.
  assert.strictEqual(lib.revState(p5, 7), 'ahead');
  assert.strictEqual(lib.revState(null, 3), 'unknown');
  assert.strictEqual(lib.revState(p5, null), null, 'un node sans révision ne dit rien, ce n\'est pas une erreur');
});

test('le slug est figé : renommer la marque ne le change pas', () => {
  let { store, product } = lib.upsert({ products: [] }, P('LEDpro', 'Flex60'));
  const slug = product.slug;
  assert.strictEqual(slug, 'ledpro-flex60');
  ({ product } = lib.upsert(store, { ...P('AutreMarque', 'Flex60'), uid: product.uid }));
  assert.strictEqual(product.slug, slug, 'sinon chaque renommage = un delete+add dans le dépôt');
});

test('l\'échange du blanc est forcé à 0 sur un type sans canal blanc', () => {
  const p = lib.normProduct(P('X', 'A', { led: { type: 22, order: 0, wswap: 3 } }), { whiteSwapTypes: [30, 31] });
  assert.strictEqual(p.led.wswap, 0, 'WS281x n\'a pas de blanc : la valeur ne doit pas rester');
  const q = lib.normProduct(P('X', 'B', { led: { type: 30, order: 0, wswap: 3 } }), { whiteSwapTypes: [30, 31] });
  assert.strictEqual(q.led.wswap, 3, 'SK6812 RGBW : la valeur est légitime');
});

test('presets : triés, dédoublonnés, un défaut garanti', () => {
  const p = lib.normProduct(P('X', 'A', { led: { type: 22, perM: 60 }, presets: [{ px: 300 }, { px: 120 }, { px: 120 }] }));
  assert.deepStrictEqual(p.presets.map(x => x.px), [120, 300]);
  assert.strictEqual(p.presets[0].default, true);
  assert.strictEqual(p.presets[0].label, '2 m', 'label déduit de perM');
});

test('sans perM, le label retombe sur les pixels', () => {
  assert.strictEqual(lib.defaultLabel(137, null), '137 px');
  assert.strictEqual(lib.defaultLabel(120, 60), '2 m');
});

test('un produit sans marque ni modèle est refusé', () => {
  assert.throws(() => lib.normProduct({ ref: {}, led: { type: 22 } }), /marque ou modèle/);
});

test('correspondance produit ↔ sortie : le preset se déduit de la longueur', () => {
  const p = lib.normProduct(P('X', 'A', { led: { type: 22, order: 3 }, presets: [{ px: 120 }, { px: 160 }] }));
  assert.strictEqual(lib.matches(p, { type: 22, order: 3, len: 160 }), true);
  assert.strictEqual(lib.presetFor(p, 160).px, 160);
  assert.strictEqual(lib.matches(p, { type: 22, order: 3, len: 137 }), false, '137 px ne correspond à aucun preset');
  assert.strictEqual(lib.presetFor(p, 137), null);
  assert.strictEqual(lib.matches(p, { type: 30, order: 3, len: 160 }), false, 'type différent');
  assert.strictEqual(lib.matches(p, { type: 22, order: 1, len: 160 }), false, 'ordre différent');
});

test('la correspondance ignore le quartet haut quand le produit n\'en déclare pas', () => {
  const p = lib.normProduct(P('X', 'A', { led: { type: 22, order: 3 }, presets: [{ px: 160 }] }));
  assert.strictEqual(lib.matches(p, { type: 22, order: (2 << 4) | 3, len: 160 }), true);
});

test('retirer : un produit utilisé est marqué retiré, jamais effacé', () => {
  let { store, product } = lib.upsert({ products: [] }, P('X', 'A'));
  store = lib.retire(store, product.uid);                 // sans purge : des nodes le portent
  const p = lib.resolve(store, product.uid);
  assert.ok(p && p.retired, 'sinon le marqueur du node ne désigne plus rien');
  const { store: st2, product: q } = lib.upsert({ products: [] }, P('X', 'B'));
  assert.strictEqual(lib.resolve(lib.retire(st2, q.uid, { purge: true }), q.uid), null,
    'la faute de frappe corrigée dans la minute peut disparaître');
});

test('un magasin illisible ne fait pas tomber le chargement', () => {
  for (const bad of [null, undefined, 42, 'x', { products: 'non' }]) {
    assert.deepStrictEqual(lib.normStore(bad).products, [], JSON.stringify(bad));
  }
  assert.deepStrictEqual(lib.migrate([{ pas: 'un produit' }]).products, []);
});

// ── La copie embarquée sur le node ─────────────────────────────────────────
test('la tranche embarquée ne contient que les produits cités, une seule fois', () => {
  let { store, product: a } = lib.upsert({ products: [] }, P('X', 'A'));
  let b; ({ store, product: b } = lib.upsert(store, P('X', 'B')));
  ({ store } = lib.upsert(store, P('X', 'C')));
  const slice = lib.nodeSlice(store, [a.uid, b.uid, a.uid, null, 'inconnu']);
  assert.deepStrictEqual(slice.products.map(p => p.uid).sort(), [a.uid, b.uid].sort(),
    'le produit non cité reste au poste, le marqueur inconnu n\'invente rien');
  assert.strictEqual(slice.products.filter(p => p.uid === a.uid).length, 1);
  assert.strictEqual(slice.products[0].dirty, undefined, 'l\'état de synchro local n\'a pas de sens sur un node');
});

test('la copie embarquée résout aussi un ancien marqueur court', () => {
  const store = lib.migrate([{ name: 'Lianes Led', type: 22, order: 3, len: 160, id: '0a' }]);
  assert.strictEqual(lib.nodeSlice(store, ['0a']).products.length, 1);
});

test('une copie illisible ne fait pas tomber la lecture du node', () => {
  for (const bad of [null, undefined, 42, {}, { format: 'autre chose' }]) {
    assert.strictEqual(lib.parseNodeSlice(bad), null, JSON.stringify(bad));
  }
  const ok = lib.parseNodeSlice({ format: lib.NODE_FORMAT, products: [{ pas: 'un produit' }] });
  assert.deepStrictEqual(ok.products, [], 'le fichier est valide, son contenu ne l\'est pas : on garde le cadre');
});

test('rapprochement node ↔ catalogue : à jour, absent, plus récent, plus ancien', () => {
  let { store, product } = lib.upsert({ products: [] }, P('X', 'A'));
  const slice = lib.nodeSlice(store, [product.uid]);
  assert.strictEqual(lib.compareNodeSlice(store, slice)[0].state, 'same');

  // le node porte un produit que ce poste ne connaît pas du tout
  assert.strictEqual(lib.compareNodeSlice({ products: [] }, slice)[0].state, 'absent');

  // le node revient d'un poste dont la bibliothèque était en avance
  const avance = lib.nodeSlice(lib.upsert(store, { ...P('X', 'A', { led: { type: 30, order: 1 } }), uid: product.uid }).store, [product.uid]);
  assert.strictEqual(lib.compareNodeSlice(store, avance)[0].state, 'newer');
  assert.strictEqual(lib.compareNodeSlice(store, avance)[0].rev, 2);
  assert.strictEqual(lib.compareNodeSlice(store, avance)[0].mineRev, 1);

  // le node a été patché avant une mise à jour du catalogue
  const apres = lib.upsert(store, { ...P('X', 'A', { presets: [{ px: 160 }, { px: 300 }] }), uid: product.uid }).store;
  assert.strictEqual(lib.compareNodeSlice(apres, slice)[0].state, 'older');
});

test('divergence : même révision, réglages différents', () => {
  // deux postes hors ligne ont chacun fait monter 1 -> 2 sur un contenu
  // différent. Le numéro ne départage plus rien : il faut le dire, pas choisir
  // à la place de l'utilisateur.
  const { store, product } = lib.upsert({ products: [] }, P('X', 'A'));
  const ici = lib.upsert(store, { ...P('X', 'A', { led: { type: 22, order: 1 } }), uid: product.uid }).store;
  const ailleurs = lib.upsert(store, { ...P('X', 'A', { led: { type: 22, order: 2 } }), uid: product.uid }).store;
  assert.strictEqual(lib.resolve(ici, product.uid).rev, lib.resolve(ailleurs, product.uid).rev, 'même numéro de révision');
  const cmp = lib.compareNodeSlice(ici, lib.nodeSlice(ailleurs, [product.uid]));
  assert.strictEqual(cmp[0].state, 'diverged');
});

test('mA par pixel : borné à 255, parce que le firmware le tronquerait', () => {
  // le champ est un uint8_t côté WLED (bus_manager.h:285) et relu tel quel
  // (cfg.cpp:241) : une valeur au-dessus n'est pas refusée, elle est tronquée
  // en silence, et l'ABL freine ensuite d'après un chiffre que personne n'a
  // saisi. L'ancienne borne à 10000 laissait passer exactement ça.
  assert.strictEqual(lib.normProduct(P('X', 'A', { led: { type: 22, ledma: 5000 } })).led.ledma, 255);
  assert.strictEqual(lib.normProduct(P('X', 'A', { led: { type: 22, ledma: 120 } })).led.ledma, 120);
  assert.strictEqual(lib.normProduct(P('X', 'A', { led: { type: 22, ledma: -5 } })).led.ledma, 0);
  // 255 reste acceptable : c'est le modèle WS2815, pas un courant
  assert.strictEqual(lib.normProduct(P('X', 'A', { led: { type: 22, ledma: 255 } })).led.ledma, 255);
});
