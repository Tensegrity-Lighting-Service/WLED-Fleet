# Journal des versions

Ce fichier dit **ce qui a changé et pourquoi**. Le détail technique est dans les
messages de commit ; ici on garde ce qu'il faut savoir avant de mettre à jour.

## Où en sont les deux canaux

| canal | version | ce qu'on y trouve |
|---|---|---|
| **stable** | **0.9.0** | la dernière version éprouvée en exploitation |
| **beta** | **0.13.0** | toute la chaîne électrique, le schéma du plateau, les trois bibliothèques |

Tout ce qui suit la 0.9.0 vit donc **uniquement sur le canal beta** (⚙ Réglages →
Application → Canal). Le canal stable ne peut pas l'attraper par accident :
GitHub ne résout jamais `releases/latest` vers une préversion.

---

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
- **Le WiFi compilé dans le firmware** attend un dépôt privé — voir
  `wled-firmware/`.
- **L'`client_id` de l'OAuth App** doit être créé pour que la connexion GitHub
  fonctionne sur un poste distribué.
