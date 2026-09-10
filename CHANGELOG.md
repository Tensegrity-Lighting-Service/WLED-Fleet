# Journal des versions

Ce fichier dit **ce qui a changé et pourquoi**. Le détail technique est dans les
messages de commit ; ici on garde ce qu'il faut savoir avant de mettre à jour.

## Où en sont les deux canaux

| canal | version | ce qu'on y trouve |
|---|---|---|
| **stable** | **0.9.0** | la dernière version éprouvée en exploitation |
| **beta** | **0.14.0** | l'écart show / node dans la cellule, la chaîne électrique, le schéma du plateau |

Tout ce qui suit la 0.9.0 vit donc **uniquement sur le canal beta** (⚙ Réglages →
Application → Canal). Le canal stable ne peut pas l'attraper par accident :
GitHub ne résout jamais `releases/latest` vers une préversion.

---

## 0.14.0

### Savoir lequel des deux a bougé, du show ou du node

Fleet mémorisait déjà le dernier état connu de chaque node, hors ligne et au
redémarrage. Ce qui manquait n'était pas la mémoire : c'était de savoir **qui a
bougé**. Un sondage écrasait la configuration lue sans rien retenir — un node
qui revenait avec une autre valeur devenait la vérité en silence, et la seule
trace était un liseré de dix minutes dans la grille. Passé ce délai, plus rien.

Dans l'autre sens, une intention posée par l'utilisateur et pas encore partie
portait le même genre de marque. Deux situations **opposées**, impossibles à
distinguer — d'où ce bouton « mettre à jour » qui semblait apparaître par magie
sans que personne n'ait rien touché côté Fleet.

**Quand les deux ne disent pas la même chose, la cellule montre les deux** :

| | |
|---|---|
| `900 ⏳ 420` | modification préplanifiée — le node ne l'a pas encore |
| `900 ⚑ 420` | information modifiée en dehors de Fleet |

La valeur du show à gauche, celle du node à droite, et le cadre suit : bleu pour
ce qu'on a décidé, orange pour ce qui nous échappe.

**Le comparatif reste dans la matrice de modification.** Un tableau ailleurs
serait indigeste et décorrélé du geste qui corrige : le clic droit sur la
cellule propose de garder l'une ou l'autre valeur — ici, sur la sélection, sur
tout le node ou sur tout le groupe. Garder le show met la valeur en attente et
passe par Déployer ; garder le node aligne la référence et n'écrit nulle part.

Deux repères pour trouver les écarts sans liste : un badge `⚑ n` sur la ligne,
un compteur dans la barre d'outils. Cliquer l'un ou l'autre **sélectionne** les
cellules concernées, et dit combien sont dans des colonnes masquées.

**Sorties/DMX parle le même langage.** Le champ y porte déjà la valeur du node :
le badge ne porte donc que celle du show et se clique pour trancher. L'alim et
la carte d'un node hors ligne portent `⏳` — la valeur affichée est celle du
show, le node ne la connaît pas encore.

### Ce que la référence ne fait jamais

Elle ne bouge que dans deux cas : un **trou** se remplit — une colonne dont
Fleet n'a jamais eu d'avis prend la première valeur vue, donc un node
fraîchement découvert n'affiche **aucun** écart — ou la modification est
attribuée à **nous**. Un sondage ordinaire ne réaligne rien, et une mise à jour
de firmware non plus : c'est précisément le moment où l'on veut voir ce que le
firmware a changé tout seul.

Trente-huit colonnes portent une référence. Ni `state.on`, ni la luminosité, ni
le preset courant : ils changent à chaque conduite, les suivre couvrirait la
grille d'écarts que personne n'a provoqués. Leurs équivalents persistants, eux,
sont suivis.

La référence est persistée dans `known-nodes.json` et voyage dans le showfile —
c'est la part du fichier qui dit ce qui est **voulu**, par opposition à ce qui
est branché. Elle s'oublie node par node ou d'un coup, et se resème alors sans
aucun écart.

### Aussi

- **« Renommer d'après cette cellule » s'applique à la sélection.** Chaque node
  s'aligne sur *sa* valeur de la colonne, jamais sur celle du node cliqué —
  sinon vingt-sept nodes prendraient le même nom, le même mDNS et le même SSID.

### Format

Trois routes apparaissent : `POST` et `DELETE /api/node/:ip/ref`,
`POST /api/ref/reset`. `/api/fleet` porte `meta.ecarts` — les seules colonnes où
le show et le node divergent, avec la valeur du show. Le showfile emporte un
champ de plus par node ; un showfile antérieur s'importe sans erreur.

## 0.13.1

- **Un flash réussi ne se déclare plus en échec.** Un ESP32 redémarre aussitôt
  après avoir accusé réception du firmware : sa réponse part tronquée, et le
  parseur HTTP refusait le message — « Parse Error: Invalid character in chunk
  size ». Fleet annonçait un échec sur un node pourtant passé en 16.0.1. La
  réponse ne décide plus de rien : c est la version relue sur le node qui
  tranche. Un vrai refus (OTA verrouillé, place insuffisante) échoue toujours,
  et un node injoignable aussi.

## 0.13.0

> **Mettre à jour depuis la 0.12.0 débloque les nodes en firmware 0.14.** La
> 0.12.0 laissait leur plateforme vide et ne proposait aucune mise à jour.

Le format `/fleet.json` passe en **version 3** : `power.psu` désigne désormais
le **modèle** d'alimentation au catalogue et non plus un exemplaire. Rien à
migrer — aucun node ne portait de rattachement.

### La chaîne électrique passe dans la grille

- **Les exemplaires d'alimentation disparaissent.** Il fallait créer une fiche
  au catalogue *puis* un exemplaire posé sur le plateau (« Alim jardin, sous le
  praticable »). Personne ne les nommait. On choisit désormais un **modèle**
  directement sur le node, et un bouton **⛓ lier** dit quels nodes sont branchés
  sur la **même alimentation physique** — c'est cette distinction, et elle
  seule, qui décide si deux consommations s'additionnent.
- **La grille se lit dans le sens du courant** : `Alim · ⛓ · Node · ☐ · Sortie ·
  ⛓ · Profil · Px · …`. La cellule Alim s'étend sur tous les nodes liés et
  affiche la charge du groupe et le nombre de nodes sur les bornes déclarées.
- **La carte du node se choisit dans sa cellule**, avec le mode DMX et le budget
  de courant. Elle ne règle rien sur le node : elle décrit le matériel, et c'est
  ce qui permet de vérifier qu'un budget est réaliste.
- **L'onglet Puissance disparaît** : il n'existait que pour éditer des
  exemplaires. Le rapport de cohérence s'affiche sous le schéma.

### Le schéma montre enfin le plateau entier

Il ne dessinait que des boîtes de nodes nues : les sorties n'étaient produites
que pour les nodes *rattachés à une alimentation*, et aucun ne l'est tant que
personne ne l'a fait. Sur la flotte de référence : **64 boîtes et 37 câbles**
au lieu de 27 boîtes isolées. La chaîne se lit `alimentation → node → fixture →
sortie`, l'antenne partageant la première colonne.

### Les firmwares anciens redeviennent gérables

- **Les nodes en 0.14 sont lus et écrits correctement.** Dans cette génération
  le `mA/pixel` est **global** ; en 16.x il vit dans chaque sortie. Fleet lisait
  le mauvais endroit — et surtout, **écrire une valeur ne faisait rien** : WLED
  0.14 ignore les clés qu'il ne connaît pas, sans erreur, pendant que
  l'interface affichait la valeur demandée comme si elle était appliquée.
- **Leur plateforme est reconnue.** `info.release` n'existe que depuis la 0.15 :
  sans lui, la colonne Plateforme restait vide et aucune mise à jour n'était
  proposée — sur les nodes qui en avaient le plus besoin. Elle se déduit
  désormais de la puce, de la taille et du mode du flash, et **refuse de
  trancher** quand plusieurs builds collent.
- **Restaurer une sauvegarde après une mise à jour traduit la configuration.**
  Sans ça, un node passé de 0.14 à 16.x repartait sur 55 mA/pixel : un ruban
  déclaré à 120 aurait tiré plus du double, en silence.

### Ce que le rapport de cohérence voit désormais

Le marqueur de produit d'une sortie vit à deux endroits pour des raisons
historiques ; la grille lisait l'un, le rapport l'autre. Sur les mêmes sorties,
la grille affichait un écart que le rapport ignorait.

> Sur la flotte de référence, le rapport signale maintenant **six nodes dont le
> limiteur de courant est entièrement désactivé** (`ledma = 0`) — vérifié en
> direct : consommation estimée 0 mA, plafond appliqué 0 mA, alors que leur
> configuration annonce 850 mA.

### Aussi

- La colonne **Px** suit le produit choisi et non une reconnaissance : choisir
  une fiche aligne la ligne dessus et propose ses longueurs types, quel que soit
  l'état du node.
- **`wled-firmware/`** : un workflow GitHub Actions qui compile WLED avec le
  WiFi du spectacle inscrit dedans. À garder dans un dépôt **privé** — le
  binaire contient le mot de passe en clair. Sur l'étagère : une mise à jour OTA
  conserve la configuration, et l'appairage couvre déjà le cas d'un node neuf.

---

## 0.12.0

- **Déduire les cartes de la flotte** : un assistant propose une fiche par
  modèle reconnu, d'après la puce, la variante de build, le type d'Ethernet et
  le brochage. Il **regroupe** des nodes qui se présentent différemment plutôt
  que de créer des doublons — un doublon serait durable, puisque des nodes le
  porteraient — et affiche ce qui diffère pour que l'utilisateur tranche. Rien
  d'électrique n'est deviné : ce n'est nulle part sur un node.
- **L'écart à la fiche s'affiche** sous le profil, dans Sorties/DMX. Le calcul
  existait et voyageait dans l'API ; rien ne l'affichait.
- Colonne **Px** : les longueurs types d'un produit, à côté du profil.
- Deux défauts qui vidaient la colonne Profil : l'ancien marqueur à deux
  caractères n'était pas reconnu, et le repli exigeait la longueur *par défaut*.

## 0.11.1

- **Correctif de fond** : une apostrophe française dans une chaîne à guillemets
  simples rendait **tout `static/app.js` illisible**. L'application n'affichait
  plus que son HTML statique — menus figés, aucune donnée, aucun message. Un
  test parse désormais chaque fichier JavaScript livré.
- Le manifeste de mise à jour beta désignait un tag inexistant : l'application
  aurait annoncé une mise à jour puis téléchargé un 404.

> **À savoir** : réutiliser un numéro de version déjà installé ne répare rien.
> L'application n'extrait son code embarqué que si le numéro change.

## 0.11.0

- **Le showfile emporte les trois bibliothèques et le plan d'alimentation.**
- **Le schéma du plateau**, avec câblage à la souris.
- **Menus en familles**, sur deux niveaux.
- **Le rattachement électrique** : quelle alimentation nourrit quel node,
  écrit dans son `/fleet.json`.
- **`power.js`** : le rapport de cohérence, dont l'arithmétique de l'ABL a été
  vérifiée ligne à ligne dans le firmware WLED v16.0.1.
- **Trois catalogues** — produits LED, cartes, alimentations — sur une mécanique
  commune (`catalog.js`) : identifiant frappé à vie, révision qui monte quand
  les *réglages* changent et pas quand on corrige un nom, retrait sans
  effacement.
- **Les milliampères sont expliqués** là où on les édite : les deux régimes de
  l'ABL, lequel est actif, et le blanc plein réellement atteignable.

> Une correction qui compte : `ledma` est un `uint8_t` côté firmware. Toute
> valeur au-dessus de 255 était **tronquée en silence**, et l'ABL freinait
> d'après un chiffre que personne n'avait saisi.

## 0.10.0

- **Bibliothèque de produits LED** : identité par uuid et révision, longueurs
  types, application d'une fiche sur une sortie.
- **Colonne Fixture** et assignation en lot : une fixture se reconstitue en
  rassemblant les sorties qui portent le même numéro, y compris sur des nodes
  différents.
- **Chaque node emporte la fiche des produits qu'il cite** (`/fleet-lib.json`) :
  un node lu sur un poste qui n'a jamais vu ce spectacle se raconte tout seul.
- **Bibliothèque partagée sur GitHub**, sans jamais écraser personne : sur
  collision, la version en ligne devient la base et la nôtre repart au-dessus.
- **Connexion GitHub en une fois**, sans dépendance extérieure ni jeton à
  recopier.
- **`docs/api.md` généré depuis le code**, et les règles du dépôt (`CLAUDE.md`).
  Trois tests rendent la dérive impossible.
- **Deux canaux de mise à jour**, stable et beta, choisis à l'exécution.

---

## Ce qui reste ouvert

- **L'ordre des groupes** dans la grille n'est pas encore réglable (il est
  alphabétique).
- **Le mA par sortie** ne se voit pas dans le tableau Sorties/DMX : la colonne
  existe mais reste avancée, cachée derrière ⚙, y compris quand c'est ce régime
  qui gouverne.
- **La puissance d'une alimentation** ne se saisit qu'en ampères. Une batterie
  ou une powerbank s'annonce en mA : il faut pouvoir choisir l'unité.
- **Le WiFi compilé dans le firmware** attend un dépôt privé — voir
  `wled-firmware/`.
- **L'`client_id` de l'OAuth App** doit être créé pour que la connexion GitHub
  fonctionne sur un poste distribué.
