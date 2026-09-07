# WiFiman Wizard — protocole BLE (phase 0, découverte)

Notes de travail pour brancher le WiFiman Wizard d'Ubiquiti (WM-W) sur
wled-fleet. Le protocole n'est **pas public** : cette page se remplit au fur et
à mesure de la découverte. Rien ici n'est copié du code d'Ubiquiti ; on décrit
seulement ce que l'appareil qu'on possède envoie et reçoit, pour interopérer.

## Ce qu'on sait déjà (sources publiques)

| Sujet | Fait | Source |
|---|---|---|
| Puce | MediaTek **MT7931AN** : SoC Wi-Fi 6 1x1 double bande + BLE 5, Cortex-M33, flash Winbond | photos internes du dossier FCC `SWX-WMW` (rapport Cerpass 22050245, juillet 2022) |
| Radio Wi-Fi | réception seule : le dossier FCC ne teste que le BLE en émission (2402-2480 MHz, 9 mW) | fccid.io/SWX-WMW |
| Antennes | 3 dBi (2,4 GHz), 2,5 dBi (5 GHz), 1x1 : profil proche d'un téléphone / d'un ESP32 | datasheet du dossier FCC |
| Données | scanner 802.11 : SSID, BSSID, canal, largeur, RSSI par AP (-96 à 0 dBm, pas de 1 dBm) ; pas d'export dans l'app ; **pas** un analyseur spectral (ne voit pas le bruit non Wi-Fi) | techspecs.ui.com, prise en main cyber-fi.net (2024) |
| Batterie | Li-ion 3,7 V 300 mAh, ~4 h de scan, USB-C | techspecs.ui.com |
| App | WiFiman iOS ≥ 0.18.0 / Android ≥ 1.15.0 (`com.ubnt.usurvey`) ; firmware du Wizard mis à jour par l'app | techspecs.ui.com |
| Reset | bouton reset usine sous le capot silicone ; LED blanche / bleue | datasheet |

## Outils

- `tools/wizard/wizard_probe.py` : scan BLE, connexion, dump GATT, lecture de
  tout ce qui est lisible, abonnement à toutes les caractéristiques
  notify/indicate, journal `wizard-probe.log` (une ligne JSON par événement).
  Option `--write <uuid> <hex>` pour rejouer une commande candidate.
- `tools/wizard/wizard_decode.py` : **le seul fichier à remplir** une fois le
  protocole compris (UUID, commande de démarrage, `parse_frame`). Il sait
  rejouer un journal de la sonde : `python wizard_decode.py wizard-probe.log`.
- `tools/wizard/wizard_bridge.py --address … --raw` : le bridge normal, mais il
  remonte aussi chaque notification brute en hexa (visible dans le journal du
  serveur si on le lance à la main).

## Méthode (sans téléphone Android)

1. **Énumération GATT depuis le PC Windows** (`wizard_probe.py`) : services et
   caractéristiques, valeurs lisibles (Device Information : fabricant, modèle,
   firmware), ce qui arrive spontanément en notification. Couper le Bluetooth
   de l'iPhone avant (une connexion BLE à la fois) ; si le Wizard refuse la
   connexion, l'oublier dans WiFiman ou faire un reset usine.
2. **Analyse statique de l'APK Android WiFiman** avec jadx (Java, tourne sous
   Windows, aucun téléphone Android requis) : chercher les UUID vus en 1,
   les classes « wizard », des définitions protobuf (Ubiquiti en utilise sur
   ses autres liaisons BLE) ou un framing TLV maison, la séquence qui lance le
   scan, la structure des résultats (BSSID, SSID, fréquence, largeur, RSSI,
   batterie, firmware). Noter ici, ne rien recopier dans le dépôt.
3. **Si 1 + 2 ne suffisent pas** (chiffrement applicatif, handshake) : capture
   réelle iPhone ↔ Wizard avec un dongle nRF52840 + nRF Sniffer + Wireshark
   (fonctionne sous Windows), ou PacketLogger sur un Mac.
4. Remplir `wizard_decode.py`, rejouer le journal de la sonde, puis valider en
   direct : mêmes BSSID et RSSI (± 3 dB) que l'app WiFiman sur l'iPhone au
   même instant, et que le scan de l'antenne MikroTik posé à côté.

Pour déboguer nos propres échanges PC ↔ Wizard : Bluetooth Virtual Sniffer
(`btvs.exe`, Windows SDK) + Wireshark.

## Relevés

### Annonces BLE (advertising)

Relevé du 5 septembre 2026, PC Windows 11, adaptateur Intel, `wizard_probe.py`,
Wizard firmware 1.9.0 (SKU EU).

| Champ | Valeur |
|---|---|
| Adresse | `74:FA:29:30:C0:38`, **publique et fixe** (OUI `74:FA:29` = Ubiquiti Inc.) |
| Nom annoncé | `FF:FF:FF:FF:FF:FF` (un espace réservé, pas le vrai nom ; probablement l'identifiant du téléphone « adopté », vide ici) |
| Nom GAP (lu après connexion) | `UWS-038` |
| UUID de service annoncé | `e0373cc2-d3bc-4eac-9c6e-423d0fe5d738` (128 bits) |
| Données constructeur | aucune |
| Puissance vue | -21 dBm posé à côté du PC (annonce assez espacée : `find_device_by_address` de bleak le rate souvent sous WinRT, un `discover()` de 10-20 s le voit) |

Conséquence : `wizard_probe.py` / `wizard_bridge.py` reconnaissent le Wizard par
l'OUI Ubiquiti et par cet UUID de service, pas par le nom.

### Table GATT

Sortie de `wizard_probe.py --address 74:FA:29:30:C0:38`, MTU négociée **512**.

| Service | Caractéristique | Handle | Propriétés | Valeur lue / rôle |
|---|---|---|---|---|
| `1801` Generic Attribute | `2a05` Service Changed | 2 | indicate | abonnement refusé (« Access Denied ») |
| `1800` Generic Access | `2a00` Device Name | 6 | read | `UWS-038` |
| | `2a01` Appearance | 8 | read | `0x1234` |
| | `2a26` Firmware Revision | 10 | read | `1.9.0` |
| `db6930ca-0b3e-4af5-82d9-878279343e8e` | `9280f26c-a56f-43ea-b769-d5d732e1ac67` | 13 | write | commandes (service secondaire, même paire de caractéristiques) |
| | `d587c47f-ac6e-4388-a31c-e6cd380ba043` | 15 | read, notify | lu : `12 34` |
| **`e0373cc2-d3bc-4eac-9c6e-423d0fe5d738`** (annoncé) | `9280f26c-a56f-43ea-b769-d5d732e1ac67` | 19 | **write** | **commandes** |
| | `d587c47f-ac6e-4388-a31c-e6cd380ba043` | 21 | **read, notify** | **réponses / flux** ; lu : `12 34` |
| | `dc272a22-43f2-416b-8fa5-63a071542fac` | 24 | read | JSON d'identité : `{"id":"74fa2930c038","fwv":"1.9.0","apiVersion":"1.0","bv":255,"sku":"EU"}` |

Pas de service Device Information `180a` ni Battery `180f` : le firmware est
dans le GAP (`2a26`) et l'identité dans la caractéristique JSON. `bv` vaut 255
sur batterie pleine / USB branché (à confirmer : niveau ou tension).

Rien n'arrive spontanément en notification pendant 45 s : le flux se déclenche
par une écriture sur `9280f26c`.

### Pile protocolaire (établie sur firmware 1.9.0, API 1.0)

Le Wizard parle un petit dialecte **HTTP sur BLE** (le lien générique
d'Ubiquiti pour ses produits provisionnés en Bluetooth) : des requêtes
`GET`/`POST` sur des chemins `/api/…` avec un corps JSON, des réponses avec un
code de statut, et des événements poussés par l'appareil. Le tout est emballé
dans trois couches binaires minces, sans chiffrement ni handshake :

| Couche | Format | Notes |
|---|---|---|
| message | en-tête JSON + corps | en-tête : `{"type":"httpRequest","id","timestamp","method","path","headers":{}}` pour une requête ; `{"type":"httpResponse","id","timestamp","statusCode"}` pour une réponse ; `{"type":"event","id","timestamp","name"}` pour un événement. `id` = identifiant libre repris dans la réponse (l'app compte à partir de `00000000-0000-0000-0000-000000000000`), `timestamp` en ms. Autres types du dialecte : `request`/`response`, `log`, `error` (`errorCode` 1001 type inconnu, 1002 non supporté, 1003 pas de requête, 1004 type incohérent), `cmd`/`cmdResponse` |
| conteneur « binme » | deux fragments `[kind u8][format u8][compression u8][0][longueur u32 BE][octets]` | `kind` 1 = en-tête, 2 = corps ; `format` 1 = JSON, 2 = chaîne, 3 = binaire ; `compression` 0 = aucune, 1 = zlib. L'app envoie sans compression, le Wizard répond sans compression (le décodeur sait dégonfler au cas où) |
| paquet | `[séquence u16 BE][protocole u8][binme]` | protocole 3 = message binaire (0 authentification, 1 gestion, 2 all-join : jamais vus). La séquence part de 0 et s'incrémente par paquet, chaque sens a la sienne |
| trame | `[longueur u16 BE, elle-même comprise][paquet]` | découpée en écritures ≤ MTU-3 sur `9280f26c` (write avec réponse) ; les notifications de `d587c47f` arrivent en morceaux de ≤ 509 octets à ré-assembler grâce à ce même préfixe |

Exemple, `GET /api/version` = trame de 165 octets :
`00a5 | 0000 03 | 01 01 00 00 0000008e {"type":"httpRequest",…} | 02 01 00 00 00000002 {}`.
MTU négociée 512 sous Windows (bleak / WinRT) ; pas besoin d'écriture
« longue », le Wizard ré-assemble les morceaux.

### API 1.0

Chemins sous `/api/1.0/<id>` où `<id>` est l'adresse BLE du Wizard en
minuscules sans séparateur (`74fa2930c038`, aussi dans la caractéristique
d'identité). Corps `{}` quand il n'y a rien à dire. Toutes les réponses vues
sont `statusCode` 200.

| Méthode | Chemin | Rôle | Réponse / corps |
|---|---|---|---|
| GET | `/api/version` (sans `<id>`) | version d'API, à vérifier avant tout | `{"fwv":"1.9.0","apiVersion":"1.0","annoid":"<uuid>"}` ; l'app refuse `apiVersion` ≠ `1.0` et un firmware < 0.2.0 |
| GET | `/api/1.0/<id>` | identité | `{"id","type":"UWS","hwType":"EU","fwv","bomId","proId","state":"app","name"}` (`name` vaut `FF:FF:FF:FF:FF:FF` tant que rien n'a été nommé) |
| GET | `…/stats` | batterie et lien | `{"powerSource":"battery"` ou `"pluggedIn","chargingState","battery":48,"batteryV":37.96,"isLowBattery":false,"uptime":s,"signalQuality":100,"signalDbm":-34}` (`batteryV` en dixièmes de volt) |
| GET | `…/fw` | état firmware | `{"hwv","fwv","fwId","buildId","ch","isUpdating","status","progressPercent","remainingTime"}` |
| GET / POST | `…/settings`, `…/settings/name`, `…/settings/led`, `…/settings/hwreset`, `…/settings/intervals` | réglages : nom, LED, blocage du reset, `autoSleepTime`, intervalles de stats | non utilisés : le chantier est passif |
| GET / POST | `…/bt` | paramètres de connexion BLE | `{"btMode":"fast","intervalMin":12,"intervalMax":12,"timeout":256,"latency":5,"enableLatency":true}`, poussé aussi en événement juste après la connexion |
| POST | `…/wifi/trigger_scan` | **démarre le balayage continu** | `{}` ; ensuite un événement `scan_done` par canal balayé, environ un par seconde, jusqu'à `stop_scan` ou déconnexion |
| POST | `…/wifi/stop_scan` | arrête le balayage (firmware ≥ 1.1.3) | `{}` |
| POST | `…/wifi/priority` | canaux prioritaires (liste) | non utilisé |
| GET | `…/wifi/get_scan_result` | **résultats du dernier canal balayé** | corps au format *binaire* (3) contenant du JSON écrit à la main par le firmware : une entrée par ligne et une **virgule finale** avant `]`, donc JSON non strict à tolérer |
| — | `…/locate`, `…/reboot`, `…/reset`, `…/fw/start`, `…/fw/data`, `…/fw/abort` | LED, redémarrage, reset usine, mise à jour | jamais appelés d'ici |

Événements (`"type":"event"`, `name` = chemin complet) : `…/scan_done` avec
`{"scan_done":"1"}` (chaîne, `"0"` = rien trouvé) ; `…/bt` ; `…/stats` et
`…/per_stats` (même forme que `GET …/stats`) ; `…/settings` ; `…/fw`.

Séquence de l'app, reproduite par `wizard_decode.Decoder` : `GET /api/version`
→ `GET /api/1.0/<id>` → `GET …/stats` → `POST …/wifi/trigger_scan` → à chaque
`scan_done` à 1, `GET …/wifi/get_scan_result` → fusion par BSSID (l'app
garde une entrée 20 s, `wizard.js` a son propre historique). Le bridge relance
`trigger_scan` s'il ne voit plus de `scan_done` pendant 30 s et envoie
`stop_scan` en se déconnectant.

### Format des résultats

```
{"scan_result":[
{"ssid":"WifiFlo","bssid":"94:83:c4:ab:b7:10","freq":"2437","ch":"6","ch_s0":"6","ch_s1":"0","sbw":"1","bw":"0","nss":"2","rssi":"-47","mcs":"11","tpc":"19","rtt":"0","ch_util":"0","sta_cnt":"0","std":"0x3d","akm":"0x4000002","cipher":"0x0010","sdr":"0x3fcf"},
]}
```

Toutes les valeurs sont des chaînes. Un lot = les AP entendus sur **un**
canal ; le Wizard parcourt les canaux 2,4 GHz puis 5 GHz, un par seconde.

| Champ | Sens | Décodage dans `wizard_decode.py` |
|---|---|---|
| `bssid`, `ssid` | AP ; `ssid` vide = réseau caché | tel quel, BSSID normalisé `aa:bb:…` |
| `freq`, `ch` | fréquence MHz, canal principal | entiers ; `band` = `2g` / `5g` / `6g` d'après la fréquence |
| `ch_s0`, `ch_s1` | canal central (segment 1, segment 2 pour 80+80) | `center` |
| `bw` | largeur : 0 = 20, 1 = 40, 2 = 80, 3 = 160, 4 = 80+80 MHz | `width` en MHz |
| `sbw` | largeur maximale supportée (même échelle) | ignoré |
| `rssi` | dBm | `signal`, rejeté hors de ]−100, 0[ |
| `nss`, `mcs`, `tpc`, `rtt` | flux spatiaux, MCS max, puissance annoncée, RTT 802.11mc | `nss` gardé, le reste ignoré |
| `ch_util`, `sta_cnt` | charge du canal 0-100 et stations associées (élément BSS Load) | `utilization` (0-1), `stations` |
| `std` | masque hexa des modes : bit 0 = g, 1 = a, 2 = n, 3 = ac, 4 = ax, 5 = be | `std` = bit le plus haut (`0x3d` → `be`, `0x1d` → `ax`, `0x05` → `n`) |
| `akm` | masque hexa des méthodes de gestion de clés, dans l'ordre des drapeaux `WPA_KEY_MGMT_*` de wpa_supplicant : bit 0 = 802.1X, 1 = PSK, 2-3 = aucune, 5 = FT-802.1X, 6 = FT-PSK, 7 = 802.1X-SHA256, 8 = PSK-SHA256, 9 = WPS, 10 = SAE, 11 = FT-SAE, 12-13 = WAPI, 15 = OSEN, 16-17 = Suite-B, 18-21 = FILS, 22 = OWE, 23 = DPP, 24 = FT-802.1X-SHA384, 25 = PASN, 26 = SAE-EXT-KEY | `security` : `0x0202` → `WPA2-PSK` (PSK + WPS), `0x0402` et `0x4000002` → `WPA2/3-PSK` (PSK + SAE), `0x0001` → `WPA2-EAP`, `0x0042` → `WPA2-PSK` (PSK + FT), `0` → `open`, SAE seul → `WPA3-SAE`, OWE → `OWE` |
| `cipher` | masque des chiffrements (`0x0010` = CCMP) | ignoré |
| `sdr` | masque des débits de base (`0x3fcf` = b/g complet, `0x3fc0` = OFDM seul) | ignoré |

### Comportement observé

- Annonces espacées, et le Wizard reste **invisible environ une minute après
  une déconnexion** : un `discover()` de 10 s le rate, une attente sur
  callback d'annonce (`wizard_decode.find_device`, jusqu'à 60-90 s) est
  fiable. `find_device_by_address` de bleak sous WinRT le rate presque toujours.
- Les deux services (`db6930ca…` et `e0373cc2…`) exposent les mêmes UUID de
  caractéristiques : bleak refuse l'UUID seul, il faut choisir la
  caractéristique dans le service annoncé (`resolve_char`).
- Batterie : environ −1 % par 5 minutes de balayage (48 % → 46 % pendant la
  session de découverte).
- Journal de la session de découverte (chaque notification en hexa) :
  `tools/wizard/wizard-probe.log` (ignoré par git), rejouable avec
  `python wizard_decode.py wizard-probe.log`.

## Décision go / no-go

- **Go (5 septembre 2026)** : protocole entièrement décodé et rejoué depuis le
  PC, `wizard_decode.py` rempli, le bridge remonte les réseaux du vrai Wizard ;
  tout le reste (serveur, relevés, live, audit) était déjà validé en `--mock`.
- **No-go** (chiffrement, protocole opaque) : repli sur un **ESP32-S3 en mode
  promiscuous sur USB série** qui remonte RSSI par BSSID et canal ; protocole
  100 % ouvert, même contrat NDJSON que `wizard_bridge.py`, donc mêmes
  phases suivantes.
