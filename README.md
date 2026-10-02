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
- **les détecteurs**, qui publient sur MQTT comme de vrais équipements.

Le PSIM de démonstration est sur http://127.0.0.1:3034 (broker MQTT sur 1884, RTSP sur 8554) : il peut tourner en même temps que votre installation habituelle. Sur la page de connexion, cliquer sur « Administrateur » ou « Opérateur » remplit les champs. Les identifiants de lecture des caméras (générés au hasard à chaque lancement) sont affichés dans le terminal : vous pouvez les saisir à la main dans *Source vidéo* pour essayer le formulaire.

Scénarios (menu dans le terminal : taper le numéro, `r` pour tout remettre au calme, `a` pour le mode automatique, `q` pour quitter) :

| # | Scénario | Ce qu'il montre |
|---|---|---|
| 1 | `fausse-alarme-vapeur` | Un détecteur se déclenche alors que la caméra ne montre que de la vapeur : à qualifier « fausse alarme » |
| 2 | `incendie-atelier` | Préalarme, alarme, flammes à l'atelier, puis propagation à l'entrepôt : deux incidents critiques |
| 3 | `surchauffe-serveurs` | Alarme immédiate en salle serveurs, sans préalarme |
| 4 | `defaut-detecteur` | Défaut technique : le statut change, aucun incident n'est créé |
| 5 | `detecteur-hors-ligne` | Perte de contact d'un détecteur |

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
| `server/secrets.ts` | Chiffrement AES-256-GCM des mots de passe des caméras |
| `web/camera.js` | Caméra simulée dans le navigateur (démonstration rapide, sans RTSP) |
| `scripts/demo.ts`, `scripts/demo/` | Environnement de démonstration : caméras RTSP simulées, scénarios, orchestration |
| `scripts/install-mediamtx.ts` | Installation vérifiée de MediaMTX |
| `web/live.js` | Lecteur de caméra réelle : lit le flux du serveur, détecte coupures et gels |

Message MQTT attendu : `{"state": "normal" | "prealarm" | "alarm" | "fault" | "offline"}` sur `psim/detectors/<id>/state`.

## Passer aux équipements réels

- **Détecteurs** : publier sur le topic ci-dessus (directement ou via une passerelle vers MQTT). Rien d'autre à changer.
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

- Pas de HTTPS intégré : à placer derrière un proxy TLS pour tout usage hors poste local (`PSIM_COOKIE_SECURE=1`).
- Sessions gardées en mémoire : une déconnexion des utilisateurs a lieu à chaque redémarrage.
- Un seul site, un seul plan.
- Pas de détection de perte de contact d'un détecteur (« hors ligne » n'est reçu que s'il est publié).

