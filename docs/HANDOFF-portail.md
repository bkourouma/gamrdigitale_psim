# Passation — portail de suivi à distance + mesure des caméras

Dernière mise à jour : 5 octobre 2026. Tout ce travail est commité (commit « Portail de suivi a distance »).

## Objectif du projet

Un tableau de bord **pour le client**, sans vidéo en direct : équipements, temps d'arrêt, incidents, statistiques, **plusieurs sites**. Décisions prises avec l'utilisateur (Baba Kourouma, qui écrit en français) :

- Public : **le client** (pas un technicien) → langage courant, jamais « MTBF », icône + texte pour chaque état.
- **Plusieurs sites** → un **portail central séparé**, alimenté par les PSIM de site (les sites envoient, le portail n'appelle jamais les sites, rien d'ouvert chez le client).
- Interface en **lecture seule** ; l'administration se fait en ligne de commande uniquement.

## Ce qui est fait et testé

**Côté PSIM (`server/`)**
- `history.ts` : table `device_state_history` (+ `blind_period`), disponibilité, pannes, temps non surveillé. Branchée dans `engine.ts` (`applyState`, `checkSilentDetectors`, `createDevice`) et au démarrage (`main.ts` : `beginHistory`). Purge à 400 jours.
- `portal.ts` : `buildSiteSummary` (instantané complet des 35 derniers jours), signature HMAC, `createPortalSender`, `validatePortalUrl`. Config `PSIM_PORTAL_URL/SITE_ID/KEY/EVERY_S`, contrôle dans `preflight.ts`, état dans `system.ts` (champ `portal`).

**Portail (`portal/`)** : `server/` (api, ingest, accounts, views, admin, keys, db, config, main), `web/` (index.html, style.css, app.js : accueil par site pire-d'abord, détail avec graphique, tableaux, mobile), `scripts/admin.ts` (CLI), `scripts/demo.ts` (démo, `npm run portal:demo`, port 4301). Doc d'exploitation : `docs/PORTAIL.md`.

**Tests** : `test/history.test.ts`, `test/portal.test.ts`, `test/portal/*.test.ts` (ingest, accès/périmètre, views). 48 tests portail + 14 historique, tous verts. Le périmètre client a été vérifié par mutation (filtre cassé → 5 tests échouent). `npm run typecheck` propre.

## État de l'installation de l'utilisateur (cette machine, Windows)

- PSIM de production : tâche planifiée Windows **`PSIM`** (restart 999) + `PSIM-healthcheck` (`--restart 3`). Données dans `data-prod/`. Interface `https://127.0.0.1:3033`. Redémarré à 10:39 le 5 oct. avec la config portail.
- Portail : lancé à la main (`npm run portal`, port 4300), données dans `portal-data/` (inclut `master.key`).
- Compte admin du portail : `portaladmin` (mot de passe choisi par l'utilisateur). Organisation « Résidence KOUROUMA ». Site actif : **`residence-kourouma`**. L'ancien site `identifiant-du-site` est désactivé (aucune commande de suppression/renommage n'existe).
- Le PSIM de production envoie bien au portail (vérifié : `portail de suivi : résumé toutes les 300 s vers 127.0.0.1:4300` dans `data-prod/logs/psim.log`).
- Ce site réel a **8 caméras et 0 détecteur** : la page affiche « Aucun détecteur suivi » avec la liste des caméras, sans pourcentage.

## PROCHAINE TÂCHE : mesurer l'état des caméras

Pourquoi : pour ce client, la page n'apprend rien tant que les caméras ne sont pas mesurées. L'utilisateur a validé cette tâche en premier, puis l'alerte « site injoignable ».

État du code : une caméra n'a pas d'état de santé (`device.status` reste `normal`). Elle n'est lue que lorsqu'un opérateur ouvre l'image (`server/video.ts`). `history.ts` ne suit que `kind = 'detector'` (`beginHistory`, `createDevice`) ; `portal.ts` met `monitored: r.kind === 'detector'` ; l'interface affiche « Non mesuré » pour toute caméra (`web/app.js`, `equipmentTable`) ; `views.ts#siteStatus` renvoie « Aucun détecteur suivi » s'il n'y a aucun équipement `monitored`.

Conception proposée (à confirmer avec l'utilisateur avant de coder) :
1. Nouveau `server/camerahealth.ts` : toutes les 60 s, test de connexion TCP (délai 3 s, **sans identifiants, sans image**) vers `host:port` de chaque caméra ayant une ligne dans `camera_source` (les caméras simulées n'ont rien à mesurer). Hors ligne après 3 échecs de suite (pas d'oscillation sur un raté isolé), retour en ligne au premier succès.
2. Écrire les transitions avec `recordState(db, id, 'offline' | 'normal', t)` (déjà réutilisable). Étendre `beginHistory` et `createDevice` aux caméras réelles ; ajouter un journal d'audit (`camera_offline` / `camera_online`) ; **ne pas** lancer d'incident ni de notification dans cette première version.
3. `portal.ts` : `monitored` = détecteur **ou** caméra avec source réelle. Garder `monitored: false` pour les caméras simulées.
4. Décision à prendre : faut-il aussi refléter l'état dans `device.status` (visible dans l'écran du PSIM, qui ne connaît pas `offline` pour une caméra) ? Plus sûr au début : ne pas toucher à `device.status`, et faire lire au résumé l'état ouvert de `device_state_history`.
5. Mettre à jour : `docs/PORTAIL.md` (section « Comment lire les chiffres » dit aujourd'hui que les caméras ne sont pas mesurées), le texte « L'état des caméras n'est pas mesuré en continu » dans `web/app.js`, la règle « Aucun détecteur suivi » dans `views.ts`, et les tests (`test/history.test.ts`, `test/portal.test.ts`, `test/portal/views.test.ts`).
6. **Limite à dire à l'utilisateur** : joindre le port d'un enregistreur Dahua prouve que l'appareil répond, pas que chaque voie vidéo fonctionne. C'est une disponibilité « appareil », pas « image ».

Ensuite : alerte « site injoignable » (le portail n'alerte personne aujourd'hui ; e-mail ou WhatsApp au prestataire), puis rapport mensuel PDF par client, mode « maintenance annoncée », double authentification pour le portail (le compte admin voit tous les clients et n'a pas de 2FA).

## À éclaircir (hors tâche)

Le journal du PSIM montre plusieurs « REDÉMARRAGE APRÈS ARRÊT INATTENDU » : 4 oct. (3 min, 1 min, 1 min), **5 oct. 07:23 UTC : 163 min sans surveillance**, 07:24, 08:48, 10:39 (ce dernier est le redémarrage volontaire). Cause non investiguée (veille du PC ? arrêt Windows ?). Journaux Windows (Observateur d'événements) et `data-prod/logs/psim.log` à examiner.

## Pièges rencontrés — à lire avant de travailler

- **Fins de ligne CRLF** : la plupart des fichiers existants (`server/*.ts`, `README.md`, `package.json`, `.env.example`, `.gitignore`) sont en CRLF. L'outil d'édition échoue ou les mélange. Le script `crlfedit.mjs` (dans le dossier scratchpad de la session précédente) applique des remplacements exacts en préservant CRLF ; le refaire si besoin (lire, normaliser en LF, remplacer, remettre en CRLF).
- **Ne jamais supprimer un `git worktree` contenant une jonction vers `node_modules`** : `git worktree remove --force` a vidé le vrai `node_modules` du projet (restauré avec `npm ci`, lockfile inchangé). Pour comparer à `HEAD`, copier sans jonction et lancer `npm ci` dedans.
- **Redémarrer le PSIM de production** : bloqué par le système de permissions (« Production Deploy »). C'est à l'utilisateur de faire `Stop-ScheduledTask -TaskName PSIM` puis `Start-ScheduledTask -TaskName PSIM`. Pas d'arrêt « doux » possible pour une tâche planifiée : le redémarrage est toujours journalisé comme arrêt inattendu. Ne pas supprimer `data-prod/psim.lock`.
- **Un changement du serveur du portail** (`portal/server/*`) ne s'applique qu'après redémarrage du portail (Ctrl+C dans sa fenêtre puis `npm run portal`). Seuls les fichiers de `portal/web/` se rechargent seuls (Ctrl+F5).
- `npm run set-password` lit `.env`, **pas** `.env.production` : pour la production, `node --env-file=.env.production scripts/set-password.ts <compte>`.
- **Tests instables sur cette machine** : `npm test` donne 2 à 4 échecs parmi les tests « processus réel » (`e2e-production`, `e2e-resilience`, `resilience`), avec un code de sortie `0xC0000409` (plantage brutal de Node à l'arrêt). **Même échec sur le dernier commit sans mes changements** : sans lien avec ce travail. Lancer les fichiers un par un pour vérifier. À examiner séparément.
- La politique de sécurité de contenu du portail interdit l'attribut `style` : en JavaScript, utiliser `element.style.x = …`, jamais `setAttribute('style', …)`.
- Aucun mot de passe ni clé n'est consigné ici. Le mot de passe de démonstration du portail (`Demo-portail-2026-x`) ne sert qu'à `portal:demo`.

## Commandes utiles

```bash
npm run typecheck
node --test "test/portal/*.test.ts" test/portal.test.ts test/history.test.ts
npm run portal:demo                                   # démo sur http://127.0.0.1:4301
npm run portal                                        # vrai portail, http://127.0.0.1:4300
npm run portal:admin -- list
npm run portal:admin -- site-env residence-kourouma   # réaffiche les 3 lignes du .env du site
node --env-file=.env.production scripts/check-config.ts
```

## Fichiers concernés par ce travail

Existants : `.env.example`, `.gitignore`, `README.md`, `package.json`, `tsconfig.json`, `scripts/check-config.ts`, `server/config.ts`, `server/db.ts`, `server/engine.ts`, `server/main.ts`, `server/preflight.ts`, `server/system.ts`. Nouveaux : `server/history.ts`, `server/portal.ts`, `portal/`, `docs/PORTAIL.md`, `docs/HANDOFF-portail.md`, `test/history.test.ts`, `test/portal.test.ts`, `test/portal/`. Dossier `.claude/` non suivi (contient `launch.json` avec une entrée `portail-demo` ajoutée).
