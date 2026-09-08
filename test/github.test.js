// La publication vers la bibliothèque partagée.
//
// Plusieurs postes écrivent le même dépôt, sans se parler, souvent hors ligne.
// La panne à éviter n'est pas l'erreur bruyante : c'est la publication qui
// réussit en effaçant le travail de quelqu'un d'autre. Ces cas décrivent
// chacun une collision réelle et ce qu'on veut qu'il en reste.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gh = require('../github');
const lib = require('../library');

const P = (extra = {}) => lib.normProduct({
  uid: '11111111-2222-4333-8444-555555555555',
  ref: { brand: 'LEDpro', model: 'Flex60' },
  led: { type: 22, order: 3 }, presets: [{ px: 160 }], rev: 1, ...extra,
});

test('rien en ligne : on dépose', () => {
  const d = gh.decide(P(), null);
  assert.strictEqual(d.action, 'create');
  assert.strictEqual(d.product.rev, 1);
});

test('identique en ligne : on n\'écrit pas', () => {
  const mine = P();
  assert.strictEqual(gh.decide(mine, P()).action, 'skip');
});

test('même contenu, numéros différents : le plus haut gagne, personne ne perd rien', () => {
  // arrive quand deux postes ont fait la même correction chacun de leur côté.
  const enLigne = P({ rev: 4 });
  assert.strictEqual(gh.decide(P({ rev: 2 }), enLigne).action, 'adopt', 'le nôtre est en retard : on se range dessus');
  const d = gh.decide(P({ rev: 7 }), enLigne);
  assert.strictEqual(d.action, 'publish');
  assert.strictEqual(d.product.rev, 7);
});

test('suite légitime : on est parti de la version en ligne', () => {
  // le cas normal : lire le dépôt, modifier, publier. `basedOnRev` prouve d'où
  // l'on part, et évite de traiter une suite normale comme une divergence.
  const enLigne = P({ rev: 3 });
  const mine = P({ rev: 4, basedOnRev: 3, led: { type: 22, order: 1 } });
  const d = gh.decide(mine, enLigne);
  assert.strictEqual(d.action, 'publish');
  assert.strictEqual(d.product.rev, 4);
});

test('LA collision : deux postes ont modifié la même version', () => {
  // chacun est parti de la rev 3 et a produit une rev 4 différente. Écraser
  // ferait disparaître le travail du premier arrivé sans un mot. On se replace
  // AU-DESSUS de ce qui est en ligne, en gardant nos réglages.
  const enLigne = P({ rev: 4, basedOnRev: 3, led: { type: 30, order: 0 } });
  const mine = P({ rev: 4, basedOnRev: 3, led: { type: 22, order: 1 } });
  const d = gh.decide(mine, enLigne);
  assert.strictEqual(d.action, 'rebase');
  assert.strictEqual(d.product.rev, 5, 'on repart de la dernière version en ligne + 1');
  assert.strictEqual(d.product.basedOnRev, 4, 'et on dit sur quoi on s\'appuie');
  assert.strictEqual(d.product.led.order, 1, 'nos réglages sont conservés');
  assert.notStrictEqual(lib.substance(d.product), lib.substance(enLigne),
    'la version d\'en face reste dans l\'historique git, elle n\'est pas réécrite en douce');
});

test('un poste longtemps hors ligne ne rétrograde pas le dépôt', () => {
  // il publie une rev 2 alors que le dépôt est en rev 9 : sans garde, il
  // réécrirait le fichier avec des réglages vieux de six mois.
  const enLigne = P({ rev: 9, led: { type: 30, order: 2 } });
  const mine = P({ rev: 2, led: { type: 22, order: 1 } });
  const d = gh.decide(mine, enLigne);
  assert.strictEqual(d.action, 'rebase');
  assert.strictEqual(d.product.rev, 10, 'sa version devient la suivante, elle n\'écrase pas les 7 d\'avant');
});

test('un numéro de révision ne désigne jamais deux contenus différents', () => {
  // c'est ce dont dépend tout le reste : les nodes se fient au numéro pour
  // savoir s'ils sont à jour. Deux contenus sous un même numéro rendrait cette
  // question insoluble.
  const enLigne = P({ rev: 4, led: { type: 30, order: 0 } });
  for (const r of [1, 3, 4, 5]) {
    const d = gh.decide(P({ rev: r, led: { type: 22, order: 1 } }), enLigne);
    if (d.action === 'skip' || d.action === 'adopt') continue;
    assert.ok(d.product.rev > enLigne.rev,
      `rev ${r} publiée en ${d.product.rev} : ce numéro est déjà pris par un autre contenu`);
  }
});

test('le slug et l\'ancien identifiant restent ceux du dépôt', () => {
  // deux postes ont pu créer le produit sous des noms un peu différents ; c'est
  // le dépôt qui fait foi sur le nom de fichier, sinon on le déplace à chaque
  // publication.
  const enLigne = P({ rev: 2, slug: 'ledpro-flex60', legacyId: '0a', led: { type: 30, order: 0 } });
  const mine = P({ rev: 2, slug: 'ledpro-flex-60', led: { type: 22, order: 1 } });
  const d = gh.decide(mine, enLigne);
  assert.strictEqual(d.product.slug, 'ledpro-flex60');
  assert.strictEqual(d.product.legacyId, '0a');
});

test('aller-retour par le dépôt : un produit encodé se relit identique', () => {
  const mine = P({ rev: 3, led: { type: 30, order: 2, wswap: 1, perM: 60 }, presets: [{ px: 120 }, { px: 300 }] });
  const back = gh.decodeBlob(gh.encode(mine));
  assert.strictEqual(back.uid, mine.uid);
  assert.strictEqual(back.rev, 3);
  assert.strictEqual(lib.substance(back), lib.substance(mine));
  assert.strictEqual(back.origin, 'library', 'ce qui vient du dépôt est marqué comme tel');
  assert.strictEqual(back.dirty, false);
});

test('un fichier abîmé dans le dépôt ne fait pas tomber la synchronisation', () => {
  for (const bad of ['', 'bm9uIGR1IEpTT04=', Buffer.from('{"ref":{}}').toString('base64')]) {
    assert.strictEqual(gh.decodeBlob(bad), null, JSON.stringify(bad));
  }
});

test('les erreurs GitHub sont dites en clair', () => {
  assert.match(gh.explain(401, {}, {}), /jeton/);
  assert.match(gh.explain(403, { 'x-ratelimit-remaining': '0' }, {}), /quota/);
  assert.match(gh.explain(403, {}, { message: 'Resource not accessible' }), /droits/);
  assert.match(gh.explain(404, {}, {}), /introuvable/);
  assert.match(gh.explain(409, {}, {}), /changé en ligne/);
});

test('le chemin d\'un produit est son uuid, jamais son nom', () => {
  // deux postes hors ligne peuvent nommer un produit pareil ; ils ne peuvent
  // pas frapper le même uuid. Le nom de fichier ne se dispute donc jamais.
  assert.strictEqual(gh.pathFor('11111111-2222-4333-8444-555555555555'),
    'products/11111111-2222-4333-8444-555555555555.json');
});
