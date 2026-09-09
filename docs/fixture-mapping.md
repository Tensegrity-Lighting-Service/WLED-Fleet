# Ce que WLED Fleet écrit sur les nodes, et comment il calcule les adresses

Ce document décrit **ce que fait WLED Fleet** : son modèle (nodes, groupes,
sorties, produits, fixtures), ce qu'il dépose sur chaque node, et l'arithmétique
DMX exacte qu'il applique.

Il s'adresse à quiconque interroge les nodes **directement en HTTP**, sans passer
par l'API de Fleet — un outil tiers, un plugin console, un script. Il ne prescrit
rien : il constate.

> **Règle qui prime sur tout le reste.** `hw.led.ins[]` dans `/json/cfg` est la
> **vérité** : c'est ce que le node pilote réellement. Ce que Fleet ajoute
> (`/fleet.json`) est un **indice** : ce que Fleet croit savoir de ces sorties.
> En cas de désaccord, le matériel a raison. Un node que Fleet n'a jamais vu n'a
> pas de `/fleet.json` du tout, et reste parfaitement exploitable.

---

## 1. Le modèle

| Notion | Où elle vit | Ce que c'est |
|---|---|---|
| **Node** | le boîtier WLED lui-même | une IP, un nom, un point de départ DMX (univers + adresse), un mode |
| **Sortie** | `hw.led.ins[i]` | un ruban physique branché sur un GPIO : type de LED, nombre de pixels, ordre des couleurs, sens… |
| **Groupe** | `if.mqtt.topics.group` | un nom libre partagé par plusieurs nodes (« Boule », « Tournette Ext »). Attribut du **node**, pas d'une sortie |
| **Chaînage** | déduit des départs | deux sorties dont les pixels se suivent sans trou : `ins[n+1].start == ins[n].start + ins[n].len` |
| **Produit** | `/fleet.json` → `outputs[].product` | référence à un catalogue de produits LED tenu par Fleet |
| **Fixture** | `/fleet.json` → `outputs[].fixture` | numéro de fixture **console**, posé par l'utilisateur |

Une **sortie** n'est pas une fixture, et une fixture n'est pas forcément une
sortie : plusieurs sorties peuvent composer une même fixture, y compris sur des
nodes différents (§5).

---

## 2. Ce que le node expose déjà, sans Fleet

Tout vient de `GET /json/cfg` :

```jsonc
{ "id":  { "mdns": "boule03", "name": "WLED boule 03" },
  "nw":  { "ins": [ { "ssid": "…", "ip": [192,168,88,53] } ] },
  "if":  { "live": { "en": true, "port": 5568, "mc": false,
                     "dmx": { "uni": 120, "addr": 217, "mode": 4 } },
           "mqtt": { "cid": "WLED-507AF0",
                     "topics": { "device": "wled/507AF0", "group": "Boule" } } },
  "hw":  { "led": { "ins": [ { "start": 0, "len": 36, "pin": [10], "order": 0,
                               "rev": false, "skip": 0, "type": 22, "ref": false,
                               "ledma": 55, "maxpwr": 850, "text": "" } ] } } }
```

- `if.live.port` **5568** = sACN/E1.31 · `mc: false` = **unicast** (la source doit
  émettre vers l'IP du node) · `mc: true` = multicast.
- `if.live.dmx.uni` / `.addr` = le point de départ du node, `.mode` le mode (§4).
- `if.mqtt.topics.group` porte le **groupe Fleet**. C'est un vrai topic MQTT
  valide : inerte quand MQTT est désactivé, ce qui est le cas le plus courant.

> ⚠️ **`hw.led.ins[].text` ne sert à rien sur un ruban.** Le champ apparaît dans
> le cfg, mais sur une sortie **numérique** WLED ne le conserve jamais : la classe
> de base renvoie une chaîne vide (`bus_manager.h:148`) et `BusDigital` ne la
> redéfinit pas. Seules les sorties **réseau** (types 80-88) l'utilisent, et là
> c'est l'**hôte de destination** DDP/Art-Net — y écrire autre chose casse la
> sortie. Vérifié sur WLED v16.0.1. Ne pas s'en servir, dans un sens comme dans
> l'autre.

---

## 3. Ce que Fleet ajoute : `/fleet.json`

Fleet dépose un fichier sur le système de fichiers du node (`POST /upload` en
multipart), servi ensuite par un simple `GET /fleet.json`.

```jsonc
{ "format": "wled-fleet-node",
  "formatVersion": 3,
  "group": "Boule",
  "power": { "psu": "8f97e081-6f2f-4133-bd38-ec7a91f2439b",
             "psuGroup": "3c1d5a90-77bb-4e02-9a44-1f6e0b2c8d55",
             "rail": "A",
             "driver": "76966b0d-1b2c-4a55-9e10-3f8d2a4b6c71" },
  "updatedAt": 1757337600000,
  "updatedBy": "decle",
  "outputs": [
    { "i": 0, "pin": "10", "product": "d8972dbb-1383-4f3c-b0c0-c1ea6a2dc378",
      "prev": 2, "fixture": 101, "instance": 0 },
    { "i": 1, "pin": "12", "product": "d8972dbb-1383-4f3c-b0c0-c1ea6a2dc378",
      "prev": 2, "fixture": 101, "instance": 36 }
  ] }
```

| clé | sens |
|---|---|
| `i` | **position** de la sortie dans `hw.led.ins` — c'est la clé de correspondance |
| `pin` | GPIO au moment de l'écriture, pour détecter un réordonnancement fait hors de Fleet |
| `product` | identifiant du produit dans le catalogue de Fleet — **chaîne opaque** |
| `prev` | **révision du produit** avec laquelle cette sortie a été patchée |
| `fixture` | **numéro de fixture console** |
| `instance` | décalage de la première instance de cette sortie dans la fixture (0 = début) |
| `order` | ordre d'affichage voulu par l'utilisateur |
| `unused` | `true` = sortie déclarée non câblée ; elle ne réserve aucun canal |
| `note` | texte libre |

Règles de lecture :

- **Le fichier peut être absent** (404) : le node n'a jamais été vu par Fleet.
  Ce n'est pas une erreur.
- **Les valeurs par défaut sont omises** : pas de `instance` = 0, pas de `unused`
  = câblée. Une sortie sans rien à dire n'apparaît pas du tout.
- **Les clés inconnues sont conservées** par Fleet à la réécriture. Une version
  plus récente peut donc en ajouter sans qu'une version plus ancienne les efface.
- `i` renvoie à `hw.led.ins[i]`. Si `pin` ne correspond plus au GPIO trouvé à
  cette position, quelqu'un a réordonné les sorties en dehors de Fleet : les
  métadonnées de cette sortie sont **douteuses**.

### `power` — ce qui alimente et ce qui pilote

Apparu en **formatVersion 2**. Absent d'un fichier plus ancien, ce qui n'est pas
une erreur : le node n'a simplement rien à dire là-dessus.

| clé | sens |
|---|---|
| `psu` | le **modèle** d'alimentation qui nourrit ce node |
| `psuGroup` | quels nodes partagent la même alimentation **physique** |
| `rail` | sa sortie, quand l'alimentation en a plusieurs |
| `driver` | le **modèle** de carte que ce node est |

> **Changement en formatVersion 3.** Jusqu'à la v2, `psu` désignait un
> *exemplaire* — « l'alim jardin, sous le praticable » — décrit dans un fichier
> propre au poste. Ces exemplaires n'existent plus : personne ne les nommait, et
> ce qu'ils apportaient vraiment tient dans `psuGroup`. **`psu` se résout
> désormais dans le catalogue des alimentations**, au même titre que `driver`
> dans celui des cartes. Un lecteur qui l'ignorerait chercherait un uid dans le
> mauvais catalogue : c'est pour ça que la version change.

`psuGroup` est un identifiant **opaque et local** : deux nodes qui le partagent
sont branchés sur la même alimentation physique. Sans lui, deux nodes désignant
le même modèle seraient indiscernables de deux nodes sur deux alimentations
identiques — et c'est exactement la question que pose un budget de courant :
faut-il additionner leurs consommations, ou non. Il n'a aucun sens hors de ce
plateau, et ne va donc jamais dans le dépôt partagé. Un node sans `psuGroup`
décrit une alimentation à lui seul.

Un `psu` ou un `rail` peut aussi apparaître **sur une sortie** : elle l'emporte
alors sur celui du node. C'est le cas d'une structure dont deux rubans partent
sur un autre circuit. Même hiérarchie que le groupe, qui est du node, contre la
fixture, qui est de la sortie. *(Prévu par le format ; le rapport de cohérence
de Fleet ne le prend pas encore en compte.)*

Ces identifiants renvoient à des choses qui vivent ailleurs. La fiche
correspondante est déposée dans `/fleet-lib.json` (voir plus haut), pour qu'un
node lu sur un poste qui n'a jamais vu ce spectacle ne dise pas seulement
« alimenté par 8f97e081… ».

WLED, lui, ne connaît pas la tension : `hw.led.maxpwr` est un courant en
milliampères, et rien dans le node ne dit sous quelle tension. C'est
précisément ce que `power` permet de retrouver.

### `product` et `prev`

`product` est une **chaîne opaque** : ne rien en déduire, ne pas la découper, la
comparer telle quelle. Fleet y écrit un uuid v4 depuis la version 3 de son
catalogue ; des nodes patchés avant portent encore un identifiant court à deux
caractères (`"a0"`). Les deux formes restent valides et cohabitent dans une même
flotte — Fleet ne réécrit pas un node pour le seul plaisir de moderniser son
marqueur.

`prev` est la **révision du produit** au moment où ces réglages ont été écrits.
Elle monte quand les réglages du produit changent, pas quand on corrige son nom.
Elle sert à répondre à une question que le marqueur seul ne permet pas de poser :
ce node porte-t-il vraiment les réglages actuels du produit, ou ceux d'une
version antérieure ? Un node resté longtemps hors ligne annonce ainsi `prev: 3`
alors que le catalogue est en révision 5.

Une révision **supérieure** à celle du catalogue local n'est pas une anomalie du
node : c'est le catalogue local qui est en retard. Ne rien réappliquer dans ce
cas — ce serait écraser des réglages plus récents.

### Historique

Avant ce fichier, Fleet planquait deux informations dans les champs MQTT, faute
de place ailleurs. D'anciens nodes peuvent encore les porter :

- `if.mqtt.cid` suffixé `#p` : profils par sortie, 2 caractères chacun,
  positionnel, `..` = aucun. Ex. `WLED-41686c#p..0a`.
- `if.mqtt.topics.device` suffixé `#u` : sorties non câblées, numérotées à partir
  de 1. Ex. `wled/41686c#u2.4` = sorties 2 et 4 non câblées.

`/fleet.json` fait autorité quand il existe.

---

## 3 bis. La fiche des produits : `/fleet-lib.json`

Un `product` renvoie à un catalogue extérieur au node. Un lecteur qui n'a pas ce
catalogue tient donc un identifiant qui ne veut rien dire. Fleet dépose, à côté
des marqueurs, la **fiche complète** des produits que les sorties de ce node
citent — le node se décrit alors tout seul.

```jsonc
{ "format": "wled-fleet-node-library",
  "formatVersion": 3,
  "savedAt": 1757337600000,
  "products": [
    { "uid": "d8972dbb-1383-4f3c-b0c0-c1ea6a2dc378",
      "rev": 2,
      "slug": "ledpro-flex60",
      "ref": { "brand": "LEDpro", "model": "Flex60", "sku": "LP-F60-2815",
               "internal": "", "note": "" },
      "led": { "type": 22, "order": 1, "wswap": 0, "ledma": 55,
               "skip": 0, "offRefresh": false, "perM": 60 },
      "presets": [ { "label": "2 m", "px": 120, "default": true } ] }
  ],
  "drivers": [ /* la fiche de la carte, même forme : uid, rev, ref, board */ ],
  "psus":    [ /* le MODÈLE d'alimentation : uid, rev, ref, psu */ ] }
```

`led` reprend le vocabulaire de `hw.led.ins[]` : appliquer un produit à une
sortie est une copie de champs, sans traduction. `order` est le quartet **bas**
et `wswap` le quartet **haut** du même octet WLED.

`drivers` et `psus` accompagnent le bloc `power` de `/fleet.json` : ce sont
les fiches de catalogue que ce node désigne, déposées ici pour qu'il se raconte
tout seul. Elles peuvent manquer ; les clés inconnues d'une version plus récente
sont conservées.

> Une clé `powerNodes` a existé jusqu'en formatVersion 2 : elle portait
> l'*exemplaire* d'alimentation posé sur le plateau. Les exemplaires ont
> disparu, et un lecteur qui rencontre encore cette clé peut l'ignorer.

Ce que le produit ne contient **pas**, délibérément : le sens de parcours
(`rev`), l'index de départ, l'univers et l'adresse. Ce sont des propriétés de
l'installation, pas du produit ; les y mettre ferait qu'appliquer un produit
casserait un patch.

Règles de lecture :

- **C'est un exemplaire daté, pas une autorité.** Il dit ce que Fleet savait du
  produit au moment où il a écrit cette sortie. Le catalogue d'un autre poste
  peut être plus avancé.
- Le fichier peut être **absent** : node jamais vu par Fleet, ou dont aucune
  sortie ne cite de produit.
- Il ne contient que les produits **cités par ce node**, pas le catalogue entier.
- Deux copies portant le **même `rev` avec des `led`/`presets` différents**
  signalent que deux postes ont fait monter le même numéro chacun de leur côté.
  Le numéro ne départage alors rien : c'est un cas à signaler, pas à trancher
  automatiquement.

---

## 4. L'arithmétique DMX, telle que Fleet la calcule

En mode « Multi », WLED prend les pixels **dans l'ordre des index globaux** et les
étale sur des univers consécutifs à partir de `uni` / `addr`.

| `if.live.dmx.mode` | nom | canaux/pixel | pixels par univers plein |
|---|---|---|---|
| 4 | Multi RGB | 3 | 170 |
| 5 | Multi DRGB | 3 | 170 |
| 6 | Multi RGBW | 4 | 128 |

**Deux pièges que le cfg seul ne révèle pas :**

1. **`order` ne concerne pas le flux DMX.** L'ordre des couleurs (quartet bas :
   0=GRB, 1=RGB, 2=BRG, 3=RBG, 4=BGR, 5=GBR) et l'échange du blanc (quartet
   haut : 1=W↔B, 2=W↔G, 3=W↔R, 4=WW↔CW) sont **internes à WLED**, qui remappe
   vers le ruban juste avant le driver. Ce qui arrive par le réseau est **toujours
   RGB(W) dans l'ordre naturel**. Un consommateur qui déduirait un ordre de
   canaux de `order` se tromperait.
2. **En Multi DRGB (mode 5), le premier canal est un dimmer**, pas un pixel : il
   occupe `addr`, et les pixels commencent à `addr + 1`.

### Position d'un pixel

Avec `cp` = canaux/pixel, `dim` = 1 en mode 5 sinon 0 :

```
pxPerUni   = floor(512 / cp)                       // 170 en RGB, 128 en RGBW
firstUniPx = floor((512 - (addr - 1) - dim) / cp)  // capacité du PREMIER univers

locate(px) =
  px < firstUniPx  ->  { u: uni,
                         ch: addr + dim + px * cp }
  sinon            ->  { u:  uni + 1 + floor((px - firstUniPx) / pxPerUni),
                         ch: 1 + ((px - firstUniPx) % pxPerUni) * cp }
```

**Le premier univers ne contient pas toujours `pxPerUni` pixels** : dès que
`addr > 1`, les canaux avant `addr` sont déjà pris et il en contient moins. À
l'adresse 109 en RGB, il n'en porte que 134, pas 170. Diviser par 170 pour
trouver une frontière d'univers donne un résultat faux — c'est l'erreur classique.

Une sortie qui commence au pixel `start` et fait `len` pixels occupe donc de
`locate(start)` à `locate(start + len - 1)`, ce dernier canal augmenté de `cp - 1`.

### Sens inversé

`ins[i].rev = true` : WLED remappe l'index de bus `i` sur la position physique
`len - 1 - i` **avant** le driver. Les canaux DMX ne bougent pas ; c'est le
ruban qui est lu à l'envers. Le pixel physique n°k d'une sortie inversée
correspond donc à l'index global `start + len - k`.

### `skip`

`ins[i].skip` = nombre de LEDs en tête de câble câblées mais non pilotées. Elles
**consomment des canaux** comme les autres.

---

## 5. Fixtures

Une fixture n'est stockée nulle part en tant qu'objet. Elle se **reconstitue** :

1. Récolter toutes les sorties de tous les nodes qui portent le même `fixture`.
2. Les trier par `instance` croissant.
3. La fixture commence à l'adresse du premier pixel du membre `instance = 0`,
   calculée par `locate()` sur **son** node.

Le nombre total d'instances est la somme des `len` des membres.

**Une fixture peut couvrir plusieurs nodes.** Chaque pixel étant une instance
adressée relativement au départ de la fixture, la traversée d'univers ne pose pas
de problème en soi. En revanche, quand les membres sont sur des nodes différents,
leurs plages de canaux **ne sont pas contiguës** : la fixture correspond alors à
**plusieurs points de patch**, un par membre, chacun à son `univers.canal`.
Fleet signale ce cas.

---

## 6. Exemples, tirés d'une flotte réelle

### Un node, une sortie

```
if.live.dmx = { uni: 121, addr: 109, mode: 4 }   // Multi RGB, cp = 3
hw.led.ins  = [ { start: 0, len: 36, pin: [10] } ]
```

`firstUniPx = floor((512 - 108) / 3) = 134`, donc les 36 pixels tiennent dans le
premier univers : `locate(0) = 121.109`, `locate(35) = 121.214` (+2) →
**121.109 → 121.216**, 108 canaux.

### Quatre nodes courts dans un seul univers

36 pixels = 108 canaux : quatre nodes tiennent dans l'univers 121 aux adresses
**1, 109, 217, 325**. Ils partagent l'univers sans se recouvrir d'un seul canal.

### Deux sorties chaînées, une fixture

```
if.live.dmx = { uni: 122, addr: 1, mode: 4 }
hw.led.ins  = [ { start: 0,  len: 36 },      // 122.1   → 122.108
                { start: 36, len: 36 } ]     // 122.109 → 122.216
/fleet.json  outputs = [ { i:0, fixture:101, instance:0 },
                         { i:1, fixture:101, instance:36 } ]
```

Une fixture de 72 instances démarrant à **122.1**, sans discontinuité.

### Une sortie à cheval sur deux univers

```
uni: 10, addr: 1, mode: 4, start: 0, len: 200
```

`firstUniPx = 170` : pixels 0-169 dans l'univers 10 (canaux 1→510), pixels
170-199 dans l'univers 11 (canaux 1→90). **10.1 → 11.90**.

---

## 7. Ce qui n'est pas garanti

- `/fleet.json` peut être **absent, périmé ou incomplet**. Il n'est écrit que
  lorsque l'utilisateur enregistre depuis Fleet.
- Les `product` renvoient à un catalogue **externe au node**. Un identifiant
  inconnu doit être conservé tel quel, jamais effacé : il vient probablement
  d'un poste dont le catalogue est plus complet. `/fleet-lib.json` donne la
  fiche quand elle est là, mais telle qu'elle était à l'écriture.
- L'écriture du fichier exige le **PIN des réglages** quand le node en a un
  (WLED répond 401).
- Ne jamais écrire sous les noms `cfg.json` (provoque un redémarrage),
  `presets.json` ni `palette*.json` : WLED leur donne un sens.
- Rien ne pousse jamais un produit ou une fixture vers un node sans action
  explicite de l'utilisateur.

---

*Ce document décrit le comportement de WLED Fleet. L'arithmétique de la §4 est
celle de `dmx.js`, couverte par `test/dmx.test.js` ; le format de la §3 est celui
de `metadata.js`, couvert par `test/metadata.test.js`.*
