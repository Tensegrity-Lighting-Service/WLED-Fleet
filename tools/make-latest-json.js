#!/usr/bin/env node
// Builds release/latest.json for the Tauri updater (see desktop/tauri.conf.json
// plugins.updater.endpoints) from the version in desktop/tauri.conf.json and the
// .sig que `cargo tauri build` produit à côté de l'installeur NSIS quand la clé
// de signature est dans l'environnement (voir desktop/build-release.cmd).
// À publier : l'installeur, son .sig et ce fichier sur la release taguée
// v<version> — trois assets, comme avant. Depuis le 2026-09-08 l'asset est
// l'installeur `..._x64-setup.exe` et non plus un exe portable : l'app
// s'installe (par utilisateur, sans admin) et garde ses données dans
// « Documents\WLED Fleet ».
//
// `--tag <nom>` pour une beta : elle vit sur une préversion à tag FIXE (`beta`,
// voir CLAUDE.md § 6 bis) dont on remplace les fichiers à chaque build, et non
// sur un tag v<version>. Sans ce drapeau, le manifeste beta désignerait
// `releases/download/v0.11.0/…` — un tag qui n'existe pas — et l'application
// installée sur le canal beta téléchargerait un 404 en annonçant une mise à
// jour disponible. C'est le seul endroit où le nom du tag est écrit.
//
// If release/latest.json already exists for the SAME version (e.g. a
// windows-x86_64 entry written earlier, and now a darwin-* entry added from a
// Mac build), its other platform entries are kept — a later run never drops
// an earlier platform's entry for the same release.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO_URL = 'https://github.com/Tensegrity-Lighting-Service/WLED-Fleet';
const RELEASE_DIR = path.join(ROOT, 'release');

// plateforme -> nom de l'asset (tel que produit par le bundler Tauri) + clé updater
const PLATFORMS = {
  win32: { target: 'windows-x86_64', name: v => `WLED-Fleet_${v}_x64-setup.exe` },
  darwin: { target: process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64', name: v => `WLED-Fleet_${v}_macos.app.tar.gz` },
};

const plat = PLATFORMS[process.platform];
if (!plat) { console.error(`plateforme non supportée pour la release : ${process.platform}`); process.exit(1); }

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'tauri.conf.json'), 'utf8'));
const tagFlag = process.argv.indexOf('--tag');
const TAG = tagFlag !== -1 && process.argv[tagFlag + 1] ? process.argv[tagFlag + 1] : `v${version}`;
const assetName = plat.name(version);
const assetPath = path.join(RELEASE_DIR, assetName);
const sigPath = assetPath + '.sig';

if (!fs.existsSync(assetPath)) { console.error(`introuvable : ${assetPath} (lancer d'abord build-release)`); process.exit(1); }
if (!fs.existsSync(sigPath)) { console.error(`introuvable : ${sigPath} (signature manquante)`); process.exit(1); }
const signature = fs.readFileSync(sigPath, 'utf8').trim();

const latestPath = path.join(RELEASE_DIR, 'latest.json');
let manifest = { version, notes: `WLED Fleet ${version} — voir ${REPO_URL}/releases/tag/${TAG}`, pub_date: new Date().toISOString(), platforms: {} };
try {
  const prev = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  // même version ET même tag : on garde les autres plateformes déjà signées.
  // Le tag compte : un latest.json stable relu pour une beta recyclerait des
  // URL pointant sur l'autre canal.
  const sameTag = !prev.platforms || Object.values(prev.platforms).every(p => String(p.url || '').includes(`/download/${TAG}/`));
  if (prev.version === version && prev.platforms && sameTag) manifest.platforms = prev.platforms;
} catch { /* pas de latest.json précédent, ou version différente : on repart de zéro */ }

manifest.pub_date = new Date().toISOString();
manifest.platforms[plat.target] = { signature, url: `${REPO_URL}/releases/download/${TAG}/${assetName}` };

fs.mkdirSync(RELEASE_DIR, { recursive: true });
fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));
console.log(`OK : ${latestPath} (version ${version}, tag ${TAG}, plateformes : ${Object.keys(manifest.platforms).join(', ')})`);
