<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Caméras IP ONVIF / RTSP (fixe, PTZ, panoramique, solaire 4G, thermique)

> Qualification d'un modèle de caméra IP raccordée directement au PSIM : découverte ONVIF, image RTSP, fluidité, nuit, reprise après coupure ; points propres au PTZ, au panoramique, au solaire 4G et au thermique.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`fixe`](#profil-fixe) | Caméra IP fixe ONVIF | 11 sur 13 |
| [`ptz`](#profil-ptz) | Caméra PTZ (dôme motorisé) | 12 sur 14 |
| [`panoramique`](#profil-panoramique) | Caméra panoramique (360° / multi-capteurs) | 12 sur 14 |
| [`solaire-4g`](#profil-solaire-4g) | Caméra solaire 4G | 14 sur 14 |
| [`thermique`](#profil-thermique) | Caméra thermique | 13 sur 14 |

<a id="profil-fixe"></a>

## Fiche de recette : Caméras IP ONVIF / RTSP (fixe, PTZ, panoramique, solaire 4G, thermique)

**Profil : Caméra IP fixe ONVIF** (`fixe`)  
Fiche `camera-onvif` version 1 — empreinte `6d2d9c70a1177602`  
Référence : README.md (section « Brancher une caméra ONVIF réelle ») ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de caméra IP raccordée directement au PSIM : découverte ONVIF, image RTSP, fluidité, nuit, reprise après coupure ; points propres au PTZ, au panoramique, au solaire 4G et au thermique.

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

- La caméra à qualifier, son alimentation (PoE ou 12 V) et son support
- Switch PoE (ou injecteur), câbles ; PC de recette avec ffmpeg installé, PSIM hors production
- Chronomètre, luxmètre ou conditions de nuit réelles, cible de test (personne, panneau lisible) à distance connue, mètre laser
- Solaire 4G : carte SIM de test, panneau et batterie fournis, accès à un lieu ensoleillé puis occulté
- Thermique : cible chaude (personne, bouteille d'eau chaude) à distance connue

### Montage du banc d'essai

1. Brancher la caméra sur le switch PoE, lui donner une adresse IP fixe ; créer un compte en lecture seule dédié au PSIM ; régler son heure (NTP).
2. Dans le PSIM de recette, créer la caméra BANC-01 (Source vidéo : Caméra réseau ONVIF, ou flux direct RTSP).
3. Régler le flux secondaire pour l'affichage (résolution basse, 10 à 15 images/s) ; noter le chemin RTSP.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Caméra).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Découverte ONVIF `onvif-decouverte` — facultative

**À faire** : Dans l'éditeur de la caméra, « Rechercher sur le réseau » (ONVIF). Si la caméra n'est pas trouvée, saisir son adresse à la main.

**Résultat attendu** : La caméra est trouvée par la recherche, ou saisie manuelle réussie. Noter si la multidiffusion est bloquée sur le réseau du site.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Image affichée (« Enregistrer et tester ») `image` — OBLIGATOIRE

**À faire** : Cliquer « Enregistrer et tester ». Relever la taille reçue et le format affiché indiqués par le PSIM. Comparer l'image du PSIM à celle de l'interface de la caméra.

**Résultat attendu** : Une image nette et à l'endroit s'affiche en moins de 10 s ; proportions correctes (pas d'image écrasée) ; message d'erreur clair si on saisit un mauvais mot de passe (testé à l'étape suivante).

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Identifiants refusés `identifiants` — OBLIGATOIRE

**À faire** : Saisir un mauvais mot de passe, puis le bon. Noter le message du PSIM et vérifier que la caméra ne verrouille pas le compte après 3 essais.

**Résultat attendu** : Le message nomme la cause probable (identifiants refusés). Le compte n'est pas verrouillé par les essais du PSIM. Le bon mot de passe fonctionne aussitôt.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Fluidité et latence de l'image `fluidite` — OBLIGATOIRE

**À faire** : Afficher la caméra 10 minutes sur le mur vidéo (flux secondaire). Compter les images par seconde (compteur d'ffmpeg ou de la caméra) et mesurer le retard : agiter un chronomètre devant la caméra et comparer à l'écran.

**Résultat attendu** : Au moins 8 images par seconde, sans saccade ni gel, et retard inférieur ou égal à 3 s.

**Mesure** `images_par_s` — Images par seconde : au moins 8 i/s. Valeur relevée : ________ i/s

**Mesure** `retard_image_s` — Retard de l'image : au plus 3 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Heure de la caméra `heure-camera` — OBLIGATOIRE

**À faire** : Comparer l'heure incrustée de la caméra à l'heure du PSIM (synchronisée NTP).

**Résultat attendu** : Écart inférieur ou égal à 5 s (au-delà, ONVIF peut refuser les identifiants).

**Mesure** `ecart_heure_s` — Écart d'heure : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Image de nuit `nuit` — OBLIGATOIRE

**À faire** : À la nuit tombée (ou pièce noire avec seulement l'éclairage IR de la caméra), placer une personne de référence à distances croissantes (5, 10, 15, 20 m). Noter la plus grande distance où l'on distingue une personne.

**Résultat attendu** : Personne distinguée à au moins 10 m ; pas de voile ni de reflet de l'infrarouge sur le support.

**Mesure** `distance_nuit_m` — Distance de détection de nuit : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 9. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la caméra (débrancher le PoE ou le 12 V) pendant 5 minutes sans toucher au PSIM. Noter l'heure.

**Résultat attendu** : Le PSIM détecte la perte après 3 mesures consécutives : « caméra hors ligne » est inscrit au journal, et l'écran Système le montre. Aucune image figée n'est présentée comme directe.

**Mesure** `liaison_perdue_s` — Délai jusqu'à « hors ligne » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'alimentation. Noter l'heure.

**Résultat attendu** : La caméra repasse « en ligne » seule et l'image revient en moins de 2 minutes, sans intervention.

**Mesure** `reprise_s` — Délai de reprise de l'image : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 11. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, attendre 60 s, le relancer.

**Résultat attendu** : La caméra est retrouvée sans reconfiguration et son image revient en moins de 60 s ; ses identifiants sont toujours lisibles (la clé de chiffrement est intacte).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 12. Conditions tropicales (35 °C, 90 % d'humidité) `tropical-autre` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 13. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 11 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le chemin RTSP et le format d'image réglés sont notés au dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une image figée affichée comme directe après une coupure de la caméra.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-ptz"></a>

## Fiche de recette : Caméras IP ONVIF / RTSP (fixe, PTZ, panoramique, solaire 4G, thermique)

**Profil : Caméra PTZ (dôme motorisé)** (`ptz`)  
Fiche `camera-onvif` version 1 — empreinte `f999d5e7e80aeb47`  
Référence : README.md (section « Brancher une caméra ONVIF réelle ») ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de caméra IP raccordée directement au PSIM : découverte ONVIF, image RTSP, fluidité, nuit, reprise après coupure ; points propres au PTZ, au panoramique, au solaire 4G et au thermique.

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

- La caméra à qualifier, son alimentation (PoE ou 12 V) et son support
- Switch PoE (ou injecteur), câbles ; PC de recette avec ffmpeg installé, PSIM hors production
- Chronomètre, luxmètre ou conditions de nuit réelles, cible de test (personne, panneau lisible) à distance connue, mètre laser
- Solaire 4G : carte SIM de test, panneau et batterie fournis, accès à un lieu ensoleillé puis occulté
- Thermique : cible chaude (personne, bouteille d'eau chaude) à distance connue

### Montage du banc d'essai

1. Brancher la caméra sur le switch PoE, lui donner une adresse IP fixe ; créer un compte en lecture seule dédié au PSIM ; régler son heure (NTP).
2. Dans le PSIM de recette, créer la caméra BANC-01 (Source vidéo : Caméra réseau ONVIF, ou flux direct RTSP).
3. Régler le flux secondaire pour l'affichage (résolution basse, 10 à 15 images/s) ; noter le chemin RTSP.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Caméra).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Découverte ONVIF `onvif-decouverte` — facultative

**À faire** : Dans l'éditeur de la caméra, « Rechercher sur le réseau » (ONVIF). Si la caméra n'est pas trouvée, saisir son adresse à la main.

**Résultat attendu** : La caméra est trouvée par la recherche, ou saisie manuelle réussie. Noter si la multidiffusion est bloquée sur le réseau du site.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Image affichée (« Enregistrer et tester ») `image` — OBLIGATOIRE

**À faire** : Cliquer « Enregistrer et tester ». Relever la taille reçue et le format affiché indiqués par le PSIM. Comparer l'image du PSIM à celle de l'interface de la caméra.

**Résultat attendu** : Une image nette et à l'endroit s'affiche en moins de 10 s ; proportions correctes (pas d'image écrasée) ; message d'erreur clair si on saisit un mauvais mot de passe (testé à l'étape suivante).

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Identifiants refusés `identifiants` — OBLIGATOIRE

**À faire** : Saisir un mauvais mot de passe, puis le bon. Noter le message du PSIM et vérifier que la caméra ne verrouille pas le compte après 3 essais.

**Résultat attendu** : Le message nomme la cause probable (identifiants refusés). Le compte n'est pas verrouillé par les essais du PSIM. Le bon mot de passe fonctionne aussitôt.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Fluidité et latence de l'image `fluidite` — OBLIGATOIRE

**À faire** : Afficher la caméra 10 minutes sur le mur vidéo (flux secondaire). Compter les images par seconde (compteur d'ffmpeg ou de la caméra) et mesurer le retard : agiter un chronomètre devant la caméra et comparer à l'écran.

**Résultat attendu** : Au moins 8 images par seconde, sans saccade ni gel, et retard inférieur ou égal à 3 s.

**Mesure** `images_par_s` — Images par seconde : au moins 8 i/s. Valeur relevée : ________ i/s

**Mesure** `retard_image_s` — Retard de l'image : au plus 3 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Heure de la caméra `heure-camera` — OBLIGATOIRE

**À faire** : Comparer l'heure incrustée de la caméra à l'heure du PSIM (synchronisée NTP).

**Résultat attendu** : Écart inférieur ou égal à 5 s (au-delà, ONVIF peut refuser les identifiants).

**Mesure** `ecart_heure_s` — Écart d'heure : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Image de nuit `nuit` — OBLIGATOIRE

**À faire** : À la nuit tombée (ou pièce noire avec seulement l'éclairage IR de la caméra), placer une personne de référence à distances croissantes (5, 10, 15, 20 m). Noter la plus grande distance où l'on distingue une personne.

**Résultat attendu** : Personne distinguée à au moins 10 m ; pas de voile ni de reflet de l'infrarouge sur le support.

**Mesure** `distance_nuit_m` — Distance de détection de nuit : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Positions mémorisées (PTZ) `ptz-presets` — OBLIGATOIRE

**À faire** : Mémoriser 3 positions (préréglages) sur la caméra ; les rappeler depuis l'interface de la caméra ; afficher dans le PSIM. Le PSIM n'envoie aucune commande de pilotage (affichage seul) : le vérifier et le noter.

**Résultat attendu** : Les positions sont reprises sans dérive après 10 rappels ; l'image reste affichée par le PSIM pendant les déplacements.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la caméra (débrancher le PoE ou le 12 V) pendant 5 minutes sans toucher au PSIM. Noter l'heure.

**Résultat attendu** : Le PSIM détecte la perte après 3 mesures consécutives : « caméra hors ligne » est inscrit au journal, et l'écran Système le montre. Aucune image figée n'est présentée comme directe.

**Mesure** `liaison_perdue_s` — Délai jusqu'à « hors ligne » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'alimentation. Noter l'heure.

**Résultat attendu** : La caméra repasse « en ligne » seule et l'image revient en moins de 2 minutes, sans intervention.

**Mesure** `reprise_s` — Délai de reprise de l'image : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 12. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, attendre 60 s, le relancer.

**Résultat attendu** : La caméra est retrouvée sans reconfiguration et son image revient en moins de 60 s ; ses identifiants sont toujours lisibles (la clé de chiffrement est intacte).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 13. Conditions tropicales (35 °C, 90 % d'humidité) `tropical-autre` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 14. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 12 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le chemin RTSP et le format d'image réglés sont notés au dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une image figée affichée comme directe après une coupure de la caméra.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-panoramique"></a>

## Fiche de recette : Caméras IP ONVIF / RTSP (fixe, PTZ, panoramique, solaire 4G, thermique)

**Profil : Caméra panoramique (360° / multi-capteurs)** (`panoramique`)  
Fiche `camera-onvif` version 1 — empreinte `88e69f7f128d359b`  
Référence : README.md (section « Brancher une caméra ONVIF réelle ») ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de caméra IP raccordée directement au PSIM : découverte ONVIF, image RTSP, fluidité, nuit, reprise après coupure ; points propres au PTZ, au panoramique, au solaire 4G et au thermique.

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

- La caméra à qualifier, son alimentation (PoE ou 12 V) et son support
- Switch PoE (ou injecteur), câbles ; PC de recette avec ffmpeg installé, PSIM hors production
- Chronomètre, luxmètre ou conditions de nuit réelles, cible de test (personne, panneau lisible) à distance connue, mètre laser
- Solaire 4G : carte SIM de test, panneau et batterie fournis, accès à un lieu ensoleillé puis occulté
- Thermique : cible chaude (personne, bouteille d'eau chaude) à distance connue

### Montage du banc d'essai

1. Brancher la caméra sur le switch PoE, lui donner une adresse IP fixe ; créer un compte en lecture seule dédié au PSIM ; régler son heure (NTP).
2. Dans le PSIM de recette, créer la caméra BANC-01 (Source vidéo : Caméra réseau ONVIF, ou flux direct RTSP).
3. Régler le flux secondaire pour l'affichage (résolution basse, 10 à 15 images/s) ; noter le chemin RTSP.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Caméra).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Découverte ONVIF `onvif-decouverte` — facultative

**À faire** : Dans l'éditeur de la caméra, « Rechercher sur le réseau » (ONVIF). Si la caméra n'est pas trouvée, saisir son adresse à la main.

**Résultat attendu** : La caméra est trouvée par la recherche, ou saisie manuelle réussie. Noter si la multidiffusion est bloquée sur le réseau du site.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Image affichée (« Enregistrer et tester ») `image` — OBLIGATOIRE

**À faire** : Cliquer « Enregistrer et tester ». Relever la taille reçue et le format affiché indiqués par le PSIM. Comparer l'image du PSIM à celle de l'interface de la caméra.

**Résultat attendu** : Une image nette et à l'endroit s'affiche en moins de 10 s ; proportions correctes (pas d'image écrasée) ; message d'erreur clair si on saisit un mauvais mot de passe (testé à l'étape suivante).

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Identifiants refusés `identifiants` — OBLIGATOIRE

**À faire** : Saisir un mauvais mot de passe, puis le bon. Noter le message du PSIM et vérifier que la caméra ne verrouille pas le compte après 3 essais.

**Résultat attendu** : Le message nomme la cause probable (identifiants refusés). Le compte n'est pas verrouillé par les essais du PSIM. Le bon mot de passe fonctionne aussitôt.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Fluidité et latence de l'image `fluidite` — OBLIGATOIRE

**À faire** : Afficher la caméra 10 minutes sur le mur vidéo (flux secondaire). Compter les images par seconde (compteur d'ffmpeg ou de la caméra) et mesurer le retard : agiter un chronomètre devant la caméra et comparer à l'écran.

**Résultat attendu** : Au moins 8 images par seconde, sans saccade ni gel, et retard inférieur ou égal à 3 s.

**Mesure** `images_par_s` — Images par seconde : au moins 8 i/s. Valeur relevée : ________ i/s

**Mesure** `retard_image_s` — Retard de l'image : au plus 3 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Heure de la caméra `heure-camera` — OBLIGATOIRE

**À faire** : Comparer l'heure incrustée de la caméra à l'heure du PSIM (synchronisée NTP).

**Résultat attendu** : Écart inférieur ou égal à 5 s (au-delà, ONVIF peut refuser les identifiants).

**Mesure** `ecart_heure_s` — Écart d'heure : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Image de nuit `nuit` — OBLIGATOIRE

**À faire** : À la nuit tombée (ou pièce noire avec seulement l'éclairage IR de la caméra), placer une personne de référence à distances croissantes (5, 10, 15, 20 m). Noter la plus grande distance où l'on distingue une personne.

**Résultat attendu** : Personne distinguée à au moins 10 m ; pas de voile ni de reflet de l'infrarouge sur le support.

**Mesure** `distance_nuit_m` — Distance de détection de nuit : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Positions mémorisées (PTZ) `ptz-presets` — OBLIGATOIRE

**À faire** : Mémoriser 3 positions (préréglages) sur la caméra ; les rappeler depuis l'interface de la caméra ; afficher dans le PSIM. Le PSIM n'envoie aucune commande de pilotage (affichage seul) : le vérifier et le noter.

**Résultat attendu** : Les positions sont reprises sans dérive après 10 rappels ; l'image reste affichée par le PSIM pendant les déplacements.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la caméra (débrancher le PoE ou le 12 V) pendant 5 minutes sans toucher au PSIM. Noter l'heure.

**Résultat attendu** : Le PSIM détecte la perte après 3 mesures consécutives : « caméra hors ligne » est inscrit au journal, et l'écran Système le montre. Aucune image figée n'est présentée comme directe.

**Mesure** `liaison_perdue_s` — Délai jusqu'à « hors ligne » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'alimentation. Noter l'heure.

**Résultat attendu** : La caméra repasse « en ligne » seule et l'image revient en moins de 2 minutes, sans intervention.

**Mesure** `reprise_s` — Délai de reprise de l'image : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 12. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, attendre 60 s, le relancer.

**Résultat attendu** : La caméra est retrouvée sans reconfiguration et son image revient en moins de 60 s ; ses identifiants sont toujours lisibles (la clé de chiffrement est intacte).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 13. Conditions tropicales (35 °C, 90 % d'humidité) `tropical-autre` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 14. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 12 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le chemin RTSP et le format d'image réglés sont notés au dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une image figée affichée comme directe après une coupure de la caméra.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-solaire-4g"></a>

## Fiche de recette : Caméras IP ONVIF / RTSP (fixe, PTZ, panoramique, solaire 4G, thermique)

**Profil : Caméra solaire 4G** (`solaire-4g`)  
Fiche `camera-onvif` version 1 — empreinte `6c1a6dc05e0d588c`  
Référence : README.md (section « Brancher une caméra ONVIF réelle ») ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de caméra IP raccordée directement au PSIM : découverte ONVIF, image RTSP, fluidité, nuit, reprise après coupure ; points propres au PTZ, au panoramique, au solaire 4G et au thermique.

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

- La caméra à qualifier, son alimentation (PoE ou 12 V) et son support
- Switch PoE (ou injecteur), câbles ; PC de recette avec ffmpeg installé, PSIM hors production
- Chronomètre, luxmètre ou conditions de nuit réelles, cible de test (personne, panneau lisible) à distance connue, mètre laser
- Solaire 4G : carte SIM de test, panneau et batterie fournis, accès à un lieu ensoleillé puis occulté
- Thermique : cible chaude (personne, bouteille d'eau chaude) à distance connue

### Montage du banc d'essai

1. Brancher la caméra sur le switch PoE, lui donner une adresse IP fixe ; créer un compte en lecture seule dédié au PSIM ; régler son heure (NTP).
2. Dans le PSIM de recette, créer la caméra BANC-01 (Source vidéo : Caméra réseau ONVIF, ou flux direct RTSP).
3. Régler le flux secondaire pour l'affichage (résolution basse, 10 à 15 images/s) ; noter le chemin RTSP.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Caméra).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. Image affichée (« Enregistrer et tester ») `image` — OBLIGATOIRE

**À faire** : Cliquer « Enregistrer et tester ». Relever la taille reçue et le format affiché indiqués par le PSIM. Comparer l'image du PSIM à celle de l'interface de la caméra.

**Résultat attendu** : Une image nette et à l'endroit s'affiche en moins de 10 s ; proportions correctes (pas d'image écrasée) ; message d'erreur clair si on saisit un mauvais mot de passe (testé à l'étape suivante).

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Identifiants refusés `identifiants` — OBLIGATOIRE

**À faire** : Saisir un mauvais mot de passe, puis le bon. Noter le message du PSIM et vérifier que la caméra ne verrouille pas le compte après 3 essais.

**Résultat attendu** : Le message nomme la cause probable (identifiants refusés). Le compte n'est pas verrouillé par les essais du PSIM. Le bon mot de passe fonctionne aussitôt.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Fluidité et latence de l'image `fluidite` — OBLIGATOIRE

**À faire** : Afficher la caméra 10 minutes sur le mur vidéo (flux secondaire). Compter les images par seconde (compteur d'ffmpeg ou de la caméra) et mesurer le retard : agiter un chronomètre devant la caméra et comparer à l'écran.

**Résultat attendu** : Au moins 8 images par seconde, sans saccade ni gel, et retard inférieur ou égal à 3 s.

**Mesure** `images_par_s` — Images par seconde : au moins 8 i/s. Valeur relevée : ________ i/s

**Mesure** `retard_image_s` — Retard de l'image : au plus 3 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Heure de la caméra `heure-camera` — OBLIGATOIRE

**À faire** : Comparer l'heure incrustée de la caméra à l'heure du PSIM (synchronisée NTP).

**Résultat attendu** : Écart inférieur ou égal à 5 s (au-delà, ONVIF peut refuser les identifiants).

**Mesure** `ecart_heure_s` — Écart d'heure : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Image de nuit `nuit` — OBLIGATOIRE

**À faire** : À la nuit tombée (ou pièce noire avec seulement l'éclairage IR de la caméra), placer une personne de référence à distances croissantes (5, 10, 15, 20 m). Noter la plus grande distance où l'on distingue une personne.

**Résultat attendu** : Personne distinguée à au moins 10 m ; pas de voile ni de reflet de l'infrarouge sur le support.

**Mesure** `distance_nuit_m` — Distance de détection de nuit : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Autonomie sans soleil `solaire-autonomie` — OBLIGATOIRE

**À faire** : Batterie pleine, panneau occulté : laisser la caméra fonctionner (flux actif en continu au débit prévu) jusqu'à l'arrêt ou jusqu'à 72 h. Noter la durée tenue et la tension de batterie toutes les 6 h.

**Résultat attendu** : Au moins 72 h sans soleil (3 jours), sans redémarrage intempestif.

**Mesure** `autonomie_h` — Autonomie sans soleil : au moins 72 h. Valeur relevée : ________ h

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Liaison 4G `reseau-4g` — OBLIGATOIRE

**À faire** : Mesurer le débit montant 4G au site (test de débit) à trois heures de la journée. Afficher la caméra par la 4G (flux secondaire). Noter la consommation de données par jour.

**Résultat attendu** : Débit montant d'au moins 1 Mbit/s et image fluide ; consommation journalière notée pour dimensionner le forfait.

**Mesure** `debit_montant_kbps` — Débit montant 4G : au moins 1000 kbit/s. Valeur relevée : ________ kbit/s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la caméra (débrancher le PoE ou le 12 V) pendant 5 minutes sans toucher au PSIM. Noter l'heure.

**Résultat attendu** : Le PSIM détecte la perte après 3 mesures consécutives : « caméra hors ligne » est inscrit au journal, et l'écran Système le montre. Aucune image figée n'est présentée comme directe.

**Mesure** `liaison_perdue_s` — Délai jusqu'à « hors ligne » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'alimentation. Noter l'heure.

**Résultat attendu** : La caméra repasse « en ligne » seule et l'image revient en moins de 2 minutes, sans intervention.

**Mesure** `reprise_s` — Délai de reprise de l'image : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 12. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, attendre 60 s, le relancer.

**Résultat attendu** : La caméra est retrouvée sans reconfiguration et son image revient en moins de 60 s ; ses identifiants sont toujours lisibles (la clé de chiffrement est intacte).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 13. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — OBLIGATOIRE

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 14. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 14 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le chemin RTSP et le format d'image réglés sont notés au dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une image figée affichée comme directe après une coupure de la caméra.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-thermique"></a>

## Fiche de recette : Caméras IP ONVIF / RTSP (fixe, PTZ, panoramique, solaire 4G, thermique)

**Profil : Caméra thermique** (`thermique`)  
Fiche `camera-onvif` version 1 — empreinte `6167c809f0bcfe8b`  
Référence : README.md (section « Brancher une caméra ONVIF réelle ») ; docs/MISE-EN-SERVICE.md

> Qualification d'un modèle de caméra IP raccordée directement au PSIM : découverte ONVIF, image RTSP, fluidité, nuit, reprise après coupure ; points propres au PTZ, au panoramique, au solaire 4G et au thermique.

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

- La caméra à qualifier, son alimentation (PoE ou 12 V) et son support
- Switch PoE (ou injecteur), câbles ; PC de recette avec ffmpeg installé, PSIM hors production
- Chronomètre, luxmètre ou conditions de nuit réelles, cible de test (personne, panneau lisible) à distance connue, mètre laser
- Solaire 4G : carte SIM de test, panneau et batterie fournis, accès à un lieu ensoleillé puis occulté
- Thermique : cible chaude (personne, bouteille d'eau chaude) à distance connue

### Montage du banc d'essai

1. Brancher la caméra sur le switch PoE, lui donner une adresse IP fixe ; créer un compte en lecture seule dédié au PSIM ; régler son heure (NTP).
2. Dans le PSIM de recette, créer la caméra BANC-01 (Source vidéo : Caméra réseau ONVIF, ou flux direct RTSP).
3. Régler le flux secondaire pour l'affichage (résolution basse, 10 à 15 images/s) ; noter le chemin RTSP.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Caméra).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Découverte ONVIF `onvif-decouverte` — facultative

**À faire** : Dans l'éditeur de la caméra, « Rechercher sur le réseau » (ONVIF). Si la caméra n'est pas trouvée, saisir son adresse à la main.

**Résultat attendu** : La caméra est trouvée par la recherche, ou saisie manuelle réussie. Noter si la multidiffusion est bloquée sur le réseau du site.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Image affichée (« Enregistrer et tester ») `image` — OBLIGATOIRE

**À faire** : Cliquer « Enregistrer et tester ». Relever la taille reçue et le format affiché indiqués par le PSIM. Comparer l'image du PSIM à celle de l'interface de la caméra.

**Résultat attendu** : Une image nette et à l'endroit s'affiche en moins de 10 s ; proportions correctes (pas d'image écrasée) ; message d'erreur clair si on saisit un mauvais mot de passe (testé à l'étape suivante).

**Mesure** `delai_image_s` — Délai jusqu'à la première image : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Identifiants refusés `identifiants` — OBLIGATOIRE

**À faire** : Saisir un mauvais mot de passe, puis le bon. Noter le message du PSIM et vérifier que la caméra ne verrouille pas le compte après 3 essais.

**Résultat attendu** : Le message nomme la cause probable (identifiants refusés). Le compte n'est pas verrouillé par les essais du PSIM. Le bon mot de passe fonctionne aussitôt.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Fluidité et latence de l'image `fluidite` — OBLIGATOIRE

**À faire** : Afficher la caméra 10 minutes sur le mur vidéo (flux secondaire). Compter les images par seconde (compteur d'ffmpeg ou de la caméra) et mesurer le retard : agiter un chronomètre devant la caméra et comparer à l'écran.

**Résultat attendu** : Au moins 8 images par seconde, sans saccade ni gel, et retard inférieur ou égal à 3 s.

**Mesure** `images_par_s` — Images par seconde : au moins 8 i/s. Valeur relevée : ________ i/s

**Mesure** `retard_image_s` — Retard de l'image : au plus 3 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Heure de la caméra `heure-camera` — OBLIGATOIRE

**À faire** : Comparer l'heure incrustée de la caméra à l'heure du PSIM (synchronisée NTP).

**Résultat attendu** : Écart inférieur ou égal à 5 s (au-delà, ONVIF peut refuser les identifiants).

**Mesure** `ecart_heure_s` — Écart d'heure : au plus 5 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Image de nuit `nuit` — OBLIGATOIRE

**À faire** : À la nuit tombée (ou pièce noire avec seulement l'éclairage IR de la caméra), placer une personne de référence à distances croissantes (5, 10, 15, 20 m). Noter la plus grande distance où l'on distingue une personne.

**Résultat attendu** : Personne distinguée à au moins 10 m ; pas de voile ni de reflet de l'infrarouge sur le support.

**Mesure** `distance_nuit_m` — Distance de détection de nuit : au moins 10 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Détection thermique `thermique-detection` — OBLIGATOIRE

**À faire** : Placer une personne (ou une source chaude à 37 °C) à 20, 50 et 100 m. Noter la plus grande distance où elle est nettement visible et distinguée du fond.

**Résultat attendu** : Personne distinguée à au moins 50 m, de jour comme de nuit.

**Mesure** `distance_thermique_m` — Distance de détection thermique : au moins 50 m. Valeur relevée : ________ m

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 10. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Couper l'alimentation de la caméra (débrancher le PoE ou le 12 V) pendant 5 minutes sans toucher au PSIM. Noter l'heure.

**Résultat attendu** : Le PSIM détecte la perte après 3 mesures consécutives : « caméra hors ligne » est inscrit au journal, et l'écran Système le montre. Aucune image figée n'est présentée comme directe.

**Mesure** `liaison_perdue_s` — Délai jusqu'à « hors ligne » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rétablir l'alimentation. Noter l'heure.

**Résultat attendu** : La caméra repasse « en ligne » seule et l'image revient en moins de 2 minutes, sans intervention.

**Mesure** `reprise_s` — Délai de reprise de l'image : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 12. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, attendre 60 s, le relancer.

**Résultat attendu** : La caméra est retrouvée sans reconfiguration et son image revient en moins de 60 s ; ses identifiants sont toujours lisibles (la clé de chiffrement est intacte).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 13. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — OBLIGATOIRE

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 14. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 13 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le chemin RTSP et le format d'image réglés sont notés au dossier du modèle.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une image figée affichée comme directe après une coupure de la caméra.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


