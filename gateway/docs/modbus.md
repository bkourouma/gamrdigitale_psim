# Module Modbus TCP de la Passerelle GAMR

Guide de l'installateur. Le module lit des équipements **Modbus TCP** (modules d'entrées réseau, compteurs d'énergie,
groupes électrogènes, automates, convertisseurs 4-20 mA) et envoie au PSIM, pour chaque point surveillé, un état, un
événement ou une mesure.

**Lecture seule.** Le module n'écrit jamais dans l'équipement : il n'existe, dans son code, aucune fonction d'écriture
(seules les fonctions Modbus 01, 02, 03 et 04 sont utilisées, et un test automatique le vérifie). Il ne peut donc
ni déclencher un relais, ni modifier un réglage.

## Câblage typique : contact sec vers module d'entrées Modbus TCP

```
 Détecteur / barrière / bouton            Module d'entrées réseau (Modbus TCP)          Réseau local
 ┌───────────────────────┐                ┌───────────────────────────────┐
 │ sortie relais (contact│ ── 2 fils ───▶ │ DI1  ●──┐                     │
 │ sec : NO / COM / NC)  │                │ COM  ●──┘  (commun des entrées)│ ── RJ45 ──▶ switch ──▶ Passerelle GAMR
 └───────────────────────┘                │ alim. 12-24 V                 │
                                          └───────────────────────────────┘
```

1. Branchez le contact sec (relais du détecteur, de la barrière, du bouton panique, de la centrale incendie...)
   entre l'entrée `DIx` et le commun `COM` du module. Respectez le mode d'entrée du module (contact sec : le module
   fournit lui-même la tension d'appel ; entrée « humide » : tension externe 12/24 V).
2. Donnez au module une **adresse IP fixe** et notez son numéro d'unité (`unitId`, souvent 1).
3. Chaque entrée est lue comme une entrée discrète (`type: "discrete"`, fonction 02). Entrée 1 = adresse `0`,
   entrée 2 = adresse `1`, etc.
4. Choisissez le contact **NO** (normalement ouvert : fermé = alarme) ou **NC** (normalement fermé : ouvert = alarme).
   Un montage NC est préférable : il signale aussi la coupure du câble. Avec un contact NC, mettez `"invert": true`.
5. Pour un module « 4-20 mA », branchez la boucle sur l'entrée analogique ; la valeur est un registre
   (`type: "input"` ou `"holding"`, voir plus bas).

> **Numérotation des adresses.** Dans le protocole, les adresses commencent à **0**. Beaucoup de fiches techniques
> utilisent l'ancienne notation : `00001` (bobines), `10001` (entrées discrètes), `30001` (registres d'entrée),
> `40001` (registres de maintien). Retirez le préfixe et soustrayez 1 : le registre `40108` est le registre de
> maintien d'adresse **107**. Si la valeur lue est incohérente, essayez l'adresse voisine.

## Format de la configuration

La section du module est un objet avec une liste `devices` (un élément par équipement Modbus).

```json
{
  "devices": [
    {
      "name": "armoire-entrees",
      "host": "192.168.1.50",
      "port": 502,
      "unitId": 1,
      "pollMs": 1000,
      "timeoutMs": 2000,
      "failThreshold": 3,
      "heartbeatMs": 30000,
      "points": [
        { "id": "porte-nord", "type": "discrete", "address": 0, "invert": true, "debounceMs": 300,
          "onTrue": { "event": "intrusion" }, "onFalse": { "event": "clear" } }
      ]
    }
  ]
}
```

### Paramètres d'un équipement

| Clé | Défaut | Rôle |
|---|---|---|
| `name` | obligatoire | Nom unique de l'équipement (pour le journal). |
| `host` | obligatoire | Adresse IP ou nom de machine (sans `http://` ni port). |
| `port` | 502 | Port TCP (1 à 65535). |
| `unitId` | 1 | Numéro d'unité Modbus (0 à 255). |
| `pollMs` | 1000 | Période de lecture, en ms (10 à 3 600 000 ; 200 ms ou plus est raisonnable). |
| `timeoutMs` | 2000 | Délai maximal de connexion et de réponse. |
| `failThreshold` | 3 | Nombre d'échecs consécutifs avant de déclarer un **défaut** (voir « Panne d'équipement »). |
| `reconnectMinMs` / `reconnectMaxMs` | 1000 / 30000 | Temporisation exponentielle entre deux reconnexions (1 s, 2 s, 4 s... plafonnée). |
| `heartbeatMs` | 30000 | Signe de vie périodique par point (`0` = aucun). Valeur par défaut des points. |
| `maxGap` | 0 | Trou maximal (en adresses) toléré pour fusionner deux points dans une même lecture. |
| `maxRegisters` / `maxBits` | 100 / 1000 | Taille maximale d'une lecture groupée (125 / 2000 au plus). |
| `points` | obligatoire | Liste non vide de points. |

Les lectures sont **groupées** : les points d'adresses contiguës et de même type sont lus en une seule requête.
Laissez `maxGap` à 0 sauf si l'équipement accepte la lecture d'adresses intermédiaires non utilisées (certains
répondent par une exception « adresse inexistante »).

### Types de points

`id` (obligatoire) est l'identifiant de l'équipement dans le PSIM : 1 à 32 caractères parmi lettres, chiffres, `_` et
`-`, unique dans toute la configuration.

| `type` | Fonction | Lit | Modes possibles |
|---|---|---|---|
| `discrete` | 02 | une entrée discrète (contact sec) | tout ou rien |
| `coil` | 01 | une bobine (sortie lue en retour d'état) | tout ou rien |
| `input` | 04 | un registre d'entrée | `value` (défaut), `bit`, `compare` |
| `holding` | 03 | un registre de maintien | `value` (défaut), `bit`, `compare` |

**Points « tout ou rien »** (`discrete`, `coil`, et registres en mode `bit` ou `compare`) :

| Clé | Défaut | Rôle |
|---|---|---|
| `onTrue` | obligatoire | Ce qui est envoyé quand le point est « vrai » : `{ "event": "intrusion" }` ou `{ "state": "alarm" }`. |
| `onFalse` | `{ "event": "clear" }` | Ce qui est envoyé quand il est « faux ». |
| `invert` | false | Inverse le sens (contact normalement fermé). |
| `debounceMs` | 0 | Anti-rebond : le nouvel état doit durer ce temps avant d'être envoyé (le premier relevé après le démarrage est envoyé tel quel). |
| `heartbeatMs` | celui de l'équipement | Signe de vie `heartbeat` périodique. |

Événements reconnus par le PSIM : `intrusion`, `motion`, `glass_break`, `tamper`, `panic`, `door_forced`, `leak`,
`flood`, `over_temperature`, `door_held_open`, `normal`, `clear`, `restored`, `door_closed`, `alarm_reset`, `dry`,
`fault`, `low_battery`, `heartbeat`, `ping`, `door_opened`, `gas`, `co`, `power_loss`, `power_restored`, `vibration`,
`line_crossing`, `sos`. États : `normal`, `prealarm`, `alarm`, `fault`, `offline`.

**Registres en mode `bit`** : `"mode": "bit"`, `"bit": 0..15` (0 = bit de poids faible), `byteOrder` optionnel. Utile pour les mots
d'état (groupe électrogène, centrale).

**Registres en mode `compare`** : `"mode": "compare"`, `"compare": { "op": "gt|ge|lt|le|eq|ne", "value": 20 }`.
La comparaison porte sur la valeur après `scale` et `offset`. Utile pour « batterie sous 20 % » ou « code de défaut ≠ 0 ».

**Registres en mode `value`** (mesure envoyée au PSIM, qui applique ses propres seuils, y compris « trop bas » pour un niveau de cuve) :

| Clé | Défaut | Rôle |
|---|---|---|
| `dataType` | `uint16` | `uint16`, `int16`, `uint32`, `int32`, `float32` (les types 32 bits occupent 2 registres). |
| `wordOrder` | `big` | Ordre des deux mots d'un type 32 bits : `big` = mot de poids fort en premier (ABCD), `little` = mot de poids faible en premier (CDAB). |
| `byteOrder` | `big` | `little` inverse les deux octets de chaque mot (BADC, ou DCBA avec `wordOrder: little`). |
| `scale`, `offset` | 1, 0 | Valeur = brut × `scale` + `offset`. |
| `decimals` | 2 | Arrondi (0 à 9 décimales). |
| `unit` | vide | Unité (documentaire, pour l'installateur). |
| `deadband` | 0 | Zone morte : une nouvelle valeur n'est envoyée que si elle diffère d'au moins ce montant de la dernière envoyée. |
| `minIntervalMs` | 5000 | Période minimale entre deux envois de valeur (évite d'inonder le PSIM). |
| `current4_20` | absent | Conversion d'une boucle 4-20 mA (voir ci-dessous). |
| `heartbeatMs` | celui de l'équipement | La dernière valeur est renvoyée périodiquement (c'est le signe de vie du point). |

Choix de l'ordre des mots : si la lecture d'un flottant donne une valeur absurde (très grande ou très petite), essayez
`"wordOrder": "little"`, puis `"byteOrder": "little"`. La notice du compteur donne souvent l'ordre (« big-endian »,
« word swap », « CDAB »...).

**Boucle 4-20 mA** : `"current4_20": { "rawMin": …, "rawMax": …, "engMin": …, "engMax": … }` où `rawMin` / `rawMax` sont
les valeurs brutes du registre pour 4 mA et 20 mA, et `engMin` / `engMax` la grandeur physique correspondante.
Le courant est déduit de la valeur brute. Si **le courant tombe sous 3,6 mA** (fil coupé, capteur débranché ou en panne ;
réglable par `loopBreakMa`) ou **dépasse 21 mA** (`overRangeMa`, `null` pour désactiver), le point est en **défaut**
(`fault`) : une fausse mesure n'est jamais envoyée. `scale` et `offset` ne se combinent pas avec `current4_20`.

## Exemples

### Niveau de cuve par sonde 4-20 mA (cuve de gasoil de 3 m)

Convertisseur 4-20 mA / Modbus TCP dont le registre d'entrée 0 vaut 4000 pour 4 mA et 20000 pour 20 mA.
Réglez le seuil « niveau bas » dans le PSIM (sens « en dessous »).

```json
{
  "devices": [
    {
      "name": "cuve-gasoil",
      "host": "192.168.1.60",
      "unitId": 1,
      "pollMs": 5000,
      "points": [
        {
          "id": "cuve-gasoil",
          "type": "input",
          "address": 0,
          "unit": "m",
          "decimals": 2,
          "deadband": 0.02,
          "minIntervalMs": 30000,
          "heartbeatMs": 300000,
          "current4_20": { "rawMin": 4000, "rawMax": 20000, "engMin": 0, "engMax": 3 }
        }
      ]
    }
  ]
}
```

### Compteur d'énergie (tension, puissance)

Compteur dont les registres d'entrée 0-1 donnent la tension (V) et 12-13 la puissance active (W), en `float32` avec mots inversés
(CDAB, cas fréquent). Le PSIM peut alerter sur une tension trop basse ou une puissance trop élevée.

```json
{
  "devices": [
    {
      "name": "compteur-tgbt",
      "host": "192.168.1.70",
      "unitId": 3,
      "pollMs": 2000,
      "points": [
        { "id": "tgbt-tension", "type": "input", "address": 0, "dataType": "float32", "wordOrder": "little",
          "decimals": 1, "unit": "V", "deadband": 2, "minIntervalMs": 10000 },
        { "id": "tgbt-puissance", "type": "input", "address": 12, "dataType": "float32", "wordOrder": "little",
          "scale": 0.001, "decimals": 2, "unit": "kW", "deadband": 0.5, "minIntervalMs": 10000 },
        { "id": "tgbt-secteur", "type": "input", "address": 0, "mode": "compare", "dataType": "float32", "wordOrder": "little",
          "compare": { "op": "lt", "value": 150 }, "debounceMs": 3000,
          "onTrue": { "event": "power_loss" }, "onFalse": { "event": "power_restored" } }
      ]
    }
  ]
}
```

Ici `tgbt-secteur` détecte la perte du secteur (tension sous 150 V pendant 3 s) à partir du même registre que `tgbt-tension`.

### Groupe électrogène

Automate du groupe : registre de maintien 100 = mot d'état (bit 0 = en marche, bit 3 = défaut général, bit 5 = niveau
carburant bas), registre 101 = tension batterie en 0,1 V, registres 102-103 = niveau de carburant en litres
(`uint32`).

```json
{
  "devices": [
    {
      "name": "groupe-electrogene",
      "host": "192.168.1.80",
      "pollMs": 2000,
      "points": [
        { "id": "ge-defaut", "type": "holding", "address": 100, "mode": "bit", "bit": 3, "debounceMs": 2000,
          "onTrue": { "event": "fault" }, "onFalse": { "event": "normal" } },
        { "id": "ge-carburant-bas", "type": "holding", "address": 100, "mode": "bit", "bit": 5, "debounceMs": 10000,
          "onTrue": { "event": "low_battery" }, "onFalse": { "event": "normal" } },
        { "id": "ge-batterie", "type": "holding", "address": 101, "scale": 0.1, "decimals": 1, "unit": "V",
          "deadband": 0.2, "minIntervalMs": 60000 },
        { "id": "ge-carburant", "type": "holding", "address": 102, "dataType": "uint32", "unit": "L",
          "deadband": 5, "minIntervalMs": 60000, "heartbeatMs": 300000 }
      ]
    }
  ]
}
```

### Barrière infrarouge (contact sec sur module d'entrées)

Barrière dont le relais s'ouvre quand le faisceau est coupé (contact NC), sur l'entrée 3 d'un module d'entrées ;
la sortie « sabotage » (autoprotection) sur l'entrée 4.

```json
{
  "devices": [
    {
      "name": "entrees-perimetre",
      "host": "192.168.1.90",
      "pollMs": 250,
      "points": [
        { "id": "barriere-est", "type": "discrete", "address": 2, "invert": true, "debounceMs": 200,
          "onTrue": { "event": "line_crossing" }, "onFalse": { "event": "clear" }, "heartbeatMs": 20000 },
        { "id": "barriere-est-sabotage", "type": "discrete", "address": 3, "invert": true,
          "onTrue": { "event": "tamper" }, "onFalse": { "event": "clear" } }
      ]
    }
  ]
}
```

Le même schéma sert pour : détecteur de gaz ou de CO à relais (`gas`, `co`), bouton panique à contact sec (`panic`),
centrale incendie par contact (`{ "state": "alarm" }`), boucle magnétique, câble de clôture (`intrusion`).

## Ce qui est envoyé au PSIM

- **État inchangé = rien d'envoyé.** Seul un changement est transmis, plus le signe de vie périodique (`heartbeat`, ou la
  dernière valeur pour une mesure). Au démarrage, l'état de chaque point est envoyé une fois.
- Chaque message porte l'**heure de la lecture** (`ts`, en ms) et un identifiant unique `msgId` de la forme
  `<id>-<ts>-<numéro>`.
- Une mesure n'est jamais envoyée avec un état : le PSIM applique ses seuils à la valeur.

## Panne d'équipement

Quand l'équipement ne répond plus (câble débranché, module éteint, trame invalide, boucle 4-20 mA coupée), le module
envoie `{ "state": "fault" }` **une seule fois par point** après `failThreshold` échecs consécutifs. Il n'envoie pas
`offline` : c'est le PSIM qui détecte le silence d'un équipement. Dès que la lecture réussit de nouveau, l'état réel
est renvoyé (et, pour une mesure, un événement `restored` suivi de la valeur). Les tentatives de reconnexion sont espacées de
façon exponentielle (`reconnectMinMs` puis le double... jusqu'à `reconnectMaxMs`).

Le journal ne signale que les **changements** : « injoignable » une fois, « de nouveau joignable » une fois ; une adresse refusée
par l'équipement (exception Modbus) est signalée une fois.

Si un seul bloc de lecture est refusé (exception « adresse inexistante »), seuls les points de ce bloc passent en défaut :
vérifiez alors l'adresse (voir la note sur la numérotation).

## Limites

- Modbus **TCP** uniquement (pas de Modbus RTU série direct : utilisez une passerelle série-Ethernet configurée en Modbus TCP).
- **Lecture seule**, sans possibilité de commander un relais.
- Pas de chiffrement ni d'authentification (propres au protocole) : placez les équipements sur un réseau local dédié.
- Pas de découverte automatique : adresses et types de données viennent de la notice de l'équipement.
- La détection de changement est faite par **scrutation** (`pollMs`) : un contact fermé moins longtemps que la période de
  lecture peut être manqué. Pour les événements brefs, réduisez `pollMs` (250 ms) ou utilisez un module qui mémorise
  les impulsions.
- L'anti-rebond est évalué aux instants de lecture : sa précision est de l'ordre de `pollMs`.
- Types supportés : 16 et 32 bits, flottant 32 bits. Pas de 64 bits ni de chaînes de caractères.
- La zone morte et la période minimale peuvent retarder un franchissement de seuil du PSIM : gardez `deadband` petit
  devant l'écart entre la valeur normale et le seuil.
- Une même entrée peut alimenter plusieurs points (par exemple une mesure et un test de seuil sur le même registre) ;
  la lecture reste unique.
- Un `id` ne peut appartenir qu'à un seul point, dans toute la configuration.
