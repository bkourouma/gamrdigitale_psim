# Module SIA : raccorder une centrale d'alarme à la Passerelle GAMR

La Passerelle GAMR peut jouer le rôle d'un **récepteur de télésurveillance** (« Central Station Receiver ») :
les centrales d'alarme intrusion / incendie du marché lui transmettent leurs événements par le protocole
**SIA DC-09** (aussi appelé SIA-DCS ou « SIA IP »), exactement comme elles le feraient vers une société de
télésurveillance. La passerelle traduit chaque événement en message PSIM (alarme, défaut, retour à la normale)
et l'acquitte seulement une fois transmis : si la passerelle est arrêtée, la centrale renvoie l'événement plus tard.

> **Important — validation sur matériel réel obligatoire.** Le module est conforme à la norme et testé contre un
> encodeur DC-09 indépendant, mais aucune marque n'a encore été qualifiée sur une vraie centrale. Avant toute mise
> en service, faites l'essai décrit plus bas (« Recette sur site ») avec la centrale du client.

## 1. Réglages à faire sur la centrale

Dans le menu « Télésurveillance », « Centre de réception », « ARC », « Monitoring station » ou « SIA DC-09 » :

| Réglage centrale | Valeur à saisir |
|---|---|
| Protocole / format | **SIA DC-09**, format **SIA-DCS** de préférence (Contact ID « ADM-CID » accepté) |
| Adresse du récepteur | adresse IP **fixe** de la passerelle sur le réseau du site (celle mise dans `listen.host`) |
| Port | celui de `listen.port` (ex. 12300) |
| Transport | **TCP** de préférence (UDP accepté si la centrale ne sait faire que cela) |
| Numéro de compte (account) | 3 à 16 caractères hexadécimaux (chiffres 0-9, lettres A-F), **différent pour chaque centrale** |
| Préfixe récepteur / ligne | laisser la valeur par défaut (renvoyée telle quelle) |
| Chiffrement | **activé, AES 128 bits** au minimum ; la même clé est saisie dans la passerelle |
| Horodatage (timestamp) | **activé**, et l'horloge de la centrale synchronisée (NTP si disponible) |
| Test cyclique / supervision (« polling », « ping », « NULL ») | **activé**, toutes les 60 s à 5 min |
| Nombre de tentatives | laisser la valeur par défaut |

Conseils :

- **Clé de chiffrement** : 32 caractères hexadécimaux pour AES-128 (64 pour AES-256), générés aléatoirement, par
  exemple avec `node -e "console.log(require('crypto').randomBytes(16).toString('hex').toUpperCase())"`.
  Certaines centrales demandent la clé sous forme de 16 caractères texte : dans ce cas, mettez `"keyFormat": "ascii"`.
- **Heure** : la passerelle refuse (NAK) une trame dont l'heure s'écarte de plus de `maxClockSkewS` secondes
  (20 s par défaut) de la sienne ; le NAK contient l'heure de la passerelle, ce qui permet à la plupart des centrales
  de se recaler. Vérifiez quand même que la passerelle **et** la centrale sont à l'heure (NTP).
- **Zones** : notez la liste des zones (numéros) et des partitions (groupes, secteurs) de la centrale ; chaque zone
  utile est rattachée à un équipement du PSIM dans la configuration.

## 2. Configuration de la passerelle

Section `sia` de la configuration de la passerelle :

```json
{
  "listen": { "host": "192.168.1.10", "port": 12300, "protocols": ["tcp", "udp"] },
  "maxClockSkewS": 20,
  "supervisionS": 300,
  "accounts": {
    "1A2B": {
      "panelName": "Centrale bureaux (Ajax Hub 2)",
      "keyEnv": "SIA_KEY_1A2B",
      "requireEncryption": true,
      "zones": {
        "1": { "id": "pir-hall" },
        "2": { "id": "porte-entree" },
        "5": { "id": "fumee-cuisine" },
        "*": { "id": "bureaux-autres-zones" }
      },
      "partitions": { "1": { "id": "bureaux-rdc" } },
      "defaultId": "centrale-bureaux"
    },
    "0457": {
      "panelName": "Centrale entrepôt (Paradox)",
      "key": "000102030405060708090A0B0C0D0E0F",
      "zones": { "1": { "id": "entrepot-porte" } },
      "defaultId": "centrale-entrepot",
      "supervisionS": 900,
      "overrides": { "sia": { "BA": { "event": "motion" } } }
    }
  }
}
```

| Clé | Rôle |
|---|---|
| `listen.host` | **Obligatoire.** Adresse IP de l'interface réseau sur laquelle écouter (jamais toutes par défaut). `0.0.0.0` / `::` refusés sauf `"allowAnyInterface": true`, à éviter. |
| `listen.port` | **Obligatoire.** Port d'écoute (TCP et UDP utilisent le même numéro). |
| `listen.protocols` | `["tcp"]` par défaut ; `["tcp", "udp"]` ou `["udp"]`. |
| `maxClockSkewS` | Écart d'heure toléré, en secondes (20 par défaut, comme la norme). |
| `supervisionS` | Silence maximal d'une centrale avant de passer ses équipements en défaut (0 = pas de supervision). Réglez-le à **2 à 3 fois** l'intervalle de test cyclique de la centrale. Peut être précisé par centrale. |
| `forwardHeartbeat` | `true` par défaut : chaque signe de vie de la centrale (trame NULL, test cyclique, armement) est relayé au PSIM comme `heartbeat` pour tous ses équipements, au plus une fois toutes les 30 s. |
| `accounts.<compte>` | Une entrée par centrale ; la clé est le numéro de compte saisi dans la centrale. |
| `key` / `keyEnv` | Clé AES (hexadécimal, 32/48/64 caractères). **Préférez `keyEnv`** : nom d'une variable d'environnement qui contient la clé, pour qu'elle ne reste pas en clair dans le fichier. Autre possibilité offerte par le socle : `"key": {"$file": "secrets/sia-0457.txt"}` ou `"key": {"$env": "NOM"}` (voir docs/PASSERELLE.md, « Secrets des modules »). |
| `keyFormat` | `"hex"` (défaut) ou `"ascii"` (clé de 16/24/32 caractères texte). |
| `requireEncryption` | Refuser toute trame non chiffrée de ce compte. **Vrai par défaut dès qu'une clé est donnée.** |
| `allowMissingTimestamp` | Accepter les trames **en clair** sans horodatage (faux par défaut ; à n'utiliser que pour une centrale qui ne sait pas horodater ; la protection anti-rejeu est alors affaiblie). |
| `zones` | Zone (numéro, sans zéros de tête : `"7"` = zone 007) → équipement PSIM. `"*"` = toutes les autres zones. |
| `partitions` | Partition / groupe → équipement PSIM (événements sans zone, ou zone non répertoriée). `"*"` possible. |
| `defaultId` | Équipement PSIM pour tout le reste (perte secteur, batterie de la centrale...). Sans correspondance ni `defaultId`, l'événement est ignoré et journalisé. |
| `overrides` | Corrections de la table des codes, générales ou par centrale (voir § 4). |
| `limits` | Bornes de sécurité (voir § 5) ; les valeurs par défaut conviennent à la plupart des sites. |

Les identifiants PSIM (`id`) doivent exister dans le PSIM comme détecteurs (catégorie intrusion, incendie,
environnement selon le cas). Ordre de recherche de l'équipement : zone exacte → zone `*` → partition →
partition `*` → `defaultId`. Les événements « de centrale » (alimentation, transmission, armement) ignorent la zone.

## 3. Table des codes (extraits principaux)

Sans `overrides`, un code **absent de la table est ignoré** (journalisé une fois) : la passerelle n'invente jamais
d'alarme. Les restaurations Contact ID (qualificatif 3) donnent `restored` (ou `power_restored` pour le secteur).

### SIA-DCS (2 lettres)

| Code(s) | Signification | Message PSIM |
|---|---|---|
| BA, BV, BM | Intrusion (vérifiée, point croisé) | `event: intrusion` |
| BG | Intrusion non vérifiée | `state: prealarm` |
| BH, BR | Fin d'alarme / rétablissement intrusion | `event: restored` |
| BC | Annulation intrusion | `event: alarm_reset` |
| BT, BS / BJ | Dérangement, supervision / fin | `event: fault` / `restored` |
| BB / BU | Zone isolée (non surveillée) / fin d'isolement | `event: fault` / `restored` |
| FA, KA, SA | Incendie, chaleur, sprinkler | `state: alarm` |
| FH, FR, KH, KR, SH, SR | Fin d'alarme incendie | `event: restored` |
| FT, FS, FB / FJ, FU | Dérangement incendie / fin | `event: fault` / `restored` |
| HA, PA | Hold-up, panique | `event: panic` |
| MA, QA | Médical, urgence | `event: sos` |
| GA | Gaz | `event: gas` |
| WA | Fuite d'eau | `event: leak` |
| ZA, UA | Gel, zone non typée | `state: alarm` |
| xH, xR (toutes familles) | Fin d'alarme | `event: restored` |
| TA / TR | Sabotage / rétablissement | `event: tamper` / `restored` |
| JA | Code utilisateur : tentative d'effraction | `event: tamper` (centrale) |
| DF | Porte forcée | `event: door_forced` |
| AT / AR | Perte / retour secteur | `event: power_loss` / `power_restored` (centrale) |
| YT, YM / YR | Batterie centrale faible, absente / rétablie | `event: low_battery` / `restored` (centrale) |
| XT / XR | Pile faible d'un détecteur sans fil / rétablie | `event: low_battery` / `restored` (zone) |
| YC, YS, YP, LT, ET, XQ | Transmission, alimentation, ligne, extension, brouillage | `event: fault` (centrale) |
| CL, CA, CG, CF, NL, OP, OA, OG | Armement / désarmement | signe de vie (`heartbeat`) |
| RP, RX, RR, BX, FX, TX | Test cyclique, test manuel, mise sous tension | signe de vie (`heartbeat`) |
| RS, RB, LB, LX, TS, TE, FI, FK, DD, DG | Programmation, tests, accès | ignorés (informatifs) |

### Contact ID (ADM-CID : `Q EEE GG CCC`)

| Code | Signification | Message PSIM |
|---|---|---|
| 1100, 1101 | Urgence médicale / personnelle | `event: sos` |
| 1110 à 1117 | Incendie (fumée, combustion, chaleur, déclencheur...) | `state: alarm` |
| 1118, 1138 | Presque-alarme | `state: prealarm` |
| 1120 à 1123 | Panique, contrainte, panique silencieuse / sonore | `event: panic` |
| 1130 à 1136, 1139, 1146, 1155 | Intrusion (périmètre, intérieur, 24 h, entrée/sortie...) | `event: intrusion` |
| 1137, 1144, 1145, 1341, 1383 | Sabotage | `event: tamper` |
| 1140, 1150 | Alarme générale / technique 24 h | `state: alarm` |
| 1151 / 1154 / 1158 / 1162 | Gaz / fuite d'eau / température haute / CO | `gas` / `leak` / `over_temperature` / `co` |
| 1301, 1342 / 3301, 3342 | Perte secteur / retour | `event: power_loss` / `power_restored` |
| 1302, 1309, 1311, 1338, 1384 | Batterie faible / absente, pile détecteur | `event: low_battery` |
| 13xx (300-393, voir code) | Dérangements système, transmission, détecteur | `event: fault` |
| 1570 à 1574 | Zone / groupe isolé (bypass) | `event: fault` |
| 1400 à 1409, 1441, 1442 (et 3xxx) | Armement / désarmement | signe de vie (`heartbeat`) |
| 1601 à 1604, 1608 | Tests cycliques et manuels | signe de vie (`heartbeat`) |
| 3xxx (alarme ou défaut) | Restauration | `event: restored` |

La table complète est dans `gateway/src/modules/sia/codes.ts`.

**Protection des alarmes en cours** : un dérangement (ou sa fin) reçu pour un équipement en alarme n'est pas
transmis, pour ne pas remplacer l'alarme par un défaut ; la perte de supervision non plus.

## 4. Corriger ou compléter la table (`overrides`)

```json
"overrides": {
  "sia": { "BA": { "event": "motion" }, "NT": { "event": "fault", "zone": false } },
  "cid": { "152": { "state": "alarm" }, "406": "ignore" }
}
```

- `event` (un événement PSIM : intrusion, motion, glass_break, tamper, panic, door_forced, forced_entry, leak,
  flood, over_temperature, gas, co, sos, fall, camera_masked, door_held_open, restored, normal, clear, alarm_reset,
  door_closed, power_restored, fault, low_battery, power_loss, heartbeat, door_opened) **ou** `state`
  (normal, prealarm, alarm, fault, offline) ;
- `kind` (facultatif) : `alarm`, `fault`, `restore` ou `heartbeat` si la déduction automatique ne convient pas ;
- `zone` (facultatif) : `false` si le numéro transmis n'est pas une zone (événement de centrale) ;
- `"ignore"` : ne rien transmettre pour ce code.

Une correction placée dans un compte l'emporte sur une correction générale, qui l'emporte sur la table.

## 5. Sécurité

Le module **écoute sur le réseau** ; il est conçu pour résister à un poste malveillant sur le même réseau :

- écoute uniquement sur l'interface configurée ; ouvrez le port **seulement** vers les centrales (pare-feu) ;
- trame limitée à 1024 octets ; une trame commencée doit être complète en `limits.frameTimeoutS` (10 s) ;
  connexion inactive fermée après `limits.idleTimeoutS` (120 s) ;
- connexions TCP simultanées limitées (`limits.maxConnections` = 64, `limits.maxConnectionsPerAddress` = 8) ;
- débit limité par adresse et par compte (`limits.perAddressPerMinute`, `limits.perAccountPerMinute` = 240) :
  au-delà, les trames ne sont pas acquittées, la centrale les renverra ;
- compte inconnu, CRC faux, heure hors fenêtre, trame en clair sur un compte chiffré, mauvaise clé : réponse
  `NAK` identique dans tous les cas (aucun indice sur les comptes existants), journal limité à une ligne par minute ;
- anti-rejeu : une trame déjà traitée (même compte, séquence et heure ; ou même contenu chiffré) est acquittée
  sans être retransmise au PSIM ; une trame ancienne est refusée par le contrôle d'heure ;
- les clés ne sont jamais écrites dans les journaux ; préférez `keyEnv` ;
- en UDP, la passerelle ne répond jamais par un message plus long que la requête (pas d'amplification).

**Le chiffrement est indispensable** dès que le réseau n'est pas entièrement maîtrisé : en clair, n'importe quel
poste du réseau peut fabriquer une fausse alarme ou un faux signe de vie (la norme DC-09 n'authentifie pas les
trames en clair).

## 6. Recette sur site (à faire pour chaque nouvelle marque ou nouveau modèle)

1. Déclarer la centrale dans la configuration, démarrer la passerelle, vérifier dans le journal :
   `recepteur SIA DC-09 a l'ecoute sur ...`.
2. Sur la centrale, lancer un **test de transmission** : la centrale doit afficher « transmission réussie » (ACK reçu).
   Un message `compte inconnu`, `horodatage hors fenetre`, `dechiffrement impossible` ou `trame en clair refusee`
   dans le journal indique un réglage à corriger.
3. Déclencher **chaque type de détecteur** (intrusion, ouverture, fumée en mode test, panique, sabotage) et vérifier
   l'équipement concerné dans le PSIM, puis sa **restauration**.
4. Débrancher le secteur de la centrale (perte puis retour secteur).
5. Débrancher le câble réseau de la centrale plus de `supervisionS` secondes : ses équipements passent en défaut ;
   rebrancher : ils redeviennent normaux.
6. Noter tout code `inconnu` signalé par le journal et l'ajouter dans `overrides` si besoin.

## 7. Marques

| Marque | Statut |
|---|---|
| Ajax (Hub 2 / Hub 2 Plus, « SIA DC-09 ») | à qualifier sur site |
| Paradox (IP150 / IP180) | à qualifier sur site |
| Texecom (ComIP / SmartCom, SIA-DCS) | à qualifier sur site |
| Risco (LightSYS, ProSYS) | à qualifier sur site |
| DSC / Tyco (TL280, PowerSeries Neo) | à qualifier sur site |
| Honeywell / Resideo (Galaxy, Vista + module IP) | à qualifier sur site |
| Hikvision AX PRO, Dahua, Satel... | à qualifier sur site |

## 8. Limites connues

- Conformité vérifiée contre un encodeur écrit d'après la norme (CRC, longueur, AES-CBC, horodatage), **pas encore
  contre une vraie centrale** : les variantes des fabricants (format de clé, emplacement du bourrage, champs
  propriétaires) peuvent exiger un ajustement.
- Pris en charge : SIA-DCS, ADM-CID, NULL, en clair et chiffrés (AES 128/192/256). Non pris en charge :
  4-2, Contact ID étendu `ADM-CID` à plusieurs événements par trame, SIA DC-04 / DC-07 (vidéo, données
  géographiques : les blocs étendus `[X...]` sont lus mais ignorés), réponses `RSP`.
- La norme DC-09 chiffre sans signature : le chiffrement empêche de fabriquer une trame valide sans la clé, mais
  ne protège pas contre un attaquant qui coupe le réseau (c'est le rôle de la supervision `supervisionS`).
- Une trame contenant plusieurs événements (SIA-DCS `Nri1/BA01/BA02`) est traitée en une fois ; si le PSIM ne
  peut pas tout prendre, la centrale renvoie la trame entière (les identifiants de message `compte-seq-heure`
  permettent au socle d'éliminer les doublons).
