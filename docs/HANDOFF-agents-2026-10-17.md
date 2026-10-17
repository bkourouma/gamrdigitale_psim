# Passation : application des agents (17 octobre 2026)

Point de reprise du chantier « application des agents sur téléphone » : alarmes, rondes NFC et QR, SOS, main courante.
Il est rédigé par le chef de projet à la fin de la session du 17/10/2026.

## Où lire

| Document | Contenu |
|---|---|
| `docs/PRD-APPLICATION-AGENTS.md` | Le besoin (PRD) |
| `docs/AGENTS-RONDES.md` | **Contrat technique figé** et avenants 1 à 4 : décisions de l'utilisateur et du chef, tables, routes, formes JSON |
| `docs/ESSAI-AGENTS-KOUROUMA.md` | Guide pas à pas et check-liste de l'essai réel à la Résidence KOUROUMA |

## État

**Tout est dans `main`** (dernier commit du chantier : 5e7bd5a). La suite complète comptait 3 788 tests, dont
3 787 réussis, 0 en échec et 1 sauté ; quelques tests de délai échouent parfois sous charge et passent quand on les
relance.

| Lot | Contenu | Fusion |
|---|---|---|
| S1 | Serveur : rôle `agent`, appairage par cookie `psim_phone`, connexion par code, service, rondes (`server/patrols.ts`, `server/patrolmachine.ts`), SOS, main courante, routes `/api/agent/*`, `/api/agents*`, `/api/agent-phones*`, `/api/patrols/*` | b81d371 |
| S2 | Écran administrateur « Rondes » : points sur le plan, planche d'étiquettes, circuits, agents, téléphones, journal (`web/patrols.js`, `web/agents-admin.js`) | b81d371 |
| S3 | Application de l'agent, installable depuis le navigateur (`web/agent/`) : alarmes, ronde NFC, QR ou saisie, SOS maintenu 2 s, mode discret, envois gardés hors ligne | b81d371 |
| S4 | Agents sur le plan du poste, « qui se déplace », rapport de rondes (`server/patrolreport.ts`), portail (`SiteSummary.patrols`, sans noms) | 474a1cb |
| S5 | Essai d'intégration avec le vrai serveur, 8 écarts corrigés | c6bcf7e |
| S6 | Textes par catégorie (plus de texte d'incendie sur un SOS), SOS acquitté non ré-armé, codes d'étiquettes masqués à l'opérateur | b2bebb6 |
| S7 | Autorité de certificat locale pour les téléphones (`make-cert`), `npm run check-agents[:prod] [-- --live]`, guide d'essai, QR de 35 mm, adresse NFC = `PSIM_PUBLIC_URL` | 5e7bd5a |

## Décisions de l'utilisateur (17/10)

- Application installable depuis le navigateur d'abord ; coquille Android ensuite (lot AG6, **non lancé**).
- Étiquettes NFC et QR.
- Périmètre : exigences M, plus les S faisables sans Android.
- Position = dernier point scanné, pas de GPS.
- Pilote : Résidence KOUROUMA, avec un agent salarié du client. Le client informe l'agent par écrit (un modèle figure
  dans le guide) et fait la déclaration ARTCI ; l'utilisateur se charge de prévenir l'agent et les destinataires des
  alertes.
- Le chef de poste peut déverrouiller le code d'un agent et terminer son service.
- Un SOS est visible de tous les agents.
- Un agent connecté peut acquitter une alarme même hors service.
- Le rapport e-mail ne contient pas de tableau par agent.
- Essai : QR d'abord, NFC NTAG213 ensuite ; avec le **téléphone Android du site**, celui de la passerelle d'appel ;
  un agent la nuit ; rondes à 22:00, 00:00, 02:00 et 04:00, 20 min chacune, pendant une semaine.

## Production (faite le 17/10 avec l'accord de l'utilisateur)

- Sauvegarde préalable du dossier `tls`, de `.env.production` et de `psim.db` dans
  `data-prod/sauvegarde-avant-essai-agents-20261017/`.
- Nouveau certificat : `npm run make-cert:prod -- --force 192.168.1.17 DESKTOP-KS8GC9M`. L'autorité
  `data-prod/tls/ca.pem` est valable jusqu'en 2036 ; le certificat du serveur jusqu'en janvier 2029.
- `.env.production` : seules ces deux lignes ont changé.
  - `PSIM_HOST=0.0.0.0` (avant : 127.0.0.1)
  - `PSIM_PUBLIC_URL=https://192.168.1.17:3033` (avant : `https://DESKTOP-KS8GC9M:3033`)
- Tâche planifiée « PSIM » redémarrée ; la base a migré au démarrage ; l'enregistreur Dahua s'est reconnecté.
  `check-agents:prod --live` : 7 contrôles OK. Les 4 échecs (agent, téléphone, circuit, points) sont normaux tant que
  rien n'a été créé.
- Le redémarrage a mis en production tout le contenu de `main`, y compris le chantier contrôle d'accès d'une autre
  session et les modifications du téléphone Android non commitées (voir plus bas).
- Les postes qui avaient accepté l'ancien certificat doivent installer le nouveau : `https://192.168.1.17:3033/api/agent-cert`.

## À faire, dans l'ordre

1. **Par l'utilisateur** (ce sont des réglages de sécurité de Windows, que Claude ne fait pas) : dans PowerShell lancé
   en administrateur, passer le Wi-Fi en réseau privé :
   `Set-NetConnectionProfile -Name "BKOUROUMA 2" -NetworkCategory Private`
   puis ouvrir le port 3033 :
   `New-NetFirewallRule -DisplayName "PSIM 3033 (réseau privé)" -Direction Inbound -Protocol TCP -LocalPort 3033 -Profile Private -Action Allow`.
   **Sans ces deux réglages, le téléphone ne joint pas le PSIM.**
2. Réserver 192.168.1.17 pour ce PC dans le DHCP du routeur.
3. Suivre le guide d'essai, chapitres 4 à 7 : installer le certificat sur le téléphone ; créer les points, le circuit,
   l'agent et le téléphone ; imprimer et poser les QR ; appairer le téléphone. Relancer ensuite
   `npm run check-agents:prod -- --live`, qui doit être entièrement vert.
4. Faire l'essai avec la check-liste du chapitre 8, puis rapporter les résultats.
5. Ensuite, si l'utilisateur le demande : lancer le lot AG6, la coquille Android (notifications application fermée,
   repli SMS du SOS, homme mort).

## Non vérifié (sur un vrai téléphone seulement)

NFC, lecture QR par l'appareil photo (`BarcodeDetector`), service worker et installation sur l'écran d'accueil, son et
vibration des alarmes, vidéo en direct sur une caméra réelle, autonomie sur une nuit de 12 h. L'objectif « alarme reçue
en moins de 10 s » ne vaut que si l'application est ouverte : il n'y a pas de notification application fermée avant AG6.

## Points ouverts connus (non bloquants)

- Un SOS déjà en attente quand le téléphone est révoqué reste dans la file locale, sans affichage, jusqu'à un nouvel
  appairage.
- Le journal des envois refusés (`psim-agent-rejets`) n'a pas d'écran de consultation.
- Le rapport de rondes calcule les rondes passées avec les points **actuels** du circuit : modifier un circuit change
  les anciens taux.
- Un vrai détecteur nommé `P-<n>`, sans zéro devant, serait pris pour un circuit.
- `check-agents` compte comme « placé » un point jamais déplacé (x et y valent 50 par défaut).
- Le portail ne garde que les semaines du dernier résumé, environ 6 ; la vue de groupe n'agrège pas les rondes.
- Le cookie de session est unique par origine : un administrateur et un agent ouverts dans le même navigateur se
  déconnectent l'un l'autre. C'est sans effet en usage réel.

## Cohabitation avec les autres chantiers

- **Téléphone Android** (autre session) : `.env.example`, `server/config.ts`, `server/main.ts`,
  `server/notifications.ts` et `test/phonegateway.test.ts` sont **modifiés sans être commités** dans `main`. Ils ont été
  préservés à chaque fusion, par avance rapide avec `--autostash`. Des copies sont dans le dossier temporaire de la
  session (`chantier-telephone*.patch`). Ne pas les commiter à la place de leur auteur.
- **Contrôle d'accès** (autre session) : cette session commite aussi sur `main`.
- Méthode de fusion utilisée : fusion et tests dans le worktree `.claude/worktrees/integration-agents` (branche
  `integration-agents`), puis `git merge --ff-only --autostash integration-agents` dans `main`.

## Organisation (voulue par l'utilisateur)

Un chef (Opus) supervise sans développer : il découpe en lots, tranche les questions techniques et pose les questions
métier par AskUserQuestion. Un superviseur Sonnet à effort élevé (`.claude/agents/superviseur-lot.md`) prend chaque
lot dans son worktree et le confie à des exécutants Sonnet (`executant` à effort moyen, `executant-expert` à effort
élevé ; Opus à titre exceptionnel). Le chef fusionne dans `main`.

Branches du chantier, toutes fusionnées et donc supprimables après accord : `agents-serveur`, `agents-ecran`,
`agents-application`, `agents-s4`, `agents-integration`, `agents-correctifs`, `essai-agents`, `integration-agents`.
Leurs worktrees sont sous `.claude/worktrees/`.
