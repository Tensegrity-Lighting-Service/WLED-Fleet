#!/usr/bin/env node
// Builds release/latest.json for the Tauri updater (see desktop/tauri.conf.json
// plugins.updater.endpoints) from the version in desktop/tauri.conf.json and the
// .sig produced alongside the release zip by `cargo tauri signer sign` (see
// desktop/build-release.cmd). To publish: attach the zip, its .sig, and this
// file to the GitHub release tagged v<version> (three assets, every time).
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

// platform key -> [zip filename template, updater target key]
const PLATFORMS = {
  win32: { target: 'windows-x86_64', suffix: 'windows' },
  darwin: { target: process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64', suffix: 'macos' },
};

const plat = PLATFORMS[process.platform];
if (!plat) { console.error(`plateforme non supportée pour la release : ${process.platform}`); process.exit(1); }

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'tauri.conf.json'), 'utf8'));
const zipName = `WLED-Fleet_${version}_${plat.suffix}.zip`;
const zipPath = path.join(RELEASE_DIR, zipName);
const sigPath = zipPath + '.sig';

if (!fs.existsSync(zipPath)) { console.error(`introuvable : ${zipPath} (lancer d'abord build-release)`); process.exit(1); }
if (!fs.existsSync(sigPath)) { console.error(`introuvable : ${sigPath} (signature manquante)`); process.exit(1); }
const signature = fs.readFileSync(sigPath, 'utf8').trim();

const latestPath = path.join(RELEASE_DIR, 'latest.json');
let manifest = { version, notes: `WLED Fleet ${version} — voir ${REPO_URL}/releases/tag/v${version}`, pub_date: new Date().toISOString(), platforms: {} };
try {
  const prev = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  if (prev.version === version && prev.platforms) manifest.platforms = prev.platforms; // même release : on garde les autres plateformes déjà signées
} catch { /* pas de latest.json précédent, ou version différente : on repart de zéro */ }

manifest.pub_date = new Date().toISOString();
manifest.platforms[plat.target] = { signature, url: `${REPO_URL}/releases/download/v${version}/${zipName}` };

fs.mkdirSync(RELEASE_DIR, { recursive: true });
fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));
console.log(`OK : ${latestPath} (version ${version}, plateformes : ${Object.keys(manifest.platforms).join(', ')})`);
