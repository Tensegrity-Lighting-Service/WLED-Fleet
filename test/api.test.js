// Le contrat d'API : ce qui empêche la documentation de mentir.
//
// Des logiciels satellites s'appuient sur docs/api.md sans pouvoir vérifier ce
// qu'il raconte. Une documentation absente se remarque ; une documentation
// fausse se propage. Ces trois tests sont donc le mécanisme, pas une formalité :
// ajouter une route sans la décrire, ou décrire sans régénérer, casse la suite.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const scan = require('../tools/api-scan');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const routes = scan.routes(source);

test('le relevé des routes trouve bien le routeur', () => {
  // garde-fou du garde-fou : si le scanner cesse de reconnaître les routes, les
  // deux tests suivants passeraient sur un ensemble vide sans rien prouver.
  assert.ok(routes.length > 50, `seulement ${routes.length} routes relevées`);
  assert.ok(routes.some(r => scan.key(r) === 'ANY /api/fleet'));
  assert.ok(routes.some(r => scan.key(r) === 'POST /api/node/:ip/outputs'));
});

test('chaque route porte une ligne « // @api »', () => {
  const nus = routes.filter(r => !r.doc).map(r => `${scan.key(r)}  (server.js:${r.line})`);
  assert.deepStrictEqual(nus, [],
    `routes sans description :\n${nus.join('\n')}\n\nAjouter « // @api … » juste au-dessus, puis : node tools/gen-api.js`);
});

test('aucune route déclarée deux fois', () => {
  const seen = new Map();
  for (const r of routes) {
    const k = scan.key(r);
    assert.ok(!seen.has(k), `${k} apparaît en server.js:${seen.get(k)} et :${r.line} — la seconde ne sera jamais atteinte`);
    seen.set(k, r.line);
  }
});

test('docs/api.md est à jour', () => {
  // --check compare le fichier au rendu courant. Régénérer coûte une seconde,
  // découvrir six mois plus tard que la doc décrit une route disparue coûte la
  // confiance d'un intégrateur.
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'gen-api.js'), '--check'], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(`${String(e.stderr || '').trim()}\n(docs/api.md doit être régénéré et commité avec le changement)`);
  }
});

// ── Le showfile ─────────────────────────────────────────────────────────────
test('le showfile emporte tout ce que ce poste sait du montage', () => {
  // Le showfile est la seule sauvegarde d'un spectacle : ce qu'il n'emporte pas
  // est perdu au remontage. Les trois catalogues en particulier n'ont pas
  // d'autre véhicule vers un poste neuf — le dépôt partagé n'est pas toujours
  // configuré, et les nodes ne portent qu'un extrait.
  //
  // `powerPlan` n'est plus de la liste : les exemplaires d'alimentation ont
  // disparu, et le rattachement qui compte voyage avec les nodes, dans leur
  // /fleet.json.
  const doc = /format: 'wledfleet-showfile',[\s\S]*?\n      \};/.exec(source);
  assert.ok(doc, 'l\'export de showfile est introuvable — ce test doit être remis à jour avec le code');
  for (const clef of ['library', 'drivers', 'psus', 'knownNodes', 'antennas', 'snapshots']) {
    assert.ok(doc[0].includes(clef), `le showfile n'emporte plus « ${clef} »`);
  }
});
