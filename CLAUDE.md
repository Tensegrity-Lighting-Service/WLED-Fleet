# Règles du dépôt WLED Fleet

Ces règles s'appliquent à **toute** intervention sur ce dossier, humaine ou
assistée par une IA. Elles existent parce que Fleet n'est pas seul : des
logiciels satellites — plugin MA3, scripts, outils tiers — lisent ce qu'il
expose, et des nodes portent sur le terrain ce qu'il y a écrit. Une incohérence
ici ne se voit pas tout de suite ; elle se découvre en production, un an après,
sur un node qui revient d'un hangar.

Trois d'entre elles sont **vérifiées par la suite de tests** : elles ne se
négocient pas, la suite échoue. Les autres sont des conventions ; les respecter
garde le dépôt lisible.

---

## 1. Le contrat d'API — vérifié

`docs/api.md` est **généré** depuis le code. Ne jamais l'éditer à la main.

- Toute route HTTP de `server.js` porte une ligne `// @api …` juste au-dessus,
  qui dit **ce qu'elle fait**, pas comment elle est écrite.
- Après toute modification touchant une route (ajout, suppression, changement de
  méthode, de chemin ou de comportement) :

```bash
node tools/gen-api.js
```

  et le fichier régénéré part **dans le même commit** que le changement.

Ce que les tests refusent : une route sans `// @api`, une route déclarée deux
fois, et un `docs/api.md` qui ne correspond plus au code (`test/api.test.js`).

**Les trois surfaces exposées**, à ne jamais confondre :

| surface | fait autorité sur | décrite dans |
|---|---|---|
| `/json/cfg` du node | ce qui est réellement câblé | le firmware WLED |
| `/fleet.json` du node | ce que Fleet pense de ce node — un **indice** | `docs/fixture-mapping.md` |
| l'API HTTP de Fleet | l'état consolidé de la flotte | `docs/api.md` |

Changer le format de `/fleet.json` ou le schéma d'un produit **oblige** à mettre
à jour `docs/fixture-mapping.md` dans le même commit : ce document est ce sur
quoi les satellites se règlent, et il est publié.

## 2. Les identifiants et les révisions — vérifié

Ce qui est écrit sur un node doit rester vrai des années.

- **Un identifiant attribué n'est jamais réattribué.** Les produits portent un
  uuid v4 frappé à la création ; les anciens identifiants courts sont conservés
  en `legacyId` et continuent de résoudre. Ne jamais renuméroter, ni à la
  migration, ni à l'import d'un showfile.
- **Une révision monte quand les réglages changent, jamais quand le nom change.**
  Sinon tous les nodes déjà patchés se signalent en retard pour une faute de
  frappe corrigée.
- **Un marqueur inconnu se conserve tel quel.** Il vient d'un poste dont le
  catalogue est plus complet ; l'effacer perd l'information pour tout le monde.
- **Une révision plus récente sur le node que dans le catalogue local n'est pas
  une anomalie du node** : c'est ce poste qui est en retard. Ne rien réappliquer.

Couvert par `test/library.test.js` et `test/metadata.test.js`.

## 3. Écrire sur un node — vérifié pour ce qui est testable

- **Les réglages d'abord, le marqueur ensuite.** Un échec entre les deux laisse
  un node sans marqueur — gênant mais honnête. Dans l'autre ordre il
  revendiquerait un produit dont il n'a pas les réglages, ce qui est un mensonge
  durable.
- **Rien ne part sur un node sans un geste explicite de l'utilisateur.** Aucun
  sondage, aucune synchronisation, aucune ouverture d'onglet n'écrit.
- **Une sortie se désigne par sa POSITION dans `hw.led.ins`**, jamais par son
  index de départ : ⚡ Patcher renumérote les départs, et un drapeau indexé
  dessus saute de ligne.
- **En lecture seule (`--readonly`), toute écriture répond 403** sans effet.
- Les noms `cfg.json`, `presets.json` et `palette*.json` sont **interdits** sur
  le système de fichiers d'un node : WLED leur donne un sens.

## 4. Code

- **Français** pour les commentaires et les textes d'interface. L'anglais
  résiduel de l'ancien code n'est pas à traduire au passage.
- Un commentaire dit **pourquoi**, pas quoi. Ceux qui gagnent leur place
  expliquent un piège rencontré, une contrainte extérieure (un comportement de
  WLED, de Tauri, de RouterOS), ou un choix qu'on regretterait d'oublier.
  Paraphraser la ligne suivante ne vaut rien.
- Les fonctions pures qui portent une règle métier vivent dans leur propre
  module (`dmx.js`, `metadata.js`, `library.js`, `columns.js`) : c'est ce qui les
  rend testables sans serveur ni node.
- Toute correction d'un défaut qui a fait perdre du temps **arrive avec son
  test**, et le test dit dans son libellé ce qui cassait.
- Vérifier une affirmation sur WLED **dans le source du firmware** avant de
  l'écrire dans le code ou la documentation. Plusieurs heures ont déjà été
  perdues sur un champ de config que le firmware ne stocke pas.

Avant tout commit :

```bash
node --test "test/*.test.js"
```

## 5. Commits

- **Un commit = un changement qui se tient.** Ni un fourre-tout de fin de
  journée, ni un commit par fichier touché.
- **Sujet** : `wled-fleet: <ce qui change>`, en minuscules, à l'infinitif ou au
  substantif, sans point final, sous 72 caractères. Le préfixe est le composant
  (`wled-fleet:`, `wled-emulator:`, `ap-manager:`).
- **Corps** : ce qui ne se lit pas dans le diff. L'état d'avant et pourquoi il ne
  convenait plus ; ce que le nouveau code garantit ; le piège qu'on ne veut pas
  revoir. Lignes à 76 colonnes environ. Pas de liste de fichiers touchés — le
  diff la donne.
- **Pas d'emoji, pas de préfixes conventionnels** (`feat:`, `fix:`) : le corps
  dit mieux que trois lettres ce qui s'est passé.
- Un commit dont les tests ne passent pas ne se pousse pas.
- Attribution en pied de message quand une IA a écrit le changement :

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## 6. Releases

La version vit à **quatre** endroits, qui doivent rester identiques :
`package.json`, `desktop/Cargo.toml`, `desktop/tauri.conf.json`,
`desktop/embed/package.json`. En manquer un donne une app qui se croit à une
version et s'annonce à une autre.

**Réutiliser un numéro déjà installé ne répare rien.** Le shell n'extrait son
app embarquée que si `.wf-embedded-version` diffère de la version courante
(`ensure_app_dir()`, `desktop/src/main.rs`). Réinstaller le même numéro laisse
donc l'ancien code extrait en place, y compris s'il est cassé. Un correctif qui
doit atteindre une installation existante prend un nouveau numéro — toujours.

Un cinquième suit tout seul, mais seulement au prochain `cargo build` :
`desktop/Cargo.lock`. Le mettre à jour dans le même commit évite de découvrir
l'écart en pleine compilation de release — c'est ce qui a valu un commit de
rattrapage (`394db84`).

Numérotation : `MAJEUR.MINEUR.CORRECTIF`.
**Mineur** dès qu'une surface exposée change — une route, `/fleet.json`, le
schéma d'un produit, le showfile. **Correctif** pour ce qui ne change rien de ce
qu'un satellite voit.

## 6 bis. Les deux canaux

L'application choisit son canal à l'exécution (⚙ Réglages → Application → Canal),
et le réglage vit sur le poste : basculer ne réinstalle rien.

| canal | code source | manifeste suivi |
|---|---|---|
| **stable** | branche `main` | `releases/latest/download/latest.json` |
| **beta** | branche `beta` | `releases/download/beta/latest.json` |

GitHub garantit l'essentiel : `/releases/latest/` ne résout **jamais** vers une
préversion. Le canal stable ne peut donc pas attraper une beta par accident,
même plus récente — et cette garantie ne repose sur rien qu'on ait écrit.

La beta suit une préversion à **tag fixe `beta`** dont on remplace les fichiers à
chaque build (`gh release upload --clobber`). Le tag ne bouge pas, l'URL non
plus, et l'application n'a rien à découvrir. **Ne jamais publier une beta sans
`--prerelease`** : elle deviendrait la « latest » et partirait à tout le monde.

Le travail en cours vit sur `beta` : `node tools/publish-to-github.js --branch beta`.

## Dans l'ordre

1. Tests au vert, `docs/api.md` régénéré, documentation à jour.
2. Bump des quatre versions, commité à part.
3. `cd desktop && build-release.cmd` — compile, signe, écrit `latest.json`.
   Le script **échoue** si la clé de signature ou le `.sig` manquent : c'est
   voulu, une release non signée ne peut pas être installée par l'updater.
   **Pour une beta, réécrire le manifeste ensuite** :
   `node tools/make-latest-json.js --tag beta`. Sans ce drapeau il désigne
   `releases/download/v<version>/…`, un tag qui n'existe pas sur ce canal :
   l'app annoncerait la mise à jour puis téléchargerait un 404.
4. Publier le code source : `node tools/publish-to-github.js` (ajouter
   `--branch beta` pour une beta).
5. Publier la release, **trois fichiers** (`setup.exe`, `.sig`, `latest.json`) :
   sans `latest.json` aucune app installée ne voit la mise à jour, sans `.sig`
   elle la refuse. Pour une beta, sur le tag `beta`, avec `--prerelease`.
6. Vérifier depuis une app installée, **sur le bon canal**, que la mise à jour
   est proposée — et qu'elle ne l'est PAS sur l'autre.

**La clé de signature ne se perd pas.** `%USERPROFILE%\.tauri\wled-fleet-updater.key`
et son mot de passe : sans elle, plus aucune installation existante ne peut être
mise à jour — il faudrait réinstaller à la main partout.

## 7. Secrets

Ne **jamais** faire sortir d'ici : le jeton GitHub, les identifiants de
l'antenne, les mots de passe WiFi, la clé de signature. Quatre endroits à tenir
cohérents pour chaque nouveau fichier sensible :

`.gitignore` · `EXTRA_EXCLUDE` de `tools/publish-to-github.js` ·
`EXCLUDE_FILES` de `desktop/build.rs` · l'export de showfile.

En manquer un, c'est pousser un secret dans un dépôt public.

---

## Pour une IA qui reprend ce dépôt

Avant de proposer quoi que ce soit :

1. Lire `docs/api.md` et `docs/fixture-mapping.md` — ce sont les engagements
   déjà pris auprès des satellites.
2. Lancer `node --test "test/*.test.js"` : les libellés des tests disent quels
   défauts ont déjà coûté cher.
3. Ne pas affirmer un comportement de WLED, de Tauri ou de RouterOS sans l'avoir
   vérifié dans leur source. Dire « je n'ai pas vérifié » est toujours préférable
   à une affirmation confortable.
4. Après un changement d'API : `node tools/gen-api.js`, dans le même commit.
