#!/usr/bin/env node
// Mirrors this folder (wled-fleet/) onto the public distribution repo
// (Tensegrity-Lighting-Service/WLED-Fleet), squashed — no fine-grained history
// kept on the public side, by design (simpler than git subtree, see README).
//
// Never publishes settings.json / known-nodes.json / snapshots/ / firmware/
// downloads / logs / etc.: the fileset is exactly `git ls-files --cached
// --others --exclude-standard` run inside wled-fleet/, i.e. whatever this
// repo's own .gitignore already keeps local. settings.json and
// led-profiles.json get an extra explicit exclude below as a safety net,
// since settings.json was tracked before it was added to .gitignore.
//
//   node tools/publish-to-github.js               # publish to the default sibling checkout
//   node tools/publish-to-github.js --dir <path>   # use a specific checkout location
//   node tools/publish-to-github.js --dry-run      # show what would be copied, don't push
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..'); // wled-fleet/
const REPO_URL = 'https://github.com/Tensegrity-Lighting-Service/WLED-Fleet.git';
const EXTRA_EXCLUDE = new Set(['settings.json', 'led-profiles.json']);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dirFlag = args.indexOf('--dir');
const dest = dirFlag !== -1 && args[dirFlag + 1]
  ? path.resolve(args[dirFlag + 1])
  : path.join(ROOT, '..', '..', 'WLED-Fleet-public');

if (args.includes('--print-dir')) { process.stdout.write(dest + '\n'); process.exit(0); }

const git = (cwd, gitArgs) => execFileSync('git', gitArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
const gitLive = (cwd, gitArgs) => execFileSync('git', gitArgs, { cwd, stdio: 'inherit' });

function fileList() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))]
    .filter(f => !EXTRA_EXCLUDE.has(f))
    .sort();
}

function clearDestExceptGit(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function copyFile(rel) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) return false; // deleted-on-disk but still in a prior commit: skip
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function main() {
  const files = fileList();
  console.log(`${files.length} fichier(s) suivis depuis ${ROOT}`);
  if (dryRun) {
    files.forEach(f => console.log(fs.existsSync(path.join(ROOT, f)) ? '  ' + f : `  ${f}  (absent sur disque, ignoré — suppr. pas encore commitée)`));
    console.log(`(dry-run — destination : ${dest})`);
    return;
  }

  if (!fs.existsSync(dest)) {
    console.log(`clone de ${REPO_URL} dans ${dest}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    gitLive(path.dirname(dest), ['clone', REPO_URL, dest]);
  } else {
    console.log(`checkout existant : ${dest} — mise à jour`);
    gitLive(dest, ['fetch', 'origin']);
    try { gitLive(dest, ['checkout', 'main']); } catch { /* dépôt vide : pas encore de branche */ }
    try { gitLive(dest, ['reset', '--hard', 'origin/main']); } catch { /* dépôt vide */ }
  }
  try { gitLive(dest, ['checkout', '-B', 'main']); } catch { /* déjà dessus */ }

  clearDestExceptGit(dest);
  let copied = 0;
  for (const f of files) if (copyFile(f)) copied++;
  console.log(`${copied} fichier(s) copiés vers le checkout public`);

  gitLive(dest, ['add', '-A']);
  let changed = true;
  try { git(dest, ['diff', '--cached', '--quiet']); changed = false; } catch { /* il y a des changements (exit != 0) */ }
  if (!changed) { console.log('rien à publier (déjà synchronisé)'); return; }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const msg = `Sync v${pkg.version} (${new Date().toISOString().slice(0, 10)})`;
  gitLive(dest, ['commit', '-m', msg]);
  gitLive(dest, ['push', '-u', 'origin', 'main']);
  console.log(`publié : ${msg}`);
}

main();
