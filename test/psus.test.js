// psus.js : le catalogue d'alimentations.
//
// Le cœur du sujet est la conversion ampères ↔ watts. Les fiches ne s'accordent
// pas — Meanwell affiche des watts, une alim de labo des ampères — et convertir
// de tête sur la donnée qui sert justement à vérifier qu'une chaîne tient est
// le meilleur moyen d'y glisser une faute.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const psus = require('../psus');

const P = (extra = {}) => ({ ref: { brand: 'Meanwell', model: 'LRS-350' }, ...extra });

test('saisir des watts donne les ampères, et réciproquement', () => {
  const w = psus.normPsu(P({ volt: 24, watts: 350, basis: 'watts' }));
  assert.strictEqual(w.psu.amps, 14.6, '350 W sous 24 V');
  const a = psus.normPsu(P({ volt: 12, amps: 20, basis: 'amps' }));
  assert.strictEqual(a.psu.watts, 240, '20 A sous 12 V');
});

test('une seule des deux valeurs suffit : l\'autre se déduit', () => {
  assert.strictEqual(psus.normPsu(P({ volt: 5, watts: 100 })).psu.amps, 20);
  assert.strictEqual(psus.normPsu(P({ volt: 5, amps: 20 })).psu.watts, 100);
});

test('changer la tension tient constante la grandeur SAISIE', () => {
  // c'est tout l'objet de `basis` : sans lui il faudrait deviner laquelle des
  // deux valeurs l'utilisateur voulait conserver, et on se tromperait une fois
  // sur deux. Une alim réglée de 12 à 24 V garde ses ampères ; une alim choisie
  // pour sa puissance garde ses watts.
  const enAmperes = psus.normPsu(P({ volt: 24, amps: 15, basis: 'amps' }));
  assert.strictEqual(enAmperes.psu.watts, 360);
  const enWatts = psus.normPsu(P({ volt: 24, watts: 360, basis: 'watts' }));
  assert.strictEqual(enWatts.psu.amps, 15);
});

test('la tension est un choix fermé, pas un champ libre', () => {
  assert.strictEqual(psus.normPsu(P({ volt: 24 })).psu.volt, 24);
  assert.strictEqual(psus.normPsu(P({ volt: 9 })).psu.volt, 12, 'une valeur hors catalogue retombe sur 12 V');
  assert.strictEqual(psus.normPsu(P({})).psu.volt, 12);
});

test('la capacité utilisable applique le taux d\'usage, pas la valeur de plaque', () => {
  // dimensionner à 100 % d'une alimentation, c'est la faire vieillir en un show
  const p = psus.normPsu(P({ volt: 12, amps: 20 }));
  assert.strictEqual(p.psu.derate, 0.8, 'valeur du métier pour une alim à convection');
  assert.strictEqual(psus.railCapacity(p).usable, 16);
  const large = psus.normPsu(P({ volt: 12, amps: 20, derate: 0.5 }));
  assert.strictEqual(psus.railCapacity(large).usable, 10);
  assert.strictEqual(psus.railCapacity(psus.normPsu(P({ volt: 12 }))), null, 'sans ampérage, on ne conclut pas');
});

test('un rail se budgète séparément, et peut porter sa propre tension', () => {
  const p = psus.normPsu(P({ volt: 12, amps: 30, rails: [
    { id: 'A', amps: 10 }, { id: 'B', volt: 5, amps: 8 }, { id: 'A', amps: 99 } ] }));
  assert.strictEqual(p.psu.rails.length, 2, 'deux rails ne peuvent pas porter le même repère');
  assert.strictEqual(p.psu.rails[0].volt, 12, 'hérite de la tension du bloc');
  assert.strictEqual(p.psu.rails[1].volt, 5, 'sauf s\'il déclare la sienne');
  assert.strictEqual(p.psu.rails[1].watts, 40, '8 A sous 5 V');
  assert.strictEqual(psus.railCapacity(p, 'A').usable, 8);
  assert.strictEqual(psus.railCapacity(p).usable, 24, 'sans rail nommé, c\'est le bloc entier');
});

test('des rails qui promettent plus que le bloc sont une erreur de saisie', () => {
  const bon = psus.normPsu(P({ volt: 12, amps: 30, rails: [{ id: 'A', amps: 10 }, { id: 'B', amps: 10 }] }));
  assert.strictEqual(psus.railsOverrun(bon), null);
  const faux = psus.normPsu(P({ volt: 12, amps: 20, rails: [{ id: 'A', amps: 15 }, { id: 'B', amps: 15 }] }));
  assert.deepStrictEqual(psus.railsOverrun(faux), { sum: 30, amps: 20 });
});

test('le catalogue ne contient que des MODÈLES, jamais un exemplaire', () => {
  // « Alim jardin » ne veut rien dire sur un autre poste : le rattachement vit
  // sur le node, pas ici. Aucun champ ne doit inviter à le saisir.
  const p = psus.normPsu(P({ volt: 12, amps: 20, node: '192.168.1.10', emplacement: 'jardin' }));
  assert.strictEqual(p.psu.node, undefined);
  assert.strictEqual(p.psu.emplacement, undefined);
});

test('la révision suit les caractéristiques, pas le nom', () => {
  let { store, product } = psus.upsert({ psus: [] }, P({ volt: 12, amps: 20 }));
  assert.strictEqual(product.rev, 1);
  ({ store, product } = psus.upsert(store, { ...P({ volt: 12, amps: 20 }), ref: { brand: 'Meanwell', model: 'LRS-350', note: 'du camion' }, uid: product.uid }));
  assert.strictEqual(product.rev, 1, 'une note ne change rien à ce que l\'alim délivre');
  ({ product } = psus.upsert(store, { ...P({ volt: 24, amps: 20 }), uid: product.uid }));
  assert.strictEqual(product.rev, 2, 'changer la tension, si');
});

test('une fiche illisible ne fait pas tomber le catalogue', () => {
  assert.deepStrictEqual(psus.normStore({ psus: [{ ref: {} }, P({ volt: 12, amps: 5 })] }).psus.length, 1);
  assert.deepStrictEqual(psus.normStore(null).psus, []);
});

test('normaliser deux fois ne perd rien — l\'aller-retour du magasin', () => {
  // normPsu range sous `psu` mais lit à plat : sans accepter les deux formes,
  // relire un enregistrement stocké remettait tout aux valeurs par défaut. Et
  // normaliser est ce qu'on fait à CHAQUE lecture, upsert et import.
  const une = psus.normPsu(P({ volt: 24, watts: 350, basis: 'watts', derate: 0.7, rails: [{ id: 'A', amps: 7 }] }));
  const deux = psus.normPsu(une);
  assert.deepStrictEqual(deux.psu, une.psu);
  const trois = psus.normStore({ psus: [une] }).psus[0];
  assert.deepStrictEqual(trois.psu, une.psu, 'passer par le magasin ne doit rien changer non plus');
});
