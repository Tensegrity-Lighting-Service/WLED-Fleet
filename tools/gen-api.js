// Fabrique docs/api.md à partir du code lui-même.
//
//   node tools/gen-api.js          écrit le fichier
//   node tools/gen-api.js --check  se tait s'il est à jour, sort en 1 sinon
//
// Le test appelle la seconde forme : la documentation ne peut donc pas prendre
// du retard sur le code sans faire échouer la suite.
'use strict';
const fs = require('fs');
const path = require('path');
const scan = require('./api-scan');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'api.md');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Regroupement des routes par domaine. L'ordre est celui du fichier ; ce qui
// n'entre dans aucune section atterrit dans « Divers », visible, plutôt que
// d'être silencieusement omis.
const SECTIONS = [
  ['Flotte et grille', ['/api/fleet', '/api/columns', '/api/changes', '/api/scan', '/api/nodes', '/api/node/:ip/cfg', '/api/node/:ip/cell', '/api/node/:ip/reboot', '/api/node/:ip/identify', '/api/node/:ip/relocate', '/api/nodes/relocate', '/api/nodes/purge']],
  ['Groupes', ['/api/groups', '/api/node/:ip/group']],
  ['Sorties LED et DMX', ['/api/node/:ip/outputs', '/api/node/:ip/outputs-ignore', '/api/node/:ip/locate-pixel', '/api/node/:ip/unify', '/api/dmx-plan']],
  ['Métadonnées des nodes (/fleet.json)', ['/api/node/:ip/meta', '/api/node/:ip/output-profile']],
  ['Catalogues : produits, cartes, alimentations', ['/api/library', '/api/led-profiles', '/api/drivers', '/api/psus']],
  ['Chaîne électrique', ['/api/power', '/api/node/:ip/power']],
  ['Écritures en attente', ['/api/node/:ip/offline-queue']],
  ['Sauvegardes et showfile', ['/api/snapshots', '/api/showfile']],
  ['Firmwares et mise à jour', ['/api/firmware', '/api/node/:ip/update']],
  ['Antenne', ['/api/ap']],
  ['Appairage', ['/api/pair']],
  ['Sonde WiFi', ['/api/wizard']],
  ['Serveur', ['/api/settings', '/api/about', '/api/restart', '/api/open']],
];

const table = rs => ['| méthode | chemin | rôle |', '|---|---|---|',
  ...rs.map(r => `| \`${r.method}\` | \`${r.path}\` | ${r.doc.replace(/\|/g, '\\|')} |`)].join('\n');

function build() {
  const routes = scan.routes(read('server.js'));
  const used = new Set();
  const blocks = [];
  for (const [title, prefixes] of SECTIONS) {
    const rs = routes.filter(r => !used.has(r) && prefixes.some(pre => r.path === pre || r.path.startsWith(pre + '/')));
    if (!rs.length) continue;
    rs.forEach(r => used.add(r));
    blocks.push(`### ${title}\n\n${table(rs)}`);
  }
  const rest = routes.filter(r => !used.has(r));
  if (rest.length) blocks.push(`### Divers\n\n${table(rest)}`);

  const version = JSON.parse(read('package.json')).version;
  return `${HEAD.replace('{VERSION}', version).replace('{N}', routes.length)}

${blocks.join('\n\n')}

${TAIL}`;
}

const HEAD = `<!-- FICHIER GÉNÉRÉ — ne pas modifier à la main.
     Source : les lignes « // @api … » de server.js.
     Régénérer : node tools/gen-api.js   (le test le vérifie à chaque exécution) -->

# API de WLED Fleet

Référence des surfaces exposées par WLED Fleet, à l'usage des logiciels
satellites — plugin MA3, scripts, outils tiers. Générée depuis le code : elle ne
peut pas diverger de ce que le serveur fait réellement.

Version de l'application au moment de la génération : **{VERSION}** · {N} points
d'entrée.

## Ce qui fait autorité, et ce qui n'en fait pas

Trois surfaces, à ne pas confondre :

1. **Le node WLED lui-même** — \`/json/cfg\`, \`/json/info\`, \`/json/state\`. C'est
   la vérité sur ce qui est câblé. Un satellite peut s'en contenter et ignorer
   Fleet complètement.
2. **Le fichier \`/fleet.json\` sur le node** — ce que Fleet pense de ce node :
   produit, révision, fixture, instance, sortie non câblée. C'est un **indice**,
   pas la vérité ; \`hw.led.ins[]\` fait foi. Format décrit dans
   [fixture-mapping.md](fixture-mapping.md).
3. **L'API HTTP ci-dessous** — ce que Fleet expose de son propre état, y compris
   ce qui n'existe nulle part ailleurs : le plan DMX consolidé, les conflits
   entre nodes, le catalogue de produits.

Un satellite qui veut rester autonome lit 1 et 2. Un satellite qui veut la vue
d'ensemble lit 3, et accepte alors de dépendre d'une instance de Fleet en marche.

## Conventions

- Tout est en JSON, en UTF-8. Les corps de requête sont en JSON.
- Une erreur renvoie \`{ "error": "…" }\` avec un code HTTP parlant :
  **400** requête invalide · **403** serveur en lecture seule · **404** inconnu ·
  **409** état incompatible (node hors ligne, lanceur absent) ·
  **502** le node ou l'antenne n'a pas répondu.
- \`:ip\` est l'adresse du node telle que Fleet la connaît, encodée dans l'URL.
  Elle peut porter un port (\`127.0.0.1:8201\`).
- Les positions de sortie sont des **index 0-based dans \`hw.led.ins\`**, jamais
  des numéros affichés.
- En lecture seule (\`--readonly\`), toute écriture répond 403 sans effet.
- \`ANY\` = la route ne filtre pas sur la méthode, ou traite plusieurs méthodes
  dans son corps.`;

const TAIL = `## Ce qui n'est pas promis

- **Rien n'est stable tant que ce document ne le dit pas.** Les champs des
  réponses peuvent gagner des clés ; un satellite doit ignorer ce qu'il ne
  connaît pas plutôt que de refuser la réponse.
- Fleet n'est pas un service : il tourne sur le poste de l'utilisateur, souvent
  pas du tout. Un satellite doit fonctionner quand l'API est injoignable.
- L'API n'est pas authentifiée. Elle écoute par défaut sur la boucle locale ;
  l'exposer sur le réseau est un choix de l'utilisateur, pas un mode prévu.

## Voir aussi

- [fixture-mapping.md](fixture-mapping.md) — ce que Fleet écrit sur les nodes,
  l'arithmétique DMX, et la reconstitution des fixtures. C'est le document à
  lire pour interroger les nodes sans passer par Fleet.
- [wizard-protocol.md](wizard-protocol.md) — le protocole de la sonde WiFi.`;

const next = build();
if (process.argv.includes('--check')) {
  let cur = null; try { cur = fs.readFileSync(OUT, 'utf8'); } catch { /* absent */ }
  if (cur !== next) { console.error('docs/api.md est périmé — lancer : node tools/gen-api.js'); process.exit(1); }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next);
  console.log(`docs/api.md écrit (${scan.routes(read('server.js')).length} points d'entrée)`);
}

module.exports = { build, OUT };
