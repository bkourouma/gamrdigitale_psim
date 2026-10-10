# Module Zigbee (pont Zigbee2MQTT)

Ce module de la Passerelle GAMR relie des capteurs Zigbee (mouvement, contact de porte, fuite d'eau,
température, fumée, gaz, monoxyde de carbone, vibration, bouton d'urgence) au PSIM. Il s'appuie sur
**Zigbee2MQTT**, logiciel libre qui pilote une clé USB Zigbee et publie chaque capteur sur un broker MQTT.
La Passerelle lit ce broker (lecture seule), traduit les messages et les envoie au PSIM.

```
capteurs Zigbee ──radio──> clé USB ──> Zigbee2MQTT ──> broker MQTT ──> module zigbee ──> PSIM
```

La Passerelle ne parle jamais aux capteurs : elle ne fait que lire ce que Zigbee2MQTT publie.

## 1. Installer Zigbee2MQTT

1. **Matériel** : une clé Zigbee USB compatible (par exemple Sonoff ZBDongle-E ou ZBDongle-P) et un
   mini-PC ou un Raspberry Pi proche du centre du bâtiment (rallonge USB de 1 m conseillée, loin des
   ports USB 3 et du Wi-Fi). Les capteurs sur secteur (prises, ampoules) font office de relais et
   étendent la portée.
2. **Broker MQTT** : installer Mosquitto (`apt install mosquitto`), créer un utilisateur et un mot de passe
   (`mosquitto_passwd`), et ne l'ouvrir qu'au réseau local.
3. **Zigbee2MQTT** : suivre l'installation officielle (https://www.zigbee2mqtt.io/guide/installation/),
   de préférence en Docker. Fichier `configuration.yaml` minimal :

```yaml
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://127.0.0.1:1883
  user: zigbee
  password: "mot-de-passe-du-broker"
serial:
  port: /dev/ttyUSB0          # ou /dev/serial/by-id/... (plus stable)
frontend:
  port: 8080
advanced:
  last_seen: ISO_8601         # IMPORTANT : horodate chaque message (voir plus bas)
  output: json                # valeur par défaut, à ne pas changer
permit_join: false
```

`last_seen: ISO_8601` n'est pas obligatoire mais fortement recommandé : sans lui, le module ne peut ni
dater les événements à leur heure réelle ni fabriquer d'identifiants de message stables (le rejeu après
une coupure peut alors créer des doublons dans le PSIM).

## 2. Appairer un capteur

1. Ouvrir l'interface Zigbee2MQTT (`http://<machine>:8080`), cliquer sur **Permit join (All)**.
2. Mettre le capteur en mode appairage (en général, appui long de 5 secondes sur le bouton du capteur
   jusqu'au clignotement de la LED).
3. Le capteur apparaît dans la liste. **Le renommer** (icône crayon, cocher « Update Home Assistant
   entity ID » sans importance ici) : ce nom, le *friendly name*, devient le sujet MQTT
   `zigbee2mqtt/<nom>`. Choisir des noms courts, sans espace superflu : `porte_entree`, `pir_couloir`.
4. Désactiver l'appairage (**Disable join**) une fois terminé.
5. Vérifier dans l'onglet *Exposes* / *State* de l'équipement les champs publiés (voir tableau plus bas).

Un capteur peut aussi être désigné par son adresse IEEE (`0x00158d0001234567`) si on a laissé ce nom par
défaut ; il est préférable de lui donner un vrai nom.

## 3. Configurer le module

Section `zigbee` de la configuration de la Passerelle :

```json
{
  "broker": { "url": "mqtt://127.0.0.1:1883", "username": "gamr-lecture", "password": "mot-de-passe" },
  "baseTopic": "zigbee2mqtt",
  "batteryLowPercent": 15,
  "staleAfterS": 7200,
  "devices": {
    "porte_entree": { "id": "zb-porte-1",  "kind": "contact" },
    "pir_couloir":  { "id": "zb-pir-1",    "kind": "motion" },
    "fuite_cuisine":{ "id": "zb-fuite-1",  "kind": "leak" },
    "thermo_salle": { "id": "zb-temp-1",   "kind": "temperature", "humidityId": "zb-hum-1", "minDelta": 0.5 },
    "fumee_atelier":{ "id": "zb-fumee-1",  "kind": "smoke" },
    "gaz_cuisine":  { "id": "zb-gaz-1",    "kind": "gas" },
    "co_chaufferie":{ "id": "zb-co-1",     "kind": "co" },
    "choc_coffre":  { "id": "zb-choc-1",   "kind": "vibration" },
    "sos_accueil":  { "id": "zb-sos-1",    "kind": "panic" }
  }
}
```

Chaque équipement doit **aussi exister dans le PSIM** (même identifiant `id`), avec la catégorie qui
convient (incendie, intrusion, accès, environnement).

### Options

| Option | Défaut | Rôle |
|---|---|---|
| `broker.url` | obligatoire | Adresse du broker de Zigbee2MQTT (`mqtt://`, `mqtts://`, `ws://`, `wss://`). |
| `broker.username` / `password` | aucun | Compte de **lecture** sur ce broker. |
| `baseTopic` | `zigbee2mqtt` | Doit être identique à `mqtt.base_topic` de Zigbee2MQTT. |
| `devices` | obligatoire | Un objet par capteur : clé = *friendly name* (ou adresse IEEE). |
| `devices.<nom>.id` | obligatoire | Identifiant PSIM (1 à 32 caractères : lettres, chiffres, `_`, `-`). Pas de doublon. |
| `devices.<nom>.kind` | obligatoire | `motion`, `contact`, `leak`, `temperature`, `smoke`, `gas`, `co`, `vibration`, `panic`, `tamper_only`. |
| `devices.<nom>.humidityId` | aucun | (`temperature` seulement) équipement PSIM distinct qui reçoit l'humidité. Sans lui, l'humidité est ignorée. |
| `devices.<nom>.minDelta` | `valueMinDelta` | Variation minimale de température avant un nouvel envoi. |
| `devices.<nom>.humidityMinDelta` | `humidityMinDelta` | Idem pour l'humidité. |
| `devices.<nom>.repeatEveryS` | `valueEveryS` | Délai (s) après lequel une mesure inchangée, ou une alarme toujours active, est renvoyée. |
| `valueMinDelta` | `0.5` | Valeur par défaut de `minDelta` (en °C). |
| `humidityMinDelta` | `2` | Valeur par défaut (en points d'humidité). |
| `valueEveryS` | `900` | Valeur par défaut de `repeatEveryS` (15 minutes). |
| `batteryLowPercent` | `15` | Seuil de batterie faible (voir plus bas). |
| `staleAfterS` | aucun | Active les signes de vie (voir « Supervision »). |
| `heartbeatEveryS` | `60` | Période des signes de vie. Doit être inférieure à `staleAfterS`. |
| `maxAgeS` | `900` | Messages datés (`last_seen`) plus vieux que cela : ignorés (`0` = pas de limite). |
| `maxPerMinute` | `60` | Plafond d'envois par capteur et par minute (protège le PSIM d'un capteur qui oscille). |

Une option inconnue, un identifiant invalide ou en double, un nom contenant un joker MQTT (`#`, `+`) ou
un type inconnu **empêchent le démarrage du module** avec un message d'erreur en français.

## 4. Capteur → événement PSIM

Le module n'écoute **que** `zigbee2mqtt/<nom>` pour les capteurs déclarés et `zigbee2mqtt/bridge/state`.
Il ne s'abonne jamais à l'ensemble du broker.

| `kind` | Champ Zigbee2MQTT | Message envoyé au PSIM |
|---|---|---|
| `motion` | `occupancy` (ou `presence`) = true / false | événement `motion` / `clear` |
| `contact` | `contact` = **false** (ouvert) / **true** (fermé) | `door_opened` / `door_closed` |
| `contact` | `tamper` = true | `door_forced` (envoyé après le contact) |
| `leak` | `water_leak` = true / false | `leak` / `dry` |
| `temperature` | `temperature` (°C) | `value` (mesure) |
| `temperature` + `humidityId` | `humidity` (%) | `value` sur l'équipement `humidityId` |
| `smoke` | `smoke` = true / false | état `alarm` / `normal` |
| `gas` | `gas` = true / false | `gas` / `clear` |
| `co` | `carbon_monoxide` = true / false | `co` / `clear` |
| `vibration` | `vibration` = true / false ; ou `action` = `vibration`, `tilt`, `drop` | `vibration` / `clear` ; `vibration` |
| tous types | `action` = `emergency` ou `panic` | `panic` (un événement par appui) |
| tous (sauf `contact`) | `tamper` = true | `tamper` |
| tous | `battery` ≤ seuil, ou `battery_low` = true | `low_battery` (une seule fois par épisode) |
| tous | tout autre champ (`linkquality`, `voltage`, `illuminance`...) | ignoré |

Précisions :

- **Pas d'inondation** : un message dont les valeurs n'ont pas changé n'est pas renvoyé (Zigbee2MQTT
  republie tout l'état à chaque variation, même du simple niveau de signal). Les mesures de température
  et d'humidité ne repartent que si elles varient d'au moins `minDelta`, ou toutes les `repeatEveryS`
  secondes. Une alarme qui dure (fuite, fumée...) est renvoyée au bout de `repeatEveryS` si elle est
  toujours active, de sorte qu'un acquittement manuel dans le PSIM ne la masque pas pour toujours.
- **Batterie** : `low_battery` est envoyé quand le niveau passe à `batteryLowPercent` ou moins (15 %
  exactement compte). Il n'est pas répété ; le verrou ne se lève que lorsque le niveau dépasse le seuil
  de plus de 5 points (pile remplacée), pour éviter les va-et-vient autour du seuil. Dans un même
  message, la batterie faible est envoyée **avant** l'alarme : l'alarme garde la priorité dans le PSIM.
- **Fin de sabotage** (`tamper` = false) : rien n'est envoyé ; le retour à la normale se fait côté PSIM.
- **Heure et doublons** : si `last_seen` est activé, l'événement est daté à cette heure (`ts`) et reçoit un
  identifiant déterministe `<nom>-<heure>-<champ>-<valeur>`. Rejouer le même message ne crée donc pas
  de doublon. Sans `last_seen`, ni `ts` ni `msgId` : c'est la Passerelle qui date et numérote.
- **Messages anciens** : un message conservé par le broker et plus vieux que `maxAgeS` est ignoré
  (état du capteur inconnu), pour ne pas déclencher d'alarme fantôme au redémarrage.
- **Charges illisibles** : JSON invalide, trop gros (plus de 32 Ko) ou qui n'est pas un objet : ignorés et
  journalisés (au plus une fois par minute et par capteur). Le module ne s'arrête jamais pour cela.

## 5. Pont hors ligne et supervision

**Pont hors ligne** (`zigbee2mqtt/bridge/state` = `offline`) : le module le **journalise** (niveau
« warn », puis « info » au retour) et n'envoie rien au PSIM. Il ne déclare **pas** les capteurs en panne :
on ne sait rien d'eux tant que le pont est arrêté. Pensez à surveiller le service Zigbee2MQTT lui-même.

**Silence des capteurs** : les capteurs Zigbee n'émettent souvent qu'aux changements (un contact de porte
reste muet des jours). Le PSIM a, pour chaque équipement, un délai de silence propre (`heartbeat_s`) :

- `0` : l'équipement n'est pas supervisé (le silence n'est jamais une panne). **Réglage sûr par défaut**
  pour les contacts de porte et les détecteurs de mouvement.
- Une valeur > 0 : au-delà de ce délai sans message, le PSIM déclare l'équipement « hors ligne ».

Deux manières de régler cela :

1. **Sans `staleAfterS`** (par défaut) : le module n'envoie aucun signe de vie. Régler `heartbeat_s` dans le
   PSIM sur une durée **supérieure** à l'intervalle de rapport du capteur (voir sa fiche ; beaucoup de
   capteurs Aqara/Sonoff remontent leur batterie ou leur température au moins toutes les heures, à
   mesurer sur le terrain), ou `0`.
2. **Avec `staleAfterS`** (par exemple `7200`) : tant qu'un capteur a parlé depuis moins de `staleAfterS`
   secondes, le module envoie `heartbeat` toutes les `heartbeatEveryS` secondes. Régler alors `heartbeat_s`
   dans le PSIM à environ 3 × `heartbeatEveryS` (180 s). Un capteur muet depuis plus de `staleAfterS` n'est
   plus maintenu en vie : le PSIM le déclare hors ligne environ `staleAfterS + heartbeat_s` après son
   dernier message. Pendant une panne du pont, les signes de vie sont suspendus : le PSIM finira donc par
   montrer les capteurs hors ligne, ce qui est la réalité.

## 6. Modèles de capteurs usuels (à qualifier avant déploiement)

Les noms de champs ci-dessous sont ceux publiés par Zigbee2MQTT ; **vérifier sur le capteur réel** (onglet
*State*) avant de s'y fier, et tester chaque modèle (déclenchement, retour à la normale, batterie, durée
d'autonomie, portée) avant une installation. La liste complète est sur https://www.zigbee2mqtt.io/supported-devices/.

| Type | Aqara | Sonoff | Tuya Zigbee | Heiman |
|---|---|---|---|---|
| Contact de porte (`contact`) | MCCGQ11LM | SNZB-04 | TS0203 | HS1DS |
| Mouvement (`motion`) | RTCGQ11LM | SNZB-03 | TS0202 | HS1MS |
| Fuite d'eau (`leak`) | SJCGQ11LM | SNZB-05 | TS0207 | HS1WL |
| Température / humidité (`temperature`) | WSDCGQ11LM | SNZB-02 | TS0201 | |
| Vibration (`vibration`) | DJT11LM | | | |
| Fumée (`smoke`) | | | | HS1SA |
| Monoxyde de carbone (`co`) | | | | HS1CA |
| Gaz (`gas`) | | | | HS1CG |
| Bouton d'urgence (`panic`) | | | | HS1EB |

Points d'attention :

- Beaucoup de capteurs bon marché n'ont pas de `tamper` : le sabotage ne sera alors pas détecté.
- Le capteur de vibration Aqara ne renvoie pas toujours `vibration: false` : le PSIM garde l'alarme
  jusqu'à son acquittement (comportement voulu : un choc est un événement).
- Le bouton d'urgence doit publier `action: emergency` (ou `panic`) : à vérifier sur le modèle choisi.
- **Détecteurs de fumée Zigbee grand public** : ils ne sont pas certifiés (EN 54) et ne remplacent pas
  une centrale incendie ni les détecteurs du dispositif de sécurité réglementaire ; à présenter comme
  une information complémentaire.
- Un contact de porte Zigbee ne remonte pas toujours d'état périodique : prévoir `heartbeat_s = 0` côté
  PSIM ou utiliser `staleAfterS` avec une valeur généreuse.

## 7. Dépannage

- **Rien n'arrive dans le PSIM** : lire le journal de la Passerelle ; vérifier `baseTopic`, le nom exact
  (majuscules comprises) du capteur, et l'identifiant dans le PSIM. Pour observer le broker :
  `mosquitto_sub -h 127.0.0.1 -u zigbee -P ... -t 'zigbee2mqtt/#' -v` (sur la machine du broker, jamais
  dans la Passerelle).
- **« message illisible »** dans le journal : le sujet reçoit autre chose qu'un objet JSON ; vérifier que
  `advanced.output` est bien `json` ou `attribute_and_json` dans Zigbee2MQTT.
- **« message trop ancien »** : le capteur n'a pas parlé depuis longtemps, ou l'horloge de la machine
  Zigbee2MQTT n'est pas à l'heure (activer la synchronisation NTP).
- **« envoie trop de messages »** : un capteur oscille (contact mal fixé, détecteur déréglé) ; le surplus
  est ignoré pour protéger le PSIM.
