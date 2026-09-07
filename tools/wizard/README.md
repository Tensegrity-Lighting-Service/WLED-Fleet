# tools/wizard — WiFiman Wizard côté PC

Trois scripts Python (3.9+, `pip install bleak`) ; le serveur Node lance le
premier, les deux autres servent à la découverte et au débogage du protocole
(`../../docs/wizard-protocol.md`).

| Script | Rôle |
|---|---|
| `wizard_bridge.py` | lancé par `wizard.js` : connexion BLE au Wizard, flux NDJSON sur stdout (`--list`, `--address`, `--mock`, `--raw`) |
| `wizard_decode.py` | le protocole du Wizard : trames, API 1.0 (version, identité, stats, `trigger_scan`, `get_scan_result`), décodage des résultats ; rejoue un journal ou teste en direct |
| `wizard_probe.py` | sonde générique : scan BLE, dump GATT, notifications brutes dans `wizard-probe.log` |
| `test_wizard_decode.py` | tests hors ligne (trames, ré-assemblage, corps réels du firmware 1.9.0) |

```sh
python wizard_bridge.py --mock                       # environnement simulé, sans matériel
python wizard_bridge.py --list                       # appareils BLE autour du PC (Wizard marqués likely)
python wizard_bridge.py --address 74:FA:29:30:C0:38  # ce que le serveur lance
python wizard_decode.py --address 74:FA:29:30:C0:38 --seconds 30 [--raw]   # test direct, réseaux en JSON
python wizard_decode.py wizard-probe.log             # rejoue un journal (sonde ou --raw)
python wizard_probe.py                               # scan, Wizard probables marqués ★
python wizard_probe.py --address 74:FA:29:30:C0:38 --seconds 60            # dump GATT + notifications
python -m unittest test_wizard_decode                # tests hors ligne
```

Sous Windows : `python` peut être l'alias du Microsoft Store (`py -3` marche
toujours ; `wizard.json` accepte `"python": "py -3"`). Bluetooth du PC actif,
Wizard allumé et libre : couper le Bluetooth de l'iPhone, une seule connexion
à la fois. Après une déconnexion le Wizard reste invisible environ une minute ;
les scripts attendent son annonce jusqu'à 60-90 s. Si Windows garde une table
GATT périmée après une mise à jour du firmware, supprimer le Wizard dans
Paramètres > Bluetooth puis reconnecter.
