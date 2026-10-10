# Passerelle GAMR

La **Passerelle GAMR** est un petit programme, installé sur le même poste que le PSIM (ou sur un poste du site), qui **traduit les équipements qui ne parlent ni MQTT ni HTTP** — capteurs Zigbee, automates Modbus, onduleurs, centrales d'alarme (SIA DC-09), capteurs LoRaWAN — vers le PSIM.

Pour le PSIM, la passerelle est un **client MQTT ordinaire** : elle publie l'état de chaque équipement sur `psim/detectors/<identifiant>/state`, exactement comme un détecteur MQTT. Rien d'autre n'est à changer dans le PSIM.

```
 Capteurs Zigbee ──► Zigbee2MQTT ─┐
 Automate Modbus ─────────────────┤
 Onduleur ────────────────────────┤──► Passerelle GAMR ──(MQTT, compte dédié)──► PSIM
 Centrale d'alarme (SIA) ─────────┤        │
 Capteurs LoRaWAN ──► ChirpStack ─┘        └── file d'envoi sur disque (aucune perte pendant une coupure)
```

## Ce qu'il faut savoir avant de commencer

- **Aucune alarme perdue pendant une coupure.** Chaque message est écrit sur le disque **avant** d'être envoyé. Si le PSIM est arrêté, redémarre, ou si le réseau tombe, la passerelle garde les messages et les envoie **dans l'ordre** dès le retour, avec **l'heure réelle** de l'événement. Un arrêt, un plantage ou une coupure de courant de la passerelle elle-même ne perd rien non plus.
- **Pas de doublon.** Chaque message porte un identifiant unique (`msgId`) conservé lors des renvois : un message reçu deux fois par le PSIM ne compte qu'une fois.
- **La file a une taille maximale** (10 000 messages / 20 Mo par défaut). Au-delà — coupure de plusieurs jours avec beaucoup d'équipements bavards — les messages **les plus anciens** sont abandonnés, et le journal le dit. Le PSIM refuse de toute façon un message vieux de plus de 7 jours.
- **Un compte MQTT par passerelle**, limité à ses équipements : une passerelle compromise ne peut pas parler au nom des autres détecteurs.
- **Heure réelle et anti-doublon** : ils demandent un PSIM à jour (prise en charge de `ts` et `msgId`). Avec un PSIM plus ancien, les messages arrivent quand même, mais datés de leur arrivée.

## 1. Créer le compte MQTT de la passerelle (côté PSIM)

Dans le fichier d'environnement du PSIM (`.env`, ou `.env.production`), ajouter (ou compléter) la variable `PSIM_MQTT_GATEWAYS`. C'est une liste JSON, **sur une seule ligne**, d'un compte par passerelle :

```
PSIM_MQTT_GATEWAYS=[{"user":"gw1","password":"un-mot-de-passe-long-et-unique","detectors":["GW-01","Z-*","M-*"]}]
```

- `user` : nom du compte (lettres, chiffres, `.`, `_`, `-` ; différent du compte principal `PSIM_MQTT_USER`).
- `password` : **12 caractères minimum**, propre à cette passerelle.
- `detectors` : les identifiants PSIM que la passerelle a le droit d'alimenter. `Z-*` veut dire « tout identifiant qui commence par `Z-` ». Prévoir une convention de nommage par passerelle (ex. `Z-` pour Zigbee, `M-` pour Modbus).

Puis **redémarrer le PSIM** et vérifier sa configuration : `npm run check-config` (ou `check-config:prod`).

Si la passerelle n'est **pas sur le même poste** que le PSIM, le broker du PSIM doit écouter sur le réseau (`PSIM_MQTT_HOST=0.0.0.0`) **et** être chiffré (`PSIM_MQTT_TLS_CERT` / `PSIM_MQTT_TLS_KEY`) : voir le README, « Mise en production ».

Enfin, **déclarer chaque équipement dans le PSIM** (menu Équipements), avec exactement le même identifiant que celui configuré dans la passerelle. Un message pour un identifiant inconnu du PSIM est ignoré.

## 2. Installer la passerelle

La passerelle est livrée avec le PSIM (dossier `gateway\`). Node.js 24 ou plus est déjà installé pour le PSIM.

1. **Le mot de passe** : créer le dossier `gateway\secrets\` et y écrire le mot de passe du compte (le même que dans `PSIM_MQTT_GATEWAYS`) dans un fichier texte, par exemple `gateway\secrets\psim-password.txt`, **sur une seule ligne**. Ce dossier n'est jamais versionné. Le restreindre aux administrateurs :
   ```
   icacls gateway\secrets /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
   ```
2. **La configuration** : copier `gateway\config.example.json` en `gateway\config.json` et l'adapter (voir ci-dessous).
3. **Vérifier** sans rien lancer :
   ```
   npm run gateway:check-config
   ```
   Le résultat liste la configuration (jamais le mot de passe), dit si chaque module accepte sa configuration, puis si le PSIM est joignable et accepte le compte. `OK` en dernière ligne = prêt.
4. **Essayer** au premier plan (Ctrl+C pour arrêter) :
   ```
   npm run gateway
   ```
5. **Installer en démarrage automatique** (PowerShell **ouvert en administrateur**, depuis le dossier du PSIM) :
   ```
   .\scripts\gateway-service.ps1 -Action Install
   ```
   Même fonctionnement et mêmes protections que le service du PSIM : la passerelle démarre avec la machine (même sans session ouverte), elle est **relancée** en quelques secondes si elle s'arrête ou se bloque, et l'installation est **refusée** si le dossier est modifiable par des utilisateurs ordinaires (ils pourraient sinon faire exécuter leur code par la tâche). Options : `-Background` (compte courant, sans fenêtre), `-AtLogon` (essais), `-User` (compte de service dédié), `-Config C:\chemin\config.json`, `-WhatIf` (voir sans rien faire).

   Ensuite :
   ```
   .\scripts\gateway-service.ps1 -Action Status     # tâches, PSIM connecté ?, messages en attente, état de chaque module
   .\scripts\gateway-service.ps1 -Action Restart    # après une modification de la configuration
   .\scripts\gateway-service.ps1 -Action Stop
   .\scripts\gateway-service.ps1 -Action Uninstall  # la file d'envoi et les journaux sont gardés
   ```

## 3. Le fichier de configuration

Exemple (`gateway\config.example.json`) :

```json
{
  "name": "passerelle-site-1",
  "psim": {
    "url": "mqtt://127.0.0.1:1883",
    "username": "gw1",
    "passwordFile": "secrets/psim-password.txt",
    "detectors": ["GW-01", "Z-*", "M-*"]
  },
  "dataDir": "data",
  "queue": { "maxMessages": 10000, "maxBytes": 20971520 },
  "retry": { "minMs": 1000, "maxMs": 60000 },
  "moduleRetry": { "minMs": 5000, "maxMs": 300000 },
  "log": { "file": true, "level": "info" },
  "modules": [
    { "name": "heartbeat", "config": { "deviceId": "GW-01", "everyS": 60 } }
  ]
}
```

| Clé | Rôle |
|---|---|
| `name` | Nom de la passerelle dans les journaux (facultatif). |
| `psim.url` | Adresse du broker du PSIM : `mqtt://hôte:port`, ou `mqtts://hôte:port` (chiffré). Pas d'identifiant dans l'adresse. |
| `psim.username` | Le compte créé à l'étape 1. |
| `psim.passwordFile` | Fichier contenant le mot de passe (**recommandé**). Autres possibilités, une seule à la fois : `passwordEnv` (nom d'une variable d'environnement, par exemple définie dans `gateway\.env`) ou `password` (en clair dans la configuration, déconseillé). |
| `psim.ca` | Certificat (PEM) de l'autorité du broker, pour un `mqtts://` au certificat auto-signé. |
| `psim.detectors` | Facultatif : la même liste que côté PSIM. Un message hors liste est refusé tout de suite, avec un message clair dans le journal. |
| `dataDir` | Dossier de la file d'envoi, de l'état et des journaux (`data` à côté du fichier de configuration par défaut). Le compte de service doit pouvoir y écrire. |
| `queue` | Taille maximale de la file d'envoi (nombre de messages, octets). |
| `retry` | Pause entre deux essais de connexion au PSIM : elle double à chaque échec, de `minMs` jusqu'à `maxMs`. |
| `moduleRetry` | Idem pour un module qui n'arrive pas à démarrer. |
| `log` | `file` : journal dans `<dataDir>\logs\gateway.log` (rotation automatique, 5 Mo × 4) ; `level` : `info`, `warn` ou `error`. |
| `modules` | Les modules à lancer : `name` (le module), `config` (ses réglages, voir sa page), et au besoin `label` (pour lancer deux fois le même module avec des réglages différents) et `enabled: false` (désactivé sans effacer ses réglages). |

Les chemins relatifs sont relatifs au **dossier du fichier de configuration**. Toute clé inconnue est une erreur (une faute de frappe ne passe pas inaperçue) ; toutes les erreurs sont listées d'un coup.

**Secrets des modules** : dans la section `config` d'un module, une valeur `{"$env": "NOM"}` est remplacée par la variable d'environnement `NOM`, et `{"$file": "secrets/zigbee.txt"}` par le contenu de ce fichier. Exemple : `"password": {"$file": "secrets/z2m-password.txt"}`.

## 4. Les modules

| Module | Équipements | Page |
|---|---|---|
| `heartbeat` | Signe de vie de la passerelle elle-même (voir ci-dessous) | ci-dessous |
| `zigbee` | Capteurs Zigbee via Zigbee2MQTT (fumée, ouverture, mouvement, fuite, gaz…) | [gateway/docs/zigbee.md](../gateway/docs/zigbee.md) |
| `modbus` | Automates et capteurs Modbus TCP/RTU | [gateway/docs/modbus.md](../gateway/docs/modbus.md) |
| `ups` | Onduleurs (coupure secteur, batterie) | [gateway/docs/ups.md](../gateway/docs/ups.md) |
| `sia` | Centrales d'alarme intrusion/incendie (protocole SIA DC-09) | [gateway/docs/sia.md](../gateway/docs/sia.md) |
| `lorawan` | Capteurs LoRaWAN via ChirpStack | [gateway/docs/lorawan.md](../gateway/docs/lorawan.md) |

**`heartbeat` — à mettre sur toute passerelle.** Il envoie un signe de vie (`heartbeat`) pour un équipement PSIM dédié (ex. `GW-01`, à déclarer dans le PSIM) toutes les `everyS` secondes. Si la passerelle s'arrête, perd le réseau ou que son poste s'éteint, le PSIM voit cet équipement passer **« Hors ligne »** (délai `PSIM_DETECTOR_TIMEOUT_S`, à régler à 3 ou 4 fois `everyS`) et prévient. C'est aussi le moyen le plus simple de **valider la mise en service** : sans aucun équipement branché, `GW-01` doit apparaître en ligne dans le PSIM.

## 5. Dépannage

Le journal est dans `<dataDir>\logs\gateway.log` (par défaut `gateway\data\logs\gateway.log`). `.\scripts\gateway-service.ps1 -Action Status` résume l'état.

| Symptôme (journal) | Cause probable | Que faire |
|---|---|---|
| `Configuration invalide (...)` au démarrage | Faute dans `config.json` | Lire la liste des erreurs, corriger, relancer `npm run gateway:check-config`. |
| `connexion refusee : identifiant ou mot de passe de la passerelle incorrect` | Compte absent de `PSIM_MQTT_GATEWAYS`, mot de passe différent, ou PSIM pas redémarré après l'ajout | Comparer les deux côtés ; redémarrer le PSIM. |
| `PSIM injoignable (...) ; nouvel essai dans ...` | PSIM arrêté, mauvais port, pare-feu, broker en `127.0.0.1` alors que la passerelle est sur un autre poste | Les messages s'accumulent sur disque sans perte. Vérifier `PSIM_MQTT_HOST` / `PSIM_MQTT_PORT` et le pare-feu. |
| `message pour X refuse N fois par le PSIM ... mis de cote dans rejected.jsonl` | L'identifiant `X` n'est pas dans les `detectors` du compte côté PSIM | Ajouter l'identifiant (ou le préfixe) dans `PSIM_MQTT_GATEWAYS`, ou corriger l'identifiant dans le module. Le message refusé est gardé dans `<dataDir>\rejected.jsonl` pour analyse. |
| `message rejete pour X : equipement hors de psim.detectors` | Même cause, détectée par la passerelle elle-même | Idem, puis mettre `psim.detectors` à jour. |
| `message rejete pour X : ...` (autre raison) | Le module a produit un message invalide (identifiant, état, heure en secondes...) | Le signaler au responsable du module, avec la ligne du journal. |
| `evenement « ... » inconnu de cette passerelle` | Événement nouveau | Sans gravité si le PSIM le connaît ; sinon le PSIM l'ignorera. |
| `file d'envoi pleine ... abandonne(s)` | Coupure longue avec beaucoup de messages | Rétablir la liaison avec le PSIM ; au besoin augmenter `queue.maxMessages` / `queue.maxBytes`. |
| `[module] echec du demarrage (...) ; nouvel essai dans ...` | Le module n'arrive pas à joindre son équipement ou son broker (Zigbee2MQTT, ChirpStack...) | Les autres modules continuent. Corriger la cause (adresse, identifiants, câble) : le module redémarre seul au prochain essai. |
| `Une autre passerelle utilise deja ce dossier de donnees` | Deux passerelles lancées sur la même configuration (par exemple `npm run gateway` alors que la tâche planifiée tourne) | Arrêter l'une des deux (`-Action Stop`). |
| `ligne(s) illisible(s) ignoree(s)` | Coupure de courant pendant une écriture | Sans gravité : seule la ligne interrompue est perdue (elle n'avait pas encore été acceptée). |

**Remettre la file à zéro** (uniquement si l'on sait que les messages en attente sont sans intérêt, par exemple après des essais) : arrêter la passerelle, supprimer `<dataDir>\queue.jsonl`, relancer.

## 6. Pour les développeurs de modules

Le contrat entre le socle et les modules est dans `gateway/src/module.ts` (à ne pas modifier sans accord). Un module est un dossier `gateway/src/modules/<nom>/index.ts` qui exporte `create(config)` ; il reçoit un contexte avec `emit(deviceId, message)` (ne lève jamais : le socle valide, date, numérote, met en file et renvoie), `openMqtt(url, identifiants)` (lecture d'un autre broker, reconnexion automatique, TLS en `mqtts://`), `log`, `config` et `now`. Exemple de référence : `gateway/src/modules/heartbeat/index.ts`. Un module qui échoue au démarrage est arrêté puis relancé plus tard, sans gêner les autres ; ses liaisons MQTT sont fermées automatiquement. Le nom d'un module est limité à des minuscules, chiffres, `-` et `_` : impossible de charger un fichier hors du dossier des modules.

Essais : `npm test` (les essais de la passerelle sont dans `gateway/test/`, contre le vrai broker du PSIM) ; `npm run typecheck`.
