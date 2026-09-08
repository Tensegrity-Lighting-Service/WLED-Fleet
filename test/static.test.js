// Le JavaScript envoyé au navigateur doit au moins se PARSER.
//
// Ce test existe pour un défaut précis : une apostrophe française insérée dans
// une chaîne à guillemets simples (« plan d'alimentation ») a rendu tout
// static/app.js illisible. Le serveur sert le fichier sans le lire, les 152
// autres tests ne le chargent jamais, et l'application n'affichait plus que le
// HTML statique — barre de menus figée, aucun onglet, aucune donnée. Rien ne
// signalait quoi que ce soit : ni au démarrage, ni à la compilation, ni à la
// publication. Le défaut est parti en release.
//
// Parser n'est pas exécuter, et ce test ne prétend pas plus. Mais la classe de
// panne qu'il attrape — un fichier entier mort d'un caractère — est justement
// celle qui ne se voit nulle part ailleurs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'static');

test('chaque .js de static/ se parse', () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 2, `seulement ${files.length} fichier(s) trouvé(s) dans static/ — ce test ne vérifierait presque rien`);
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    // compileFunction parse sans exécuter : pas de document, pas de fetch, et
    // aucun effet de bord. `new vm.Script` ferait pareil, mais accepterait un
    // « return » de premier niveau qu'un navigateur refuserait.
    assert.doesNotThrow(() => vm.compileFunction(src, [], { filename: f }),
      `static/${f} ne se parse pas — le navigateur l'abandonnerait en entier`);
  }
});

test('les scripts cités par index.html existent', () => {
  // une balise <script src> qui pointe dans le vide échoue comme une erreur de
  // syntaxe : silencieusement, et l'app s'ouvre à moitié.
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length, 'aucun script référencé : ce test doit être remis à jour avec index.html');
  for (const s of srcs) {
    if (/^https?:/.test(s)) continue;                        // le projet n'en a pas, mais ne pas mentir si ça change
    assert.ok(fs.existsSync(path.join(DIR, s.replace(/^\.?\//, ''))), `index.html charge « ${s} », absent de static/`);
  }
});
