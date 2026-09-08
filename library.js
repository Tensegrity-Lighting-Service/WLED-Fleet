// Catalogue de produits LED — le « quoi est branché », partageable en ligne.
//
// Avant : une ligne locale {name, type, order, len}, plus deux champs (perM,
// note) que personne ne lisait ni n'écrivait. Ça décrivait un tiers du produit
// et ne se partageait pas.
//
// Maintenant : un produit porte TOUS les réglages qui lui sont propres, une
// référence structurée, et plusieurs longueurs types. Ce qui relève de
// l'installation — sens inversé, index de départ, univers, adresse — n'y est
// pas : appliquer un produit ne peut donc jamais casser un patch existant.
//
// ── Ce qui vit ici, et ce qui vit dans catalog.js ──────────────────────────
// L'identité (uuid jamais réattribué), les révisions, le retrait, la copie
// embarquée sur les nodes et la comparaison sont communs aux trois catalogues
// de Fleet : ils sont dans catalog.js, avec leurs tests. Ce fichier ne garde
// que ce qui est propre aux rubans — le vocabulaire de hw.led.ins[], les
// longueurs types, la correspondance avec une sortie, et la migration des deux
// formats précédents, qui n'ont jamais concerné qu'eux.
//
// ── Identité : un GUID, pas un numéro attribué ──────────────────────────────
// Le node mémorise QUEL produit a rempli chaque sortie. Ce marqueur doit rester
// vrai à vie et désigner le même produit sur tous les postes, sinon un node
// déplacé pointe vers autre chose.
//
// La première version utilisait un identifiant court à 2 caractères, hérité de
// l'époque où le marqueur devait tenir dans un champ MQTT de 40 caractères. Il
// fallait alors un ALLOCATEUR CENTRAL — lire index.json, choisir le prochain
// libre, réécrire avec son sha, recommencer sur conflit — et une liste d'ids
// « brûlés » pour qu'un produit retiré ne rende jamais son numéro au suivant.
// Beaucoup de machinerie, et deux postes hors ligne pouvaient quand même
// inventer le même identifiant.
//
// Le marqueur vit désormais dans /fleet.json, un vrai fichier : la contrainte de
// taille a disparu. Un uuid v4 tiré à la création est unique sans se concerter
// avec personne — plus d'allocateur, plus de conflit d'attribution, plus d'ids
// brûlés, et deux postes peuvent créer des produits hors ligne toute la journée.
//
// ── Révisions : savoir avec QUELLE version un node a été patché ─────────────
// `rev` s'incrémente dès que les réglages du produit changent (led ou
// longueurs), pas quand on corrige une faute dans son nom. Le node retient la
// révision appliquée. Un node qui n'a pas tourné depuis six mois annonce donc
// « patché en rev 3 » alors que la bibliothèque est en rev 5 : Fleet le voit,
// le dit, et propose de réappliquer — au lieu de laisser croire que ses
// réglages sont à jour parce que le nom du produit correspond.
'use strict';

const { makeCatalog, isUid, isLegacyId, slugify, num } = require('./catalog');

// La liste des types à canal blanc fait partie du vocabulaire WLED, au même
// titre que LED_TYPES : sans elle, la migration effacerait l'échange du blanc
// des anciens profils (le quartet haut de `order`).
const { WHITE_SWAP_TYPES, VOLTAGES } = require('./columns');

const FORMAT = 'wled-led-library-local';
const FORMAT_VERSION = 3;
const NODE_FILE = '/fleet-lib.json';
const NODE_FORMAT = 'wled-fleet-node-library';

// Les réglages qui décrivent le PRODUIT, repris tels quels de hw.led.ins[] pour
// qu'appliquer un produit soit une copie de champs, sans traduction.
// `order` est le quartet BAS et `wswap` le quartet HAUT du même octet WLED :
// le serveur les recompose, comme il le fait déjà pour l'éditeur de sorties.
function normLed(led, whiteSwapTypes = WHITE_SWAP_TYPES) {
  const l = led || {};
  const type = num(l.type, 22, 0, 255);
  return {
    type,
    order: num(l.order, 0, 0, 15),
    // WLED remet l'échange du blanc à zéro sur un type qui n'a pas de canal
    // blanc ; le catalogue fait pareil plutôt que de garder une valeur morte.
    wswap: whiteSwapTypes.includes(type) ? num(l.wswap, 0, 0, 15) : 0,
    // mA par pixel à pleine luminosité. Borné à 255 parce que le firmware le
    // range dans un uint8_t (bus_manager.h:285) : au-delà, la valeur ne serait
    // pas refusée mais TRONQUÉE en silence à la relecture du cfg
    // (cfg.cpp:241), et l'ABL freinerait d'après un chiffre que personne n'a
    // saisi. L'ancienne borne à 10000 laissait passer ça.
    //
    // 255 n'est pas « 255 mA » : c'est le modèle de puissance WS2815
    // (estimateCurrent(), bus_manager.cpp:198), soit 12 mA/LED. Un vrai courant
    // se déclare donc entre 1 et 254.
    ledma: num(l.ledma, 55, 0, 255),
    skip: num(l.skip, 0, 0, 4096),
    offRefresh: !!l.offRefresh,
    perM: l.perM === null || l.perM === undefined || l.perM === '' ? null : num(l.perM, null, 1, 1000),
  };
}

// ── Longueurs types, et assemblages à plusieurs sorties ────────────────────
// Un preset n'est qu'un RACCOURCI DE SAISIE. La vérité sur ce qui est branché
// reste `hw.led.ins[i].len`, lu sur le node : rien ici ne la réécrit sans un
// « Enregistrer » explicite, et une longueur sur mesure est parfaitement
// légitime — elle n'a simplement pas de nom.
//
// `segments` permet de décrire un produit livré en PLUSIEURS morceaux pilotés
// par plusieurs sorties : une tournette dont l'anneau intérieur et l'anneau
// extérieur sont deux rubans distincts est un seul produit, pas deux. Le cas
// courant reste un seul segment, et `px` en donne alors directement la
// longueur ; pour un assemblage, `px` vaut le total.
//
// À ne pas confondre avec une fixture : le produit dit ce qu'on ACHÈTE, la
// fixture dit ce que la console PILOTE. Un assemblage vendu d'un bloc est un
// produit ; deux rubans réunis pour ce spectacle-là sont une fixture.
function normPresets(list, perM) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const raw = Array.isArray(p && p.segments) && p.segments.length ? p.segments : [p && p.px];
    const segments = raw.map(v => num(v, null, 1, 100000)).filter(v => v !== null);
    if (!segments.length) continue;
    const px = segments.reduce((a, b) => a + b, 0);
    if (out.some(x => x.px === px && x.segments.length === segments.length)) continue;  // doublons écartés
    const label = String((p && p.label) || '').trim().slice(0, 30)
      || (segments.length > 1 ? `${segments.length} sorties · ${segments.join(' + ')} px` : defaultLabel(px, perM));
    out.push({ label, px, segments, ...(p && p.default ? { default: true } : {}) });
  }
  out.sort((a, b) => a.px - b.px);
  if (out.length && !out.some(p => p.default)) out[0].default = true;
  return out;
}
const defaultLabel = (px, perM) => (perM ? `${Math.round((px / perM) * 10) / 10} m` : `${px} px`);

// ── Ce qui est électrique, et pourquoi c'est à CÔTÉ de `led` ───────────────
// docs/fixture-mapping.md publie que `led` reprend le vocabulaire de
// hw.led.ins[] : appliquer un produit à une sortie est une copie de champs,
// sans traduction. Un `volts` glissé dedans casserait cette promesse — le jour
// où quelqu'un écrit Object.assign(ins[i], product.led), il envoie un champ que
// WLED ne connaît pas.
//
// `volts` est une LISTE : un même ruban existe souvent en 12 et en 24 V, et une
// liste vide veut dire « je ne sais pas », jamais « c'est bon ». C'est pour ça
// qu'il n'y a pas de valeur par défaut : en inventer une ferait passer au vert
// une vérification que personne n'a renseignée.
function normElec(elec, perM) {
  const e = elec || {};
  const volts = [...new Set((Array.isArray(e.volts) ? e.volts : []).map(Number).filter(v => VOLTAGES.includes(v)))].sort((a, b) => a - b);
  const wPerM = e.wPerM === null || e.wPerM === undefined || e.wPerM === '' ? null : Math.round(Number(e.wPerM) * 10) / 10;
  let wPerPx = e.wPerPx === null || e.wPerPx === undefined || e.wPerPx === '' ? null : Math.round(Number(e.wPerPx) * 1000) / 1000;
  // les deux chiffres du fabricant disent la même chose : on déduit celui qui
  // manque plutôt que de demander deux fois la même information
  if (wPerPx === null && wPerM !== null && perM) wPerPx = Math.round((wPerM / perM) * 1000) / 1000;
  return {
    volts,
    wPerM: Number.isFinite(wPerM) ? wPerM : null,
    wPerPx: Number.isFinite(wPerPx) ? wPerPx : null,
    // d'où sort le chiffre : mesuré au banc, lu sur la fiche, ou estimé. Sans
    // ça, personne ne saura six mois plus tard s'il est fiable.
    note: String(e.note || '').trim().slice(0, 120),
  };
}

// Ce qui définit la RÉVISION : uniquement ce qui décrit le produit lui-même.
// Corriger une faute dans le nom ne doit pas faire croire aux nodes déjà
// patchés qu'ils sont en retard. La tension en fait partie : la corriger DOIT
// signaler que les nodes portent une fiche fausse.
const substance = p => JSON.stringify({ led: p.led, elec: p.elec, presets: p.presets.map(x => x.px) });

const cat = makeCatalog({
  kind: 'product',
  collection: 'products',
  format: FORMAT,
  formatVersion: FORMAT_VERSION,
  nodeFormat: NODE_FORMAT,
  fallbackSlug: 'produit',
  substance,
  norm(x, opts) {
    const led = normLed(x.led, opts.whiteSwapTypes || WHITE_SWAP_TYPES);
    return { led, elec: normElec(x.elec, led.perM), presets: normPresets(x.presets, led.perM) };
  },
  // v2 du magasin local : l'identifiant court vivait dans `id`
  preNorm: p => (p && typeof p === 'object' && !p.legacyId && isLegacyId(p.id) ? { ...p, legacyId: p.id } : p),
});

// ── Migration depuis les formats précédents ────────────────────────────────
// v1 : un tableau nu de {name, type, order, len}.
// v2 : {products:[{id:'0a',…}], burnedIds:[…]} — identifiants courts attribués.
//
// Dans les deux cas l'identifiant court devient `legacyId` et le produit reçoit
// un uid. Les marqueurs déjà posés sur les nodes continuent donc de résoudre :
// c'est tout l'objet de `resolve()`. `burnedIds` disparaît — un uuid n'est
// jamais réattribué, il n'y a plus rien à brûler.
//
// Propre aux produits : ce sont les seuls à avoir eu une vie avant l'uuid.
function migrate(raw) {
  if (raw && !Array.isArray(raw) && raw.format === FORMAT) return cat.normStore(raw);
  const list = Array.isArray(raw) ? raw : [];
  const products = list.filter(x => x && x.name).map(old => cat.normOne({
    legacyId: isLegacyId(old.id) ? old.id : null,
    slug: slugify(old.name),
    ref: { brand: '', model: String(old.name).slice(0, 40), note: String(old.note || '') },
    led: { type: old.type, order: Number(old.order) & 0x0f, wswap: (Number(old.order) || 0) >> 4, perM: old.perM },
    presets: old.len ? [{ px: old.len, default: true }] : [],
    origin: 'local', dirty: true,
  }));
  return cat.normStore({ products });
}

// Le preset d'UNE sortie : celui dont l'unique segment fait cette longueur. Un
// assemblage à plusieurs segments ne se reconnaît pas sur une sortie isolée.
const presetFor = (product, len) => (product && product.presets.find(p => p.segments.length === 1 && p.segments[0] === Number(len))) || null;
// Le preset d'un ASSEMBLAGE : les longueurs des sorties consécutives, dans
// l'ordre. Sert à reconnaître une tournette au complet plutôt que deux rubans
// sans rapport.
const presetForAssembly = (product, lens) => {
  const l = (lens || []).map(Number);
  return (product && product.presets.find(p => p.segments.length === l.length && p.segments.every((s, i) => s === l[i]))) || null;
};

// Un produit correspond-il à ce qu'une sortie déclare ? On compare ce qui
// identifie le produit — type de ruban, ordre des couleurs — puis la longueur.
//
// `strict` (par défaut) exige que la longueur soit l'une des longueurs types :
// c'est ce qu'il faut pour DEVINER le produit d'une sortie qui ne porte aucun
// marqueur, où se tromper serait pire que ne rien dire. Sans `strict`, on
// accepte une longueur sur mesure : c'est ce qu'il faut pour confirmer un
// marqueur déjà posé, puisque le node fait foi sur sa longueur et qu'un ruban
// coupé aux mesures reste le même produit.
function matches(product, ins, opts = {}) {
  if (!product || !ins) return false;
  const order = (Number(ins.order) || 0) & 0x0f, wswap = (Number(ins.order) || 0) >> 4;
  const sameKind = Number(product.led.type) === Number(ins.type) && product.led.order === order
    && (product.led.wswap === wswap || product.led.wswap === 0);
  if (!sameKind) return false;
  return opts.strict === false ? true : !!presetFor(product, ins.len);
}

// ── Ce qu'une sortie a de différent de la fiche qu'elle revendique ─────────
// Le node fait foi : une longueur sur mesure, un ordre corrigé sur place, un
// mA/pixel relevé au banc sont tous légitimes. Mais si rien ne le DIT, le
// marqueur laisse croire que la sortie est conforme au produit, et on découvre
// l'écart le jour où on réapplique la fiche par-dessus.
//
// D'où ce relevé : le preset reconnu quand il y en a un, et sinon le fait que
// la longueur est sur mesure ; plus la liste des champs qui divergent. Il est
// calculé côté serveur et voyage dans le plan DMX, pour que l'interface n'ait
// rien à redeviner — et pour qu'un satellite y ait accès aussi.
function deviations(product, ins) {
  if (!product || !ins) return null;
  const order = (Number(ins.order) || 0) & 0x0f, wswap = (Number(ins.order) || 0) >> 4;
  const fields = [];
  const cmp = (key, label, mine, node) => {
    if (node === undefined || node === null) return;      // le node ne dit rien : rien à comparer
    if (Number(mine) !== Number(node)) fields.push({ key, label, product: Number(mine), node: Number(node) });
  };
  cmp('type', 'type de LED', product.led.type, ins.type);
  cmp('order', 'ordre des couleurs', product.led.order, order);
  // l'échange du blanc n'a de sens que si le produit en déclare un
  if (product.led.wswap) cmp('wswap', 'échange du blanc', product.led.wswap, wswap);
  cmp('ledma', 'mA par pixel', product.led.ledma, ins.ledma);
  cmp('skip', 'LEDs sautées', product.led.skip, ins.skip);
  if (ins.ref !== undefined && !!product.led.offRefresh !== !!ins.ref) {
    fields.push({ key: 'offRefresh', label: 'off refresh', product: product.led.offRefresh, node: !!ins.ref });
  }
  const preset = presetFor(product, ins.len);
  const len = Number(ins.len);
  return {
    preset: preset ? preset.label : null,
    // longueur qui ne correspond à aucune longueur type : parfaitement valable,
    // mais elle mérite un nom — ou d'être enregistrée comme longueur type
    customLen: !preset && Number.isFinite(len) ? len : null,
    label: preset ? preset.label : (Number.isFinite(len) ? `${len} px · sur mesure` : ''),
    fields,
    // vrai dès que quelque chose diverge de la fiche, longueur comprise
    modified: !preset || fields.length > 0,
  };
}

module.exports = {
  FORMAT, FORMAT_VERSION, NODE_FILE, NODE_FORMAT, isUid, isLegacyId, slugify, deviations,
  nodeSlice: cat.nodeSlice, parseNodeSlice: cat.parseNodeSlice, compareNodeSlice: cat.compareNodeSlice,
  normProduct: cat.normOne, normStore: cat.normStore, migrate,
  upsert: cat.upsert, retire: cat.retire, resolve: cat.resolve, find: cat.resolve, revState: cat.revState,
  label: cat.label, presetFor, presetForAssembly, matches, defaultLabel, substance,
  normLed, normPresets, normElec, catalog: cat,
};
