// Column catalogue for the fleet grid. Served to the UI by GET /api/columns so
// the browser stays dumb: it renders whatever the server declares.
//
//   path   : dotted path into the node record {meta, info, state, cfg, derived}
//   type   : str | num | bool | enum
//   help   : French explanation shown in the tooltip of the header and cells
//   write  : {target: 'cfg' | 'state', path} - if absent the cell is read-only.
//            The write path is the dotted key inside the JSON that WLED accepts
//            on POST /json/cfg or POST /json/state (partial merge semantics).
//   reboot : true when WLED only applies the change after a reboot.
//   nodiff : excluded from the outlier highlight (naturally unique/volatile).
//   watch  : false = volatile metric, never written to the change journal.
//   width  : default column width in px (the user can resize/reorder in the UI).
//
// Writable fields are limited on purpose to scalar keys whose *partial* POST is
// known to leave the rest of the config untouched (cfg.cpp uses CJSON(): only
// keys present in the payload are applied). Arrays such as hw.led.ins or
// nw.ins are NOT exposed for writing: WLED rebuilds the whole array from the
// payload, so a partial write would silently drop the other outputs.
//
// Group order = reading order: who it is, is it alive, how it is connected,
// what it drives, what the console sends it, sync, current state, boot
// defaults, and finally maintenance (firmware).

const DMX_MODES = {
  0: 'Disabled', 1: 'Single RGB', 2: 'Single DRGB', 3: 'Effect', 4: 'Multi RGB',
  5: 'Multi DRGB', 6: 'Multi RGBW', 7: 'Effect + W', 8: 'Effect segment',
  9: 'Effect segment + W', 10: 'Preset',
};

const LED_TYPES = {
  18: 'WS2812 1ch', 19: 'WS2812 1ch x3', 20: 'WS2812 2ch x3', 21: 'WS2812 WWA',
  22: 'WS281x RGB', 23: 'GS8608', 24: 'WS2811 400k', 25: 'TM1829', 26: 'UCS8903',
  27: 'APA106', 28: 'FW1906', 29: 'UCS8904', 30: 'SK6812 RGBW', 31: 'TM1814',
  32: 'WS2805', 33: 'TM1914', 34: 'SM16825',
  40: 'On/Off', 41: 'PWM 1ch', 42: 'PWM 2ch', 43: 'PWM 3ch', 44: 'PWM 4ch', 45: 'PWM 5ch',
  50: 'WS2801', 51: 'APA102', 52: 'LPD8806', 53: 'P9813', 54: 'LPD6803',
  80: 'DDP out', 81: 'E1.31 out', 82: 'Art-Net out', 88: 'Art-Net RGBW out',
};

const COLOR_ORDERS = { 0: 'GRB', 1: 'RGB', 2: 'BRG', 3: 'RBG', 4: 'BGR', 5: 'GBR' };

// Échange du canal blanc (WLED : « Swap » dans LED Settings). Rangé dans le QUARTET
// HAUT du même octet que l'ordre des couleurs — hw.led.ins[i].order vaut
// (swap << 4) | ordre, cf. settings_leds.htm : (v.order>>4) & 0x0F. Fleet ne lisait
// que le quartet bas et réécrivait l'octet entier : le swap réglé sur le node était
// effacé à la première sauvegarde (corrigé 2026-09-08).
const WHITE_SWAPS = { 0: 'aucun', 1: 'W & B', 2: 'W & G', 3: 'W & R', 4: 'WW & CW' };
// types numériques à canal blanc : WLED n'affiche le sélecteur que pour ceux-là
// (isDig(t) && hasW(t)) et remet le swap à 0 sur les autres.
const WHITE_SWAP_TYPES = [28, 29, 30, 31, 32, 34];

// Consommation par pixel, choix nommés repris de settings_leds.htm (menu
// « mA/LED »). Ce n'est pas un réglage libre dans l'esprit de WLED : le chiffre
// dépend du TYPE de ruban, et l'interface propose donc les cas courants.
//
// 255 est le seul piège : ce n'est pas 255 mA mais une valeur magique qui
// bascule sur le modèle de puissance WS2815 — 12 mA/LED, somme des couleurs ×3
// (bus_manager.cpp:198, WLED #549). Elle freine donc MOINS que 55, et non plus.
// D'où le libellé, qui annonce 12 et non 255.
// Liste ORDONNÉE, pas un objet : les clés numériques d'un objet se réordonnent
// toutes seules en JS, et « 12 mA » se retrouvait affiché après « 55 mA ».
const LED_MA_PRESETS = [
  [55, '55 mA — 5 V WS281x (défaut)'],
  [35, '35 mA — WS2812 éco'],
  [30, '30 mA — 12 V typique'],
  [255, '12 mA — WS2815 (modèle dédié)'],
  [15, '15 mA — guirlande / fairy'],
];
// Bornes du firmware : le champ par pixel est un uint8_t (bus_manager.h:285), et
// une limite d'alimentation doit valoir au moins 250 mA (settings_leds.htm).
const LED_MA_MAX = 255;
const PSU_MA_MIN = 250, PSU_MA_MAX = 65000;
// Consommation propre de l'ESP, retirée du budget avant toute répartition
// (bus_manager.h:523-525 : 80 mA sur ESP8266, 120 sur ESP32).
const MA_FOR_ESP = 120;

// Les tensions du métier. WLED ne connaît PAS la tension : il raisonne en
// milliampères et ignore complètement les volts. C'est donc une notion propre à
// Fleet, et la seule façon d'attraper le ruban 24 V branché sur une alim 12 V —
// une erreur qui ne se voit nulle part ailleurs et qui coûte le ruban.
//
// Liste fermée : au-delà de ces quatre valeurs on est hors des alimentations du
// marché, et un champ libre inviterait surtout à saisir des fautes de frappe.
const VOLTAGES = [5, 12, 24, 48];

const ETH_TYPES = {
  0: 'None', 1: 'WT32-ETH01', 2: 'ESP32-POE', 3: 'WESP32', 4: 'QuinLED-ESP32',
  5: 'TwilightLord', 6: 'ESP3DEUXQuattro', 7: 'ESP32Deux', 8: 'KIT-VE',
  9: 'QuinLED-Dig-Octa', 10: 'ABC WLED V43', 11: 'Serg74', 12: 'ESP32-POE-WROVER',
  13: 'LILYGO T-ETH-POE', 14: 'QuinLED-ESP32-Ethernet',
};

// WLED wifi.txpwr values (ESP-IDF wifi_power_t, quarter-dBm units)
const TX_POWER = { 78: '19,5 dBm (max)', 76: '19 dBm', 74: '18,5 dBm', 68: '17 dBm', 60: '15 dBm', 52: '13 dBm', 44: '11 dBm', 34: '8,5 dBm', 28: '7 dBm', 20: '5 dBm', 8: '2 dBm', '-4': '-1 dBm' };

const cfgW = (p) => ({ target: 'cfg', path: p });
const stW = (p) => ({ target: 'state', path: p });

// adv: true = colonne avancée, masquée dans la vue « essentiel » de la grille (case « toutes les colonnes »).
const columns = [
  // ── Identité : qui est ce node ──────────────────────────────────────────
  { id: 'name', group: 'Identité', label: 'Nom', path: 'cfg.id.name', type: 'str', write: cfgW('id.name'), nodiff: true, width: 170,
    help: "Nom affiché du node (Config > Identity). Utilisé aussi dans la liste des nodes WLED." },
  { id: 'ip', group: 'Identité', label: 'IP', path: 'meta.ip', type: 'str', link: true, nodiff: true, width: 120,
    help: "Adresse IP actuelle. Clic = ouvrir l'interface WLED du node." },
  { id: 'group', group: 'Identité', label: 'Groupe', path: 'meta.group', type: 'str', local: true, write: { target: 'local', path: 'group' }, nodiff: true, width: 110,
    help: "Groupe (zone, type, plateau…) = le « Group topic » MQTT du node (Sync Interfaces > MQTT), champ natif WLED, texte libre 32 caractères, sans effet tant que MQTT est désactivé ; « wled/all » = sans groupe. Écrit sur le node immédiatement (pas de Déployer, le node doit répondre). Dans la grille : lignes de groupe en arborescence, glisser un node sous une ligne de groupe pour l'y mettre." },
  { id: 'mdns', adv: true, group: 'Identité', label: 'mDNS', path: 'cfg.id.mdns', type: 'str', write: cfgW('id.mdns'), reboot: true, nodiff: true, width: 130,
    help: "Nom mDNS : le node est joignable en http://<mdns>.local. Prend effet après redémarrage." },
  { id: 'apssid', adv: true, group: 'Identité', label: 'SSID de l\'AP', path: 'cfg.ap.ssid', type: 'str', write: cfgW('ap.ssid'), reboot: true, nodiff: true, width: 140,
    help: "Nom du point d'accès de secours que le node émet quand il n'a pas de réseau (page WiFi Setup de WLED). C'est ce nom, et pas le nom du node, que l'on voit dans la liste Wi‑Fi à l'appairage. Prend effet après redémarrage." },
  { id: 'mac', adv: true, group: 'Identité', label: 'MAC', path: 'info.mac', type: 'str', nodiff: true, width: 110,
    help: "Adresse MAC de la puce (identifiant matériel stable, même si l'IP change)." },
  { id: 'product', adv: true, group: 'Identité', label: 'Produit', path: 'derived.product', type: 'str', width: 130,
    help: "Marque et produit déclarés par le firmware (WLED FOSS = build officiel ; autre = build constructeur)." },
  { id: 'arch', adv: true, group: 'Identité', label: 'Puce', path: 'info.arch', type: 'str', width: 80,
    help: "Famille de microcontrôleur détectée à l'exécution (esp32, ESP32-S3…)." },
  { id: 'release', adv: true, group: 'Identité', label: 'Plateforme', path: 'info.release', type: 'str', width: 130,
    help: "Variante de build (ESP32, ESP32_Ethernet, ESP32-S3_4M_qspi…). Doit correspondre au nom du .bin pour une mise à jour." },
  { id: 'ver', group: 'Identité', label: 'Version', path: 'info.ver', type: 'str', width: 70,
    help: "Version du firmware WLED en cours d'exécution." },
  { id: 'vid', adv: true, group: 'Identité', label: 'Build', path: 'info.vid', type: 'num', watch: false, width: 80,
    help: "Numéro de build (AAMMJJx) : distingue deux binaires de même version." },

  // ── Santé : est-il vivant, comment va-t-il ──────────────────────────────
  { id: 'online', adv: true, group: 'Santé', label: 'En ligne', path: 'meta.online', type: 'bool', watch: false, width: 70,
    help: "Le node a répondu au dernier relevé (passe hors ligne après 2 échecs consécutifs)." },
  { id: 'lastseen', adv: true, group: 'Santé', label: 'Vu il y a', path: 'meta.lastSeenAgo', type: 'num', fmt: 'duration', nodiff: true, watch: false, width: 70,
    help: "Temps écoulé depuis la dernière réponse du node." },
  { id: 'latency', adv: true, group: 'Santé', label: 'Latence ms', path: 'meta.latency', type: 'num', nodiff: true, watch: false, width: 80,
    help: "Temps de réponse de /json/info en millisecondes, mesuré depuis ce serveur." },
  { id: 'uptime', adv: true, group: 'Santé', label: 'Uptime', path: 'info.uptime', type: 'num', fmt: 'duration', nodiff: true, watch: false, width: 80,
    help: "Temps écoulé depuis le dernier démarrage du node. Un uptime qui retombe à zéro = redémarrage (plantage, coupure, watchdog)." },
  { id: 'fps', adv: true, group: 'Santé', label: 'FPS réel', path: 'info.leds.fps', type: 'num', nodiff: true, watch: false, width: 65,
    help: "Images par seconde réellement rendues sur les LEDs en ce moment." },
  { id: 'freeheap', adv: true, group: 'Santé', label: 'RAM libre', path: 'info.freeheap', type: 'num', fmt: 'bytes', nodiff: true, watch: false, width: 80,
    help: "Mémoire RAM libre. Sous ~20 kB le node devient instable (segments, effets lourds, DDP)." },
  { id: 'psram', adv: true, group: 'Santé', label: 'PSRAM libre', path: 'info.psram', type: 'num', fmt: 'bytes', nodiff: true, watch: false, width: 85,
    help: "Mémoire PSRAM libre (uniquement sur les cartes qui en ont)." },
  { id: 'fsused', adv: true, group: 'Santé', label: 'Stockage', path: 'derived.fs', type: 'str', nodiff: true, watch: false, width: 90,
    help: "Espace utilisé / total du système de fichiers interne (presets, cfg.json, ledmaps)." },

  // ── Réseau : comment il est connecté ────────────────────────────────────
  { id: 'ssid', adv: true, group: 'Réseau', label: 'SSID', path: 'cfg.nw.ins.0.ssid', type: 'str', width: 100, write: { target: 'special', path: 'ssid' }, reboot: true,
    help: "Réseau Wi‑Fi du premier profil. Modifiable : le node garde son mot de passe Wi‑Fi actuel (il n'est jamais relu ni renvoyé) ; pour un autre réseau avec un autre mot de passe, passer par l'appairage. Redémarrage requis." },
  { id: 'staticip', group: 'Réseau', label: 'IP fixe', path: 'derived.staticIp', type: 'str', def: "DHCP", nodiff: true, width: 110, write: { target: 'special', path: 'staticip' }, reboot: true,
    help: "IP fixe du node (profil Wi‑Fi). Modifiable : taper une IP libre (passerelle .1 et masque /24 déduits) ou DHCP, puis Déployer : le node redémarre et sa ligne le suit à la nouvelle adresse (identité par MAC, pas de doublon)." },
  { id: 'gw', adv: true, group: 'Réseau', label: 'Passerelle', path: 'derived.gw', type: 'str', width: 100, write: { target: 'special', path: 'gw' }, reboot: true,
    help: "Passerelle de l'IP fixe. Modifiable (redémarrage requis) ; sans effet en DHCP." },
  { id: 'eth', adv: true, group: 'Réseau', label: 'Ethernet', path: 'cfg.eth.type', type: 'enum', def: 0, enum: ETH_TYPES, width: 110, write: cfgW('eth.type'), reboot: true,
    help: "Type de carte Ethernet (None = Wi‑Fi seul). Modifiable : choisir la carte réelle (ex. LILYGO T-ETH-POE) fait passer le node par le câble au redémarrage. Un mauvais type peut bloquer des GPIO : vérifier la carte avant." },
  { id: 'rssi', group: 'Réseau', label: 'RSSI dBm', path: 'info.wifi.rssi', type: 'num', nodiff: true, watch: false, width: 75,
    help: "Puissance du signal Wi‑Fi reçu en dBm. > -60 très bon, -60 à -70 correct, < -75 fragile (pertes, latence)." },
  { id: 'signal', adv: true, group: 'Réseau', label: 'Signal %', path: 'info.wifi.signal', type: 'num', nodiff: true, watch: false, width: 65,
    help: "Même chose que RSSI, ramené sur 0-100 %." },
  { id: 'channel', adv: true, group: 'Réseau', label: 'Canal', path: 'info.wifi.channel', type: 'num', watch: false, width: 55,
    help: "Canal Wi‑Fi de l'AP auquel le node est associé." },
  { id: 'bssid', adv: true, group: 'Réseau', label: 'AP (BSSID)', path: 'info.wifi.bssid', type: 'str', nodiff: true, watch: false, width: 130,
    help: "MAC du point d'accès auquel le node est connecté : permet de voir quels nodes sont sur quel AP." },
  { id: 'wifisleep', adv: true, group: 'Réseau', label: 'Veille Wi‑Fi', path: 'cfg.wifi.sleep', type: 'bool', def: false, write: cfgW('wifi.sleep'), width: 85,
    help: "Veille modem de l'ESP32 (WLED : « Disable WiFi sleep » inversé). Oui = le node s'endort entre deux balises et rate des trames : cause n° 1 de paquets E1.31 / DDP perdus. Pour un show : NON, sur tous les nodes." },
  { id: 'txpwr', adv: true, group: 'Réseau', label: 'Puissance TX', path: 'cfg.wifi.txpwr', type: 'enum', def: 78, enum: TX_POWER, write: cfgW('wifi.txpwr'), width: 90,
    help: "Puissance d'émission Wi‑Fi de l'ESP32 (WLED ≥ 0.15). Maximum 19,5 dBm ; le laisser au maximum sauf pour un node collé à l'antenne. Ne compense pas une mauvaise antenne du node : c'est la réception côté node qui limite en général." },
  { id: 'phyg', adv: true, group: 'Réseau', label: 'Forcer 802.11g', path: 'cfg.wifi.phy', type: 'bool', def: false, write: cfgW('wifi.phy'), reboot: true, width: 95,
    help: "Force le mode 802.11g (désactive le 802.11n côté node). À essayer seulement si un node décroche avec l'antenne en ax/n ; sinon laisser NON." },
  { id: 'apmode', adv: true, group: 'Réseau', label: 'Mode AP', path: 'info.wifi.ap', type: 'bool', width: 65,
    help: "Oui si le node a basculé sur son propre point d'accès de secours (WLED-AP), donc plus sur le réseau." },

  // ── Antenne : ce que le point d'accès MikroTik voit de ce node (ap.js) ──
  { id: 'apseen', adv: true, group: 'Antenne', label: 'Vu par l\'AP', path: 'derived.ap.seen', type: 'bool', nodiff: true, watch: false, width: 80,
    help: "Oui si la MAC de ce node figure dans la table des clients Wi‑Fi de l'antenne (registration-table). Non = le node est en Ethernet, ou associé à une autre antenne, ou l'antenne n'est pas configurée." },
  { id: 'apiface', adv: true, group: 'Antenne', label: 'Radio', path: 'derived.ap.iface', type: 'str', nodiff: true, watch: false, width: 70,
    help: "Interface radio de l'antenne qui sert ce node (wifi1 = 5 GHz, wifi2 = 2,4 GHz sur un wAP ax)." },
  { id: 'apband', adv: true, group: 'Antenne', label: 'Canal AP', path: 'derived.ap.band', type: 'str', nodiff: true, watch: false, width: 110,
    help: "Fréquence / standard / largeur du canal vus côté antenne (ex. 2452/ax/Ce = 2,4 GHz canal 9, Wi‑Fi 6, 40 MHz)." },
  { id: 'apsignal', adv: true, group: 'Antenne', label: 'Signal AP dBm', path: 'derived.ap.signal', type: 'num', nodiff: true, watch: false, width: 95,
    help: "Puissance du signal du node REÇUE PAR L'ANTENNE, en dBm. À comparer au RSSI mesuré par le node : un écart important trahit une asymétrie (antenne du node faible, puissance TX trop basse)." },
  { id: 'aptx', adv: true, group: 'Antenne', label: 'Débit → node', path: 'derived.ap.txRate', type: 'num', nodiff: true, watch: false, width: 90,
    help: "Débit de modulation actuel de l'antenne vers le node, en Mbit/s. Bas (< 20) = liaison dégradée, retransmissions, paquets DDP/E1.31 en retard." },
  { id: 'aprx', adv: true, group: 'Antenne', label: 'Débit ← node', path: 'derived.ap.rxRate', type: 'num', nodiff: true, watch: false, width: 90,
    help: "Débit de modulation du node vers l'antenne, en Mbit/s." },
  { id: 'apthru', adv: true, group: 'Antenne', label: 'Trafic → node kbit/s', path: 'derived.ap.txKbps', type: 'num', nodiff: true, watch: false, width: 110,
    help: "Débit réellement envoyé par l'antenne à ce node en ce moment (kbit/s). Au repos quelques kbit/s ; en show E1.31 ou DDP, plusieurs centaines à quelques milliers. À comparer au débit de modulation : si le trafic approche le débit de modulation, le lien sature." },
  { id: 'apuptime', adv: true, group: 'Antenne', label: 'Associé depuis', path: 'derived.ap.uptime', type: 'num', fmt: 'duration', nodiff: true, watch: false, width: 95,
    help: "Durée de l'association Wi‑Fi actuelle. Une valeur qui retombe souvent = le node se déconnecte / re-connecte (roaming, coupures)." },

  // ── LEDs : ce qu'il pilote ──────────────────────────────────────────────
  { id: 'ledcount', group: 'LEDs', label: 'Pixels', path: 'info.leds.count', type: 'num', nodiff: true, width: 60,
    help: "Nombre total de pixels, toutes sorties confondues." },
  { id: 'outputs', group: 'LEDs', label: 'Sorties', path: 'derived.outputs', type: 'str', nodiff: true, width: 300,
    help: "Sorties LED : pin : longueur, type de puce, ordre des couleurs, rev = inversée. Éditable uniquement dans WLED (Config > LED Preferences)." },
  { id: 'rgbw', adv: true, group: 'LEDs', label: 'RGBW', path: 'info.leds.rgbw', type: 'bool', width: 60,
    help: "Au moins une sortie en LEDs à 4 canaux (RGB + blanc)." },
  { id: 'seglc', adv: true, group: 'LEDs', label: 'Segments', path: 'derived.segments', type: 'num', width: 70,
    help: "Nombre de segments définis." },
  { id: 'ledmaps', adv: true, group: 'LEDs', label: 'Ledmaps', path: 'derived.ledmaps', type: 'num', width: 65,
    help: "Nombre de ledmaps (tables de remappage des pixels) présents sur le node." },
  { id: 'maxpwr', group: 'LEDs', label: 'Limite mA', path: 'cfg.hw.led.maxpwr', type: 'num', def: 850, write: cfgW('hw.led.maxpwr'), width: 80,
    help: "Limiteur de courant automatique (ABL) en mA : WLED réduit la luminosité pour ne pas dépasser cette valeur. 0 = désactivé." },
  { id: 'pwr', adv: true, group: 'LEDs', label: 'Conso est. mA', path: 'info.leds.pwr', type: 'num', nodiff: true, watch: false, width: 95,
    help: "Consommation estimée par WLED à partir de la couleur actuelle, en mA." },
  { id: 'tfps', adv: true, group: 'LEDs', label: 'FPS cible', path: 'cfg.hw.led.fps', type: 'num', def: 42, write: cfgW('hw.led.fps'), width: 70,
    help: "Cadence cible du rendu en images/s (0 = par défaut, 42). Plus haut = plus fluide mais plus de CPU." },

  // ── Live : ce que la console lui envoie ─────────────────────────────────
  { id: 'live', adv: true, group: 'Live', label: 'Live actif', path: 'info.live', type: 'bool', nodiff: true, watch: false, width: 70,
    help: "Oui quand le node reçoit actuellement un flux temps réel (E1.31, Art-Net, DDP, UDP…) et l'affiche à la place de ses effets." },
  { id: 'lm', adv: true, group: 'Live', label: 'Protocole', path: 'info.lm', type: 'str', watch: false, width: 75,
    help: "Protocole temps réel actuellement reçu (E1.31, Art-Net, DDP, UDP, Hyperion…)." },
  { id: 'lip', adv: true, group: 'Live', label: 'Source', path: 'info.lip', type: 'str', nodiff: true, watch: false, width: 110,
    help: "Adresse IP de la source du flux temps réel (la console, l'orchestrateur)." },
  { id: 'liveen', adv: true, group: 'Live', label: 'Recevoir UDP', path: 'cfg.if.live.en', type: 'bool', def: true, write: cfgW('if.live.en'), width: 90,
    help: "Autorise la réception des protocoles temps réel réseau. Non = le node ignore E1.31/Art-Net/DDP." },
  { id: 'dmxuni', group: 'Live', label: 'Univers', path: 'cfg.if.live.dmx.uni', type: 'num', def: 1, write: cfgW('if.live.dmx.uni'), nodiff: true, width: 65,
    help: "Premier univers E1.31 / Art-Net écouté par le node." },
  { id: 'dmxaddr', group: 'Live', label: 'Adresse DMX', path: 'cfg.if.live.dmx.addr', type: 'num', def: 1, write: cfgW('if.live.dmx.addr'), nodiff: true, width: 90,
    help: "Adresse DMX de départ (1-512) dans ce premier univers." },
  { id: 'dmxmode', group: 'Live', label: 'Mode DMX', path: 'cfg.if.live.dmx.mode', type: 'enum', def: 4, enum: DMX_MODES, write: cfgW('if.live.dmx.mode'), width: 130,
    help: "Ce que représentent les canaux DMX reçus : Multi RGB/RGBW = un pixel par 3/4 canaux (pixel mapping console) ; Effect = quelques canaux pilotent effet, vitesse, couleur ; Single = tout le node sur une couleur ; Preset = un canal choisit un preset ; Disabled = ignoré." },
  { id: 'dmxdss', adv: true, group: 'Live', label: 'Espacement seg.', path: 'cfg.if.live.dmx.dss', type: 'num', def: 0, write: cfgW('if.live.dmx.dss'), width: 105,
    help: "Espacement entre segments en canaux, pour les modes Effect segment." },
  { id: 'e131prio', adv: true, group: 'Live', label: 'Priorité E1.31', path: 'cfg.if.live.dmx.e131prio', type: 'num', def: 0, write: cfgW('if.live.dmx.e131prio'), width: 95,
    help: "Priorité E1.31 minimale acceptée (0 = toutes). Permet d'ignorer une source de priorité inférieure." },
  { id: 'seqskip', group: 'Live', label: 'Skip séq. HS', path: 'cfg.if.live.dmx.seqskip', type: 'bool', def: false, write: cfgW('if.live.dmx.seqskip'), width: 90,
    help: "Ignore les paquets E1.31 reçus dans le désordre (numéro de séquence inférieur au précédent). Utile en Wi‑Fi pour éviter les retours en arrière." },
  { id: 'liveport', adv: true, group: 'Live', label: 'Port E1.31', path: 'cfg.if.live.port', type: 'num', def: 5568, write: cfgW('if.live.port'), reboot: true, width: 80,
    help: "Port UDP d'écoute E1.31 (5568 par défaut). Redémarrage requis." },
  { id: 'mc', group: 'Live', label: 'Multicast', path: 'cfg.if.live.mc', type: 'bool', def: false, write: cfgW('if.live.mc'), reboot: true, width: 75,
    help: "Rejoint le groupe multicast E1.31 de l'univers au lieu d'écouter en unicast. À activer seulement si la console envoie en multicast. Redémarrage requis." },
  { id: 'timeout', group: 'Live', label: 'Timeout x100ms', path: 'cfg.if.live.timeout', type: 'num', def: 25, write: cfgW('if.live.timeout'), width: 105,
    help: "Délai sans paquet temps réel (en dixièmes de seconde, 25 = 2,5 s) avant que le node reprenne ses effets normaux." },
  { id: 'maxbri', adv: true, group: 'Live', label: 'Force bri max', path: 'cfg.if.live.maxbri', type: 'bool', def: false, write: cfgW('if.live.maxbri'), width: 95,
    help: "Force la luminosité à 100 % pendant un flux temps réel, en ignorant le curseur de luminosité du node. À activer pour que la console ait le contrôle total." },
  { id: 'nogc', adv: true, group: 'Live', label: 'Sans gamma', path: 'cfg.if.live.no-gc', type: 'bool', def: true, write: cfgW('if.live.no-gc'), width: 85,
    help: "Désactive la correction gamma pendant un flux temps réel : les valeurs reçues sont envoyées telles quelles aux LEDs (la console fait sa propre courbe)." },
  { id: 'mso', adv: true, group: 'Live', label: 'Seg. principal seul', path: 'cfg.if.live.mso', type: 'bool', def: false, write: cfgW('if.live.mso'), width: 120,
    help: "Le flux temps réel ne pilote que le segment principal ; les autres segments continuent leurs effets." },
  { id: 'rlm', adv: true, group: 'Live', label: 'Respecte ledmap', path: 'cfg.if.live.rlm', type: 'bool', def: false, write: cfgW('if.live.rlm'), width: 110,
    help: "Applique le ledmap (remappage des pixels) aussi aux données temps réel." },
  { id: 'offset', adv: true, group: 'Live', label: 'Offset pixels', path: 'cfg.if.live.offset', type: 'num', def: 0, write: cfgW('if.live.offset'), width: 90,
    help: "Décalage de pixels appliqué aux données temps réel (le canal 1 pilote le pixel N+offset)." },

  // ── Sync : dialogue entre nodes WLED ────────────────────────────────────
  { id: 'syncsend', adv: true, group: 'Sync', label: 'Envoi sync', path: 'state.udpn.send', type: 'bool', def: false, write: stW('udpn.send'), width: 80,
    help: "Envoie ses changements (couleur, luminosité, effet) aux autres nodes WLED en UDP." },
  { id: 'syncrecv', adv: true, group: 'Sync', label: 'Réception sync', path: 'state.udpn.recv', type: 'bool', def: true, write: stW('udpn.recv'), width: 100,
    help: "Applique les changements envoyés par les autres nodes WLED." },
  { id: 'syncgrpS', adv: true, group: 'Sync', label: 'Groupe envoi', path: 'cfg.if.sync.send.grp', type: 'num', write: cfgW('if.sync.send.grp'), width: 90,
    help: "Groupe(s) de sync vers lesquels ce node émet (bitmask 1-255)." },
  { id: 'syncgrpR', adv: true, group: 'Sync', label: 'Groupe récep.', path: 'cfg.if.sync.recv.grp', type: 'num', write: cfgW('if.sync.recv.grp'), width: 95,
    help: "Groupe(s) de sync que ce node écoute (bitmask 1-255)." },
  { id: 'port0', adv: true, group: 'Sync', label: 'Port sync', path: 'cfg.if.sync.port0', type: 'num', def: 21324, write: cfgW('if.sync.port0'), reboot: true, width: 75,
    help: "Port UDP de la synchronisation WLED (21324 par défaut). Redémarrage requis." },
  { id: 'nodesl', adv: true, group: 'Sync', label: 'Liste nodes', path: 'cfg.if.nodes.list', type: 'bool', def: true, write: cfgW('if.nodes.list'), width: 85,
    help: "Maintient la liste des autres nodes WLED du réseau (visible dans /json/nodes, utilisée par la découverte)." },
  { id: 'nodesb', adv: true, group: 'Sync', label: 'Annonce nodes', path: 'cfg.if.nodes.bcast', type: 'bool', def: true, write: cfgW('if.nodes.bcast'), width: 100,
    help: "S'annonce aux autres nodes en broadcast UDP (port 65506)." },

  // ── État : ce qu'il fait maintenant ─────────────────────────────────────
  { id: 'on', group: 'État', label: 'Allumé', path: 'state.on', type: 'bool', write: stW('on'), width: 65,
    help: "Sortie allumée ou éteinte (état courant)." },
  { id: 'bri', group: 'État', label: 'Brightness', path: 'state.bri', type: 'num', write: stW('bri'), min: 0, max: 255, width: 80,
    help: "Luminosité globale courante 0-255." },
  { id: 'ps', group: 'État', label: 'Preset actif', path: 'state.ps', type: 'num', write: stW('ps'), width: 85,
    help: "Preset actuellement actif (-1 = aucun). Écrire un numéro applique ce preset." },
  { id: 'fx', adv: true, group: 'État', label: 'Effet seg. 0', path: 'state.seg.0.fx', type: 'num', watch: false, width: 80, write: stW('seg.0.fx'),
    help: "Numéro de l'effet sur le segment 0." },
  { id: 'pal', adv: true, group: 'État', label: 'Palette seg. 0', path: 'state.seg.0.pal', type: 'num', watch: false, width: 95, write: stW('seg.0.pal'),
    help: "Numéro de la palette sur le segment 0." },
  { id: 'trans', adv: true, group: 'État', label: 'Transition', path: 'state.transition', type: 'num', write: stW('transition'), width: 80,
    help: "Durée de transition courante en dixièmes de seconde." },

  // ── Défauts : ce qu'il fait au démarrage ────────────────────────────────
  { id: 'defon', adv: true, group: 'Défauts', label: 'Allumé au boot', path: 'cfg.def.on', type: 'bool', def: true, write: cfgW('def.on'), width: 100,
    help: "Le node s'allume au démarrage." },
  { id: 'defbri', group: 'Défauts', label: 'Bri boot', path: 'cfg.def.bri', type: 'num', def: 128, write: cfgW('def.bri'), min: 0, max: 255, width: 70,
    help: "Luminosité au démarrage 0-255." },
  { id: 'defps', adv: true, group: 'Défauts', label: 'Preset boot', path: 'cfg.def.ps', type: 'num', def: 0, write: cfgW('def.ps'), width: 85,
    help: "Preset appliqué au démarrage du node (0 = aucun, reprend le dernier état)." },
  { id: 'trdur', adv: true, group: 'Défauts', label: 'Transition déf.', path: 'cfg.light.tr.dur', type: 'num', def: 7, write: cfgW('light.tr.dur'), width: 100,
    help: "Durée de transition par défaut entre deux états, en dixièmes de seconde." },
  { id: 'scalebri', adv: true, group: 'Défauts', label: 'Échelle bri %', path: 'cfg.light.scale-bri', type: 'num', def: 100, write: cfgW('light.scale-bri'), width: 95,
    help: "Facteur global de luminosité en % appliqué à tout (plafond de sécurité, ex. 50 pour brider un costume)." },
  { id: 'gamma', adv: true, group: 'Défauts', label: 'Gamma', path: 'cfg.light.gc.val', type: 'num', def: 2.8, write: cfgW('light.gc.val'), width: 65,
    help: "Valeur de la courbe gamma appliquée aux couleurs (2.2 par défaut, 1.0 = linéaire)." },

  // ── MAJ : maintenance du firmware (voir firmware.js) ────────────────────
  { id: 'fwlatest', adv: true, group: 'MAJ', label: 'Dernière stable', path: 'derived.fw.latest', type: 'str', watch: false, width: 100,
    help: "Dernière release stable connue dans le catalogue pour cette plateforme." },
  { id: 'fwavail', group: 'MAJ', label: 'MAJ dispo', path: 'derived.fw.available', type: 'bool', watch: false, width: 75,
    help: "Oui si la dernière stable est plus récente que la version du node." },
  { id: 'fwstatus', adv: true, group: 'MAJ', label: 'Statut MAJ', path: 'derived.fw.status', type: 'str', nodiff: true, watch: false, width: 130,
    help: "Résumé : à jour / MAJ à télécharger (le .bin n'est pas encore dans le dépôt) / MAJ prête (flashable hors ligne) / plateforme inconnue." },
  { id: 'fwlocal', adv: true, group: 'MAJ', label: 'Dans le dépôt', path: 'derived.fw.latestLocal', type: 'bool', watch: false, width: 95,
    help: "Oui si le .bin de la dernière stable pour cette plateforme est déjà dans le dépôt local (utilisable sans internet)." },
  { id: 'repo', adv: true, group: 'MAJ', label: 'Dépôt source', path: 'info.repo', type: 'str', width: 110,
    help: "Dépôt Git d'où vient le firmware. wled/WLED = officiel ; autre = fork (constructeur, build perso)." },
  { id: 'otalock', adv: true, group: 'MAJ', label: 'OTA verrouillé', path: 'cfg.ota.lock', type: 'bool', width: 95,
    help: "Verrou OTA (Config > Security). Quand actif, le node refuse toute mise à jour par le réseau jusqu'au déverrouillage dans son interface." },
  { id: 'otastate', adv: true, group: 'MAJ', label: 'Flash en cours', path: 'meta.ota.status', type: 'str', nodiff: true, watch: false, width: 95,
    help: "Étape de la mise à jour en cours : en file, envoi, redémarrage, terminé, échec." },
];

const groups = [...new Set(columns.map(c => c.group))];

module.exports = { columns, groups, LED_TYPES, COLOR_ORDERS, WHITE_SWAPS, WHITE_SWAP_TYPES, DMX_MODES,
  LED_MA_PRESETS, LED_MA_MAX, PSU_MA_MIN, PSU_MA_MAX, MA_FOR_ESP, VOLTAGES, ETH_TYPES };
