# Qualification en atelier du matériel

**Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier. Chaque équipement est marqué `qualified` ou `to_qualify`.**

Ce document décrit, de A à Z, comment un responsable d'atelier qualifie un modèle de matériel, qui signe, où ranger les résultats, et comment un pack vérifie que ses références sont qualifiées.

> **Honnêteté sur l'état de départ.** Le PSIM, la passerelle et les packs ont été éprouvés avec des équipements **simulés**. Seuls deux constats ont été faits sur du matériel réel : **une voie d'un enregistreur Dahua DH-XVR5108HS-I3/T** (flux et événements de détection) et **un détecteur de fumée WiFi Tuya** (lecture réelle du cloud). Tout le reste est `to_qualify`, y compris le XVR5104HS-I3, la caméra HAC-HFW1500TH-I8 et le détecteur Heiman HS1SA-E cités dans les packs. Un essai simulé (tests automatiques, `npm run bench`) ne qualifie jamais un matériel.

## 1. Les trois statuts

| Statut | Sens | Qui peut le donner |
|---|---|---|
| `to_qualify` | À qualifier : aucune recette réussie sur du matériel réel. Statut de départ de tout modèle. | automatique ; ou retiré par `set-status` |
| `qualified` | Recette réussie en atelier **avec le matériel réel**, fiche signée, résultat rangé. Vaut pour la **portée** écrite au registre, pas au-delà. | **seulement** `promote`, sur un fichier de résultat complet |
| `rejected` | Essayé et refusé (instable, dangereux, incompatible). Ne doit entrer dans aucun pack. | `set-status`, avec la raison |

Les deux modèles qualifiés avant l'existence de cet outil sont des **constats historiques** (README et `docs/HANDOFF-tuya.md`), sans fiche signée. Leur liste est figée **dans le code** (`LEGACY_QUALIFIED` dans `qualification/registry.ts`) : le registre seul ne peut pas en ajouter un autre.

## 2. Qui fait quoi, qui signe

| Rôle | Mission |
|---|---|
| **Testeur** | Monte le banc, déroule la fiche étape par étape avec le matériel réel, relève les mesures, remplit et signe la fiche, saisit le résultat (`record`). |
| **Responsable d'atelier** | Relit la fiche signée, contrôle le résultat, écrit la **portée** (ce qui est réellement validé), puis lance `promote` **sous son nom** (`--by`). C'est lui qui engage la qualification. Idéalement une autre personne que le testeur. |
| **Chef de projet / vendeur de packs** | Ne modifie jamais le registre à la main ; vérifie ses packs avec `check-pack`. |

Chaque changement de statut est consigné dans le registre : **qui**, **quand**, **depuis quel statut**, **sur quel fichier de résultat** et **pourquoi**.

## 3. Où sont les fichiers

| Fichier | Rôle |
|---|---|
| `qualification/registry.json` | Le registre : une entrée par modèle ou famille de modèles. **Les statuts ne se changent qu'avec `npm run qualify`** (écriture atomique, validation stricte avant écriture) ; seule exception, l'ajout à la main d'une nouvelle entrée `to_qualify` (voir 4.1), que la validation contrôle. |
| `qualification/fiches.json` | Source unique des fiches : gabarits d'étapes communs, fiches par famille, profils, critères chiffrés. |
| `docs/qualification/<fiche>.md` | Les fiches de recette imprimables, une par famille, **générées** depuis `fiches.json` (ne pas les modifier à la main : `npm run qualify -- docs`). |
| `qualification/results/<id>-<date>.json` | Les résultats d'essai. **À conserver et à versionner** : ils justifient le statut. Jamais écrasés (un second essai le même jour reçoit le suffixe `-2`). |
| La fiche papier ou PDF signée | À ranger avec le dossier de l'équipement ; le nom du fichier de résultat y est inscrit. |

Familles de fiches : `zigbee`, `modbus` (contacts secs et mesures), `onduleur`, `lorawan`, `sia` (centrales d'alarme), `tuya`, `camera-onvif`, `enregistreur-dahua`, `mqtt-ingest` (équipements directs ou à développer), `notifications`, `socle` (mini-PC, onduleur, routeur 4G, switch PoE, parafoudre).

## 4. Le processus, pas à pas

### 4.1 Trouver le modèle dans le registre

```
npm run qualify -- list --status to_qualify
npm run qualify -- list --family video
npm run qualify -- show heiman-hs1sa-e
```

Si le modèle n'y est pas : **ne rien essayer avant de créer son entrée**. Une entrée se copie d'un modèle voisin du même profil dans `registry.json` (même fiche, même profil, `status` à `to_qualify`, `last_trial` à `null`, `history` vide), puis `npm run qualify -- verify` la contrôle. Un modèle voisin déjà qualifié **ne qualifie pas** le nouveau : chaque référence a sa propre entrée.

### 4.2 Imprimer la fiche

```
npm run qualify -- sheet heiman-hs1sa-e --out fiches-a-imprimer
```

Produit `fiche-<id>.html` (à imprimer ou enregistrer en PDF) et `fiche-<id>.md`, avec le résumé du modèle, le statut actuel et la portée déjà validée. Les fiches génériques de chaque famille sont aussi dans `docs/qualification/`.

### 4.3 Dérouler la fiche avec le matériel réel

Chaque fiche contient : le **matériel nécessaire**, le **montage du banc d'essai**, des **étapes numérotées** avec le résultat attendu, des **critères de réussite et d'échec chiffrés**, et les champs à remplir (numéro de série, firmware, versions du PSIM et de la passerelle, testeur, date, température et humidité du local).

Les étapes couvrent, selon la famille : déclenchement, retour à la normale, répétabilité (10 cycles sur 10), latence mesurée (pire délai), batterie faible, sabotage, coupure de liaison, rétablissement, **silence d'un capteur (affiché « Hors ligne », jamais « Normal »)**, redémarrage brutal du PSIM, coupure réseau puis renvoi daté, et **conditions tropicales (35 °C, 90 % d'humidité)**.

- Une étape **OBLIGATOIRE** doit être à `pass`.
- `fail` : l'étape a échoué ; une remarque est obligatoire. **Un seul `fail`, même sur une étape facultative, empêche la qualification.**
- `na` : non applicable ; la raison est obligatoire. Autorisé seulement pour les étapes facultatives (par exemple l'essai tropical quand aucune enceinte n'est disponible, ou le sabotage d'un capteur sans autoprotection : la limite reste alors au dossier).
- Une étape à mesure chiffrée (`latence_max_s`, `silence_detecte_s`…) n'est `pass` que si la valeur relevée est **dans ses limites**.

Avant de se déplacer ou d'ouvrir l'atelier, on peut vérifier que la fiche elle-même se déroule : `npm run bench -- <id-du-modèle>` (voir 6).

### 4.4 Saisir le résultat

```
npm run qualify -- record heiman-hs1sa-e --template > saisie.json
# remplir saisie.json : date, testeur, numéros de série, firmware, versions testées,
# conditions (matériel réel : true), un résultat par étape, les mesures
npm run qualify -- record heiman-hs1sa-e --file saisie.json
```

`record` **refuse** tout champ manquant, toute étape absente ou inconnue, un `fail`/`na` sans remarque, une mesure absente ou hors limite sur une étape `pass`, une date future, une version de passerelle absente pour un équipement qui passe par la passerelle. Il écrit `qualification/results/<id>-<date>.json` et **ne modifie pas le statut**.

Le champ `conditions.real_hardware` doit dire la vérité : `true` seulement si l'essai a été fait avec l'équipement réel. Un résultat avec `false` (banc simulé, démonstration) est enregistrable pour la trace, mais **ne pourra jamais qualifier**.

### 4.5 Qualifier

Le responsable d'atelier relit la fiche signée et le résultat, puis :

```
npm run qualify -- promote heiman-hs1sa-e \
  --result qualification/results/heiman-hs1sa-e-2026-10-20.json \
  --by "Nom du responsable d'atelier" \
  --scope "Un exemplaire HS1SA-E, firmware 1.2.3, Zigbee2MQTT 1.40 : alarme, retour, pile faible, silence, redémarrage PSIM ; 31 °C" \
  --not-covered "Conditions tropicales non essayées ; autres firmwares"
```

`promote` ne qualifie que si **toutes** les conditions sont réunies : essai sur **matériel réel**, toutes les étapes obligatoires à `pass`, aucune étape en `fail`, mesures dans leurs limites, résultat rangé dans `qualification/results/`, fiche **inchangée** depuis l'essai (sinon il faut refaire l'essai), modèle non rejeté. Sinon il **liste tout ce qui manque** et ne change rien. En cas de succès il inscrit la portée, l'empreinte (SHA-256) du fichier de résultat, la date, les versions testées, et une ligne d'historique (qui, quand).

La **portée** (`--scope`) est obligatoire : elle dit précisément ce qui est validé (« une voie, détection de mouvement », « un exemplaire, firmware X »). Elle s'affiche dans `show`, sur les fiches et dans `check-pack`.

### 4.6 Retirer ou refuser

```
npm run qualify -- set-status heiman-hs1sa-e rejected --by "Nom" --reason "se bloque après 2 h de fonctionnement"
npm run qualify -- set-status heiman-hs1sa-e to_qualify --by "Nom" --reason "firmware corrigé, nouvel essai"
```

Un modèle `rejected` doit d'abord être remis à `to_qualify` (avec la raison) avant tout nouvel essai. **On ne peut jamais passer à `qualified` par `set-status`.**

### 4.7 Quand refaire l'essai

- Autre **référence** ou autre **révision matérielle** : nouvelle entrée, nouvel essai.
- Nouveau **firmware** de l'équipement, nouvelle version majeure du **module** de la passerelle ou du PSIM qui touche ce raccordement : refaire au moins les étapes de détection, de silence et de redémarrage, puis `promote` à nouveau.
- Fiche modifiée dans ses étapes, ses obligations ou ses limites : les anciens résultats ne suffisent plus (`verify` le signale).
- Portée élargie (autres voies d'un enregistreur, autres capteurs du même type) : nouvel essai sur le nouveau périmètre.

## 5. Les packs : ne contrôler que du qualifié

### Ligne de commande

```
npm run qualify -- check-pack packs/pack-standard.json
npm run qualify -- check-pack packs/pack-standard.json --strict
```

Le pack attendu a la forme minimale `{ "devices": [ { "model": "DH-XVR5104HS-I3" }, … ] }`. Le nom d'un modèle peut être l'identifiant du registre, un alias, ou le fabricant suivi de l'alias, sans souci de casse, d'espaces ni de tirets (`Dahua HAC-HFW1500TH-I8`). La commande liste chaque modèle distinct avec son statut, et **échoue (code 1)** si un modèle n'est pas `qualified` ou est absent du registre. Un pack sans `devices`, ou un appareil sans `model`, est toléré (avertissement) ; `--strict` refuse un appareil sans modèle.

### API pour l'importeur de packs

```ts
import { isQualified, qualificationStatus, resolveModel, checkPackModels } from '../qualification/registry.ts';

isQualified('heiman-hs1sa-e');            // false (à qualifier)
isQualified('tuya-smoke-wifi');           // true
qualificationStatus('inconnu');           // 'unknown'
resolveModel('Dahua HAC-HFW1500TH-I8');   // l'entrée du registre, ou null
checkPackModels(['DH-XVR5104HS-I3', 'tuya-smoke-wifi']);
// [{ name, entry, status: 'qualified' | 'to_qualify' | 'rejected' | 'unknown', ok, count }]
```

- `isQualified(id)` est vrai **seulement** pour un modèle `qualified`. Un identifiant inconnu, à qualifier ou rejeté donne `false`.
- Un registre **illisible ou invalide fait lever `RegistryError`** : on échoue fermé, jamais ouvert. L'importeur doit refuser le pack dans ce cas.
- Chaque appel relit le registre (petit fichier) : pour un pack entier, préférer `checkPackModels` (une seule lecture).
- Les packs ne modifient jamais le registre ; seule la commande `npm run qualify` l'écrit.

## 6. Le banc simulé : vérifier les fiches, pas le matériel

```
npm run bench -- --all                        toutes les fiches, tous les profils
npm run bench -- zigbee --profile mouvement   une fiche
npm run bench -- heiman-hs1sa-e               la fiche d'un modèle du registre
```

Le banc rejoue **sans matériel** la séquence d'une fiche contre un vrai moteur PSIM jetable (base temporaire, horloge simulée) : déclenchement, retour, répétition, défaut, sabotage zone désarmée, coupure de liaison, silence (état « Hors ligne », notification « détecteur muet »), arrêt brutal et redémarrage, renvoi daté après coupure (doublons, ordre inversé). **Une étape de fiche qu'on ne sait pas dérouler, ou dont le résultat attendu contredit le PSIM réel, est un défaut de la fiche.** Les étapes qui demandent un humain devant l'équipement (gestes, mesures, signatures) sont marquées « physiques » et ne sont pas rejouées.

Le banc simulé :
- ne crée aucun fichier de résultat et ne touche pas au registre ;
- affiche et enregistre toujours `real_hardware: false` ;
- ne peut donc **jamais** qualifier un équipement.

## 7. Vérifier le tout

```
npm run qualify -- verify
```

Contrôle le registre (structure, doublons, statuts, historique), la présence de chaque fiche, et pour chaque modèle `qualified` (hors constats historiques) : fichier de résultat présent, **intact** (empreinte), sur matériel réel et toujours valable pour la fiche actuelle. Les tests automatiques (`test/qualification.test.ts`) font de même et échouent si un modèle est marqué `qualified` sans résultat matériel.

## 8. Format du registre (référence)

Chaque entrée : `id` (stable), `family`, `manufacturer`, `model`, `kind` (`model` ou `generic`), `aliases`, `connection` (`existing`, `gateway` + `module`, ou `to_develop`), `fiche` et `profile`, `status`, `scope` (ce qui est validé), `not_covered`, `last_trial` (date, référence, versions PSIM / passerelle, matériel réel oui/non, conditions, numéros de série, firmware, fichier de résultat et empreinte), `simulated_tests` (tests automatiques qui ont éprouvé le raccordement avec des équipements simulés : ils ne qualifient pas), `history` (qui, quand, de quel statut à quel statut, pourquoi) et `notes`. Toute clé inconnue est refusée.

Règles vérifiées à chaque lecture et à chaque écriture : identifiants et alias uniques ; fiche et profil existants ; un modèle `qualified` a un dernier essai sur **matériel réel** avec fichier de résultat et numéro de série (sauf les deux constats historiques figés dans le code) ; un modèle `rejected` explique pourquoi ; l'historique enchaîne les statuts.

## 9. Limites

- Les fiches et leurs seuils chiffrés (latences, silences, autonomie…) sont des **propositions de départ** tirées de la documentation du PSIM et de la passerelle ; le responsable d'atelier peut les durcir dans `qualification/fiches.json` (puis `npm run qualify -- docs`). Toute modification des étapes, obligations ou limites invalide les anciens résultats, volontairement.
- L'outil ne **prouve** pas qu'un essai a eu lieu : il garantit que rien n'est qualifié sans un résultat complet, signé par un nom, daté, intact, et déclaré sur matériel réel. La confiance repose sur la signature du responsable d'atelier et la conservation de la fiche papier.
- Aucune dépendance npm n'est ajoutée ; l'outil ne parle ni au PSIM de production ni à ses données.
