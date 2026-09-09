// La chaîne électrique : est-ce que ça tient ?
//
// Fonctions pures, sur le modèle de dmx.js — aucun réseau, aucun état, donc
// éprouvables sur les données réelles de la flotte sans allumer quoi que ce soit.
//
// ── Ce que WLED fait vraiment, vérifié dans le firmware v16.0.1 ────────────
// Tout ce module en dépend, donc c'est écrit ici plutôt que supposé ailleurs.
//
// `BusManager::initializeABL()` / `applyABL()` (bus_manager.cpp:1447-1524) :
//
//   · DEUX RÉGIMES QUI S'EXCLUENT. Si hw.led.maxpwr > 0, le freinage est GLOBAL
//     et les limites par sortie (ins[i].maxpwr) sont entièrement ignorées —
//     elles ne servent que lorsque la limite globale vaut 0. Vérifié à chaque
//     point d'appel : ins[].maxpwr n'est lu qu'en :1461 et :1472, dans la
//     branche `else`, et _milliAmpsLimit n'est écrit que par setCurrentLimit()
//     appelé au seul :1476.
//
//   · L'ESP SE SERT EN PREMIER. MA_FOR_ESP vaut 120 mA sur ESP32
//     (bus_manager.h:525). En régime global il est retiré une fois du budget ;
//     en régime par sortie il est DIVISÉ entre les bus actifs (:1467).
//
//   · UN PLANCHER. Si le budget utile ne couvre pas 1 mA par pixel, la
//     luminosité est clouée au minimum (1/255), pas simplement réduite.
//
//   · LA VEILLE COMPTE. estimateCurrent() (:196-207) ajoute 1 mA par LED en
//     plus du calcul couleur : le pire cas exact d'une sortie est donc
//     len × (ledma + 1), et non len × ledma.
//
//   · 255 N'EST PAS UN COURANT. C'est le modèle WS2815 (12 mA/LED, somme des
//     couleurs ×3, WLED #549) : déclarer 255 freine MOINS que déclarer 55.
//
// ── La réserve à connaître ─────────────────────────────────────────────────
// WLED ne connaît PAS la tension. `maxpwr` est un courant en milliampères, et
// rien dans le node ne dit sous quelle tension. Ce module le traite comme un
// courant À LA TENSION DES PRODUITS BRANCHÉS. Quand les sorties d'un node
// mélangent des tensions, il REFUSE de conclure plutôt que de choisir.
//
// ── Pourquoi on somme les budgets et jamais les pires cas ──────────────────
// Sur une flotte réelle, tous les nodes sont bridés par l'ABL : le pire cas
// théorique dépasse partout le budget déclaré, de 43 % à 6 %. Sommer les pires
// cas donnerait 338 A pour une flotte qui ne peut pas dépasser une quarantaine
// d'ampères par construction, et produirait une alerte permanente que personne
// ne lirait. C'est le `maxpwr` déclaré qui décrit la consommation réellement
// autorisée.
//
// ── Et pourquoi un rapport vide est le résultat normal ─────────────────────
// Une vérification qui parle tout le temps ne sert à rien. Chaque seuil est
// calibré pour qu'une flotte saine ne produise AUCUN constat — y compris face
// aux valeurs que le firmware fabrique tout seul (cfg.cpp:242 répartit la
// limite globale au prorata des pixels quand elle manque, d'où les 2666 et 33
// qu'on trouve dans les configs sans que personne ne les ait saisis).
'use strict';

const { MA_FOR_ESP, LED_MA_MAX } = require('./columns');

// Valeur par défaut du firmware pour une limite par sortie (const.h:596). Une
// valeur égale à celle-ci n'est pas un réglage, c'est un défaut.
const ABL_DEFAULT = 850;
// mA par pixel supposé quand rien ne le déclare : le défaut de WLED pour un
// WS2812 générique (const.h)
const ABL_DEFAULT_LEDMA = 55;

const DEF = {
  usage: 0.60,      // part du pire cas qu'un contenu réel atteint
  headroom: 0.20,   // marge gardée sous la capacité utilisable
  derate: 0.80,     // taux d'usage d'une alimentation, quand elle ne le dit pas
  voltTol: 0.05,    // écart de tension toléré (5 %)
  crossTol: 0.30,   // écart toléré entre ledma×V et les W/pixel déclarés
  minWhite: 0.90,   // en dessous, on signale que le blanc plein est inatteignable
  hardWhite: 0.50,  // en dessous, on le signale plus fort
};

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const chk = (level, code, msg, extra = {}) => ({ level, code, msg, ...extra });

// ── Le budget d'un node, sans rien savoir des autres ───────────────────────
//
//   ins      hw.led.ins[] tel que lu sur le node — la vérité sur ce qui est câblé
//   maxpwr   hw.led.maxpwr, la limite globale (0 = régime par sortie)
//   ignored  positions déclarées non câblées : elles ne consomment rien
//   product  (i) -> la fiche du produit de la sortie i, ou null
//   fixture  (i) -> le numéro de fixture console de la sortie i, ou null. Il ne
//            sert à aucun calcul : il permet au schéma de placer une sortie
//            sous sa fixture plutôt que directement sous son node.
//   driver   la fiche de la carte, ou null
function nodeBudget({ maxpwr = 0, ins = [], ignored = [], product = () => null, fixture = () => null, driver = null, opts = {} } = {}) {
  const o = { ...DEF, ...opts };
  const ig = new Set(ignored);
  const cap = Number(maxpwr) || 0;

  const outputs = ins.map((b, i) => {
    const len = Number(b.len) || 0;
    const ledma = Number(b.ledma);
    const ma = Number.isFinite(ledma) ? ledma : 55;
    // 255 = modèle WS2815 : la consommation réelle estimée est 12 mA/LED, pas 255
    const effective = ma === LED_MA_MAX ? 12 : ma;
    return {
      i, len, ledma: ma, ignored: ig.has(i),
      // pire cas exact : la veille compte pour 1 mA par LED en plus de la couleur
      worstMa: ig.has(i) ? 0 : len * (effective + 1),
      ownLimit: Number(b.maxpwr) || 0,
      product: product(i) || null,
      fixture: fixture(i),
    };
  });

  const counted = outputs.filter(x => !x.ignored && x.len > 0);
  const px = counted.reduce((a, x) => a + x.len, 0);
  const worstMa = counted.reduce((a, x) => a + x.worstMa, 0);

  // Le régime se DÉDUIT, il n'est stocké nulle part — c'est le discriminant du
  // firmware lui-même.
  const perOutput = cap === 0 && counted.some(x => x.ownLimit > 0);
  const checks = [];

  let budgetMa = 0, ratio = null;
  if (perOutput) {
    const actifs = counted.filter(x => x.ownLimit > 0);
    const share = MA_FOR_ESP / Math.max(1, actifs.length);   // l'ESP est réparti entre les bus
    let worstRatio = 1;
    for (const x of actifs) {
      const utile = Math.max(x.len, x.ownLimit - share);     // plancher : 1 mA par pixel
      x.ratio = x.worstMa ? Math.min(1, utile / x.worstMa) : 1;
      worstRatio = Math.min(worstRatio, x.ratio);
      budgetMa += x.ownLimit;
    }
    ratio = worstRatio;
  } else if (cap > 0) {
    budgetMa = cap;
    const utile = cap - MA_FOR_ESP;
    if (cap <= MA_FOR_ESP) {
      checks.push(chk('bad', 'esp-mange-tout',
        `budget de ${cap} mA entièrement consommé par l'ESP (${MA_FOR_ESP} mA) : la luminosité reste au minimum`));
      ratio = 0;
    } else if (utile <= px) {
      checks.push(chk('bad', 'bri-clouee',
        `budget utile ${utile} mA pour ${px} pixels : le firmware cloue la luminosité à 1/255`, { num: { utile, px } }));
      ratio = 0;
    } else {
      ratio = worstMa ? Math.min(1, utile / worstMa) : 1;
    }
  } else {
    checks.push(chk('warn', 'abl-absente', 'aucune limite de courant : rien ne bride ce node'));
  }

  // ── Ce qui se voit sortie par sortie ─────────────────────────────────────
  for (const x of counted) {
    // Le défaut le plus dangereux, et le seul silencieux : l'ABL ne freine
    // correctement que si ledma est honnête. Sous-déclaré, la tension
    // s'effondre et les données se corrompent, sans aucune erreur affichée.
    if (x.product && Number(x.product.led.ledma) > x.ledma) {
      const facteur = r2(x.product.led.ledma / Math.max(1, x.ledma));
      checks.push(chk('bad', 'abl-sous-declaree',
        `sortie ${x.i + 1} : ${x.ledma} mA/pixel déclarés alors que la fiche du produit dit ${x.product.led.ledma} — l'ABL laisse passer ${facteur}× le courant prévu`,
        { i: x.i, uid: x.product.uid, num: { declare: x.ledma, fiche: x.product.led.ledma, facteur } }));
    }
    // Le sens inverse : la sortie déclare PLUS que la fiche. Le node est alors
    // parfaitement sûr — il freine trop, pas trop peu. C'est la fiche du
    // produit qui est fausse, et le jour où quelqu'un l'appliquera à une
    // nouvelle sortie, il posera un 55 là où il faut 120. On le dit doucement,
    // et on désigne le bon coupable.
    if (x.product && Number(x.product.led.ledma) < x.ledma) {
      checks.push(chk('warn', 'fiche-sous-declaree',
        `sortie ${x.i + 1} : la fiche « ${x.product.ref.model || x.product.slug} » annonce ${x.product.led.ledma} mA/pixel alors que la sortie est réglée à ${x.ledma} — c'est probablement la fiche qu'il faut corriger`,
        { i: x.i, uid: x.product.uid, num: { declare: x.ledma, fiche: x.product.led.ledma } }));
    }
    if (x.ledma === 0) {
      checks.push(chk('bad', 'sortie-non-comptee',
        `sortie ${x.i + 1} à 0 mA/pixel : le firmware l'exclut de l'ABL, elle tire sans être comptée`, { i: x.i }));
    }
    // Une limite par sortie renseignée alors que la globale est active ne fait
    // RIEN. On ne le signale que si quelqu'un l'a voulue : ni le défaut du
    // firmware (850), ni la répartition qu'il calcule lui-même (cfg.cpp:242).
    if (cap > 0 && x.ownLimit > 0 && x.ownLimit !== ABL_DEFAULT) {
      const auto = px ? Math.floor((cap * x.len) / px) : 0;
      if (Math.abs(x.ownLimit - auto) > 1) {
        checks.push(chk('warn', 'limite-inerte',
          `sortie ${x.i + 1} : limite de ${x.ownLimit} mA sans effet — le régime par sortie n'agit que si la limite globale du node vaut 0`, { i: x.i }));
      }
    }
    // Croisement gratuit : le produit déclare des W/pixel et un mA/pixel ; sous
    // sa tension, les deux doivent dire la même chose.
    const e = x.product && x.product.elec;
    if (e && e.wPerPx && e.volts.length === 1) {
      const attendu = (x.ledma * e.volts[0]) / 1000;
      if (Math.abs(attendu - e.wPerPx) / e.wPerPx > o.crossTol) {
        checks.push(chk('warn', 'elec-inconsistent',
          `sortie ${x.i + 1} : ${x.ledma} mA sous ${e.volts[0]} V font ${r2(attendu)} W/pixel, mais la fiche annonce ${e.wPerPx}`, { i: x.i }));
      }
    }
  }

  // ── Les tensions du node ─────────────────────────────────────────────────
  // Un node n'a pas de tension propre : il hérite de celle de ses rubans. S'ils
  // ne s'accordent pas, aucun chiffre en ampères ne veut dire quoi que ce soit.
  const voltSets = counted.map(x => (x.product && x.product.elec ? x.product.elec.volts : [])).filter(v => v.length);
  const volts = voltSets.length
    ? voltSets.reduce((a, b) => a.filter(v => b.includes(v)))     // intersection : ce qui convient à TOUS
    : [];
  const mixedVolt = voltSets.length > 1 && volts.length === 0;
  if (mixedVolt) {
    checks.push(chk('warn', 'mixed-volt',
      'les produits de ce node ne partagent aucune tension : impossible de conclure sur son courant'));
  }

  // ── Ce que la carte supporte ─────────────────────────────────────────────
  if (driver && driver.board.maxA && budgetMa / 1000 > driver.board.maxA) {
    checks.push(chk('bad', 'abl-over-board',
      `budget de ${r1(budgetMa / 1000)} A pour une carte annoncée à ${driver.board.maxA} A`,
      { num: { budgetA: r1(budgetMa / 1000), boardA: driver.board.maxA } }));
  }
  if (driver && driver.board.maxAPerOut) {
    for (const x of counted) {
      const partMa = perOutput ? x.ownLimit : (worstMa ? budgetMa * (x.worstMa / worstMa) : 0);
      if (partMa / 1000 > driver.board.maxAPerOut) {
        checks.push(chk('warn', 'abl-over-out',
          `sortie ${x.i + 1} : ${r1(partMa / 1000)} A pour une sortie annoncée à ${driver.board.maxAPerOut} A`, { i: x.i }));
      }
    }
  }

  // ── Le blanc plein est-il atteignable ? ──────────────────────────────────
  // Ce n'est PAS une faute : une flotte bridée à 43 % peut être exactement ce
  // qu'on veut. Mais rien ne l'affiche nulle part, et c'est une information
  // qu'on préfère connaître avant le raccord que pendant.
  //
  // Toujours en `info`, jamais en avertissement, quel que soit le taux : sur
  // une vraie flotte TOUS les nodes sont bridés, de 43 % à 6 %. En faire une
  // alerte à partir d'un seuil, c'est teindre le rapport en orange dès la
  // première ouverture et le rendre illisible. Le chiffre est dans `num` : à
  // l'interface de le colorer si elle veut, au rapport de rester sobre.
  if (ratio !== null && ratio < o.minWhite && cap !== 0) {
    checks.push(chk('info', 'abl-clamped',
      `blanc plein atteignable à ${Math.round(ratio * 100)} %`, { num: { ratio: r2(ratio), bas: ratio < o.hardWhite } }));
  }

  // Facteur d'usage : ce qu'un contenu réel tire, plafonné par ce que l'ABL
  // autorise. Le min est capital — l'usage ne peut jamais dépasser le budget.
  const usageMa = Math.min(budgetMa || Infinity, worstMa * o.usage);
  // Ce n'est PAS un constat : c'est l'explication de la façon dont le chiffre
  // au-dessus a été obtenu. En faire une ligne de rapport le répéterait à
  // l'identique sur quatorze nodes, sans rien apprendre à personne. L'interface
  // l'affiche à côté du chiffre, là où la question se pose.
  const ablGoverns = !!budgetMa && worstMa * o.usage > budgetMa;

  return {
    maxA: r2(budgetMa / 1000), worstA: r2(worstMa / 1000), usageA: r2((Number.isFinite(usageMa) ? usageMa : 0) / 1000),
    px, ratio: ratio === null ? null : r2(ratio), perOutput, volts, mixedVolt, ablGoverns,
    outputs, checks,
  };
}

// ── La chaîne complète ─────────────────────────────────────────────────────
//
//   psus   [{ uid, label, model, rail, nodes: [ip…], mixedModel }] — un GROUPE
//          d'alimentation : les nodes branchés sur une même alimentation
//          physique, et le modèle du catalogue qu'elle suit. Un node seul forme
//          un groupe d'un seul ; `uid` est l'identifiant du groupe.
//   nodes  [{ ip, name, budget }] où budget est le retour de nodeBudget()
//
// Il n'y a plus d'« exemplaire » : le modèle vit au catalogue, et l'appartenance
// à une même alimentation physique se lit dans `power.psuGroup` sur les nodes.
// Ce qu'un exemplaire apportait — un libellé, un emplacement — n'était rempli
// par personne ; ce qu'il apportait vraiment, savoir QUI partage QUOI, est
// désormais porté par les nodes eux-mêmes.
function audit({ psus = [], nodes = [], opts = {} } = {}) {
  const o = { ...DEF, ...opts };
  const byIp = new Map(nodes.map(n => [n.ip, n]));
  const rattaches = new Set();
  const out = [];

  for (const psu of psus) {
    const checks = [];
    const model = psu.model || null;
    const rail = model && psu.rail ? (model.psu.rails || []).find(r => r.id === psu.rail) : null;
    const volt = rail ? rail.volt : (model ? model.psu.volt : null);
    const amps = rail ? rail.amps : (model ? model.psu.amps : null);
    const derate = model ? (model.psu.derate || o.derate) : o.derate;
    const capA = amps === null || amps === undefined ? null : r2(amps);
    const budgetA = capA === null ? null : r2(capA * derate * (1 - o.headroom));

    const mine = (psu.nodes || []).map(ip => byIp.get(ip)).filter(Boolean);
    mine.forEach(n => rattaches.add(n.ip));
    // On somme les BUDGETS, jamais les pires cas — voir l'en-tête du module.
    const usedA = r2(mine.reduce((a, n) => a + (n.budget.maxA || 0), 0));

    // Des nodes liés qui ne désignent pas le même modèle : ils sont pourtant
    // sur la même alimentation physique. L'un des deux se trompe, et tant qu'on
    // ne sait pas lequel, la capacité retenue est une supposition.
    if (psu.mixedModel) {
      checks.push(chk('warn', 'psu-incoherent',
        'les nodes liés ne désignent pas le même modèle d\'alimentation : ils sont pourtant censés partager la même',
        { num: { nodes: (psu.nodes || []).length } }));
    }
    if (!model) checks.push(chk('info', 'psu-unknown', 'modèle d\'alimentation non renseigné : rien à vérifier'));
    else if (capA === null) checks.push(chk('info', 'psu-unknown', 'ampérage de l\'alimentation non renseigné'));
    else if (!mine.length) checks.push(chk('info', 'psu-unused', 'aucun node rattaché'));
    else if (usedA > capA) {
      checks.push(chk('bad', 'psu-over',
        `${usedA} A budgétés pour une alimentation de ${capA} A : les nodes ont le droit de tirer plus qu'elle ne fournit`,
        { num: { usedA, capA } }));
    } else if (usedA > budgetA) {
      checks.push(chk('warn', 'psu-tight',
        `${usedA} A budgétés sur ${budgetA} A utilisables (${capA} A × ${Math.round(derate * 100)} % moins ${Math.round(o.headroom * 100)} % de marge)`,
        { num: { usedA, budgetA, capA } }));
    }

    // ── La tension, l'erreur qui coûte le ruban ────────────────────────────
    // Ce qui MANQUE est regroupé en une ligne par alimentation. Le dire node
    // par node donnerait seize lignes sur une flotte que personne n'a encore
    // renseignée — et un rapport de seize lignes dès la première ouverture ne
    // se lit pas. Ce qui est FAUX, en revanche, se dit node par node : il faut
    // savoir lequel débrancher.
    const sansTension = mine.filter(n => !n.budget.volts.length);
    if (volt !== null && sansTension.length) {
      checks.push(chk('info', 'volt-unknown',
        `${sansTension.length} node(s) sans tension renseignée : impossible de vérifier qu'ils vont sur du ${volt} V`,
        { nodes: sansTension.map(n => n.ip) }));
    }
    for (const n of mine) {
      if (volt === null) continue;
      if (n.budget.volts.length && !n.budget.volts.some(v => Math.abs(v - volt) / volt <= o.voltTol)) {
        checks.push(chk('bad', 'volt-mismatch',
          `${n.name} : produits en ${n.budget.volts.join(' ou ')} V sur une alimentation de ${volt} V`,
          { ip: n.ip, num: { produit: n.budget.volts, alim: volt } }));
      }
      // Indépendant de la tension des rubans : une carte grille pour son propre
      // compte. La vérification ne doit donc pas être conditionnée à des
      // produits renseignés.
      const b = n.driver && n.driver.board;
      if (b && b.inputVolts.length && !b.inputVolts.includes(volt)) {
        checks.push(chk('bad', 'volt-board',
          `${n.name} : carte alimentée en ${volt} V alors qu'elle accepte ${b.inputVolts.join(' ou ')} V`, { ip: n.ip }));
      }
    }

    out.push({ ...psu, volt, capA, budgetA, usedA, derate,
      chargePct: capA ? Math.round((usedA / capA) * 100) : null,
      nodes: mine.map(n => ({ ip: n.ip, name: n.name, maxA: n.budget.maxA, worstA: n.budget.worstA, ratio: n.budget.ratio })),
      checks });
  }

  // Ce qui n'est rattaché à rien : la seule liste que personne ne peut produire
  // aujourd'hui, et la première chose à regarder sur un plateau qu'on découvre.
  const orphelins = nodes.filter(n => !rattaches.has(n.ip)).map(n => ({ ip: n.ip, name: n.name, maxA: n.budget.maxA }));

  // Une fiche fausse produit un constat par sortie qui l'utilise — dix-sept sur
  // la flotte réelle, pour UNE seule chose à corriger. On les rassemble : le
  // rapport doit compter les causes, pas les symptômes, sinon il donne
  // l'impression d'un chantier là où il y a un champ à changer.
  const perNode = nodes.flatMap(n => n.budget.checks.map(c => ({ ...c, ip: n.ip, node: n.name })));
  const GROUPABLES = ['fiche-sous-declaree', 'abl-sous-declaree'];
  const groupes = new Map();
  const restants = [];
  for (const c of perNode) {
    if (!GROUPABLES.includes(c.code) || !c.uid) { restants.push(c); continue; }
    const cle = `${c.code}|${c.uid}`;
    const g = groupes.get(cle);
    if (g) { g.sorties++; if (!g.nodes.includes(c.node)) g.nodes.push(c.node); }
    else groupes.set(cle, { ...c, sorties: 1, nodes: [c.node], ip: undefined, node: undefined, i: undefined });
  }
  for (const g of groupes.values()) {
    if (g.sorties > 1) {
      g.msg = g.msg.replace(/^sortie \d+ : /, '')
        + ` — ${g.sorties} sorties sur ${g.nodes.length} node(s) : ${g.nodes.slice(0, 4).join(', ')}${g.nodes.length > 4 ? '…' : ''}`;
    }
  }
  const checks = [
    ...out.flatMap(p => p.checks.map(c => ({ ...c, psu: p.uid || p.label }))),
    ...groupes.values(),
    ...restants,
  ];

  return {
    psus: out, orphelins, checks,
    // Les nodes AU COMPLET, budgets, sorties et produits compris. Ils étaient
    // jetés ici alors que le schéma et l'onglet les lisaient (`data.nodes`) :
    // résultat, le schéma ne dessinait que des boîtes nues et ne montrait
    // aucune sortie tant qu'un node n'était pas rattaché à une alimentation.
    // C'est la donnée qui manquait, pas le dessin.
    nodes,
    totals: {
      capaciteA: r2(out.reduce((a, p) => a + (p.capA || 0), 0)),
      budgetA: r2(nodes.reduce((a, n) => a + (n.budget.maxA || 0), 0)),
      pireCasA: r2(nodes.reduce((a, n) => a + (n.budget.worstA || 0), 0)),
      usageA: r2(nodes.reduce((a, n) => a + (n.budget.usageA || 0), 0)),
      nodes: nodes.length, rattaches: rattaches.size,
    },
  };
}

// ── Les deux générations de firmware ───────────────────────────────────────
// Relevé sur la vraie flotte, et vérifié en direct sur les nodes :
//
//   0.14.4 (vid 2405180)   hw.led.ledma = 55        <- GLOBAL, un seul chiffre
//                          hw.led.ins[i]            <- ni ledma, ni maxpwr
//   16.x   (vid 2605030+)  hw.led                   <- plus de ledma du tout
//                          hw.led.ins[i].ledma      <- un par sortie
//                          hw.led.ins[i].maxpwr     <- un par sortie
//
// Fleet lisait ins[i].ledma sans se poser la question. Sur un node 0.14 il ne
// trouve rien et retombe sur 55 — ce qui est juste par hasard tant que le node
// déclare 55, et faux dès qu'il déclare autre chose.
//
// Le vrai danger est à l'ÉCRITURE : WLED 0.14 ignore les clés qu'il ne connaît
// pas. Écrire ins[i].ledma sur un de ces nodes ne lève aucune erreur, ne change
// rien, et Fleet affiche ensuite la valeur demandée comme si elle était
// appliquée. Un réglage de courant qui n'existe que dans l'interface est
// exactement le genre de mensonge qu'on ne découvre qu'en voyant les LED
// déconner sur le plateau.
const SCHEME_GLOBAL = 'ledma-global';   // 0.14 et avant
const SCHEME_PER_OUT = 'ledma-par-sortie'; // 16.x et après

// On tranche sur ce que le node porte, jamais sur son numéro de version : un
// build maison peut être numéroté n'importe comment, la forme de sa config ne
// ment pas.
function ablScheme(led) {
  const L = led || {};
  const ins = Array.isArray(L.ins) ? L.ins.filter(Boolean) : [];
  if (ins.some(b => b.ledma !== undefined)) return SCHEME_PER_OUT;
  if (L.ledma !== undefined) return SCHEME_GLOBAL;
  return SCHEME_PER_OUT;   // rien pour trancher : on suppose le firmware courant
}

// Le mA/pixel réellement en vigueur sur une sortie, quelle que soit la
// génération. C'est ce chiffre-là qu'il faut afficher et calculer.
function ledmaOf(led, i) {
  const L = led || {};
  const b = (Array.isArray(L.ins) ? L.ins : [])[i] || {};
  const v = b.ledma !== undefined ? Number(b.ledma)
    : (L.ledma !== undefined ? Number(L.ledma) : NaN);
  return Number.isFinite(v) ? v : ABL_DEFAULT_LEDMA;
}

// Traduire une config 0.14 vers la forme 16.x : le ledma global descend dans
// CHAQUE sortie, et disparaît du niveau node.
//
// Sans cette traduction, réinjecter la sauvegarde d'un node après sa mise à
// jour lui rendrait une config dont le firmware neuf ne lit plus le ledma : il
// repartirait sur son défaut (55), et un ruban déclaré à 120 se remettrait
// silencieusement à tirer plus du double de ce qui est prévu.
//
// Le maxpwr GLOBAL, lui, ne bouge pas : il existe dans les deux générations et
// garde le même sens.
function migrateLed(led) {
  const L = led && typeof led === 'object' ? led : {};
  if (ablScheme(L) === SCHEME_PER_OUT) return { ...L };
  const ma = Number(L.ledma);
  const out = { ...L };
  delete out.ledma;
  out.ins = (Array.isArray(L.ins) ? L.ins : []).map(b => (b && typeof b === 'object'
    ? { ...b, ledma: Number.isFinite(ma) ? ma : ABL_DEFAULT_LEDMA }
    : b));
  return out;
}

// Réinjecter une sauvegarde sur un node qui a changé de génération.
//
// Le cas : on sauvegarde un node en 0.14, on le met à jour en 16.x, puis on lui
// rend sa configuration. Rendue telle quelle, elle porte un ledma GLOBAL que le
// firmware neuf ne lit plus — il repart alors sur son défaut de 55 mA/pixel. Un
// ruban déclaré à 120 se remettrait donc à tirer plus du double du prévu, sans
// qu'aucune erreur ne le dise : la restauration aurait "réussi".
//
// On ne traduit QUE dans ce sens. Rendre une config 16.x à un node resté en
// 0.14 ne se répare pas ici : le firmware n'a tout simplement pas de champ par
// sortie, et c'est à l'appelant de ne pas descendre une version en douce.
function restoreLed(savedLed, liveLed) {
  const avant = ablScheme(savedLed);
  const apres = ablScheme(liveLed);
  if (avant === SCHEME_GLOBAL && apres === SCHEME_PER_OUT) {
    const ma = Number((savedLed || {}).ledma);
    return {
      led: migrateLed(savedLed),
      traduit: true,
      note: `mA/pixel repris du réglage global (${Number.isFinite(ma) ? ma : ABL_DEFAULT_LEDMA}) et posé sur chaque sortie`,
    };
  }
  return { led: savedLed, traduit: false, note: '' };
}

module.exports = { nodeBudget, audit, DEF, ABL_DEFAULT, MA_FOR_ESP, ablScheme, ledmaOf, migrateLed, SCHEME_GLOBAL, SCHEME_PER_OUT, restoreLed };
