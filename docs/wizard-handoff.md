# Reprise — WiFiman Wizard dans wled-fleet (session locale sur le PC)

À coller tel quel dans une session Claude Code ouverte **sur le PC Windows**, dans le
clone de `WLED-Wireless-Orchestrator`. Tout ce qui suit est vrai au 4 septembre 2026,
branche `claude/ubiquity-wifiman-bluetooth-6fdolm` (deux commits poussés).

## Résultat (session du 5 septembre 2026)

**Fait.** Le protocole a été relevé sur le Wizard (adresse `74:FA:29:30:C0:38`,
nom GATT `UWS-038`, firmware 1.9.0) : sonde GATT, puis analyse statique de
l'APK WiFiman 2.12.1 avec jadx, puis rejeu depuis le PC. C'est du HTTP sur BLE
(JSON) sans chiffrement, entièrement décrit dans `docs/wizard-protocol.md`.
`tools/wizard/wizard_decode.py` est rempli et testé (`test_wizard_decode.py`),
le bridge remonte les réseaux réels dans le panneau (décodeur `wmw-api-1.0`,
batterie, relevés). Reste à faire par Florian : comparer avec l'app WiFiman
sur l'iPhone (pas en même temps : une seule connexion BLE à la fois) et avec
le scan de l'antenne MikroTik posée à côté, puis deux relevés à deux endroits.
Le reste de cette note est l'état d'avant, gardé pour l'historique.

Ajouts du même jour, après le décodage (commits suivants sur la branche) :

- **Sonde optionnelle** : `wizard.json "enabled"`, case « activer la sonde »
  en tête du panneau Antenne > WiFiman Wizard ; décocher replie le panneau et
  arrête le bridge, cocher relance la connexion auto.
- **Vue fréquence** 2,4 / 5 GHz (`renderFreqView` dans `static/index.html`,
  partagée avec le scan de l'antenne) : réseaux dessinés à leur fréquence
  centrale, larges comme leur canal, hauts comme leur RSSI.
- **Cascade temps × canal** : `wizard.js` garde en RAM une ligne toutes les 5 s
  (une heure) du signal le plus fort par tranche de 5 MHz (`waterfall()`,
  route `GET /api/wizard/waterfall`), dessinée côté client dans un canvas
  (`drawWaterfall`). Tests : `test/waterfall.test.js`.

Pistes suivantes, non commencées : afficher le Wizard comme source du plan
de canaux à la place du scan PC quand il est connecté ; vrai spectre (bruit
non Wi-Fi) via `spectral-scan` RouterOS sur l'antenne MikroTik si sa puce le
permet ; une app autonome `wizard-app/` autour du même bridge si l'usage hors
show se confirme.

## Mission

Brancher le WiFiman Wizard d'Ubiquiti (WM-W, scanner 802.11 2,4 / 5 GHz sur batterie,
relié en Bluetooth LE) sur wled-fleet comme **sonde RF mobile** : promené sur le plateau,
il montre ce qu'un node WLED entendrait à cet endroit ; posé près d'un node pendant le
show, il alimente le diagnostic de l'antenne. Tout le côté Node / UI est fait et validé
en simulation. **Il manque une seule chose : le protocole BLE du Wizard**, qui n'est pas
public. La session locale sert à ça : sonder l'appareil, comprendre ses trames, remplir
`wled-fleet/tools/wizard/wizard_decode.py`.

## Ce qui est déjà en place (ne pas refaire)

| Fichier | Rôle |
|---|---|
| `wled-fleet/ap.js` | `occupancy(nets, oursFreq)` extrait de `scan()` : plan de canaux 1-13 partagé antenne / Wizard (`npm test`, 6 tests) |
| `wled-fleet/wizard.js` | lance le bridge Python, historique RSSI par BSSID, `snapshot()` dans la forme de `ap.scan()`, relevés (`wizard-surveys.log`), live (`wizard-live.log`), `audit()` fusionné dans `/api/ap`, corrélation « posé près d'un node » |
| `wled-fleet/server.js` | routes `/api/wizard/*`, `--wizard-mock`, `wizard.json` (adresse, connexion auto, chemin python) |
| `wled-fleet/static/index.html` | onglet **Antenne > WiFiman Wizard** : recherche BLE, connexion, simulation, histogramme + recommandation vus d'ici, courbe du signal de l'antenne, antenne vs Wizard, relevés nommés ; `renderRfEnv()` partagé |
| `wled-fleet/tools/wizard/wizard_bridge.py` | BLE (bleak) → NDJSON sur stdout ; `--list`, `--address`, `--mock`, `--raw` |
| `wled-fleet/tools/wizard/wizard_probe.py` | **sonde phase 0** : scan, dump GATT, lecture, abonnement à toutes les notifications, journal `wizard-probe.log` |
| `wled-fleet/tools/wizard/wizard_decode.py` | **à remplir** : UUID, commande de démarrage, `parse_frame()` ; rejoue un journal de la sonde |
| `wled-fleet/docs/wizard-protocol.md` | faits établis + méthode + sections vides à compléter |
| `wled-fleet/README.md`, `ROADMAP.md` | documentés |

Faits établis (dossier FCC SWX-WMW, prises en main) : puce **MediaTek MT7931AN** (Wi-Fi 6
1x1 + BLE 5, Cortex-M33), Wi-Fi en **réception seule**, antenne 3 dBi comparable à un
ESP32, données = **scan 802.11** (SSID / BSSID / canal / largeur / RSSI), **pas** de
spectre non Wi-Fi, app WiFiman `com.ubnt.usurvey`, iPhone uniquement chez Florian
(donc pas de journal HCI Android : on passe par le PC et par l'APK).

## À faire sur le PC, dans l'ordre

### 1. Mise en place

```powershell
git fetch origin claude/ubiquity-wifiman-bluetooth-6fdolm
git checkout claude/ubiquity-wifiman-bluetooth-6fdolm
python --version            # 3.9+ requis ; sinon py -3 --version
pip install bleak
cd wled-fleet
npm test                    # 6 tests verts attendus
node server.js --wizard-mock   # puis http://127.0.0.1:8792/#tab=ap : le panneau Wizard en simulation
```

Conditions matérielles : Bluetooth du PC actif (adaptateur intégré ou dongle BT 5
récent, pas un vieux CSR 4.0), Wizard allumé (LED), **Bluetooth de l'iPhone coupé**
(une seule connexion BLE à la fois). Si le Wizard refuse la connexion : l'oublier dans
WiFiman, ou reset usine (bouton sous le capot silicone). Si Windows garde une table
GATT périmée : Paramètres > Bluetooth > supprimer le Wizard, reconnecter.

### 2. Sonde (phase 0, étape 1)

```powershell
cd wled-fleet\tools\wizard
python wizard_probe.py                                   # scan 8 s, Wizard probables marqués ★
python wizard_probe.py --address <ADRESSE> --seconds 120  # dump GATT + notifications
```

Noter dans `docs/wizard-protocol.md` (sections « Relevés ») : nom annoncé, UUID de
service, données constructeur, table GATT (service / caractéristique / propriétés /
valeur lue), ce qui arrive spontanément en notification. Le journal
`wizard-probe.log` (une ligne JSON par événement) est la matière première du décodeur.

Si rien n'arrive spontanément, c'est normal : l'app écrit probablement une commande de
démarrage. Ne pas deviner à l'aveugle avec `--write` avant l'étape 3.

### 3. Analyse statique de l'APK (phase 0, étape 2, sans téléphone Android)

- Récupérer l'APK WiFiman (`com.ubnt.usurvey`, ex. APKMirror), l'ouvrir avec **jadx**
  (Java requis, tourne sous Windows).
- Chercher : les UUID vus à l'étape 2, les classes / packages contenant `wizard`,
  `Wizard`, `WmW`, des `.proto` / classes protobuf (Ubiquiti en utilise sur ses autres
  liaisons BLE), un framing TLV maison, la séquence qui lance le scan, la structure des
  résultats (BSSID, SSID, fréquence ou canal, largeur, RSSI, batterie, firmware),
  un éventuel chiffrement / handshake.
- Consigner dans `docs/wizard-protocol.md`. **Ne rien recopier du code d'Ubiquiti** dans
  le dépôt : on décrit le format, on réécrit le décodeur.

### 4. Rejouer, puis écrire la commande de démarrage

- Si l'APK donne la commande : `python wizard_probe.py --address <ADRESSE> --write <uuid> <hex> --seconds 60`
  et vérifier que les notifications arrivent.
- Remplir `wizard_decode.py` : `SERVICE_UUID`, `CHAR_NOTIFY`, `CHAR_WRITE`,
  `START_CMD`, `STOP_CMD`, et `parse_frame(data) -> [ {bssid, ssid, freq, channel,
  width, signal, band, security, std} ]`. Le reste du bridge est déjà câblé sur cette
  forme.
- `python wizard_decode.py wizard-probe.log` doit sortir des réseaux plausibles.

### 5. Validation terrain

- `python wizard_bridge.py --address <ADRESSE>` à la main : des lignes
  `{"type":"network",...}` défilent.
- Dans wled-fleet (serveur relancé sans `--wizard-mock`) : Antenne > WiFiman Wizard >
  Connecter. Décodeur ≠ `none`, réseaux affichés, mêmes BSSID et RSSI (± 3 dB) que
  l'app WiFiman sur l'iPhone au même instant, et que le scan de l'antenne MikroTik
  posée à côté.
- Enregistrer deux relevés à deux endroits, vérifier `wizard-surveys.log` et le
  tableau des relevés après redémarrage du serveur.

### 6. Si le protocole reste opaque (no-go)

Chiffrement applicatif ou handshake incompréhensible après les étapes 2-3 : essayer une
capture réelle iPhone ↔ Wizard (dongle nRF52840 + nRF Sniffer + Wireshark, fonctionne
sous Windows). Sinon repli documenté : un **ESP32-S3 en mode promiscuous sur USB série**
qui remonte RSSI par BSSID et canal, avec le même contrat NDJSON que
`wizard_bridge.py` ; tout le reste (serveur, UI, relevés, live) reste tel quel.

## Conventions du dépôt

- Node sans dépendance npm ; Python n'a que `bleak`. Commentaires de code en anglais,
  textes UI / README en français, bloc d'en-tête en tête de chaque module.
- Aucune écriture vers le routeur ou les nodes depuis ce chantier ; le Wizard est passif.
- `wizard.json`, `wizard-*.log`, `tools/wizard/wizard-probe.log` sont ignorés par git.
- Commits en français sur la branche `claude/ubiquity-wifiman-bluetooth-6fdolm` ; pas de
  pull request tant que le décodeur n'est pas validé en réel.

## Livrable attendu de la session locale

1. `docs/wizard-protocol.md` complété (annonces, table GATT, commandes, format).
2. `tools/wizard/wizard_decode.py` rempli, `wizard_decode.py wizard-probe.log` concluant.
3. Une connexion réelle qui affiche les réseaux dans le panneau, validée contre l'iPhone.
4. Commit + push sur la branche ; sinon, le point de blocage exact et l'erreur brute.
