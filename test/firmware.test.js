// firmware.js : reconnaître la plateforme d'un node pour savoir quel binaire
// lui envoyer.
//
// Ces cas viennent du relevé de la vraie flotte. Huit nodes y tournent une
// 0.14.4 d'Athom, et WLED n'expose `info.release` que depuis la 0.15 : la
// colonne Plateforme restait vide, aucune mise à jour n'était proposée, et le
// garde-fou du flash refusait de toute façon en comparant à un champ absent.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fw = require('../firmware');

// relevé sur 192.168.88.54 et ses sept jumelles
const BOULE_014 = { name: 'WLED boule 04', ver: '0.14.4', vid: 2405180, arch: 'ESP32-C3',
  brand: 'www.athom.tech', product: 'Athom_USB_Controller',
  getflash: 4194304, e32flashtext: 'DIO', fs: { u: 12, t: 983 } };
// et la même boule une fois passée en 16.0.0
const BOULE_16 = { name: 'WLED boule 03', ver: '16.0.0', vid: 2605030, arch: 'ESP32-C3',
  release: 'ESP32-C3', flash: 4, fs: { u: 16, t: 983 } };

test('un node qui déclare sa plateforme est cru sur parole', () => {
  const g = fw.guessEnv(BOULE_16);
  assert.strictEqual(g.env, 'ESP32-C3');
  assert.strictEqual(g.deduit, false, 'déclaré, pas déduit — la nuance doit remonter à l\'interface');
});

test('une 0.14.4 sans champ release est reconnue par son matériel', () => {
  const g = fw.guessEnv(BOULE_014);
  assert.strictEqual(g.env, 'ESP32-C3');
  assert.strictEqual(g.deduit, true);
  assert.match(g.pourquoi, /4 Mo/);
  // et c'est bien la même cible que celle de ses jumelles déjà à jour
  assert.strictEqual(g.env, fw.guessEnv(BOULE_16).env);
});

test('la déduction REFUSE de trancher quand plusieurs builds collent', () => {
  // un esp32 nu peut être ESP32, ESP32_8M, ESP32_16M ou ESP32_Ethernet, et rien
  // dans /json/info ne les départage. Envoyer une build sans Ethernet à un node
  // PoE lui ferait perdre son réseau, et il faudrait aller le rechercher.
  const g = fw.guessEnv({ arch: 'esp32', getflash: 4194304, e32flashtext: 'DIO' });
  assert.strictEqual(g.env, null);
  assert.match(g.pourquoi, /à choisir à la main/);
});

test('un S3 en 8 Mo OPI n\'est pas confondu avec le 4 Mo qspi', () => {
  assert.strictEqual(fw.guessEnv({ arch: 'ESP32-S3', getflash: 8388608, e32flashtext: 'OPI' }).env, null);
  assert.strictEqual(fw.guessEnv({ arch: 'ESP32-S3', getflash: 4194304, e32flashtext: 'QIO' }).env, 'ESP32-S3_4M_qspi');
});

test('sans information, on ne prétend rien', () => {
  for (const vide of [null, undefined, {}, { arch: '' }]) {
    assert.strictEqual(fw.guessEnv(vide).env, null, `entrée ${JSON.stringify(vide)}`);
  }
});

test('assess() cesse d\'afficher « ? » sur un node ancien', () => {
  const a = fw.assess(BOULE_014);
  assert.strictEqual(a.env, 'ESP32-C3');
  assert.strictEqual(a.envDeduit, true, 'l\'interface doit pouvoir dire que c\'est déduit');
  assert.notStrictEqual(a.status, '?');
});
