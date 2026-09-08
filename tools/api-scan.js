// Relève les points d'entrée HTTP de Fleet directement DANS server.js.
//
// Pourquoi lire le code plutôt que tenir une liste à côté : une liste séparée
// se désynchronise le jour où quelqu'un ajoute une route sans y penser, et une
// documentation fausse est pire qu'une documentation absente — les satellites
// (plugin MA3, scripts, autres outils) s'y fient sans pouvoir la vérifier.
//
// La règle est donc : chaque route porte une ligne « // @api … » juste
// au-dessus. Le test refuse toute route qui n'en a pas, et refuse aussi que
// docs/api.md diffère de ce que ce fichier produit. La documentation ne peut
// alors ni manquer, ni mentir.
'use strict';

// Deux formes de route cohabitent dans le routeur :
//   if (p === '/api/fleet' && req.method === 'GET')      -> chemin littéral
//   if ((m = /^\/api\/node\/([^/]+)\/cfg$/.exec(p)) …)   -> chemin paramétré
const LITERAL = /\bp === '(\/api\/[^']*)'/g;
const PATTERN = /\(m = (\/\^[^=]*?\/)\.exec\(p\)\)/;
const METHOD = /req\.method === '([A-Z]+)'/;

// /^\/api\/node\/([^/]+)\/cfg$/ -> /api/node/:ip/cfg
// Les noms de paramètres viennent de la position : le premier segment capturé
// d'une route /api/node/… est toujours l'adresse du node.
function pathOfPattern(src, params) {
  let s = src.replace(/^\//, '').replace(/\/$/, '');       // délimiteurs
  s = s.replace(/^\^/, '').replace(/\$$/, '');
  let i = 0;
  s = s.replace(/\([^)]*\)/g, () => `:${params[i++] || `p${i}`}`);
  return s.replace(/\\\//g, '/');
}
const paramsFor = path => (path.startsWith('/api/node/') ? ['ip'] : path.startsWith('/api/nodes/') ? ['ip'] : path.startsWith('/api/snapshots/') ? ['id'] : path.startsWith('/api/groups/') ? ['nom'] : path.startsWith('/api/library/product/') ? ['uid'] : ['id']);

function routes(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // exactement quatre espaces : c'est le niveau du routeur. Un `p === '…'`
    // plus profond est un aiguillage à l'intérieur d'une route, pas une route.
    if (!/^ {4}if \(/.test(line)) continue;
    const paths = [...line.matchAll(LITERAL)].map(x => x[1]);   // une ligne peut couvrir deux chemins
    if (!paths.length) {
      const pat = PATTERN.exec(line);
      if (!pat || !pat[1].includes('\\/api\\/')) continue;
      // le nom des paramètres dépend du préfixe, qu'on ne connaît qu'après coup
      const rough = pathOfPattern(pat[1], []);
      paths.push(pathOfPattern(pat[1], paramsFor(rough)));
    }
    const meth = METHOD.exec(line);
    // Un @api peut tenir sur plusieurs lignes : on remonte tant que ce sont des
    // lignes de continuation « // », en s'arrêtant au premier commentaire qui
    // n'appartient pas à ce bloc.
    const doc = [];
    for (let j = i - 1; j >= 0; j--) {
      const c = /^\s*\/\/ ?(.*)$/.exec(lines[j]);
      if (!c) break;
      doc.unshift(c[1]);
      if (/^\s*\/\/ @api\b/.test(lines[j])) break;
      if (doc.length > 12) break;
    }
    const first = doc.findIndex(t => /^@api\b/.test(t));
    const text = first < 0 ? '' : [doc[first].replace(/^@api\s*/, ''), ...doc.slice(first + 1)].join(' ').replace(/\s+/g, ' ').trim();
    for (const path of paths) out.push({ method: meth ? meth[1] : 'ANY', path, line: i + 1, doc: text });
  }
  return out;
}

const key = r => `${r.method} ${r.path}`;

module.exports = { routes, key };
