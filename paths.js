// Où vivent le code et les données (2026-09-08, passage à l'installeur).
//
// Jusqu'ici tout cohabitait à côté de server.js : le code ET l'état (flotte
// connue, réglages, sauvegardes, firmwares…). Avec une version installée, le
// dossier d'installation est géré par l'installeur — il est remplacé à chaque
// mise à jour et supprimé à la désinstallation : y garder l'état serait le
// perdre. L'état part donc dans « Documents\WLED Fleet », visible et
// sauvegardable par l'utilisateur.
//
// DATA_DIR vient de la variable d'environnement WLED_FLEET_DATA, posée par la
// coquille Tauri. Sans elle (lancement direct de `node server.js`, dev, tests),
// on retombe sur le dossier du code : le mode portable d'avant continue de
// marcher tel quel, et aucun test n'écrit ailleurs que là où il l'a toujours fait.
'use strict';
const fs = require('fs');
const path = require('path');

const CODE_DIR = __dirname;
const DATA_DIR = process.env.WLED_FLEET_DATA ? path.resolve(process.env.WLED_FLEET_DATA) : __dirname;

if (DATA_DIR !== CODE_DIR) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.log(`dossier de données inaccessible (${DATA_DIR}) : ${e.message}`); }
}

// chemin d'un fichier d'état (écrit par l'app) et d'une ressource (livrée avec le code)
const dataFile = (...p) => path.join(DATA_DIR, ...p);
const codeFile = (...p) => path.join(CODE_DIR, ...p);

module.exports = { CODE_DIR, DATA_DIR, dataFile, codeFile };
