// La référence du show : ce que Fleet tient pour vrai, colonne par colonne.
//
// Ce qui a motivé le dispositif : un node qui revenait sur le réseau avec une
// autre valeur que celle connue devenait la vérité EN SILENCE. Rien ne
// distinguait « l'utilisateur a prévu ça » de « le node a changé tout seul »,
// et un bouton « mettre à jour » apparaissait sans que personne n'ait rien
// touché côté Fleet.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const showref = require('../showref');
const { REF } = require('../columns');

// un record minimal, dans la forme que la grille lit vraiment
const node = (over = {}) => ({
  meta: { ip: '192.168.88.81', group: 'Boules' },
  info: { name: 'Boule 04', mac: 'aa:bb:cc:dd:ee:ff' },
  state: { on: true, bri: 128, ps: 3 },
  cfg: { id: { name: 'Boule 04', mdns: 'boule-04' }, ap: { ssid: 'Boule 04' },
    hw: { led: { maxpwr: 850, fps: 42 } }, def: { bri: 200 }, ...over },
  derived: { staticIp: '192.168.88.81', gw: '192.168.88.1' },
});

test('l\'état courant du node n\'entre pas dans la référence — sinon chaque conduite la ferait diverger', () => {
  const ids = REF.map(c => c.id);
  assert.ok(!ids.includes('bri'), 'state.bri suivi : la grille se couvrirait d\'écarts à chaque cue');
  assert.ok(!ids.includes('on'));
  assert.ok(!ids.includes('ps'));
  assert.ok(ids.includes('defbri'), 'la luminosité PERSISTANTE, elle, doit être suivie');
  assert.ok(!REF.some(c => c.path.startsWith('meta.')), 'les colonnes Fleet-seules ne peuvent pas diverger');
  assert.ok(REF.every(c => c.write), 'une colonne non écrivable n\'a pas de référence : elle ne se décide pas depuis un pupitre');
});

test('un node fraîchement découvert n\'affiche AUCUN écart', () => {
  const rec = node(), ref = {};
  showref.seed(ref, rec);
  assert.deepStrictEqual(showref.ecarts(ref, rec), {}, 'le semis doit être silencieux, sinon la grille se couvre de marques que personne n\'a provoquées');
  assert.strictEqual(ref.maxpwr, 850);
  assert.strictEqual(ref.name, 'Boule 04');
});

test('semer ne réaligne pas : c\'est toute la différence', () => {
  const rec = node(), ref = {};
  showref.seed(ref, rec);
  rec.cfg.hw.led.maxpwr = 500;          // le node a dérivé
  assert.strictEqual(showref.seed(ref, rec), 0, 'seed a rempli un trou qui n\'existe plus');
  assert.deepStrictEqual(showref.ecarts(ref, rec), { maxpwr: 850 }, 'l\'écart doit survivre au sondage suivant');
});

test('l\'écart porte la valeur du SHOW — le client a déjà celle du node', () => {
  const rec = node(), ref = {};
  showref.seed(ref, rec);
  rec.cfg.id.name = 'Boule 4';
  assert.strictEqual(showref.ecarts(ref, rec).name, 'Boule 04');
});

test('Fleet écrit : la référence suit', () => {
  const rec = node(), ref = {};
  showref.seed(ref, rec);
  showref.set(ref, 'maxpwr', 1200);
  rec.cfg.hw.led.maxpwr = 1200;
  assert.deepStrictEqual(showref.ecarts(ref, rec), {});
});

test('« garder la valeur du node » aligne la référence sans rien envoyer', () => {
  const rec = node(), ref = {};
  showref.seed(ref, rec);
  rec.cfg.hw.led.maxpwr = 500;
  rec.cfg.hw.led.fps = 60;
  assert.strictEqual(showref.align(ref, rec, ['maxpwr']), 1, 'une seule colonne citée, une seule alignée');
  assert.deepStrictEqual(showref.ecarts(ref, rec), { tfps: 42 }, 'l\'autre écart reste, il n\'a pas été tranché');
  showref.align(ref, rec);
  assert.deepStrictEqual(showref.ecarts(ref, rec), {});
});

test('une colonne absente du firmware n\'est pas un écart', () => {
  const rec = node(), ref = {};
  showref.seed(ref, rec);
  delete rec.cfg.hw.led.maxpwr;         // firmware plus ancien, la clé n'existe pas
  assert.deepStrictEqual(showref.ecarts(ref, rec), {}, 'un node en 0.14 ne doit pas se signaler en écart sur ce qu\'il n\'a pas');
});

test('une colonne hors référence est refusée à l\'écriture', () => {
  const ref = {};
  showref.set(ref, 'bri', 255);
  showref.set(ref, 'mac', 'aa:bb');
  assert.deepStrictEqual(ref, {}, 'écrire une colonne non suivie la ferait diverger sans jamais pouvoir être tranchée');
});

test('la référence ne retient pas null — sinon un champ vidé deviendrait un écart permanent', () => {
  const ref = { maxpwr: 850 };
  showref.set(ref, 'maxpwr', null);
  assert.strictEqual('maxpwr' in ref, false);
});
