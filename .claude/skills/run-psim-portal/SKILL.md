---
name: run-psim-portal
description: Lance le PSIM et le portail de suivi à distance de ce dépôt (mode démo avec données de test, ou mode normal avec .env / .env.portal), vérifie qu'ils répondent et donne les adresses et comptes. À utiliser quand on demande de lancer, démarrer, relancer ou ouvrir le PSIM, le portail, ou « les deux ».
---

# Lancer le PSIM et le portail

Deux programmes **indépendants** (Node.js 24+, `npm install` déjà fait si `node_modules/` existe) :

| Programme | Mode démo (données de test, base recréée à chaque lancement) | Mode normal (vraies données) |
|---|---|---|
| **PSIM** | `npm run demo` → http://127.0.0.1:3034 (+ MediaMTX, 5 caméras simulées, faux courrier/Telegram ; nécessite `ffmpeg`) | `npm start` (ou `npm run dev` : rechargement auto) → http://127.0.0.1:3033, config dans `.env` |
| **Portail** | `npm run portal:demo` → http://127.0.0.1:4301 (écrit dans `portal-demo-data/`, jamais `portal-data/`) | `npm run portal` → http://127.0.0.1:4300, config dans `.env.portal` |

Le portail ne reçoit rien du PSIM tant que `PSIM_PORTAL_URL`, `PSIM_PORTAL_SITE_ID` et `PSIM_PORTAL_KEY` ne sont pas réglés dans le `.env` du PSIM (voir `docs/PORTAIL.md`). La démo du portail fabrique son propre historique : pas besoin du PSIM.

## Marche à suivre

1. **Choisir le mode.** Sans précision : **démo** pour les deux (aucun risque pour `data/` ni `portal-data/`). Mode normal seulement si l'utilisateur le demande ; dans ce cas vérifier que `.env` existe (sinon `cp .env.example .env`). Le portail normal exige un `.env.portal` (`PORTAL_MASTER_KEY` en production) : s'il manque et que l'utilisateur veut le mode normal, lui poser la question plutôt que d'inventer des secrets.
2. **Libérer les ports si besoin** : 3034/3033 (PSIM), 4301/4300 (portail), 1884 (MQTT démo), 8554 (RTSP démo). Si un port est pris, regarder qui l'occupe (`Get-NetTCPConnection -LocalPort <port>`) et le dire à l'utilisateur ; ne tuer un processus que s'il s'agit d'une instance précédente de ce projet.
3. **Lancer chaque programme en arrière-plan** (jamais en premier plan : ils ne s'arrêtent pas). Depuis `D:\APP\GAMRdigitale_PSIM-1` :
   - `npm run portal:demo` (ou `npm run portal`) avec `run_in_background: true`
   - `npm run demo -- --auto` (ou `npm start`) avec `run_in_background: true`. Avec `npm run demo` seul, le menu interactif attend le clavier : en arrière-plan, utiliser `--auto` (scénarios en boucle) ou `--scenario=<id>`.
   - Ou, dans l'application de bureau, `preview_start` avec une entrée de `.claude/launch.json` (`portail-demo` = portail démo sur 4301). Le PSIM démo n'y figure pas : il se lance par `npm run demo`.
4. **Vérifier** (attendre quelques secondes, le démarrage du PSIM démo prend ~10-20 s) :
   - lire la sortie des deux processus : le portail affiche `[demo] portail : http://127.0.0.1:4301`, le PSIM affiche le cadre « Demonstration prete » ;
   - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/` doit répondre 200 (ou 302 vers la connexion).
   En cas d'échec, montrer les dernières lignes de la sortie et diagnostiquer (port occupé, `ffmpeg` absent, `.env` invalide) avant de relancer.
5. **Rendre la main à l'utilisateur** avec les adresses et comptes ci-dessous. Si c'est utile, ouvrir les pages dans le navigateur intégré (`preview_start` avec `url`).

## Adresses et comptes (mode démo)

- **PSIM** http://127.0.0.1:3034 : boutons « Administrateur » / « Opérateur » sur la page de connexion qui remplissent les identifiants. Les scénarios (incendie, etc.) défilent seuls avec `--auto`.
- **Portail** http://127.0.0.1:4301 : comptes `prestataire` (admin), `diallo` (direction, 4 sites), `kaloum` (un site), `autre` (autre client) ; mot de passe `Demo-portail-2026-x` (affiché aussi dans la sortie du portail).
- Mode normal : PSIM http://127.0.0.1:3033 (mots de passe dans `.env`), portail http://127.0.0.1:4300 (comptes créés par `npm run portal:admin -- list` / `add-user`, voir `docs/PORTAIL.md`).

## Mode production (sur demande explicite : « la prod »)

- **PSIM** : `npm run start:prod` (arrière-plan) → https://127.0.0.1:3033 (HTTPS, certificat auto-signé : `curl -k`), config `.env.production`, données `data-prod/`. Le démarrage affiche « REDEMARRAGE APRES ARRET INATTENDU » s'il était arrêté : normal. Il envoie un résumé au portail toutes les 300 s.
- **Portail** : `npm run portal` → http://127.0.0.1:4300 (`portal-data/`). Il tourne souvent déjà (démarré hors session) : vérifier d'abord `Get-NetTCPConnection -LocalPort 4300` et la ligne de commande du processus ; s'il répond, le laisser tel quel plutôt que de le relancer. Pas de `.env.portal` obligatoire ici : la clé maître est dans `portal-data/master.key`.
- Ne pas mélanger : si des processus démo tournent encore, les arrêter avant (voir ci-dessous).

## Arrêt

**Sous Windows, TaskStop / preview_stop ne tuent que l'enveloppe `npm` : les processus Node, MediaMTX et ffmpeg lancés par la démo restent actifs.** Après TaskStop, vérifier les ports (3034, 4301, 1884, 8554, 2525, 2526), lire la ligne de commande des processus restants (`Get-CimInstance Win32_Process`) et tuer l'arbre de la démo avec `taskkill /PID <pid du node scripts/demo.ts> /T /F` (idem pour `portal/scripts/demo.ts`). Ne jamais tuer le `node` de `server/index.ts` lancé avec `.env.production` ni `portal/server/main.ts` : c'est la prod.

## À ne pas faire

- Ne pas lancer `npm run start:prod` / `supervise:prod` / `portal` en production, ni toucher à `data-prod/`, `.env.production`, `backups-prod/`, sauf demande explicite.
- Ne pas lancer les entrées `.tmp-refonte` / `.tmp-plan` de `launch.json` sauf si l'utilisateur parle de la refonte d'interface (branche `refonte-interface`, non fusionnée).
- Ne pas modifier `.env` ni `.env.portal` pour faire démarrer : demander.
