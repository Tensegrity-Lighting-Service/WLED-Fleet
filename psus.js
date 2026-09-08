// Catalogue d'alimentations — le « d'où vient le courant ».
//
// Ce fichier décrit un MODÈLE : « Meanwell LRS-350-24 », pas l'exemplaire n° 3
// du camion. C'est la même distinction que pour les produits LED (library.js) :
// le catalogue dit ce qu'on achète, l'installation dit où c'est branché. Un
// « Alim jardin » ne voudrait rien dire sur un autre poste, et n'a donc rien à
// faire dans un dépôt partagé.
//
// ── Ampères ou watts, au choix ─────────────────────────────────────────────
// Les fiches ne s'accordent pas : Meanwell affiche des watts, une alimentation
// de laboratoire des ampères, et les revendeurs mélangent les deux. Obliger à
// convertir de tête, c'est inviter la faute de frappe sur la donnée qui sert
// justement à vérifier qu'une chaîne tient.
//
// Les deux champs sont donc saisissables et liés par la tension. `basis` retient
// lequel a été saisi : c'est lui qui fait foi, l'autre en est déduit. Changer la
// tension d'une alimentation ajustable recalcule alors la bonne grandeur —
// à ampérage constant si on a saisi des ampères, à puissance constante sinon.
// Sans `basis`, il faudrait deviner, et on se tromperait une fois sur deux.
'use strict';

const { makeCatalog, num } = require('./catalog');
const { VOLTAGES } = require('./columns');

const FORMAT = 'wled-fleet-psus';
const FORMAT_VERSION = 1;
const NODE_FORMAT = 'wled-fleet-node-library';   // même fichier embarqué que les produits

const r1 = v => Math.round(v * 10) / 10;
const numOrNull = (v, min, max) => (v === null || v === undefined || v === '' ? null
  : (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v) * 10) / 10)) : null));

// Ampères et watts, réconciliés par la tension.
function normPower(x, volt) {
  const basis = x.basis === 'watts' ? 'watts' : 'amps';
  let amps = numOrNull(x.amps, 0, 2000);
  let watts = numOrNull(x.watts, 0, 100000);
  if (basis === 'watts' && watts !== null) amps = volt ? r1(watts / volt) : null;
  else if (basis === 'amps' && amps !== null) watts = volt ? r1(amps * volt) : null;
  // une seule des deux valeurs saisie : on déduit l'autre plutôt que d'exiger
  // deux fois la même information
  else if (amps === null && watts !== null && volt) amps = r1(watts / volt);
  else if (watts === null && amps !== null && volt) watts = r1(amps * volt);
  return { amps, watts, basis };
}

// Les rails d'une alimentation multi-sorties. Chacun peut porter sa propre
// tension (les alims de labo) ou hériter de celle du bloc.
function normRails(list, volt) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const id = String((r && r.id) || '').trim().slice(0, 8) || String.fromCharCode(65 + out.length);
    if (out.some(x => x.id === id)) continue;              // deux rails ne peuvent pas porter le même repère
    const rv = VOLTAGES.includes(Number(r && r.volt)) ? Number(r.volt) : volt;
    const { amps, watts } = normPower(r || {}, rv);
    out.push({ id, volt: rv, amps, watts, label: String((r && r.label) || '').trim().slice(0, 40) });
  }
  return out;
}

function normPsu(input) {
  // On accepte les deux formes : à plat quand ça vient du formulaire, imbriqué
  // sous `psu` quand ça vient du magasin. Sans ça, re-normaliser un
  // enregistrement déjà stocké perdrait tout — et normaliser est justement ce
  // qu'on fait à chaque lecture, à chaque upsert et à chaque import.
  const x = (input && input.psu) || input || {};
  // une alimentation délivre UNE tension : un sélecteur, pas des cases. C'est la
  // différence avec un produit LED, qui existe souvent en plusieurs tensions.
  const volt = VOLTAGES.includes(Number(x.volt)) ? Number(x.volt) : 12;
  const { amps, watts, basis } = normPower(x, volt);
  return {
    psu: {
      volt, amps, watts, basis,
      rails: normRails(x.rails, volt),
      // Taux d'usage conseillé par le fabricant. 80 % est la valeur du métier
      // pour une alimentation à convection : au-delà elle chauffe, vieillit vite
      // et sa tension s'affaisse — ce qui, sur du LED adressable, se traduit par
      // des données corrompues bien avant une coupure franche.
      derate: (() => { const d = Number(x.derate); return Number.isFinite(d) && d > 0 && d <= 1 ? Math.round(d * 100) / 100 : 0.8; })(),
      // beaucoup d'alimentations ont un potentiomètre : remonter une 5 V à 5,2 V
      // compense la chute de câble, et change ce qu'on peut en attendre
      adjustable: !!x.adjustable,
      note: String(x.note || '').trim().slice(0, 120),
    },
  };
}

const substance = p => JSON.stringify(p.psu);

const cat = makeCatalog({
  kind: 'psu',
  collection: 'psus',
  format: FORMAT,
  formatVersion: FORMAT_VERSION,
  nodeFormat: NODE_FORMAT,
  fallbackSlug: 'alimentation',
  norm: normPsu,
  substance,
});

// Ce qu'un rail délivre réellement, une fois le taux d'usage appliqué. C'est ce
// chiffre-là qu'on compare aux budgets des nodes, pas la valeur de la plaque :
// dimensionner à 100 % d'une alimentation, c'est la faire vieillir en un show.
function railCapacity(psu, railId) {
  if (!psu) return null;
  const p = psu.psu || psu;
  const rail = railId ? (p.rails || []).find(r => r.id === railId) : null;
  const volt = rail ? rail.volt : p.volt;
  const amps = rail ? rail.amps : p.amps;
  if (amps === null || amps === undefined) return null;
  return { volt, amps, usable: r1(amps * (p.derate || 0.8)) };
}

// Somme des rails contre ce que le bloc annonce : une alimentation dont les
// rails promettent plus que le bloc est une erreur de saisie, pas une bonne
// nouvelle.
function railsOverrun(psu) {
  const p = (psu && (psu.psu || psu)) || {};
  if (!p.rails || !p.rails.length || p.amps === null) return null;
  const sum = r1(p.rails.reduce((a, r) => a + (r.amps || 0), 0));
  return sum > p.amps ? { sum, amps: p.amps } : null;
}

module.exports = {
  FORMAT, FORMAT_VERSION, NODE_FORMAT,
  normPsu: cat.normOne, normStore: cat.normStore, upsert: cat.upsert, retire: cat.retire,
  resolve: cat.resolve, find: cat.resolve, revState: cat.revState,
  nodeSlice: cat.nodeSlice, parseNodeSlice: cat.parseNodeSlice, compareNodeSlice: cat.compareNodeSlice,
  label: cat.label, substance, normPower, railCapacity, railsOverrun, catalog: cat,
};
