# Module `ups` : supervision d'onduleur (Passerelle GAMR)

Ce module surveille un onduleur (UPS) **en lecture seule** et remonte au PSIM :

- la **coupure** et le **retour du secteur** ;
- la **batterie faible** ou à remplacer ;
- des **mesures** (charge de la batterie, autonomie restante, charge de l'onduleur, tensions, température), chacune
  vers un « détecteur » PSIM distinct, avec ses propres seuils réglés côté PSIM.

Il ne pilote jamais l'onduleur : aucune extinction, aucun test de batterie, aucune écriture. Deux façons de le lire :

| Transport | Quand l'utiliser |
|-----------|------------------|
| `nut` (Network UPS Tools, TCP 3493) | onduleur branché en **USB** (ou série) à un PC/mini-PC de la passerelle ; NUT sait parler à des centaines de modèles |
| `snmp` (UDP 161, v1 ou v2c) | onduleur avec une **carte réseau** (carte SNMP/web) qui expose le standard UPS-MIB (RFC 1628) |

## 1. Onduleur USB : installer NUT

NUT se compose d'un pilote (qui parle à l'onduleur par USB) et d'un serveur `upsd` (qui répond sur le port 3493).
Le module se connecte à `upsd`.

### Linux (Debian / Ubuntu)

```sh
sudo apt install nut
```

1. `/etc/nut/nut.conf` : `MODE=netserver` (ou `standalone` si la passerelle est sur la même machine : `upsd` écoute alors sur 127.0.0.1).
2. `/etc/nut/ups.conf` : déclarer l'onduleur.
   ```ini
   [onduleur1]
       driver = usbhid-ups
       port = auto
       desc = "Onduleur salle technique"
   ```
   Pour un modèle particulier, chercher son pilote dans la liste de compatibilité NUT (https://networkupstools.org/stable-hcl.html).
3. `/etc/nut/upsd.conf` : `LISTEN 127.0.0.1 3493` si la passerelle tourne sur la même machine. Si elle est sur une autre machine,
   écouter sur l'adresse du réseau local **et** limiter l'accès (`ACCEPT` / pare-feu) à la seule adresse de la passerelle :
   `upsd` ne demande aucun mot de passe pour la lecture.
4. `/etc/nut/upsd.users` : non nécessaire pour ce module (aucune authentification, aucune commande).
5. Démarrer : `sudo systemctl restart nut-driver@onduleur1 nut-server` puis vérifier :
   ```sh
   upsc onduleur1@localhost
   ```
   On doit voir `ups.status: OL`, `battery.charge: 100`, etc.

### Windows

1. Installer « NUT for Windows » (paquet `nut-<version>-win64`, https://networkupstools.org/). Placer le dossier par exemple dans `C:\nut`.
2. Pour un onduleur USB, installer le pilote **libusb-win32 / WinUSB** sur le périphérique de l'onduleur avec l'outil **Zadig**
   (sinon NUT ne le voit pas, car Windows le prend pour une batterie d'ordinateur portable).
3. Éditer `C:\nut\etc\ups.conf` comme ci-dessus (`driver = usbhid-ups`, `port = auto`),
   `C:\nut\etc\nut.conf` (`MODE=standalone`) et `C:\nut\etc\upsd.conf` (`LISTEN 127.0.0.1 3493`).
4. Installer et démarrer les services : `C:\nut\sbin\upsdrvsvcctl.exe install`, `C:\nut\sbin\upsd.exe -install`, puis les démarrer (`net start nut-driver`, `net start nut-server`).
5. Vérifier : `C:\nut\bin\upsc.exe onduleur1@localhost`.

### Dans la passerelle

```json
{ "name": "salle-technique", "transport": "nut", "host": "127.0.0.1", "upsName": "onduleur1", "ids": { "status": "ond-etat" } }
```

`upsName` est le nom entre crochets dans `ups.conf`. S'il est omis, le module le découvre (`LIST UPS`) à condition
que le serveur n'expose **qu'un seul** onduleur.

## 2. Onduleur avec carte réseau : activer SNMP

1. Dans l'interface web de la carte (souvent « Réseau » ou « Administration » > « SNMP »), **activer SNMP v1 ou v2c**.
2. Créer une **communauté en lecture seule** (par exemple une chaîne longue et non devinable ; ne pas garder `public`)
   et, si la carte le permet, la **restreindre à l'adresse IP de la passerelle**. SNMP v1/v2c circule en clair sur le réseau :
   l'isoler (VLAN de supervision).
3. Donner une adresse IP fixe à la carte.
4. Vérifier depuis un poste (outils `net-snmp`) :
   ```sh
   snmpget -v2c -c <communaute> <ip> 1.3.6.1.2.1.33.1.2.4.0     # charge batterie, en %
   snmpget -v2c -c <communaute> <ip> 1.3.6.1.2.1.33.1.4.1.0     # source de sortie (3 = secteur, 5 = batterie)
   ```
   Si ces commandes répondent, le module fonctionnera. Si la carte répond « No Such Object », elle n'implémente pas l'UPS-MIB standard
   (voir « Limites »).

```json
{
  "name": "baie-1", "transport": "snmp", "host": "192.168.10.50", "version": "2c", "community": "ma-communaute-longue",
  "ids": { "status": "ond-etat", "charge": "ond-charge" }
}
```

La communauté n'est **jamais** écrite dans les journaux ni dans les messages d'erreur.

## 3. Configuration

Section du module `ups` : une liste d'onduleurs. Toute clé inconnue est refusée avec un message en français (pour attraper les fautes de frappe).

```json
{
  "ups": [
    {
      "name": "salle-technique",
      "transport": "nut",
      "host": "127.0.0.1",
      "port": 3493,
      "upsName": "onduleur1",
      "pollMs": 15000,
      "timeoutMs": 3000,
      "maxFailures": 3,
      "heartbeatMs": 300000,
      "minIntervalMs": 10000,
      "runtimeUnit": "min",
      "deadband": { "charge": 2, "runtime": 1, "load": 5, "battery_voltage": 0.5, "input_voltage": 3, "temperature": 1 },
      "ids": {
        "status": "ond-etat",
        "charge": "ond-charge",
        "runtime": "ond-autonomie",
        "load": "ond-charge-sortie",
        "battery_voltage": "ond-vbat",
        "input_voltage": "ond-secteur",
        "temperature": "ond-temp"
      }
    },
    {
      "name": "baie-1",
      "transport": "snmp",
      "host": "192.168.10.50",
      "version": "2c",
      "community": "ma-communaute-longue",
      "line": 1,
      "ids": { "status": "baie1-etat", "runtime": "baie1-autonomie" }
    }
  ]
}
```

| Clé | Rôle | Défaut |
|-----|------|--------|
| `name` | nom de l'onduleur (1 à 32 caractères : lettres, chiffres, `_`, `-`), unique ; sert aux journaux | obligatoire |
| `transport` | `"nut"` ou `"snmp"` | obligatoire |
| `host` | adresse IP ou nom de machine | obligatoire |
| `port` | port TCP (NUT) ou UDP (SNMP) | 3493 / 161 |
| `upsName` | NUT : nom de l'onduleur chez `upsd` | découvert si un seul |
| `community` | SNMP : communauté en lecture | `public` |
| `version` | SNMP : `"1"` ou `"2c"` (entre guillemets) | `"2c"` |
| `line` | SNMP : numéro de ligne (phase) lu pour la tension d'entrée et la charge | 1 |
| `pollMs` | délai entre deux lectures (100 à 3 600 000 ; conseillé : 5 000 à 30 000) | 15000 |
| `timeoutMs` | délai maximal d'une lecture | 3000 |
| `maxFailures` | nombre d'échecs consécutifs avant de déclarer « défaut » | 3 |
| `heartbeatMs` | signe de vie périodique, en ms (`0` = désactivé, sinon 1000 minimum) | 300000 |
| `minIntervalMs` | délai minimal entre deux envois d'une même mesure | 10000 |
| `runtimeUnit` | unité de l'autonomie envoyée : `"min"` ou `"s"` | `"min"` |
| `deadband` | écart minimal avant de renvoyer une mesure, par grandeur (dans l'unité envoyée) | voir ci-dessus |
| `ids` | grandeur → identifiant PSIM (1 à 32 caractères). Au moins une. Une grandeur omise n'est ni lue ni envoyée. | obligatoire |

Règles : un identifiant PSIM ne peut recevoir **qu'une seule** grandeur (sinon deux mesures s'écraseraient) et ne peut pas être partagé entre deux onduleurs.

## 4. Ce qui est envoyé au PSIM

### État (grandeur `status`)

Le module n'envoie un message **qu'au changement** (plus un signe de vie périodique) :

| Situation | Message |
|-----------|---------|
| Premier relevé, tout va bien | `state: normal` (une fois) |
| Passage sur batterie (NUT `OB`, `DISCHRG` ; SNMP `upsOutputSource = battery(5)`) | `event: power_loss` |
| Retour du secteur | `event: power_restored` (puis `state: normal` si une batterie faible avait aussi été signalée) |
| Batterie faible ou à remplacer (NUT `LB`, `RB` ; SNMP `upsBatteryStatus = batteryLow(3)` ou `batteryDepleted(4)`) | `event: low_battery` |
| Surcharge, alarme, onduleur éteint (NUT `OVER`, `ALARM`, `OFF` ; SNMP `upsOutputSource = none(2)`) | `event: fault` |
| Retour à la normale sans coupure (fin de batterie faible) | `state: normal` |
| Aucun changement depuis `heartbeatMs` | `event: heartbeat` |

Quand la situation change (par exemple batterie faible pendant une coupure), le **dernier** message envoyé reflète toujours la situation la plus grave encore présente.

### Mesures

Une mesure est envoyée la première fois, puis seulement si elle a varié d'au moins `deadband` **et** que `minIntervalMs` s'est écoulé depuis son dernier envoi, ou
toutes les `heartbeatMs` pour rafraîchir. Les valeurs sont arrondies à 0,1.

### Onduleur injoignable

Après `maxFailures` échecs consécutifs (délai dépassé, connexion refusée, réponse illisible), le module envoie **une seule fois** `state: fault` à chaque identifiant PSIM de cet
onduleur, puis reste silencieux. Dès que l'onduleur répond de nouveau, chaque identifiant reçoit d'abord un état explicite (`normal`, ou la coupure/batterie faible en cours),
puis ses valeurs. Le journal reste sobre : une ligne au premier échec, une au passage en défaut, une à la reprise.

Chaque message porte l'heure de la lecture (`ts`) et un `msgId` unique (`ups-<id>-<ts>-<n>`).

## 5. Grandeurs, identifiants PSIM et seuils conseillés

Le module envoie la mesure brute ; **les seuils se règlent dans le PSIM** (catégorie « Environnement », sens « en dessous de » ou « au dessus de »).

| Grandeur (`ids`) | NUT | SNMP (UPS-MIB, RFC 1628) | Unité envoyée | Seuils conseillés (alerte / alarme) | Sens |
|------------------|-----|---------------------------|---------------|--------------------------------------|------|
| `status` | `ups.status` | `upsOutputSource` 1.3.6.1.2.1.33.1.4.1.0 + `upsBatteryStatus` 1.3.6.1.2.1.33.1.2.1.0 | événements | aucun seuil (voir tableau ci-dessus) | |
| `charge` | `battery.charge` | `upsEstimatedChargeRemaining` 1.3.6.1.2.1.33.1.2.4.0 | % | 50 / 20 | en dessous |
| `runtime` | `battery.runtime` (secondes) | `upsEstimatedMinutesRemaining` 1.3.6.1.2.1.33.1.2.3.0 (minutes) | minutes (`runtimeUnit`) | 15 / **10** min | en dessous |
| `load` | `ups.load` | `upsOutputPercentLoad` 1.3.6.1.2.1.33.1.4.4.1.5.`<ligne>` | % | 80 / 95 | au dessus |
| `battery_voltage` | `battery.voltage` | `upsBatteryVoltage` 1.3.6.1.2.1.33.1.2.5.0 (0,1 V converti en V) | V | pour 12 V : 11,8 / 11,0 ; pour 24 V : 23,6 / 22,0 | en dessous |
| `input_voltage` | `input.voltage` | `upsInputVoltage` 1.3.6.1.2.1.33.1.3.3.1.3.`<ligne>` | V | réseau 230 V : 200 / 180 | en dessous |
| `temperature` | `ups.temperature` | `upsBatteryTemperature` 1.3.6.1.2.1.33.1.2.7.0 | °C | 35 / 45 | au dessus |

Le seuil d'autonomie (≤ 10 min) est le plus utile en pratique : il prévient avant l'arrêt des équipements, même si la coupure a été annoncée plus tôt.

Valeurs des énumérations RFC 1628 : `upsOutputSource` : other(1), none(2), normal(3), bypass(4), battery(5), booster(6), reducer(7) ;
`upsBatteryStatus` : unknown(1), batteryNormal(2), batteryLow(3), batteryDepleted(4).

## 6. Limites

- **Côté PSIM** : les événements `power_loss` et `power_restored` doivent être connus du PSIM (table `EVENTS` de `server/sources.ts`) pour être acceptés ; `low_battery`, `fault`, `normal` et `heartbeat` le sont déjà.
- **SNMP v3 non géré** (v1 et v2c seulement, sans chiffrement). Utiliser un réseau de supervision isolé, une communauté en lecture seule et une restriction par IP.
- **MIB propriétaires** (APC PowerNet, Eaton, etc.) non lues : seule l'UPS-MIB standard est interrogée. Certaines cartes ne l'implémentent qu'en partie : une grandeur absente est signalée une fois dans le journal et ignorée, sans bloquer les autres.
- Sans `upsOutputSource`, le module ne peut pas détecter la coupure par SNMP (seul l'état de la batterie reste lisible).
- Seule la **première ligne** (phase) est lue pour la tension d'entrée et la charge (réglable par `line`). Pas de somme triphasée.
- Une seule grandeur par identifiant PSIM, et un seul seuil « sens » par détecteur côté PSIM : pas de seuil haut et bas simultanés sur une même tension.
- L'**écart minimal** (`deadband`) et `minIntervalMs` peuvent retarder de quelques secondes le franchissement d'un seuil : prendre une marge (par exemple alarme à 20 % plutôt que 5 %), ou descendre `deadband` à 1.
- Une lecture ratée isolée (connexion NUT interrompue, trame SNMP perdue) n'est pas une panne : le défaut n'est déclaré qu'après `maxFailures` échecs de suite. SNMP réessaie une fois par grandeur avant de compter un échec.
- Lecture seule stricte : le module ne peut pas éteindre l'onduleur, lancer un test de batterie ni modifier sa configuration. NUT est lu sans authentification ; protéger le port 3493 par le pare-feu.
- Au redémarrage de la passerelle, l'état courant est renvoyé une fois (le PSIM garde le dernier état reçu).
