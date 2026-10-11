<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`capteur-porte`](#profil-capteur-porte) | Contact de porte (Dragino LDS03A, Milesight WS301) | 17 sur 19 |
| [`capteur-fuite`](#profil-capteur-fuite) | Détecteur de fuite d'eau (Dragino LWL03A) | 17 sur 19 |
| [`capteur-niveau`](#profil-capteur-niveau) | Niveau de cuve par ultrason (Dragino LDDS75 / LDDS45) | 17 sur 19 |
| [`capteur-temperature`](#profil-capteur-temperature) | Température et humidité (Dragino LHT65, Milesight famille EM300-TH) | 17 sur 19 |
| [`capteur-mouvement`](#profil-capteur-mouvement) | Mouvement PIR (Milesight WS202) | 17 sur 19 |
| [`bouton`](#profil-bouton) | Bouton panique (Milesight WS101, bouton SOS générique) | 17 sur 19 |
| [`passerelle-radio`](#profil-passerelle-radio) | Passerelle radio LoRa (concentrateur) | 7 sur 8 |

<a id="profil-capteur-porte"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Contact de porte (Dragino LDS03A, Milesight WS301)** (`capteur-porte`)  
Fiche `lorawan` version 1 — empreinte `50eb51392f0ee8ec`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

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

##### 3. Jonction OTAA et champs du codec `jonction` — OBLIGATOIRE

**À faire** : Mettre le capteur sous tension, attendre la jonction (join) et la première trame ; ouvrir l'onglet Events de ChirpStack et relever les noms réels des champs de `object`. Les comparer au tableau de gateway/docs/lorawan.md (section 5).

**Résultat attendu** : Le champ `object` est rempli et ses noms correspondent au profil du module. Tout écart est noté ; il se corrige par `overrides` AVANT de poursuivre, et l'écart figure au dossier du modèle.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Attendre la jonction puis la première trame dans ChirpStack (Events), relever les noms de champs réels de `object`. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Ouvrir la porte (écarter l'aimant). Une trame part immédiatement à l'ouverture. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme d'intrusion s'ouvre (zone armée). L'incident porte le bon nom, la bonne zone et le motif « Intrusion » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer la porte ; attendre « Porte fermée ».

**Résultat attendu** : L'état revient à Normal en moins de 120 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 60 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter le capteur avec des piles déchargées (tension juste sous le seuil du profil : 2,4 V pour les Dragino LDS03A et LWL03A, 3,0 V pour le LDDS75, 2,6 V pour le LHT65) et attendre la trame suivante. Noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher le capteur. La plupart des capteurs LoRa n'ont pas d'autoprotection ni de profil prévu pour elle : le noter ; marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio (ou arrêter ChirpStack) pendant 40 minutes. Les capteurs continuent d'émettre dans le vide. Noter l'heure.

**Résultat attendu** : En moins de 1800 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Remettre l'alimentation de la passerelle radio ou relancer ChirpStack. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 900 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, passerelle radio et ChirpStack restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 1 800 s pour un capteur qui émet toutes les 10 minutes (3 fois la période) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 2000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 2000 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Trame rejouée (même compteur) `rejeu-fcnt` — OBLIGATOIRE

**À faire** : Republier sur le broker de ChirpStack une trame `event/up` déjà traitée (même `fCnt`) : `mosquitto_pub` avec le contenu relevé avec `mosquitto_sub`.

**Résultat attendu** : Aucun nouvel incident ni doublon : le module ignore la trame déjà vue.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, déclencher le capteur puis le remettre au repos. Redémarrer le PSIM. Faire ensuite rejouer une trame déjà vue (même `fCnt`) en republiant le message sur le broker ChirpStack.

**Résultat attendu** : Après le rétablissement : les trames suivantes remettent l'état à jour. Rappel : ChirpStack ne rejoue pas l'historique MQTT ; un événement unique perdu pendant la coupure du lien vers le PSIM est rattrapé par la file de la passerelle GAMR (heure réelle, un seul incident, aucun doublon si le même `fCnt` est rejoué).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 18. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 19. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 17 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-capteur-fuite"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Détecteur de fuite d'eau (Dragino LWL03A)** (`capteur-fuite`)  
Fiche `lorawan` version 1 — empreinte `55d2a8e45dca7106`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

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

##### 3. Jonction OTAA et champs du codec `jonction` — OBLIGATOIRE

**À faire** : Mettre le capteur sous tension, attendre la jonction (join) et la première trame ; ouvrir l'onglet Events de ChirpStack et relever les noms réels des champs de `object`. Les comparer au tableau de gateway/docs/lorawan.md (section 5).

**Résultat attendu** : Le champ `object` est rempli et ses noms correspondent au profil du module. Tout écart est noté ; il se corrige par `overrides` AVANT de poursuivre, et l'écart figure au dossier du modèle.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Attendre la jonction puis la première trame dans ChirpStack (Events), relever les noms de champs réels de `object`. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Plonger la sonde dans 1 cm d'eau. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Fuite d'eau » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Fuite d'eau » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Sécher la sonde ; attendre « Sol sec ».

**Résultat attendu** : L'état revient à Normal en moins de 120 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 60 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter le capteur avec des piles déchargées (tension juste sous le seuil du profil : 2,4 V pour les Dragino LDS03A et LWL03A, 3,0 V pour le LDDS75, 2,6 V pour le LHT65) et attendre la trame suivante. Noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher le capteur. La plupart des capteurs LoRa n'ont pas d'autoprotection ni de profil prévu pour elle : le noter ; marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio (ou arrêter ChirpStack) pendant 40 minutes. Les capteurs continuent d'émettre dans le vide. Noter l'heure.

**Résultat attendu** : En moins de 1800 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Remettre l'alimentation de la passerelle radio ou relancer ChirpStack. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 900 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, passerelle radio et ChirpStack restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 1 800 s pour un capteur qui émet toutes les 10 minutes (3 fois la période) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 2000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 2000 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Trame rejouée (même compteur) `rejeu-fcnt` — OBLIGATOIRE

**À faire** : Republier sur le broker de ChirpStack une trame `event/up` déjà traitée (même `fCnt`) : `mosquitto_pub` avec le contenu relevé avec `mosquitto_sub`.

**Résultat attendu** : Aucun nouvel incident ni doublon : le module ignore la trame déjà vue.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, déclencher le capteur puis le remettre au repos. Redémarrer le PSIM. Faire ensuite rejouer une trame déjà vue (même `fCnt`) en republiant le message sur le broker ChirpStack.

**Résultat attendu** : Après le rétablissement : les trames suivantes remettent l'état à jour. Rappel : ChirpStack ne rejoue pas l'historique MQTT ; un événement unique perdu pendant la coupure du lien vers le PSIM est rattrapé par la file de la passerelle GAMR (heure réelle, un seul incident, aucun doublon si le même `fCnt` est rejoué).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 18. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 19. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 17 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-capteur-niveau"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Niveau de cuve par ultrason (Dragino LDDS75 / LDDS45)** (`capteur-niveau`)  
Fiche `lorawan` version 1 — empreinte `3745133631ffe668`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement (niveau en %, seuil d'alarme bas)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Jonction OTAA et champs du codec `jonction` — OBLIGATOIRE

**À faire** : Mettre le capteur sous tension, attendre la jonction (join) et la première trame ; ouvrir l'onglet Events de ChirpStack et relever les noms réels des champs de `object`. Les comparer au tableau de gateway/docs/lorawan.md (section 5).

**Résultat attendu** : Le champ `object` est rempli et ses noms correspondent au profil du module. Tout écart est noté ; il se corrige par `overrides` AVANT de poursuivre, et l'écart figure au dossier du modèle.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Attendre la jonction puis la première trame dans ChirpStack (Events), relever les noms de champs réels de `object`. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Vérifier la hauteur de cuve (`emptyAt`) avec un mètre. Faire varier le niveau réel ou placer une plaque à des distances connues (20 %, 50 %, 80 %) devant le capteur ; comparer les niveaux affichés. Noter l'heure exacte du geste.

**Résultat attendu** : Le niveau affiché suit la distance (écart inférieur à 5 points) ; l'alarme de seuil bas s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Niveau bas » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Remettre le niveau à 80 %.

**Résultat attendu** : L'état revient à Normal en moins de 120 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 60 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter le capteur avec des piles déchargées (tension juste sous le seuil du profil : 2,4 V pour les Dragino LDS03A et LWL03A, 3,0 V pour le LDDS75, 2,6 V pour le LHT65) et attendre la trame suivante. Noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher le capteur. La plupart des capteurs LoRa n'ont pas d'autoprotection ni de profil prévu pour elle : le noter ; marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio (ou arrêter ChirpStack) pendant 40 minutes. Les capteurs continuent d'émettre dans le vide. Noter l'heure.

**Résultat attendu** : En moins de 1800 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Remettre l'alimentation de la passerelle radio ou relancer ChirpStack. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 900 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, passerelle radio et ChirpStack restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 1 800 s pour un capteur qui émet toutes les 10 minutes (3 fois la période) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 2000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 2000 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Trame rejouée (même compteur) `rejeu-fcnt` — OBLIGATOIRE

**À faire** : Republier sur le broker de ChirpStack une trame `event/up` déjà traitée (même `fCnt`) : `mosquitto_pub` avec le contenu relevé avec `mosquitto_sub`.

**Résultat attendu** : Aucun nouvel incident ni doublon : le module ignore la trame déjà vue.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, déclencher le capteur puis le remettre au repos. Redémarrer le PSIM. Faire ensuite rejouer une trame déjà vue (même `fCnt`) en republiant le message sur le broker ChirpStack.

**Résultat attendu** : Après le rétablissement : les trames suivantes remettent l'état à jour. Rappel : ChirpStack ne rejoue pas l'historique MQTT ; un événement unique perdu pendant la coupure du lien vers le PSIM est rattrapé par la file de la passerelle GAMR (heure réelle, un seul incident, aucun doublon si le même `fCnt` est rejoué).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 18. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 19. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 17 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-capteur-temperature"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Température et humidité (Dragino LHT65, Milesight famille EM300-TH)** (`capteur-temperature`)  
Fiche `lorawan` version 1 — empreinte `356dc8e6a7bdc5b2`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement (°C, préalarme 30, alarme 38 pour la recette)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Jonction OTAA et champs du codec `jonction` — OBLIGATOIRE

**À faire** : Mettre le capteur sous tension, attendre la jonction (join) et la première trame ; ouvrir l'onglet Events de ChirpStack et relever les noms réels des champs de `object`. Les comparer au tableau de gateway/docs/lorawan.md (section 5).

**Résultat attendu** : Le champ `object` est rempli et ses noms correspondent au profil du module. Tout écart est noté ; il se corrige par `overrides` AVANT de poursuivre, et l'écart figure au dossier du modèle.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Attendre la jonction puis la première trame dans ChirpStack (Events), relever les noms de champs réels de `object`. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Chauffer le capteur au sèche-cheveux jusqu'à dépasser 38 °C ; relever le thermo-hygromètre étalonné en parallèle. Noter l'heure exacte du geste.

**Résultat attendu** : La valeur suit la température à 1 °C près ; alarme à 38 °C. L'incident porte le bon nom, la bonne zone et le motif « Température excessive » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Laisser refroidir sous 30 °C.

**Résultat attendu** : L'état revient à Normal en moins de 1800 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 60 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter le capteur avec des piles déchargées (tension juste sous le seuil du profil : 2,4 V pour les Dragino LDS03A et LWL03A, 3,0 V pour le LDDS75, 2,6 V pour le LHT65) et attendre la trame suivante. Noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher le capteur. La plupart des capteurs LoRa n'ont pas d'autoprotection ni de profil prévu pour elle : le noter ; marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio (ou arrêter ChirpStack) pendant 40 minutes. Les capteurs continuent d'émettre dans le vide. Noter l'heure.

**Résultat attendu** : En moins de 1800 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Remettre l'alimentation de la passerelle radio ou relancer ChirpStack. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 900 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, passerelle radio et ChirpStack restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 1 800 s pour un capteur qui émet toutes les 10 minutes (3 fois la période) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 2000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 2000 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Trame rejouée (même compteur) `rejeu-fcnt` — OBLIGATOIRE

**À faire** : Republier sur le broker de ChirpStack une trame `event/up` déjà traitée (même `fCnt`) : `mosquitto_pub` avec le contenu relevé avec `mosquitto_sub`.

**Résultat attendu** : Aucun nouvel incident ni doublon : le module ignore la trame déjà vue.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, déclencher le capteur puis le remettre au repos. Redémarrer le PSIM. Faire ensuite rejouer une trame déjà vue (même `fCnt`) en republiant le message sur le broker ChirpStack.

**Résultat attendu** : Après le rétablissement : les trames suivantes remettent l'état à jour. Rappel : ChirpStack ne rejoue pas l'historique MQTT ; un événement unique perdu pendant la coupure du lien vers le PSIM est rattrapé par la file de la passerelle GAMR (heure réelle, un seul incident, aucun doublon si le même `fCnt` est rejoué).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 18. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 19. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 17 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-capteur-mouvement"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Mouvement PIR (Milesight WS202)** (`capteur-mouvement`)  
Fiche `lorawan` version 1 — empreinte `827c987443c93674`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

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

##### 3. Jonction OTAA et champs du codec `jonction` — OBLIGATOIRE

**À faire** : Mettre le capteur sous tension, attendre la jonction (join) et la première trame ; ouvrir l'onglet Events de ChirpStack et relever les noms réels des champs de `object`. Les comparer au tableau de gateway/docs/lorawan.md (section 5).

**Résultat attendu** : Le champ `object` est rempli et ses noms correspondent au profil du module. Tout écart est noté ; il se corrige par `overrides` AVANT de poursuivre, et l'écart figure au dossier du modèle.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Attendre la jonction puis la première trame dans ChirpStack (Events), relever les noms de champs réels de `object`. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Passer devant le capteur à 1 m, 3 m, 5 m. Noter l'heure exacte du geste.

**Résultat attendu** : Un incident s'ouvre à chaque passage (zone armée). L'incident porte le bon nom, la bonne zone et le motif « Mouvement détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Rester immobile hors du champ jusqu'au retour au repos.

**Résultat attendu** : L'état revient à Normal en moins de 300 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 60 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter le capteur avec des piles déchargées (tension juste sous le seuil du profil : 2,4 V pour les Dragino LDS03A et LWL03A, 3,0 V pour le LDDS75, 2,6 V pour le LHT65) et attendre la trame suivante. Noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher le capteur. La plupart des capteurs LoRa n'ont pas d'autoprotection ni de profil prévu pour elle : le noter ; marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio (ou arrêter ChirpStack) pendant 40 minutes. Les capteurs continuent d'émettre dans le vide. Noter l'heure.

**Résultat attendu** : En moins de 1800 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Remettre l'alimentation de la passerelle radio ou relancer ChirpStack. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 900 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, passerelle radio et ChirpStack restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 1 800 s pour un capteur qui émet toutes les 10 minutes (3 fois la période) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 2000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 2000 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Trame rejouée (même compteur) `rejeu-fcnt` — OBLIGATOIRE

**À faire** : Republier sur le broker de ChirpStack une trame `event/up` déjà traitée (même `fCnt`) : `mosquitto_pub` avec le contenu relevé avec `mosquitto_sub`.

**Résultat attendu** : Aucun nouvel incident ni doublon : le module ignore la trame déjà vue.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, déclencher le capteur puis le remettre au repos. Redémarrer le PSIM. Faire ensuite rejouer une trame déjà vue (même `fCnt`) en republiant le message sur le broker ChirpStack.

**Résultat attendu** : Après le rétablissement : les trames suivantes remettent l'état à jour. Rappel : ChirpStack ne rejoue pas l'historique MQTT ; un événement unique perdu pendant la coupure du lien vers le PSIM est rattrapé par la file de la passerelle GAMR (heure réelle, un seul incident, aucun doublon si le même `fCnt` est rejoué).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 18. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 19. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 17 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-bouton"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Bouton panique (Milesight WS101, bouton SOS générique)** (`bouton`)  
Fiche `lorawan` version 1 — empreinte `4e06b60b6c04bd30`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

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

##### 3. Jonction OTAA et champs du codec `jonction` — OBLIGATOIRE

**À faire** : Mettre le capteur sous tension, attendre la jonction (join) et la première trame ; ouvrir l'onglet Events de ChirpStack et relever les noms réels des champs de `object`. Les comparer au tableau de gateway/docs/lorawan.md (section 5).

**Résultat attendu** : Le champ `object` est rempli et ses noms correspondent au profil du module. Tout écart est noté ; il se corrige par `overrides` AVANT de poursuivre, et l'écart figure au dossier du modèle.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Attendre la jonction puis la première trame dans ChirpStack (Events), relever les noms de champs réels de `object`. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Appui court, appui double, puis appui long : seul l'appui prévu par le profil (long pour le WS101) déclenche. Vérifier les trois appuis. Noter l'heure exacte du geste.

**Résultat attendu** : Seul l'appui prévu ouvre une alarme de panique, même zone désarmée. L'incident porte le bon nom, la bonne zone et le motif « Alarme de panique » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Acquitter l'incident ; envoyer « Alarme réarmée ».

**Résultat attendu** : L'état revient à Normal en moins de 120 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 60 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter le capteur avec des piles déchargées (tension juste sous le seuil du profil : 2,4 V pour les Dragino LDS03A et LWL03A, 3,0 V pour le LDDS75, 2,6 V pour le LHT65) et attendre la trame suivante. Noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher le capteur. La plupart des capteurs LoRa n'ont pas d'autoprotection ni de profil prévu pour elle : le noter ; marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio (ou arrêter ChirpStack) pendant 40 minutes. Les capteurs continuent d'émettre dans le vide. Noter l'heure.

**Résultat attendu** : En moins de 1800 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 1800 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Remettre l'alimentation de la passerelle radio ou relancer ChirpStack. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 900 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 900 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur, passerelle radio et ChirpStack restant en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 1 800 s pour un capteur qui émet toutes les 10 minutes (3 fois la période) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 2000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 2000 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Trame rejouée (même compteur) `rejeu-fcnt` — OBLIGATOIRE

**À faire** : Republier sur le broker de ChirpStack une trame `event/up` déjà traitée (même `fCnt`) : `mosquitto_pub` avec le contenu relevé avec `mosquitto_sub`.

**Résultat attendu** : Aucun nouvel incident ni doublon : le module ignore la trame déjà vue.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, déclencher le capteur puis le remettre au repos. Redémarrer le PSIM. Faire ensuite rejouer une trame déjà vue (même `fCnt`) en republiant le message sur le broker ChirpStack.

**Résultat attendu** : Après le rétablissement : les trames suivantes remettent l'état à jour. Rappel : ChirpStack ne rejoue pas l'historique MQTT ; un événement unique perdu pendant la coupure du lien vers le PSIM est rattrapé par la file de la passerelle GAMR (heure réelle, un seul incident, aucun doublon si le même `fCnt` est rejoué).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 18. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 19. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 17 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-passerelle-radio"></a>

## Fiche de recette : Capteurs LoRaWAN (module « lorawan » de la passerelle, via ChirpStack)

**Profil : Passerelle radio LoRa (concentrateur)** (`passerelle-radio`)  
Fiche `lorawan` version 1 — empreinte `3c0f8b4261fa8351`  
Référence : gateway/docs/lorawan.md ; docs/PASSERELLE.md

> Qualification d'un modèle de capteur LoRaWAN (Dragino, Milesight…) et de la passerelle radio : jonction, noms de champs du codec, déclenchement, batterie, silence, portée.

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

- 2 exemplaires du capteur à qualifier, piles neuves, DevEui et AppKey imprimés
- Passerelle radio LoRa (concentrateur) à la bonne bande de fréquences, ChirpStack v4 installé avec son broker MQTT
- Décodeur (codec) du fabricant collé dans le profil d'appareil ChirpStack
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module lorawan configuré
- Chronomètre, multimètre, thermo-hygromètre étalonné ; pour la portée : plan du site ou mesure de distance
- Confirmation écrite de l'ARTCI sur la bande de fréquences utilisée (voir gateway/docs/lorawan.md, section 8)

### Montage du banc d'essai

1. Installer la passerelle radio, l'ajouter dans ChirpStack ; créer le profil d'appareil (OTAA, région adaptée) avec le codec du fabricant.
2. Créer l'application et l'appareil (DevEui, AppKey) ; attendre la jonction (join) puis la première trame ; vérifier dans l'onglet Events que le champ `object` est rempli.
3. Déclarer le capteur dans le module lorawan (`kind` du profil), identifiant PSIM BANC-01, et dans le PSIM de recette ; régler la supervision à 3 fois la période d'émission du capteur.
4. Ajouter des destinataires de test (niveaux 1 et 2).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc-radio` — OBLIGATOIRE

**À faire** : Monter le banc : passerelle radio branchée en Ethernet, ajoutée dans ChirpStack, antenne dégagée à 2 m du sol, trois capteurs de référence déjà qualifiés ou à qualifier.

**Résultat attendu** : La passerelle radio apparaît « en ligne » dans ChirpStack et reçoit les trames des trois capteurs.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Bande de fréquences et autorisation `radio-bande` — OBLIGATOIRE

**À faire** : Relever la bande de fréquences, la puissance et la région configurées sur la passerelle radio, le profil d'appareil ChirpStack et le capteur. Obtenir (ou joindre) la confirmation écrite de l'ARTCI.

**Résultat attendu** : Région identique partout et confirmation écrite jointe au dossier. Sans elle : ne pas qualifier.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Portée radio mesurée `portee` — OBLIGATOIRE

**À faire** : Éloigner le capteur de la passerelle radio par paliers (100, 300, 500 m ou la distance du site, en visibilité puis avec obstacles). À chaque palier, déclencher 10 fois et compter les trames reçues par ChirpStack ; relever RSSI et SNR.

**Résultat attendu** : Au moins 95 % des trames reçues à la distance prévue pour le site (500 m minimum en visibilité) ; RSSI et SNR notés pour le dossier du site.

**Mesure** `portee_m` — Distance avec au moins 95 % de trames reçues : au moins 500 m. Valeur relevée : ________ m

**Mesure** `trames_recues_pct` — Trames reçues à cette distance : au moins 95 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Couverture mesurée avec trois capteurs `radio-couverture` — OBLIGATOIRE

**À faire** : Placer trois capteurs à trois distances et orientations ; sur 1 heure, compter les trames reçues par rapport aux trames émises.

**Résultat attendu** : Pertes de trames inférieures à 5 % sur chaque capteur.

**Mesure** `pertes_trames_pct` — Pertes de trames (pire capteur) : au plus 5 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 6. Reprise après coupure de la passerelle radio `radio-reprise` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la passerelle radio 10 minutes, puis la rétablir sans autre intervention.

**Résultat attendu** : La passerelle radio revient « en ligne » seule et les trames reprennent en moins de 10 minutes ; pendant la coupure, les capteurs passent « Hors ligne » dans le PSIM après leur délai.

**Mesure** `reprise_radio_min` — Délai de reprise : au plus 10 min. Valeur relevée : ________ min

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 7. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 8. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 7 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le noms de champs réels du codec sont notés au dossier du modèle ; les `overrides` éventuels sont recopiés dans la fiche de configuration du site.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur dont la trame d'alarme est perdue à la portée prévue sans qu'une trame périodique la rattrape.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


