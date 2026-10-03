# GAMRdigitale PSIM — MVP incendie + vidéosurveillance

Un seul scénario, de bout en bout : **un détecteur incendie déclenche → l'opérateur voit l'alarme sur le plan → les caméras liées s'affichent automatiquement → il acquitte, puis qualifie l'incident (feu confirmé / fausse alarme) → tout est écrit dans un journal.**

Hors périmètre volontairement : contrôle d'accès, intrusion, IoT, GPS, scoring de risque, tableau de bord décisionnel, SIEM.

> Le PSIM **supervise** l'incendie, il ne remplace pas la centrale de détection incendie certifiée.
> Ce MVP lit des états et n'envoie **aucune commande** vers le système incendie.

## Démarrer

Prérequis : Node.js 24 ou plus.

```bash
npm install
cp .env.example .env     # puis changer les mots de passe
npm start
```

Ouvrir http://127.0.0.1:3033. Comptes : `admin` (administrateur) et `operateur` (opérateur) ; leurs mots de passe sont ceux de `.env` (valeurs de développement dans `.env.example`).

## Démonstration complète en une commande

```bash
npm run demo
```

Cette commande lance tout l'environnement de test, sans aucun équipement :

- **MediaMTX** (serveur RTSP open source), installé automatiquement au premier lancement dans `tools/` (version épinglée, empreinte SHA-256 vérifiée) ;
- **5 caméras RTSP simulées** (C-01 à C-05) qui publient une vraie vidéo H.264, avec fumée et flammes pilotées en direct ;
- **4 faux appareils ONVIF** (ports 8801 à 8804, pour C-01 à C-04) : la 5e caméra reste en RTSP direct, pour montrer les deux chemins ;
- **le PSIM**, sur une base vierge `data-demo/` (recréée à chaque lancement : votre `data/` n'est jamais touché), configuré pour lire ces caméras comme de vraies caméras, avec identifiants ;
- **les détecteurs**, qui publient sur MQTT comme de vrais équipements, avec un signal de vie toutes les 8 secondes (la surveillance des détecteurs muets est active, à 30 s).

La démo applique ces règles avec des délais raccourcis (persistance 25 s au lieu de 120 s). Le PSIM de démonstration est sur http://127.0.0.1:3034 (broker MQTT sur 1884, RTSP sur 8554) : il peut tourner en même temps que votre installation habituelle. Sur la page de connexion, cliquer sur « Administrateur » ou « Opérateur » remplit les champs. Les identifiants de lecture des caméras (générés au hasard à chaque lancement) sont affichés dans le terminal : vous pouvez les saisir à la main dans *Source vidéo* pour essayer le formulaire.

Scénarios (menu dans le terminal : taper le numéro, `r` pour tout remettre au calme, `a` pour le mode automatique, `q` pour quitter) :

| # | Scénario | Ce qu'il montre |
|---|---|---|
| 1 | `fausse-alarme-vapeur` | Un détecteur se déclenche alors que la caméra ne montre que de la vapeur : à qualifier « fausse alarme » |
| 2 | `incendie-atelier` | Préalarme, alarme, flammes à l'atelier, puis propagation à l'entrepôt : deux incidents critiques |
| 3 | `surchauffe-serveurs` | Alarme immédiate en salle serveurs, sans préalarme |
| 4 | `defaut-detecteur` | Défaut technique : le statut change, aucun incident n'est créé |
| 5 | `detecteur-muet` | Un détecteur cesse d'émettre sans rien annoncer : le PSIM le déclare hors ligne de lui-même, compteur « hors service » en haut de l'écran |
| 6 | `confirmation-croisee` | Deux détecteurs voisins (couloir, bureaux) se confirment mutuellement |
| 7 | `detecteur-hors-ligne` | Un détecteur annonce lui-même qu'il est hors ligne |
| 8 | `intrusion-nuit` | Mouvement détecté à l'accueil la nuit : incident d'intrusion avec l'image de la caméra |
| 9 | `porte-forcee` | Porte de service restée ouverte (avertissement), puis forcée (critique) |
| 10 | `derive-temperature` | La température de la salle serveurs franchit les seuils de préalarme (30 °C) puis d'alarme (38 °C) |
| 11 | `fuite-eau` | Fuite d'eau détectée au stockage |

Options : `npm run demo -- --no-onvif` (toutes les caméras en RTSP direct), `--auto` (enchaîne les scénarios en boucle, pour une présentation), `--scenario=incendie-atelier` (lance un scénario au démarrage), `--speed=2` (deux fois plus vite), `--duration=120` (s'arrête seul après 120 s). `Ctrl+C` arrête tout proprement.

> **Attention au son** : tant qu'un incident n'est pas acquitté, l'interface émet une alerte sonore. Fermez l'onglet ou utilisez le bouton « Son activé » avant de lancer une démo dans un lieu calme.

### Ce que valident les faux appareils ONVIF

Chaque faux appareil (`scripts/demo/onvif-device.ts`) se comporte comme une caméra réelle sur les points qui comptent pour le PSIM :

- il **exige une authentification** WS-Security et refuse un mauvais identifiant (essayez de changer le mot de passe dans *Source vidéo* : le message « Identifiants refusés » s'affiche) ;
- il propose **deux profils** : un principal lourd (H.265 4K, volontairement sans flux) et un secondaire léger (H.264) : le PSIM doit choisir le second ;
- il annonce une **adresse RTSP interne fausse** (10.255.255.1), défaut fréquent sur le terrain : le PSIM doit l'ignorer et utiliser l'adresse saisie ;
- il **n'implémente pas `GetServices`**, comme beaucoup de caméras anciennes : le PSIM doit se rabattre sur `GetCapabilities` ;
- il répond à la **recherche réseau** (bouton « Rechercher sur le réseau » : 4 caméras doivent apparaître). Cette recherche utilise la multidiffusion UDP : si votre pare-feu la bloque, la démo l'indique et la saisie manuelle reste possible.

Limite : ces appareils valident le dialogue tel que **nous** comprenons ONVIF, pas la conformité complète à la norme. Une vraie caméra peut encore réserver des surprises (autre structure de profils, authentification HTTP Digest, horloge décalée, H.265 seul…).

### Sans la démo complète

- Depuis l'interface (compte admin) : panneau **Simulateur de détecteurs**, boutons Préalarme / Alarme / Défaut / Normal.
- Ou en ligne de commande, comme un vrai détecteur qui publie sur MQTT :

```bash
npm run sim -- D-04 alarm
npm run sim -- D-04 normal
```

Un incident ne peut être clôturé qu'une fois le détecteur revenu à la normale (comme un reset de centrale).

## Comptes, accès et double authentification

**Qui peut faire quoi.** Deux rôles : **opérateur** (supervise, acquitte, qualifie les incidents, consulte les risques) et **administrateur** (tout, plus la configuration). Un administrateur gère les comptes dans **Utilisateurs et accès** (panneau d'administration) : créer, changer le rôle, désactiver, réinitialiser un mot de passe ou la 2FA, supprimer.

**Garde-fous**
- On ne peut **jamais retirer le dernier administrateur actif** (suppression, désactivation, rétrogradation), ni se désactiver ou se supprimer soi-même. Les modifications demandées ensemble sont appliquées en bloc ou pas du tout.
- **Tout changement coupe les sessions immédiatement** : mot de passe, rôle, désactivation, suppression. Le PSIM vérifie le compte à chaque requête ; le rôle vient de la base, jamais du jeton. Cela vaut aussi pour `npm run set-password`.
- Un compte **créé** ou dont le mot de passe est **réinitialisé** par un administrateur doit changer son mot de passe à la première connexion : sa session est « restreinte » (rien d'autre n'est accessible, ni le temps réel, ni l'API).
- Mots de passe : 12 caractères minimum, ni de démonstration, ni contenant l'identifiant. Stockés avec scrypt.
- Limitation des essais **par adresse et par compte** (5 échecs par minute), connexions refusées journalisées (jamais le mot de passe).

**Double authentification (TOTP, RFC 6238)** : compatible Google Authenticator, Microsoft Authenticator, Aegis, FreeOTP, 1Password… Chaque utilisateur l'active dans **Mon compte** (clic sur son nom en haut) : QR code, saisie d'un premier code de vérification, puis **8 codes de secours à usage unique** à conserver.
- La connexion se fait **en deux étapes** : le mot de passe seul ne donne **aucune session**. Le code est valable 30 s (tolérance d'une fenêtre), **jamais rejouable** ; 5 essais maximum par connexion.
- Le secret est **chiffré en base** ; les codes de secours ne sont stockés que sous forme d'empreinte.
- **Téléphone perdu** : un code de secours, ou un administrateur qui **réinitialise la 2FA** du compte (ses sessions sont fermées).
- **`PSIM_REQUIRE_2FA`** : `none`, `admin` ou `all`. **Par défaut : `admin` en production** (un administrateur doit l'activer avant de pouvoir faire quoi que ce soit), `none` ailleurs. Un compte soumis à cette règle ne peut pas la désactiver.

**Destinataires de notification** : en administrateur, **Notifications** permet d'ajouter, de désactiver, de changer de niveau et de retirer des destinataires (e-mail, Telegram, webhook) **sans redémarrer** ; ils s'ajoutent à ceux du `.env`, affichés en lecture seule. Les adresses sont validées (injection d'en-tête e-mail refusée), l'adresse complète d'un webhook n'est jamais renvoyée à l'écran (elle peut contenir un jeton), et un canal dont le secret n'est pas dans le `.env` (SMTP, jeton Telegram) ne peut pas recevoir de destinataire.

**Limites** : pas d'envoi de lien d'invitation ni de réinitialisation par e-mail (l'administrateur communique le mot de passe temporaire par un canal sûr) ; pas de SSO ni d'annuaire (LDAP, Active Directory) ; deux rôles seulement ; les sessions sont en mémoire (un redémarrage déconnecte tout le monde).

## Mise en production

Tout ce qui précède fonctionne en développement avec des valeurs de démonstration. **En production, le PSIM refuse de démarrer s'il est mal configuré.** Procédure complète :

**1. Configurer** : copier `.env.example` en `.env` et y mettre au minimum

```
PSIM_ENV=production
PSIM_ADMIN_PASSWORD=...            # 12 caractères minimum, ni identiques ni de démonstration
PSIM_OPERATOR_PASSWORD=...
PSIM_MQTT_PASSWORD=...
PSIM_HOST=0.0.0.0                  # seulement si le PSIM doit être joint depuis le réseau (alors HTTPS obligatoire)
PSIM_TLS_CERT=...  PSIM_TLS_KEY=...
PSIM_PUBLIC_URL=https://psim.exemple.fr
```

Puis les notifications (voir plus haut) et, si des détecteurs distants publient sur le broker, `PSIM_MQTT_HOST=0.0.0.0` (avec `PSIM_MQTT_TLS_CERT/KEY`). **`npm run check-config`** donne le verdict sans démarrer le PSIM (avec `PSIM_ENV=production` dans le `.env`, le même que celui du démarrage).

**2. Ce que le PSIM refuse en production** (erreurs bloquantes, code de sortie 1) : mots de passe de démonstration, trop courts (< 12 caractères) ou identiques ; simulateur actif (il permet de fabriquer de fausses alarmes : désactivé par défaut en production) ; comptes cliquables sur la page de connexion ; interface ouverte au réseau **sans HTTPS** (ni proxy HTTPS). Il **avertit** pour : MQTT sans TLS sur le réseau, aucun canal de notification, aucun destinataire de niveau 2, surveillance des détecteurs muets coupée, sauvegarde automatique coupée.

**3. HTTPS** : fournir `PSIM_TLS_CERT` et `PSIM_TLS_KEY` (fichiers PEM, TLS 1.2 minimum). Le cookie de session devient `Secure` et l'en-tête HSTS est envoyé. `PSIM_HTTP_REDIRECT_PORT=80` ajoute un port HTTP qui redirige vers HTTPS. Pour un réseau interne sans certificat d'autorité, **`npm run make-cert -- psim.local 192.168.1.10`** génère un certificat auto-signé dans `data/tls/` (OpenSSL requis, livré avec Git for Windows) ; les navigateurs afficheront un avertissement tant que ce certificat n'est pas installé comme autorité de confiance sur les postes. Derrière un proxy HTTPS (IIS, nginx, Caddy), mettre `PSIM_TRUST_PROXY=1` et `PSIM_COOKIE_SECURE=1`.

**4. Démarrage automatique et reprise après panne (Windows)** : dans un PowerShell **ouvert en administrateur**, depuis le dossier du projet :

```powershell
.\scripts\windows-service.ps1 -Action Install -WhatIf   # voir ce qui serait fait, sans rien modifier
.\scripts\windows-service.ps1 -Action Install            # installe et démarre
.\scripts\windows-service.ps1 -Action Status
```

Cela crée deux tâches planifiées (sans logiciel supplémentaire) : **`PSIM`** démarre le PSIM au démarrage de la machine, sans session ouverte, et le **relance** automatiquement s'il s'arrête ; **`PSIM-healthcheck`** interroge `/healthz` chaque minute et, après 3 échecs consécutifs, arrête un PSIM *bloqué* (qui tourne mais ne fait plus rien) pour que la première tâche le relance. Pour un compte de service dédié : `-User DOMAINE\psim`. Linux : `deploy/psim.service` (systemd). Les journaux vont dans `data/logs/psim.log` (rotation 5 × 5 Mo).

**5. Sauvegardes** : automatiques toutes les 24 h en production (`PSIM_BACKUP_EVERY_H`, 14 conservées, dossier `PSIM_BACKUP_DIR`), ou à la demande : `npm run backup`, ou **Système → Sauvegarder maintenant**. Une sauvegarde contient la base (copie cohérente faite à chaud), les plans et les images d'incident, avec l'empreinte SHA-256 de chaque fichier, vérifiée à la création et avant toute restauration.
- **La clé de chiffrement des mots de passe de caméras (`data/secret.key`) n'est pas incluse** (la ranger avec la base annulerait l'intérêt de la chiffrer) : conservez-la dans un coffre. `--with-key` l'inclut si vous le décidez.
- **Une sauvegarde sur le même disque ne protège pas d'une panne de disque** : copiez le dossier ailleurs (disque externe, réseau) ou pointez `PSIM_BACKUP_DIR` vers un autre volume.
- **Restaurer** (PSIM arrêté) : `npm run restore -- backups/psim-AAAAMMJJ-HHMMSS` montre ce qui serait fait ; ajoutez `--yes` pour restaurer. L'ancien dossier de données est **mis de côté** (`data.before-restore-…`), jamais supprimé. **Essayez une restauration sur une machine de test avant d'en avoir besoin.**
- Un **verrou d'instance unique** (`data/psim.lock`) empêche de lancer deux PSIM sur la même base, et la restauration de s'exécuter pendant qu'il tourne.

**6. Comptes** : les mots de passe de `.env` ne servent qu'à créer les deux comptes initiaux au premier démarrage (et seulement si le contrôle de démarrage est passé). Ensuite, tout se fait dans l'interface (voir « Comptes, accès et double authentification »), ou en ligne de commande : **`npm run set-password -- operateur`** (saisie masquée, 12 caractères minimum ; ses sessions ouvertes sont fermées immédiatement). **En production, la 2FA est imposée aux administrateurs par défaut** : prévoyez une application d'authentification avant la première connexion.

**7. Surveiller le PSIM lui-même** : `GET /healthz` (sans authentification, volontairement minimal : `ok` ou `degraded` avec la raison, code 200 ou 503) pour un superviseur externe ; en administrateur, **Système** affiche la santé, l'espace disque, les passerelles MQTT, la dernière sauvegarde et la liste des avertissements, et un badge rouge apparaît en haut de l'écran en cas d'alerte critique (sauvegarde en échec ou trop ancienne, disque presque plein, santé dégradée).

**Limites** : un seul serveur (pas de haute disponibilité) ; les sessions sont en mémoire (un redémarrage déconnecte tout le monde) ; une sauvegarde bloque très brièvement le PSIM (quelques centaines de ms pour une base de quelques dizaines de Mo) ; les scripts d'installation du service Windows ont été validés en simulation (`-WhatIf`) mais **pas installés réellement sur une machine** par l'auteur : essayez-les d'abord sur un poste de test.

## Gestion des risques (indice par zone)

Le bouton **Risques** (en haut de l'écran) ouvre une vue qui répond à : *où le risque est-il le plus élevé, pourquoi, et que faire en premier ?* Tout utilisateur connecté la consulte ; seul l'administrateur évalue les zones.

**Indice de sécurité = Probabilité (1-3) × Vulnérabilité (1-4) × Répercussions (1-5), soit de 1 à 60**, calculé **par zone** (les zones sont celles des équipements du plan). Niveaux : Faible ≤ 8, Modéré ≤ 20, Élevé ≤ 36, Critique ≤ 60. L'indice du **site** est celui de sa **zone la plus exposée**.

| Composante | Saisie par l'évaluateur | Corrigée automatiquement par le PSIM |
|---|---|---|
| **Probabilité** (1 improbable, 2 possible, 3 probable) | note de base (environnement, activité) | +1 si 1 à 2 incendies **confirmés** dans la zone sur 180 jours, +2 si 3 ou plus (plafond 3). Une fausse alarme ne compte pas. |
| **Vulnérabilité** (1 bien défendu … 4 peu défendu) | 5 lignes de défense cochées : extincteurs, consignes, personnel formé, compartimentage, désenfumage (0-1 → 4, 2 → 3, 3-4 → 2, 5 → 1) | +1 par défaut constaté : aucun détecteur dans la zone, détecteur hors service ou en défaut, aucune caméra ne couvre la zone (plafond 4) |
| **Répercussions** (1 négligeable … 5 catastrophique) | trois notes : image, économie, humaines | **la plus grave des trois** : un risque humain n'est jamais dilué par un faible impact économique |

- **Chaque note se justifie** : « Voir le calcul » détaille les raisons (par exemple « +1 : détecteur hors service (D-07) »). L'indice réagit donc à l'état réel : un détecteur qui tombe en panne fait monter l'indice de sa zone, et il redescend à sa reprise.
- **Pas de chiffre inventé** : une zone non évaluée (nouvel équipement dans une nouvelle zone) apparaît **« À évaluer »**, sans note, avec une priorité de court terme. Une évaluation de plus de 12 mois est marquée **« à revoir »**.
- **Priorités d'action** en court, moyen et long terme (remettre en service un détecteur, couvrir une zone par une caméra, ajouter un détecteur voisin, lignes de défense manquantes, causes d'incendies répétés…). Chaque mesure chiffrable affiche son **gain** : la baisse d'indice attendue si elle est réalisée (`−12`).
- **Tendances** : un point par jour et par zone est conservé ; les courbes apparaissent au bout de quelques jours.
- Une **nouvelle alarme ramène automatiquement** l'opérateur sur l'écran de supervision : elle n'est jamais cachée derrière une autre vue.
- Réglages : `PSIM_RISK_FIRE_WINDOW_DAYS` (180), `PSIM_RISK_STALE_MONTHS` (12).

> **Cadre d'usage** : cette grille est un outil d'aide à la décision, **pas une méthode réglementaire** (elle ne remplace ni l'analyse de risque d'incendie du site, ni l'avis du préventionniste ou de l'assureur). Les évaluations du site de démonstration sont des valeurs plausibles, à remplacer par celles du site réel ; les seuils et la grille de vulnérabilité sont dans `server/risk.ts`.

## Notifications et escalade

Le PSIM peut prévenir des personnes hors de l'écran, par **e-mail (SMTP)**, **Telegram** et **webhook** (Slack, Teams, passerelle SMS, etc.). Sans aucun canal configuré, les alarmes ne préviennent personne en dehors de l'interface : le démarrage l'indique.

**Qui est prévenu, et quand**

| Événement | Niveau 1 | Niveau 2 |
|---|---|---|
| Ouverture, aggravation, confirmation d'un incident | ✔ immédiatement | |
| Images prises par les caméras liées | ✔ en complément, dès qu'elles sont prêtes | |
| Détecteur muet (zone peut-être non surveillée) | ✔ | |
| Incident **toujours non acquitté** après `PSIM_ESCALATE_AFTER_S` (180 s) | | ✔ **escalade** |
| Rappels ensuite, toutes les `PSIM_REMINDER_S` (300 s), `PSIM_MAX_REMINDERS` fois (3) | ✔ | ✔ |

L'acquittement, ou la clôture, arrête l'escalade. Une confirmation qui rouvre un incident acquitté relance le décompte.

**Garanties**

- **Une alarme notifie toujours**, même « à confirmer » : les règles anti-fausses alarmes qualifient, elles ne font jamais taire.
- **Jamais bloquant** : les envois partent en tâche de fond, avec 3 tentatives (0, 2 puis 10 s). Un canal en panne n'empêche pas les autres, et ne retarde pas l'alarme. Un échec définitif est inscrit au journal (« Notification en échec ») et compté dans l'état des canaux.
- **Aucun secret dans les journaux** : jeton Telegram et mot de passe SMTP sont masqués dans les erreurs ; un webhook n'est affiché que par son hôte (son adresse complète peut contenir un jeton) ; les adresses e-mail sont abrégées (`a***@domaine`).
- Webhook : corps JSON, signé en HMAC SHA-256 dans l'en-tête `X-PSIM-Signature` si `PSIM_WEBHOOK_SECRET` est défini (vérifiez-le côté récepteur).

**Configuration** (voir `.env.example`) : serveur SMTP (`PSIM_SMTP_*`), jeton Telegram (`PSIM_TELEGRAM_TOKEN`), destinataires par niveau (`PSIM_NOTIFY_EMAIL_L1/L2`, `PSIM_NOTIFY_TELEGRAM_L1/L2` = identifiants de conversation, `PSIM_NOTIFY_WEBHOOK_L1/L2`), `PSIM_PUBLIC_URL` (lien ajouté aux messages). En administrateur, **Notifications → Envoyer un message de test** vérifie chaque destinataire des deux niveaux et affiche le résultat par destinataire.

**Limites** : pas de limitation de débit (un incendie qui se propage peut produire beaucoup de messages : c'est voulu, on ne perd pas d'alarme) ; pas de file persistante : si le PSIM s'arrête pendant un envoi, les tentatives en cours sont perdues (l'escalade, elle, repart de la base). Les destinataires ne sont pas encore modifiables depuis l'interface.

**Démonstration** : la démo lance un faux serveur SMTP et un faux Telegram locaux et **affiche dans le terminal** chaque message (`[courrier]`, `[telegram]`), avec une escalade à 25 s : rien ne quitte la machine.

## Images jointes aux incidents

À chaque étape d'un incident (**ouverture**, **aggravation**, **confirmation**), le PSIM prend une image de chaque caméra liée au détecteur et la joint à l'incident : l'opérateur (et la personne qui relit l'incident le lendemain) voit ce que les caméras montraient *à ce moment-là*, même si la vidéo en direct a changé depuis. Les miniatures apparaissent sous l'incident (clic = agrandir, Échap = fermer) et restent visibles dans les incidents clôturés.

- La capture se fait **après** la publication de l'alarme, en tâche de fond : une caméra lente ou en panne ne retarde jamais l'alarme. Un échec est inscrit au journal (« Image non prise »).
- Seules les caméras à **source réelle** (ONVIF ou RTSP) sont capturées : une caméra simulée dans le navigateur n'a pas d'image côté serveur.
- Si la caméra est déjà affichée, la dernière image du flux est reprise (instantané) ; sinon le PSIM se connecte à la caméra pour en lire une.
- Plafond de 12 images par incident. Conservation **30 jours** par défaut (`PSIM_SNAPSHOT_DAYS`, `0` = illimité) ; nettoyage au démarrage puis toutes les 6 heures.
- Les images sont dans `data/snapshots/` et ne sont servies qu'aux utilisateurs connectés. Elles font partie des données à sauvegarder avec la base.

## Règles anti-fausses alarmes

> **Principe : une règle anti-fausse alarme ne cache, ne retarde et ne ferme jamais une alarme.** Elle ne fait que **qualifier** l'incident pour aider l'opérateur à prioriser. Une alarme s'ouvre toujours immédiatement, à sa vraie gravité, reste visible et sonne ; seul un opérateur peut la clôturer, avec sa qualification (« feu confirmé » ou « fausse alarme »).

Chaque incident porte une étiquette :

| Étiquette | Signification |
|---|---|
| **À CONFIRMER** | Rien ne la corrobore pour l'instant. Elle reste à traiter. |
| **CONFIRMÉE** | Corroborée par un détecteur voisin, ou persistante. Alerte renforcée (double bip aigu, tri prioritaire). |
| *Probable fausse alarme* (indice bleu) | Suggestion : détecteur isolé revenu très vite à la normale. L'incident reste ouvert et à vérifier. |

Trois règles, réglables (secondes ; `0` désactive la règle) :

1. **Coïncidence** (`PSIM_CONFIRM_WINDOW_S`, 60) : un **détecteur voisin** est en préalarme ou en alarme, ou s'est déclenché dans cette fenêtre : les **deux** incidents sont confirmés. Sont voisins deux détecteurs de la **même zone**, ou qui partagent **au moins une caméra** (réglage *Caméras affichées* d'un détecteur : c'est donc l'administrateur qui définit le voisinage).
2. **Persistance** (`PSIM_CONFIRM_PERSIST_S`, 120) : un détecteur toujours en alarme ou préalarme après ce délai est confirmé. Les signaux de vie répétés ne remettent pas le compteur à zéro ; un retour à la normale, si.
3. **Indice de fausse alarme** (`PSIM_FALSE_ALARM_HINT_S`, 30) : un détecteur **isolé** (sans voisin) revenu à la normale en moins de ce délai reçoit l'indice « probable fausse alarme ». Il disparaît si le détecteur se redéclenche ou si un voisin confirme ensuite.

Une confirmation est traitée comme une **aggravation** : un incident déjà acquitté redevient « non acquitté » et l'alerte repart. Chaque confirmation et chaque indice sont inscrits au journal avec leur raison.

Les bases créées avant ces règles sont migrées automatiquement au démarrage, sans perte de données.

## Surveillance des détecteurs muets

Un détecteur qui tombe en panne ou perd son réseau ne prévient pas : sans surveillance, il resterait affiché « Normal » et sa zone ne serait plus protégée à l'insu de l'opérateur. Les détecteurs réels émettent un **signal de vie** périodique ; le PSIM considère donc le silence comme un défaut.

- Un détecteur « normal » ou « défaut » qui n'a rien émis depuis `PSIM_DETECTOR_TIMEOUT_S` secondes passe **« hors ligne »**. L'événement est inscrit au journal (`Détecteur muet — aucun message depuis 3 min`), la pastille devient grise et un compteur orange **« N détecteurs hors service »** s'affiche en haut de l'écran (il compte aussi les détecteurs en défaut). L'infobulle de chaque détecteur donne l'heure de son dernier message.
- Dès qu'il émet à nouveau, il reprend son état réel. S'il reprend avec une alarme, l'incident s'ouvre normalement.
- **Un détecteur en préalarme ou en alarme n'est jamais déclassé par le silence** : il garde son état, comme une centrale, tant qu'il n'est pas revenu à la normale. Sinon un silence pourrait masquer un feu en cours.
- Un détecteur jamais entendu depuis le démarrage du PSIM dispose du même délai, compté depuis le démarrage.
- Les caméras ne sont pas concernées (leur flux affiche déjà sa propre panne).

Réglage : **`PSIM_DETECTOR_TIMEOUT_S`**. Comptez 3 à 4 fois la période d'émission de vos détecteurs (période de 60 s : 180-240 s). `0` désactive. Valeur par défaut : **180 en exploitation** (`PSIM_SIM_ENABLED=0`), **désactivé en mode simulateur** : le simulateur et `npm run sim` n'envoient qu'un message ponctuel, sans signal de vie, et les détecteurs simulés passeraient sinon hors ligne au bout de 3 minutes. Le démarrage du PSIM affiche l'état de cette surveillance.

## Autres sources d'alarme : intrusion, contrôle d'accès, environnement

Un détecteur a une **catégorie** : `fire` (incendie, par défaut), `intrusion`, `access` (contrôle d'accès) ou `environment` (température, fuite d'eau, humidité…). Toutes passent par **le même circuit** : incident, acquittement, clôture, journal, notifications avec escalade, images des caméras liées, confirmation par un voisin. Seul change ce que dit l'équipement et la façon de le lire.

**Ce qu'un équipement peut envoyer** (MQTT `psim/detectors/<id>/state`, ou HTTP, voir plus bas). Un message contient l'un des trois, dans cet ordre de priorité :

| Message | Effet |
|---|---|
| `{"state": "alarm"}` | État déjà interprété par l'équipement : `normal`, `prealarm`, `alarm`, `fault`, `offline` |
| `{"event": "door_forced"}` | Événement nommé, voir ci-dessous |
| `{"value": 41.5}` | Mesure, comparée aux **seuils réglés dans le PSIM** (préalarme, alarme, sens « trop haut » ou « trop bas », unité) |

`value` peut accompagner `state` ou `event` : la mesure est alors seulement mémorisée et affichée. Une mesure sans seuil réglé est affichée sans rien déclencher.

Événements reconnus : **alarme** `intrusion`, `motion`, `glass_break`, `tamper`, `panic`, `door_forced`, `forced_entry`, `leak`, `flood`, `over_temperature` ; **préalarme** `door_held_open`, `badge_denied_repeated` ; **normal** `normal`, `clear`, `restored`, `door_closed`, `alarm_reset`, `dry` ; **défaut** `fault`, `low_battery` ; **simple signe de vie** `heartbeat`, `ping`, `badge_granted`, `badge_denied`, `door_opened`. Tout autre message est refusé (HTTP 400, ou ignoré en MQTT).

Un badge refusé isolé est un fait courant, pas un incident : c'est à la passerelle d'envoyer `badge_denied_repeated` après plusieurs refus rapprochés.

**Entrée HTTP** pour les systèmes qui poussent leurs événements sans parler MQTT :

```bash
curl -X POST http://serveur:3033/api/ingest/A-01 \
  -H "Authorization: Bearer $PSIM_INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"event": "door_forced"}'
```

Elle n'existe que si **`PSIM_INGEST_TOKEN`** est défini (24 caractères minimum, sinon le contrôle de démarrage le signale et l'entrée reste fermée). Jeton comparé en temps constant ; 5 échecs par minute bloquent l'adresse ; corps limité à 2 Ko ; le jeton n'apparaît jamais dans les journaux ni dans les réponses. Un seul jeton partagé : à placer derrière HTTPS dès que le réseau n'est pas isolé.

**Réglages** (administrateur, *Édition du plan* → choisir le détecteur) : catégorie, unité, seuils, sens, et **supervision**. Les capteurs hors incendie ne sont **pas supervisés par défaut** : un contact de porte n'émet qu'aux changements, le déclarer « muet » après quelques minutes serait une fausse panne. Pour un capteur qui émet en continu (température), renseignez le délai attendu ; vide = délai général, `0` = non supervisé. **Conséquence à connaître** : un capteur non supervisé qui tombe en panne ne le dit pas.

**Précisions de comportement**
- La confirmation par un voisin ne joue qu'entre détecteurs **de même catégorie** (un détecteur de fumée ne corrobore pas un contact de porte). Deux détecteurs de mouvement voisins se confirment.
- L'**indice de risque incendie** ne compte que les détecteurs et incidents d'incendie.
- Les notifications précisent le type (`ALARME INTRUSION`, `PREALARME CONTROLE D'ACCES`…) et la dernière mesure.
- La clôture d'un incident hors incendie propose « Intrusion avérée », « Accès anormal avéré » ou « Incident avéré ». En base, la qualification d'un événement réel reste `fire` pour toutes les catégories (donnée historique, pas de migration risquée) : à savoir si vous exploitez la base directement.
- Les caméras simulées ne dessinent fumée et flammes que pour l'incendie.
- Changer la catégorie d'un détecteur en incident est refusé.

Démonstration : le site contient un détecteur de mouvement (`I-01`), une porte de service (`A-01`), un capteur de température 30/38 °C (`E-01`) et un capteur d'eau (`E-02`), avec les scénarios `intrusion-nuit`, `porte-forcee`, `derive-temperature` et `fuite-eau` (`npm run demo -- --scenario=<id>`).

## Armement des zones d'intrusion

Un détecteur de mouvement n'a de sens que lorsque la zone est vide : en journée, il déclencherait en permanence. Chaque zone qui contient un détecteur d'**intrusion** est donc **armée** ou **désarmée**. Panneau **Armement des zones** (sous le plan, visible dès qu'il existe une telle zone).

**État effectif d'une zone**, du plus au moins prioritaire :
1. une **dérogation manuelle** (« Désarmer 1 h / 4 h / 12 h », « Armer maintenant »), ouverte à l'opérateur comme à l'administrateur. Elle **expire toujours** (24 h maximum, durée obligatoire) : un désarmement oublié ne laisse jamais une zone sans surveillance indéfiniment ;
2. le **planning hebdomadaire** de la zone, s'il y en a un (administrateur) : plages pendant lesquelles la zone est armée, en **heure locale du serveur**. Une plage de nuit (`19:00 → 07:00`, du lundi au vendredi) se termine le lendemain matin, donc la nuit du vendredi se prolonge le samedi matin ;
3. sinon, **armée en permanence**. Rien ne change tant qu'on ne configure rien.

**Ce que le désarmement ne masque jamais**
- le **sabotage** (`tamper`) et la **panique** (`panic`) d'un détecteur d'intrusion alarment toujours ;
- l'**incendie**, le **contrôle d'accès** et l'**environnement** ne sont jamais concernés par l'armement ;
- un incident **déjà ouvert** n'est pas fermé par un désarmement ; un retour à la normale ou un défaut passent toujours.

Un mouvement ignoré dans une zone désarmée est noté au journal (`Intrusion ignorée`), au plus une fois par minute et par détecteur. Chaque armement, désarmement et changement de planning est journalisé avec son auteur, y compris les changements automatiques dus au planning. Sur le plan, les détecteurs d'une zone désarmée sont estompés (contour pointillé).

**Limites** : pas de temporisation d'entrée/sortie (le désarmement est un geste manuel avant d'entrer) ; un mouvement survenu pendant le désarmement n'est pas rejoué à l'armement ; le planning suit l'heure du serveur (vérifiez le fuseau horaire de la machine) ; seuls les détecteurs d'intrusion sont armables.

## Rapports et exports

Panneau **Rapports et exports** (tout utilisateur connecté) : choisir une période (jours inclus, 366 maximum, 30 derniers jours par défaut) et éventuellement une catégorie.

- **Rapport imprimable** : synthèse chiffrée (incidents, critiques, événements réels, **taux de fausses alarmes**, **délai d'acquittement** médian et maximal, durée de clôture, alertes envoyées ou en échec), répartition par catégorie, zones et détecteurs les plus sollicités, détail de chaque incident. Il s'ouvre dans un onglet ; **Imprimer, puis « Enregistrer au format PDF »** produit le PDF (le PSIM ne fabrique pas de PDF lui-même : pas de composant supplémentaire à installer ni à surveiller).
- **Fiche d'incident** (lien « fiche » sur chaque incident clôturé, ou depuis le rapport) : chronologie complète du journal, alertes envoyées avec leur résultat, images des caméras. Pensée pour un assureur ou une enquête.
- **Exports CSV** des incidents et (administrateur) du **journal complet**, prêts pour Excel : séparateur `;`, UTF-8 avec marque BOM (accents corrects), dates à l'heure du serveur.

**Sûretés** : lecture seule, rien n'est modifié. Les textes saisis (noms, commentaires) sont **échappés** dans les pages et **neutralisés** dans les CSV (une cellule commençant par `=`, `+`, `-` ou `@` est préfixée, pour qu'Excel ne l'exécute pas comme une formule). Les pages n'embarquent aucun script en ligne. Chaque rapport ou export est **inscrit au journal** avec son auteur. Le rapport HTML liste au plus 2 000 incidents (il le dit), les exports CSV 50 000.

### Rapport automatique par e-mail

Pour que la direction reçoive le rapport sans rien demander : *Rapports et exports → Rapport automatique par e-mail* (administrateur).

- **Rythme** : chaque semaine (jour et heure au choix) ou chaque mois (jour 1 à 28). Hebdomadaire : les **7 jours entiers précédents** ; mensuel : le **mois civil précédent**. Heure du serveur.
- **Contenu** : le corps du message donne la synthèse (incidents, réels, fausses alarmes et leur taux, délai d'acquittement, alertes en échec, répartition par catégorie) et **dit si le PSIM a été aveugle** pendant la période, s'il y a des détecteurs hors service, ou si le journal a été signalé altéré. En pièces jointes : le **rapport complet autonome** (HTML sans script, à ouvrir dans un navigateur ou à imprimer en PDF) et l'**export CSV**. L'**empreinte du journal** y figure, ce qui l'ancre hors de la machine (voir « Journal infalsifiable »). Une semaine calme est envoyée aussi : c'est une preuve de bon fonctionnement.
- **Prérequis** : le serveur SMTP des alertes (`PSIM_SMTP_HOST`, `PSIM_SMTP_FROM`, etc.). Sans lui, l'activation est refusée. Jusqu'à 20 destinataires.
- **Garde-fous** : l'activation **n'envoie rien d'arrière** (seul le prochain envoi prévu part) ; un envoi manqué parce que le PSIM était arrêté est **rattrapé pendant 3 jours**, pas au-delà (un rapport périmé n'est pas envoyé, et le journal le dit) ; en cas d'échec, **3 essais espacés de 10 minutes**, puis abandon journalisé et avertissement dans *Système* ; jamais deux envois pour la même période.
- **Envoyer le dernier rapport maintenant** : envoi immédiat de la dernière période complète, pour vérifier le rendu ; il ne modifie pas le calendrier.

**Limites** : les durées sont mesurées entre l'ouverture de l'incident et l'action de l'opérateur (pas le temps d'intervention sur le terrain) ; les dates suivent le fuseau horaire du serveur ; le message n'est ni signé ni chiffré (le rapport ne contient pas d'identifiants, mais des noms d'équipements et de zones : choisir les destinataires en conséquence) ; si le PSIM est coupé du réseau ou éteint à l'heure prévue, le rapport n'est pas envoyé, et seule la supervision externe le signale.

## Reprise après panne et supervision externe

Un PSIM arrêté ne surveille rien, et ne peut pas le dire. Trois protections complémentaires :

**1. Savoir qu'on a été aveugle.** Le PSIM inscrit en base un signe de vie toutes les 10 s, et une marque à l'arrêt volontaire. Au redémarrage, l'écart est la **période sans surveillance** : inscrite au journal (`Période sans surveillance`, arrêt volontaire ou **INATTENDU**), affichée dans *Système*, signalée par un avertissement pendant 24 h après un arrêt inattendu, et **notifiée** (niveau 1) si elle dure au moins `PSIM_GAP_NOTIFY_S` secondes (60 par défaut) : « le PSIM n'a rien surveillé de 02:10 à 02:17, une alarme a pu passer inaperçue, vérifier les zones ». Un redémarrage volontaire court n'est pas signalé ; une horloge revenue en arrière n'invente pas d'écart.

**2. Être prévenu quand le PSIM meurt.** Il envoie un simple signal HTTP à un service **externe** qui s'inquiète de ne plus le recevoir (*dead man's switch*). Réglage : **`PSIM_HEARTBEAT_URL`** (et `PSIM_HEARTBEAT_EVERY_S`, 60 s par défaut). Compatible [healthchecks.io](https://healthchecks.io) (gratuit pour un petit usage), Uptime Kuma (monitor « push ») ou tout service qui attend un appel. Quand la santé du PSIM est dégradée (boucle de contrôle figée, base inaccessible), il appelle `<adresse>/fail`. Rien du site n'est transmis, seulement un appel vide. L'adresse contient en général un jeton : elle n'apparaît **jamais** en entier (journaux, écran : seul l'hôte), les redirections ne sont pas suivies, et **`https://` est exigé en production**. Un échec d'envoi ne gêne pas le PSIM ; il est journalisé une fois, avec le rétablissement. Au démarrage en production, l'absence de supervision externe est signalée.

> À configurer côté service : une « période » égale à l'intervalle choisi et un délai de grâce de quelques minutes, avec alerte par e-mail ou SMS **vers quelqu'un qui n'est pas derrière le même réseau que le PSIM**. Un service externe qui prévient la même boîte e-mail que le PSIM ne vaut rien si le PSIM est coupé du réseau.

**3. Relance automatique, y compris des blocages : `npm run supervise`.** Superviseur portable (Windows, Linux, macOS), sans composant à installer :
- PSIM **planté ou tué** : relancé avec une pause croissante (1, 2, 4… 60 s au plus), remise à 1 s après 10 minutes de bon fonctionnement. Il **ne renonce jamais** ; chaque redémarrage est tracé et notifié par le PSIM lui-même (point 1) ;
- PSIM **bloqué** (il tourne mais `/healthz` ne répond plus ou signale une boucle de contrôle figée) : arrêté de force après **3 échecs consécutifs** (sonde toutes les 30 s, après 60 s de démarrage), puis relancé, y compris ses processus enfants (ffmpeg) ;
- **arrêt volontaire** (Ctrl+C, arrêt du service) : le PSIM reçoit une demande d'arrêt **propre** (canal interne, valable sous Windows où SIGTERM n'existe pas), forcée au bout de 10 s ; rien n'est relancé et le prochain démarrage ne parlera pas de plantage.

Sous Windows, le lancer à l'ouverture de la machine (tâche planifiée, voir `scripts/windows-service.ps1`) ; sous Linux, `deploy/psim.service` (systemd, `Restart=always`) relance déjà, et `npm run supervise` ou `npm run healthcheck -- --restart 3` y ajoute la détection des blocages. **Limite** : le superviseur et le PSIM tournent sur la même machine : une machine éteinte ou coupée du réseau n'est détectée que par la supervision externe (point 2), pas par le superviseur. Pas de bascule vers une seconde machine : une seule instance (verrou de données), pas de haute disponibilité.

## Journal infalsifiable

Chaque entrée du journal contient l'**empreinte SHA-256 de la précédente** (chaîne, comme une blockchain sans réseau) : modifier, supprimer ou insérer une ligne après coup rompt la chaîne **à cet endroit**, et la vérification désigne l'entrée en cause.

- **Vérification automatique** au démarrage puis toutes les 6 h, et à la demande (*Système → Vérifier le journal*). Une altération est inscrite au journal, affichée en **alerte critique**, et **notifiée** aux niveaux 1 et 2 (`JOURNAL ALTERE`). Une seule alerte par altération, et un message quand la chaîne redevient cohérente.
- **Hors PSIM** : `npm run verify-journal` (lecture seule, sans démarrer le PSIM ; `--db <fichier>` pour une copie ou une sauvegarde). Code de sortie 0 (intègre), 1 (altéré), 2 (erreur d'usage).
- **Ancres** : l'empreinte de la dernière entrée (`1234:ab12…`) est mémorisée chaque jour, **imprimée en pied des rapports et fiches d'incident**, et **enregistrée dans le manifeste de chaque sauvegarde**. Comparer à une ancre conservée ailleurs : `npm run verify-journal -- --anchor 1234:ab12…` ou `-- --manifest backups/<sauvegarde>/manifest.json`.

**Ce que cela protège, et ce que cela ne protège pas** (à dire tel quel à un assureur ou un auditeur) :
- Protège contre une modification ou une suppression **maladroite ou partielle** : quelqu'un qui change une ligne, en efface une ou en ajoute une dans la base.
- Ne protège **pas, seule**, contre quelqu'un qui a un accès complet à la base **et** connaît ce mécanisme : il peut recalculer toute la chaîne depuis la ligne modifiée. C'est le rôle des **ancres conservées hors de la machine** : une chaîne réécrite ne correspond plus à l'ancre d'un rapport envoyé par e-mail ou d'une sauvegarde copiée ailleurs, et la vérification le montre. Sans ancre externe, ce cas n'est pas détecté. De même, la suppression de la **fin** du journal n'est détectée qu'avec une ancre plus récente.
- Ne couvre que le **journal** (`audit_log`) : pas les incidents, les comptes, ni l'historique des notifications. Les entrées **antérieures** à l'activation (mise à jour) ne sont pas protégées ; elles sont comptées à part.
- Ce n'est pas un horodatage certifié : l'heure reste celle du serveur.

## Architecture

```
détecteur ──MQTT──► broker embarqué (aedes) ─┐
  psim/detectors/<id>/state                  ▼
                                    moteur de corrélation ──► SQLite (node:sqlite)
caméras (simulées) ◄── mur vidéo             │
                                             ▼
                          API REST + WebSocket ──► interface web (un écran)
```

| Fichier | Rôle |
|---|---|
| `server/engine.ts` | Règle unique : alarme → incident → caméras liées ; acquittement, clôture, inventaire, journal |
| `server/mqtt.ts` | Broker MQTT (127.0.0.1, authentifié, publication limitée aux topics détecteurs) |
| `server/api.ts` | API REST, sessions par cookie, rôles, plan du site |
| `server/db.ts` | Schéma SQLite (un seul incident actif par détecteur, garanti par la base) |
| `web/` | Interface : plan, mur vidéo, incidents, journal, simulateur, édition |
| `server/onvif.ts` | Client ONVIF (Profile S/T) : choix du flux le plus léger, recherche réseau |
| `server/video.ts` | Sources caméra chiffrées, ffmpeg RTSP → images JPEG, un seul flux partagé par caméra |
| `server/preflight.ts` | Contrôle de démarrage : refus en production si mal configuré |
| `server/users.ts`, `server/totp.ts` | Comptes, rôles, sessions, double authentification TOTP et codes de secours |
| `server/recipients.ts` | Destinataires de notification modifiables à chaud |
| `server/backup.ts`, `server/lock.ts` | Sauvegarde / restauration vérifiées ; verrou d'instance unique |
| `server/system.ts`, `server/tls.ts`, `server/logger.ts` | Santé et état système ; HTTPS ; journaux avec rotation |
| `server/sources.ts` | Lecture des messages d'équipements : états, événements nommés, mesures et seuils (intrusion, accès, environnement) |
| `server/arming.ts` | Armement des zones d'intrusion : planning hebdomadaire, dérogations qui expirent, journal |
| `server/reports.ts` | Rapports et exports : statistiques d'incidents, CSV sûrs pour Excel, rapport imprimable, fiche d'incident |
| `server/continuity.ts` | Signe de vie en base, période sans surveillance au redémarrage (arrêt propre ou inattendu) |
| `server/heartbeat.ts` | Signal de supervision externe (dead man's switch), adresse jamais exposée |
| `scripts/commission.ts`, `scripts/commission/` | Mise en service : contrôles d'installation, recette des détecteurs (watch), fiche de recette imprimable |
| `scripts/supervise.ts` | Superviseur portable : relance avec pause croissante, détection des blocages, arrêt propre |
| `server/auditchain.ts`, `server/journal.ts` | Journal infalsifiable : chaîne d'empreintes, vérification, ancres, alerte d'altération |
| `scripts/verify-journal.ts` | Vérification du journal hors PSIM (base, sauvegarde, ancre externe) |
| `server/reportmail.ts` | Rapport périodique par e-mail : calendrier, rattrapage borné, reprises, contenu |
| `server/risk.ts` | Indice de risque par zone, priorités d'action chiffrées, tendances |
| `server/notifications.ts` | Notifications e-mail / Telegram / webhook, niveaux, escalade, rappels, reprises |
| `server/snapshots.ts` | Images des caméras prises à l'ouverture, l'aggravation et la confirmation d'un incident |
| `server/secrets.ts` | Chiffrement AES-256-GCM des mots de passe des caméras |
| `web/account.js`, `web/users.js` | Mon compte (mot de passe, 2FA), utilisateurs, destinataires |
| `web/sources.js` | Catégories : libellés, simulateur, réglages d'un capteur (seuils, supervision) |
| `web/arming.js` | Panneau d'armement des zones et éditeur de planning |
| `web/reports.js`, `web/report.css` | Panneau d'exports ; style des pages de rapport imprimables |
| `web/risk.js` | Vue « Risques » : indice du site, zones, priorités, évaluation |
| `web/camera.js` | Caméra simulée dans le navigateur (démonstration rapide, sans RTSP) |
| `scripts/demo.ts`, `scripts/demo/` | Environnement de démonstration : caméras RTSP simulées, scénarios, orchestration |
| `scripts/install-mediamtx.ts` | Installation vérifiée de MediaMTX |
| `web/live.js` | Lecteur de caméra réelle : lit le flux du serveur, détecte coupures et gels |

Message MQTT attendu sur `psim/detectors/<id>/state` : `{"state": "normal" | "prealarm" | "alarm" | "fault" | "offline"}`, ou `{"event": …}` / `{"value": …}` pour les autres sources (voir plus haut).

## Mise en service sur site

Tout le PSIM a été éprouvé avec des équipements **simulés** ; **aucun équipement réel n'a été testé**. Pour que la première rencontre avec le matériel réel soit méthodique, le PSIM livre un **guide** ([docs/MISE-EN-SERVICE.md](docs/MISE-EN-SERVICE.md) : de la machine vide à la recette signée) et trois outils, en lecture seule, qui n'envoient aucune alerte :

- **`npm run commission`** contrôle l'installation réelle, point par point, avec la marche à suivre pour chaque problème : configuration, **heure** (écart mesuré si une référence externe est réglée), **certificat HTTPS** (expiration, correspondance avec la clé), **ffmpeg**, **SMTP** (connexion et authentification sans rien envoyer), **Telegram** (jeton valide), **webhooks** (joignables, sans requête), **supervision externe** (signal réel), **disque**, **sauvegardes** (intégrité de la dernière), **caméras** (une image reçue de chacune), **inventaire** (détecteurs jamais entendus, sans zone, sans caméra liée, administrateurs sans 2FA) et **intégrité du journal**. Messages de test sur demande uniquement : `--send-mail <adresse>`, `--telegram-chat <id>`. Code de sortie 1 s'il y a un échec. Une base d'une version antérieure est reconnue (le PSIM doit d'abord la migrer en démarrant).
- **`npm run commission -- watch`** est la **recette des détecteurs** : écoute le broker et dit, message par message, ce que le PSIM comprend (`OK … -> ALARME`, `INCONNU` : identifiant absent de l'inventaire, `ILLISIBLE` : JSON, état, événement ou valeur invalides, message de plus de 1 Ko). Au bilan : détecteurs entendus, **silencieux**, inconnus, illisibles. Options : `--minutes`, `--until-all`, `--allow-missing`. Les messages reçus sont traités par le PSIM comme de vraies alarmes : prévenir les destinataires avant.
- **`npm run commission -- sheet --out recette.html`** produit la **fiche de recette** imprimable : une ligne par équipement de l'inventaire (message reçu, alarme testée, image visible, retour à la normale), les essais de bout en bout (alarme, escalade, pannes, sécurité) et les signatures.

**Limites** : ces outils vérifient ce qu'ils peuvent mesurer depuis le serveur ; ils ne remplacent pas la constatation sur place (le détecteur déclenche-t-il vraiment, la sirène retentit-elle, le destinataire a-t-il reçu l'alerte). Les équipements qui ne parlent pas MQTT/JSON demandent une **passerelle** de traduction, hors périmètre du PSIM.

## Passer aux équipements réels

- **Détecteurs** : publier sur le topic ci-dessus (directement ou via une passerelle vers MQTT). Rien d'autre à changer. Voir « Mise en service sur site » pour la recette, détecteur par détecteur.
- **Plan** : en administrateur, *Édition du plan* → *Remplacer le plan* (PNG, JPEG, WEBP ou SVG), puis glisser les pastilles à leur emplacement réel.
- **Caméras** : voir la section suivante.

## Brancher une caméra ONVIF réelle

Prérequis : `ffmpeg` installé (dans le `PATH`, ou chemin dans `PSIM_FFMPEG`) et une caméra joignable depuis le poste qui fait tourner le PSIM. Sur la caméra, créer un compte dédié en **lecture seule** et vérifier que son **heure est correcte** (ONVIF refuse les identifiants si l'horloge dérive).

1. Se connecter en `admin` → *Édition du plan et de l'inventaire* → cocher *Mode édition*.
2. Cliquer sur la pastille de la caméra à remplacer (ou en ajouter une, puis la glisser à sa place).
3. Dans *Source vidéo* : choisir **Caméra ONVIF**, puis *Rechercher sur le réseau* (ou saisir l'adresse IP à la main), renseigner utilisateur et mot de passe.
4. Cliquer **Enregistrer et tester** : le message indique le modèle de la caméra, le profil choisi et confirme qu'une image a été reçue.

Si ONVIF ne fonctionne pas sur votre modèle, choisir **Flux RTSP direct** avec le chemin du flux (souvent indiqué dans la fiche du constructeur, par exemple `/Streaming/Channels/102`).

Fonctionnement :

- Le PSIM interroge la caméra en ONVIF, choisit le profil **le moins lourd** (H.264 ou JPEG, plus petite résolution) et reçoit son adresse RTSP. L'adresse annoncée par la caméra est ignorée au profit de celle que vous avez saisie.
- `ffmpeg` convertit le flux en images JPEG (640 px, 8 images/s), affichées dans le mur vidéo. **Un seul `ffmpeg` par caméra**, quel que soit le nombre d'opérateurs, arrêté 5 secondes après le départ du dernier.
- 6 flux simultanés au maximum (le mur en affiche 4).
- Les mots de passe sont **chiffrés en base** (AES-256-GCM). La clé est dans `data/secret.key` (ou `PSIM_SECRET_KEY`) : la sauvegarder séparément de la base, la perdre oblige à ressaisir les mots de passe. Ils ne sont jamais renvoyés au navigateur, ni écrits dans le journal ni dans les logs.
- Une caméra en panne affiche la cause dans sa vignette (connexion refusée, identifiants refusés, chemin introuvable…) et le PSIM retente automatiquement.

Limites :

- Image seule (pas de son, pas de pilotage PTZ, pas d'enregistrement).
- Le mot de passe apparaît dans les arguments du processus `ffmpeg` le temps du flux : réserver le poste PSIM à des utilisateurs de confiance.
- Caméras en H.265 : décodées par `ffmpeg`, plus coûteux en processeur ; le PSIM préfère le profil H.264 quand la caméra en propose un.
- La recherche réseau utilise la multidiffusion UDP : elle peut être bloquée par le pare-feu Windows ou ne pas traverser un autre sous-réseau. Saisir l'adresse à la main dans ce cas.

## Tests

```bash
npm test          # moteur, chiffrement, flux vidéo (ffmpeg réel), dialogue ONVIF simulé, scénarios de démo
npm run typecheck
```

## Limites connues du MVP

- Sessions gardées en mémoire : une déconnexion des utilisateurs a lieu à chaque redémarrage.
- Un seul site, un seul plan, une seule instance (pas de haute disponibilité).
- Armement : seuls les détecteurs d'intrusion sont armables (voir plus haut). Pas de gestion de badges ni de portes, pas de commande des équipements : le PSIM écoute, il ne pilote rien.
- Pas de prise en charge native des protocoles de terrain (BACnet, Modbus, OPC UA, Wiegand…) : passer par une passerelle vers MQTT ou HTTP.
- Matériel réel (détecteurs, caméras, SMTP, Telegram) jamais testé ici : tout a été validé avec des équipements simulés.

