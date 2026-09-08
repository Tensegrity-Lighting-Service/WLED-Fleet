<!-- FICHIER GÉNÉRÉ — ne pas modifier à la main.
     Source : les lignes « // @api … » de server.js.
     Régénérer : node tools/gen-api.js   (le test le vérifie à chaque exécution) -->

# API de WLED Fleet

Référence des surfaces exposées par WLED Fleet, à l'usage des logiciels
satellites — plugin MA3, scripts, outils tiers. Générée depuis le code : elle ne
peut pas diverger de ce que le serveur fait réellement.

Version de l'application au moment de la génération : **0.11.0** · 101 points
d'entrée.

## Ce qui fait autorité, et ce qui n'en fait pas

Trois surfaces, à ne pas confondre :

1. **Le node WLED lui-même** — `/json/cfg`, `/json/info`, `/json/state`. C'est
   la vérité sur ce qui est câblé. Un satellite peut s'en contenter et ignorer
   Fleet complètement.
2. **Le fichier `/fleet.json` sur le node** — ce que Fleet pense de ce node :
   produit, révision, fixture, instance, sortie non câblée. C'est un **indice**,
   pas la vérité ; `hw.led.ins[]` fait foi. Format décrit dans
   [fixture-mapping.md](fixture-mapping.md).
3. **L'API HTTP ci-dessous** — ce que Fleet expose de son propre état, y compris
   ce qui n'existe nulle part ailleurs : le plan DMX consolidé, les conflits
   entre nodes, le catalogue de produits.

Un satellite qui veut rester autonome lit 1 et 2. Un satellite qui veut la vue
d'ensemble lit 3, et accepte alors de dépendre d'une instance de Fleet en marche.

## Conventions

- Tout est en JSON, en UTF-8. Les corps de requête sont en JSON.
- Une erreur renvoie `{ "error": "…" }` avec un code HTTP parlant :
  **400** requête invalide · **403** serveur en lecture seule · **404** inconnu ·
  **409** état incompatible (node hors ligne, lanceur absent) ·
  **502** le node ou l'antenne n'a pas répondu.
- `:ip` est l'adresse du node telle que Fleet la connaît, encodée dans l'URL.
  Elle peut porter un port (`127.0.0.1:8201`).
- Les positions de sortie sont des **index 0-based dans `hw.led.ins`**, jamais
  des numéros affichés.
- En lecture seule (`--readonly`), toute écriture répond 403 sans effet.
- `ANY` = la route ne filtre pas sur la méthode, ou traite plusieurs méthodes
  dans son corps.

### Flotte et grille

| méthode | chemin | rôle |
|---|---|---|
| `ANY` | `/api/fleet` | État complet de la flotte : un objet par node avec info, state, cfg, les colonnes dérivées et les métadonnées Fleet. C'est la lecture principale, celle que la grille rafraîchit en boucle. |
| `ANY` | `/api/columns` | Vocabulaire de l'application : définition des colonnes, groupes déclarés, et les tables WLED (types de LED, ordres des couleurs, échanges du blanc, types à canal blanc, consommations par pixel courantes, et les bornes du firmware pour les champs de courant). |
| `POST` | `/api/node/:ip/identify` | Fait clignoter le node quelques secondes pour le repérer physiquement, puis remet son état d'origine. |
| `POST` | `/api/nodes/relocate` | Change l'adresse IP de plusieurs nodes d'un coup, échanges et rotations compris : toutes les écritures d'abord, tous les redémarrages ensuite. |
| `POST` | `/api/node/:ip/relocate` | Change l'adresse IP fixe d'un node, puis le redémarre. |
| `POST` | `/api/nodes/purge` | Oublie les nodes vus pour la dernière fois il y a plus de N heures. |
| `ANY` | `/api/changes` | Journal des changements observés sur la flotte depuis un horodatage, qu'ils viennent de Fleet ou d'ailleurs. |
| `POST` | `/api/scan` | Lance un balayage du ou des sous-réseaux à la recherche de nodes. |
| `POST` | `/api/nodes` | Ajoute un node par son adresse, après avoir vérifié qu'il répond. |
| `DELETE` | `/api/nodes/:ip` | Oublie un node : Fleet cesse de l'interroger et de l'afficher. Rien n'est écrit sur le node. |
| `ANY` | `/api/node/:ip/cfg` | GET renvoie la configuration WLED brute du node ; POST y applique une modification partielle. |
| `POST` | `/api/node/:ip/cell` | Écrit une seule cellule de la grille sur le node — le chemin de la colonne et la valeur. |
| `POST` | `/api/node/:ip/reboot` | Redémarre le node. |

### Groupes

| méthode | chemin | rôle |
|---|---|---|
| `POST` | `/api/groups` | Déclare un groupe, éventuellement vide, ou en renomme un — le groupe est le topic MQTT de groupe, écrit sur chaque node concerné. |
| `DELETE` | `/api/groups/:nom` | Oublie un groupe : ses nodes redeviennent sans groupe. |
| `POST` | `/api/node/:ip/group` | Change le groupe d'un node. C'est un champ WLED natif (topic MQTT de groupe), écrit sur le node et recopié dans son enregistrement. |

### Sorties LED et DMX

| méthode | chemin | rôle |
|---|---|---|
| `POST` | `/api/node/:ip/outputs` | Écrit les sorties LED du node. Le bloc hw.led.ins est renvoyé ENTIER — WLED le reconstruit — et les champs non gérés par Fleet sont hérités par position. Accepte un tableau `meta` optionnel, écrit dans /fleet.json APRÈS les réglages. |
| `POST` | `/api/node/:ip/unify` | Aligne le nom mDNS et le SSID du point d'accès du node sur son nom (ou sur un nouveau nom). Demande un redémarrage du node. |
| `POST` | `/api/node/:ip/locate-pixel` | Repérage d'un pixel : allonge temporairement la sortie à son maximum et éclaire trois zones (avant, marqueur, après) pour compter sur le ruban. La longueur d'origine est toujours rétablie à l'arrêt. |
| `DELETE` | `/api/node/:ip/locate-pixel` | Arrête le repérage et rétablit la longueur et l'état d'origine de la sortie. |
| `POST` | `/api/node/:ip/outputs-ignore` | Déclare, par POSITION dans hw.led.ins, les sorties qui existent dans WLED mais ne sont pas câblées. Elles ne réservent aucun canal et ne peuvent donc pas créer de conflit. |
| `GET` | `/api/dmx-plan` | Plan DMX de toute la flotte : pour chaque sortie l'univers et le canal de son premier et de son dernier pixel, plus les conflits entre nodes, détectés au canal près. |

### Métadonnées des nodes (/fleet.json)

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/node/:ip/meta` | Métadonnées Fleet lues sur le node (/fleet.json), et la dernière copie non vide qu'en a gardée Fleet. |
| `POST` | `/api/node/:ip/meta` | Écrit les métadonnées Fleet du node sans toucher à sa configuration LED. Fusionne : les clés inconnues et les sorties non citées sont conservées. |
| `POST` | `/api/node/:ip/meta/restore` | Repose les métadonnées sur un node revenu nu, à partir de la copie gardée par Fleet. Ne fait rien si le node a encore les siennes. |
| `POST` | `/api/node/:ip/output-profile` | Ancien marqueur de produit par sortie, écrit dans le client id MQTT. Conservé pour les nodes anciens ; les nouveaux passent par /api/node/:ip/meta. |

### Catalogues : produits, cartes, alimentations

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/drivers` | Catalogue de cartes : pour chaque modèle, son brochage, ses tensions d'entrée et ses courants admissibles, plus la liste des nodes qui le déclarent. Sert à dire si un budget de courant est réaliste pour ce matériel — ce que le node lui-même ne sait pas. |
| `POST` | `/api/drivers/item` | Crée ou met à jour une carte. L'uid est frappé à la création et ne change jamais ; la révision monte quand le matériel change, pas quand on corrige le nom. |
| `DELETE` | `/api/drivers/item/:id` | Retire une carte. Marquée retirée — jamais effacée — dès qu'un node la déclare, pour que son marqueur garde un sens. |
| `GET` | `/api/psus` | Catalogue d'alimentations : tension, ampères et watts (liés par la tension), rails, taux d'usage conseillé, plus les nodes rattachés. Décrit un MODÈLE, jamais un exemplaire — l'exemplaire vit sur le node. |
| `POST` | `/api/psus/item` | Crée ou met à jour une alimentation. Ampères et watts sont réconciliés par la tension ; `basis` retient lequel a été saisi, pour que changer la tension sache quelle grandeur tenir constante. |
| `DELETE` | `/api/psus/item/:id` | Retire une alimentation, selon les mêmes règles que les cartes. |
| `GET` | `/api/library` | Catalogue de produits LED, avec pour chaque produit le relevé des sorties qui l'utilisent et l'état de leur révision (à jour, en retard, en avance, inconnue). |
| `POST` | `/api/library/product` | Crée ou met à jour un produit. L'uid est frappé à la création et ne change jamais ; la révision monte quand les réglages changent, pas quand le nom change. |
| `DELETE` | `/api/library/product/:uid` | Retire un produit. Il est marqué retiré — jamais effacé — dès qu'une sortie de la flotte le référence, pour que son marqueur garde un sens. |
| `GET` | `/api/library/remote` | État du dépôt partagé : quel dépôt, quelle branche, si un jeton est enregistré (ses 4 derniers caractères seulement, JAMAIS le jeton), la dernière synchronisation et le nombre de produits pas encore publiés. |
| `POST` | `/api/library/remote` | Enregistre le dépôt partagé, la branche, et la façon de s'authentifier. Un jeton saisi à la main n'est jamais renvoyé ensuite ; envoyer une chaîne vide l'efface. |
| `POST` | `/api/library/login/start` | Démarre la connexion GitHub. Renvoie un code court et l'adresse où le saisir : c'est le « device flow », qui ne demande aucun logiciel extérieur ni aucun secret embarqué. La connexion est ensuite gardée, y compris après une mise à jour de l'application. |
| `POST` | `/api/library/login/poll` | Interroge l'avancement de la connexion. Répond `pending` tant que le code n'a pas été validé sur github.com — ce n'est pas une erreur, c'est l'attente normale. |
| `POST` | `/api/library/logout` | Se déconnecte : le jeton gardé est effacé. Le dépôt et les réglages restent, seule l'identité s'en va. |
| `POST` | `/api/library/login/cli` | Se connecte par GitHub CLI, quand il est installé : Fleet lui demande son jeton au moment de s'en servir et n'en stocke aucun. Voie secondaire — la connexion normale ne dépend d'aucun logiciel extérieur. |
| `POST` | `/api/library/pull` | Tire le dépôt partagé (jamais destructif), les trois catalogues. Une fiche modifiée localement et pas encore publiée n'est PAS écrasée : elle est signalée comme divergente, à publier — c'est la publication qui saura se replacer au-dessus de la version en ligne. |
| `POST` | `/api/library/publish` | Publie vers le dépôt partagé : une fiche si `uid` est donné (dans le catalogue `kind`, produits par défaut), sinon tout ce qui a changé localement dans les trois. Rien n'est jamais écrasé — sur collision, la version en ligne devient la base et la nôtre repart au-dessus, de sorte qu'aucun numéro de révision ne désigne deux contenus. |
| `GET` | `/api/library/nodes` | Ce que les nodes portent de la bibliothèque : chaque node cite les produits de ses sorties, avec leur fiche complète et leur révision. Le rapprochement dit, produit par produit, si le node est à jour, en retard, en avance, inconnu de ce poste, ou divergent — même révision, réglages différents, deux postes hors ligne ayant fait monter le même numéro. |
| `POST` | `/api/library/adopt` | Récupère dans le catalogue local un produit porté par un node — celui d'un node revenu d'ailleurs, ou d'un poste dont la bibliothèque était en avance. Jamais automatique : recopier sans demander effacerait silencieusement la version locale. |
| `GET` | `/api/led-profiles` | Ancienne forme du catalogue, à plat. Conservée le temps qu'un showfile ancien passe ; utiliser /api/library. |

### Chaîne électrique

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/power` | Le rapport de cohérence électrique : pour chaque alimentation posée sur le plateau, sa capacité, la somme des budgets des nodes qu'elle nourrit, et les constats. Plus les nodes rattachés à rien — la seule liste que personne ne peut produire autrement. Les seuils et l'arithmétique de l'ABL sont dans power.js, vérifiés dans le firmware. |
| `POST` | `/api/power/psu` | Crée ou met à jour un EXEMPLAIRE d'alimentation : son libellé, le modèle du catalogue qu'il suit, et où il se trouve. Propre au spectacle — « Alim jardin » ne veut rien dire sur un autre poste — donc jamais publié dans le dépôt partagé, mais présent dans le showfile. |
| `DELETE` | `/api/power/psu/:id` | Retire un exemplaire d'alimentation. Les nodes qui le désignent sont renvoyés : c'est à l'utilisateur de les rattacher ailleurs, on ne les détache pas d'autorité. |
| `POST` | `/api/node/:ip/power` | Rattache un node : quelle alimentation le nourrit, sur quel rail, et quelle carte il est. Écrit dans son /fleet.json, donc le node se raconte ensuite tout seul — y compris sur un autre poste. |

### Écritures en attente

| méthode | chemin | rôle |
|---|---|---|
| `POST` | `/api/node/:ip/offline-queue/apply` | Applique à un node redevenu joignable les écritures mises en attente pendant son absence. |
| `POST` | `/api/node/:ip/offline-queue/discard` | Abandonne les écritures en attente pour ce node. |

### Sauvegardes et showfile

| méthode | chemin | rôle |
|---|---|---|
| `POST` | `/api/showfile` | Exporte un showfile : groupes, sorties non câblées, les trois bibliothèques, le plan d'alimentation, les métadonnées des nodes et les réglages retenus. Jamais de secrets. |
| `POST` | `/api/showfile/import` | Importe un showfile. Les identifiants des fiches — produits, drivers, alimentations — et leurs révisions sont conservés tels quels, sinon les marqueurs déjà posés sur les nodes désigneraient autre chose. Les catalogues et le plan d'alimentation sont FUSIONNÉS, jamais remplacés : importer le showfile d'un autre plateau n'efface rien d'ici. |
| `GET` | `/api/snapshots` | Liste des sauvegardes de flotte. |
| `POST` | `/api/snapshots` | Prend une sauvegarde de la flotte : config, presets et fichiers Fleet de chaque node joignable. |
| `POST` | `/api/snapshots/import` | Importe un fichier de sauvegarde produit ailleurs. |
| `ANY` | `/api/snapshots/:id` | GET lit une sauvegarde (`?download=1` pour la télécharger), DELETE la supprime. |
| `GET` | `/api/snapshots/:id/diff` | Compare une sauvegarde à l'état actuel de la flotte, colonne par colonne. |
| `POST` | `/api/snapshots/:id/restore` | Restaure tout ou partie d'une sauvegarde sur les nodes choisis. |

### Firmwares et mise à jour

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/firmware` | Dépôt de firmwares : catalogue GitHub mémorisé, fichiers .bin déjà téléchargés, et les plateformes réellement présentes dans la flotte. |
| `POST` | `/api/firmware/refresh` | Rafraîchit le catalogue des versions depuis GitHub. |
| `POST` | `/api/firmware/download` | Télécharge un firmware dans le dépôt local. `forFleet` prend d'un coup tous les fichiers de la version qui correspondent aux plateformes présentes. |
| `POST` | `/api/firmware/delete` | Supprime un firmware du dépôt local. |
| `POST` | `/api/firmware/upload` | Ajoute au dépôt local un firmware fourni à la main (nom du fichier dans l'en-tête X-Filename). |
| `POST` | `/api/node/:ip/update` | Met un node à jour en OTA depuis le dépôt local, en file d'attente. |

### Antenne

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/ap` | Vue de l'antenne : radios, clients associés, historique de scan, et les constats qui demandent de croiser l'antenne avec la config des nodes. |
| `POST` | `/api/ap/scan` | Lance un scan des canaux sur une radio de l'antenne. Perturbant par nature — la radio quitte son canal quelques secondes — donc jamais automatique. |
| `GET` | `/api/ap/scans` | Historique des scans de canaux. |
| `GET` | `/api/ap/preset` | Réglages recommandés pour une radio en configuration show, comparés aux valeurs actuelles. |
| `POST` | `/api/ap/preset` | Applique les réglages recommandés cochés sur la radio. |
| `POST` | `/api/ap/channel` | Écrit le plan de canaux d'une radio de l'antenne, sur confirmation explicite. |
| `GET` | `/api/ap/raw` | Lecture brute de RouterOS pour les audits. GET seulement, et limité aux arbres interface, system, ip et routing. |
| `POST` | `/api/ap/config` | Enregistre les identifiants de l'antenne saisis dans le panneau, puis interroge l'antenne aussitôt. |
| `POST` | `/api/ap/bind` | Choisit la carte réseau locale par laquelle joindre l'antenne (REST et MNDP), quand Windows en préfère une autre. |
| `POST` | `/api/ap/connect` | Bascule sur une antenne dont les identifiants sont déjà enregistrés. |
| `POST` | `/api/ap/forget` | Oublie une antenne et ses identifiants. |

### Appairage

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/pair/networks` | Réseaux WiFi vus par la carte du poste, avec l'état de l'association. Les points d'accès WLED balisent lentement : ceux déjà vus sont mémorisés pour ne pas disparaître d'un scan à l'autre. |
| `GET` | `/api/pair/suggest` | Propose un nom et une adresse pour un node repéré par le SSID de son point d'accès. |
| `GET` | `/api/pair/status` | État du travail d'appairage en cours. |
| `POST` | `/api/pair` | Appaire un node : le poste rejoint son point d'accès, écrit le réseau du show (SSID et clé venus de l'antenne), puis revient. /api/pair/test fait le même trajet sans rien écrire. |
| `POST` | `/api/pair/test` | Appaire un node : le poste rejoint son point d'accès, écrit le réseau du show (SSID et clé venus de l'antenne), puis revient. /api/pair/test fait le même trajet sans rien écrire. |

### Sonde WiFi

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/wizard` | État de la sonde WiFi Bluetooth (WiFiman) et sa dernière lecture, rapprochée du dernier scan de l'antenne. |
| `GET` | `/api/wizard/devices` | Liste les sondes Bluetooth à portée. |
| `POST` | `/api/wizard/connect` | Se connecte à une sonde WiFi Bluetooth. |
| `POST` | `/api/wizard/disconnect` | Coupe la liaison avec la sonde. |
| `POST` | `/api/wizard/toggle` | Connecte ou déconnecte la sonde — le bouton unique du panneau. |
| `POST` | `/api/wizard/install` | Installe les dépendances de la sonde (bleak, et Python si absent). |
| `GET` | `/api/wizard/deps` | État des dépendances de la sonde. `?force=1` refait la vérification. |
| `POST` | `/api/wizard/survey` | Enregistre un relevé de site à l'endroit courant, sous un libellé. |
| `DELETE` | `/api/wizard/survey` | Supprime un relevé de site, désigné par son horodatage. |
| `GET` | `/api/wizard/surveys` | Les N derniers relevés de site. |
| `GET` | `/api/wizard/live` | Historique des mesures en direct de la sonde. |
| `GET` | `/api/wizard/waterfall` | Cascade des canaux 2,4 GHz sur les N dernières lectures. |
| `POST` | `/api/wizard/near` | Déclare près de quel node se trouve la sonde, pour rapporter ses mesures à ce point. |
| `POST` | `/api/wizard/config` | Réglages de la sonde : activation, connexion automatique, chemin de Python. |

### Serveur

| méthode | chemin | rôle |
|---|---|---|
| `GET` | `/api/settings` | Réglages du serveur : le fichier settings.json, les valeurs effectives (sous-réseaux, écoute, intervalles, lecture seule) et l'état réseau du poste. |
| `POST` | `/api/settings` | Valide et écrit settings.json, puis redémarre le serveur par le lanceur pour que tout soit relu. |
| `POST` | `/api/open` | Ouvre une URL dans le navigateur du système. La fenêtre native ne sait pas ouvrir d'onglet elle-même. |
| `ANY` | `/api/about` | Version de l'application, version de Node, dossiers de code et de données, PID et temps de fonctionnement. |
| `POST` | `/api/restart` | Redémarre le serveur pour relire les fichiers source. Refusé si le serveur n'a pas été lancé par le lanceur. |

## Ce qui n'est pas promis

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
- [wizard-protocol.md](wizard-protocol.md) — le protocole de la sonde WiFi.