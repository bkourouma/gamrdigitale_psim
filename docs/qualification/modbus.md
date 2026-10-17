<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Modbus TCP et contacts secs (module « modbus » de la passerelle)

> Qualification d'un équipement lu en Modbus TCP : contact sec (barrière infrarouge, bris de vitre, radar, câble de clôture, déclencheur manuel, détecteur de coupure, centrale incendie par contact) ou mesure (niveau de cuve 4-20 mA, qualité de l'air, compteur d'énergie, groupe électrogène).

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`contact-sec`](#profil-contact-sec) | Contact sec (barrière IR, bris de vitre, radar, câble de clôture, déclencheur manuel, détecteur de coupure, centrale incendie par contact) | 15 sur 16 |
| [`mesure`](#profil-mesure) | Mesure (niveau de cuve 4-20 mA, qualité de l'air, compteur d'énergie, groupe électrogène) | 15 sur 16 |

<a id="profil-contact-sec"></a>

## Fiche de recette : Modbus TCP et contacts secs (module « modbus » de la passerelle)

**Profil : Contact sec (barrière IR, bris de vitre, radar, câble de clôture, déclencheur manuel, détecteur de coupure, centrale incendie par contact)** (`contact-sec`)  
Fiche `modbus` version 1 — empreinte `fc2c8bb2695e3c26`  
Référence : gateway/docs/modbus.md ; docs/PASSERELLE.md

> Qualification d'un équipement lu en Modbus TCP : contact sec (barrière infrarouge, bris de vitre, radar, câble de clôture, déclencheur manuel, détecteur de coupure, centrale incendie par contact) ou mesure (niveau de cuve 4-20 mA, qualité de l'air, compteur d'énergie, groupe électrogène).

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

- L'équipement à qualifier, son alimentation et sa notice (adresses Modbus, sens du contact)
- Module d'entrées Modbus TCP (pour un contact sec) ou l'équipement parlant directement Modbus TCP, switch Ethernet, câbles
- Pour une mesure 4-20 mA : calibrateur de boucle (source 4 / 12 / 20 mA) et multimètre
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module modbus configuré
- Chronomètre ou horloge synchronisée (NTP), thermo-hygromètre étalonné

### Montage du banc d'essai

1. Câbler l'équipement au module d'entrées (contact sec : fil de contact entre l'entrée et la borne commune ; noter si le contact est normalement ouvert ou fermé).
2. Brancher le module d'entrées sur le switch, lui donner une adresse IP fixe, vérifier avec l'outil du fabricant que l'entrée change quand le contact change.
3. Déclarer le point dans la configuration du module modbus (adresse, type, `onTrue`/`onFalse`, `invert`, `debounceMs`, `failThreshold`), identifiant PSIM BANC-01.
4. Dans le PSIM de recette, créer le détecteur BANC-01, régler sa supervision (au moins 3 fois `heartbeatMs`) et, pour une mesure, ses seuils.
5. Ajouter des destinataires de test (niveaux 1 et 2).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Intrusion, Incendie ou Énergie selon l'équipement).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Démarrer la passerelle : elle envoie l'état de chaque point au démarrage. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Faire commuter le contact comme le ferait le fait réel : couper le faisceau (barrière), appuyer sur le déclencheur manuel, simuler le bris de vitre avec le testeur du fabricant, marcher dans la zone du radar, couper l'alimentation secteur (détecteur de coupure). Noter l'heure exacte du geste.

**Résultat attendu** : Un incident s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Intrusion » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Rétablir le contact (faisceau libre, déclencheur réarmé, secteur rétabli).

**Résultat attendu** : L'état revient à Normal en moins de 15 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 15 s. Valeur relevée : ________ s

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

##### 8. Anti-rebond `anti-rebond` — OBLIGATOIRE

**À faire** : Faire rebondir le contact (le secouer, ou le commuter 10 fois en 2 s). Compter les messages reçus par le PSIM (journal du détecteur).

**Résultat attendu** : Un seul message par changement d'état stable ; aucune inondation du journal ; l'état final est exact.

**Mesure** `messages_par_changement` — Messages par changement stable : au plus 1 messages. Valeur relevée : ________ messages

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 9. Boucle ou capteur coupé `boucle-coupee` — OBLIGATOIRE

**À faire** : Couper la boucle 4-20 mA (courant sous 3,6 mA), ou débrancher le fil du contact sec si l'équipement est câblé en fin de ligne.

**Résultat attendu** : Le point passe en Défaut (jamais en Normal ni sur une valeur figée) en moins de 60 s ; le rétablissement est constaté.

**Mesure** `boucle_coupee_s` — Délai jusqu'au Défaut : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du module d'entrées (ou arrêter l'équipement Modbus). Noter que la passerelle envoie « Défaut » une seule fois après `failThreshold` échecs. Noter l'heure.

**Résultat attendu** : En moins de 60 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau ; la passerelle se reconnecte avec des pauses croissantes (1 s à 30 s). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 60 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Arrêter le module modbus de la passerelle (ou la passerelle entière) tout en laissant l'équipement et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 90 s (3 fois le signe de vie `heartbeatMs` de 30 s) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 120 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 13. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, faire commuter le contact (ou franchir le seuil) puis le remettre au repos. Redémarrer le PSIM.

**Résultat attendu** : La file d'envoi de la passerelle vide ses messages dans l'ordre à la reprise : l'événement est daté de son heure réelle (« reçu avec N minutes de retard »), un seul incident, aucun doublon si on redémarre la passerelle, l'état final est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 15. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 16. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 15 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le sens du contact (normalement ouvert / fermé) et les adresses Modbus relevés sur le banc sont reportés dans le dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une coupure de câble ou de boucle qui laisse l'état « Normal » affiché.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-mesure"></a>

## Fiche de recette : Modbus TCP et contacts secs (module « modbus » de la passerelle)

**Profil : Mesure (niveau de cuve 4-20 mA, qualité de l'air, compteur d'énergie, groupe électrogène)** (`mesure`)  
Fiche `modbus` version 1 — empreinte `1cc594433517f13e`  
Référence : gateway/docs/modbus.md ; docs/PASSERELLE.md

> Qualification d'un équipement lu en Modbus TCP : contact sec (barrière infrarouge, bris de vitre, radar, câble de clôture, déclencheur manuel, détecteur de coupure, centrale incendie par contact) ou mesure (niveau de cuve 4-20 mA, qualité de l'air, compteur d'énergie, groupe électrogène).

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

- L'équipement à qualifier, son alimentation et sa notice (adresses Modbus, sens du contact)
- Module d'entrées Modbus TCP (pour un contact sec) ou l'équipement parlant directement Modbus TCP, switch Ethernet, câbles
- Pour une mesure 4-20 mA : calibrateur de boucle (source 4 / 12 / 20 mA) et multimètre
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module modbus configuré
- Chronomètre ou horloge synchronisée (NTP), thermo-hygromètre étalonné

### Montage du banc d'essai

1. Câbler l'équipement au module d'entrées (contact sec : fil de contact entre l'entrée et la borne commune ; noter si le contact est normalement ouvert ou fermé).
2. Brancher le module d'entrées sur le switch, lui donner une adresse IP fixe, vérifier avec l'outil du fabricant que l'entrée change quand le contact change.
3. Déclarer le point dans la configuration du module modbus (adresse, type, `onTrue`/`onFalse`, `invert`, `debounceMs`, `failThreshold`), identifiant PSIM BANC-01.
4. Dans le PSIM de recette, créer le détecteur BANC-01, régler sa supervision (au moins 3 fois `heartbeatMs`) et, pour une mesure, ses seuils.
5. Ajouter des destinataires de test (niveaux 1 et 2).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Environnement ou Énergie (mesure avec seuils de préalarme et d'alarme)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Démarrer la passerelle : elle envoie l'état de chaque point au démarrage. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Faire franchir le seuil d'alarme réglé dans le PSIM : appliquer au calibrateur la valeur correspondante (par exemple 18 mA pour un niveau de cuve très bas ou très haut selon le sens du seuil), ou faire varier la grandeur réelle. Noter l'heure exacte du geste.

**Résultat attendu** : La valeur affichée suit l'entrée ; préalarme au seuil bas, alarme au seuil d'alarme ; un incident s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Seuil d'alarme dépassé » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Ramener la grandeur à sa valeur normale (calibrateur à 12 mA, par exemple).

**Résultat attendu** : L'état revient à Normal en moins de 15 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 15 s. Valeur relevée : ________ s

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

##### 8. Étalonnage de la mesure `etalonnage` — OBLIGATOIRE

**À faire** : Appliquer au calibrateur 4, 12 et 20 mA (ou trois valeurs connues de la grandeur). Comparer la valeur affichée dans le PSIM à la valeur attendue.

**Résultat attendu** : Écart maximal inférieur ou égal à 1 % de l'échelle.

**Mesure** `ecart_pct_echelle` — Plus grand écart (en % de l'échelle) : au plus 1 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 9. Boucle ou capteur coupé `boucle-coupee` — OBLIGATOIRE

**À faire** : Couper la boucle 4-20 mA (courant sous 3,6 mA), ou débrancher le fil du contact sec si l'équipement est câblé en fin de ligne.

**Résultat attendu** : Le point passe en Défaut (jamais en Normal ni sur une valeur figée) en moins de 60 s ; le rétablissement est constaté.

**Mesure** `boucle_coupee_s` — Délai jusqu'au Défaut : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du module d'entrées (ou arrêter l'équipement Modbus). Noter que la passerelle envoie « Défaut » une seule fois après `failThreshold` échecs. Noter l'heure.

**Résultat attendu** : En moins de 60 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau ; la passerelle se reconnecte avec des pauses croissantes (1 s à 30 s). Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 60 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Arrêter le module modbus de la passerelle (ou la passerelle entière) tout en laissant l'équipement et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 90 s (3 fois le signe de vie `heartbeatMs` de 30 s) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 120 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 13. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 2 minutes. Pendant la coupure, faire commuter le contact (ou franchir le seuil) puis le remettre au repos. Redémarrer le PSIM.

**Résultat attendu** : La file d'envoi de la passerelle vide ses messages dans l'ordre à la reprise : l'événement est daté de son heure réelle (« reçu avec N minutes de retard »), un seul incident, aucun doublon si on redémarre la passerelle, l'état final est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 15. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 16. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 15 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le sens du contact (normalement ouvert / fermé) et les adresses Modbus relevés sur le banc sont reportés dans le dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une coupure de câble ou de boucle qui laisse l'état « Normal » affiché.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


