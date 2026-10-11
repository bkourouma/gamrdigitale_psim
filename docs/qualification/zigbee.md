<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`mouvement`](#profil-mouvement) | Détecteur de mouvement (PIR) | 14 sur 17 |
| [`contact`](#profil-contact) | Contact d'ouverture de porte ou fenêtre | 15 sur 18 |
| [`fuite`](#profil-fuite) | Détecteur de fuite d'eau | 14 sur 17 |
| [`temperature`](#profil-temperature) | Capteur de température et humidité | 15 sur 18 |
| [`fumee`](#profil-fumee) | Détecteur de fumée Zigbee (non certifié EN 54) | 14 sur 17 |
| [`gaz`](#profil-gaz) | Détecteur de gaz | 14 sur 17 |
| [`co`](#profil-co) | Détecteur de monoxyde de carbone | 14 sur 17 |
| [`vibration`](#profil-vibration) | Capteur de vibration / choc | 14 sur 17 |
| [`panique`](#profil-panique) | Bouton d'urgence | 14 sur 17 |

<a id="profil-mouvement"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Détecteur de mouvement (PIR)** (`mouvement`)  
Fiche `zigbee` version 1 — empreinte `8a19e99929396162`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Intrusion (zone armée)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Zone armée : passer devant le capteur, en faisant le tour de son champ (3 passages à 1 m, 3 m et 5 m). Noter la distance où la détection devient incertaine. Noter l'heure exacte du geste.

**Résultat attendu** : Un incident d'intrusion s'ouvre à chaque passage (zone armée). L'incident porte le bon nom, la bonne zone et le motif « Mouvement détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Sortir du champ et rester immobile ; attendre que le capteur repasse au repos (délai propre au capteur : le noter).

**Résultat attendu** : L'état revient à Normal en moins de 90 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 90 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-contact"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Contact d'ouverture de porte ou fenêtre** (`contact`)  
Fiche `zigbee` version 1 — empreinte `b2b8fb1d4bf5d809`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Contrôle d'accès ou intrusion).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Faire sauter l'autoprotection du contact (ouvrir le boîtier ou l'arracher de son support) : le module envoie « Porte forcée » après l'ouverture. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Porte forcée » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Porte forcée » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer le boîtier, remettre l'aimant en face et la porte fermée ; attendre « Porte fermée ».

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Ouverture et fermeture sans incident `contact-info` — OBLIGATOIRE

**À faire** : Ouvrir puis refermer la porte (aimant écarté puis remis) 5 fois, porte normalement autorisée.

**Résultat attendu** : Le PSIM enregistre « Porte ouverte » et « Porte fermée » comme informations, sans ouvrir d'incident ni changer l'état du détecteur.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper-contact` — facultative

**À faire** : Sans objet pour ce profil : l'autoprotection sert de déclencheur à l'étape « Déclenchement ». Marquer « na » avec cette mention. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 17. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 18. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 15 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-fuite"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Détecteur de fuite d'eau** (`fuite`)  
Fiche `zigbee` version 1 — empreinte `d42870bff77caff5`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Plonger les deux sondes du capteur dans un verre d'eau (1 cm d'eau). Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Fuite d'eau » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Fuite d'eau » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Sécher les sondes ; attendre « Sol sec ».

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-temperature"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Capteur de température et humidité** (`temperature`)  
Fiche `zigbee` version 1 — empreinte `d905bbfb3e722556`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement (mesure en °C, seuils de préalarme 30 °C et d'alarme 38 °C pour la recette)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Chauffer le capteur (sèche-cheveux à 20 cm) jusqu'à dépasser le seuil d'alarme réglé (38 °C). Relever en parallèle le thermo-hygromètre étalonné. Noter l'heure exacte du geste.

**Résultat attendu** : La valeur affichée suit la température (écart avec le thermo-hygromètre : voir l'étape de justesse) ; préalarme à 30 °C puis alarme à 38 °C. L'incident porte le bon nom, la bonne zone et le motif « Température excessive » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Laisser refroidir le capteur à l'air ambiant jusqu'à repasser sous 30 °C.

**Résultat attendu** : L'état revient à Normal en moins de 900 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Justesse de la mesure `justesse-temperature` — OBLIGATOIRE

**À faire** : À température stable, comparer la valeur affichée dans le PSIM à celle du thermo-hygromètre étalonné, à trois niveaux (ambiante, environ 30 °C, environ 38 °C). Noter le plus grand écart.

**Résultat attendu** : Écart maximal inférieur ou égal à 1,0 °C.

**Mesure** `ecart_temperature_c` — Plus grand écart avec la référence : au plus 1 °C. Valeur relevée : ________ °C

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 17. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 18. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 15 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-fumee"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Détecteur de fumée Zigbee (non certifié EN 54)** (`fumee`)  
Fiche `zigbee` version 1 — empreinte `380d70a834bc2a08`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Incendie).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Utiliser le bouton test du détecteur, puis une bombe de fumée d'essai agréée sous le capteur. Noter laquelle des deux déclenche. Rappel : détecteur grand public, complémentaire d'une détection certifiée. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme incendie s'ouvre (sirène locale éventuelle indépendante du PSIM). L'incident porte le bon nom, la bonne zone et le motif « Alarme » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Aérer ; attendre l'arrêt de la sirène locale et le retour à Normal.

**Résultat attendu** : L'état revient à Normal en moins de 300 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-gaz"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Détecteur de gaz** (`gaz`)  
Fiche `zigbee` version 1 — empreinte `88f4c31eee3d4040`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Faire le test du fabricant (bouton test) puis, en local ventilé et avec les précautions d'usage, un gaz d'essai agréé (briquet non allumé, 1 s) à 5 cm du capteur. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Gaz détecté » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Gaz détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Aérer le local ; attendre le retour du capteur (peut demander plusieurs minutes) puis « Retour au calme ».

**Résultat attendu** : L'état revient à Normal en moins de 600 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-co"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Détecteur de monoxyde de carbone** (`co`)  
Fiche `zigbee` version 1 — empreinte `ac3d3e82b3a3503e`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Bouton test du fabricant, puis gaz d'essai CO agréé si disponible. Ne jamais produire de CO par combustion. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Monoxyde de carbone détecté » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Monoxyde de carbone détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Aérer ; attendre le retour du capteur puis « Retour au calme ».

**Résultat attendu** : L'état revient à Normal en moins de 600 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-vibration"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Capteur de vibration / choc** (`vibration`)  
Fiche `zigbee` version 1 — empreinte `eccc273f6abfaf2b`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Intrusion).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Taper trois coups secs sur le support du capteur, puis secouer le capteur 3 s. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Vibration détectée » s'ouvre (zone armée). L'incident porte le bon nom, la bonne zone et le motif « Vibration détectée » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Poser le capteur immobile. Le capteur peut ne jamais renvoyer « fin de vibration » : le PSIM garde l'alarme jusqu'à l'acquittement, comportement voulu à constater et noter.

**Résultat attendu** : L'état revient à Normal en moins de 120 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-panique"></a>

## Fiche de recette : Capteurs Zigbee (module « zigbee » de la passerelle, via Zigbee2MQTT)

**Profil : Bouton d'urgence** (`panique`)  
Fiche `zigbee` version 1 — empreinte `5eaf8a5a37de9cf0`  
Référence : gateway/docs/zigbee.md ; docs/PASSERELLE.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de capteur Zigbee (mouvement, ouverture, fuite, température, fumée, gaz, CO, vibration, bouton d'urgence) lu par la passerelle GAMR.

> **Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec `npm run qualify -- record`.

### Champs à remplir

| Champ | Valeur |
|---|---|
| Numéro(s) de série | |
| Version du micrologiciel (firmware) | |
| Version du PSIM testée | |
| Version de la passerelle testée (si utilisée) | |
| Testeur (nom) | |
| Date de l'essai | |
| Matériel réel (oui / non) | |
| Température et humidité du local d'essai | |

### Matériel nécessaire

- 2 exemplaires du capteur à qualifier (un pour l'essai, un pour la répétabilité), piles neuves du type prévu par le fabricant
- Clé USB Zigbee (Sonoff ZBDongle-E ou -P, ou équivalent) et son broker Mosquitto, Zigbee2MQTT en marche avec `last_seen: ISO_8601`
- Poste de recette : PSIM hors production (dossier de données séparé) et Passerelle GAMR avec le module zigbee configuré
- Chronomètre ou horloge synchronisée (NTP), multimètre (tension de pile), thermo-hygromètre étalonné
- Pour le sabotage et la fumée : outils d'ouverture du boîtier ; bombe de fumée d'essai ou aérosol de test agréé (détecteur de fumée)
- Enceinte à 35 °C / 90 % HR, ou accès à un local chaud et humide (étape « conditions tropicales »)

### Montage du banc d'essai

1. Poser la clé Zigbee sur une rallonge USB d'1 m, loin des ports USB 3 et du Wi-Fi ; démarrer Mosquitto puis Zigbee2MQTT.
2. Dans la configuration du module zigbee de la passerelle, déclarer le capteur (`kind` adapté, identifiant BANC-01), avec `staleAfterS` à 300 et `heartbeatEveryS` à 60 pour la recette.
3. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil), régler sa supervision à 180 s, lier une caméra de démonstration si possible.
4. Ajouter un destinataire de test de niveau 1 et un de niveau 2 (messagerie jetable) pour constater les notifications.
5. Mettre le capteur à 1 m de la clé, le laisser s'appairer (Permit join), le renommer, noter ses champs dans l'onglet State de Zigbee2MQTT.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Personnes).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Appairer le capteur dans Zigbee2MQTT (gateway/docs/zigbee.md, section 2), le déclarer dans le module et dans le PSIM, vérifier dans l'onglet State les champs publiés. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Appuyer sur le bouton d'urgence (un appui bref, puis un appui long). Vérifier dans Zigbee2MQTT que le capteur publie `action: emergency` ou `panic`. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme de panique s'ouvre même zone désarmée. L'incident porte le bon nom, la bonne zone et le motif « Alarme de panique » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Acquitter l'incident dans le PSIM, puis envoyer « Alarme réarmée » (le bouton ne publie pas de retour : le noter).

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Portée radio `portee` — facultative

**À faire** : Éloigner le capteur de la clé USB par paliers (5, 10, 15 m, avec une cloison) ; à chaque palier déclencher 5 fois et noter combien d'événements arrivent. Relever la qualité de lien (`linkquality`) dans Zigbee2MQTT.

**Résultat attendu** : 100 % des événements reçus jusqu'à 10 m avec une cloison. Noter la distance au-delà de laquelle des pertes apparaissent : elle limite la pose.

**Mesure** `portee_m` — Distance sans perte (avec une cloison) : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Arrêter Zigbee2MQTT (ou retirer la clé USB) pendant 10 minutes. Noter que le module journalise « pont hors ligne » sans rien envoyer au PSIM. Noter l'heure.

**Résultat attendu** : En moins de 600 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Redémarrer Zigbee2MQTT (ou remettre la clé). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, Zigbee2MQTT restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 180 s (environ 3 fois la période des signes de vie de la passerelle) avec `staleAfterS` à 300 s (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 540 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 540 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (`last_seen`, « reçu avec N minutes de retard »), un seul incident est ouvert, rejouer le même message ne crée aucun doublon, l'état final est exact. Noter si `last_seen` était bien activé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 16. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 17. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les champs réellement publiés par le capteur (onglet State de Zigbee2MQTT) correspondent à ceux que le module lit ; sinon l'écart est noté dans les remarques et `overrides` n'existe pas pour Zigbee : le module doit être corrigé avant de qualifier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur de sécurité qui ne publie pas son retour ou son défaut batterie sans que ce comportement soit documenté dans le dossier du modèle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


