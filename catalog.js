// La mécanique commune aux catalogues de Fleet — produits LED, drivers,
// alimentations.
//
// ── Pourquoi un module et pas trois copies ─────────────────────────────────
// Les trois catalogues décrivent des choses différentes mais posent exactement
// les mêmes problèmes, et ce sont ces problèmes-là qui ont coûté cher :
//
//   · un identifiant attribué ne doit JAMAIS être réattribué, parce que des
//     nodes le portent sur le terrain et qu'un marqueur recyclé désigne
//     silencieusement autre chose ;
//   · une révision doit monter quand les RÉGLAGES changent et pas quand on
//     corrige une faute dans un nom, sinon tout ce qui est déjà installé se
//     signale « en retard » pour rien ;
//   · un marqueur qu'on ne reconnaît pas se conserve, il vient d'un poste dont
//     le catalogue est plus complet ;
//   · retirer n'est pas supprimer tant que quelque chose y renvoie.
//
// Recopier ce code deux fois, c'est accepter que ces quatre règles divergent
// entre trois fichiers dans six mois. Elles vivent donc ici, une fois, avec
// leurs tests.
//
// ── Ce qui reste propre à chaque type ──────────────────────────────────────
// Le descripteur passé à makeCatalog() dit trois choses : comment normaliser la
// partie métier, ce qui fait monter la révision, et sous quelle clé les
// enregistrements sont rangés. Tout le reste est ici.
'use strict';

const { randomUUID } = require('crypto');

const RE_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUid = v => typeof v === 'string' && RE_UID.test(v);
// L'ancien identifiant court à 2 caractères, encore porté par des nodes patchés
// avant le passage à l'uuid. On ne l'attribue plus ; on sait le reconnaître.
const isLegacyId = v => typeof v === 'string' && /^[0-9a-z]{2}$/.test(v);

// « LEDpro » + « Flex60 » -> « ledpro-flex60 ». Figé à la création : un
// renommage ne le suit pas, sinon chaque correction de nom devient un
// delete+add dans le dépôt et une resynchronisation pour tout le monde.
const slugify = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const num = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def; };

// La référence commerciale, identique pour les trois types : on achète un
// produit LED, une carte et une alimentation de la même façon.
function normRef(ref) {
  const r = ref || {};
  const brand = String(r.brand || '').trim().slice(0, 40);
  const model = String(r.model || '').trim().slice(0, 40);
  if (!brand && !model) throw new Error('marque ou modèle requis');
  return { brand, model, sku: String(r.sku || '').trim().slice(0, 40), internal: String(r.internal || '').trim().slice(0, 40), note: String(r.note || '').trim().slice(0, 200) };
}

const labelOf = p => [p.ref.brand, p.ref.model].filter(Boolean).join(' ') || p.slug;

/**
 * @param spec {
 *   kind          nom court du type, pour les messages et les chemins du dépôt
 *   collection    clé sous laquelle les enregistrements sont rangés ('products'…)
 *   format        format du magasin local
 *   formatVersion version du format
 *   nodeFormat    format du fichier embarqué sur les nodes
 *   norm(x, opts) partie métier normalisée, fusionnée dans l'enregistrement
 *   substance(p)  ce qui fait monter la révision
 *   fallbackSlug  nom de repli quand marque et modèle donnent une chaîne vide
 *   preNorm(x)    (option) réécrit une entrée avant normalisation — sert aux
 *                 anciens formats
 * }
 */
function makeCatalog(spec) {
  const { collection, format, formatVersion, nodeFormat, norm, substance, fallbackSlug = 'objet', preNorm = x => x } = spec;

  function normOne(input, opts = {}) {
    const x = input || {};
    const ref = normRef(x.ref);
    return {
      uid: isUid(x.uid) ? x.uid : null,                // frappé à l'insertion
      // ancien identifiant court : conservé À VIE quand il a existé, car des
      // nodes le portent encore dans leur /fleet.json
      legacyId: isLegacyId(x.legacyId) ? x.legacyId : null,
      rev: Math.max(1, num(x.rev, 1, 1, 1e9)),
      // révision du dépôt partagé sur laquelle celle-ci s'appuie. Sert à
      // distinguer « j'ai continué à partir de la version en ligne » de « nous
      // avons tous les deux modifié la même version chacun de notre côté ».
      basedOnRev: x.basedOnRev === null || x.basedOnRev === undefined ? null : num(x.basedOnRev, null, 0, 1e9),
      slug: slugify(x.slug || `${ref.brand}-${ref.model}`) || fallbackSlug,
      ref,
      ...norm(x, opts),
      retired: !!x.retired,
      origin: x.origin === 'library' ? 'library' : 'local',
      blobSha: typeof x.blobSha === 'string' ? x.blobSha : null,
      dirty: x.dirty === undefined ? true : !!x.dirty,
      updatedAt: Number(x.updatedAt) || Date.now(),
      updatedBy: String(x.updatedBy || '').slice(0, 40),
    };
  }

  function normStore(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const items = (Array.isArray(s[collection]) ? s[collection] : []).map(p => {
      try { return normOne(preNorm(p)); } catch { return null; }   // une entrée abîmée ne fait pas tomber le chargement
    }).filter(Boolean);
    for (const p of items) if (!p.uid) p.uid = randomUUID();
    return { format, formatVersion, syncedAt: Number(s.syncedAt) || 0, [collection]: items };
  }

  const itemsOf = store => (Array.isArray(store) ? store : ((store && store[collection]) || []));

  // ── Résolution d'un marqueur lu sur un node ──────────────────────────────
  // Le marqueur est opaque : uuid pour tout ce que Fleet écrit désormais,
  // identifiant court pour ce qu'il a écrit avant. On accepte les deux, sans
  // jamais réécrire le node de force.
  function resolve(store, marker) {
    if (!marker) return null;
    // pas de normStore ici : c'est un accès en lecture, appelé une fois par
    // sortie à chaque sondage. Re-normaliser rebattrait tout le catalogue — et
    // frapperait un uid neuf à chaque appel pour une entrée qui n'en a pas.
    const items = itemsOf(store);
    return items.find(p => p.uid === marker) || items.find(p => p.legacyId === marker) || null;
  }

  function upsert(store, input, opts = {}) {
    const st = normStore(store);
    const list = st[collection];
    const p = normOne(input, opts);
    const i = p.uid ? list.findIndex(x => x.uid === p.uid) : -1;
    if (i >= 0) {
      const before = list[i];
      p.slug = before.slug;                 // le slug ne suit pas les renommages
      p.legacyId = before.legacyId;         // ni l'ancien identifiant, que des nodes portent
      // la révision ne bouge que si les RÉGLAGES changent : renommer ne doit pas
      // signaler « en retard » à tout ce qui est déjà installé
      p.rev = substance(before) === substance(p) ? before.rev : before.rev + 1;
      list[i] = { ...p, dirty: true };
    } else {
      p.uid = p.uid || randomUUID();
      p.rev = 1;
      list.push(p);
    }
    list.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    return { store: st, product: list.find(x => x.uid === p.uid) };
  }

  // Retirer, pas supprimer : des marqueurs pointent dessus sur le terrain, et un
  // marqueur orphelin ne dit plus rien du tout. Ce qui n'est utilisé nulle part
  // et n'a jamais été publié peut en revanche disparaître pour de bon — la faute
  // de frappe corrigée dans la minute.
  function retire(store, uid, opts = {}) {
    const st = normStore(store);
    const p = st[collection].find(x => x.uid === uid || x.legacyId === uid);
    if (!p) throw new Error('produit inconnu');
    if (opts.purge && p.origin !== 'library') st[collection] = st[collection].filter(x => x.uid !== p.uid);
    else { p.retired = true; p.dirty = true; p.updatedAt = Date.now(); }
    return st;
  }

  // Où en est un node par rapport au catalogue ? `rev` est la révision qu'il dit
  // avoir reçue. Null quand il n'y a rien à comparer.
  //   'ok'       patché avec la version courante
  //   'stale'    le catalogue a bougé depuis : réappliquer mettrait à jour
  //   'ahead'    le node connaît une révision que ce poste n'a pas — catalogue
  //              local en retard, ne surtout PAS écraser
  //   'unknown'  marqueur qui ne désigne rien de connu ici
  function revState(item, rev) {
    if (!item) return 'unknown';
    const r = Number(rev);
    if (!Number.isFinite(r) || r <= 0) return null;
    return r === item.rev ? 'ok' : r < item.rev ? 'stale' : 'ahead';
  }

  // ── La copie embarquée sur le node ───────────────────────────────────────
  // Un marqueur renvoie à un catalogue extérieur : un node qui arrive sur un
  // poste neuf désigne alors quelque chose dont personne n'a la description. La
  // copie lui permet de se raconter tout seul. Ce n'est pas une autorité, c'est
  // un exemplaire daté, à comparer — rien ne le recopie sans un geste, et c'est
  // précisément ce qui permet de CONSTATER une divergence au lieu de l'effacer.
  function nodeSlice(store, markers) {
    const items = [];
    const seen = new Set();
    for (const mk of markers || []) {
      const p = resolve(store, mk);
      if (!p || seen.has(p.uid)) continue;
      seen.add(p.uid);
      const { blobSha, dirty, ...keep } = p;   // état de synchro local : sans objet sur un node
      items.push(keep);
    }
    items.sort((a, b) => a.uid.localeCompare(b.uid));
    return { format: nodeFormat, formatVersion, savedAt: Date.now(), [collection]: items };
  }

  function parseNodeSlice(doc) {
    if (!doc || typeof doc !== 'object' || doc.format !== nodeFormat) return null;
    const items = (Array.isArray(doc[collection]) ? doc[collection] : [])
      .map(p => { try { return normOne(p); } catch { return null; } })
      .filter(p => p && isUid(p.uid));
    return { format: nodeFormat, formatVersion: Number(doc.formatVersion) || formatVersion, savedAt: Number(doc.savedAt) || 0, [collection]: items };
  }

  // Que dit la copie du node par rapport au catalogue de ce poste ?
  //   'same' · 'absent' (inconnu ici) · 'newer' (le node est en avance) ·
  //   'older' (nous sommes en avance) ·
  //   'diverged' MÊME révision, réglages DIFFÉRENTS : deux postes hors ligne ont
  //   fait monter le même numéro sur des contenus différents, le numéro ne
  //   départage plus et il faut choisir à la main.
  function compareNodeSlice(store, slice) {
    const out = [];
    for (const np of (slice && slice[collection]) || []) {
      const mine = resolve(store, np.uid);
      const state = !mine ? 'absent'
        : np.rev > mine.rev ? 'newer'
          : np.rev < mine.rev ? 'older'
            : substance(np) === substance(mine) ? 'same' : 'diverged';
      out.push({ uid: np.uid, label: labelOf(np), rev: np.rev, mineRev: mine ? mine.rev : null, state, product: np });
    }
    return out;
  }

  return {
    kind: spec.kind, collection, FORMAT: format, FORMAT_VERSION: formatVersion, NODE_FORMAT: nodeFormat,
    normOne, normStore, upsert, retire, resolve, find: resolve, revState,
    nodeSlice, parseNodeSlice, compareNodeSlice, substance, label: labelOf,
  };
}

module.exports = { makeCatalog, isUid, isLegacyId, slugify, num, normRef, labelOf };
