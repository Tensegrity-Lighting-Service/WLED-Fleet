// power.js : est-ce que la chaîne électrique tient ?
//
// Les cas viennent de la vraie flotte — 16 nodes, 4 467 pixels, des budgets de
// 850 mA à 16 A. C'est important : une vérification calibrée sur des exemples
// inventés se révèle inutilisable le jour où on la branche sur du réel, parce
// qu'elle parle tout le temps.
//
// Le fil rouge de ces cas est donc double : attraper ce qui est vraiment
// dangereux, et SE TAIRE sur tout le reste.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const power = require('../power');
const lib = require('../library');
const psusCat = require('../psus');
const driversCat = require('../drivers');

// une boule : 36 px, 55 mA/pixel, budget 850 mA
const boule = (over = {}) => ({ maxpwr: 850, ins: [{ len: 36, ledma: 55, maxpwr: 850 }], ...over });
// un PIXY_LIANA : 3 sorties de 160 px à 120 mA/pixel, budget 8 A
const liana = (over = {}) => ({
  maxpwr: 8000,
  ins: [{ len: 160, ledma: 120, maxpwr: 0 }, { len: 160, ledma: 120, maxpwr: 2666 }, { len: 160, ledma: 120, maxpwr: 2666 }],
  ...over,
});
const codes = r => r.checks.map(c => c.code);

test('une boule bridée à 36 % est signalée, pas déclarée en faute', () => {
  // 850 − 120 pour l'ESP = 730 mA utiles, pour 36 × 56 = 2016 mA de pire cas.
  // C'est peut-être exactement ce qu'on veut : on le DIT, on ne le corrige pas.
  const b = power.nodeBudget(boule());
  assert.strictEqual(b.ratio, 0.36);
  // 'abl-governs' aussi : 60 % du pire cas (1,21 A) dépasse le budget (0,85 A),
  // donc c'est l'ABL qui décide — et le module le dit plutôt que d'afficher
  // deux chiffres identiques sans explication.
  assert.deepStrictEqual(codes(b), ['abl-clamped']);
  // toujours en `info`, quel que soit le taux : sur une vraie flotte tous les
  // nodes sont bridés, et en faire une alerte teindrait le rapport en orange
  // dès la première ouverture.
  const clamp = b.checks.find(c => c.code === 'abl-clamped');
  assert.strictEqual(clamp.level, 'info', 'un constat, pas une alerte');
  assert.strictEqual(clamp.num.bas, true, 'le chiffre reste disponible pour que l\'interface le colore');
  assert.strictEqual(b.maxA, 0.85);
  assert.strictEqual(b.worstA, 2.02, 'pire cas = len × (ledma + 1), la veille comprise');
});

test('LE défaut silencieux : ledma sous-déclaré par rapport à la fiche', () => {
  // c'est le seul qui casse du matériel sans rien afficher : l'ABL freine trop
  // peu, la tension s'effondre, les données se corrompent.
  const produit = lib.normProduct({ ref: { brand: 'X', model: 'Liane' }, led: { type: 22, ledma: 120 }, presets: [{ px: 160 }] });
  const b = power.nodeBudget({ ...liana({ ins: liana().ins.map(x => ({ ...x, ledma: 55 })) }), product: () => produit });
  const sous = b.checks.filter(c => c.code === 'abl-sous-declaree');
  assert.strictEqual(sous.length, 3, 'les trois sorties');
  assert.strictEqual(sous[0].level, 'bad');
  assert.strictEqual(sous[0].num.facteur, 2.18, '2,18 fois le courant prévu — mesuré sur la vraie flotte');
});

test('une sortie à 0 mA/pixel est exclue de l\'ABL par le firmware', () => {
  const b = power.nodeBudget(boule({ ins: [{ len: 36, ledma: 0 }] }));
  assert.ok(codes(b).includes('sortie-non-comptee'));
});

test('les valeurs que le FIRMWARE fabrique ne sont pas signalées', () => {
  // c'est la règle qui décide si le rapport sera lu. cfg.cpp:242 répartit la
  // limite globale au prorata des pixels quand elle manque — d'où les 2666 des
  // PIXY — et const.h:596 met 850 par défaut. Rien de tout ça n'est délibéré.
  assert.ok(!codes(power.nodeBudget(liana())).includes('limite-inerte'), '2666 = 8000 × 160/480, calculé par WLED');
  assert.ok(!codes(power.nodeBudget(boule())).includes('limite-inerte'), '850 = ABL_MILLIAMPS_DEFAULT');
  // en revanche une valeur que quelqu'un a vraiment saisie, oui
  const voulu = power.nodeBudget(boule({ ins: [{ len: 36, ledma: 55, maxpwr: 3000 }] }));
  assert.ok(codes(voulu).includes('limite-inerte'));
});

test('un budget avalé par l\'ESP, et un budget qui cloue la luminosité', () => {
  // deux pièges du firmware, invisibles dans l'interface de WLED
  assert.ok(codes(power.nodeBudget(boule({ maxpwr: 100 }))).includes('esp-mange-tout'));
  // 1329 px (Tournette ext) avec 1400 mA : 1280 utiles ≤ 1329 pixels
  const t = power.nodeBudget({ maxpwr: 1400, ins: [{ len: 1329, ledma: 55 }] });
  assert.ok(codes(t).includes('bri-clouee'));
  assert.strictEqual(t.ratio, 0);
});

test('aucune limite du tout : rien ne bride', () => {
  assert.ok(codes(power.nodeBudget({ maxpwr: 0, ins: [{ len: 36, ledma: 55 }] })).includes('abl-absente'));
});

test('le régime par sortie se déduit, et répartit l\'ESP entre les bus', () => {
  // limite globale à 0 + limites par sortie = régime par sortie. L'ESP est
  // alors DIVISÉ entre les bus actifs, pas retiré une seule fois : deux sorties
  // de 36 px budgétées à 365 mA sont donc un peu plus bridées qu'en global.
  const b = power.nodeBudget({ maxpwr: 0, ins: [{ len: 36, ledma: 55, maxpwr: 365 }, { len: 36, ledma: 55, maxpwr: 365 }] });
  assert.strictEqual(b.perOutput, true);
  assert.strictEqual(b.maxA, 0.73);
  assert.strictEqual(b.ratio, 0.15);
  assert.ok(!codes(b).includes('abl-absente'));
});

test('une sortie déclarée non câblée ne consomme rien', () => {
  const b = power.nodeBudget({ maxpwr: 8000, ignored: [1], ins: [{ len: 160, ledma: 120 }, { len: 160, ledma: 120 }] });
  assert.strictEqual(b.px, 160);
  assert.strictEqual(b.worstA, 19.36, 'une seule sortie comptée');
});

test('255 mA/pixel n\'est pas un courant mais le modèle WS2815', () => {
  // déclarer 255 freine MOINS que déclarer 55 : le firmware bascule sur 12 mA
  const a = power.nodeBudget({ maxpwr: 5000, ins: [{ len: 100, ledma: 255 }] });
  const b = power.nodeBudget({ maxpwr: 5000, ins: [{ len: 100, ledma: 55 }] });
  assert.ok(a.worstA < b.worstA, `${a.worstA} A doit être inférieur à ${b.worstA} A`);
  assert.strictEqual(a.worstA, 1.3, '100 × (12 + 1)');
});

// ── La chaîne complète ─────────────────────────────────────────────────────
const alim = (o = {}) => psusCat.normPsu({ ref: { brand: 'Meanwell', model: 'LRS' }, volt: 12, amps: 20, ...o });
const nodeFrom = (ip, name, b, extra = {}) => ({ ip, name, budget: power.nodeBudget(b), ...extra });

test('on somme les BUDGETS, pas les pires cas — et le test fixe ce choix', () => {
  // 8 boules sur une alim 12 V / 20 A. Budgets : 8 × 0,85 = 6,8 A -> ça passe.
  // Pires cas : 8 × 2,02 = 16,2 A -> ça alerterait, alors que l'ABL rend cette
  // consommation impossible par construction.
  const nodes = Array.from({ length: 8 }, (_, i) => nodeFrom(`n${i}`, `boule ${i}`, boule()));
  const r = power.audit({ psus: [{ label: 'jardin', model: alim(), nodes: nodes.map(n => n.ip) }], nodes });
  assert.strictEqual(r.psus[0].usedA, 6.8);
  assert.strictEqual(r.totals.pireCasA, 16.16, 'le pire cas est calculé et affiché…');
  assert.ok(!r.psus[0].checks.some(c => c.code.startsWith('psu-')), '…mais il n\'entre pas dans le verdict');
});

test('une alim serrée avertit, une alim dépassée échoue', () => {
  const gros = () => nodeFrom('a', 'gros', { maxpwr: 9000, ins: [{ len: 100, ledma: 55 }] });
  // 20 A × 0,8 × 0,8 = 12,8 A utilisables
  const deux = [gros(), { ...gros(), ip: 'b' }];        // 18 A
  const r1 = power.audit({ psus: [{ label: 'p', model: alim(), nodes: ['a', 'b'] }], nodes: deux });
  assert.deepStrictEqual(r1.psus[0].checks.filter(c => c.code.startsWith('psu-')).map(c => c.code), ['psu-tight']);
  const trois = [...deux, { ...gros(), ip: 'c' }];       // 27 A > 20
  const r2 = power.audit({ psus: [{ label: 'p', model: alim(), nodes: ['a', 'b', 'c'] }], nodes: trois });
  assert.deepStrictEqual(r2.psus[0].checks.filter(c => c.code.startsWith('psu-')).map(c => c.code), ['psu-over']);
});

test('un ruban 24 V sur une alim 12 V échoue même quand les ampères passent', () => {
  const p24 = lib.normProduct({ ref: { brand: 'X', model: 'R' }, led: { type: 22 }, elec: { volts: [24] }, presets: [{ px: 36 }] });
  const n = nodeFrom('a', 'boule', { ...boule(), product: () => p24 });
  const r = power.audit({ psus: [{ label: 'p', model: alim(), nodes: ['a'] }], nodes: [n] });
  const c = r.psus[0].checks.find(x => x.code === 'volt-mismatch');
  assert.ok(c, 'les 0,85 A passent largement, mais le ruban grille');
  assert.strictEqual(c.level, 'bad');
});

test('une tension non renseignée ne vaut PAS une tension correcte', () => {
  // empêche la régression « valeur par défaut qui verdit tout »
  const sansVolt = lib.normProduct({ ref: { brand: 'X', model: 'R' }, led: { type: 22 }, presets: [{ px: 36 }] });
  assert.deepStrictEqual(sansVolt.elec.volts, []);
  const n = nodeFrom('a', 'boule', { ...boule(), product: () => sansVolt });
  const c = power.audit({ psus: [{ label: 'p', model: alim(), nodes: ['a'] }], nodes: [n] }).psus[0].checks;
  assert.strictEqual(c.find(x => x.code === 'volt-unknown').level, 'info');
  assert.ok(!c.some(x => x.code === 'volt-mismatch'), 'on ne conclut pas dans un sens ni dans l\'autre');
});

test('une carte alimentée hors de ses tensions d\'entrée', () => {
  const carte = driversCat.normDriver({ ref: { brand: 'Q', model: 'Quad' }, board: { inputVolts: [5] } });
  const n = { ...nodeFrom('a', 'boule', boule()), driver: carte };
  const r = power.audit({ psus: [{ label: 'p', model: alim({ volt: 24 }), nodes: ['a'] }], nodes: [n] });
  assert.ok(r.psus[0].checks.some(c => c.code === 'volt-board'));
});

test('un budget supérieur à ce que la carte supporte', () => {
  const carte = driversCat.normDriver({ ref: { brand: 'Q', model: 'Quad' }, board: { maxA: 8 } });
  const b = power.nodeBudget({ maxpwr: 16000, ins: [{ len: 296, ledma: 55 }], driver: carte });
  const c = b.checks.find(x => x.code === 'abl-over-board');
  assert.ok(c && c.level === 'bad');
  assert.strictEqual(c.num.budgetA, 16);
});

test('un rail se budgète séparément du bloc', () => {
  const model = alim({ amps: 30, rails: [{ id: 'A', amps: 10 }, { id: 'B', amps: 10 }] });
  const gros = nodeFrom('a', 'gros', { maxpwr: 12000, ins: [{ len: 100, ledma: 55 }] });
  const r = power.audit({ psus: [{ label: 'p', model, rail: 'A', nodes: ['a'] }], nodes: [gros] });
  assert.strictEqual(r.psus[0].capA, 10, 'le rail, pas les 30 A du bloc');
  assert.deepStrictEqual(r.psus[0].checks.filter(c => c.code.startsWith('psu-')).map(c => c.code), ['psu-over']);
});

test('une alim sans node, et un node sans alim', () => {
  const n = nodeFrom('a', 'orpheline', boule());
  const r = power.audit({ psus: [{ label: 'vide', model: alim(), nodes: [] }], nodes: [n] });
  assert.deepStrictEqual(r.psus[0].checks.map(c => c.code), ['psu-unused'], 'pas une erreur');
  assert.deepStrictEqual(r.orphelins.map(x => x.ip), ['a'], 'la liste que personne ne peut produire aujourd\'hui');
});

test('le facteur d\'usage ne dépasse jamais ce que l\'ABL autorise', () => {
  // sur cette flotte il ne change rien, et le module doit le DIRE plutôt que
  // d'afficher deux chiffres identiques sans explication
  const b = power.nodeBudget(boule());
  assert.strictEqual(b.usageA, 0.85, 'plafonné par le budget, pas 60 % de 2,02 A');
  assert.strictEqual(b.ablGoverns, true, 'un drapeau sur le budget, pas une ligne de rapport répétée quatorze fois');
  // un node large, lui, est bien gouverné par l'usage
  const large = power.nodeBudget({ maxpwr: 20000, ins: [{ len: 100, ledma: 55 }] });
  assert.strictEqual(large.usageA, 3.36, '60 % de 5,6 A');
  assert.strictEqual(large.ablGoverns, false);
});

test('audit() ne modifie pas ce qu\'on lui donne', () => {
  // garde-fou de pureté, comme pour dmx.js : deux appels doivent donner le même
  // résultat, et les entrées ressortir intactes.
  const nodes = [nodeFrom('a', 'boule', boule())];
  const psus = [{ label: 'p', model: alim(), nodes: ['a'] }];
  const avant = JSON.stringify({ nodes, psus });
  const r1 = power.audit({ psus, nodes });
  const r2 = power.audit({ psus, nodes });
  assert.strictEqual(JSON.stringify({ nodes, psus }), avant);
  assert.deepStrictEqual(r1.totals, r2.totals);
});

test('une flotte saine ne produit AUCUN constat', () => {
  // le test le plus important du fichier : une vérification qui parle tout le
  // temps ne sera jamais lue.
  const p = lib.normProduct({ ref: { brand: 'X', model: 'R' }, led: { type: 22, ledma: 55 }, elec: { volts: [12] }, presets: [{ px: 36 }] });
  const carte = driversCat.normDriver({ ref: { brand: 'Q', model: 'Quad' }, board: { maxA: 10, inputVolts: [12] } });
  // budget large : blanc plein atteignable, rien à signaler
  const n = { ...nodeFrom('a', 'boule', { maxpwr: 2500, ins: [{ len: 36, ledma: 55 }], product: () => p }), driver: carte };
  const r = power.audit({ psus: [{ label: 'jardin', model: alim(), nodes: ['a'] }], nodes: [n] });
  assert.deepStrictEqual(r.checks, [], `constats inattendus : ${JSON.stringify(r.checks)}`);
});

test('le sens inverse : c\'est la FICHE qui est fausse, pas le node', () => {
  // cas réel de la flotte : les PIXY sont réglés à 120 mA/pixel — la bonne
  // valeur — mais le produit migré depuis l'ancien format déclare 55. Le node
  // est sûr, il freine trop. C'est la fiche qui piégera la prochaine sortie à
  // laquelle on l'appliquera, et c'est elle qu'il faut désigner.
  const fiche55 = lib.normProduct({ ref: { brand: '', model: 'lianes' }, led: { type: 22, ledma: 55 }, presets: [{ px: 160 }] });
  const b = power.nodeBudget({ ...liana(), product: () => fiche55 });
  const c = b.checks.filter(x => x.code === 'fiche-sous-declaree');
  assert.strictEqual(c.length, 3);
  assert.strictEqual(c[0].level, 'warn', 'moins grave que l\'inverse : rien ne casse');
  assert.ok(!b.checks.some(x => x.code === 'abl-sous-declaree'), 'surtout pas le contraire');
  assert.match(c[0].msg, /lianes/, 'le produit à corriger est nommé');
});

// ── Les deux générations de firmware ───────────────────────────────────────
// Les deux formes viennent d'un relevé en direct : un ESP32-C3 en 0.14.4
// (vid 2405180) et une boule en 16.0.0 (vid 2605030).
const LED_014 = { total: 32, maxpwr: 1500, ledma: 55, cct: false, fps: 42, rgbwm: 255, ld: true,
  ins: [{ start: 0, len: 32, pin: [10], order: 0, rev: false, skip: 0, type: 22, ref: false, rgbwm: 0, freq: 0 }] };
const LED_16 = { total: 36, maxpwr: 850, cct: false, fps: 42, rgbwm: 255,
  ins: [{ start: 0, len: 36, pin: [10], order: 0, rev: false, skip: 0, type: 22, ref: false, rgbwm: 0, freq: 0, maxpwr: 850, ledma: 55, drv: 0, text: '' }] };

test('la génération se lit sur la FORME de la config, pas sur le numéro de version', () => {
  // un build maison peut porter n'importe quel numéro ; la forme, elle, ne ment pas
  assert.strictEqual(power.ablScheme(LED_014), power.SCHEME_GLOBAL);
  assert.strictEqual(power.ablScheme(LED_16), power.SCHEME_PER_OUT);
});

test('sans rien pour trancher, on suppose le firmware courant', () => {
  assert.strictEqual(power.ablScheme({ ins: [{ len: 10 }] }), power.SCHEME_PER_OUT);
  assert.strictEqual(power.ablScheme(null), power.SCHEME_PER_OUT);
});

test('le mA/pixel en vigueur se lit où il se trouve', () => {
  // c'est tout l'enjeu : sur un node 0.14, lire ins[i].ledma ne rend RIEN, et
  // Fleet affichait alors son défaut — juste par hasard quand le node déclare
  // 55, faux dès qu'il déclare autre chose
  assert.strictEqual(power.ledmaOf(LED_014, 0), 55);
  assert.strictEqual(power.ledmaOf({ ...LED_014, ledma: 120 }, 0), 120);
  assert.strictEqual(power.ledmaOf(LED_16, 0), 55);
  assert.strictEqual(power.ledmaOf({ ins: [{ len: 10 }] }, 0), 55, 'défaut WLED quand personne ne le dit');
});

test('un ledma global de 120 ne se lit pas 55 — le cas qui fait déconner les LED', () => {
  const vieux = { ...LED_014, ledma: 120 };
  assert.notStrictEqual(power.ledmaOf(vieux, 0), 55);
  // et le budget calculé s'appuie bien dessus une fois la config traduite
  const b = power.nodeBudget({ maxpwr: vieux.maxpwr, ins: power.migrateLed(vieux).ins });
  assert.strictEqual(b.outputs[0].ledma, 120);
});

test('migrer 0.14 vers 16 fait DESCENDRE le ledma dans chaque sortie', () => {
  // réinjecter la sauvegarde telle quelle après la mise à jour rendrait au node
  // une config dont le firmware neuf ne lit plus le ledma : il repartirait sur
  // 55, et un ruban déclaré à 120 tirerait plus du double du prévu.
  const m = power.migrateLed({ ...LED_014, ledma: 120, ins: [{ len: 32, pin: [10] }, { len: 8, pin: [3] }] });
  assert.strictEqual(m.ledma, undefined, 'le champ global n\'a plus de sens en 16.x');
  assert.deepStrictEqual(m.ins.map(b => b.ledma), [120, 120]);
  assert.strictEqual(m.maxpwr, 1500, 'le maxpwr global existe dans les DEUX générations : il ne bouge pas');
});

test('migrer une config déjà en 16.x ne la touche pas', () => {
  assert.deepStrictEqual(power.migrateLed(LED_16), { ...LED_16 });
});

test('migrer ne modifie pas la config d\'origine', () => {
  const src = { ...LED_014 };
  const avant = JSON.stringify(src);
  power.migrateLed(src);
  assert.strictEqual(JSON.stringify(src), avant);
});

// ── Réinjecter une sauvegarde après une mise à jour ────────────────────────
test('une config 0.14 rendue à un node passé en 16.x est TRADUITE', () => {
  // le scénario complet : sauvegarde, mise à jour du firmware, restauration.
  // Sans traduction la restauration « réussit » et le node repart à 55 mA/pixel
  // au lieu de 120 — plus du double du courant prévu, sans un mot.
  const sauvegarde = { total: 36, maxpwr: 850, ledma: 120, ins: [{ len: 36, pin: [10] }, { len: 12, pin: [3] }] };
  const apresMaj = { total: 48, maxpwr: 850, ins: [{ len: 36, pin: [10], ledma: 55 }, { len: 12, pin: [3], ledma: 55 }] };
  const r = power.restoreLed(sauvegarde, apresMaj);
  assert.strictEqual(r.traduit, true);
  assert.deepStrictEqual(r.led.ins.map(b => b.ledma), [120, 120]);
  assert.strictEqual(r.led.ledma, undefined);
  assert.match(r.note, /120/, 'la note dit d\'où vient le chiffre');
});

test('rien n\'est traduit quand les deux générations concordent', () => {
  const v = { maxpwr: 850, ledma: 55, ins: [{ len: 36, pin: [10] }] };
  const n = { maxpwr: 850, ins: [{ len: 36, pin: [10], ledma: 55 }] };
  assert.strictEqual(power.restoreLed(n, n).traduit, false, '16.x vers 16.x');
  assert.strictEqual(power.restoreLed(v, v).traduit, false, '0.14 vers 0.14');
});

test('on ne « traduit » jamais dans l\'autre sens', () => {
  // rendre une config 16.x à un node resté en 0.14 ne se répare pas ici : le
  // firmware n'a pas de champ par sortie. Inventer une conversion masquerait le
  // vrai problème, qui est qu'on redescend une version.
  const n = { maxpwr: 850, ins: [{ len: 36, pin: [10], ledma: 120 }] };
  const v = { maxpwr: 850, ledma: 55, ins: [{ len: 36, pin: [10] }] };
  const r = power.restoreLed(n, v);
  assert.strictEqual(r.traduit, false);
  assert.strictEqual(r.led, n, 'la config est rendue telle quelle');
});

test('un ledma global de 0 se propage tel quel — il ne s\'invente pas un défaut', () => {
  // six boules de la flotte déclarent 0, ce qui désactive l'ABL. La mise à jour
  // ne doit pas maquiller ça en 55 : le rapport doit continuer de le signaler.
  const r = power.restoreLed({ maxpwr: 850, ledma: 0, ins: [{ len: 36 }] },
    { maxpwr: 850, ins: [{ len: 36, ledma: 55 }] });
  assert.strictEqual(r.led.ins[0].ledma, 0);
});

// ── Les groupes d'alimentation, sans exemplaires ───────────────────────────
test('audit rend les nodes AU COMPLET, avec leurs budgets et leurs sorties', () => {
  // Ils étaient jetés ici alors que le schéma les lisait : résultat, il ne
  // dessinait que des boîtes nues et aucune sortie tant qu'un node n'était pas
  // rattaché à une alimentation.
  const nodes = [nodeFrom('a', 'un', boule()), nodeFrom('b', 'deux', boule())];
  const r = power.audit({ psus: [], nodes });
  assert.strictEqual(r.nodes.length, 2);
  assert.ok(r.nodes[0].budget.outputs.length, 'les sorties voyagent avec');
});

test('deux nodes LIÉS additionnent leurs budgets, deux nodes séparés non', () => {
  // C'est toute la raison d'être du groupe : sur la même alimentation physique
  // les consommations s'ajoutent, sur deux alimentations identiques elles ne
  // s'ajoutent pas. Rien dans le modèle ne permet de trancher — seul le lien.
  const gros = ip => nodeFrom(ip, ip, { maxpwr: 9000, ins: [{ len: 100, ledma: 55 }] });
  const nodes = [gros('a'), gros('b')];
  const lies = power.audit({ psus: [{ uid: 'g1', model: alim(), nodes: ['a', 'b'] }], nodes });
  assert.strictEqual(lies.psus[0].usedA, 18);
  assert.ok(lies.psus[0].checks.some(c => c.code.startsWith('psu-')), '18 A sur 20 A : ça se signale');

  const separes = power.audit({
    psus: [{ uid: 'seul:a', model: alim(), nodes: ['a'] }, { uid: 'seul:b', model: alim(), nodes: ['b'] }],
    nodes,
  });
  assert.deepStrictEqual(separes.psus.map(p => p.usedA), [9, 9]);
  assert.ok(!separes.psus.some(p => p.checks.some(c => c.code.startsWith('psu-'))), 'chacune tient largement');
});

test('des nodes liés qui ne désignent pas le même modèle sont signalés', () => {
  const r = power.audit({
    psus: [{ uid: 'g1', model: alim(), nodes: ['a', 'b'], mixedModel: true }],
    nodes: [nodeFrom('a', 'un', boule()), nodeFrom('b', 'deux', boule())],
  });
  const c = r.psus[0].checks.find(x => x.code === 'psu-incoherent');
  assert.ok(c, 'sinon la capacité retenue est une supposition silencieuse');
  assert.strictEqual(c.level, 'warn');
});

test('un node sans alimentation reste orphelin, et ne fausse aucun total', () => {
  const nodes = [nodeFrom('a', 'rattaché', boule()), nodeFrom('b', 'seul', boule())];
  const r = power.audit({ psus: [{ uid: 'g1', model: alim(), nodes: ['a'] }], nodes });
  assert.deepStrictEqual(r.orphelins.map(o => o.ip), ['b']);
  assert.strictEqual(r.totals.rattaches, 1);
  assert.strictEqual(r.totals.nodes, 2);
});
