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

**Secrets des modules** : dans la section `config` d'un module, **n'importe quelle valeur** peut être remplacée par `{"$env": "NOM"}` (la variable d'environnement `NOM`, par exemple définie dans `gateway\.env`) ou par `{"$file": "secrets/fichier.txt"}` (le contenu de ce fichier, sur une ligne ; chemin relatif au dossier de la configuration). Le remplacement a lieu au chargement, avant que le module ne voie sa configuration : une variable absente ou un fichier illisible est une **erreur de configuration** (le nom de la variable ou le chemin est cité, jamais la valeur). Exemples vérifiés par les essais (`gateway/test/modules-load.test.ts`) :

```json
{ "name": "zigbee",  "config": { "broker": { "url": "mqtt://127.0.0.1:1883", "username": "gamr-lecture", "password": { "$file": "secrets/z2m.txt" } }, "devices": { "...": {} } } }
{ "name": "lorawan", "config": { "broker": { "url": "mqtt://192.168.1.20:1883", "username": "gamr", "password": { "$env": "CHIRPSTACK_PASSWORD" } }, "devices": { "...": {} } } }
{ "name": "sia",     "config": { "listen": { "host": "192.168.1.10", "port": 12300 }, "accounts": { "0457": { "key": { "$file": "secrets/sia-0457.txt" }, "defaultId": "centrale-entrepot" } } } }
{ "name": "ups",     "config": { "ups": [{ "name": "baie-1", "transport": "snmp", "host": "192.168.10.50", "community": { "$env": "UPS_COMMUNITY" }, "ids": { "status": "ond-etat" } }] } }
```

Le module `sia` accepte aussi sa propre forme `"keyEnv": "SIA_KEY_0457"` (nom de la variable qui contient la clé). Ces secrets (clé AES SIA, communauté SNMP, mots de passe des brokers Zigbee2MQTT / ChirpStack, mot de passe du PSIM) n'apparaissent **ni** dans la sortie de `gateway:check-config`, **ni** dans le journal, **ni** dans `<dataDir>\status.json` (vérifié par les essais). Les fichiers de `secrets\` se protègent comme celui du mot de passe du PSIM (`icacls`, étape 2).

## 4. Les modules

| Module | Équipements | Page |
|---|---|---|
| `heartbeat` | Signe de vie de la passerelle elle-même (voir ci-dessous) | ci-dessous |
| `zigbee` | Capteurs Zigbee via Zigbee2MQTT (fumée, ouverture, mouvement, fuite, gaz…) | [gateway/docs/zigbee.md](../gateway/docs/zigbee.md) |
| `modbus` | Automates, modules d'entrées et capteurs Modbus TCP (lecture seule ; RTU série via un convertisseur série-Ethernet) | [gateway/docs/modbus.md](../gateway/docs/modbus.md) |
| `ups` | Onduleurs (coupure secteur, batterie) | [gateway/docs/ups.md](../gateway/docs/ups.md) |
| `sia` | Centrales d'alarme intrusion/incendie (protocole SIA DC-09) | [gateway/docs/sia.md](../gateway/docs/sia.md) |
| `lorawan` | Capteurs LoRaWAN via ChirpStack | [gateway/docs/lorawan.md](../gateway/docs/lorawan.md) |

Chaque page de module donne la configuration complète, les équipements testés (ou « à qualifier ») et le dépannage. Les six modules sont chargés et vérifiés ensemble par les essais (`gateway/test/modules-load.test.ts`), avec les exemples de leur page ; un essai de bout en bout (`gateway/test/e2e-module-psim.test.ts`) suit une coupure secteur lue sur un automate Modbus jusqu'à l'incident « Coupure secteur » ouvert par le moteur du PSIM.

### Ordre d'installation conseillé

1. **PSIM à jour** (étape 2 au moins : `ts`, `msgId`, nouveaux événements `gas`, `co`, `power_loss`…, catégories Énergie et Personnes). Créer le compte de la passerelle (`PSIM_MQTT_GATEWAYS`) et **déclarer les équipements** dans le PSIM, avec la bonne catégorie.
2. **Passerelle avec `heartbeat` seul** : `npm run gateway:check-config` puis `npm run gateway`. `GW-01` doit passer en ligne dans le PSIM : la chaîne compte MQTT → file disque → broker est validée.
3. **Un module à la fois**, du plus simple au plus exposé, avec une recette par équipement (`npm run commission -- watch` côté PSIM) :
   1. `ups` (onduleur du poste PSIM : une coupure se provoque sans risque) ;
   2. `modbus` (contacts secs et 4-20 mA : alarmes techniques, cuves, groupe électrogène) ;
   3. `zigbee` (Zigbee2MQTT installé et appairé d'abord) ;
   4. `lorawan` (passerelle LoRaWAN et ChirpStack v4 en service d'abord) ;
   5. `sia` en dernier : il **écoute sur le réseau** (port à ouvrir dans le pare-feu, uniquement depuis l'adresse de la centrale), et la centrale doit être programmée par son installateur (compte, clé AES, horodatage).
4. **Service Windows** (`scripts\gateway-service.ps1 -Action Install`) une fois la configuration stable, puis `-Action Status`.
5. Fiche de recette signée (`npm run commission -- sheet`).

### Équipements du catalogue → module

D'après le *Catalogue des équipements* (version du 9 octobre 2026). « Tuya (PSIM) » : lu directement par le PSIM dans le cloud Smart Life, **sans passerelle** (voir [docs/TUYA.md](TUYA.md)). Tout équipement reste « à qualifier » tant qu'il n'est pas passé par l'atelier.

| Équipement du catalogue | Module | Remarques |
|---|---|---|
| Onduleur du socle, supervision de l'onduleur (USB ou carte SNMP) | `ups` | USB via NUT (`upsd`), carte réseau via SNMP UPS-MIB (v1/v2c). Coupure secteur, batterie faible, autonomie, charge. |
| Détecteur de coupure du secteur (relais de présence de tension) | `modbus` | Contact sec sur un module d'entrées Modbus TCP : `onTrue` → `power_loss`, `onFalse` → `power_restored`. |
| Compteur d'énergie Modbus, contrôle de groupe électrogène, kit solaire (tension batterie) | `modbus` | Registres (mesures, `value`) et contacts secs (démarrage, défaut). Lecture seule. |
| Capteur de niveau de cuve | `modbus` ou `lorawan` | Sortie 4-20 mA (rupture de boucle détectée) ; en LoRa : profil `dragino-ldds75`. |
| Barrière infrarouge, câble de clôture, détecteur extérieur, bris de vitre, boucle magnétique, câble de détection de fuite | `modbus` (ou `sia` via la centrale) | Sortie contact sec câblée sur un module d'entrées Modbus, ou sur une zone de la centrale d'alarme. |
| Centrale d'alarme intrusion (Ajax, Paradox…) et ses détecteurs, claviers, télécommandes | `sia` | Transmission IP SIA DC-09 (SIA-DCS ou Contact ID), chiffrée AES. Une zone de la centrale = un équipement PSIM. Armement / désarmement : signe de vie de la centrale (le PSIM garde son propre armement). |
| Centrale incendie certifiée, détecteurs adressables, déclencheurs manuels | `sia` ou `modbus` | Si la centrale transmet en SIA DC-09 ; sinon ses sorties relais (feu, dérangement) en contact sec. Le PSIM supervise, il ne remplace pas la centrale. |
| Détecteur de mouvement intérieur, contact de porte et fenêtre (Zigbee) | `zigbee` | Types `motion`, `contact` (sabotage → `door_forced` / `tamper`). |
| Contact de porte, mouvement (LoRa) | `lorawan` | Profils `milesight-ws301`, `dragino-lds03a`, `milesight-ws202`. |
| Contact, mouvement, fuite, température, gaz, CO, bouton SOS (WiFi Smart Life) | Tuya (PSIM) | Aucun module de passerelle. |
| Détecteur de fumée WiFi | Tuya (PSIM) | Validé sur un vrai détecteur. Fumée Zigbee : `zigbee` type `smoke`. |
| Détecteur de gaz, détecteur de CO | `zigbee` (types `gas`, `co`), Tuya (PSIM), ou `modbus` | Modèles 230 V à relais : contact sec sur `modbus`. |
| Capteur de température et d'humidité | `zigbee` (`temperature`), `lorawan` (`dragino-lht65`, `milesight-th`), Tuya (PSIM) | Seuils réglés dans le PSIM (catégorie Environnement). |
| Capteur de fuite d'eau | `zigbee` (`leak`), `lorawan` (`dragino-lwl03a`), Tuya (PSIM) | |
| Capteur de vibration | `zigbee` (`vibration`), `lorawan` (règle `mapping`) | |
| Capteur de qualité de l'air, capteur acoustique (LoRa) | `lorawan` | Règles `mapping` sur les champs décodés par ChirpStack : à écrire et qualifier avec le capteur réel. |
| Passerelle LoRaWAN (mât solaire ou intérieure) | `lorawan` | Via ChirpStack v4 (broker MQTT de ChirpStack). |
| Bouton panique fixe ou portatif | `zigbee` (`panic`), `lorawan` (`milesight-ws101`, `bouton-sos`), `sia`, Tuya (PSIM) | Événement `panic` ou `sos`, jamais masqué par le désarmement. |
| Signe de vie de la passerelle elle-même | `heartbeat` | À mettre sur toute passerelle. |

Hors passerelle : caméras, enregistreurs Dahua, supervision réseau (le PSIM les lit lui-même) ; contrôle d'accès, drones, lecture de plaques, balises GPS, pièges photo, radars : **à développer** (catalogue, chapitre 6).

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

**Événements** : un module n'émet que des événements connus du PSIM (`EVENTS` de `server/sources.ts`) ; le socle en lit directement la liste (`gateway/src/validate.ts`), et l'essai `gateway/test/contract.test.ts` échoue si une table de traduction (ou un littéral `event: '…'` du code d'un module, ou des capteurs Tuya) cite un événement inconnu du PSIM.

**`msgId`** : le PSIM n'accepte que 1 à 64 caractères parmi lettres, chiffres, `.`, `_`, `:` et `-`. Un module qui fabrique ses propres `msgId` (pour l'anti-doublon après un renvoi) utilise `makeMsgId(...morceaux)` de `gateway/src/msgid.ts` : accents et caractères interdits nettoyés, longueur bornée par une empreinte courte de l'original, résultat **déterministe** (même message, même `msgId`). Par sécurité, le socle nettoie de la même façon un `msgId` hors format (avec un avertissement dans le journal) au lieu de rejeter le message. Un `msgId` doit rester unique dans le temps : y mettre l'heure de l'événement, pas seulement un compteur qui peut repartir de zéro (compteur LoRaWAN après un nouveau `join`, séquence SIA…), sinon le PSIM prendrait le nouveau message pour un doublon pendant 7 jours.

Essais : `npm test` (les essais de la passerelle sont dans `gateway/test/`, contre le vrai broker du PSIM) ; `npm run typecheck` (couvre `gateway/`).
