<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Supervision d'onduleur (module « ups » de la passerelle, NUT ou SNMP)

> Qualification d'un onduleur (ou d'une carte réseau d'onduleur) lu par la passerelle : coupure secteur, batterie faible, mesures de charge, d'autonomie et de tension.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`nut-usb`](#profil-nut-usb) | Onduleur USB lu par NUT | 16 sur 17 |
| [`snmp`](#profil-snmp) | Onduleur avec carte réseau SNMP | 16 sur 17 |

<a id="profil-nut-usb"></a>

## Fiche de recette : Supervision d'onduleur (module « ups » de la passerelle, NUT ou SNMP)

**Profil : Onduleur USB lu par NUT** (`nut-usb`)  
Fiche `onduleur` version 1 — empreinte `c8cf325f5ea41ba7`  
Référence : gateway/docs/ups.md ; docs/PASSERELLE.md

> Qualification d'un onduleur (ou d'une carte réseau d'onduleur) lu par la passerelle : coupure secteur, batterie faible, mesures de charge, d'autonomie et de tension.

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

- L'onduleur à qualifier avec sa batterie en bon état et chargée à 100 % depuis au moins 12 h
- Câble USB (NUT) ou carte réseau SNMP configurée (communauté en lecture seule)
- Charge de test connue (lampes ou résistances, 30 à 60 % de la puissance nominale) et wattmètre
- Multimètre pour la tension de batterie ; chronomètre ; thermo-hygromètre étalonné
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module ups configuré

### Montage du banc d'essai

1. Brancher la charge de test sur l'onduleur et l'onduleur sur une prise commandée par un interrupteur (pour couper le secteur franchement).
2. NUT : vérifier avec `upsc` que `ups.status`, `battery.charge` et `battery.runtime` sont lisibles ; SNMP : vérifier avec `snmpwalk` les objets de l'UPS-MIB listés dans la documentation du module.
3. Déclarer l'onduleur dans le module ups (identifiants PSIM pour `status`, `charge`, `runtime`…), identifiant principal BANC-01.
4. Dans le PSIM de recette, créer les détecteurs (catégorie Énergie), régler la supervision à 900 s et les seuils conseillés par la documentation.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Énergie).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Démarrer la passerelle : le premier relevé envoie « Normal » une fois, puis les mesures. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Couper le secteur à l'interrupteur de la prise commandée : l'onduleur passe sur batterie. Noter l'heure. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Coupure secteur » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Coupure secteur » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Rétablir le secteur ; attendre « Courant rétabli ».

**Résultat attendu** : L'état revient à Normal en moins de 60 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois la coupure secteur de 20 s puis le rétablissement (laisser 40 s entre deux cycles), en acquittant et clôturant l'incident entre deux cycles.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 30 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Laisser l'onduleur sur batterie, charge branchée, jusqu'au seuil de batterie faible de l'onduleur (le module envoie « Batterie faible »). Rétablir le secteur dès l'alerte. Noter la tension de batterie au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Autonomie réelle `autonomie` — OBLIGATOIRE

**À faire** : Batterie pleine, secteur coupé, charge de test branchée : mesurer la durée réelle jusqu'à la batterie faible. Comparer à l'autonomie annoncée par le module dans le PSIM (`runtime`).

**Résultat attendu** : Autonomie réelle d'au moins 10 minutes sur la charge du pack (valeur de dimensionnement), et écart avec l'autonomie annoncée par l'onduleur inférieur à 30 %.

**Mesure** `autonomie_min` — Autonomie réelle mesurée : au moins 10 min. Valeur relevée : ________ min

**Mesure** `ecart_autonomie_pct` — Écart avec l'autonomie annoncée : au plus 30 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Justesse des mesures `justesse-mesures` — OBLIGATOIRE

**À faire** : Comparer la tension de batterie, la charge de l'onduleur (%) et la tension d'entrée affichées dans le PSIM aux mesures du multimètre et du wattmètre.

**Résultat attendu** : Tension de batterie à 0,5 V près, charge à 10 points près.

**Mesure** `ecart_tension_batterie_v` — Écart de tension de batterie : au plus 0.5 V. Valeur relevée : ________ V

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble USB (NUT) ou le câble réseau de la carte SNMP. Noter que la passerelle envoie « Défaut » une seule fois après `maxFailures` échecs. Noter l'heure.

**Résultat attendu** : En moins de 120 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Arrêter le module ups (ou la passerelle) en laissant l'onduleur et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 900 s (3 fois la période de lecture majorée du signe de vie de 300 s) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 1000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 1000 s. Valeur relevée : ________ s

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

**À faire** : Mesurer la température de la batterie de l'onduleur (sonde ou valeur `ups.temperature`) dans le local le plus chaud du site, à pleine charge de test pendant 1 h. Noter température ambiante et humidité. Une batterie plomb vieillit vite au-dessus de 30 °C : noter la durée de vie annoncée à cette température.

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
- Les 16 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les identifiants PSIM `status`, `charge`, `runtime` sont tous lus sur le modèle (une grandeur absente est notée et retirée de la configuration).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une coupure secteur réelle non signalée, ou signalée sans que « Courant rétabli » arrive au retour.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-snmp"></a>

## Fiche de recette : Supervision d'onduleur (module « ups » de la passerelle, NUT ou SNMP)

**Profil : Onduleur avec carte réseau SNMP** (`snmp`)  
Fiche `onduleur` version 1 — empreinte `774086ad715215d8`  
Référence : gateway/docs/ups.md ; docs/PASSERELLE.md

> Qualification d'un onduleur (ou d'une carte réseau d'onduleur) lu par la passerelle : coupure secteur, batterie faible, mesures de charge, d'autonomie et de tension.

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

- L'onduleur à qualifier avec sa batterie en bon état et chargée à 100 % depuis au moins 12 h
- Câble USB (NUT) ou carte réseau SNMP configurée (communauté en lecture seule)
- Charge de test connue (lampes ou résistances, 30 à 60 % de la puissance nominale) et wattmètre
- Multimètre pour la tension de batterie ; chronomètre ; thermo-hygromètre étalonné
- Poste de recette : PSIM hors production et Passerelle GAMR avec le module ups configuré

### Montage du banc d'essai

1. Brancher la charge de test sur l'onduleur et l'onduleur sur une prise commandée par un interrupteur (pour couper le secteur franchement).
2. NUT : vérifier avec `upsc` que `ups.status`, `battery.charge` et `battery.runtime` sont lisibles ; SNMP : vérifier avec `snmpwalk` les objets de l'UPS-MIB listés dans la documentation du module.
3. Déclarer l'onduleur dans le module ups (identifiants PSIM pour `status`, `charge`, `runtime`…), identifiant principal BANC-01.
4. Dans le PSIM de recette, créer les détecteurs (catégorie Énergie), régler la supervision à 900 s et les seuils conseillés par la documentation.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Énergie).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Démarrer la passerelle : le premier relevé envoie « Normal » une fois, puis les mesures. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Couper le secteur à l'interrupteur de la prise commandée : l'onduleur passe sur batterie. Noter l'heure. Noter l'heure exacte du geste.

**Résultat attendu** : Une alarme « Coupure secteur » s'ouvre. L'incident porte le bon nom, la bonne zone et le motif « Coupure secteur » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Rétablir le secteur ; attendre « Courant rétabli ».

**Résultat attendu** : L'état revient à Normal en moins de 60 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Répétabilité `repeat` — OBLIGATOIRE

**À faire** : Répéter 10 fois la coupure secteur de 20 s puis le rétablissement (laisser 40 s entre deux cycles), en acquittant et clôturant l'incident entre deux cycles.

**Résultat attendu** : 10 cycles sur 10 : chaque déclenchement ouvre un incident, aucun n'est manqué, aucun n'est doublé.

**Mesure** `cycles_reussis` — Cycles réussis : au moins 10 cycles. Valeur relevée : ________ cycles

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 30 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Batterie faible `lowbat` — OBLIGATOIRE

**À faire** : Laisser l'onduleur sur batterie, charge branchée, jusqu'au seuil de batterie faible de l'onduleur (le module envoie « Batterie faible »). Rétablir le secteur dès l'alerte. Noter la tension de batterie au multimètre.

**Résultat attendu** : Le détecteur passe en Défaut (« batterie faible » ou équivalent), jamais en Normal, avec notification. Une alarme survenant pendant le défaut n'est pas masquée : elle l'emporte.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Autonomie réelle `autonomie` — OBLIGATOIRE

**À faire** : Batterie pleine, secteur coupé, charge de test branchée : mesurer la durée réelle jusqu'à la batterie faible. Comparer à l'autonomie annoncée par le module dans le PSIM (`runtime`).

**Résultat attendu** : Autonomie réelle d'au moins 10 minutes sur la charge du pack (valeur de dimensionnement), et écart avec l'autonomie annoncée par l'onduleur inférieur à 30 %.

**Mesure** `autonomie_min` — Autonomie réelle mesurée : au moins 10 min. Valeur relevée : ________ min

**Mesure** `ecart_autonomie_pct` — Écart avec l'autonomie annoncée : au plus 30 %. Valeur relevée : ________ %

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Justesse des mesures `justesse-mesures` — OBLIGATOIRE

**À faire** : Comparer la tension de batterie, la charge de l'onduleur (%) et la tension d'entrée affichées dans le PSIM aux mesures du multimètre et du wattmètre.

**Résultat attendu** : Tension de batterie à 0,5 V près, charge à 10 points près.

**Mesure** `ecart_tension_batterie_v` — Écart de tension de batterie : au plus 0.5 V. Valeur relevée : ________ V

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble USB (NUT) ou le câble réseau de la carte SNMP. Noter que la passerelle envoie « Défaut » une seule fois après `maxFailures` échecs. Noter l'heure.

**Résultat attendu** : En moins de 120 s l'équipement n'est plus affiché « Normal » : il passe en Défaut ou Hors ligne, avec notification. Il ne reste JAMAIS Normal faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 120 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Arrêter le module ups (ou la passerelle) en laissant l'onduleur et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à 900 s (3 fois la période de lecture majorée du signe de vie de 300 s) (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 1000 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 1000 s. Valeur relevée : ________ s

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

**À faire** : Mesurer la température de la batterie de l'onduleur (sonde ou valeur `ups.temperature`) dans le local le plus chaud du site, à pleine charge de test pendant 1 h. Noter température ambiante et humidité. Une batterie plomb vieillit vite au-dessus de 30 °C : noter la durée de vie annoncée à cette température.

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
- Les 16 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Les identifiants PSIM `status`, `charge`, `runtime` sont tous lus sur le modèle (une grandeur absente est notée et retirée de la configuration).

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une coupure secteur réelle non signalée, ou signalée sans que « Courant rétabli » arrive au retour.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


