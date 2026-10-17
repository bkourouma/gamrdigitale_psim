<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Centrales d'alarme (module « sia » de la passerelle, SIA DC-09)

> Qualification d'une marque et d'un modèle de centrale d'alarme intrusion ou incendie qui transmet ses événements à la passerelle en SIA DC-09.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`centrale`](#profil-centrale) | Centrale d'alarme intrusion / incendie | 21 sur 23 |

<a id="profil-centrale"></a>

## Fiche de recette : Centrales d'alarme (module « sia » de la passerelle, SIA DC-09)

**Profil : Centrale d'alarme intrusion / incendie** (`centrale`)  
Fiche `sia` version 1 — empreinte `886f9d328027a42b`  
Référence : gateway/docs/sia.md ; docs/PASSERELLE.md

> Qualification d'une marque et d'un modèle de centrale d'alarme intrusion ou incendie qui transmet ses événements à la passerelle en SIA DC-09.

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

- La centrale à qualifier, alimentée, avec un détecteur de chaque type que le pack utilise (mouvement, ouverture, fumée en mode test, bouton panique, autoprotection)
- Module de transmission IP (ou centrale IP) réglé en SIA DC-09, notice des réglages
- Switch, câbles ; poste de recette (PSIM hors production + Passerelle GAMR avec le module sia)
- Clé AES-128 générée au hasard (32 caractères hexadécimaux), numéro de compte de 3 à 16 caractères hexadécimaux
- Chronomètre ; accès NTP pour la centrale ou possibilité de décaler son horloge

### Montage du banc d'essai

1. Mettre la centrale et la passerelle sur le même réseau, adresse IP fixe pour la passerelle (`listen.host`), port choisi (`listen.port`).
2. Sur la centrale : protocole SIA DC-09 format SIA-DCS, adresse et port de la passerelle, numéro de compte, chiffrement AES activé avec la clé, horodatage activé, test cyclique toutes les 60 s à 5 min.
3. Dans le module sia : compte, clé (`keyEnv` de préférence), `zones`, `partitions`, `defaultId`, `supervisionS` à 2 à 3 fois l'intervalle de test cyclique.
4. Dans le PSIM de recette, créer un détecteur par zone utile (BANC-01 pour la zone d'intrusion de référence) et un pour la centrale (`defaultId`).

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Réglages de la centrale `sia-reglages` — OBLIGATOIRE

**À faire** : Relever et noter les réglages saisis sur la centrale : format (SIA-DCS ou ADM-CID), transport (TCP ou UDP), numéro de compte, chiffrement AES (longueur de clé), horodatage, test cyclique (intervalle). Joindre une photo de l'écran ou une copie de la configuration SANS la clé.

**Résultat attendu** : Tous les réglages correspondent à la section 1 de gateway/docs/sia.md. La clé n'est écrite nulle part dans la fiche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Intrusion (zone d'intrusion de la centrale)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Sur la centrale, lancer un test de transmission : elle doit afficher « transmission réussie » (ACK reçu). Un message « compte inconnu », « horodatage hors fenetre », « dechiffrement impossible » dans le journal de la passerelle est un réglage à corriger. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Test de transmission `sia-test` — OBLIGATOIRE

**À faire** : Lancer un test de transmission depuis la centrale. Lire l'affichage de la centrale et le journal de la passerelle.

**Résultat attendu** : La centrale indique « transmission réussie » (ACK). Le journal de la passerelle montre la réception sans erreur.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 6. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Armer la centrale puis déclencher le détecteur d'intrusion de la zone de référence (ouverture ou mouvement). Noter l'heure exacte du geste.

**Résultat attendu** : La centrale envoie l'alarme (code BA ou équivalent) ; un incident d'intrusion s'ouvre sur le bon équipement. L'incident porte le bon nom, la bonne zone et le motif « Intrusion » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Désarmer la centrale ; la restauration (BR ou équivalent) arrive.

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 10 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Alarme incendie (mode test) `sia-incendie` — facultative

**À faire** : Déclencher un détecteur incendie de la centrale en mode test (bouton test, jamais de flamme réelle). Si la centrale n'a pas de voie incendie, marquer « na ».

**Résultat attendu** : Alarme incendie (code FA ou 1110) transmise et affichée sur le bon équipement ; la restauration arrive.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Panique `sia-panique` — OBLIGATOIRE

**À faire** : Déclencher la panique (clavier ou bouton) ; le déclencher centrale désarmée.

**Résultat attendu** : Alarme de panique ouverte même centrale désarmée (code PA / HA).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Sabotage (autoprotection) `tamper` — OBLIGATOIRE

**À faire** : Ouvrir le boîtier de la centrale ou arracher un détecteur de son support (autoprotection). Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Débrancher la batterie de la centrale puis le secteur jusqu'à l'alerte « batterie faible » (ou utiliser le test de batterie de la centrale). Noter la tension. Rétablir ensuite.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Perte et retour du secteur de la centrale `sia-secteur` — OBLIGATOIRE

**À faire** : Couper le secteur de la centrale (batterie branchée), attendre l'alerte, puis rétablir.

**Résultat attendu** : « Coupure secteur » (AT) puis « Courant rétabli » (AR) arrivent sur l'équipement de la centrale (`defaultId`).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 15. Chiffrement et clé `sia-chiffrement` — OBLIGATOIRE

**À faire** : Changer volontairement la clé AES sur la centrale (clé fausse), lancer un test de transmission, puis remettre la bonne clé. Si la centrale sait envoyer en clair, essayer aussi une trame en clair.

**Résultat attendu** : Avec une mauvaise clé ou en clair (alors que `requireEncryption` vaut vrai) : la trame est refusée, le journal le dit (« dechiffrement impossible » ou « trame en clair refusee »), aucun événement n'arrive au PSIM. Avec la bonne clé : tout redevient normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Horloge de la centrale décalée `sia-horloge` — OBLIGATOIRE

**À faire** : Décaler l'horloge de la centrale de plus de 60 s (au-delà de `maxClockSkewS`), lancer un test de transmission, puis la remettre à l'heure.

**Résultat attendu** : La trame est refusée (NAK, « horodatage hors fenetre » dans le journal), aucun événement au PSIM ; la centrale se recale sur l'heure du NAK ou une fois remise à l'heure.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau de la centrale (ou du module IP) plus longtemps que `supervisionS`. Noter l'heure.

**Résultat attendu** : En moins de 300 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 18. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 19. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la centrale et sa batterie (mettre la centrale hors tension) en laissant la passerelle et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 2 à 3 fois l'intervalle du test cyclique de la centrale (`supervisionS`) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 360 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 360 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 20. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 21. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter la passerelle pendant 5 minutes. Pendant la coupure, déclencher un détecteur de la centrale puis le restaurer. Redémarrer la passerelle.

**Résultat attendu** : La centrale, faute d'ACK, retransmet ; l'événement arrive à la reprise, daté de son heure réelle (horodatage de la trame), un seul incident, aucun doublon si la centrale retransmet une trame déjà traitée.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 22. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 23. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 21 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Tout code `inconnu` signalé par le journal pendant l'essai est noté et, si besoin, ajouté dans `overrides` (puis l'essai concerné est refait).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une trame chiffrée avec une mauvaise clé ou hors fenêtre d'horloge acceptée par la passerelle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


