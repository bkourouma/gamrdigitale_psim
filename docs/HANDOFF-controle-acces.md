# Passation — chantier « Contrôle d'accès »

> **Actualisation du 17 octobre 2026, après reprise :** les branches `acces-integration` et `acces-regles` ont été fusionnées par avance rapide dans `main` (tête `9be9987`). L'arbre final avec les modifications téléphoniques locales réappliquées passe 4 720 tests, sans échec ni test ignoré, ainsi que `npm run typecheck`. Le texte ci-dessous conserve l'état historique au moment de l'arrêt et sa liste de points à vérifier. Les essais sur le contrôleur Dahua réel, l'issue de secours et la revue visuelle restent à faire avant R3.

Dernière mise à jour : 17 octobre 2026, session « PRD — Contrôle d'accès » (chef de projet Opus, superviseurs Sonnet).
Arrêté à la demande de l'utilisateur pendant la vague 3. Autres passations : [catalogue](HANDOFF-catalogue.md),
[portail](HANDOFF-portail.md), [Tuya](HANDOFF-tuya.md).

Références : `docs/PRD-CONTROLE-ACCES.md` (le besoin), **`docs/CONTROLE-ACCES.md` (contrat commun : décisions, format
des messages, lots, protocole de synchronisation § 7)**, `docs/ACCES.md` (API, écrans, guides installateur et
opérateur, volume, limites), `docs/COMMANDES.md` (canal de commande signé, § 8 revue), `docs/PASSERELLE.md`,
`gateway/docs/acces-dahua.md`, `gateway/docs/acces-zkteco.md`, fiche de recette `qualification/` « controle-acces ».

## 1. Résumé

Phase 1 (supervision, journal, alarmes, ouverture à distance) et l'essentiel de la phase 2 (rapports, portail) sont
**dans `main`**. Restent **hors de `main`** : les titulaires de badges et leur synchronisation vers les contrôleurs
(écrits et testés séparément, intégration commencée), et les règles d'accès + l'armement des portes (vague 3, en
cours). Aucun matériel réel n'a été essayé : tout est validé contre des faux contrôleurs. Rien n'est poussé.

## 2. Dans `main` (tête au moment de l'arrêt : `5e7bd5a`, avancée ensuite par la session « agents / rondes »)

| Lot | Contenu | Commits clés |
|---|---|---|
| Contrat | `docs/CONTROLE-ACCES.md` | 77a7676, 44c9613, deafa67 |
| AC0 | Canal de commande corrigé (M3, A6, H2, S1-S6, A1-A5, H1, catch HTTP ; garde-fous `test/garde-*.test.ts`), ré-authentification `server/reauth.ts` (champ `reauth`), pilote de commandes côté passerelle `gateway/src/actuators.ts` (`ctx.onActuator`), essai bout en bout | 47d6038 … 2cdf348 |
| AC1 + AC6 (v1) | Modules passerelle `acces-dahua`, `acces-zkteco`, code commun `acces-commun`, faux contrôleurs, `clock_drift`, fiche de recette, registre « à qualifier » | fusion 9843dc5 |
| AC2 | `server/access.ts`, `server/accessapi.ts` : journal des passages, déduplication, différé, état des portes, escalade « maintenue ouverte », recherche, export CSV, purge (90 jours) | dc21510 |
| AC3, AC3b, AC3c | Écran « Accès » (`web/access.js`), portes sur le plan, fiche de porte, déclaration ; relecture vidéo Dahua `cam/playback` par `server/video.ts` ; 12 retouches UI/UX | 33097a6, 0e5d2bf, 53240aa (fusion 054eb60) |
| F27, F28 | Section accès du rapport (`server/accessreport.ts`), agrégat anonyme vers le portail (`server/accessportal.ts`), test de confidentialité | 3350c75 (avance rapide 6f52eb2) |
| AC4 | Lien porte ↔ actionneur, F18, mode de porte F19 (stockage), « Tout ouvrir » F20 (`server/accessremote.ts`), composant `web/dooractions.js` (événement `psim:door-card`), action `evacuate` 15 min administrateur, refus de supprimer un actionneur relié | f625a02 … 2c2b0ea |

Vérifié par le chef sur `main` : typecheck propre à chaque avance ; suite complète à 6f52eb2 = 3337/3346 (9 échecs de
charge, tous verts relancés seuls). Dernier chiffre de branche : AC4 à 2c2b0ea = 3717/3719, 0 échec (1 ignoré :
test 5a mode de porte, 1 annulé sous charge). **La suite complète n'a pas été relancée sur `main` après 2c2b0ea.**

Mesures (boucle locale, faux Dahua) : porte forcée → incident 4-6 ms (objectif < 3 s) ; ordre d'ouverture → accusé
p95 185 ms (objectif < 2 s) ; 900 000 passages : toute recherche < 2 s, export 100 000 lignes 2,1 s, ingestion
1,5 ms/message.

## 3. Hors de `main`

| Branche (worktree `.claude/worktrees/<branche>`) | Tête | État |
|---|---|---|
| `acces-titulaires` | aacf176 | **Fini et vert sur sa branche** (AC5 : titulaires, badges, groupes, plages, jours fériés, visiteurs, import CSV, synchronisation signée § 7 côté PSIM, droits MQTT `.../sync`, écran `web/holders.js`). Inclus dans `acces-integration`. |
| `acces-passerelle` | 770f4fc | **Fini et vert sur sa branche** (suite : `door_mode`, Duress → `panic`, `epoch`, socle de synchronisation `gateway/src/accesssync.ts`, gestionnaires Dahua/ZKTeco, `registerActuator` qui n'empêche plus la remontée des passages). Inclus dans `acces-integration`. |
| `acces-integration` | 37ff725 | Fusion des deux précédentes **faite sans conflit** (18f4848, adb2e6b) sur `main` 054eb60, puis **travail en cours commité tel quel** (37ff725 : `server/accesssync.ts`, `test/accesssync.test.ts`, `test/accesssync-interop.test.ts`, `test/e2e-acces-sync-chaine.test.ts`). Typecheck propre, **tests non lancés**. |
| `acces-regles` | 922392d | Part de `acces-titulaires`. **Travail en cours commité tel quel** : `server/accessrules.ts`, `accessarming.ts`, `accessrulestypes.ts`, `web/holderref.js`, tests, retouches de `rules.ts`, `arming.ts`, `access.ts`, `engine.ts`, `sources.ts`, `web/access.js`, `incidents.js`, `rules.js`. Typecheck propre, **tests non lancés**. Fichier parasite non suivi `=` (sortie de la commande Windows `AT`) à supprimer. |

## 4. Pour reprendre, dans l'ordre

1. **`acces-integration`** — relire 37ff725 (`git show 37ff725`), puis terminer :
   - interopérabilité § 7, point par point (a à j du brief) : `code` null écrit vide dans la chaîne canonique ;
     vecteurs fixes de `gateway/test/accesssync.test.ts` repris côté PSIM ; réessai **même `seq`** sans accusé,
     **nouveau `seq`** après un accusé `error`/`refused` (seul `error/unreachable` laisse le `seq` libre) ; délai
     passerelle 300 s contre 10 s PSIM (accusé tardif accepté) ; `set_holidays` avec `dates: []` ; plage « Tout le
     temps » en deux demi-journées ; refus Dahua `holidays: true` affiché clairement ; remise à zéro conjointe du `seq`
     au renouvellement de clé ; droits MQTT vérifiés avec le vrai client ; `gateway_id` = nom du compte MQTT ;
   - essai bout en bout réel : titulaire → cartes et plages dans le faux contrôleur ; « désactiver le badge » → carte
     gelée (P3) et passage refusé remonté avec `holder_id` ; coupure et redémarrage sans perte ni doublon ; mesure ;
   - traduction de `evacuate` dans `gateway/src/modules/acces-commun/actuator.ts` (porte maintenue ouverte puis mode
     normal ; portail : ouvrir) et mise à jour du scénario 2b de `test/e2e-acces-chaine.test.ts` ;
   - activation du test 5a « mode de porte » de `test/e2e-acces-chaine.test.ts` (maintenant que `door_mode` existe) ;
   - **décision utilisateur** : un opérateur peut désactiver un badge perdu ou volé ; réactiver reste administrateur
     (`server/accessholdersapi.ts`, `web/holders.js`, tests de rôles) ;
   - `git merge main` (main a avancé), typecheck, `npm test` complet, puis avance rapide de `main`.
2. **`acces-regles`** — relire 922392d ; terminer F15 (badge d'un groupe hors horaires via `canPass`, badge surveillé,
   N refus sur M portes en T s) et F14 (ouverture pendant l'armement = pré-alarme sauf groupe en droit à cet instant) ;
   tests, essai réel, navigateur ; puis `git merge main` (qui contiendra l'intégration) et avance rapide.
3. Vérification finale sur `main` : `npm test` complet, essai visuel (écran Accès, Titulaires, Règles), mise à jour de
   la mémoire et de ce document.
4. Plus tard (décision utilisateur) : F16 badge + visage, quand la caméra à reconnaissance faciale sera là.

## 5. Décisions (en plus du contrat § 1)

Utilisateur : phase 2 maintenant ; règles d'accès maintenant, badge + visage plus tard ; pilote **contrôleur Dahua à
la Résidence KOUROUMA** ; conservation **3 mois** ; « Ouvrir N minutes » = **impulsion seule par défaut**
(l'administrateur relève `maxS` de `unlock` dans le PSIM **et** dans la section `actuators` de la passerelle) ;
« Tout ouvrir » **15 min puis reverrouillage** ; une alarme feu **n'ouvre jamais** les portes d'elle-même ;
**un opérateur peut désactiver** un badge perdu.

Chef : code PIN non géré par le PSIM (reste dans le contrôleur) ; Dahua « fermé les jours fériés » refusé
(`not_supported`) tant que non qualifié ; Duress → `panic` ; `epoch` par contrôleur (procédure « remplacement d'un
contrôleur » dans `gateway/docs/acces-*.md`) ; rejeu de 24 h au premier démarrage (Dahua) ; une erreur de
configuration des commandes ne coupe jamais la remontée des passages ; issue de secours : `evacuate` ouvre, `lock`
jamais envoyé ; rapport sans liste nominative (jamais, dans cette version).

## 6. À qualifier sur le matériel réel (tout est marqué « A QUALIFIER » dans le code et les docs)

- **Dahua** : valeurs `Method` 4 (distance) et 5 (bouton) ; table `ErrorCode` (motifs de refus) ; noms des codes
  `DoorStatus`, `DoorNotClosed`, `BreakIn`, `ChassisIntruded` ; numérotation des portes (`doorBase`) ;
  `recordFinder` (formats d'heure, absence de `RecNo` sur certains ASI) ; `AccessControl[i].State` ;
  `AccessControlCard` sur un ASC1204 ; clés `AccessTimeSchedule` / `AccessControlHoliday` ; `CardType = 5`
  (contrainte) ; `UserID` alphanumérique `H<id>` ; relecture `cam/playback` (format et fuseau de `starttime`, délai
  avant qu'un passage récent soit relisible).
- **ZKTeco** : table des événements, champs `rtlog`, format de `CONTROL DEVICE`, sémantique de `DATA UPDATE`, codes
  `Return`, événements 9/10/204/205 (mode de porte), capacité de 50 plages.
- Latences réelles, ouverture et retour à l'état sûr, issue de secours sans PSIM (coupure de courant → porte libre).

## 7. Points ouverts et limites connues

- Canal de commande : AAD sur la clé chiffrée non fait ; M2 documenté ; pas de reprise automatique après « retour au
  repos ABANDONNÉ » (20 échecs) : un humain vérifie sur place.
- `PSIM_INGEST_MAX_AGE_S` (7 j par défaut, 30 au plus) borne l'âge des passages récupérés après coupure.
- Un `door_closed` efface l'état « sabotage » du détecteur (l'incident reste ouvert jusqu'à l'opérateur).
- ZKTeco « push » : en clair et sans authentification → réseau dédié, listes blanches `allowFrom` et numéros de série.
- aedes ne borne pas la file d'une session persistante : passerelles en `clean: true` recommandé.
- Fichier d'état de synchronisation perdu côté passerelle : un ancien message capturé peut être rejoué jusqu'à
  l'opération suivante (écrit en tête de `gateway/src/accesssync.ts`).
- Non vérifié dans un navigateur : écrans d'évacuation, composant AC4 avec un vrai accusé.

## 8. Instabilités de tests (sous charge, passent seuls)

`test/floors.test.ts` (ECONNRESET), `gateway/test/modbus.test.ts`, `gateway/test/sia.test.ts`,
`test/production.test.ts`, `test/e2e-resilience.test.ts`, `test/e2e-security.test.ts` (« mode démonstration »),
`test/e2e-rules.test.ts`, `test/e2e-portal-access.test.ts`. Ne pas lancer plusieurs `npm test` en parallèle.

## 9. Pièges

- `main` contient des modifications **non commitées** d'une autre session (téléphone Android : `.env.example`,
  `server/config.ts`, `server/main.ts`, `server/notifications.ts`, `test/phonegateway.test.ts`). À chaque avance :
  copie du diff, mise de côté **étiquetée**, `git merge --ff-only`, réapplication. La pile de `git stash` est
  **partagée** entre worktrees et sessions : retrouver son entrée par son étiquette ou son SHA, `apply` puis `drop`,
  jamais un `pop` à l'aveugle.
- La session « agents / rondes » fusionne aussi dans `main` : toujours vérifier `merge-base --is-ancestor` avant.
- Superviseurs : lancer les exécutants **au premier plan**, sinon la plateforme leur fait rendre la main avant la fin.
- Navigateur intégré : les cookies de session ignorent le port sur `127.0.0.1` → un hôte `<nom>.localhost:<port>`
  par serveur d'essai.
- Ne jamais `git worktree remove` un worktree dont `node_modules` est une jonction (voir HANDOFF-catalogue).

## 10. À faire par l'utilisateur

1. Choisir et acheter le contrôleur Dahua du pilote (Résidence KOUROUMA), puis faire la recette (`qualification/`).
2. Faire valider par un juriste la durée de conservation et l'information des personnes (loi 2013-450) ; ARTCI avant
   tout lecteur biométrique.
3. Supprimer `D:\tmp_full.txt` (fichier parasite laissé par un agent) et `.claude/worktrees/acces-regles/=`.
4. Décider quand pousser `main` (rien n'a été poussé).
