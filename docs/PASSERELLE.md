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

### Voir l'état des passerelles (menu Administration → Clés et passerelles)

Dès que le compte existe, la passerelle apparaît dans le menu **Administration → Clés et passerelles**, section **Passerelles** (réservée aux administrateurs). Pour chaque compte :

- **Autorisée pour** : les identifiants et préfixes déclarés dans `PSIM_MQTT_GATEWAYS` ; **Détecteurs représentés** : ceux, parmi eux, qui existent vraiment dans le PSIM (hors capteurs lus par le PSIM lui-même). « Aucun détecteur du PSIM pour l'instant » veut dire que les identifiants déclarés ne correspondent à rien : déclarer les équipements dans *Équipements et plan* avec exactement ces identifiants.
- **Liaison** : *Connectée* (depuis quand), *Déconnectée* (pas encore déclarée coupée : elle a jusqu'à `PSIM_GATEWAY_TIMEOUT_S` pour revenir), ou *Liaison coupée* (au-delà : ses capteurs sont « non surveillés », un seul avertissement dans l'écran Système).
- **Dernier message reçu** : l'heure du dernier message d'état publié par ce compte. Cette date n'est gardée qu'en mémoire : après un redémarrage du PSIM, « Aucun depuis le démarrage du PSIM » s'affiche jusqu'au premier message.
- **Capteurs non surveillés** : combien de capteurs sont dans ce cas à cause de la coupure ; ils redeviennent surveillés au retour de la passerelle.

La liste se rafraîchit toute seule toutes les 15 secondes. Elle lit `GET /api/system` (champ `gateways` : `detectors`, `represents` et `lastMessageAt` s'ajoutent à `user`, `connected`, `since`, `down` et `unmonitored` ; rien n'a été retiré).

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
| `actuators` | Facultatif : les actionneurs (gâches, barrières, relais…) que le PSIM peut commander, avec leur clé de signature, les actions permises et leurs plafonds locaux. Voir la section 8. |

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
| `acces-dahua` | Contrôle d'accès Dahua : contrôleurs ASC et terminaux ASI (passages, état des portes, ouverture à distance) | [gateway/docs/acces-dahua.md](../gateway/docs/acces-dahua.md) |
| `acces-zkteco` | Contrôle d'accès ZKTeco : centrales C3 / inBio et terminaux (protocole push, la passerelle écoute) | [gateway/docs/acces-zkteco.md](../gateway/docs/acces-zkteco.md) |

Chaque page de module donne la configuration complète, les équipements testés (ou « à qualifier ») et le dépannage. Les huit modules sont chargés et vérifiés ensemble par les essais (`gateway/test/modules-load.test.ts`), avec les exemples de leur page ; un essai de bout en bout (`gateway/test/e2e-module-psim.test.ts`) suit une coupure secteur lue sur un automate Modbus jusqu'à l'incident « Coupure secteur » ouvert par le moteur du PSIM.

### Ordre d'installation conseillé

1. **PSIM à jour** (étape 2 au moins : `ts`, `msgId`, nouveaux événements `gas`, `co`, `power_loss`…, catégories Énergie et Personnes). Créer le compte de la passerelle (`PSIM_MQTT_GATEWAYS`) et **déclarer les équipements** dans le PSIM, avec la bonne catégorie.
2. **Passerelle avec `heartbeat` seul** : `npm run gateway:check-config` puis `npm run gateway`. `GW-01` doit passer en ligne dans le PSIM : la chaîne compte MQTT → file disque → broker est validée.
3. **Un module à la fois**, du plus simple au plus exposé, avec une recette par équipement (`npm run commission -- watch` côté PSIM) :
   1. `ups` (onduleur du poste PSIM : une coupure se provoque sans risque) ;
   2. `modbus` (contacts secs et 4-20 mA : alarmes techniques, cuves, groupe électrogène) ;
   3. `zigbee` (Zigbee2MQTT installé et appairé d'abord) ;
   4. `lorawan` (passerelle LoRaWAN et ChirpStack v4 en service d'abord) ;
   5. `sia` : il **écoute sur le réseau** (port à ouvrir dans le pare-feu, uniquement depuis l'adresse de la centrale), et la centrale doit être programmée par son installateur (compte, clé AES, horodatage) ;
   6. le **contrôle d'accès**, après `sia` : `acces-dahua` (la passerelle appelle le contrôleur : compte dédié sur le contrôleur, réseau dédié) puis `acces-zkteco` (comme `sia`, il **écoute sur le réseau** et son protocole n'a ni chiffrement ni mot de passe : **réseau dédié, pare-feu et `allowFrom` obligatoires**). Déclarer d'abord les portes dans le PSIM (catégorie `access`) et ajouter leurs identifiants aux `detectors` du compte de la passerelle (voir « Contrôle d'accès » ci-dessous).
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
| Contrôleurs d'accès, lecteurs de badge, serrures, barrières | `acces-dahua` ou `acces-zkteco` | Chaque porte = un détecteur PSIM de catégorie `access`. Le contrôleur décide, le PSIM supervise. Ouverture à distance par le canal de commande signé seulement. Voir « Contrôle d'accès » ci-dessous. |
| Signe de vie de la passerelle elle-même | `heartbeat` | À mettre sur toute passerelle. |

Hors passerelle : caméras, enregistreurs Dahua, supervision réseau (le PSIM les lit lui-même) . Drones, lecture de plaques, balises GPS, pièges photo, radars : **à développer** (catalogue, chapitre 6).

**`heartbeat` — à mettre sur toute passerelle.** Il envoie un signe de vie (`heartbeat`) pour un équipement PSIM dédié (ex. `GW-01`, à déclarer dans le PSIM) toutes les `everyS` secondes. Si la passerelle s'arrête, perd le réseau ou que son poste s'éteint, le PSIM voit cet équipement passer **« Hors ligne »** (délai `PSIM_DETECTOR_TIMEOUT_S`, à régler à 3 ou 4 fois `everyS`) et prévient. C'est aussi le moyen le plus simple de **valider la mise en service** : sans aucun équipement branché, `GW-01` doit apparaître en ligne dans le PSIM.

### Contrôle d'accès

Les modules `acces-dahua` et `acces-zkteco` rapportent au PSIM ce que font les contrôleurs de portes ; contrat complet : [docs/CONTROLE-ACCES.md](CONTROLE-ACCES.md).

- **Le contrôleur décide, le PSIM supervise.** L'ouverture par badge, code, empreinte ou visage se joue entièrement dans le contrôleur : si la passerelle ou le PSIM s'arrête, les portes continuent de fonctionner. Les modules ne créent, ne modifient ni ne suppriment aucun badge ni utilisateur, et ne lisent jamais de gabarit biométrique ni de code PIN.
- **Une porte = un détecteur PSIM de catégorie `access`.** Dans la configuration du module, chaque porte du contrôleur (`doors`) est rattachée à l'identifiant d'un détecteur déclaré dans le PSIM (menu Équipements), par exemple `P-ENTREE`. Passages (acceptés **et** refusés), ouvertures, alarmes (porte forcée, sabotage), signe de vie et état hors ligne de la porte arrivent sur ce détecteur.
- **Message de passage** : un message par passage, avec l'événement `badge_granted` ou `badge_denied` et un bloc `access` (contrôleur, identifiant d'événement, sens, numéro de badge, titulaire, méthode, résultat, motif, « différé »). Le format exact est décrit dans [docs/CONTROLE-ACCES.md](CONTROLE-ACCES.md) § 2.
- **Passages manqués et curseur.** Après une coupure, le module relit la mémoire du contrôleur et rejoue les passages manqués (marqués « différés »). Le dernier passage traité est gardé dans un **curseur**, dans le dossier `stateDir` de chaque module (par défaut `gateway/data/acces`). Le contexte des modules n'expose pas encore `dataDir` : **si `dataDir` change, régler `stateDir` à la main**, sinon les curseurs restent à l'ancien endroit. Donner de préférence **un `stateDir` différent à chaque module** (par exemple `data/acces-dahua` et `data/acces-zkteco`) : le fichier de curseurs porte le même nom pour tous (les curseurs sont fusionnés à l'écriture, deux modules qui partageraient un dossier ne s'écraseraient pas, mais un dossier par module reste plus lisible). Le compte de service doit pouvoir écrire dans ce dossier.
- **Comptes MQTT.** La liste `detectors` du compte de la passerelle (`PSIM_MQTT_GATEWAYS`, et `psim.detectors` dans la configuration de la passerelle) doit **inclure les identifiants des portes**, par exemple `"P-*"` si tous les détecteurs de portes commencent par `P-`. Sinon les messages sont refusés (voir le dépannage).
- **Secrets des modules désactivés.** Un module avec `"enabled": false` voit quand même ses `{"$file": ...}` et `{"$env": ...}` résolus : créer le fichier de secret (ou retirer le bloc du module) avant `npm run gateway:check-config`. C'est vrai du mot de passe du contrôleur **et** de sa clé de synchronisation (`syncKey`) : l'exemple `gateway\config.example.json` demande, pour être validé tel quel, les fichiers `secrets\acces-dahua-asc-entree.txt`, `secrets\acces-dahua-asc-entree-sync.key` et `secrets\acces-zkteco-c3-entree-sync.key` (la clé : 64 hexadécimaux minuscules, sur une ligne).
- **Ouverture à distance** : uniquement par le **canal de commande signé** du PSIM, pour les actionneurs déclarés dans `actuators`. L'accusé n'est donné qu'après la confirmation du contrôleur ; « verrouiller » remet la porte en mode normal et ne coupe jamais les badges.
- **Actionneur du module non déclaré dans la passerelle.** Chaque porte pilotable est déclarée à **deux** endroits : dans la section `actuators` **du module** (`"SERRURE-ENTREE": { "door": 1, "type": "lock" }`) et dans la section `actuators` **de la passerelle** (section 8, avec sa clé de signature et son champ `module`, qui doit être exactement le nom du module : `acces-dahua` ou `acces-zkteco`, ou son `label`). Si le second manque, l'ouverture à distance de cette porte est indisponible, mais **la remontée des passages, des alarmes et des modes n'est jamais coupée** : le module continue de surveiller et le journal dit une fois « actionneur « SERRURE-ENTREE » non enregistre : ouverture a distance indisponible, surveillance seule (...) ». C'est le cas de l'exemple `gateway\config.example.json`, qui déclare des actionneurs dans les modules mais aucune section `actuators` : surveillance seule, par construction.
- **Mode de porte et contrainte.** Chaque porte envoie au PSIM son **mode** (`{"event":"door_mode","doorMode":"normal"}`, ou `always_open`, `always_closed`) à la connexion du contrôleur et à chaque changement : Dahua le lit dans la configuration du contrôleur, ZKTeco le déduit de quelques événements (il ne peut pas l'interroger). `door_mode` compte comme un signe de vie du détecteur. Une **contrainte** (code ou doigt « sous la menace », carte de contrainte Dahua) envoie `{"event":"panic"}`, alarme silencieuse toujours active, en plus du passage. Détails : pages des modules.
- **Remplacement d'un contrôleur : l'`epoch`.** Quand un contrôleur est remplacé (mémoire vide, numéros d'enregistrement repartis de zéro), l'installateur **augmente** de 1 la clé `epoch` de **ce** contrôleur dans la configuration du module (0 par défaut) puis redémarre la passerelle : les identifiants des passages deviennent `<epoch>.<numéro>` et le curseur de récupération repart de zéro, sans jamais confondre l'ancien et le nouveau contrôleur. **Ne jamais diminuer `epoch`.** Procédure pas à pas : section 9 de [gateway/docs/acces-dahua.md](../gateway/docs/acces-dahua.md) et section 8 de [gateway/docs/acces-zkteco.md](../gateway/docs/acces-zkteco.md).

#### Synchronisation des titulaires (PSIM → contrôleurs)

**Principe.** Le PSIM est la référence des titulaires (personnes, badges, validité, portes, horaires, jours fériés). Il les **pousse** vers chaque contrôleur par la passerelle, **une opération à la fois**, et garde l'état de la synchronisation de chaque contrôleur. Le contrat est dans [docs/CONTROLE-ACCES.md](CONTROLE-ACCES.md) § 7 ; ce qui est écrit dans chaque marque est dans la page du module. Le contrôleur reste maître de l'ouverture : la synchronisation ne fait que tenir sa liste à jour. Jamais de code PIN, de gabarit biométrique ni de photo dans un message. Fonctionnement **par contrôleur**, activé seulement par sa clé `syncKey` : sans elle, le contrôleur est surveillé mais ne reçoit rien.

**Les messages (MQTT).** Un abonnement **exact** (jamais de joker) par contrôleur qui a une `syncKey`, repris à chaque reconnexion au PSIM :

| Topic | Sens | Contenu |
|---|---|---|
| `psim/access/<controllerId>/sync` | PSIM → passerelle, QoS 1, **jamais `retain`** | l'ordre signé : `{"v":1,"opId":...,"seq":...,"ts":...,"body":"...","sig":"..."}` |
| `psim/access/<controllerId>/sync-ack` | passerelle → PSIM, QoS 1, jamais `retain` | l'accusé signé : `{"v":1,"opId":...,"seq":...,"result":...,"code":...,"ts":...,"sig":"..."}` |

`<controllerId>` est l'identifiant du contrôleur : le même dans le PSIM (`access_controller.id`) et dans la clé `id` du contrôleur de la configuration du module. Un message `retain` est ignoré (un ordre conservé par le broker serait rejouable). L'accusé part tout de suite (5 s au plus) et n'est **jamais** mis en file sur le disque : s'il est perdu, le PSIM renvoie l'opération et reçoit l'accusé réémis. La chaîne signée, les formats et les **vecteurs de signature** de référence sont dans `gateway/test/accesssync.test.ts` (à reprendre côté PSIM).

**La clé de synchronisation d'un contrôleur.** Elle est créée avec le contrôleur dans le PSIM et **montrée une seule fois**. À recopier (64 caractères hexadécimaux minuscules, sur une seule ligne) dans un fichier de `gateway\secrets\`, puis à référencer dans la configuration du module :

```
"syncKey": { "$file": "secrets/acces-dahua-asc-entree-sync.key" }
```

C'est un secret au même titre que le mot de passe du contrôleur et les clés des actionneurs : même protection du dossier `secrets\` (`icacls`, section 2), jamais dans un message, un courriel ou le journal, et elle n'apparaît ni dans `gateway:check-config`, ni dans les journaux, ni dans `<dataDir>\status.json`. Une clé perdue se **remplace** (nouvelle clé dans le PSIM, nouveau fichier ici, redémarrage).

**Ce que le socle vérifie, dans cet ordre** (`gateway/src/accesssync.ts`) :

1. **Formats** : 1 024 octets au plus, UTF-8 valide, objet JSON dont les champs sont exactement `v` (= 1), `opId` (32 hexadécimaux minuscules), `seq` (entier supérieur ou égal à 1), `ts` (entier en ms), `body` (texte de 800 octets au plus) et `sig` (64 hexadécimaux minuscules). Sinon : ignoré, **sans accusé**.
2. **Signature** HMAC-SHA256 avec la clé du contrôleur, comparée en **temps constant**. Fausse : ignorée **sans accusé** (aucun renseignement pour un attaquant).
3. **Anti-rejeu** : le `seq` doit être **strictement croissant** pour ce contrôleur. Le dernier `seq` est **persisté** dans `<dataDir>\access-sync-state.json` (écrit de façon atomique **avant** l'exécution) : un redémarrage n'accepte plus un `seq` inférieur. Un `seq` inférieur au dernier, ou égal avec un autre `opId`, est ignoré. Un `seq` **déjà appliqué** n'est pas réexécuté : son **accusé est réémis**. Un `seq` encore en cours d'exécution est ignoré (l'accusé partira à la fin). Il n'y a pas de délai de fraîcheur : l'ordre et le `seq` suffisent, la synchronisation n'est pas urgente.
4. **Module disponible** : si aucun module ne suit ce contrôleur (module arrêté ou en échec de démarrage), accusé `error` / `unreachable`, sans consommer le `seq` : le PSIM peut renvoyer la même opération plus tard.
5. **Corps** : un objet JSON avec un champ `type` (et sans `opId` ni `seq`), sinon accusé `refused` / `invalid`.
6. **Une opération à la fois** par contrôleur, dans l'ordre d'arrivée, 8 au plus en attente (au-delà : ignoré, le PSIM renverra). Délai maximal d'une opération : **300 s** (le module peut attendre plusieurs interrogations de l'appareil) ; au-delà, accusé `error` / `timeout`. Une exception du module donne `error` / `io`.
7. **Accusé signé**, jamais retenté. Résultats : `done`, `refused` (codes `not_supported`, `invalid`, `full`) ou `error` (`io`, `unreachable`, `timeout`...). Quand le module est **arrêté** ou en échec, les ordres reçus sont accusés `error` / `unreachable` : l'abonnement est gardé pendant un redémarrage du module.

Le fichier `access-sync-state.json` ne contient **aucun secret** (ni clé, ni signature, ni nom, ni badge) : pour chaque contrôleur, le dernier `seq`, son `opId`, son résultat et une empreinte non secrète de la clé. Absent, illisible ou corrompu : la mémoire repart à vide, avec un avertissement dans le journal (un attaquant ne peut pas fabriquer d'ordre sans la clé ; il pourrait au plus rejouer un ancien message authentique, et seulement s'il peut publier sur le broker du PSIM). Les compteurs (opérations faites, refusées, en erreur, ignorées, rejeux, accusés perdus) sont dans `<dataDir>\status.json`, rubrique `accessSync`.

**Changer de clé.** Si la clé d'un contrôleur change (nouvelle clé dans le PSIM, nouveau fichier ici) et que la passerelle est redémarrée, le **compteur `seq` de ce contrôleur est remis à zéro** et le journal avertit : « cle de synchronisation changee depuis le dernier demarrage : numero de sequence remis a zero ». C'est sans danger, car les anciens messages, signés avec l'ancienne clé, ne passent plus la vérification de signature. Dans l'autre sens, une clé renouvelée côté PSIM **mais pas ici** donne des ordres « à signature fausse » ignorés sans accusé (tableau ci-dessous). Si le PSIM a perdu son compteur (restauration d'une sauvegarde plus ancienne), ses nouveaux `seq` sont inférieurs à celui de la passerelle : tout est ignoré comme rejeu ; le remède est de **changer la clé du contrôleur** (puis de redémarrer la passerelle).

**À prévoir côté broker du PSIM (à faire par l'équipe PSIM).** La passerelle s'abonne à `psim/access/<controllerId>/sync` et publie sur `psim/access/<controllerId>/sync-ack`. Dans les droits du broker, le compte de chaque passerelle doit donc pouvoir **lire** `.../sync` et **écrire** `.../sync-ack`, **uniquement** pour les contrôleurs rattachés à cette passerelle (jamais de joker, jamais le topic d'un contrôleur d'une autre passerelle) ; inversement le PSIM publie sur `.../sync` et lit `.../sync-ack`. Le code du PSIM de cette branche ne contient pas encore ce côté : tant qu'il manque, la passerelle l'écrit dans le journal (voir « non autorisé pour ce compte » ci-dessous) et la synchronisation de ce contrôleur ne fonctionne pas, sans gêner le reste.

**Dépannage de la synchronisation.** Les lignes du socle commencent par `[synchro]` (au plus une par minute et par sujet, avec le nombre de cas) :

| Ligne du journal | Cause | Action |
|---|---|---|
| `[synchro] <id> : N ordre(s) de synchronisation mal forme(s) ignore(s)...` | Message qui ne respecte pas les formats (taille, champ en trop ou manquant, `opId`, `seq`, `sig`) | Chercher l'émetteur : le PSIM ne produit que des messages conformes ; sinon un autre client publie sur le topic |
| `[synchro] <id> : N ordre(s) de synchronisation a signature fausse ignore(s) (sans accuse)` | Clé différente de celle du PSIM (renouvelée d'un seul côté, mauvais fichier, espace ou saut de ligne en trop), ou tentative de forgerie | Après un renouvellement : mettre la clé du PSIM dans le fichier et redémarrer. Sinon, **alerte de sécurité** : vérifier qui peut publier sur le broker |
| `[synchro] <id> : N ordre(s) de synchronisation deja applique(s) ou plus ancien(s) ignore(s) (rejeu)` | Renvoi d'un ancien message, deux émetteurs, ou compteur du PSIM revenu en arrière | Si le PSIM a été restauré : changer la clé du contrôleur (remet le compteur à zéro). Sinon, chercher un rejeu |
| `[synchro] <id> : N renvoi(s) d'une operation encore en cours ignore(s)...` | Le PSIM a renvoyé une opération longue avant la fin | Information : l'accusé partira à la fin |
| `[synchro] <id> : N ordre(s) de synchronisation ignore(s) : 8 operations deja en attente` | Le module est lent ou bloqué | Voir le journal du module ; le PSIM renverra |
| `[synchro] <id> : N ordre(s) de synchronisation sans module pour les executer (module arrete ou en echec) : accuse(s) « unreachable »` | Le module du contrôleur est arrêté ou n'a pas pu démarrer | Corriger la cause du module (autres lignes du journal) ; le PSIM réessaie |
| `[synchro] <id> : N operation(s) de synchronisation faite(s)` | Information | Aucune |
| `[synchro] <id> : N accuse(s) reemis pour une operation deja faite` | L'accusé précédent s'était perdu | Information |
| `[synchro] <id> : N accuse(s) de synchronisation perdu(s) (liaison PSIM coupee ? ...)` | Liaison au PSIM coupée au moment de l'accusé | Vérifier la liaison ; le PSIM renverra l'opération |
| `[synchro] <id> : synchronisation <type> seq N (op xxxxxxxx) -> refused (code)` ou `-> error (code)` | Résultat négatif du module (voir les codes dans sa page) ; peut être suivi de « le module n'a pas repondu en 300 s : etat du controleur inconnu », « reponse du module hors contrat » ou « le module a leve une exception (...) » | Voir la page du module (dépannage) |
| `[synchro] ordre de synchronisation recu pour un controleur sans cle enregistree (« X ») : ignore` | Le PSIM publie pour un contrôleur que cette passerelle ne suit pas (pas de `syncKey`, mauvais `id`) | Comparer l'identifiant du PSIM et la clé `id` du module ; vérifier le rattachement du contrôleur à la bonne passerelle |
| `[synchro] <id> : cle de synchronisation changee depuis le dernier demarrage : numero de sequence remis a zero` | Clé renouvelée | Attendu après un changement de clé ; sinon vérifier qui a modifié le fichier |
| `[synchro] fichier d'etat illisible (...)` ou `fichier d'etat corrompu (...)` ou `fichier d'etat de version inconnue` | `access-sync-state.json` abîmé | La mémoire anti-rejeu repart à vide : sans gravité si le broker est de confiance ; vérifier le dossier |
| `[synchro] ecriture du fichier d'etat impossible (...) : la memoire anti-rejeu ne survivra pas a un redemarrage` | `dataDir` non inscriptible ou plein | Donner au compte de service le droit d'écrire dans `dataDir` |
| `[synchro] arret : N operation(s) de synchronisation non terminee(s)...` | Arrêt de la passerelle pendant une opération | Sans gravité : elle sera réexécutée si le PSIM la renvoie (opérations idempotentes) |
| `controleur <id> non autorise pour ce compte (voir la liste des controleurs d'acces de PSIM_MQTT_GATEWAYS) : la synchronisation de ses titulaires ne sera pas recue` | Le broker refuse l'abonnement : droits du compte (voir « À prévoir côté broker ») | À faire par l'équipe PSIM : autoriser ce compte pour ce contrôleur |
| `abonnement a la synchronisation du controleur <id> impossible (...)` | Erreur du broker à l'abonnement | Voir le message ; la passerelle réessaie à la reconnexion |
| `ordre de synchronisation : erreur interne (...)` | Défaut interne | Relever la ligne et prévenir le support |
| `controleur <id> : synchronisation des titulaires non enregistree, surveillance des portes seule (...)` | Le socle a refusé la déclaration : clé invalide, identifiant invalide, contrôleur déjà suivi par un autre module, module arrêté | Lire la cause entre parenthèses ; la surveillance des portes continue |
| Le module refuse de démarrer, « configuration invalide » citant `syncKey` | La clé n'est pas 64 hexadécimaux minuscules | Recopier la clé du PSIM, sur une seule ligne |

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
| `actionneur X non autorise pour ce compte`, `ordre ... REFUSE`, `accuse ... PERDU`, `retour au repos ... ECHOUE` | Commandes d'actionneurs (section `actuators`) | Voir la section 8.5. |

**Remettre la file à zéro** (uniquement si l'on sait que les messages en attente sont sans intérêt, par exemple après des essais) : arrêter la passerelle, supprimer `<dataDir>\queue.jsonl`, relancer.

## 6. Pour les développeurs de modules

Le contrat entre le socle et les modules est dans `gateway/src/module.ts` (à ne pas modifier sans accord). Un module est un dossier `gateway/src/modules/<nom>/index.ts` qui exporte `create(config)` ; il reçoit un contexte avec `emit(deviceId, message)` (ne lève jamais : le socle valide, date, numérote, met en file et renvoie), `openMqtt(url, identifiants)` (lecture d'un autre broker, reconnexion automatique, TLS en `mqtts://`), `log`, `config` et `now`. Exemple de référence : `gateway/src/modules/heartbeat/index.ts`. Un module qui échoue au démarrage est arrêté puis relancé plus tard, sans gêner les autres ; ses liaisons MQTT sont fermées automatiquement. Le nom d'un module est limité à des minuscules, chiffres, `-` et `_` : impossible de charger un fichier hors du dossier des modules.

**Acquittement de la source** : `ctx.emit` ne lève jamais ; au-delà du contrat (typé `void`), il renvoie `false` quand le message n'a **pas** été mis en file (disque plein, passerelle en cours d'arrêt, équipement hors de `psim.detectors`, message invalide). Un module qui peut faire renvoyer sa source (le récepteur `sia` : pas d'ACK, la centrale renverra) teste `=== false` ; les autres l'ignorent.

**Événements** : un module n'émet que des événements connus du PSIM (`EVENTS` de `server/sources.ts`) ; le socle en lit directement la liste (`gateway/src/validate.ts`), et l'essai `gateway/test/contract.test.ts` échoue si une table de traduction (ou un littéral `event: '…'` du code d'un module, ou des capteurs Tuya) cite un événement inconnu du PSIM.

**`msgId`** : le PSIM n'accepte que 1 à 64 caractères parmi lettres, chiffres, `.`, `_`, `:` et `-`. Un module qui fabrique ses propres `msgId` (pour l'anti-doublon après un renvoi) utilise `makeMsgId(...morceaux)` de `gateway/src/msgid.ts` : accents et caractères interdits nettoyés, longueur bornée par une empreinte courte de l'original, résultat **déterministe** (même message, même `msgId`). Par sécurité, le socle nettoie de la même façon un `msgId` hors format (avec un avertissement dans le journal) au lieu de rejeter le message. Un `msgId` doit rester unique dans le temps : y mettre l'heure de l'événement, pas seulement un compteur qui peut repartir de zéro (compteur LoRaWAN après un nouveau `join`, séquence SIA…), sinon le PSIM prendrait le nouveau message pour un doublon pendant 7 jours.

**Commander un équipement** : un module qui agit sur un équipement (gâche, barrière, relais) enregistre un gestionnaire par actionneur avec `ctx.onActuator(actuatorId, async (req) => ({ result: 'done' | 'refused' | 'error', code? }))` ; l'actionneur doit être déclaré dans la section `actuators` de la configuration, pour ce module. Le socle fait la vérification des ordres, les plafonds, le retour au repos et l'accusé ; le module exécute seulement l'action. Voir la section 8.4.

Essais : `npm test` (les essais de la passerelle sont dans `gateway/test/`, contre le vrai broker du PSIM) ; `npm run typecheck` (couvre `gateway/`).

## 7. Clés des équipements qui envoient leurs images (HTTP)

Un équipement qui parle HTTP (caméra 4G, boîtier) et non MQTT n'utilise pas de compte de passerelle mais une **clé par équipement** (`psk_<n>_…`). Elles se gèrent dans **Administration → Clés et passerelles**, section **Clés des équipements** :

- **Créer une clé** : un nom (pour la reconnaître), puis les équipements concernés : un identifiant exact (`I-01`) ou un début d'identifiant terminé par `*` (`D-*`) ; le signe `*` seul est refusé. Touchez **Créer la clé**.
- **La clé n'est affichée qu'une seule fois**, dans une fenêtre dédiée avec les boutons **Copier la clé** et **Copier la commande** (exemple `curl` prêt à coller pour envoyer une image). La fenêtre ne se ferme que par son bouton : un clic à côté ou la touche Échap ne la ferment pas. Rien n'est gardé dans la page, l'adresse, l'historique ni le stockage du navigateur ; le PSIM n'en garde que l'empreinte. Une clé perdue se remplace, elle ne se retrouve pas.
- **Remplacer** : crée une nouvelle clé pour les mêmes équipements ; l'ancienne reste valable le délai choisi (tout de suite, 15 min, 1 h, 4 h, 24 h) le temps de reconfigurer l'équipement sur le terrain. Pendant ce délai, la ligne de l'ancienne clé indique *En rotation* et sa fin de validité.
- **Révoquer** : coupe la clé tout de suite, après confirmation. Les clés révoquées restent listées (repliées) pour l'historique.
- La liste montre aussi les équipements couverts, la date de création, la **dernière utilisation** et l'état (*Active*, *En rotation*, *Révoquée*).

Même chose en ligne de commande (`npm run device-key`) et en API : voir le README, « Clés par équipement ».

## 8. Actionneurs : exécuter les ordres du PSIM (section `actuators`)

Jusqu'ici la passerelle ne fait que **remonter** des états. Avec la section `actuators`, elle devient aussi le **dernier maillon d'une commande** : le PSIM envoie un ordre signé (« ouvrir cette gâche 5 secondes »), la passerelle le vérifie, le fait exécuter par un module (qui parle à l'équipement : contrôleur d'accès, relais…) et renvoie un accusé signé. Le protocole complet est dans [docs/COMMANDES.md](COMMANDES.md), section 5 ; le contrat avec les modules dans [docs/CONTROLE-ACCES.md](CONTROLE-ACCES.md), section 3.

Une faute ici n'est plus une fausse alarme : c'est une porte ouverte. Chaque règle ci-dessous est donc pensée contre un attaquant (broker compromis, PSIM compromis, rejeu, horloge truquée) et la passerelle **garde ses propres plafonds**, même si le PSIM lui demande davantage.

### 8.1 Mise en place

1. **Dans le PSIM** (Administration → Actionneurs) : créer l'actionneur (identifiant `GACHE-1`, type `lock`, transport MQTT). Sa **clé de signature** (64 caractères hexadécimaux) n'est affichée **qu'une seule fois** : la copier tout de suite.
2. **Autoriser le compte de la passerelle** dans `PSIM_MQTT_GATEWAYS` (liste `actuators`, identifiants exacts ou préfixes `GACHE-*`, jamais `*` seul) puis redémarrer le PSIM :
   ```
   PSIM_MQTT_GATEWAYS=[{"user":"gw1","password":"un-mot-de-passe-long-et-unique","detectors":["GW-01"],"actuators":["GACHE-1"]}]
   ```
   Un compte limité aux actionneurs peut omettre `detectors`. **Une seule passerelle par actionneur** : deux passerelles abonnées au même actionneur exécuteraient l'ordre deux fois.
3. **Sur la passerelle** : écrire la clé dans un fichier **sur une seule ligne** (`gateway\secrets\gache-1.key`, même protection que le mot de passe, voir l'étape 2 de la section 2) et déclarer l'actionneur dans `config.json` :
   ```json
   "actuators": [
     {
       "id": "GACHE-1",
       "keyFile": "secrets/gache-1.key",
       "module": "acces-dahua",
       "actions": { "unlock": { "maxS": 10 }, "lock": {} },
       "rest": "lock",
       "emergencyExit": false
     },
     {
       "id": "PORTAIL-1",
       "keyFile": "secrets/portail-1.key",
       "module": "acces-dahua",
       "actions": { "open": { "maxS": 10 }, "close": { "maxS": 10 }, "stop": {} }
     }
   ]
   ```
   (Cet exemple n'est **pas** dans `gateway\config.example.json`, qui déclare le module `acces-dahua` mais aucune section `actuators` (surveillance seule) : il faudrait y créer les fichiers de clés pour que `npm run gateway:check-config` reste valide. Le champ `module` doit être exactement le nom du module, ou son `label` s'il en a un.)
4. `npm run gateway:check-config` liste chaque actionneur (module, actions, plafonds, source de la clé — jamais la clé). Puis `npm run gateway`. Au démarrage et à **chaque reconnexion**, la passerelle s'abonne à `psim/actuators/<id>/command` pour chaque actionneur, **un abonnement par actionneur** (QoS 0, jamais de joker).

| Clé (par actionneur) | Rôle |
|---|---|
| `id` | Identifiant PSIM de l'actionneur : 1 à 32 caractères (lettres, chiffres, `_`, `-`), unique. |
| `keyFile` | Fichier contenant la clé (64 hexadécimaux, une ligne), chemin relatif au fichier de configuration. **Recommandé.** Autres possibilités, une seule à la fois : `keyEnv` (nom d'une variable d'environnement) ou `key` (en clair dans la configuration). Chaque actionneur a **sa** clé : deux actionneurs avec la même clé sont refusés. La clé n'apparaît jamais dans les journaux ni dans les erreurs. |
| `module` | **Étiquette** (`label`, ou nom par défaut) du module de `modules` qui exécute les ordres. Un module désactivé (`enabled: false`) reste valable : ses actionneurs répondent alors « indisponible ». |
| `actions` | Les actions **permises**, avec leur plafond : `{ "unlock": { "maxS": 10 }, "lock": {} }`. Noms : 1 à 16 minuscules ou `_`. `maxS` : durée maximale (1 à 86 400 s). Sans `maxS` l'action est **instantanée**. `unbounded: true` (avec `maxS`) autorise aussi un ordre **sans durée** (à réserver aux sirènes ou projecteurs que l'on coupe par un ordre contraire). |
| `rest` | L'action de **repos**, appelée par la passerelle au bout de `durationS` (par exemple `lock`, `off`). Doit figurer dans `actions`, sans `maxS`. **Absent = aucun retour automatique** : c'est le cas voulu pour un portail ou une barrière (fermer automatiquement sur une personne est plus dangereux que de laisser ouvert ; voir COMMANDES.md 4.8). |
| `emergencyExit` | `true` pour une **issue de secours** : l'action `lock` est interdite, dans la configuration (erreur si `actions.lock` existe ou si `rest` vaut `lock`) **et** à l'exécution (tout ordre `lock` est refusé `emergency_exit`, même si la configuration est modifiée en mémoire). |

Les plafonds locaux appliqués à **chaque** ordre : un ordre dont `durationS` dépasse `maxS` est refusé ; une action qui a un `maxS` refuse un ordre **sans** durée (sauf `unbounded`) ; une action **instantanée** refuse un ordre **avec** durée ; une action absente de la liste est refusée. Un PSIM compromis ne peut donc pas tenir une gâche ouverte une heure.

### 8.2 Ce que la passerelle vérifie, dans cet ordre

| # | Règle | Si elle échoue |
|---|---|---|
| 1 | Message ≤ 1 024 octets, JSON, chaque champ au bon format (`v`, `cmdId`, `action`, `params` limités à `durationS` et `clip`, `ts`, `ttlS`, `sig`) | **Ignoré**, sans accusé |
| 2 | Signature HMAC-SHA256 recalculée avec la clé de l'actionneur, comparaison en temps constant ; l'identifiant utilisé est celui du **topic**, jamais celui du message | **Ignoré, sans accusé** (aucune réponse à exploiter pour deviner la clé) ; compté, une ligne de journal par minute au plus |
| 4 (d'abord) | `cmdId` déjà vu dans les 120 dernières secondes | Rien n'est exécuté, **ni accusé** (journalisé) |
| 3 | Fraîcheur : `ts − 5 s ≤ maintenant ≤ ts + ttlS` | Accusé `refused`, code `stale` |
| 4 | `ts` plus ancien que le dernier ordre accepté pour cet actionneur (un ordre retardé par un broker malveillant) | Accusé `refused`, code `out_of_order` |
| 5 | Issue de secours, action permise, plafonds de durée | Accusé `refused`, code `emergency_exit` ou `not_allowed` |
| 5 | Un module a enregistré l'actionneur | Sinon accusé `refused`, code `unavailable` |
| 6 | Exécution par le module (4 s au plus) | Accusé `done`, `refused` ou `error` selon la réponse du module (`error`/`timeout` ou `error`/`exception` s'il ne répond pas ou plante) |

L'ordre est **toujours exécuté une seule fois** : la passerelle ne réessaie jamais un ordre, et un ordre signé et frais est mémorisé (même refusé). Cette mémoire **survit à un redémarrage** de la passerelle : fichier `<dataDir>\actuators-state.json`, écrit de façon atomique, qui ne contient **aucun secret** (ni clé, ni signature : seulement les `cmdId` récents, le dernier `ts` accepté et d'éventuels retours au repos en attente). Fichier illisible ou corrompu : la passerelle repart avec une mémoire vide et le dit dans le journal.

Les ordres d'un même actionneur sont exécutés **un par un**, dans l'ordre d'arrivée ; un ordre qui a attendu son tour derrière un module lent et devient périmé n'est pas exécuté (refusé `stale`). Au plus 8 ordres attendent : au-delà, refus `busy`.

Les **accusés** sont signés (`psim-ack-v1`) et publiés immédiatement (QoS 1). Si la liaison avec le PSIM est coupée, l'accusé est **perdu et journalisé** (« accusé … PERDU ») : il n'est **jamais mis en file** ni renvoyé après la reprise — un accusé en retard n'aurait aucune valeur (le PSIM affiche alors la commande « sans accusé »). Un ordre n'est jamais mis en file non plus (QoS 0, jamais conservé).

### 8.3 Retour au repos, quoi qu'il arrive

Pour un ordre avec `durationS` dont l'action n'est pas l'action de repos, la passerelle **revient localement au repos** au bout de `durationS` : elle appelle le gestionnaire du module avec l'action `rest` (`cmdId` = `<cmdId de l'ordre>:rest`, sans durée). Ceci ne dépend de rien : liaison avec le PSIM perdue, PSIM arrêté, accusé non remis, module en erreur ou qui n'a pas répondu (l'état de l'équipement est alors inconnu, le repos est donc programmé quand même). Seul un module qui répond `refused` (rien n'a été fait) n'arme pas de minuteur.

- **Un nouvel ordre accepté remplace le minuteur** en cours de cet actionneur ; un ordre refusé par la passerelle (ou par le module) ne l'annule pas. L'ordre de repos lui-même (`lock`) annule le minuteur.
- **Échec du repos** : nouvel essai toutes les 5 s, 20 au plus, avec une ligne d'erreur à chaque échec ; au bout des essais, une erreur « ABANDONNE : vérifier l'équipement sur place » est journalisée. Si le module est arrêté ou en redémarrage, le repos est retenté et part **dès que le module réenregistre son gestionnaire**.
- **Arrêt de la passerelle** (`Stop`, `Restart`, Ctrl+C) : pour chaque actionneur dont un retour au repos est programmé, la passerelle appelle le repos **une fois, au mieux, avant d'arrêter les modules**. Si cela échoue (ou si le module est absent), le retour reste dans `actuators-state.json` et sera **repris immédiatement au prochain démarrage**. Un arrêt brutal (courant coupé) ne peut pas faire cet appel : le module doit donc, quand l'équipement le permet, **programmer aussi la durée dans l'équipement** (par exemple « ouvrir 5 s » côté contrôleur).
- Sans `durationS` (action `unbounded`) : l'équipement est tenu **jusqu'à l'ordre contraire** ; c'est journalisé.

### 8.4 Ce que le module doit faire

Dans `start(ctx)`, pour chaque actionneur dont il a la charge :

```ts
ctx.onActuator('GACHE-1', async (req) => {
  // req : { actuatorId, cmdId, action, durationS?, clip? } — déjà vérifié (signature, fraîcheur, plafonds)
  try {
    await controleur.ouvrirPorte(numeroDePorte, req.durationS ?? 0);
    return { result: 'done' };
  } catch (err) {
    return { result: 'error', code: 'io' };
  }
});
```

- **Quand le module n'a pas pu agir** parce qu'il refuse l'action (porte inconnue, contrôleur en maintenance) : `{ result: 'refused', code: 'door_busy' }`. Le socle n'arme alors **pas** de retour au repos (rien n'a été fait).
- **Quand l'exécution a échoué ou qu'on ne sait pas** : `{ result: 'error', code: 'io' }`. Le socle programme quand même le repos.
- Le `code` est facultatif : `^[a-z0-9_]{1,32}$`, sinon la passerelle le remplace par `other`. Une exception ou une promesse rejetée est traitée comme `error` / `exception`.
- **Répondre vite** : le socle attend 4 s au plus (après quoi l'ordre est accusé `error` / `timeout` et la réponse tardive ignorée). Si le matériel est lent, répondre dès que l'ordre est accepté par l'équipement.
- **Idempotence** : le gestionnaire sera aussi appelé pour le repos (`<cmdId>:rest`), éventuellement plusieurs fois (réessais, reprise après redémarrage). Appeler `lock` sur une porte déjà verrouillée doit être sans effet.
- Une erreur de `onActuator` **fait échouer le démarrage du module** (journal, nouvel essai, comme toute erreur de démarrage) : actionneur non déclaré dans `actuators`, déclaré pour **un autre** module, ou déjà enregistré. Les gestionnaires d'une instance sont **retirés quand elle s'arrête** : pendant un redémarrage du module, les ordres reçoivent `refused` / `unavailable`.

### 8.5 Statut et dépannage

`status.json` (et `-Action Status`) compte les ordres : `actuators` = `{ configured, executed, refused, failed, ignored, replayed, acksLost, pendingRests }`.

| Symptôme (journal) | Cause probable | Que faire |
|---|---|---|
| `actionneur X non autorise pour ce compte : voir PSIM_MQTT_GATEWAYS, liste actuators` | Le compte de la passerelle n'a pas `X` dans `actuators` côté PSIM (ou le PSIM n'a pas été redémarré) | Ajouter `X` (identifiant exact ou préfixe) à la liste `actuators` du compte, redémarrer le PSIM, redémarrer la passerelle. Les autres actionneurs et les détecteurs fonctionnent entre-temps. |
| Le PSIM refuse la commande : « aucune passerelle n'écoute » | La passerelle est arrêtée, déconnectée, ou l'abonnement a été refusé | Voir la ligne précédente ; `connecte au PSIM` doit apparaître au journal. |
| `ordre ... REFUSE (stale) : date dans le futur de N s (horloge ... 5 s de tolerance)` ou ordres refusés `stale` alors que tout est branché | **Horloges désynchronisées** : la passerelle tolère 5 s d'avance du PSIM et accepte l'ordre jusqu'à `ttlS` (10 s par défaut) après son émission. Au-delà, l'ordre est refusé | Synchroniser l'heure (NTP / service « Heure Windows ») sur le PSIM et sur la passerelle. Côté PSIM, un accusé daté de plus de 5 s dans le futur est ignoré (« accusé date de facon impossible » dans le journal du PSIM). |
| `N ordre(s) a signature fausse ignore(s)` | Clé différente de celle du PSIM (clé renouvelée côté PSIM mais pas ici), ou tentative de forgerie | Si c'est après un renouvellement de clé : remplacer le contenu du `keyFile` et redémarrer la passerelle. Sinon, c'est une alerte de sécurité : vérifier qui a accès au broker. |
| `N ordre(s) mal forme(s) ignore(s)` | Message qui n'est pas un ordre du PSIM (autre client sur le broker) | À examiner si cela se répète. |
| `ordre ... REFUSE (not_allowed)` | L'action ou la durée dépasse ce que `actions` permet localement | Corriger la configuration de la passerelle (si le plafond est légitime) ou la demande du PSIM. |
| `ordre ... REFUSE (out_of_order)` | Ordre plus ancien que le dernier exécuté (retardé en route) | Normal si un ordre a été retardé ; sinon vérifier l'horloge du PSIM. |
| `ordre ... REFUSE (unavailable)` | Aucun module n'a enregistré l'actionneur : module arrêté, en échec de démarrage, ou `enabled: false` | Voir la ligne `[module] echec du demarrage` ; le module réenregistre seul son gestionnaire à son retour. |
| `accuse ... PERDU` | Liaison avec le PSIM coupée au moment de répondre | L'ordre a été exécuté ; le PSIM le montrera « sans accusé ». Rien à rejouer. |
| `le module n'a pas repondu en 4 s` | Contrôleur ou relais injoignable ou lent | Vérifier l'équipement ; l'état de la porte est inconnu, le retour au repos est programmé quand même. |
| `retour au repos « lock » ECHOUE (essai N/21)` puis `ABANDONNE` | Le module ne parvient pas à joindre l'équipement | **Vérifier la porte sur place.** Le journal dit pour quel actionneur. |
| `ecriture du fichier d'etat impossible` | Disque plein ou droits | La protection contre le rejeu ne survivra pas à un redémarrage tant que cela dure. Libérer l'espace / corriger les droits sur `<dataDir>`. |
| `fichier d'etat corrompu ... repartie a vide` | Coupure de courant ou fichier modifié | Sans gravité : la mémoire anti-rejeu repart à vide (les ordres déjà périmés restent refusés). |
| `actionneur « X » non declare dans la section « actuators »` / `declare pour le module « Y »` / `deja enregistre` (échec de démarrage d'un module) | Faute dans la configuration de la passerelle ou dans le module | Corriger `actuators[].module`, ou l'identifiant passé à `ctx.onActuator`. |

**Limites connues.** Un module qui ne répond pas dans les 4 s peut quand même agir sur l'équipement plus tard (on ne peut pas annuler une promesse) : le gestionnaire doit être sobre et borner lui-même ses délais. Un arrêt brutal de la passerelle ne ramène pas au repos : prévoir un temporisateur dans l'équipement.
