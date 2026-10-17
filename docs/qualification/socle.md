<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Socle technique : mini-PC, onduleur du poste, routeur 4G, switch PoE, parafoudre

> Qualification des équipements d'infrastructure du pack : démarrage automatique du poste, autonomie de l'onduleur, reprise du routeur 4G, budget PoE du switch, parafoudre.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`mini-pc`](#profil-mini-pc) | Mini-PC du PSIM | 6 sur 7 |
| [`onduleur`](#profil-onduleur) | Onduleur du poste PSIM | 4 sur 6 |
| [`routeur-4g`](#profil-routeur-4g) | Routeur 4G | 5 sur 6 |
| [`switch-poe`](#profil-switch-poe) | Switch PoE | 5 sur 6 |
| [`parafoudre`](#profil-parafoudre) | Parafoudre | 4 sur 4 |

<a id="profil-mini-pc"></a>

## Fiche de recette : Socle technique : mini-PC, onduleur du poste, routeur 4G, switch PoE, parafoudre

**Profil : Mini-PC du PSIM** (`mini-pc`)  
Fiche `socle` version 1 — empreinte `68615c4fd1f86afa`  
Référence : docs/MISE-EN-SERVICE.md (sections 0, 1, 7, 8) ; deploy/

> Qualification des équipements d'infrastructure du pack : démarrage automatique du poste, autonomie de l'onduleur, reprise du routeur 4G, budget PoE du switch, parafoudre.

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

- L'équipement à qualifier et son câblage complet tel que posé en pack
- Charge réelle du pack (caméras, switch, routeur) ou son équivalent mesuré au wattmètre
- Wattmètre, multimètre, chronomètre, thermo-hygromètre étalonné ; testeur de terre pour le parafoudre
- PSIM de recette installé comme en exploitation (tâche de démarrage de Windows ou systemd)

### Montage du banc d'essai

1. Monter le pack complet sur table comme sur site : mini-PC, onduleur, routeur 4G, switch PoE, caméras, parafoudre.
2. Installer le PSIM de recette avec la tâche de démarrage prévue (`scripts/windows-service.ps1` ou `deploy/psim.service`).
3. Déclarer l'équipement à essayer comme indiqué dans la fiche du profil.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (infrastructure)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. Démarrage automatique après coupure `demarrage-auto` — OBLIGATOIRE

**À faire** : Débrancher brutalement le mini-PC (arrachement de l'alimentation), le rebrancher, ne rien toucher et chronométrer jusqu'à l'affichage du PSIM sur un autre poste.

**Résultat attendu** : Le PSIM redémarre seul, sans identification, et répond en moins de 5 minutes ; la période sans surveillance est journalisée et notifiée.

**Mesure** `demarrage_min` — Délai de remise en service : au plus 5 min. Valeur relevée : ________ min

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Tenue en charge `charge-poste` — OBLIGATOIRE

**À faire** : Afficher les 4 caméras du pack pendant 4 h avec la détection active. Relever l'utilisation du processeur, de la mémoire et la température du processeur.

**Résultat attendu** : Processeur à moins de 70 % en moyenne, mémoire sans fuite, température inférieure à 80 °C, aucune image figée.

**Mesure** `cpu_moyen_pct` — Processeur moyen : au plus 70 %. Valeur relevée : ________ %

**Mesure** `temp_cpu_c` — Température processeur maximale : au plus 80 °C. Valeur relevée : ________ °C

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 5. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Le processus est relancé par le superviseur ou la tâche planifiée en moins de 2 minutes ; la période sans surveillance est journalisée ; une notification part.

**Mesure** `relance_s` — Délai de relance du PSIM : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 6. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si disponible, sinon mesurer sur site dans le local technique le plus chaud (thermo-hygromètre étalonné). Relever la température de l'équipement (sonde ou valeur interne) en fonctionnement à pleine charge.

**Résultat attendu** : Aucun redémarrage, aucune dégradation de débit ou d'autonomie, température interne sous la limite du fabricant. Sinon « na » avec la raison.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 7. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 6 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement d'infrastructure qui redémarre ou se bloque pendant l'essai sans reprise automatique.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-onduleur"></a>

## Fiche de recette : Socle technique : mini-PC, onduleur du poste, routeur 4G, switch PoE, parafoudre

**Profil : Onduleur du poste PSIM** (`onduleur`)  
Fiche `socle` version 1 — empreinte `9b471122969a4d70`  
Référence : docs/MISE-EN-SERVICE.md (sections 0, 1, 7, 8) ; deploy/

> Qualification des équipements d'infrastructure du pack : démarrage automatique du poste, autonomie de l'onduleur, reprise du routeur 4G, budget PoE du switch, parafoudre.

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

- L'équipement à qualifier et son câblage complet tel que posé en pack
- Charge réelle du pack (caméras, switch, routeur) ou son équivalent mesuré au wattmètre
- Wattmètre, multimètre, chronomètre, thermo-hygromètre étalonné ; testeur de terre pour le parafoudre
- PSIM de recette installé comme en exploitation (tâche de démarrage de Windows ou systemd)

### Montage du banc d'essai

1. Monter le pack complet sur table comme sur site : mini-PC, onduleur, routeur 4G, switch PoE, caméras, parafoudre.
2. Installer le PSIM de recette avec la tâche de démarrage prévue (`scripts/windows-service.ps1` ou `deploy/psim.service`).
3. Déclarer l'équipement à essayer comme indiqué dans la fiche du profil.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (infrastructure)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. Coupure secteur et autonomie `coupure-secteur` — OBLIGATOIRE

**À faire** : Charge complète branchée, batterie pleine : couper le secteur et chronométrer jusqu'à l'arrêt de la charge. Rétablir le secteur.

**Résultat attendu** : Le poste et le switch tiennent au moins 30 minutes ; l'arrêt propre du poste (si configuré) a lieu avant l'épuisement ; au retour du secteur tout redémarre seul.

**Mesure** `autonomie_min` — Autonomie sur la charge du pack : au moins 30 min. Valeur relevée : ________ min

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Recharge de la batterie `recharge` — facultative

**À faire** : Après la décharge, mesurer le temps pour retrouver 80 % de charge.

**Résultat attendu** : Retour à 80 % en moins de 8 heures.

**Mesure** `recharge_h` — Délai de recharge à 80 % : au plus 8 h. Valeur relevée : ________ h

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 5. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si disponible, sinon mesurer sur site dans le local technique le plus chaud (thermo-hygromètre étalonné). Relever la température de l'équipement (sonde ou valeur interne) en fonctionnement à pleine charge.

**Résultat attendu** : Aucun redémarrage, aucune dégradation de débit ou d'autonomie, température interne sous la limite du fabricant. Sinon « na » avec la raison.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 6. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 4 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement d'infrastructure qui redémarre ou se bloque pendant l'essai sans reprise automatique.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-routeur-4g"></a>

## Fiche de recette : Socle technique : mini-PC, onduleur du poste, routeur 4G, switch PoE, parafoudre

**Profil : Routeur 4G** (`routeur-4g`)  
Fiche `socle` version 1 — empreinte `c8c4f4afa76a36d9`  
Référence : docs/MISE-EN-SERVICE.md (sections 0, 1, 7, 8) ; deploy/

> Qualification des équipements d'infrastructure du pack : démarrage automatique du poste, autonomie de l'onduleur, reprise du routeur 4G, budget PoE du switch, parafoudre.

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

- L'équipement à qualifier et son câblage complet tel que posé en pack
- Charge réelle du pack (caméras, switch, routeur) ou son équivalent mesuré au wattmètre
- Wattmètre, multimètre, chronomètre, thermo-hygromètre étalonné ; testeur de terre pour le parafoudre
- PSIM de recette installé comme en exploitation (tâche de démarrage de Windows ou systemd)

### Montage du banc d'essai

1. Monter le pack complet sur table comme sur site : mini-PC, onduleur, routeur 4G, switch PoE, caméras, parafoudre.
2. Installer le PSIM de recette avec la tâche de démarrage prévue (`scripts/windows-service.ps1` ou `deploy/psim.service`).
3. Déclarer l'équipement à essayer comme indiqué dans la fiche du profil.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (infrastructure)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. Débit 4G au site `routeur-debit` — OBLIGATOIRE

**À faire** : Mesurer le débit montant et descendant (test de débit) à trois heures de la journée, au site d'installation (ou équivalent).

**Résultat attendu** : Débit montant d'au moins 2 Mbit/s en moyenne.

**Mesure** `debit_montant_mbps` — Débit montant moyen : au moins 2 Mbit/s. Valeur relevée : ________ Mbit/s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 4. Coupure du routeur 4G `routeur-coupure` — OBLIGATOIRE

**À faire** : Couper l'alimentation du routeur 4G 5 minutes, le rétablir sans autre geste. Chronométrer le retour d'Internet (signal de supervision externe reçu).

**Résultat attendu** : Le routeur se reconnecte seul ; la supervision externe alerte pendant la coupure puis revient.

**Mesure** `reprise_4g_s` — Délai de retour d'Internet : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 5. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si disponible, sinon mesurer sur site dans le local technique le plus chaud (thermo-hygromètre étalonné). Relever la température de l'équipement (sonde ou valeur interne) en fonctionnement à pleine charge.

**Résultat attendu** : Aucun redémarrage, aucune dégradation de débit ou d'autonomie, température interne sous la limite du fabricant. Sinon « na » avec la raison.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 6. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 5 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement d'infrastructure qui redémarre ou se bloque pendant l'essai sans reprise automatique.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-switch-poe"></a>

## Fiche de recette : Socle technique : mini-PC, onduleur du poste, routeur 4G, switch PoE, parafoudre

**Profil : Switch PoE** (`switch-poe`)  
Fiche `socle` version 1 — empreinte `c09526123635e57d`  
Référence : docs/MISE-EN-SERVICE.md (sections 0, 1, 7, 8) ; deploy/

> Qualification des équipements d'infrastructure du pack : démarrage automatique du poste, autonomie de l'onduleur, reprise du routeur 4G, budget PoE du switch, parafoudre.

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

- L'équipement à qualifier et son câblage complet tel que posé en pack
- Charge réelle du pack (caméras, switch, routeur) ou son équivalent mesuré au wattmètre
- Wattmètre, multimètre, chronomètre, thermo-hygromètre étalonné ; testeur de terre pour le parafoudre
- PSIM de recette installé comme en exploitation (tâche de démarrage de Windows ou systemd)

### Montage du banc d'essai

1. Monter le pack complet sur table comme sur site : mini-PC, onduleur, routeur 4G, switch PoE, caméras, parafoudre.
2. Installer le PSIM de recette avec la tâche de démarrage prévue (`scripts/windows-service.ps1` ou `deploy/psim.service`).
3. Déclarer l'équipement à essayer comme indiqué dans la fiche du profil.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (infrastructure)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. Budget PoE `poe-budget` — OBLIGATOIRE

**À faire** : Brancher toutes les caméras du pack à pleine charge (infrarouge allumé) ; relever au wattmètre la puissance totale et comparer au budget PoE annoncé du switch.

**Résultat attendu** : Puissance consommée inférieure à 80 % du budget PoE ; aucune caméra ne redémarre.

**Mesure** `poe_pct_budget` — Puissance PoE / budget : au plus 80 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 4. Reprise du switch PoE `poe-reprise` — OBLIGATOIRE

**À faire** : Couper puis rétablir l'alimentation du switch ; chronométrer le retour de toutes les caméras dans le PSIM.

**Résultat attendu** : Toutes les caméras reviennent seules en moins de 2 minutes.

**Mesure** `reprise_poe_s` — Délai de retour des caméras : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 5. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si disponible, sinon mesurer sur site dans le local technique le plus chaud (thermo-hygromètre étalonné). Relever la température de l'équipement (sonde ou valeur interne) en fonctionnement à pleine charge.

**Résultat attendu** : Aucun redémarrage, aucune dégradation de débit ou d'autonomie, température interne sous la limite du fabricant. Sinon « na » avec la raison.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 6. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 5 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement d'infrastructure qui redémarre ou se bloque pendant l'essai sans reprise automatique.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-parafoudre"></a>

## Fiche de recette : Socle technique : mini-PC, onduleur du poste, routeur 4G, switch PoE, parafoudre

**Profil : Parafoudre** (`parafoudre`)  
Fiche `socle` version 1 — empreinte `b5cb3dd18e7ba1cb`  
Référence : docs/MISE-EN-SERVICE.md (sections 0, 1, 7, 8) ; deploy/

> Qualification des équipements d'infrastructure du pack : démarrage automatique du poste, autonomie de l'onduleur, reprise du routeur 4G, budget PoE du switch, parafoudre.

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

- L'équipement à qualifier et son câblage complet tel que posé en pack
- Charge réelle du pack (caméras, switch, routeur) ou son équivalent mesuré au wattmètre
- Wattmètre, multimètre, chronomètre, thermo-hygromètre étalonné ; testeur de terre pour le parafoudre
- PSIM de recette installé comme en exploitation (tâche de démarrage de Windows ou systemd)

### Montage du banc d'essai

1. Monter le pack complet sur table comme sur site : mini-PC, onduleur, routeur 4G, switch PoE, caméras, parafoudre.
2. Installer le PSIM de recette avec la tâche de démarrage prévue (`scripts/windows-service.ps1` ou `deploy/psim.service`).
3. Déclarer l'équipement à essayer comme indiqué dans la fiche du profil.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (infrastructure)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 3. Contrôle du parafoudre `parafoudre-controle` — OBLIGATOIRE

**À faire** : Contrôler le montage selon la notice (calibre, câble de terre court et droit), le témoin d'état, et mesurer la résistance de la prise de terre au testeur de terre.

**Résultat attendu** : Témoin en bon état ; résistance de terre inférieure ou égale à 10 ohms.

**Mesure** `terre_ohm` — Résistance de terre : au plus 10 Ω. Valeur relevée : ________ Ω

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 4. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 4 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un équipement d'infrastructure qui redémarre ou se bloque pendant l'essai sans reprise automatique.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


