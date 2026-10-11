<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`fumee`](#profil-fumee) | Détecteur de fumée WiFi (catégorie Tuya ywbj) | 15 sur 17 |
| [`contact`](#profil-contact) | Contact de porte ou fenêtre (catégorie mcs) | 15 sur 18 |
| [`pir`](#profil-pir) | Détecteur de mouvement (catégorie pir) | 15 sur 18 |
| [`fuite`](#profil-fuite) | Détecteur de fuite d'eau (catégorie sj) | 15 sur 18 |
| [`temperature`](#profil-temperature) | Température et humidité (catégorie wsdcg) | 15 sur 18 |
| [`gaz`](#profil-gaz) | Détecteur de gaz (catégorie rqbj ou jwbj) | 15 sur 18 |
| [`co`](#profil-co) | Détecteur de monoxyde de carbone (catégorie cobj) | 15 sur 18 |
| [`sos`](#profil-sos) | Bouton SOS (catégorie sos) | 15 sur 18 |

<a id="profil-fumee"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Détecteur de fumée WiFi (catégorie Tuya ywbj)** (`fumee`)  
Fiche `tuya` version 1 — empreinte `32727fbd68d10d7c`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Appuyer 2 s sur le bouton TEST du détecteur (sirène et alarme), puis, dans un second essai, la bombe de fumée d'essai sous le capteur. La sirène sonne seule, sur place, indépendamment du PSIM. Noter l'heure exacte du geste.

**Résultat attendu** : Un incident incendie s'ouvre dans la minute qui suit la remontée au cloud. L'incident porte le bon nom, la bonne zone et le motif « Alarme » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Arrêter la sirène (bouton), aérer ; attendre « Normal ».

**Résultat attendu** : L'état revient à Normal en moins de 180 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Remplacer la pile par une pile 9 V déchargée (environ 6 V) ou attendre le message de pile faible du détecteur ; relever `battery_state` / `battery_percentage` avec « Tester la lecture » et la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 13. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-contact"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Contact de porte ou fenêtre (catégorie mcs)** (`contact`)  
Fiche `tuya` version 1 — empreinte `e94c6684cd94476f`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Ouvrir la porte et la laisser ouverte plus de 90 s. Rappel : une ouverture plus courte que l'intervalle de lecture peut passer inaperçue (cloud lu toutes les 60 s). Noter l'heure exacte du geste.

**Résultat attendu** : Un incident d'intrusion s'ouvre (zone armée). L'incident porte le bon nom, la bonne zone et le motif « Intrusion » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer la porte ; attendre « Porte fermée ».

**Résultat attendu** : L'état revient à Normal en moins de 180 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-pir"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Détecteur de mouvement (catégorie pir)** (`pir`)  
Fiche `tuya` version 1 — empreinte `3be689cc9c9639c4`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Rester dans le champ du capteur plus de 90 s (agiter la main en continu). Un mouvement d'une seconde peut passer inaperçu à cause de la lecture toutes les 60 s : le tester et le noter. Noter l'heure exacte du geste.

**Résultat attendu** : Un incident s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Mouvement détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Quitter le champ ; attendre « Retour au calme ».

**Résultat attendu** : L'état revient à Normal en moins de 300 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-fuite"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Détecteur de fuite d'eau (catégorie sj)** (`fuite`)  
Fiche `tuya` version 1 — empreinte `4b56bf2e397860e0`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

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

**Résultat attendu** : L'état revient à Normal en moins de 180 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-temperature"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Température et humidité (catégorie wsdcg)** (`temperature`)  
Fiche `tuya` version 1 — empreinte `8321f7acc3172b13`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement (°C, préalarme 30, alarme 38)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Chauffer le capteur au sèche-cheveux jusqu'à dépasser 38 °C ; relever le thermo-hygromètre étalonné. Noter l'échelle (`scale`) lue dans les spécifications de l'appareil. Noter l'heure exacte du geste.

**Résultat attendu** : La valeur suit la température à 1 °C près ; alarme à 38 °C. L'incident porte le bon nom, la bonne zone et le motif « Température excessive » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Laisser refroidir sous 30 °C.

**Résultat attendu** : L'état revient à Normal en moins de 1200 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 1200 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-gaz"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Détecteur de gaz (catégorie rqbj ou jwbj)** (`gaz`)  
Fiche `tuya` version 1 — empreinte `04d90a0aba1f2693`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Bouton test du fabricant puis gaz d'essai agréé en local ventilé. Noter si le capteur passe par un état de préchauffe (traité en défaut par le PSIM). Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Gaz détecté » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Gaz détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Aérer ; attendre « Retour au calme ».

**Résultat attendu** : L'état revient à Normal en moins de 600 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-co"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Détecteur de monoxyde de carbone (catégorie cobj)** (`co`)  
Fiche `tuya` version 1 — empreinte `5074028ab2424f00`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Bouton test du fabricant puis gaz d'essai CO agréé si disponible. Ne jamais produire de CO par combustion. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Monoxyde de carbone détecté » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Monoxyde de carbone détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Aérer ; attendre « Retour au calme ».

**Résultat attendu** : L'état revient à Normal en moins de 600 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 600 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-sos"></a>

## Fiche de recette : Capteurs WiFi Tuya / Smart Life (fumée et autres capteurs)

**Profil : Bouton SOS (catégorie sos)** (`sos`)  
Fiche `tuya` version 1 — empreinte `4e7086431d1e05d7`  
Référence : docs/TUYA.md ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de détecteur de fumée WiFi Tuya (validé) ou d'un autre capteur Tuya (contact, mouvement, fuite, température, gaz, CO, SOS), lu par le PSIM dans le cloud Tuya.

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

- 2 exemplaires du capteur Tuya à qualifier, piles neuves, appairés dans l'application Smart Life
- Compte Tuya Cloud avec un projet lié au compte Smart Life (Access ID / Secret, région correcte, services API souscrits)
- Poste de recette : PSIM hors production avec `PSIM_TUYA_*` renseignées, accès Internet, possibilité de couper Internet (câble ou pare-feu)
- Chronomètre ; multimètre ; thermo-hygromètre étalonné ; pour la fumée : bombe de fumée d'essai agréée
- Une pile déchargée du même type (9 V vers 6 V, par exemple) pour l'étape batterie faible

### Montage du banc d'essai

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID), vérifier qu'il est « En ligne ».
2. Dans le PSIM de recette, créer le détecteur BANC-01 (catégorie du profil) et coller le Device ID dans la section « Capteur WiFi Tuya ».
3. Cliquer « Tester la lecture » : relever le type reconnu et les données reçues (noms des fonctions Tuya, valeur de la pile).
4. Enregistrer la source ; vérifier que la supervision de 300 s est posée. Ajouter des destinataires de test.

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

##### 3. Lecture du cloud (« Tester la lecture ») `tuya-lecture` — OBLIGATOIRE

**À faire** : Cliquer « Tester la lecture » dans l'éditeur du détecteur. Relever : catégorie Tuya, nom des fonctions reçues, type reconnu par le PSIM. Les comparer à la liste de docs/TUYA.md.

**Résultat attendu** : Le type de capteur est reconnu (ou forcé correctement dans la liste « Type de capteur ») et les noms de fonctions sont ceux que le PSIM lit. Un nom inconnu doit être ajouté au PSIM (server/tuyasensors.ts) AVANT de continuer ; en attendant, le PSIM l'affiche en défaut, jamais Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; la première lecture du cloud arrive dans la minute. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Maintenir l'appui plus de 90 s si le capteur le permet, sinon appuyer de façon répétée pendant 90 s. Un appui bref peut passer inaperçu (lecture toutes les 60 s) : le tester et le noter. Ce capteur ne convient pas à la protection des personnes en première ligne. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme SOS s'ouvre, même zone désarmée. L'incident porte le bon nom, la bonne zone et le motif « Appel de détresse (SOS) » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Relâcher ; envoyer « Alarme réarmée » ou attendre le retour.

**Résultat attendu** : L'état revient à Normal en moins de 180 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 5 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 5 cycles sur 5 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 5 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 120 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Alimenter l'équipement avec une pile ou une batterie déchargée (tension juste sous le seuil du fabricant) ou, à défaut, laisser le niveau descendre sous le seuil du module ; noter la tension au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Si le capteur a une autoprotection (`tamper_alarm`), la déclencher (ouvrir le boîtier). Sinon marquer « na » avec cette justification.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste du PSIM de recette (débrancher le câble réseau) pendant 8 minutes, capteur inchangé. Le PSIM ne peut plus interroger le cloud. Noter l'heure.

**Résultat attendu** : En moins de 420 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'accès Internet. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Retirer la pile du capteur (ou couper le WiFi de son point d'accès), Internet du PSIM restant en marche, de sorte que Tuya déclare l'appareil hors ligne. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 300 s (supervision posée automatiquement) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 420 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 420 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 14. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès Internet du poste de recette pendant 6 minutes. Pendant la coupure, déclencher le capteur et NE PAS le remettre au repos. Rétablir Internet.

**Résultat attendu** : Pendant la coupure : le capteur passe « Hors ligne » après 5 minutes (jamais Normal). Au rétablissement : l'alarme encore active est lue et ouvre un incident en moins de 3 minutes. Limite connue à noter : une alarme terminée pendant la coupure n'est pas rejouée (le PSIM lit un niveau, pas des impulsions).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Quota du cloud Tuya `tuya-quota` — facultative

**À faire** : Dans la console Tuya, relever le nombre d'appels API consommés sur la journée d'essai et l'extrapoler au mois (60 s de lecture groupée : environ 43 000 appels par mois jusqu'à 20 appareils).

**Résultat attendu** : Consommation extrapolée inférieure au quota de l'abonnement ; date d'expiration de l'essai gratuit notée au dossier.

**Mesure** `appels_par_mois` — Appels API extrapolés par mois : au plus 100000 appels. Valeur relevée : ________ appels

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
- La sirène locale du détecteur sonne seule, que le PSIM l'entende ou non (constaté et noté).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un capteur déclaré Normal par le PSIM alors que Tuya le dit hors ligne ou que ses données ne sont pas reconnues.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


