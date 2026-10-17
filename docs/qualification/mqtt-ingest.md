<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Équipement MQTT / HTTP direct (raccordement existant) et équipements à développer

> Qualification d'un équipement qui parle directement au PSIM (message JSON MQTT sur psim/detectors/<id>/state, ou POST /api/ingest/<id>), ou d'une intégration à développer (contrôle d'accès, clavier, sirène, ronde NFC, balise).

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`capteur`](#profil-capteur) | Capteur ou lecteur (état, événement ou mesure) | 15 sur 17 |
| [`actionneur`](#profil-actionneur) | Actionneur (sirène, relais) : dépend de la fonction de commande, en cours de développement | 7 sur 8 |

<a id="profil-capteur"></a>

## Fiche de recette : Équipement MQTT / HTTP direct (raccordement existant) et équipements à développer

**Profil : Capteur ou lecteur (état, événement ou mesure)** (`capteur`)  
Fiche `mqtt-ingest` version 1 — empreinte `603c59383bb5f4fc`  
Référence : docs/MISE-EN-SERVICE.md (section 4) ; README.md (« Autres sources d'alarme »)

> Qualification d'un équipement qui parle directement au PSIM (message JSON MQTT sur psim/detectors/<id>/state, ou POST /api/ingest/<id>), ou d'une intégration à développer (contrôle d'accès, clavier, sirène, ronde NFC, balise).

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

- L'équipement à qualifier avec sa passerelle ou son pont constructeur s'il en a un
- Client MQTT de contrôle (`mosquitto_sub`) pour voir les messages réellement émis
- Poste de recette : PSIM hors production, `npm run commission -- watch` pour voir ce que le PSIM comprend
- Chronomètre, multimètre, thermo-hygromètre étalonné

### Montage du banc d'essai

1. Déclarer le détecteur BANC-01 dans le PSIM de recette avec l'identifiant exact que l'équipement publiera.
2. Donner à l'équipement (ou à son pont) un compte MQTT dédié limité à ses identifiants (`PSIM_MQTT_GATEWAYS`), ou un jeton d'ingestion.
3. Lancer `npm run commission -- watch --minutes 30` : il montre, message par message, ce que le PSIM en comprend (OK, INCONNU, ILLISIBLE).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Selon l'équipement).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Mettre l'équipement sous tension ; il publie son premier message sur son topic. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Format des messages `format-messages` — OBLIGATOIRE

**À faire** : Avec `npm run commission -- watch`, provoquer chaque type de message de l'équipement (état, événement nommé, mesure, signe de vie). Relever chaque affichage de l'outil.

**Résultat attendu** : Tous les messages sont « OK » ; aucun « ILLISIBLE » ni « INCONNU ». Les événements utilisés figurent dans la liste du PSIM.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Provoquer l'événement réel avec l'équipement (bouton test ou provocation maîtrisée). Noter l'heure exacte du geste.

**Résultat attendu** : Un incident s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Alarme » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Remettre l'équipement au repos (fin du fait déclencheur).

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Ouvrir le boîtier ou arracher l'équipement de son support. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper la liaison réseau de l'équipement (ou de son pont) 5 minutes. Noter l'heure.

**Résultat attendu** : En moins de 180 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir la liaison. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Couper l'alimentation de l'équipement en laissant le reste en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 3 fois la période de l'équipement (au moins 2 fois, plus une marge) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 300 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette (ou couper la liaison de la passerelle vers lui) pendant 2 minutes. Pendant la coupure, déclencher l'équipement puis le remettre au repos. Rétablir ensuite la liaison.

**Résultat attendu** : Après le rétablissement : l'événement arrive daté de son heure réelle (« reçu avec N minutes de retard »), un seul incident est ouvert, renvoyer le même message ne crée aucun doublon, l'état final est exact.

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
- Les 15 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement qui publie un format que le PSIM ne comprend pas sans qu'un pont de traduction ait été écrit et essayé.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-actionneur"></a>

## Fiche de recette : Équipement MQTT / HTTP direct (raccordement existant) et équipements à développer

**Profil : Actionneur (sirène, relais) : dépend de la fonction de commande, en cours de développement** (`actionneur`)  
Fiche `mqtt-ingest` version 1 — empreinte `c7910cd3d42af378`  
Référence : docs/MISE-EN-SERVICE.md (section 4) ; README.md (« Autres sources d'alarme »)

> Qualification d'un équipement qui parle directement au PSIM (message JSON MQTT sur psim/detectors/<id>/state, ou POST /api/ingest/<id>), ou d'une intégration à développer (contrôle d'accès, clavier, sirène, ronde NFC, balise).

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

- L'équipement à qualifier avec sa passerelle ou son pont constructeur s'il en a un
- Client MQTT de contrôle (`mosquitto_sub`) pour voir les messages réellement émis
- Poste de recette : PSIM hors production, `npm run commission -- watch` pour voir ce que le PSIM comprend
- Chronomètre, multimètre, thermo-hygromètre étalonné

### Montage du banc d'essai

1. Déclarer le détecteur BANC-01 dans le PSIM de recette avec l'identifiant exact que l'équipement publiera.
2. Donner à l'équipement (ou à son pont) un compte MQTT dédié limité à ses identifiants (`PSIM_MQTT_GATEWAYS`), ou un jeton d'ingestion.
3. Lancer `npm run commission -- watch --minutes 30` : il montre, message par message, ce que le PSIM en comprend (OK, INCONNU, ILLISIBLE).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : selon le profil).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. La commande produit son effet `cmd-effet` — OBLIGATOIRE

**À faire** : Envoyer la commande depuis le PSIM (par exemple faire sonner la sirène 5 s). Chronométrer.

**Résultat attendu** : L'effet physique est constaté en moins de 5 s et s'arrête à l'ordre ou à la fin de la durée.

**Mesure** `delai_commande_s` — Délai commande → effet : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Retour d'état de l'actionneur `cmd-retour` — OBLIGATOIRE

**À faire** : Après la commande, lire l'état renvoyé par l'équipement dans le PSIM.

**Résultat attendu** : L'état affiché est l'état réel de l'équipement (jamais l'état seulement demandé).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 5. Commande impossible `cmd-echec` — OBLIGATOIRE

**À faire** : Couper la liaison de l'équipement, envoyer la commande.

**Résultat attendu** : L'échec est signalé à l'opérateur dans les secondes qui suivent ; jamais un « ok » silencieux.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Droits sur la commande `cmd-droits` — OBLIGATOIRE

**À faire** : Envoyer la commande avec un compte qui n'a pas le droit (opérateur sans autorisation), puis avec un compte autorisé.

**Résultat attendu** : Refus clair pour le premier, exécution et trace au journal (qui, quand) pour le second.

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

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement qui publie un format que le PSIM ne comprend pas sans qu'un pont de traduction ait été écrit et essayé.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


