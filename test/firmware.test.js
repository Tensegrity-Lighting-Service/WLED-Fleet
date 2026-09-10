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
const fs = require('fs');
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

// ── L'envoi d'un firmware, et la réponse d'un node qui redémarre ────────────
// Un ESP32 redémarre aussitôt après avoir accusé réception : sa réponse part
// tronquée, en morceaux mal formés, ou la connexion se ferme au milieu. Rejeter
// là-dessus déclare un échec après un flash RÉUSSI — c'est arrivé sur une boule
// passée en 16.0.1 pendant que l'interface affichait « ✗ échec ».
const net = require('net');
const os = require('os');
const path = require('path');

// un faux node qui accepte tout l'envoi puis répond n'importe quoi
const nodeQuiRedemarre = (repondre) => new Promise(resolve => {
  const srv = net.createServer(sock => {
    let recu = 0, taille = null, tete = '';
    sock.on('data', c => {
      recu += c.length;
      if (taille === null) { tete += c.toString('latin1'); const m = /content-length:\s*(\d+)/i.exec(tete); if (m) taille = Number(m[1]); }
      // tout le corps est arrivé : on répond comme un ESP qui repart
      if (taille !== null && recu >= taille) { repondre(sock); }
    });
    sock.on('error', () => { /* le pair coupe : normal ici */ });
  });
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});

const fauxFirmware = () => {
  const p = path.join(os.tmpdir(), `wf-test-${Date.now()}.bin`);
  fs.writeFileSync(p, Buffer.alloc(4096, 7));
  return p;
};

test('une réponse au découpage illisible ne fait PLUS échouer un flash réussi', async () => {
  // exactement le message rencontré : « Parse Error: Invalid character in chunk size »
  const { srv, port } = await nodeQuiRedemarre(sock => {
    sock.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZZZ\r\n');
    sock.destroy();
  });
  const bin = fauxFirmware();
  try {
    const msg = await fw.flashFile(`127.0.0.1:${port}`, bin, () => {}, 8000);
    assert.match(String(msg), /illisible|version/i, 'on rend la main avec une note, pas une erreur');
  } finally { srv.close(); fs.unlinkSync(bin); }
});

test('une connexion coupée après l\'envoi complet ne fait pas échouer non plus', async () => {
  const { srv, port } = await nodeQuiRedemarre(sock => sock.destroy());
  const bin = fauxFirmware();
  try {
    const msg = await fw.flashFile(`127.0.0.1:${port}`, bin, () => {}, 8000);
    assert.ok(typeof msg === 'string');
  } finally { srv.close(); fs.unlinkSync(bin); }
});

test('un node qui REFUSE la mise à jour échoue toujours', async () => {
  // la tolérance ne doit pas avaler un vrai refus : OTA verrouillé, place
  // insuffisante, mauvaise image
  const { srv, port } = await nodeQuiRedemarre(sock => {
    const corps = '<html>Update error: Not Enough Space</html>';
    sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${corps.length}\r\n\r\n${corps}`);
  });
  const bin = fauxFirmware();
  try {
    await assert.rejects(() => fw.flashFile(`127.0.0.1:${port}`, bin, () => {}, 8000), /error|space/i);
  } finally { srv.close(); fs.unlinkSync(bin); }
});

test('un node injoignable échoue toujours — le firmware n\'est jamais parti', async () => {
  const bin = fauxFirmware();
  try {
    await assert.rejects(() => fw.flashFile('127.0.0.1:1', bin, () => {}, 3000));
  } finally { fs.unlinkSync(bin); }
});
