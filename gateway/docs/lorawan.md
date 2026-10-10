# Module LoRaWAN de la Passerelle GAMR

Ce module relie des capteurs **LoRaWAN** (longue portée, faible consommation) au PSIM : chantiers et sites isolés, cuves, températures, ouvertures, détecteurs de mouvement, boutons panique. Le réseau LoRaWAN lui-même est géré par **ChirpStack v4** (logiciel libre), que vous installez à côté de la Passerelle.

> **État de validation.** Le module est testé avec des charges ChirpStack v4 simulées. Les noms de champs des capteurs viennent des codecs publiés par les fabricants, relus de mémoire : **aucun n'a été vérifié avec un capteur réel**. Chaque profil est classé « probable » ou « à qualifier » (tableau plus bas). Dans tous les cas, faites un essai avec le capteur réel avant la mise en service (section 7).

## 1. Architecture

```
 capteur LoRa  ──radio──►  passerelle LoRa  ──►  ChirpStack v4  ──MQTT──►  Passerelle GAMR  ──►  PSIM
 (Dragino,                 (concentrateur,      (décode la trame      (module lorawan :       (alarmes, plan,
  Milesight...)             « gateway »)         avec le codec)        traduction)             notifications)
```

1. Le capteur émet une trame radio (en général toutes les 10 à 60 minutes, et immédiatement lors d'un événement : ouverture, fuite, appui).
2. Une passerelle radio LoRa la reçoit et la transmet à ChirpStack.
3. ChirpStack déduplique (plusieurs passerelles radio peuvent entendre la même trame), déchiffre, applique le **codec** du capteur (octets → champs lisibles dans `object`) et publie le résultat sur son **broker MQTT**.
4. Le module `lorawan` s'abonne à ce broker, applique les règles de traduction et envoie des messages à l'équipement PSIM correspondant.

Ne pas confondre les deux brokers MQTT : celui de **ChirpStack** (que ce module lit) et celui du **PSIM** (vers lequel la Passerelle envoie). Le module ne publie jamais sur le broker de ChirpStack.

## 2. Configurer ChirpStack

1. **Passerelle radio** : ajoutez-la dans ChirpStack (identifiant « gateway ID » de la passerelle LoRa).
2. **Profil d'appareil** (Device profile) : région/bande radio adaptée (voir section 8), version LoRaWAN du capteur, mode OTAA. Dans l'onglet *Codec*, choisissez *JavaScript functions* et collez le **décodeur fourni par le fabricant** du capteur : sans codec, ChirpStack ne produit pas le champ `object` et le module ne voit que des octets bruts (il le signale par un avertissement « trame sans objet décodé »).
3. **Application** : créez une application (par exemple « chantier-nord ») et relevez son identifiant (UUID, visible dans l'adresse de la page).
4. **Appareils** : ajoutez chaque capteur avec son **DevEui** (16 caractères hexadécimaux, imprimé sur le capteur), son AppKey, et le profil d'appareil ci-dessus.
5. **Intégration MQTT** : dans la configuration de ChirpStack (`chirpstack.toml`, section `[integration.mqtt]`), vérifiez que l'intégration MQTT est active et notez l'adresse du broker. Le modèle de sujet par défaut est `application/{application_id}/device/{dev_eui}/event/{event}` : c'est celui que le module attend. Créez sur le broker un compte **en lecture seule** pour la Passerelle (sujets `application/#` en lecture).

Le module s'abonne, pour chaque capteur déclaré, à trois sujets seulement (jamais `#`) :

| Sujet | Utilité |
|---|---|
| `application/<appId>/device/<devEui>/event/up` | mesures et événements (trames montantes) |
| `application/<appId>/device/<devEui>/event/status` | niveau de batterie rapporté par le réseau (si le capteur répond à la demande d'état) |
| `application/<appId>/device/<devEui>/event/join` | nouvelle session (remet à zéro la protection contre les doublons) |

## 3. Configuration du module

Section `lorawan` de la configuration de la Passerelle :

```json
{
  "broker": { "url": "mqtt://192.168.1.20:1883", "username": "gamr-lecture", "password": "..." },
  "applicationId": "52f14cd4-c6f1-4fbd-8f87-4025e1d49242",
  "lowBatteryPercent": 15,
  "staleAfterS": 0,
  "devices": {
    "a84041ffff1a2b3c": { "id": "porte-atelier", "kind": "dragino-lds03a" },
    "a84041ffff2d4e5f": { "id": "fuite-local-pompe", "kind": "dragino-lwl03a" },
    "70b3d57ed0012345": { "id": "cuve-gasoil", "kind": "dragino-ldds75",
                          "overrides": { "niveau": { "emptyAt": 2000 } } },
    "70b3d57ed0067890": { "id": "chambre-froide", "kind": "milesight-th",
                          "overrides": { "temperature": { "minIntervalS": 300 } } },
    "70b3d57ed00abcde": {
      "id": "pompe-vibration",
      "mapping": [
        { "key": "vib", "from": "object.vibration", "type": "bool", "equals": true,
          "emit": { "event": "vibration" }, "emitElse": { "event": "normal" } }
      ]
    }
  }
}
```

| Clé | Rôle |
|---|---|
| `broker.url` | broker MQTT de ChirpStack (`mqtt://`, `mqtts://`, `ws://`, `wss://`) |
| `broker.username`, `broker.password` | identifiants (jamais écrits dans les journaux) |
| `applicationId` | identifiant d'application ChirpStack ; `"+"` ou absent = toutes les applications |
| `lowBatteryPercent` | seuil de batterie faible pour les capteurs qui rapportent un pourcentage (1 à 99, défaut 15) |
| `staleAfterS` | si > 0, ignore les trames dont l'heure (`time`) est plus ancienne que ce délai (rattrapage après une coupure). 0 = désactivé (défaut) |
| `devices` | un capteur par DevEui (majuscules ou minuscules, 16 hexadécimaux). Un DevEui ou un identifiant PSIM en double est refusé |
| `devices.<devEui>.id` | identifiant de l'équipement dans le PSIM (1 à 32 caractères : lettres, chiffres, `_`, `-`) |
| `devices.<devEui>.kind` | nom d'un profil prédéfini (section 5) |
| `devices.<devEui>.mapping` | règles personnalisées (section 4), ajoutées après celles du profil |
| `devices.<devEui>.overrides` | modifie des champs d'une règle du profil, par sa clé (section 5) |

La configuration est validée **strictement** au démarrage : clé inconnue, évènement inconnu, DevEui mal formé, doublon, chemin dangereux... toute erreur arrête le module avec un message en français qui indique l'endroit (par exemple `lorawan : devices.a84041ffff1a2b3c.mapping[0].emit.event : evenement inconnu`). Une faute de frappe ne rend donc jamais un capteur muet en silence.

## 4. Règles de traduction (`mapping`), sans code

Chaque règle lit un champ du codec ChirpStack et le traduit en message PSIM. Le chemin est **pointé** et sûr : `object.temperature`, `object.mesures.0.valeur` (les nombres désignent un rang de tableau). Les crochets, `__proto__`, `constructor`, `prototype` et tout ce qui ressemble à du code sont refusés ; seules les propriétés propres de la charge JSON sont lues.

Champs communs : `key` (nom de la règle, utilisé dans le `msgId` et par `overrides` ; par défaut le dernier segment du chemin), `from`, `type`, `minIntervalS` (délai minimal entre deux messages de cette règle).

### `type: "bool"` : un champ vrai/faux (ou 0/1, `"true"`/`"false"`)

```json
{ "from": "object.DOOR_OPEN_STATUS", "type": "bool", "equals": true,
  "emit": { "event": "intrusion" }, "emitElse": { "event": "door_closed" } }
```
`equals` (défaut `true`) : valeur qui déclenche `emit` ; toute autre valeur déclenche `emitElse`. Par défaut, on n'émet **qu'au changement** (les trames périodiques qui répètent le même état ne font rien). `"repeat": true` émet à chaque trame concernée (boutons).

### `type: "enum"` : un champ texte ou numérique à valeurs connues

```json
{ "from": "object.pir", "type": "enum",
  "map": { "trigger": { "event": "motion" }, "normal": { "event": "clear" } } }
```
Les valeurs absentes de `map` sont sans effet. Même logique « au changement » ; `repeat` possible.

### `type: "number"` : une mesure

- **Transmettre la mesure** (le PSIM la compare à ses propres seuils d'alerte, réglés par équipement) :
  `{ "from": "object.TempC_SHT", "type": "number", "emit": { "value": true }, "deadband": 0.5, "minIntervalS": 60, "scale": 1, "offset": 0 }`
  La valeur transmise est `brut × scale + offset`. `deadband` : une nouvelle mesure n'est envoyée que si elle diffère d'au moins cette valeur de la dernière envoyée. `min` / `max` saturent la valeur. Les textes avec unité (`"430 mm"`) sont acceptés.
- **Déclencher un événement au franchissement d'un seuil** :
  `{ "from": "object.temp", "type": "number", "when": "above", "threshold": 60, "hysteresis": 5, "emit": { "event": "over_temperature", "value": true }, "emitElse": { "event": "normal" } }`
  `when` : `above` (>), `below` (<), `atLeast` (≥), `atMost` (≤). L'événement n'est émis qu'au franchissement ; `hysteresis` évite les va-et-vient autour du seuil. `emit.value: true` joint la mesure.

### `type: "level"` : niveau de cuve en pourcentage

Convertit une **distance** capteur-liquide en niveau 0 à 100 % : `emptyAt` = distance quand la cuve est vide (hauteur de cuve, même unité que le capteur, en général des millimètres), `fullAt` = distance quand elle est pleine (défaut 0 ; pour un capteur ultrason, utilisez sa zone aveugle). Accepte les mêmes options que `number` (sauf `scale`, `offset`, `min`, `max`). Exemple : cuve de 2 m, `emptyAt: 2000` ; une distance de 1500 mm donne 25 %.

### `type: "battery"` : batterie faible

`{ "from": "object.battery", "type": "battery", "unit": "percent" }` : émet `low_battery` **une seule fois** au passage sous le seuil (`threshold`, par défaut `lowBatteryPercent`). En `"unit": "volt"`, le seuil `threshold` (en volts) est obligatoire. Une hystérésis (3 points / 0,1 V par défaut) empêche de répéter l'alerte tant que la batterie oscille autour du seuil. Le module n'émet pas de « retour à la normale » : après un changement de pile, l'état « défaut » est levé par le prochain événement de retour à la normale du capteur, ou à la main dans le PSIM.

### Messages produits (`emit`)

`{ "event": "..." }` **ou** `{ "state": "..." }` (pas les deux), éventuellement avec `"value": true` pour une mesure. Événements reconnus par le PSIM : `intrusion, motion, glass_break, tamper, panic, door_forced, leak, flood, over_temperature, normal, clear, restored, door_closed, dry, fault, low_battery, heartbeat, door_opened, gas, co, power_loss, power_restored, vibration, line_crossing, loitering, sos, fall`. États : `normal, prealarm, alarm, fault, offline`. Le PSIM donne la priorité à l'état, puis à l'événement, puis à la mesure.

### Garanties communes

- **Retransmissions** : le compteur de trames (`fCnt`) de chaque capteur est mémorisé (64 dernières valeurs) ; une trame déjà vue est ignorée. ChirpStack omet `fCnt` quand il vaut 0 : le module le lit alors comme 0. Une nouvelle session (`join`) vide cette mémoire.
- **Identifiant de message** : `<devEui>-<fCnt>-<clé de règle>` (ex. `a84041ffff1a2b3c-123-porte`), identique si la trame est rejouée. Pour les événements `status` et `join` : `<devEui>-status-<heure>-...`.
- **Heure** : l'heure `time` de la trame est transmise comme heure de l'événement. Si elle est invalide, avant 2000 ou à plus de 5 minutes dans le futur, l'heure de la Passerelle est utilisée.
- **Signe de vie** : toute trame valide qui ne produit aucun autre message produit un `heartbeat`. Ainsi, un capteur de température dont la valeur ne bouge pas (bande morte) reste « vivant » côté PSIM.
- **Pas d'inondation** : bande morte, `minIntervalS`, et plafond de 60 messages par minute et par capteur.
- **Robustesse** : charge limitée à 64 Kio, JSON invalide ou non objet ignoré avec un avertissement (au plus un par minute et par capteur et par nature), `devEui` du contenu comparé à celui du sujet.

## 5. Profils prédéfinis

Un profil est un simple fichier de données (`profiles.ts`), sans code dynamique. « Probable » : nom de champ vraisemblable d'après le codec du fabricant, à vérifier. « À qualifier » : incertain, **à qualifier avec le capteur réel**. Les seuils de batterie en volts sont des valeurs prudentes à confirmer sur la fiche du capteur.

| Profil (`kind`) | Capteur | Champs du codec ChirpStack attendus | Messages PSIM | Fiabilité |
|---|---|---|---|---|
| `dragino-lht65` | Dragino LHT65 | `object.TempC_SHT` (°C), `object.BatV` (V) | `value` = température ; `low_battery` sous 2,6 V | probable |
| `milesight-th` | Milesight température/humidité (famille EM300-TH, etc.) | `object.temperature` (°C), `object.battery` (%) | `value` = température ; `low_battery` | probable |
| `milesight-ws301` | Milesight WS301 (contact de porte) | `object.door` (`open`/`close`), `object.battery` (%) | ouvert → `intrusion`, fermé → `door_closed` | **à qualifier** |
| `dragino-lds03a` | Dragino LDS03A (contact de porte) | `object.DOOR_OPEN_STATUS` (1 = ouvert), `object.BAT_V` (V) | ouvert → `intrusion`, fermé → `door_closed` ; `low_battery` sous 2,4 V | probable |
| `dragino-lwl03a` | Dragino LWL03A (fuite d'eau) | `object.WATER_LEAK_STATUS` (1 = fuite), `object.BAT_V` (V) | fuite → `leak`, sec → `dry` ; `low_battery` sous 2,4 V | probable |
| `dragino-ldds75` | Dragino LDDS75 / LDDS45 (niveau de cuve) | `object.Distance` (nombre ou texte « 430 mm »), `object.Bat` (V) | `value` = niveau 0 à 100 % ; `low_battery` sous 3,0 V | **à qualifier** |
| `milesight-ws202` | Milesight WS202 (mouvement PIR) | `object.pir` (`trigger`/`normal`), `object.battery` (%) | `trigger` → `motion`, `normal` → `clear` | probable |
| `milesight-ws101` | Milesight WS101 (bouton) | `object.press` (`short`/`long`/`double`), `object.battery` (%) | appui long → `panic` (chaque appui) | **à qualifier** |
| `bouton-sos` | bouton panique générique | `object.alarm` (booléen ou 0/1) ; à adapter au codec réel | `panic` à chaque trame vraie | **à qualifier** |

Règles contenues dans chaque profil (clés utilisables dans `overrides`) : `temperature`, `batterie` (température/humidité LHT65 et Milesight) ; `porte`, `batterie` (contacts) ; `fuite`, `batterie` ; `niveau`, `batterie` (cuve) ; `mouvement`, `batterie` ; `bouton`, `batterie`.

L'humidité n'est pas transmise : un équipement PSIM porte **une seule** mesure, et un DevEui ne peut être déclaré qu'une fois. Si l'humidité vous importe plus que la température, remplacez la règle `temperature` par une règle `number` personnalisée sur `object.humidity` (ou `overrides.temperature.from`).

### Corriger un profil sans code : `overrides`

Si le codec du capteur réel nomme un champ autrement, ou pour fixer la hauteur d'une cuve :

```json
"a84041ffff1a2b3c": {
  "id": "porte-atelier", "kind": "milesight-ws301",
  "overrides": { "porte": { "from": "object.magnet_status" } }
}
```
Chaque entrée porte le nom de la règle (`key`) et remplace les champs indiqués ; `key` et `type` ne se changent pas. Pour voir ce que le codec produit réellement : onglet *Events* de l'appareil dans ChirpStack, ou abonnez-vous avec `mosquitto_sub -h <broker> -t "application/<appId>/device/<devEui>/event/up" -v` et lisez le champ `object`.

## 6. Régler la détection de silence (côté PSIM)

Le module ne juge pas lui-même qu'un capteur est silencieux : c'est le PSIM qui le fait, à partir de la date du dernier message reçu. Le module envoie un message (mesure, événement ou `heartbeat`) à **chaque trame valide**, donc le silence du PSIM correspond bien à une absence de trames.

Dans le PSIM, ouvrez l'équipement (écran des équipements, champ *Supervision*, en secondes) et réglez le délai en fonction de la période d'émission du capteur :

> **délai = 3 × période d'émission du capteur** (jamais moins de 2 fois la période, plus une marge)

| Le capteur émet toutes les | Délai conseillé |
|---|---|
| 10 minutes | 1 800 s (30 min) |
| 30 minutes | 5 400 s (1 h 30) |
| 60 minutes | 10 800 s (3 h) |

Avec un délai trop court, un capteur LoRa sera déclaré « hors ligne » à tort (pertes de trames normales en radio). `0` désactive la supervision pour l'équipement. Un capteur qui n'émet qu'aux changements (ex. contact de porte sans trame périodique) doit être mis à `0`, ou configuré pour envoyer une trame périodique. Rappel : le PSIM ne déclare muets que les équipements de type détecteur à l'état normal ou défaut.

## 7. Mise en service d'un capteur

1. Ajoutez le capteur dans ChirpStack, attendez la jonction (*join*) et la première trame ; contrôlez dans *Events* que le champ `object` est bien rempli.
2. Relevez les noms de champs réels ; comparez au tableau ; corrigez avec `overrides` si besoin.
3. Déclarez le capteur dans la configuration du module et dans le PSIM (même identifiant), réglez la supervision (section 6) et les seuils d'alerte d'une mesure (température, niveau) dans le PSIM.
4. Provoquez chaque événement (ouvrir la porte, mouiller la sonde, appuyer sur le bouton) et vérifiez l'incident dans le PSIM.

## 8. Fréquences radio et réglementation

La bande de fréquences à utiliser en Côte d'Ivoire, les puissances et les éventuelles autorisations sont **à confirmer auprès de l'ARTCI** avant tout déploiement. Ce document n'affirme rien sur la réglementation locale. Le profil radio (région) de la passerelle LoRa, du profil d'appareil ChirpStack et des capteurs doit être le même ; choisissez des capteurs vendus dans la bonne variante de fréquence.

## 9. Limites

- **Latence** : une alarme LoRa arrive en quelques secondes à quelques dizaines de secondes (réseau, déduplication), jamais comme un contact filaire ou un détecteur incendie certifié. Ne pas utiliser pour la protection des personnes en première ligne.
- **Débit radio très limité** : un capteur qui perd sa liaison ne le dit pas ; seul le silence (section 6) le révèle. Un événement unique perdu en radio (trame d'alarme non reçue) n'est pas rejoué : privilégiez les capteurs qui répètent leur état à chaque trame périodique, ce que le module sait exploiter (une trame périodique qui montre l'état d'alarme déclenche l'alarme si elle n'avait pas été vue).
- **Codec indispensable** : sans codec dans ChirpStack, pas de champ `object`.
- **Un équipement PSIM = un capteur = une mesure** (une valeur ; plusieurs évènements possibles).
- **Aucune commande** : le module lit uniquement, il n'envoie rien aux capteurs.
- **Reconnexion MQTT** : assurée par la liaison fournie par le socle de la Passerelle ; au démarrage, si le broker de ChirpStack est injoignable, le module échoue à démarrer (message dans le journal).
- **Redémarrage** : l'état mémorisé (dernier état vu, dernière mesure) est perdu ; la première trame après un redémarrage est donc réémise.
- **Anti-doublons** : borné aux 64 derniers `fCnt` de chaque capteur, sans durée. Pas de reprise des messages manqués pendant une coupure (ChirpStack ne rejoue pas non plus l'historique MQTT).
- **Pas de réglage fin du réseau** : le module ne lit ni la qualité du signal (RSSI/SNR) ni la marge de liaison.
