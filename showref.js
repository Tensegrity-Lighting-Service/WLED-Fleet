// ── La référence du show ─────────────────────────────────────────────────────
//
// Fleet a toujours mémorisé le dernier état connu d'un node, hors ligne et au
// redémarrage. Ce qui manquait, c'est de savoir QUI A BOUGÉ. Un sondage écrasait
// rec.cfg sans rien retenir : un node qui revenait avec une autre valeur
// devenait la vérité en silence, et la seule trace était un liseré de dix
// minutes dans la grille. Passé ce délai, plus rien. Dans l'autre sens, une
// intention posée par l'utilisateur et pas encore partie portait le même genre
// de marque — deux situations opposées, impossibles à distinguer.
//
// La référence garde, colonne par colonne, la valeur que Fleet tient pour celle
// du SPECTACLE. Elle se compare à la valeur vivante, et l'écart se lit dans la
// cellule concernée : pas dans un tableau à part, qui serait décorrélé de
// l'endroit où on le corrige.
//
// Elle bouge dans deux cas seulement, et c'est ce qui fait toute sa valeur :
//
//   - un TROU se remplit (`seed`). Une colonne dont Fleet n'a jamais eu d'avis
//     prend la première valeur vue. Un node fraîchement découvert n'affiche donc
//     aucun écart — sinon la grille se couvrirait de marques que personne n'a
//     provoquées.
//   - une modification est attribuée à NOUS (`NOTRES`, côté server.js). C'est le
//     seul point d'accroche nécessaire : chaque écriture — cellule, sorties,
//     unifier, IP fixe — resonde ensuite le node avec la source « grille », et
//     une restauration de sauvegarde est déjà distinguée par `restoreUntil`.
//
// Ce qu'elle ne fait JAMAIS : se réaligner sur un sondage ordinaire. Une mise à
// jour de firmware (source « maj ») ne réaligne pas non plus — c'est précisément
// le moment où l'on veut voir ce que le firmware a changé tout seul.
'use strict';

const { REF } = require('./columns');

// chemin pointé dans le record {meta, info, state, cfg, derived}
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isCol = colId => REF.some(c => c.id === colId);

// Fleet vient de décider cette valeur : elle devient la référence.
function set(ref, colId, value) {
  if (!isCol(colId)) return ref;
  if (value === undefined || value === null) delete ref[colId];
  else ref[colId] = value;
  return ref;
}

// Remplit les colonnes sur lesquelles Fleet n'a pas encore d'avis. N'écrase
// rien : c'est la différence entre semer et se réaligner, et tout le dispositif
// tient sur elle.
function seed(ref, rec) {
  let n = 0;
  for (const c of REF) {
    if (ref[c.id] !== undefined) continue;
    const v = getPath(rec, c.path);
    if (v !== undefined && v !== null) { ref[c.id] = v; n++; }
  }
  return n;
}

// Les colonnes où la référence et le node ne disent pas la même chose, avec la
// valeur du SHOW (le client a déjà celle du node dans le record).
//
// Un node hors ligne compare avec sa dernière valeur connue : c'est justement ce
// qu'on veut voir en préparant un spectacle sans matériel sous la main.
function ecarts(ref, rec) {
  const out = {};
  if (!ref) return out;
  for (const c of REF) {
    const r = ref[c.id];
    if (r === undefined) continue;
    const v = getPath(rec, c.path);
    if (v === undefined) continue; // la colonne n'existe pas sur ce firmware : ce n'est pas un écart
    if (!same(r, v)) out[c.id] = r;
  }
  return out;
}

// « Garder la valeur du node » : la référence s'aligne, rien n'est envoyé.
// `cols` absent = toutes les colonnes de ce node.
function align(ref, rec, cols) {
  const list = cols && cols.length ? REF.filter(c => cols.includes(c.id)) : REF;
  let n = 0;
  for (const c of list) {
    const v = getPath(rec, c.path);
    if (v === undefined) continue;
    if (!same(ref[c.id], v)) { ref[c.id] = v; n++; }
  }
  return n;
}

module.exports = { REF, getPath, set, seed, ecarts, align };
