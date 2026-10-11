<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Enregistreurs Dahua NVR / XVR et caméras HDCVI

> Qualification d'un enregistreur Dahua (flux RTSP par voie, événements de détection de mouvement transformés en alarmes d'intrusion) ou d'une caméra HDCVI raccordée à un enregistreur.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`enregistreur`](#profil-enregistreur) | Enregistreur NVR / XVR Dahua | 20 sur 21 |
| [`camera-hdcvi`](#profil-camera-hdcvi) | Caméra HDCVI raccordée à un enregistreur | 16 sur 18 |

<a id="profil-enregistreur"></a>

## Fiche de recette : Enregistreurs Dahua NVR / XVR et caméras HDCVI

**Profil : Enregistreur NVR / XVR Dahua** (`enregistreur`)  
Fiche `enregistreur-dahua` version 1 — empreinte `9475f5f86f29098f`  
Référence : README.md (section « Détection des enregistreurs Dahua et alertes par zone ») ; server/dahua.ts

> Qualification d'un enregistreur Dahua (flux RTSP par voie, événements de détection de mouvement transformés en alarmes d'intrusion) ou d'une caméra HDCVI raccordée à un enregistreur.

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

- L'enregistreur à qualifier avec ses caméras branchées (une caméra par voie à tester) et son disque, mot de passe administrateur réinitialisé
- Un compte de l'enregistreur en lecture seule dédié au PSIM
- Switch, câbles ; PC de recette avec ffmpeg, PSIM hors production
- Chronomètre ; mètre laser ; multimètre (tension d'alimentation des caméras HDCVI)
- Pour les caméras HDCVI : câble coaxial de la longueur réelle de pose, alimentation 12 V, cible de nuit à distance connue

### Montage du banc d'essai

1. Enregistreur sur le switch, adresse IP fixe, heure en NTP, fuseau correct ; vérifier dans son interface que la détection de mouvement (ou SMD humain) est activée sur chaque voie testée.
2. Dans le PSIM de recette : créer une caméra par voie (flux RTSP `/cam/realmonitor?channel=<voie>&subtype=1`, compte lecture seule) ; créer un détecteur d'intrusion BANC-01 avec une zone, armé pour la recette.
3. Dans l'éditeur du détecteur, section « Détection par l'enregistreur vidéo » : choisir la caméra, la voie, le type d'événement, puis « Écouter 20 secondes ».

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

##### 3. Authentification et connexion `dahua-auth` — OBLIGATOIRE

**À faire** : Enregistrer la source du détecteur. Lire l'état de connexion dans l'éditeur. Noter la version du micrologiciel de l'enregistreur.

**Résultat attendu** : « Connecté à l'appareil » s'affiche : authentification Digest acceptée (jamais Basic), signe de vie reçu. Le mot de passe n'apparaît nulle part (écran, journal).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Image d'une voie (flux RTSP) `voie-image` — OBLIGATOIRE

**À faire** : Pour la voie testée : « Enregistrer et tester ». Relever la taille reçue et le format affiché (704x576, 1440x1620…). Comparer à l'image de l'enregistreur.

**Résultat attendu** : Image nette, proportions correctes avec le format automatique (sinon régler 16:9 ou 4:3 et noter le réglage retenu), en moins de 10 s.

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Écoute des événements (20 secondes) `voie-ecoute` — OBLIGATOIRE

**À faire** : Cliquer « Écouter 20 secondes » en passant devant la caméra de la voie. Relever la liste des événements par voie (Code=VideoMotion, SmartMotionHuman…).

**Résultat attendu** : Les événements de la bonne voie apparaissent en vert (voie et type suivis) ; ceux des autres voies n'apparaissent pas en vert.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; l'état « Connecté à l'appareil » doit s'afficher (premier signe de vie lu). Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 7. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Zone armée : passer devant la caméra de la voie testée (3 passages). Si le type suivi est « humain », se placer à la distance prévue. Noter l'heure exacte du geste.

**Résultat attendu** : Un incident d'intrusion s'ouvre pour le détecteur de CETTE voie, avec l'image de la caméra liée. L'incident porte le bon nom, la bonne zone et le motif « Mouvement détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Sortir du champ de la caméra ; l'enregistreur envoie la fin du mouvement.

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois de suite le cycle déclenchement / retour à la normale, en acquittant et clôturant l'incident entre deux cycles. Noter combien de cycles ont ouvert un incident.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Isolement des voies `voie-isolement` — OBLIGATOIRE

**À faire** : Passer devant la caméra d'une AUTRE voie que celle du détecteur testé.

**Résultat attendu** : Aucun incident sur le détecteur testé : seule sa voie le déclenche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Toutes les voies du pack `multi-voies` — OBLIGATOIRE

**À faire** : Refaire les étapes « Image d'une voie » et « Déclenchement » pour CHAQUE voie utilisée par le pack (4 voies pour le pack standard). Compter les voies réussies.

**Résultat attendu** : Toutes les voies du pack passent. Si une seule voie a été essayée, la portée de la qualification est « une voie » et doit être écrite telle quelle (`promote --scope`).

**Mesure** `voies_testees` — Voies testées avec succès : au moins 4 voies. Valeur relevée : ________ voies

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Perte vidéo d'une voie `perte-video` — OBLIGATOIRE

**À faire** : Débrancher la caméra de la voie testée. Faire l'essai zone armée, puis zone désarmée.

**Résultat attendu** : Zone armée : alarme « Sabotage » (perte vidéo = sabotage possible). Zone désarmée : simple défaut du détecteur, pas d'incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 14. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau de l'enregistreur 5 minutes. Noter l'heure. Noter l'heure.

**Résultat attendu** : En moins de 180 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Mot de passe changé sur l'enregistreur `auth-refusee` — OBLIGATOIRE

**À faire** : Changer le mot de passe du compte lecture seule sur l'enregistreur ; observer le PSIM 8 minutes ; remettre le bon mot de passe.

**Résultat attendu** : Le PSIM affiche l'erreur d'authentification, ne retente qu'après 5 minutes (jamais en boucle : un enregistreur Dahua bloque le compte après quelques échecs), le détecteur passe « Hors ligne » ; le retour du bon mot de passe rétablit l'écoute.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Éteindre l'enregistreur (ou le débrancher du réseau) : le PSIM n'entend plus ses signes de vie toutes les 5 s. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 120 s (valeur posée par le PSIM quand le détecteur n'en avait pas) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 180 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 18. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 19. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès réseau entre le PSIM et l'enregistreur 6 minutes. Pendant la coupure, passer devant la caméra. Rétablir.

**Résultat attendu** : Pendant la coupure : le détecteur passe « Hors ligne » (muet) après le délai, jamais Normal. Au rétablissement : l'écoute reprend seule (reconnexion de 2 s à 60 s). Limite connue à noter : le mouvement survenu pendant la coupure n'est pas rejoué (le PSIM ne récupère pas l'historique de l'enregistreur).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 20. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 21. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 20 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- La portée (nombre de voies et fonctions réellement essayées) est écrite sans ambiguïté dans `--scope`.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un détecteur qui reste Normal alors que la connexion à l'enregistreur est perdue.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-camera-hdcvi"></a>

## Fiche de recette : Enregistreurs Dahua NVR / XVR et caméras HDCVI

**Profil : Caméra HDCVI raccordée à un enregistreur** (`camera-hdcvi`)  
Fiche `enregistreur-dahua` version 1 — empreinte `333efb3f89b6df6f`  
Référence : README.md (section « Détection des enregistreurs Dahua et alertes par zone ») ; server/dahua.ts

> Qualification d'un enregistreur Dahua (flux RTSP par voie, événements de détection de mouvement transformés en alarmes d'intrusion) ou d'une caméra HDCVI raccordée à un enregistreur.

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

- L'enregistreur à qualifier avec ses caméras branchées (une caméra par voie à tester) et son disque, mot de passe administrateur réinitialisé
- Un compte de l'enregistreur en lecture seule dédié au PSIM
- Switch, câbles ; PC de recette avec ffmpeg, PSIM hors production
- Chronomètre ; mètre laser ; multimètre (tension d'alimentation des caméras HDCVI)
- Pour les caméras HDCVI : câble coaxial de la longueur réelle de pose, alimentation 12 V, cible de nuit à distance connue

### Montage du banc d'essai

1. Enregistreur sur le switch, adresse IP fixe, heure en NTP, fuseau correct ; vérifier dans son interface que la détection de mouvement (ou SMD humain) est activée sur chaque voie testée.
2. Dans le PSIM de recette : créer une caméra par voie (flux RTSP `/cam/realmonitor?channel=<voie>&subtype=1`, compte lecture seule) ; créer un détecteur d'intrusion BANC-01 avec une zone, armé pour la recette.
3. Dans l'éditeur du détecteur, section « Détection par l'enregistreur vidéo » : choisir la caméra, la voie, le type d'événement, puis « Écouter 20 secondes ».

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

##### 3. Image d'une voie (flux RTSP) `voie-image` — OBLIGATOIRE

**À faire** : Pour la voie testée : « Enregistrer et tester ». Relever la taille reçue et le format affiché (704x576, 1440x1620…). Comparer à l'image de l'enregistreur.

**Résultat attendu** : Image nette, proportions correctes avec le format automatique (sinon régler 16:9 ou 4:3 et noter le réglage retenu), en moins de 10 s.

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Enregistrer la source ; l'état « Connecté à l'appareil » doit s'afficher (premier signe de vie lu). Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Tension à la caméra `alimentation-hdcvi` — OBLIGATOIRE

**À faire** : Mesurer au multimètre la tension d'alimentation au bout du câble, à la caméra, avec la longueur réelle de pose.

**Résultat attendu** : Tension supérieure ou égale à 10,8 V pour une alimentation 12 V (chute de tension acceptable).

**Mesure** `tension_camera_v` — Tension à la caméra : au moins 10.8 V. Valeur relevée : ________ V

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 6. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Zone armée : passer devant la caméra de la voie testée (3 passages). Si le type suivi est « humain », se placer à la distance prévue. Noter l'heure exacte du geste.

**Résultat attendu** : Un incident d'intrusion s'ouvre pour le détecteur de CETTE voie, avec l'image de la caméra liée. L'incident porte le bon nom, la bonne zone et le motif « Mouvement détecté » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Sortir du champ de la caméra ; l'enregistreur envoie la fin du mouvement.

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

**Résultat attendu** : Pire délai inférieur ou égal à 5 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — facultative

**À faire** : Couvrir l'objectif de la caméra (masquage) puis la débrancher. Noter ce que signale l'enregistreur.

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Image de nuit `nuit` — OBLIGATOIRE

**À faire** : À la nuit tombée, placer une personne de référence à 5, 10, 15, 20 m. Noter la plus grande distance où l'on distingue une personne.

**Résultat attendu** : Personne distinguée à au moins 10 m ; pas de reflet de l'infrarouge.

**Mesure** `distance_nuit_m` — Distance de détection de nuit : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 12. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau de l'enregistreur 5 minutes. Noter l'heure. Noter l'heure.

**Résultat attendu** : En moins de 180 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Éteindre l'enregistreur (ou le débrancher du réseau) : le PSIM n'entend plus ses signes de vie toutes les 5 s. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 120 s (valeur posée par le PSIM quand le détecteur n'en avait pas) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 180 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 15. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Couper l'accès réseau entre le PSIM et l'enregistreur 6 minutes. Pendant la coupure, passer devant la caméra. Rétablir.

**Résultat attendu** : Pendant la coupure : le détecteur passe « Hors ligne » (muet) après le délai, jamais Normal. Au rétablissement : l'écoute reprend seule (reconnexion de 2 s à 60 s). Limite connue à noter : le mouvement survenu pendant la coupure n'est pas rejoué (le PSIM ne récupère pas l'historique de l'enregistreur).

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
- Les 16 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- La portée (nombre de voies et fonctions réellement essayées) est écrite sans ambiguïté dans `--scope`.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un détecteur qui reste Normal alors que la connexion à l'enregistreur est perdue.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


