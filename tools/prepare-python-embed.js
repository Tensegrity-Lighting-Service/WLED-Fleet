#!/usr/bin/env node
// One-time (or occasional) prep: downloads the official python.org "embeddable"
// Windows runtime and installs `bleak` into it, so the WiFiman Wizard bridge
// (tools/wizard/wizard_bridge.py) never needs a system Python at all — no more
// hunting python/py/python3 on PATH (and no more Windows Store popups when
// those resolve to an App Execution Alias stub instead of a real install).
//
// Output: tools/python-embed/ (gitignored — ~30 MB, rebuilt from scratch each
// run, not meant to be committed). desktop/build.rs picks it up from there and
// bakes it into the exe like server.js. Re-run this after bumping the Python
// or bleak version; not run automatically by `cargo build` (needs network +
// a working system Python to drive pip, neither of which a plain build should
// require).
//
//   node tools/prepare-python-embed.js
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const PY_VERSION = '3.14.7';
const URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'python-embed');
const TMP_ZIP = path.join(ROOT, 'tools', `python-embed-${PY_VERSION}.zip`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { download(res.headers.location, dest).then(resolve, reject); return; }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    });
    req.on('error', reject);
  });
}

// a real Python install to drive pip — never `python`/`python3` directly (an
// unset system could resolve those to the Windows Store's alias stub); `py -3`
// is the official launcher and, failing that, PY_FOR_PIP lets a known-good
// interpreter be pointed at explicitly (env var, for machines where even `py`
// is aliased weirdly, as seen once in dev: prefer a `where`-resolved real path)
function findSystemPython() {
  if (process.env.PY_FOR_PIP) return process.env.PY_FOR_PIP;
  const tryOne = cmd => { try { return execFileSync('where', [cmd], { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).find(p => p && !/\\WindowsApps\\/i.test(p)); } catch { return null; } };
  return tryOne('py') || tryOne('python') || tryOne('python3');
}

async function main() {
  const py = findSystemPython();
  if (!py) { console.error('Python introuvable (hors alias Windows Store) pour piloter pip — installer Python 3 depuis python.org, ou définir PY_FOR_PIP=<chemin exact>.'); process.exit(1); }
  console.log(`pip piloté par : ${py}`);

  console.log(`téléchargement : ${URL}`);
  fs.rmSync(TMP_ZIP, { force: true });
  await download(URL, TMP_ZIP);
  console.log(`OK (${(fs.statSync(TMP_ZIP).size / 1048576).toFixed(1)} Mo)`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  console.log('extraction…');
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${TMP_ZIP}' -DestinationPath '${OUT}' -Force`]);
  fs.rmSync(TMP_ZIP, { force: true });

  // the embeddable package ships with `import site` commented out in its
  // ._pth file — site-packages (where bleak lands below) would silently never
  // be importable without this
  const pth = fs.readdirSync(OUT).find(f => f.endsWith('._pth'));
  if (!pth) throw new Error('fichier ._pth introuvable dans le paquet embeddable — format inattendu');
  const pthPath = path.join(OUT, pth);
  let pthContent = fs.readFileSync(pthPath, 'utf8');
  if (!/^import site$/m.test(pthContent)) {
    pthContent = /^#\s*import site\s*$/m.test(pthContent) ? pthContent.replace(/^#\s*import site\s*$/m, 'import site') : pthContent.trimEnd() + '\nimport site\n';
    fs.writeFileSync(pthPath, pthContent);
  }
  console.log(`site-packages activé (${pth})`);

  console.log('installation de bleak…');
  const target = path.join(OUT, 'Lib', 'site-packages');
  fs.mkdirSync(target, { recursive: true });
  execFileSync(py, ['-m', 'pip', 'install', '--target', target, '--upgrade', 'bleak'], { stdio: 'inherit' });

  const check = execFileSync(path.join(OUT, 'python.exe'), ['-c', 'import bleak, importlib.metadata as m; print(m.version("bleak"))'], { encoding: 'utf8' }).trim();
  console.log(`OK : python-embed prêt (bleak ${check}) → ${OUT}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
