// Les fichiers qui contiennent des secrets doivent être exclus de QUATRE
// endroits. En manquer un ne se voit pas : le fichier part dans le dépôt
// public, ou dans l'archive distribuée, et le secret est dehors pour de bon.
// Ce test relit les quatre listes et les compare.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Ce qui ne doit JAMAIS sortir d'ici. Ajouter une ligne à cette liste en même
// temps que le fichier, pas après.
const SECRETS = [
  ['github.json', 'jeton d\'écriture du dépôt partagé'],
  ['github-dev.json', 'idem, instance de développement'],
  ['ap.json', 'identifiants de l\'antenne'],
  ['ap-dev.json', 'idem, instance de développement'],
  ['settings.json', 'réglages du poste'],
  ['drivers.json', 'catalogue de cartes — pas un secret, mais propre au poste'],
  ['psus.json', 'catalogue d\'alimentations — idem'],
  ['power-plan.json', 'les alimentations posées sur CE plateau — il voyage par le showfile, jamais par le dépôt'],
];

test('chaque fichier sensible est exclu des quatre endroits', () => {
  const gitignore = read('.gitignore').split(/\r?\n/).map(s => s.trim());
  const publish = read('tools/publish-to-github.js');
  const buildrs = read('desktop/build.rs');
  for (const [file, quoi] of SECRETS) {
    assert.ok(gitignore.includes(file), `${file} (${quoi}) absent de .gitignore — il partirait dans le dépôt`);
    assert.ok(buildrs.includes(`"${file}"`), `${file} (${quoi}) absent de EXCLUDE_FILES dans desktop/build.rs — il serait embarqué dans l'installeur`);
    // publish-to-github.js s'appuie sur .gitignore ; la liste explicite est un
    // filet pour les fichiers qui ont été suivis avant d'y être ajoutés
    if (/^(settings|github|github-dev|led-profiles)\.json$/.test(file)) {
      assert.ok(publish.includes(`'${file}'`), `${file} (${quoi}) absent de EXTRA_EXCLUDE dans tools/publish-to-github.js`);
    }
  }
});

test('le jeton GitHub ne sort par aucune réponse de l\'API', () => {
  // githubView() est le SEUL endroit qui décrit la configuration du dépôt vers
  // l'extérieur, et il ne doit livrer que les quatre derniers caractères.
  const src = read('server.js');
  const view = /const githubView = \(\) => \(\{[\s\S]*?\n\}\);/.exec(src);
  assert.ok(view, 'githubView() introuvable — ce test doit être remis à jour avec le code');
  assert.ok(!/\btoken:\s*ghConf\.token\b/.test(view[0]), 'githubView() renvoie le jeton en clair');
  assert.match(view[0], /slice\(-4\)/, 'le jeton doit être réduit à ses derniers caractères');
});

test('le showfile ne contient jamais la configuration du dépôt', () => {
  // le showfile circule : il part par mail, il est versionné avec le spectacle.
  const src = read('server.js');
  const doc = /format: 'wledfleet-showfile',[\s\S]*?\n      \};/.exec(src);
  assert.ok(doc, 'l\'export de showfile est introuvable — ce test doit être remis à jour avec le code');
  for (const mot of ['ghConf', 'github', 'token']) {
    assert.ok(!doc[0].includes(mot), `l'export de showfile mentionne « ${mot} »`);
  }
});
