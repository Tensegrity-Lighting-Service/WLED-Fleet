# wled-fleet

Gestionnaire de flotte WLED (Phase 1 de la roadmap) : découverte des nodes sur
le réseau, suivi de leur santé, et **grille de réglages type tableur** — une
ligne par node, une colonne par paramètre, cellules éditables.

Prototype Node.js **sans aucune dépendance** (stdlib uniquement). Le cœur
temps-réel (DDP) restera en Go, conformément à la roadmap ; ce module valide
d'abord l'API WLED et le modèle de données.

## Application autonome (sans Claude, sans console)

- **`WLED-Fleet.exe`** (raccourci « WLED Fleet » du Bureau) : fenêtre native
  comme Lumitrack (coquille Tauri 2 / WebView2 dans `desktop/`). Elle lance
  `node server.js` **caché** (aucune console), affiche la page dans sa
  fenêtre, relance node sur le code 75 (bouton « Redémarrer le serveur »)
  ou après un plantage, et tue node quand on ferme la fenêtre. Si un serveur
  tourne déjà sur le port (lancé par `WLED-Fleet.cmd`), il est réutilisé.
  L'exe cherche `server.js` à côté de lui : le laisser dans ce dossier.
  Recompiler seulement après une modif de `desktop/src/main.rs` (jamais
  nécessaire pour le reste de l'app) : `cd desktop && cargo build --release`
  puis copier `desktop/target/release/wled-fleet-desktop.exe` en
  `WLED-Fleet.exe`. Icône : `node tools/make-icon.js`.
- **`WLED-Fleet.cmd`**, variante sans fenêtre native : démarre le serveur en
  console réduite avec les réglages de `settings.json` et ouvre la page dans
  le navigateur. Fermer la fenêtre réduite = arrêter.
- **`settings.json`** remplace les arguments : `subnet`, `listen`, `interval`,
  `cfgInterval`, `readonly`, `otaParallel` (mêmes noms que les options, en
  camelCase ; un argument en ligne de commande garde la priorité).
  `"listen": "0.0.0.0:8792"` rend la page accessible depuis une tablette ou un
  téléphone du réseau.
- **Bouton « ↻ Redémarrer le serveur »** en bas de page : relance node avec
  les fichiers modifiés (le lanceur relance sur le code de sortie 75). C'est
  ainsi qu'une modification de code prend effet : éditer, cliquer, la page se
  reconnecte. Si le serveur plante, le lanceur le relance après 5 s.
- **Démarrage avec Windows** (optionnel) :
  `powershell -ExecutionPolicy Bypass -File tools\install-shortcuts.ps1 -Autostart`
  crée une tâche planifiée à l'ouverture de session (`-RemoveAutostart` pour
  l'enlever). Sans `-Autostart`, le script ne fait que le raccourci du Bureau.
- Seul prérequis : Node.js 18+ (aucune dépendance npm, rien à installer
  d'autre). Tout le code reste en fichiers clairs dans ce dossier.
- **Mise à jour** : pas d'installateur, `WLED-Fleet.exe` reste un dossier
  portable (l'exe à côté de `server.js`, `settings.json`, `known-nodes.json`,
  `snapshots/`, `firmware/`…). Au démarrage, l'app vérifie discrètement s'il y a
  une nouvelle version (dépôt public
  [WLED-Fleet](https://github.com/Tensegrity-Lighting-Service/WLED-Fleet)) et
  propose de l'installer : les fichiers de code sont remplacés sur place,
  jamais tes réglages / la flotte connue / les sauvegardes / le dépôt de
  firmwares. Rien de silencieux ni de forcé : un clic pour installer, un clic
  pour ignorer.

## Réseau : changement de carte, perte de connexion, nodes égarés

- **Panneau ⚙ Réglages** : sous-réseau de la flotte (cartes détectées à
  cliquer, ou auto), accès à la page (ce PC seulement / tout le réseau, port),
  intervalles, parallélisme OTA, lecture seule. Enregistrer écrit
  `settings.json` et redémarre par le lanceur ; la page se reconnecte.
- **Surveillance des cartes réseau** toutes les 5 s : tout changement (câble,
  dock, DHCP, Wi‑Fi qui bascule) est loggé et journalisé ; dès que le PC
  retrouve une adresse dans le sous-réseau de la flotte, les nodes sont
  ré-interrogés et un scan repart. Badge en haut de page : `PC : ip (carte)`,
  ou `⚠ PC hors du réseau x.x.x.x` en orange avec les adresses actuelles au
  survol. Un node perdu passe simplement hors ligne (2 relevés manqués) et
  revient seul ; rien n'est oublié.
- **Nodes hors sous-réseau** : le scan balaye aussi les *autres* sous-réseaux
  du PC (« secours »). Un node qui y répond (IP fixe mal réglée, reste d'un
  autre show) est marqué **hors réseau** (badge en haut, bouton
  **⇢ rapatrier** sur sa ligne). Rapatrier propose une IP libre et logique
  dans le bon sous-réseau, réécrit ip/gw/sn du premier profil Wi‑Fi (même
  SSID, mot de passe conservé : cfg.json ne le renvoie jamais et WLED le garde
  quand la clé est absente), redémarre le node et le suit à sa nouvelle
  adresse. Endpoint : `POST /api/node/:ip/relocate {ip, gw?, sn?}`.
  Condition : le PC doit avoir lui-même une adresse dans ce sous-réseau
  étranger (sinon le node est injoignable, il faut l'appairage).

## WiFiman Wizard : sonde RF mobile (Bluetooth)

Le boîtier WiFiman Wizard d'Ubiquiti (scanner 802.11 2,4 / 5 GHz en
réception seule, sur batterie, relié en Bluetooth LE) sert de **troisième
source RF**, après le scan de l'antenne MikroTik et la carte Wi-Fi du PC :
promené sur le plateau, il montre ce qu'un node entendrait *à cet endroit*.
**Un seul bouton « 📡 WiFiman »** dans l'onglet Antenne, à côté de « Scanner
l'environnement » : un clic active la sonde, cherche le Wizard en Bluetooth
(adresse enregistrée, sinon découverte par adresse Ubiquiti / service BLE),
se connecte et le mémorise ; le bouton affiche l'état (recherche…, connecté à
UWS-038 · 44 réseaux, ou le problème en clair : Wizard non vu → appuyer sur
son bouton, couper le Bluetooth du téléphone). Un second clic arrête. Le
reste (autre boîtier, simulation, Python) est replié dans « Options WiFiman
Wizard ». Prérequis (Python 3.9+ et le module bleak) : installés par
`toolsinstall-shortcuts.ps1` (winget + pip, `-NoWizard` pour sauter), ou
par le bouton « Installer les prérequis » qui apparaît s'il manque quelque
chose (`POST /api/wizard/install`).

- Node n'a pas de Bluetooth : le serveur lance `tools/wizard/wizard_bridge.py`.
  L'adresse choisie est mémorisée dans `wizard.json` (ignoré par git) et la
  reconnexion au démarrage est automatique tant que la sonde est active.
  `--wizard-mock` (ou « Simulation » dans les options) fait tourner le bridge
  sans matériel.
- **Ce que le Wizard entend** : même histogramme d'occupation 1-13 et même
  recommandation de canal que le scan de l'antenne (calcul partagé,
  `ap.occupancy`), **vue fréquence** 2,4 et 5 GHz (chaque réseau dessiné à sa
  fréquence, large comme son canal, haut comme son signal ; ton canal et le
  canal recommandé en repère ; survol = détail, charge d'air et stations
  annoncées par l'AP), **cascade temps × canal** (une ligne toutes les 5 s
  sur une heure, couleur = signal le plus fort par tranche de 5 MHz : un
  voisin qui s'allume pendant le show apparaît comme une bande qui démarre),
  tableau des réseaux avec min / max et fraîcheur, ligne
  « antenne reçue ici à N dBm » avec l'historique du signal du réseau du
  show (même antenne 3 dBi qu'un ESP32 : c'est à peu près le RSSI qu'aurait
  un node posé là), et « Antenne vs Wizard » pour les réseaux vus des deux
  côtés.
- **Relevés** : un libellé (« régie », « plateau jardin »…), **Enregistrer le
  relevé** → une ligne dans `wizard-surveys.log`, relue au démarrage ;
  comparer le canal recommandé d'un endroit à l'autre avant de changer celui
  de l'antenne.
- **Live** : posé près d'un node (menu « posé »), ses trouvailles rejoignent
  le **Diagnostic** de l'antenne (antenne non entendue ou faible à cet
  endroit, voisin fort sur ton canal, réseau 40 MHz proche, écart node /
  Wizard ≥ 12 dB) et `wizard-live.log` garde un point toutes les 5 s.
- **Protocole** : le lien BLE du Wizard n'est pas public ; il a été relevé
  sur l'appareil (firmware 1.9.0) et documenté dans `docs/wizard-protocol.md`
  (HTTP sur BLE : requêtes JSON `GET /api/version`, `POST …/wifi/trigger_scan`,
  `GET …/wifi/get_scan_result`, résultats par canal balayé chaque seconde).
  `tools/wizard/wizard_decode.py` l'implémente ; une connexion réelle affiche
  les réseaux 2,4 et 5 GHz avec largeur, sécurité et norme, la batterie
  remonte toutes les minutes. Après une déconnexion, le Wizard reste
  invisible en Bluetooth pendant environ une minute : la reconnexion attend.
  Le Wizard n'est pas un analyseur spectral : il ne voit pas le bruit non
  Wi-Fi.

API : `GET /api/wizard`, `GET /api/wizard/devices`, `POST /api/wizard/connect
{address | mock}`, `POST /api/wizard/disconnect`, `POST /api/wizard/survey
{label}`, `GET /api/wizard/surveys`, `DELETE /api/wizard/survey {at}`,
`POST /api/wizard/near {mac}`, `POST /api/wizard/config {enabled, autoconnect,
python, address}`, `GET /api/wizard/live`, `GET /api/wizard/waterfall?n=360`. Tests : `npm test`
(plan de canaux partagé, cascade)
et `python -m unittest test_wizard_decode` dans `tools/wizard/` (trames,
résultats du firmware).

Un plantage du serveur est invisible dans la fenêtre native (le lanceur le
relance en silence après 5 s) : la raison est écrite dans
`server-errors.log` à côté de `server.js`.

## Lancer à la main

```sh
node server.js                                   # scanne tous les /24 locaux
node server.js --subnet 192.168.88               # limite le scan
node server.js --ip 192.168.88.81,192.168.88.82  # liste fixe, pas de scan
node server.js --readonly                        # interdit toute écriture
# puis ouvrir http://127.0.0.1:8792/
```

Options : `--listen 127.0.0.1:8792`, `--interval 3000` (ms, info+state),
`--cfg-interval 20000` (ms, relecture de cfg.json).

Les IP trouvées sont mémorisées dans `known-nodes.json` (ignoré par git) pour
que le redémarrage soit instantané ; « Rescanner » relance le balayage.

## Comment on parle aux nodes

Tout passe par l'API JSON HTTP de WLED, sur le port 80 du node :

| Endpoint            | Sens | Contenu |
|---------------------|------|---------|
| `GET /json/info`    | lecture | version, nom, MAC, LEDs (count, fps, conso), Wi‑Fi (rssi, bssid, canal), heap, uptime, protocole live actif (`lm`) et source (`lip`) |
| `GET /json/state`   | lecture | on/bri, preset, sync UDP (`udpn`), segments |
| `GET /json/cfg`     | lecture | **cfg.json complet** : identité, réseau, sorties LED (`hw.led.ins`), E1.31/DMX (`if.live`), sync, MQTT, défauts de boot… |
| `GET /json/nodes`   | lecture | les autres nodes WLED vus en broadcast UDP (port 65506) → découverte de proche en proche |
| `POST /json/cfg`    | écriture | fusion partielle : seules les clés envoyées sont appliquées, puis cfg.json est sauvé en flash |
| `POST /json/state`  | écriture | idem pour l'état ; `{"rb":true}` redémarre |

Le serveur ne fait que relayer ces appels ; le navigateur ne parle jamais
directement aux nodes.

### Ce qui est éditable dans la grille

Tout ce que WLED accepte en écriture l'est dans la grille (43 colonnes ✎) :
nom, mDNS, SSID de l'AP, **SSID, IP fixe, passerelle, type Ethernet** (bloc
`nw.ins` renvoyé entier sans le mot de passe, que WLED conserve ; redémarrage
automatique), univers/adresse/mode DMX, options E1.31, sync, limite mA, FPS
cible, on/bri/preset, **effet et palette du segment 0** (`{seg:[{id,fx}]}`),
valeurs de boot, gamma, transition. Les **sorties LED** s'éditent dans
l'onglet Sorties / DMX (bloc `hw.led.ins` complet).

Restent en lecture seule, par nature : les mesures (RSSI, FPS, RAM, uptime,
latence…), ce que l'antenne voit, les infos firmware, et le verrou OTA (se
déverrouille uniquement dans WLED avec son mot de passe).

Les erreurs de déploiement s'affichent cellule par cellule (bulle sur la
cellule + liste dans la notification). Les changements d'IP d'un même
déploiement partent en **un lot** (`POST /api/nodes/relocate`) : écriture sur
tous les nodes, puis redémarrage groupé, donc **échanger deux IP marche**
(l'ancienne adresse est libérée au moment où la nouvelle est prise). Refusé :
une cible tenue par un node absent du lot, ou deux nodes vers la même IP.

Les colonnes marquées ⟳ ne prennent effet qu'après redémarrage (bouton ⟳ sur la
ligne).

## Showfile de l'application

Onglet Sauvegardes, bloc **Showfile** : un seul fichier `.wledfleet` qui
contient tout ce que l'app sait : `settings.json`, les antennes **avec leurs
mots de passe**, la liste des nodes avec leurs dernières infos connues, les
sauvegardes de configs, le catalogue firmware (pas les .bin, re-téléchargeables)
et la disposition des colonnes ; en option le journal et l'historique des
scans radio. Phrase secrète facultative : le fichier est alors chiffré
(scrypt + AES‑256‑GCM), illisible sans elle ; en clair, les mots de passe sont
lisibles dans le fichier. L'import choisit quoi remplacer (réglages, antennes,
nodes, sauvegardes, catalogue, colonnes) et redémarre le serveur si les
réglages changent. Endpoints : `POST /api/showfile`, `POST /api/showfile/import`.

## Sorties / DMX

**Un tableau par groupe**, façon cellules fusionnées : la cellule du node (nom, IP,
univers de → à, pixels, état, et ses réglages DMX : mode, univers et adresse de
départ, limite mA) s'étend sur ses lignes de sorties, qui se suivent d'un node à
l'autre. Les sorties existent déjà sur les boîtiers : pas d'ajout ici, on règle
type, ordre, départ, pixels et sens ; l'adresse console de → à et les univers
occupés se recalculent en direct. **Un seul bouton « Enregistrer les
modifications »** (actif dès qu'un champ diffère) écrit sur chaque node touché :
ses sorties (bloc complet, sauvegarde de la flotte prise avant) et ses réglages
DMX (via la mise en attente et Déployer, donc journal). Le calculateur **📏** : LEDs par mètre ×
longueur → pixels, et le nombre d'univers que ça occupe pour ce type de LED
(170 px RGB, 128 px RGBW par univers). Une sortie sur plusieurs univers est
normale ; l'avertissement ▲ ne reste que si la sortie suivante commence au
milieu d'un univers. **« ≡ univers entiers »** (dans la cellule du node quand ce
n'est pas le cas) décale le *départ* de chaque sortie au début d'un univers sans
toucher à son nombre de pixels : les index laissés libres (ex. 160-169) ne
pilotent rien, la sortie suivante commence sur l'univers suivant, et la
consommation estimée reste juste.

- **⚡ Autopatch** (par groupe, ou par node solo, les nodes sans groupe étant
  considérés seuls) : chaque sortie commence sur un nouvel univers, les nodes
  du groupe s'enchaînent sur des univers consécutifs (le premier garde son
  univers de départ), adresse 1, et le mode DMX est mis en cohérence avec le
  type de LED (Multi RGB / Multi RGBW, 170 ou 128 px par univers). Rien n'est
  écrit : les champs sont remplis, on vérifie, on Enregistre.
- **Profils de LED** (`led-profiles.json`, dans le showfile) : un nom pour ce
  qu'on branche (type, ordre, pixels). Sur une ligne de sortie, choisir le
  profil remplit type, ordre et pixels ; « enregistrer cette ligne comme
  profil » en crée un ; « gérer » les supprime. API `/api/led-profiles`. Le
  node **se souvient du profil de chaque sortie** : suffixe de son MQTT client
  id (`WLED-41686c#p..0a` = sortie 2 sur le profil `0a`, deux caractères par
  sortie, `..` = aucun), relu à chaque config ; sans mémoire, Fleet présélectionne
  le profil dont type, ordre et pixels correspondent exactement à la ligne.
- **Sorties non utilisées** : la case « Sortie N » décochée marque une sortie
  qui existe dans WLED mais n'est pas branchée (grisée, hors conflits). Le
  marqueur est stocké **sur le node**, en suffixe de son MQTT device topic
  (`wled/41686c#u2.4` = sorties 2 et 4 non utilisées) : inert tant que MQTT
  est désactivé, toujours un topic valide sinon, relu à chaque config.

Onglet **Sorties / DMX** (`GET /api/dmx-plan`, `derived.dmx` par node).
**Éditeur de sorties** par node : pin, type de LED, ordre des couleurs, index
de départ, longueur, sens, « + sortie », et l'adresse console univers.canal de
chaque sortie recalculée en direct pendant la saisie. « Enregistrer les
sorties » renvoie le bloc `hw.led.ins` complet (WLED le reconstruit ; les
champs non édités d'une sortie existante sont conservés) après une sauvegarde
automatique de la flotte. Endpoint : `POST /api/node/:ip/outputs {ins}`.
Dans WLED l'univers d'une sortie **n'est pas un réglage** : il découle du point
de départ du node (`dmx.uni` / `dmx.addr`) et de la longueur des sorties qui
précèdent. **≡ 1 univers par sortie** allonge chaque sortie à un multiple de
170 px (128 en RGBW) pour qu'une sortie = un univers entier ; les pixels en
trop n'existent pas physiquement (`POST /api/node/:ip/align-outputs`).
**Sorties non comptées** (case « sortie N » décochée) : purement visuel dans
Fleet, rien n'est écrit sur le node. Une sortie qui existe dans WLED mais
n'est pas câblée est grisée et les univers qu'elle est seule à occuper sont
exclus de la détection de conflits (mémorisé dans `known-nodes.json`,
`POST /api/node/:ip/outputs-ignore {starts}`). Le reste de l'onglet : en mode
Multi (RGB / DRGB / RGBW), WLED enchaîne les pixels sur des univers
consécutifs à partir de `dmx.uni` / `dmx.addr`, 170 pixels RGB (510 canaux)
ou 128 RGBW par univers. Une sortie physique de 160 px ne tombe donc jamais
sur une frontière d'univers : la 2ᵉ liane commence au canal 481 du premier
univers et finit au canal 450 du suivant. L'onglet donne, par node, l'adresse
console (univers.canal) du premier et du dernier pixel de chaque sortie, le
contenu de chaque univers, le nombre d'univers consommés, et signale les
**conflits** (deux nodes écoutant le même univers). Règle de patch : une
fixture continue par node à `uni.addr`, ou chaque sortie exactement à
l'adresse indiquée ; jamais « un univers par sortie ».

## Identifier, et les trois noms d'un node

- **💡 Identifier** (bouton par ligne, ou « 💡 Identifier » sur la sélection /
  tous les nodes en ligne) : blanc plein 3 s puis retour exact à l'état
  précédent. Utilise `lor:1` (live override) pour passer devant un flux
  E1.31 / DDP, puis renvoie le `/json/state` sauvegardé. Rien n'est écrit en
  flash. Endpoint : `POST /api/node/:ip/identify {ms}`.
- WLED range **trois noms** sur deux pages : `id.name` (page UI, le nom
  affiché), `id.mdns` (page WiFi Setup) et `ap.ssid` (page WiFi Setup, le nom
  de l'AP de secours, celui que l'on voit à l'appairage). Ils ne se suivent
  pas : un node préparé depuis la config d'un autre garde le nom du donneur.
  La grille marque en orange (≠, bulle explicative) les nodes discordants ;
  **≡ unifier** met mDNS (forme d'hôte : minuscules, tirets ; WLED 16 refuse
  les tirets bas) et SSID de l'AP au nom du node, ou à un nouveau nom, puis
  redémarre. Colonne « SSID de l'AP » ajoutée dans Identité (modifiable, ⟳).
  Endpoint : `POST /api/node/:ip/unify {name?, reboot}`.
- À l'appairage : colonne **Nom du node**, pré-remplie avec le nom d'origine
  une fois lu par Vérifier (vide = inchangé, modifié = renommé), et case
  **unifier** (cochée) qui aligne mDNS et AP sur ce nom. La charge exacte
  envoyée est écrite dans le journal d'appairage (`pairing.log`, mot de passe
  masqué).

## IP des nodes et identité par MAC

- Colonne **IP fixe** modifiable dans la grille : une IP libre (passerelle
  `.1` et masque `/24` déduits) ou `DHCP`, puis Déployer. Le serveur réécrit
  `ip/gw/sn` du premier profil Wi‑Fi (bloc `nw.ins` renvoyé sans le mot de
  passe, que WLED conserve), redémarre le node et **déplace sa ligne** à la
  nouvelle adresse. En DHCP, un scan repart 20 s plus tard.
- **Identité par MAC** : après chaque relevé réussi, un node dont la MAC est
  déjà connue sous une autre IP (renouvellement DHCP, changement d'IP fixe,
  rapatriement) fusionne avec cette ancienne ligne : pas de doublon, l'ancienne
  entrée disparaît, le journal note « ip : ancienne → nouvelle ».
- **⧉ navigateur** ouvre l'interface dans le navigateur par défaut de Windows
  (`POST /api/open`, le serveur lance `start`). Depuis la fenêtre native, tous
  les liens externes (interface WLED d'un node, GitHub, routeur) passent par
  là : la WebView ne peut pas ouvrir de fenêtre elle-même. « ⧉ fenêtre »
  ouvre l'onglet courant seul dans le navigateur.

## Nodes hors ligne et lignes fantômes

`known-nodes.json` garde pour chaque node ses **dernières infos connues**
(info, état, cfg, dernière réponse) : un node éteint ou parti sur un autre
site garde sa ligne complète, grisée, avec « vu il y a ». **Purger
hors‑ligne** (barre d'outils) retire d'un coup tous les nodes hors ligne de la
liste ; le ✕ en bout de ligne le fait pour un seul. Ils réapparaissent au
prochain scan s'ils répondent. Endpoint : `POST /api/nodes/purge`.

## Confirmations

Plus de boîte de dialogue native : toute action à confirmer ouvre un **petit
rectangle ancré au clic** (`confirmBox()`), avec le résumé, un bouton
« Annuler » et un bouton coloré portant le verbe de l'action : **rouge** pour
retirer / supprimer / abandonner / purger, **orange** pour écrire, flasher,
redémarrer, appairer, appliquer, **vert** pour le reste. Cliquer à côté ou
Échap annule, Entrée confirme.

## Onglets

La page est organisée en onglets pleine hauteur : **Grille · Journal ·
Antenne · Mises à jour · Appairage · Sauvegardes · ⚙ Réglages**. Un seul
onglet à la fois, rien ne s'empile sous la grille. Les badges (modifs
externes non vues, MAJ disponibles, clients Wi‑Fi) restent sur les onglets.
L'onglet courant est mémorisé et reflété dans l'URL (`#tab=antenne`).
**⧉ fenêtre** ouvre l'onglet courant dans une fenêtre séparée sans barre
d'onglets (`?solo=1#tab=…`), pratique pour garder l'Antenne ou le Journal sur
un second écran. Dans l'onglet Antenne, le Diagnostic est replié derrière une
ligne de synthèse (nombre de points ▲ / ℹ).

## Grille

- **Édition en brouillon** : clic sur une cellule ✎, Entrée met la valeur *en
  attente* (cellule bleue). Rien n'est envoyé aux nodes avant le bouton
  **Déployer N changements → M nodes**, qui récapitule et demande confirmation.
  **Annuler** jette tout le brouillon. Les échecs restent en attente.
- **Journal des modifications** (bouton Journal, tiroir en bas) : chaque poll
  est comparé au précédent sur les colonnes de réglage ; toute différence est
  consignée avec avant/après et sa source : `grille` (envoyée d'ici),
  `externe` (interface WLED, autre outil, preset…) ou `statut`
  (node apparu/disparu). Une modif externe déclenche une alerte, un badge sur le
  bouton Journal et un liseré orange sur la cellule pendant 10 min (vert pour
  une modif faite d'ici). Persisté dans `changes.log` (JSONL, ignoré par git).
  Délai de détection : ~3 s pour l'état, ≤ 20 s pour cfg.json
  (`--cfg-interval`). Les métriques volatiles (RSSI, FPS, heap…) ne sont pas
  journalisées (`watch: false` dans columns.js).
- **Vue easy par défaut** : 20 colonnes, ce qu'un show demande (nom, IP, groupe,
  IP fixe, univers, adresse, mode DMX et ses options : skip séquence, multicast,
  timeout ; pixels, sorties, limite mA, brightness et brightness au boot, allumé,
  preset, RSSI, version, MAJ dispo). 💡 à côté de la pastille d'état = identifier
  le node. Chaque groupe de colonnes a une teinte de fond discrète (reprise sur
  sa puce dans la barre Colonnes). La case « toutes les colonnes » (ou le clic
  droit sur un en-tête) donne la vue brute : les 71 colonnes avancées
  (`adv: true` dans columns.js) et la colonne Actions ; en vue easy ces actions
  (redémarrer, cfg.json, retirer) sont dans le menu clic droit. Mémorisé dans
  le navigateur.
- Groupes de colonnes activables, dans l'ordre de lecture : Identité (qui) ·
  Santé (vivant ?) · Réseau (connecté comment) · LEDs (pilote quoi) · Live (ce
  que la console envoie) · Sync · État (maintenant) · Défauts (au boot) · MAJ
  (maintenance firmware). Mémorisé dans le navigateur.
- **En-têtes façon Excel** : glisser un en-tête pour réordonner les colonnes
  (les colonnes Nom et IP restent épinglées à gauche et visibles pendant le
  défilement horizontal), tirer son bord droit pour la redimensionner,
  **double-clic sur le bord = ajuster au contenu**, clic pour trier, **clic
  droit = menu** (ajuster cette colonne ou toutes au contenu, largeurs par
  défaut). Ordre et largeurs mémorisés ; « ↺ colonnes » remet tout par défaut.
- **Ordre manuel des lignes** : la poignée à points en début de ligne se
  saisit et se glisse (la ligne se soulève, les autres glissent pour laisser
  la place, défilement automatique près des bords) ; relâcher écrit l'ordre,
  mémorisé par identité de node (MAC). Le ≡ de l'en-tête active l'ordre manuel
  à partir du tri courant ; cliquer un en-tête revient à un tri par colonne.
- **Groupes de nodes en arborescence** (zone, type, plateau…) : une ligne de
  groupe dans la grille, ses nodes dessous, ▾ replie / déplie (mémorisé), la
  case de la ligne de groupe coche tous ses nodes. Un node change de groupe en
  le glissant sous une autre ligne de groupe (ou en éditant sa colonne
  « Groupe », avec suggestions). Les nodes sans groupe sont sous « Sans
  groupe » ; sans aucun groupe la grille reste plate. **Le groupe est stocké
  sur le node lui-même**, dans son « Group topic » MQTT (Sync Interfaces >
  MQTT, `cfg.if.mqtt.topics.group`) : champ natif WLED, texte libre de 32
  caractères, sans effet tant que MQTT est désactivé (et cohérent si on
  l'active : un message au topic du groupe touche tout le groupe) ; `wled/all`
  (le défaut) = sans groupe. L'écriture est immédiate (pas de Déployer),
  journalisée, et demande que le node réponde ; renommer ou supprimer un
  groupe réécrit chaque node membre, les hors-ligne sont signalés et gardent
  l'ancien nom. La copie locale (`known-nodes.json`, showfile) ne sert qu'aux
  nodes dont la config n'a pas encore été lue. Un groupe peut exister vide
  (« Nouveau groupe (vide) »), la liste des groupes déclarés reste locale.
- **Clic droit contextuel** (le menu du navigateur est désactivé partout sauf
  dans les champs de texte) : sur une cellule ou une sélection (une cellule
  hors sélection devient la sélection) = **Groupe ▸** sous-menu avec « Non
  groupé » en premier, les groupes existants (✓ sur l'actuel) et « Nouveau
  groupe… », puis **valeur par défaut WLED** pour les cellules sélectionnées
  (colonnes qui documentent leur défaut, `def` dans columns.js ; mise en
  attente, rien n'est envoyé avant Déployer) et retirer les nodes de la
  liste ; sur une ligne de groupe = cocher, replier / déplier, tout replier /
  déplier, renommer, supprimer (ses nodes restent, sans groupe) ; dans le
  vide, et seulement là = nouveau groupe vide, ajuster toutes les colonnes ;
  sur un en-tête = largeurs.
- **Aide au survol** partout : chaque en-tête et chaque cellule expliquent le
  réglage (texte `help` dans columns.js), s'il est modifiable et où il est
  écrit ; les boutons, groupes et panneaux ont aussi leur bulle.
- **Surligner les écarts** : dans chaque colonne, les cellules qui diffèrent de
  la valeur majoritaire sont teintées → repère immédiat d'un node mal réglé.
- Sélection de cellules comme dans Excel : clic = une cellule, cliquer-glisser
  ou Maj+clic = rectangle, Ctrl+clic = ajouter / retirer, flèches et Tab
  déplacent la cellule active (Maj+flèches étendent), Échap désélectionne. Le
  texte de la grille n'est pas sélectionnable (un glisser sélectionne des
  cellules, pas du texte).
- Édition : Entrée, F2, double-clic, ou taper directement sur la cellule
  active ✎ (le texte tapé remplace la valeur). Entrée valide et descend d'une
  ligne, Échap annule, cliquer ailleurs ferme l'éditeur sans valider. Si
  plusieurs cellules d'une même colonne sont sélectionnées, valider propose de
  remplir toute la sélection de la colonne : même valeur, ou incrémentale
  (univers, dernier octet d'IP, suffixe numérique du nom) depuis la ligne
  éditée.
- Les cases à cocher restent la sélection de *lignes* pour les actions
  (identifier, préréglage show, mise à jour) ; sans cellules sélectionnées, une
  édition sur une ligne cochée propose aussi le remplissage sur les lignes
  cochées.
- Tri par colonne, filtre texte, masquage des hors‑ligne.
- **Copier pour Excel** (TSV dans le presse‑papier) et **Exporter CSV**.
- ⬇ cfg : télécharge le cfg.json du node (sauvegarde).

## Mises à jour (dépôt hors-ligne + OTA)

Bouton **Mises à jour** (badge = nombre de nodes qui ont une MAJ disponible).
Deux moitiés, séparées exprès :

1. **Dépôt hors-ligne** (`firmware.js`, dossier `firmware/`, ignoré par git).
   « Rafraîchir depuis GitHub » interroge les releases de `wled/WLED` et
   mémorise le catalogue dans `firmware/index.json` (donc consultable sans
   internet ensuite). Les .bin se téléchargent à l'unité (⬇) ou en un clic
   « ⬇ pour la flotte » = uniquement les plateformes présentes dans la flotte
   (`ESP32_Ethernet`, `ESP32-S3_4M_qspi`…). Une fois sur disque ils sont
   marqués **✓ hors ligne**. On peut aussi glisser un .bin perso (build maison,
   fork constructeur) nommé `WLED_<version>_<plateforme>.bin` ; il apparaît
   sous la release « local ».
2. **Flotte ↔ dépôt** : pour chaque node, plateforme (= `info.release`),
   version, dernière stable connue pour cette plateforme, statut
   (`à jour` / `MAJ à télécharger` / `MAJ prête` / `plateforme inconnue`),
   verrou OTA, et marqueur **fork** si `info.repo` n'est pas `wled/WLED`
   (ex. GLEDOPTO : le firmware officiel peut ne pas convenir au matériel).

### Workflow d'une mise à jour

1. Rafraîchir le catalogue (une fois, avec internet), télécharger
   « pour la flotte » la release voulue.
2. Choisir la **cible** (liste des releases ayant au moins un .bin local),
   cocher les nodes (seuls ceux en ligne, non verrouillés, et dont le .bin
   de plateforme est local sont cochables ; le survol explique pourquoi sinon).
3. **Mettre à jour la sélection** → récapitulatif node par node → confirmation.
4. Le serveur flashe depuis le fichier local, par le même mécanisme que
   l'interface WLED (`POST /update` multipart). Le sélecteur à côté du bouton
   fixe le parallélisme : **1 à la fois** par défaut (en Wi‑Fi les uploads se
   partagent l'antenne, un upload trop lent finit en timeout côté ESP32),
   2, 4, ou **tous en même temps** pour des nodes Ethernet. Aussi réglable au
   lancement avec `--ota-parallel N`.
   - barre **envoi xx %** (octets réellement acceptés par le node, ~10-30 s
     en Wi‑Fi),
   - **redémarrage… Ns** (barre orange, le node ne répond plus),
   - **✓ 16.0.0 → 16.0.1** dès que `/json/info` répond avec la nouvelle
     version (jusqu'à 150 s d'attente, sinon `pas revenu`).
   Une ligne « mise à jour en cours : X terminé(s), Y restant(s) » résume le
   lot ; le changement de version est journalisé avec la source `maj`.

Garde-fous côté serveur : refus si le .bin n'est pas local, si sa plateforme
ne correspond pas à celle du node, si OTA lock est actif, ou si une MAJ est
déjà en cours sur ce node.

## Sauvegardes de la flotte (hors ligne, export / import / restauration)

Bouton **Sauvegardes**. Module `snapshots.js`, dossier `snapshots/` (ignoré
par git, un fichier JSON par sauvegarde).

- **Sauvegarder la flotte maintenant** : pour chaque node en ligne, lit
  `cfg.json` (`GET /json/cfg`) et `presets.json` (`GET /presets.json`), plus
  identité (nom, MAC, IP, version, plateforme) et état. Journalisé.
- **⬇ Exporter** : télécharge le fichier JSON (à archiver, envoyer, versionner).
  **⬆ Importer** : recharge un fichier exporté, d'ici ou d'un autre PC.
- **Comparer** : sauvegarde ↔ nodes actuels, réglage par réglage (colonnes cfg
  et state du catalogue + sorties LED), avec correspondance par **MAC** puis IP
  (un node qui a changé d'IP est retrouvé).
- **Restaurer…** : choix des nodes (seuls les nodes présents et en ligne sont
  cochables), de ce qu'on renvoie (`cfg.json`, `presets.json`), option
  « garder le réseau du node » (par défaut : le Wi‑Fi / Ethernet / IP fixe
  actuels du node sont conservés, on ne pousse jamais le réseau d'un autre
  node par accident) et redémarrage. Mécanisme identique à la page
  Sécurité > Backup & Restore de WLED : `POST /upload` du fichier dans le
  système de fichiers du node, puis `{"rb":true}`. Un node à la fois,
  résultat par node, journalisé en source `restauration`.

## Antenne (MikroTik RouterOS, lecture seule)

L'onglet tient en peu de lignes : un en-tête (modèle, RouterOS, canal, clients
dont nodes, heure du relevé), une rangée de boutons (Scanner l'environnement,
📡 WiFiman, ★ Optimisation avec le nombre de réglages proposés), le diagnostic
seulement s'il y a un avertissement (une ligne par point, détail au survol),
puis **un seul bloc Environnement radio** : le verdict (canal recommandé contre
le canal actuel) avec le bouton « Passer au canal N », une bulle ⓘ qui porte
toute la légende, le graphe 2,4 GHz avec la bande d'occupation des 13 canaux
nichée au-dessus sur le même axe (vert = libre, rouge = chargé, cadre bleu =
ton canal, cadre vert = recommandé), et en replié : 5 GHz, la liste des réseaux
voisins. **La source est le Wizard dès qu'il est connecté** (en direct, sur la
dernière minute, avec le signal de l'antenne reçu à l'endroit du boîtier),
sinon le dernier scan de l'antenne (5 s de coupure radio). Le reste est replié :
« Radios et clients », « Routeur, antennes et identifiants », « Options WiFiman
Wizard ». Les relevés, la cascade et la comparaison antenne / Wizard ne sont plus
affichés (le serveur les garde : `/api/wizard/surveys`, `/waterfall`).

Bouton **Antenne**. Module `ap.js`, Phase 3 de la roadmap (monitoring d'abord,
jamais de contrôle automatique).

- **Découverte sans identifiants** : le serveur écoute les annonces MNDP
  (MikroTik Neighbor Discovery, UDP 5678) et affiche identité, carte,
  version RouterOS et IP de chaque MikroTik du réseau.
- **Identifiants, un jeu par antenne** : dans le panneau, chaque antenne
  découverte a un bouton « Identifiants… » qui pré-remplit le formulaire
  (IP, utilisateur, mot de passe) ; « Enregistrer et connecter » écrit
  `ap.json` (ignoré par git, format `{active, aps: {host: {user, pass}}}`) et
  se connecte sans redémarrage. Une antenne déjà enregistrée se reconnecte
  d'un clic (« Connecter ») sans retaper le mot de passe ; « ✕ » l'oublie.
  Alternative : `--ap 192.168.88.1 --ap-user admin --ap-pass …` au lancement.
  Un utilisateur RouterOS du groupe `read` suffit. Sur un MikroTik neuf, le mot
  de passe d'usine est imprimé sur l'étiquette du boîtier ; il n'existe aucun
  moyen de lire l'API sans lui. Le serveur interroge l'API REST (`/rest/...`,
  HTTP basic) toutes les 5 s :
  - `system/resource` → carte, version, uptime, CPU, RAM ;
  - `interface/wifi` + commande `monitor` → radios, SSID, canal
    (fréquence/standard/largeur), puissance TX, clients par radio ;
  - `interface/wifi/registration-table` → clients : MAC, radio, signal reçu
    par l'antenne, débits TX/RX, durée d'association, paquets.
- **Corrélation par MAC** : chaque client dont la MAC est celle d'un node
  WLED est reconnu ; le groupe de colonnes **Antenne** de la grille montre,
  par node, la radio, le canal, le signal côté antenne (à comparer au RSSI
  côté node), les débits et la durée d'association. Les nodes Ethernet ou sur
  une autre antenne sont « non vus ».
- **Diagnostic automatique** (bloc en tête du panneau, recalculé à chaque
  relevé, `ap.js audit()` + constats croisés antenne/nodes dans `server.js`) :
  canal chevauchant, largeur, puissance vs limite légale, 802.11r, WPA3,
  multicast-enhance, taux d'erreurs de trames par radio, clients faibles ou à
  bas débit sous charge, radio 5 GHz coupée, horloge sans NTP, nodes à
  firmware Ethernet mais associés en Wi‑Fi, signal asymétrique node ↔ antenne.
  Chaque ligne dit quoi changer dans RouterOS ; rien n'est appliqué.
- **Environnement radio** (bouton « Scanner l'environnement », 3/5/10 s) :
  la seule action qui perturbe le Wi‑Fi. RouterOS quitte le canal pendant le
  scan, les clients décrochent et se réassocient seuls (WLED : ~5 s). Résultat :
  réseaux voisins dédoublonnés (SSID, BSSID, canal, signal, largeur, standard,
  sécurité, clients), **occupation pondérée par canal 1‑13** (chaque voisin
  pollue son canal et ±4 canaux en 20 MHz, ±6 en 40 MHz, pondéré par sa
  puissance), et **canal recommandé** parmi 1 / 6 / 11. Le canal 13 est
  affiché mais jamais recommandé : beaucoup d'ESP32 tournent avec le profil
  pays « monde » du SDK (canaux 1‑11) et ne voient pas un AP en 12/13.
  Historique dans `rf-scans.log`. Endpoints : `POST /api/ap/scan {iface,
  duration}`, `GET /api/ap/scans`.
- **Appliquer le canal** (deux boutons sous l'histogramme) : la seule écriture
  sur le routeur, sur confirmation. « Appliquer le canal N » fixe
  `channel.frequency` sur la fréquence recommandée ; « Laisser l'antenne
  choisir parmi 1 / 6 / 11 » écrit `2412,2437,2462` et RouterOS re-sélectionne
  lui-même (il le fait déjà, mais dans sa plage d'usine 2446‑2468 qui ne
  contient que des canaux chevauchants). PATCH REST sur l'interface, journalisé
  en source `sauvegarde`/antenne, la radio redémarre et les clients se
  réassocient. Endpoint : `POST /api/ap/channel {iface, spec}`.
- **Onglet Optimisation** : les préréglages show des deux côtés avec l'état
  réel. *Antenne* (`GET/POST /api/ap/preset`, liste blanche de clés) :
  proposés = 802.11r off (`security.ft`, `ft-over-ds`) et plage de canaux
  1/6/11 (`channel.frequency`) ; facultatifs, décochés = WPA2 seul, PMF
  désactivé, DTIM 1 (préventifs, inutiles tant que tout s'associe) ; déjà
  bons = 20 MHz, multicast-enhance. Cocher puis appliquer = un PATCH, la
  radio redémarre ~10 s. *Nodes* : veille Wi‑Fi = non, puissance TX =
  19,5 dBm, saut des paquets hors séquence = oui, par node avec ✓/▲ ;
  « Mettre en attente » puis « Déployer ». Plus un mémo placement (puissance
  déjà au maximum légal, hauteur, vue directe, réception côté node). Le bouton
  ★ Préréglage show de la grille fait la même mise en attente. Colonnes
  ajoutées dans Réseau : Veille Wi‑Fi, Puissance TX, Forcer 802.11g.
- Cible testée : wAP ax (`wAPG-5HaxD2HaxD`), RouterOS 7.16 avec le paquet
  `wifi`.

## Appairage de nouveaux nodes (`provision.js`)

Bouton **Appairage**. Un WLED sans réseau configuré ouvre son propre point
d'accès (« WLED-AP », clé `wled1234` ; ou son nom si le node a déjà été
baptisé, ex. `PIXY_LIANA_011`). Le module utilise la **carte Wi‑Fi du PC**
(Windows, `netsh wlan`) :

1. « Scanner » : **scan natif** de tous les canaux par l'API WLAN de Windows
   (`WlanScan`, `tools/wlan-scan.ps1`), comme NetSpot : ~4 s, sans couper le
   Wi‑Fi. Résultat fusionné avec ce que l'antenne a vu dans les 15 dernières
   minutes ; chaque réseau vu par le PC est mémorisé 3 min (un AP WLED balise
   lentement, un scan peut le rater : il reste listé « vu il y a N s »).
   **Radar 8 s** : rescanne en continu avec l'historique du signal de chaque
   réseau (mini-courbe). « Scan hors connexion » (dernier recours) coupe le
   Wi‑Fi ~10 s puis se reconnecte.
   **Identification** (le nom d'un réseau n'est jamais un critère, juste un
   indice affiché) :
   - **autre appareil** : préfixe MAC (OUI) hors du registre IEEE d'Espressif
     (`tools/espressif-oui.json`, 344 préfixes extraits de `oui.csv`). WLED
     ne tourne que sur ESP32/ESP8266 : ce n'est pas un WLED, exclu par défaut.
   - **Espressif · probable** : puce Espressif, WLED possible mais pas prouvé.
   - **AP de <nom>** : BSSID = MAC + 1 d'un node déjà dans la flotte (softAP
     ESP32) : son AP de secours, pas un nouveau node.
   - **✓ WLED <version>** : prouvé par **Vérifier** : le PC rejoint l'AP ~20 s,
     lit `/json/info` en 4.3.2.1 (marque, version, MAC), revient, rien n'est
     écrit. Résultat mémorisé pour la session.
   Le bouton Appairer reste actif partout (confirmation supplémentaire pour
   un « autre appareil »).
2. La liste ne montre que les WLED (case « tous les réseaux » pour le
   reste). Chaque ligne : clé de l'AP (`wled1234`, vide si ouvert), **IP
   proposée** (libre, vérifiée, dans la suite des nodes existants :
   `.241..243` → `.245`…), et un bouton **Appairer**. Rien d'autre.
3. Le **réseau du show** (SSID + mot de passe) est lu sur l'antenne MikroTik
   (`security.passphrase` de la radio 2,4 GHz) : personne ne le tape, il ne
   transite que du serveur vers le node. Sans antenne configurée, l'appairage
   est impossible (message clair).
4. « Appairer » : le PC rejoint l'AP du node, `POST /json/cfg` avec
   `nw.ins[0]` = SSID / psk / IP fixe **uniquement** (le node garde son nom,
   jamais renommé), `{"rb":true}`, retour du PC sur son Wi‑Fi, suppression du
   profil temporaire ; le node est ajouté à la flotte 45 s plus tard. Journal
   en direct dans le panneau. Un appairage à la fois.

**PC relié en Wi‑Fi seulement** (cas normal en tournée) : pendant un
appairage ou une recherche approfondie, la carte Wi‑Fi quitte le réseau du
show, donc antenne et nodes sont injoignables 20 à 40 s. Le serveur ouvre
alors une **fenêtre de maintenance** : relevés des nodes et de l'antenne en
pause (aucun node passé hors ligne, aucun bruit dans le journal), badge
« ⏸ … relevés en pause » en haut de page, puis reprise automatique dès que
le PC retrouve une adresse dans le sous-réseau de la flotte (le retour sur le
Wi‑Fi précédent est attendu explicitement). Le réseau du show lu sur l'antenne
est mémorisé pour rester utilisable pendant la coupure.

Le node doit être **à portée de la carte Wi‑Fi du PC** (pas seulement de
l'antenne). Si la carte Wi‑Fi est en **IP fixe**, l'AP du node ne peut pas lui
donner d'adresse 4.3.2.x : le module la passe en DHCP le temps de
l'appairage puis la remet à l'identique (IP, masque, passerelle). Windows
demande une élévation (UAC) pour chacun des deux changements ; un refus
annule l'appairage avec un message clair. Le panneau prévient à l'avance
quand la carte est en IP fixe. Endpoints : `GET /api/pair/networks[?deep=1]`,
`GET /api/pair/suggest?ssid=`, `POST /api/pair/test`, `POST /api/pair`,
`GET /api/pair/status`. Les anciens RouterOS (`interface/wireless`) ne sont pas encore gérés.

## API du serveur

```
GET    /api/fleet                 état complet (meta + info + state + cfg + derived par node)
GET    /api/columns               catalogue des colonnes (columns.js)
GET    /api/changes?since=<ms>    journal des modifications (événements plus récents que since)
GET    /api/snapshots             liste des sauvegardes
POST   /api/snapshots {name}      capture cfg.json + presets.json de tous les nodes en ligne
GET    /api/snapshots/:id[?download=1]   contenu (export en fichier)
POST   /api/snapshots/import      corps = fichier JSON exporté, en-tête X-Filename
GET    /api/snapshots/:id/diff    comparaison avec la flotte actuelle
POST   /api/snapshots/:id/restore {targets:[mac|ip], what:{cfg,presets,keepNetwork}, reboot}
DELETE /api/snapshots/:id
GET    /api/ap/raw?path=/interface/wifi   lecture brute RouterOS (GET seulement, arbres wifi/system/interface)
GET    /api/ap                    antenne : MikroTik découverts (MNDP), enregistrées (saved), système, radios, clients (isNode = MAC d'un node)
POST   /api/ap/config {host,user,pass}   enregistre les identifiants de CETTE antenne et s'y connecte
POST   /api/ap/connect {host}     bascule sur une antenne déjà enregistrée
POST   /api/ap/forget {host}      supprime ses identifiants
GET    /api/firmware[?all=1]      catalogue + état local + évaluation par node (all=1 : toutes plateformes)
POST   /api/firmware/refresh      interroge GitHub et met à jour firmware/index.json
POST   /api/firmware/download {tag, asset} | {tag, forFleet:true}
POST   /api/firmware/delete {tag, asset}
POST   /api/firmware/upload       corps = .bin brut, en-tête X-Filename
POST   /api/node/:ip/update {tag, asset}   met le node en file de flash (fichier local uniquement)
POST   /api/scan                  relance la découverte
POST   /api/nodes {ip}            ajoute une IP (host[:port])
DELETE /api/nodes/:ip             retire un node de la liste
GET    /api/node/:ip/cfg          cfg.json frais (téléchargement)
POST   /api/node/:ip/cfg {…}      relaie un JSON arbitraire vers /json/cfg (restauration)
POST   /api/node/:ip/cell {col, value}   écrit une cellule (voir columns.js)
POST   /api/node/:ip/reboot
```

## Architecture

```
server.js          découverte, polling, relais HTTP vers les nodes, API, statique
columns.js         catalogue des colonnes : chemin de lecture, type, chemin d'écriture
static/index.html  page (structure seule)
static/style.css   styles de la grille
static/app.js      logique de la grille (vanilla JS, aucune lib)
```

## Deux dépôts

Le développement se fait ici, dans le monorepo privé
`Tensegrity-Lighting-Service/WLED-Wireless-Orchestrator` (avec `ap-manager/` et
les autres outils). Les releases (installables, mises à jour) sortent sur
`Tensegrity-Lighting-Service/WLED-Fleet`, un dépôt **public** séparé, qui ne
contient jamais que ce dossier `wled-fleet/` — synchronisé par
`node tools/publish-to-github.js` (copie + commit + push, squashé, pas
d'historique fin conservé côté public ; jamais `settings.json` ni
`led-profiles.json`, spécifiques au lieu). Une session future (notamment sur
macOS) doit repartir d'ici, pas du dépôt public.

## Publier une release (manuel, comme Lumitrack)

Pas de release automatique en CI — un script local, comme Lumitrack
(`Tensegrity-Lighting-Service/lumitrack`) :

```sh
cd desktop
./build-release.cmd   # compile, synchronise le dépôt public, zippe, signe, écrit latest.json
gh release create v<version> ../release/WLED-Fleet_<version>_windows.zip \
  ../release/WLED-Fleet_<version>_windows.zip.sig ../release/latest.json \
  --repo Tensegrity-Lighting-Service/WLED-Fleet --title "WLED Fleet <version>"
```

Nécessite `cargo install tauri-cli --version "^2"` et la clé de signature
updater : `cargo tauri signer generate -w %USERPROFILE%\.tauri\wled-fleet-updater.key`
(une seule fois — mot de passe dans `wled-fleet-updater.pass` à côté, **les
deux fichiers vivent hors de tout dépôt** : les perdre = plus aucune app
installée ne pourra se mettre à jour automatiquement).

Le paquet publié est un `.zip` du dossier applicatif (pas un `.exe`
d'installation) — voir `desktop/src/main.rs` (`install_update`) : le plugin
`tauri-plugin-updater` vérifie la signature au téléchargement, puis l'app
extrait l'archive et remplace ses propres fichiers de code sur place.

## macOS (préparation, à finir depuis un Mac)

Le shell natif (`desktop/`) est un simple `cargo build --release` (pas de
bundler, pas d'installateur ici non plus) : `node` doit être sur le PATH,
avec un repli déjà en place (`/opt/homebrew/bin/node`, `/usr/local/bin/node`,
`desktop/src/main.rs`) pour les apps GUI lancées depuis le Finder, qui
n'héritent pas du PATH du shell. `icons/icon.icns` est déjà généré (`cargo
tauri icon` fonctionne depuis Windows). Reste à faire sur le Mac :

- `cargo build --release` dans `desktop/`, copier l'exe (`wled-fleet-desktop`)
  à côté de `server.js` sous un nom stable, comme sous Windows.
- Adapter `desktop/build-release.cmd` en équivalent shell (zip via `ditto -c -k
  --sequesterRsrc --keepParent` ou `zip -r`, signature via `cargo tauri signer
  sign`, `tools/make-latest-json.js` détecte déjà `darwin-x86_64`/
  `darwin-aarch64` selon `process.arch` et **fusionne** avec le `latest.json`
  déjà publié pour ne pas perdre l'entrée `windows-x86_64`).
- Non signé/notarié : premier lancement → clic droit → Ouvrir, ou
  `xattr -dr com.apple.quarantine WLED-Fleet` (même avertissement que
  Lumitrack, voir son `packaging/README.md`).
- CI déjà en place sur le dépôt public (`.github/workflows/ci.yml`, job
  `rust-macos`) : compile déjà sous macOS avant que tu t'y mettes.

## Suite (roadmap Phase 1)

- Sauvegarde/restauration versionnée des cfg.json, clone entre nodes
- Édition des sorties LED par écriture du bloc `hw.led` complet
- Découverte mDNS (`_wled._tcp`) en complément du scan
- Historique RSSI / FPS / latence pour la corrélation RF (Phase 3)
