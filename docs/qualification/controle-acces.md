<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Contrôle d'accès (modules « acces-dahua » et « acces-zkteco » de la passerelle) : contrôleurs, lecteurs, serrures, barrières

> Qualification en atelier d'un contrôleur de 1 à 4 portes (ou d'un terminal), d'un lecteur de badge, d'une serrure à sécurité positive ou d'une barrière raccordés à la passerelle. Chaque porte est un détecteur PSIM de catégorie « access ».

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`controleur`](#profil-controleur) | Contrôleur de 1 à 4 portes | 28 sur 29 |
| [`terminal`](#profil-terminal) | Terminal de contrôle d'accès autonome (lecteur et contrôleur dans le même boîtier) | 29 sur 30 |
| [`lecteur`](#profil-lecteur) | Lecteur de badge (passe par le contrôleur) | 13 sur 14 |
| [`serrure`](#profil-serrure) | Serrure, ventouse ou gâche à sécurité positive (passe par le contrôleur) | 21 sur 22 |
| [`barriere`](#profil-barriere) | Barrière ou portail (passe par le contrôleur) | 13 sur 17 |

<a id="profil-controleur"></a>

## Fiche de recette : Contrôle d'accès (modules « acces-dahua » et « acces-zkteco » de la passerelle) : contrôleurs, lecteurs, serrures, barrières

**Profil : Contrôleur de 1 à 4 portes** (`controleur`)  
Fiche `controle-acces` version 1 — empreinte `387ff58fbd5feb73`  
Référence : docs/PRD-CONTROLE-ACCES.md (sections 7, 8.9 et 10) ; docs/CONTROLE-ACCES.md (contrat commun, sections 1 et 2) ; docs/COMMANDES.md (canal de commande signé) ; docs/PASSERELLE.md

> Qualification en atelier d'un contrôleur de 1 à 4 portes (ou d'un terminal), d'un lecteur de badge, d'une serrure à sécurité positive ou d'une barrière raccordés à la passerelle. Chaque porte est un détecteur PSIM de catégorie « access ».

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

- Le matériel à qualifier : contrôleur ou terminal avec sa notice, son alimentation et sa batterie ; au moins un lecteur de badge, une serrure (ventouse ou gâche) et un contact de porte raccordés, une porte d'essai réelle ou une maquette de porte
- Badges d'essai : un badge MIFARE chiffré accepté, un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires ; un badge ou une carte EM 125 kHz pour vérifier qu'elle n'est pas acceptée
- Pour une barrière ou un portail : une barrière complète avec ses cellules et sa boucle de détection, un obstacle souple et inoffensif pour les essais de sécurité (jamais une personne ni un véhicule réel)
- Switch, câbles ; poste de recette (PSIM hors production + Passerelle GAMR avec le module d'accès de la marque)
- Canal de commande signé configuré sur le banc (lot AC0), accès à l'alimentation de chaque élément pour la couper
- Chronomètre ; possibilité de décaler l'horloge du contrôleur

### Montage du banc d'essai

1. Raccorder le contrôleur, le lecteur, la serrure et le contact de porte comme sur site ; adresse IP fixe pour le contrôleur, accès par la passerelle seule. Les identifiants du contrôleur ne sont notés nulle part sur la fiche.
2. Dans la passerelle : module « acces-dahua » ou « acces-zkteco » avec le contrôleur et ses portes ; dans le PSIM de recette : un détecteur de catégorie « access » par porte, PORTE-BANC-01 pour la porte de référence.
3. Créer dans le contrôleur les badges d'essai (accepté, expiré, hors horaire) ; laisser un badge inconnu.
4. Pour les ordres à distance : lier la porte de référence à un actionneur « lock » ou « gate » du canal de commande signé.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Réglages du matériel `acc-reglages` — OBLIGATOIRE

**À faire** : Relever et noter : adresse du contrôleur, nombre de portes déclarées, heure du contrôleur (réglée sur NTP ou à la main), mode de raccordement du lecteur (Wiegand ou OSDP), type de serrure (ventouse, gâche, autre) et sécurité de la serrure (positive ou négative, selon la notice). Joindre une photo de l'écran ou de l'étiquette SANS les mots de passe.

**Résultat attendu** : Tous les réglages sont notés. Aucun identifiant ni mot de passe n'est écrit sur la fiche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact PORTE-BANC-01 (catégorie : Accès (porte d'essai)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Mettre le contrôleur sous tension et démarrer le module d'accès de la passerelle ; le signe de vie (« heartbeat », toutes les 60 s par défaut) arrive pour la porte. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Mémoire hors ligne du contrôleur `acc-memoire` — OBLIGATOIRE

**À faire** : Relever dans la notice du constructeur ET sur le contrôleur la capacité de la mémoire d'événements hors ligne. Noter les deux valeurs et leur source.

**Résultat attendu** : La capacité est d'au moins 50 000 événements. En dessous, le modèle est refusé (rejeté ou limité à un usage sans récupération de passages).

**Mesure** `memoire_evenements` — Capacité de la mémoire hors ligne : au moins 50000 événements. Valeur relevée : ________ événements

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 6. Badge accepté `acc-badge-accepte` — OBLIGATOIRE

**À faire** : Présenter le badge d'essai accepté à l'entrée de la porte de référence. Noter l'heure.

**Résultat attendu** : La porte s'ouvre par le contrôleur seul. Un passage « accepté » (badge_granted) arrive dans le PSIM avec l'heure du contrôleur, le numéro de badge, le sens et la méthode « badge ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Badge inconnu, expiré, hors horaire `acc-badge-refus` — OBLIGATOIRE

**À faire** : Présenter successivement : un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires. Un seul refus à la fois, avec plus d'une minute entre deux.

**Résultat attendu** : Chaque refus est un passage « refusé » (badge_denied) avec le bon motif (badge inconnu, expiré, hors horaire). La porte reste fermée. Un refus isolé n'ouvre AUCUN incident : il est seulement journalisé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Refus répétés (3 en 60 s) `acc-refus-repetes` — OBLIGATOIRE

**À faire** : Présenter 2 fois de suite un badge inconnu en moins de 60 s, vérifier, puis recommencer avec 3 refus en moins de 60 s sur la même porte.

**Résultat attendu** : Avec 2 refus : aucune pré-alarme. Au 3e refus en 60 s : « refus répétés » (badge_denied_repeated), une pré-alarme est ouverte sur la bonne porte ; les 3 refus restent journalisés.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Bouton de sortie `acc-sortie` — OBLIGATOIRE

**À faire** : Appuyer sur le bouton de sortie (ou utiliser le lecteur de sortie) pour sortir.

**Résultat attendu** : La porte s'ouvre. Un passage accepté avec la méthode « bouton de sortie » arrive dans le PSIM, sans numéro de badge.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sens entrée / sortie `acc-sens` — OBLIGATOIRE

**À faire** : Passer un badge accepté au lecteur d'entrée puis au lecteur de sortie (ou, pour un contrôleur à lecteur unique, noter que le sens n'est pas connu).

**Résultat attendu** : Le passage porte le sens correct (entrée ou sortie). Si le matériel ne donne pas le sens, le passage arrive sans sens (jamais un sens inventé).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Ouverture et fermeture de la porte `acc-ouverture-fermeture` — OBLIGATOIRE

**À faire** : Ouvrir la porte avec un badge accepté, la franchir, la refermer.

**Résultat attendu** : Les messages « porte ouverte » (door_opened) puis « porte fermée » (door_closed) arrivent dans l'ordre, sans alarme ; l'état revient à Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Forcer la porte d'essai SANS badge (ouvrir le vantail sans que le contrôleur ait commandé la serrure, ou simuler l'ouverture du contact de porte selon la notice). Noter l'heure exacte du geste.

**Résultat attendu** : Le module envoie « porte forcée » (door_forced) ; une alarme critique s'ouvre sur la bonne porte. L'incident porte le bon nom, la bonne zone et le motif « Porte forcée » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer la porte et remettre le contact de porte au repos.

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 10 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Porte maintenue ouverte `acc-maintenue` — OBLIGATOIRE

**À faire** : Ouvrir la porte avec un badge accepté et la laisser ouverte plus longtemps que le délai réglé dans le contrôleur. Noter le délai réglé et l'heure.

**Résultat attendu** : « Porte maintenue ouverte » (door_held_open) arrive : pré-alarme dans le PSIM ; elle devient une alarme après le délai réglé pour la porte. Refermer la porte : retour à Normal. Aucun signe de vie ne rajeunit une porte muette.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Sabotage (autoprotection) `tamper` — OBLIGATOIRE

**À faire** : Ouvrir le boîtier du contrôleur (ou du lecteur) pour déclencher son contact d'autoprotection, puis le refermer. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 17. Horloge du contrôleur déréglée `acc-horloge` — OBLIGATOIRE

**À faire** : Décaler l'horloge du contrôleur d'un peu moins de 2 minutes puis de plus de 2 minutes, attendre le prochain signe de vie, puis remettre l'horloge à l'heure.

**Résultat attendu** : En dessous de 2 minutes : aucun défaut. Au-delà : « horloge déréglée » (clock_drift) arrive, la porte passe en défaut avec le libellé « Horloge de l'équipement déréglée » ; elle revient à Normal une fois l'horloge corrigée. Les passages gardent l'heure du contrôleur.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 18. Signe de vie `acc-heartbeat` — OBLIGATOIRE

**À faire** : Observer pendant 5 minutes le journal de la passerelle et le PSIM, porte au repos. Noter l'intervalle réel entre deux signes de vie (60 s par défaut dans la passerelle).

**Résultat attendu** : Un signe de vie (heartbeat) arrive par porte, à l'intervalle réglé. L'état reste Normal et aucun incident ne s'ouvre.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 19. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du contrôleur (alimentation maintenue) plus longtemps que le délai de supervision du module. Noter l'heure.

**Résultat attendu** : En moins de 180 s la porte est affichée « Hors ligne » (state offline) pour chacune des portes du contrôleur, avec notification. Elle n'est JAMAIS affichée « fermée » ni « Normal » faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 20. Passages manqués récupérés après coupure du réseau `acc-differe` — OBLIGATOIRE

**À faire** : Avec le contrôleur coupé du réseau (câble débranché, alimentation maintenue), faire 5 passages par badge (acceptés et refusés) et ouvrir puis fermer la porte. Rebrancher le câble. Noter les identifiants d'événement du contrôleur.

**Résultat attendu** : Après la reprise, les 5 passages arrivent dans le PSIM, datés de l'heure du contrôleur, marqués « reçus en différé », sans passage perdu ni doublé (rejouer la récupération ne crée aucun doublon). La porte revient à l'état réel.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 21. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau du contrôleur. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 22. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Couper l'alimentation du contrôleur ET sa batterie en laissant la passerelle et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à le délai de supervision réglé pour le contrôleur dans la passerelle (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 300 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 23. Autonomie : le PSIM et la passerelle coupés `acc-autonomie` — OBLIGATOIRE

**À faire** : Arrêter la passerelle ET le PSIM de recette. Présenter successivement un badge accepté, un badge refusé, utiliser le bouton de sortie.

**Résultat attendu** : Le contrôleur décide seul : le badge accepté ouvre la porte, le refusé ne l'ouvre pas, le bouton de sortie fonctionne. Personne n'est bloqué ni dehors ni dedans. Remettre ensuite la passerelle et le PSIM en marche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 24. Redémarrage de la passerelle `acc-passerelle-redemarrage` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus de la passerelle (pas un arrêt propre), faire 2 passages par badge pendant qu'elle est arrêtée, attendre 60 s, la relancer.

**Résultat attendu** : Au redémarrage : la passerelle retrouve le contrôleur et ses portes sans reconfiguration ; les 2 passages arrivent (en différé, une seule fois chacun), aucun passage déjà reçu n'est doublé, l'état des portes est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 25. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 26. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 1 heure. Pendant la coupure, faire 5 passages par badge (acceptés et refusés) et ouvrir puis fermer la porte. Redémarrer le PSIM.

**Résultat attendu** : Après le rétablissement : les 5 passages arrivent datés de leur heure réelle (heure du contrôleur), marqués « reçu en différé » si besoin, sans aucun passage perdu ni doublé ; l'état final de la porte est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 27. Ouverture à distance par le canal signé `acc-ouverture-distance` — OBLIGATOIRE

**À faire** : Depuis le PSIM, avec une raison saisie et le mot de passe redemandé : (1) « Ouvrir (impulsion) », (2) « Ouvrir N minutes » avec N à quelques minutes, (3) attendre la fin du délai ou ordonner le retour à l'état normal. Essayer aussi un ordre refusé (mauvais mot de passe, ou ordre « toujours fermé »). Noter l'heure de chaque ordre et de chaque accusé.

**Résultat attendu** : L'impulsion ouvre la porte puis elle se referme seule. L'ouverture prolongée garde la porte déverrouillée puis revient à l'état normal à la fin du délai ou sur ordre. L'ordre refusé ne change rien. « Toujours fermé » n'existe pas : jamais de verrouillage permanent par ordre. Chaque ordre est accusé et journalisé avec sa raison ; le passage porte la méthode « ouverture à distance ». Le canal de commande est le seul chemin vers la serrure.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 28. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 29. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 28 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Une porte dont le contrôleur ne répond plus est affichée « Hors ligne », jamais « fermée » ni « Normal ».
- Aucun passage n'est perdu ni doublé après une coupure du réseau, du PSIM ou de la passerelle.
- Le contrôleur décide seul de l'ouverture par badge ; le PSIM n'intervient jamais dans cette décision.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une serrure d'issue de secours qui reste verrouillée sans courant, ou qu'un ordre à distance peut verrouiller.
- Un ordre à distance qui passe ailleurs que par le canal de commande signé, ou qui installe un « toujours fermé ».
- Un lecteur qui accepte une carte EM 125 kHz (clonable), ou une barrière qui continue de se fermer sur un obstacle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-terminal"></a>

## Fiche de recette : Contrôle d'accès (modules « acces-dahua » et « acces-zkteco » de la passerelle) : contrôleurs, lecteurs, serrures, barrières

**Profil : Terminal de contrôle d'accès autonome (lecteur et contrôleur dans le même boîtier)** (`terminal`)  
Fiche `controle-acces` version 1 — empreinte `3447c13f00ac2aa7`  
Référence : docs/PRD-CONTROLE-ACCES.md (sections 7, 8.9 et 10) ; docs/CONTROLE-ACCES.md (contrat commun, sections 1 et 2) ; docs/COMMANDES.md (canal de commande signé) ; docs/PASSERELLE.md

> Qualification en atelier d'un contrôleur de 1 à 4 portes (ou d'un terminal), d'un lecteur de badge, d'une serrure à sécurité positive ou d'une barrière raccordés à la passerelle. Chaque porte est un détecteur PSIM de catégorie « access ».

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

- Le matériel à qualifier : contrôleur ou terminal avec sa notice, son alimentation et sa batterie ; au moins un lecteur de badge, une serrure (ventouse ou gâche) et un contact de porte raccordés, une porte d'essai réelle ou une maquette de porte
- Badges d'essai : un badge MIFARE chiffré accepté, un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires ; un badge ou une carte EM 125 kHz pour vérifier qu'elle n'est pas acceptée
- Pour une barrière ou un portail : une barrière complète avec ses cellules et sa boucle de détection, un obstacle souple et inoffensif pour les essais de sécurité (jamais une personne ni un véhicule réel)
- Switch, câbles ; poste de recette (PSIM hors production + Passerelle GAMR avec le module d'accès de la marque)
- Canal de commande signé configuré sur le banc (lot AC0), accès à l'alimentation de chaque élément pour la couper
- Chronomètre ; possibilité de décaler l'horloge du contrôleur

### Montage du banc d'essai

1. Raccorder le contrôleur, le lecteur, la serrure et le contact de porte comme sur site ; adresse IP fixe pour le contrôleur, accès par la passerelle seule. Les identifiants du contrôleur ne sont notés nulle part sur la fiche.
2. Dans la passerelle : module « acces-dahua » ou « acces-zkteco » avec le contrôleur et ses portes ; dans le PSIM de recette : un détecteur de catégorie « access » par porte, PORTE-BANC-01 pour la porte de référence.
3. Créer dans le contrôleur les badges d'essai (accepté, expiré, hors horaire) ; laisser un badge inconnu.
4. Pour les ordres à distance : lier la porte de référence à un actionneur « lock » ou « gate » du canal de commande signé.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Réglages du matériel `acc-reglages` — OBLIGATOIRE

**À faire** : Relever et noter : adresse du contrôleur, nombre de portes déclarées, heure du contrôleur (réglée sur NTP ou à la main), mode de raccordement du lecteur (Wiegand ou OSDP), type de serrure (ventouse, gâche, autre) et sécurité de la serrure (positive ou négative, selon la notice). Joindre une photo de l'écran ou de l'étiquette SANS les mots de passe.

**Résultat attendu** : Tous les réglages sont notés. Aucun identifiant ni mot de passe n'est écrit sur la fiche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact PORTE-BANC-01 (catégorie : Accès (porte d'essai)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Mettre le contrôleur sous tension et démarrer le module d'accès de la passerelle ; le signe de vie (« heartbeat », toutes les 60 s par défaut) arrive pour la porte. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Mémoire hors ligne du contrôleur `acc-memoire` — OBLIGATOIRE

**À faire** : Relever dans la notice du constructeur ET sur le contrôleur la capacité de la mémoire d'événements hors ligne. Noter les deux valeurs et leur source.

**Résultat attendu** : La capacité est d'au moins 50 000 événements. En dessous, le modèle est refusé (rejeté ou limité à un usage sans récupération de passages).

**Mesure** `memoire_evenements` — Capacité de la mémoire hors ligne : au moins 50000 événements. Valeur relevée : ________ événements

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 6. Technologie de badge : MIFARE chiffré, pas d'EM 125 kHz `acc-lecteur-mifare` — OBLIGATOIRE

**À faire** : Présenter au lecteur un badge MIFARE chiffré d'essai puis un badge ou une carte EM 125 kHz (sans chiffrement). Lire la référence du lecteur et la technologie annoncée par le constructeur.

**Résultat attendu** : Le badge MIFARE chiffré est lu. La carte EM 125 kHz n'ouvre pas la porte et n'est pas acceptée (elle est ignorée ou refusée). Si le lecteur ne sait lire que l'EM 125 kHz, il est rejeté.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Badge accepté `acc-badge-accepte` — OBLIGATOIRE

**À faire** : Présenter le badge d'essai accepté à l'entrée de la porte de référence. Noter l'heure.

**Résultat attendu** : La porte s'ouvre par le contrôleur seul. Un passage « accepté » (badge_granted) arrive dans le PSIM avec l'heure du contrôleur, le numéro de badge, le sens et la méthode « badge ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Badge inconnu, expiré, hors horaire `acc-badge-refus` — OBLIGATOIRE

**À faire** : Présenter successivement : un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires. Un seul refus à la fois, avec plus d'une minute entre deux.

**Résultat attendu** : Chaque refus est un passage « refusé » (badge_denied) avec le bon motif (badge inconnu, expiré, hors horaire). La porte reste fermée. Un refus isolé n'ouvre AUCUN incident : il est seulement journalisé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Refus répétés (3 en 60 s) `acc-refus-repetes` — OBLIGATOIRE

**À faire** : Présenter 2 fois de suite un badge inconnu en moins de 60 s, vérifier, puis recommencer avec 3 refus en moins de 60 s sur la même porte.

**Résultat attendu** : Avec 2 refus : aucune pré-alarme. Au 3e refus en 60 s : « refus répétés » (badge_denied_repeated), une pré-alarme est ouverte sur la bonne porte ; les 3 refus restent journalisés.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Bouton de sortie `acc-sortie` — OBLIGATOIRE

**À faire** : Appuyer sur le bouton de sortie (ou utiliser le lecteur de sortie) pour sortir.

**Résultat attendu** : La porte s'ouvre. Un passage accepté avec la méthode « bouton de sortie » arrive dans le PSIM, sans numéro de badge.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Sens entrée / sortie `acc-sens` — OBLIGATOIRE

**À faire** : Passer un badge accepté au lecteur d'entrée puis au lecteur de sortie (ou, pour un contrôleur à lecteur unique, noter que le sens n'est pas connu).

**Résultat attendu** : Le passage porte le sens correct (entrée ou sortie). Si le matériel ne donne pas le sens, le passage arrive sans sens (jamais un sens inventé).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Ouverture et fermeture de la porte `acc-ouverture-fermeture` — OBLIGATOIRE

**À faire** : Ouvrir la porte avec un badge accepté, la franchir, la refermer.

**Résultat attendu** : Les messages « porte ouverte » (door_opened) puis « porte fermée » (door_closed) arrivent dans l'ordre, sans alarme ; l'état revient à Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Forcer la porte d'essai SANS badge (ouvrir le vantail sans que le contrôleur ait commandé la serrure, ou simuler l'ouverture du contact de porte selon la notice). Noter l'heure exacte du geste.

**Résultat attendu** : Le module envoie « porte forcée » (door_forced) ; une alarme critique s'ouvre sur la bonne porte. L'incident porte le bon nom, la bonne zone et le motif « Porte forcée » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer la porte et remettre le contact de porte au repos.

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Latence mesurée `latency` — OBLIGATOIRE

**À faire** : Mesurer, au chronomètre ou avec les heures du journal du PSIM, le temps entre le geste et l'affichage de l'incident. Faire 10 essais ; noter le PIRE délai (pas la moyenne).

**Résultat attendu** : Pire délai inférieur ou égal à 10 s.

**Mesure** `latence_max_s` — Pire latence geste → incident : au plus 10 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 16. Porte maintenue ouverte `acc-maintenue` — OBLIGATOIRE

**À faire** : Ouvrir la porte avec un badge accepté et la laisser ouverte plus longtemps que le délai réglé dans le contrôleur. Noter le délai réglé et l'heure.

**Résultat attendu** : « Porte maintenue ouverte » (door_held_open) arrive : pré-alarme dans le PSIM ; elle devient une alarme après le délai réglé pour la porte. Refermer la porte : retour à Normal. Aucun signe de vie ne rajeunit une porte muette.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Sabotage (autoprotection) `tamper` — OBLIGATOIRE

**À faire** : Ouvrir le boîtier du contrôleur (ou du lecteur) pour déclencher son contact d'autoprotection, puis le refermer. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 18. Horloge du contrôleur déréglée `acc-horloge` — OBLIGATOIRE

**À faire** : Décaler l'horloge du contrôleur d'un peu moins de 2 minutes puis de plus de 2 minutes, attendre le prochain signe de vie, puis remettre l'horloge à l'heure.

**Résultat attendu** : En dessous de 2 minutes : aucun défaut. Au-delà : « horloge déréglée » (clock_drift) arrive, la porte passe en défaut avec le libellé « Horloge de l'équipement déréglée » ; elle revient à Normal une fois l'horloge corrigée. Les passages gardent l'heure du contrôleur.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 19. Signe de vie `acc-heartbeat` — OBLIGATOIRE

**À faire** : Observer pendant 5 minutes le journal de la passerelle et le PSIM, porte au repos. Noter l'intervalle réel entre deux signes de vie (60 s par défaut dans la passerelle).

**Résultat attendu** : Un signe de vie (heartbeat) arrive par porte, à l'intervalle réglé. L'état reste Normal et aucun incident ne s'ouvre.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 20. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du contrôleur (alimentation maintenue) plus longtemps que le délai de supervision du module. Noter l'heure.

**Résultat attendu** : En moins de 180 s la porte est affichée « Hors ligne » (state offline) pour chacune des portes du contrôleur, avec notification. Elle n'est JAMAIS affichée « fermée » ni « Normal » faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 21. Passages manqués récupérés après coupure du réseau `acc-differe` — OBLIGATOIRE

**À faire** : Avec le contrôleur coupé du réseau (câble débranché, alimentation maintenue), faire 5 passages par badge (acceptés et refusés) et ouvrir puis fermer la porte. Rebrancher le câble. Noter les identifiants d'événement du contrôleur.

**Résultat attendu** : Après la reprise, les 5 passages arrivent dans le PSIM, datés de l'heure du contrôleur, marqués « reçus en différé », sans passage perdu ni doublé (rejouer la récupération ne crée aucun doublon). La porte revient à l'état réel.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 22. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau du contrôleur. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 23. Silence du capteur (« muet ») `silence` — OBLIGATOIRE

**À faire** : Couper l'alimentation du contrôleur ET sa batterie en laissant la passerelle et le PSIM en marche. Vérifier que la supervision de l'équipement dans le PSIM est réglée à le délai de supervision réglé pour le contrôleur dans la passerelle (champ « Supervision »). Ne rien toucher d'autre ; chronométrer.

**Résultat attendu** : Au bout du délai réglé (marge comprise : 300 s au plus) l'équipement est affiché « Hors ligne » (muet), la notification « Détecteur muet » part. Il n'est JAMAIS affiché « Normal » alors qu'il se tait.

**Mesure** `silence_detecte_s` — Délai réel avant « muet » : au plus 300 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 24. Autonomie : le PSIM et la passerelle coupés `acc-autonomie` — OBLIGATOIRE

**À faire** : Arrêter la passerelle ET le PSIM de recette. Présenter successivement un badge accepté, un badge refusé, utiliser le bouton de sortie.

**Résultat attendu** : Le contrôleur décide seul : le badge accepté ouvre la porte, le refusé ne l'ouvre pas, le bouton de sortie fonctionne. Personne n'est bloqué ni dehors ni dedans. Remettre ensuite la passerelle et le PSIM en marche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 25. Redémarrage de la passerelle `acc-passerelle-redemarrage` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus de la passerelle (pas un arrêt propre), faire 2 passages par badge pendant qu'elle est arrêtée, attendre 60 s, la relancer.

**Résultat attendu** : Au redémarrage : la passerelle retrouve le contrôleur et ses portes sans reconfiguration ; les 2 passages arrivent (en différé, une seule fois chacun), aucun passage déjà reçu n'est doublé, l'état des portes est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 26. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 27. Coupure réseau puis renvoi daté `netcut` — OBLIGATOIRE

**À faire** : Arrêter le PSIM de recette pendant 1 heure. Pendant la coupure, faire 5 passages par badge (acceptés et refusés) et ouvrir puis fermer la porte. Redémarrer le PSIM.

**Résultat attendu** : Après le rétablissement : les 5 passages arrivent datés de leur heure réelle (heure du contrôleur), marqués « reçu en différé » si besoin, sans aucun passage perdu ni doublé ; l'état final de la porte est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 28. Ouverture à distance par le canal signé `acc-ouverture-distance` — OBLIGATOIRE

**À faire** : Depuis le PSIM, avec une raison saisie et le mot de passe redemandé : (1) « Ouvrir (impulsion) », (2) « Ouvrir N minutes » avec N à quelques minutes, (3) attendre la fin du délai ou ordonner le retour à l'état normal. Essayer aussi un ordre refusé (mauvais mot de passe, ou ordre « toujours fermé »). Noter l'heure de chaque ordre et de chaque accusé.

**Résultat attendu** : L'impulsion ouvre la porte puis elle se referme seule. L'ouverture prolongée garde la porte déverrouillée puis revient à l'état normal à la fin du délai ou sur ordre. L'ordre refusé ne change rien. « Toujours fermé » n'existe pas : jamais de verrouillage permanent par ordre. Chaque ordre est accusé et journalisé avec sa raison ; le passage porte la méthode « ouverture à distance ». Le canal de commande est le seul chemin vers la serrure.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 29. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 30. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 29 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Une porte dont le contrôleur ne répond plus est affichée « Hors ligne », jamais « fermée » ni « Normal ».
- Aucun passage n'est perdu ni doublé après une coupure du réseau, du PSIM ou de la passerelle.
- Le contrôleur décide seul de l'ouverture par badge ; le PSIM n'intervient jamais dans cette décision.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une serrure d'issue de secours qui reste verrouillée sans courant, ou qu'un ordre à distance peut verrouiller.
- Un ordre à distance qui passe ailleurs que par le canal de commande signé, ou qui installe un « toujours fermé ».
- Un lecteur qui accepte une carte EM 125 kHz (clonable), ou une barrière qui continue de se fermer sur un obstacle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-lecteur"></a>

## Fiche de recette : Contrôle d'accès (modules « acces-dahua » et « acces-zkteco » de la passerelle) : contrôleurs, lecteurs, serrures, barrières

**Profil : Lecteur de badge (passe par le contrôleur)** (`lecteur`)  
Fiche `controle-acces` version 1 — empreinte `2d77facb8bc15ca7`  
Référence : docs/PRD-CONTROLE-ACCES.md (sections 7, 8.9 et 10) ; docs/CONTROLE-ACCES.md (contrat commun, sections 1 et 2) ; docs/COMMANDES.md (canal de commande signé) ; docs/PASSERELLE.md

> Qualification en atelier d'un contrôleur de 1 à 4 portes (ou d'un terminal), d'un lecteur de badge, d'une serrure à sécurité positive ou d'une barrière raccordés à la passerelle. Chaque porte est un détecteur PSIM de catégorie « access ».

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

- Le matériel à qualifier : contrôleur ou terminal avec sa notice, son alimentation et sa batterie ; au moins un lecteur de badge, une serrure (ventouse ou gâche) et un contact de porte raccordés, une porte d'essai réelle ou une maquette de porte
- Badges d'essai : un badge MIFARE chiffré accepté, un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires ; un badge ou une carte EM 125 kHz pour vérifier qu'elle n'est pas acceptée
- Pour une barrière ou un portail : une barrière complète avec ses cellules et sa boucle de détection, un obstacle souple et inoffensif pour les essais de sécurité (jamais une personne ni un véhicule réel)
- Switch, câbles ; poste de recette (PSIM hors production + Passerelle GAMR avec le module d'accès de la marque)
- Canal de commande signé configuré sur le banc (lot AC0), accès à l'alimentation de chaque élément pour la couper
- Chronomètre ; possibilité de décaler l'horloge du contrôleur

### Montage du banc d'essai

1. Raccorder le contrôleur, le lecteur, la serrure et le contact de porte comme sur site ; adresse IP fixe pour le contrôleur, accès par la passerelle seule. Les identifiants du contrôleur ne sont notés nulle part sur la fiche.
2. Dans la passerelle : module « acces-dahua » ou « acces-zkteco » avec le contrôleur et ses portes ; dans le PSIM de recette : un détecteur de catégorie « access » par porte, PORTE-BANC-01 pour la porte de référence.
3. Créer dans le contrôleur les badges d'essai (accepté, expiré, hors horaire) ; laisser un badge inconnu.
4. Pour les ordres à distance : lier la porte de référence à un actionneur « lock » ou « gate » du canal de commande signé.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Réglages du matériel `acc-reglages` — OBLIGATOIRE

**À faire** : Relever et noter : adresse du contrôleur, nombre de portes déclarées, heure du contrôleur (réglée sur NTP ou à la main), mode de raccordement du lecteur (Wiegand ou OSDP), type de serrure (ventouse, gâche, autre) et sécurité de la serrure (positive ou négative, selon la notice). Joindre une photo de l'écran ou de l'étiquette SANS les mots de passe.

**Résultat attendu** : Tous les réglages sont notés. Aucun identifiant ni mot de passe n'est écrit sur la fiche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact PORTE-BANC-01 (catégorie : Accès (porte d'essai)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Mettre le lecteur sous tension, raccordé à son contrôleur ; le contrôleur le déclare en service. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Technologie de badge : MIFARE chiffré, pas d'EM 125 kHz `acc-lecteur-mifare` — OBLIGATOIRE

**À faire** : Présenter au lecteur un badge MIFARE chiffré d'essai puis un badge ou une carte EM 125 kHz (sans chiffrement). Lire la référence du lecteur et la technologie annoncée par le constructeur.

**Résultat attendu** : Le badge MIFARE chiffré est lu. La carte EM 125 kHz n'ouvre pas la porte et n'est pas acceptée (elle est ignorée ou refusée). Si le lecteur ne sait lire que l'EM 125 kHz, il est rejeté.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Badge accepté `acc-badge-accepte` — OBLIGATOIRE

**À faire** : Présenter le badge d'essai accepté à l'entrée de la porte de référence. Noter l'heure.

**Résultat attendu** : La porte s'ouvre par le contrôleur seul. Un passage « accepté » (badge_granted) arrive dans le PSIM avec l'heure du contrôleur, le numéro de badge, le sens et la méthode « badge ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Badge inconnu, expiré, hors horaire `acc-badge-refus` — OBLIGATOIRE

**À faire** : Présenter successivement : un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires. Un seul refus à la fois, avec plus d'une minute entre deux.

**Résultat attendu** : Chaque refus est un passage « refusé » (badge_denied) avec le bon motif (badge inconnu, expiré, hors horaire). La porte reste fermée. Un refus isolé n'ouvre AUCUN incident : il est seulement journalisé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Bouton de sortie `acc-sortie` — OBLIGATOIRE

**À faire** : Appuyer sur le bouton de sortie (ou utiliser le lecteur de sortie) pour sortir.

**Résultat attendu** : La porte s'ouvre. Un passage accepté avec la méthode « bouton de sortie » arrive dans le PSIM, sans numéro de badge.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Sens entrée / sortie `acc-sens` — OBLIGATOIRE

**À faire** : Passer un badge accepté au lecteur d'entrée puis au lecteur de sortie (ou, pour un contrôleur à lecteur unique, noter que le sens n'est pas connu).

**Résultat attendu** : Le passage porte le sens correct (entrée ou sortie). Si le matériel ne donne pas le sens, le passage arrive sans sens (jamais un sens inventé).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — OBLIGATOIRE

**À faire** : Ouvrir le boîtier du contrôleur (ou du lecteur) pour déclencher son contact d'autoprotection, puis le refermer. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 11. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du contrôleur (alimentation maintenue) plus longtemps que le délai de supervision du module. Noter l'heure.

**Résultat attendu** : En moins de 180 s la porte est affichée « Hors ligne » (state offline) pour chacune des portes du contrôleur, avec notification. Elle n'est JAMAIS affichée « fermée » ni « Normal » faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau du contrôleur. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 13. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

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
- Une porte dont le contrôleur ne répond plus est affichée « Hors ligne », jamais « fermée » ni « Normal ».
- Aucun passage n'est perdu ni doublé après une coupure du réseau, du PSIM ou de la passerelle.
- Le contrôleur décide seul de l'ouverture par badge ; le PSIM n'intervient jamais dans cette décision.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une serrure d'issue de secours qui reste verrouillée sans courant, ou qu'un ordre à distance peut verrouiller.
- Un ordre à distance qui passe ailleurs que par le canal de commande signé, ou qui installe un « toujours fermé ».
- Un lecteur qui accepte une carte EM 125 kHz (clonable), ou une barrière qui continue de se fermer sur un obstacle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-serrure"></a>

## Fiche de recette : Contrôle d'accès (modules « acces-dahua » et « acces-zkteco » de la passerelle) : contrôleurs, lecteurs, serrures, barrières

**Profil : Serrure, ventouse ou gâche à sécurité positive (passe par le contrôleur)** (`serrure`)  
Fiche `controle-acces` version 1 — empreinte `65554682bcbd523c`  
Référence : docs/PRD-CONTROLE-ACCES.md (sections 7, 8.9 et 10) ; docs/CONTROLE-ACCES.md (contrat commun, sections 1 et 2) ; docs/COMMANDES.md (canal de commande signé) ; docs/PASSERELLE.md

> Qualification en atelier d'un contrôleur de 1 à 4 portes (ou d'un terminal), d'un lecteur de badge, d'une serrure à sécurité positive ou d'une barrière raccordés à la passerelle. Chaque porte est un détecteur PSIM de catégorie « access ».

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

- Le matériel à qualifier : contrôleur ou terminal avec sa notice, son alimentation et sa batterie ; au moins un lecteur de badge, une serrure (ventouse ou gâche) et un contact de porte raccordés, une porte d'essai réelle ou une maquette de porte
- Badges d'essai : un badge MIFARE chiffré accepté, un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires ; un badge ou une carte EM 125 kHz pour vérifier qu'elle n'est pas acceptée
- Pour une barrière ou un portail : une barrière complète avec ses cellules et sa boucle de détection, un obstacle souple et inoffensif pour les essais de sécurité (jamais une personne ni un véhicule réel)
- Switch, câbles ; poste de recette (PSIM hors production + Passerelle GAMR avec le module d'accès de la marque)
- Canal de commande signé configuré sur le banc (lot AC0), accès à l'alimentation de chaque élément pour la couper
- Chronomètre ; possibilité de décaler l'horloge du contrôleur

### Montage du banc d'essai

1. Raccorder le contrôleur, le lecteur, la serrure et le contact de porte comme sur site ; adresse IP fixe pour le contrôleur, accès par la passerelle seule. Les identifiants du contrôleur ne sont notés nulle part sur la fiche.
2. Dans la passerelle : module « acces-dahua » ou « acces-zkteco » avec le contrôleur et ses portes ; dans le PSIM de recette : un détecteur de catégorie « access » par porte, PORTE-BANC-01 pour la porte de référence.
3. Créer dans le contrôleur les badges d'essai (accepté, expiré, hors horaire) ; laisser un badge inconnu.
4. Pour les ordres à distance : lier la porte de référence à un actionneur « lock » ou « gate » du canal de commande signé.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Réglages du matériel `acc-reglages` — OBLIGATOIRE

**À faire** : Relever et noter : adresse du contrôleur, nombre de portes déclarées, heure du contrôleur (réglée sur NTP ou à la main), mode de raccordement du lecteur (Wiegand ou OSDP), type de serrure (ventouse, gâche, autre) et sécurité de la serrure (positive ou négative, selon la notice). Joindre une photo de l'écran ou de l'étiquette SANS les mots de passe.

**Résultat attendu** : Tous les réglages sont notés. Aucun identifiant ni mot de passe n'est écrit sur la fiche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact PORTE-BANC-01 (catégorie : Accès (porte d'essai)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Alimenter la serrure par le contrôleur ; le contact de porte indique « fermée ». Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Badge accepté `acc-badge-accepte` — OBLIGATOIRE

**À faire** : Présenter le badge d'essai accepté à l'entrée de la porte de référence. Noter l'heure.

**Résultat attendu** : La porte s'ouvre par le contrôleur seul. Un passage « accepté » (badge_granted) arrive dans le PSIM avec l'heure du contrôleur, le numéro de badge, le sens et la méthode « badge ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Ouverture et fermeture de la porte `acc-ouverture-fermeture` — OBLIGATOIRE

**À faire** : Ouvrir la porte avec un badge accepté, la franchir, la refermer.

**Résultat attendu** : Les messages « porte ouverte » (door_opened) puis « porte fermée » (door_closed) arrivent dans l'ordre, sans alarme ; l'état revient à Normal.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Forcer la porte d'essai SANS badge (ouvrir le vantail sans que le contrôleur ait commandé la serrure, ou simuler l'ouverture du contact de porte selon la notice). Noter l'heure exacte du geste.

**Résultat attendu** : Le module envoie « porte forcée » (door_forced) ; une alarme critique s'ouvre sur la bonne porte. L'incident porte le bon nom, la bonne zone et le motif « Porte forcée » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer la porte et remettre le contact de porte au repos.

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Porte maintenue ouverte `acc-maintenue` — OBLIGATOIRE

**À faire** : Ouvrir la porte avec un badge accepté et la laisser ouverte plus longtemps que le délai réglé dans le contrôleur. Noter le délai réglé et l'heure.

**Résultat attendu** : « Porte maintenue ouverte » (door_held_open) arrive : pré-alarme dans le PSIM ; elle devient une alarme après le délai réglé pour la porte. Refermer la porte : retour à Normal. Aucun signe de vie ne rajeunit une porte muette.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Sabotage (autoprotection) `tamper` — OBLIGATOIRE

**À faire** : Ouvrir le boîtier du contrôleur (ou du lecteur) pour déclencher son contact d'autoprotection, puis le refermer. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Sécurité positive : coupure de courant, porte libre `acc-securite-positive` — OBLIGATOIRE

**À faire** : Porte fermée et serrure verrouillée, couper l'alimentation de la serrure (et du contrôleur si la serrure en dépend). Essayer d'ouvrir la porte de l'intérieur sans clé ni badge. Rétablir l'alimentation.

**Résultat attendu** : Dès la coupure, la porte est libre : elle s'ouvre de l'intérieur sans outil ni badge. À l'alimentation rétablie, la serrure reprend son état normal. Une serrure qui reste verrouillée sans courant est refusée pour une issue de secours.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Ouverture par impulsion `acc-impulsion` — OBLIGATOIRE

**À faire** : Commander l'ouverture par impulsion (badge accepté, puis ordre à distance). Chronométrer la durée pendant laquelle la serrure reste déverrouillée.

**Résultat attendu** : La serrure se déverrouille puis se reverrouille seule à la fin de l'impulsion. Le contact de porte confirme l'ouverture et la fermeture.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Ouverture prolongée et retour à l'état normal `acc-prolongee` — OBLIGATOIRE

**À faire** : Commander une ouverture prolongée de quelques minutes puis ordonner le retour à l'état normal avant la fin du délai ; recommencer en laissant le délai se terminer.

**Résultat attendu** : Pendant le délai, la porte reste déverrouillée et les badges continuent de fonctionner. À la fin du délai ou sur ordre, la serrure revient à son état normal (fermée sur badge). Aucun ordre n'installe un « toujours fermé ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 14. « Verrouiller » ne coupe jamais les badges `acc-verrouiller` — OBLIGATOIRE

**À faire** : Sur une porte qui n'est PAS une issue de secours, utiliser « Verrouiller » (retour à l'état verrouillé normal). Présenter ensuite un badge accepté.

**Résultat attendu** : La serrure est verrouillée mais le badge accepté ouvre toujours la porte (le contrôleur décide). « Verrouiller » ne désactive aucun badge et ne rend jamais la porte inouvrable de l'intérieur.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Issue de secours jamais verrouillée `acc-issue-secours` — OBLIGATOIRE

**À faire** : Déclarer la porte de référence comme issue de secours dans le PSIM, puis essayer « Verrouiller » depuis la fiche de la porte et par le canal de commande signé.

**Résultat attendu** : L'ordre « Verrouiller » est refusé au niveau du PSIM et à l'exécution ; la porte reste libre de l'intérieur. Le refus est journalisé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 16. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du contrôleur (alimentation maintenue) plus longtemps que le délai de supervision du module. Noter l'heure.

**Résultat attendu** : En moins de 180 s la porte est affichée « Hors ligne » (state offline) pour chacune des portes du contrôleur, avec notification. Elle n'est JAMAIS affichée « fermée » ni « Normal » faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 17. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau du contrôleur. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 18. Autonomie : le PSIM et la passerelle coupés `acc-autonomie` — OBLIGATOIRE

**À faire** : Arrêter la passerelle ET le PSIM de recette. Présenter successivement un badge accepté, un badge refusé, utiliser le bouton de sortie.

**Résultat attendu** : Le contrôleur décide seul : le badge accepté ouvre la porte, le refusé ne l'ouvre pas, le bouton de sortie fonctionne. Personne n'est bloqué ni dehors ni dedans. Remettre ensuite la passerelle et le PSIM en marche.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 19. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le processus du PSIM de recette (pas un arrêt propre), attendre 60 s, le relancer. Déclencher ensuite l'équipement.

**Résultat attendu** : Au redémarrage : l'équipement et son état sont retrouvés sans reconfiguration ; la période sans surveillance est journalisée ; aucune alarme fantôme ; l'équipement n'est pas déclaré muet avant son délai de grâce ; le premier déclenchement après redémarrage ouvre bien un incident.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 20. Ouverture à distance par le canal signé `acc-ouverture-distance` — OBLIGATOIRE

**À faire** : Depuis le PSIM, avec une raison saisie et le mot de passe redemandé : (1) « Ouvrir (impulsion) », (2) « Ouvrir N minutes » avec N à quelques minutes, (3) attendre la fin du délai ou ordonner le retour à l'état normal. Essayer aussi un ordre refusé (mauvais mot de passe, ou ordre « toujours fermé »). Noter l'heure de chaque ordre et de chaque accusé.

**Résultat attendu** : L'impulsion ouvre la porte puis elle se referme seule. L'ouverture prolongée garde la porte déverrouillée puis revient à l'état normal à la fin du délai ou sur ordre. L'ordre refusé ne change rien. « Toujours fermé » n'existe pas : jamais de verrouillage permanent par ordre. Chaque ordre est accusé et journalisé avec sa raison ; le passage porte la méthode « ouverture à distance ». Le canal de commande est le seul chemin vers la serrure.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Conditions tropicales

##### 21. Conditions tropicales (35 °C, 90 % d'humidité) `tropical` — facultative

**À faire** : Placer l'équipement et son alimentation au moins 4 h dans une enceinte à 35 °C et 90 % d'humidité relative si une enceinte est disponible. Sinon, mesurer sur site au point le plus chaud et humide (local technique, extérieur à l'ombre l'après-midi) avec un thermo-hygromètre étalonné. Noter température et humidité mesurées, puis refaire un déclenchement, un retour à la normale et une mesure de latence dans ces conditions.

**Résultat attendu** : Mêmes résultats qu'aux étapes de déclenchement et de latence ; aucune fausse alarme, aucun défaut, aucune condensation visible, aucune dérive de mesure. Si l'essai n'est pas possible, marquer « na » et en donner la raison : la limite sera inscrite au dossier.

**Mesure** `tropical_temperature_c` — Température relevée pendant l'essai : au moins 35 °C. Valeur relevée : ________ °C

**Mesure** `tropical_humidite_pct` — Humidité relative relevée pendant l'essai : au moins 90 % HR. Valeur relevée : ________ % HR

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 22. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 21 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Une porte dont le contrôleur ne répond plus est affichée « Hors ligne », jamais « fermée » ni « Normal ».
- Aucun passage n'est perdu ni doublé après une coupure du réseau, du PSIM ou de la passerelle.
- Le contrôleur décide seul de l'ouverture par badge ; le PSIM n'intervient jamais dans cette décision.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une serrure d'issue de secours qui reste verrouillée sans courant, ou qu'un ordre à distance peut verrouiller.
- Un ordre à distance qui passe ailleurs que par le canal de commande signé, ou qui installe un « toujours fermé ».
- Un lecteur qui accepte une carte EM 125 kHz (clonable), ou une barrière qui continue de se fermer sur un obstacle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-barriere"></a>

## Fiche de recette : Contrôle d'accès (modules « acces-dahua » et « acces-zkteco » de la passerelle) : contrôleurs, lecteurs, serrures, barrières

**Profil : Barrière ou portail (passe par le contrôleur)** (`barriere`)  
Fiche `controle-acces` version 1 — empreinte `f85587b2c5a9b468`  
Référence : docs/PRD-CONTROLE-ACCES.md (sections 7, 8.9 et 10) ; docs/CONTROLE-ACCES.md (contrat commun, sections 1 et 2) ; docs/COMMANDES.md (canal de commande signé) ; docs/PASSERELLE.md

> Qualification en atelier d'un contrôleur de 1 à 4 portes (ou d'un terminal), d'un lecteur de badge, d'une serrure à sécurité positive ou d'une barrière raccordés à la passerelle. Chaque porte est un détecteur PSIM de catégorie « access ».

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

- Le matériel à qualifier : contrôleur ou terminal avec sa notice, son alimentation et sa batterie ; au moins un lecteur de badge, une serrure (ventouse ou gâche) et un contact de porte raccordés, une porte d'essai réelle ou une maquette de porte
- Badges d'essai : un badge MIFARE chiffré accepté, un badge inconnu du contrôleur, un badge expiré, un badge hors de ses horaires ; un badge ou une carte EM 125 kHz pour vérifier qu'elle n'est pas acceptée
- Pour une barrière ou un portail : une barrière complète avec ses cellules et sa boucle de détection, un obstacle souple et inoffensif pour les essais de sécurité (jamais une personne ni un véhicule réel)
- Switch, câbles ; poste de recette (PSIM hors production + Passerelle GAMR avec le module d'accès de la marque)
- Canal de commande signé configuré sur le banc (lot AC0), accès à l'alimentation de chaque élément pour la couper
- Chronomètre ; possibilité de décaler l'horloge du contrôleur

### Montage du banc d'essai

1. Raccorder le contrôleur, le lecteur, la serrure et le contact de porte comme sur site ; adresse IP fixe pour le contrôleur, accès par la passerelle seule. Les identifiants du contrôleur ne sont notés nulle part sur la fiche.
2. Dans la passerelle : module « acces-dahua » ou « acces-zkteco » avec le contrôleur et ses portes ; dans le PSIM de recette : un détecteur de catégorie « access » par porte, BARRIERE-BANC-01 pour la porte de référence.
3. Créer dans le contrôleur les badges d'essai (accepté, expiré, hors horaire) ; laisser un badge inconnu.
4. Pour les ordres à distance : lier la porte de référence à un actionneur « lock » ou « gate » du canal de commande signé.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Relever sur l'équipement et noter dans le résultat : numéro de série, version du micrologiciel (firmware) et référence exacte du modèle. Photographier l'étiquette.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Réglages de la barrière `acc-reglages-barriere` — OBLIGATOIRE

**À faire** : Relever et noter : mode de commande (impulsion ou maintenu), présence d'une boucle de détection, de cellules, d'un arrêt, d'un déverrouillage manuel, selon la notice. Joindre une photo de la plaque signalétique.

**Résultat attendu** : Tous les éléments présents sont notés ; ce qui est absent est marqué « absent » (pas « na » silencieux).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BARRIERE-BANC-01 (catégorie : Accès (barrière ou portail)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 4. Premier message `prep-reception` — OBLIGATOIRE

**À faire** : Mettre la barrière sous tension, raccordée au contrôleur ; son état est remonté. Laisser l'ensemble au repos 10 minutes sans toucher à l'équipement.

**Résultat attendu** : L'état passe à Normal en moins de 120 s (noter la valeur). Aucune alarme ni aucun défaut parasite pendant les 10 minutes de repos.

**Mesure** `premier_message_s` — Délai jusqu'au premier état Normal : au plus 120 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 5. Déclenchement `trigger` — OBLIGATOIRE

**À faire** : Ouvrir la barrière en la forçant (sans ordre du contrôleur) si le matériel remonte ce fait ; sinon marquer « na ». Noter l'heure exacte du geste.

**Résultat attendu** : Le module envoie « porte forcée » (door_forced) ; une alarme critique s'ouvre sur la bonne porte. L'incident porte le bon nom, la bonne zone et le motif « Porte forcée » ; l'alerte sonore retentit ; la notification arrive chez les destinataires de niveau 1.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Retour à la normale `restore` — OBLIGATOIRE

**À faire** : Refermer la porte et remettre le contact de porte au repos.

**Résultat attendu** : L'état revient à Normal en moins de 30 s. L'incident reste ouvert tant qu'un opérateur ne l'a pas acquitté puis clôturé : un retour à la normale ne ferme jamais un incident tout seul.

**Mesure** `retour_s` — Délai de retour à Normal : au plus 30 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Sabotage (autoprotection) `tamper` — OBLIGATOIRE

**À faire** : Ouvrir le boîtier du contrôleur (ou du lecteur) pour déclencher son contact d'autoprotection, puis le refermer. Faire l'essai zone désarmée (planning d'armement coupé).

**Résultat attendu** : Alarme « Sabotage » ouverte même zone désarmée (le sabotage est toujours actif). Si l'équipement n'a pas d'autoprotection, le noter : étape à marquer « na » avec cette justification.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 8. Commande ouvrir / fermer `acc-barriere-commande` — OBLIGATOIRE

**À faire** : Depuis le PSIM, avec raison et mot de passe : commander « ouvrir » puis « fermer » la barrière. Si le matériel sait s'arrêter, commander aussi « arrêt » en cours de mouvement ; sinon le noter.

**Résultat attendu** : La barrière s'ouvre puis se ferme sur ordre ; l'état remonté suit le mouvement (ouverte, fermée). « Arrêt » arrête le mouvement si le matériel le permet. Chaque ordre est accusé et journalisé avec sa raison.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Boucle de détection `acc-barriere-boucle` — facultative

**À faire** : Barrière ouverte, placer un véhicule d'essai (ou une masse métallique sur la boucle) puis commander « fermer ».

**Résultat attendu** : Tant que la boucle détecte une présence, la barrière ne se ferme pas. Elle se ferme une fois la boucle libérée. Si la barrière n'a pas de boucle, noter « absent » : la recette de sécurité de fermeture reste obligatoire.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 10. Cellules `acc-barriere-cellules` — facultative

**À faire** : Pendant la fermeture, couper le faisceau des cellules avec l'obstacle souple d'essai.

**Résultat attendu** : La barrière s'arrête ou se rouvre dès la coupure du faisceau ; elle ne continue pas à se fermer. L'événement est remonté si le matériel le permet. Sans cellules, noter « absent ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 11. Sécurité de fermeture `acc-barriere-securite` — OBLIGATOIRE

**À faire** : Pendant la fermeture, opposer à la barrière l'obstacle souple d'essai (jamais une personne ni un véhicule).

**Résultat attendu** : La barrière s'arrête ou se rouvre au contact ou à la détection de l'obstacle. Le matériel ne force pas. Si ce comportement n'est pas obtenu, la barrière est rejetée.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 12. Retour à l'état normal `acc-barriere-retour` — OBLIGATOIRE

**À faire** : Commander une ouverture prolongée de quelques minutes sur la barrière puis laisser le délai se terminer, ou ordonner le retour à l'état normal.

**Résultat attendu** : La barrière revient à son état normal (fermée) à la fin du délai ou sur ordre. Aucun ordre n'installe un « toujours fermé ».

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 13. Coupure de courant `acc-barriere-courant` — facultative

**À faire** : Couper l'alimentation de la barrière ouverte puis fermée. Noter si un déverrouillage manuel est possible et son mode d'emploi.

**Résultat attendu** : L'état au moment de la coupure et la possibilité de déverrouiller à la main sont notés. La barrière ne reste pas bloquée sans moyen de passer à la main. Rétablir l'alimentation : l'état remonté est exact.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 14. Coupure de liaison `linkloss` — OBLIGATOIRE

**À faire** : Débrancher le câble réseau du contrôleur (alimentation maintenue) plus longtemps que le délai de supervision du module. Noter l'heure.

**Résultat attendu** : En moins de 180 s la porte est affichée « Hors ligne » (state offline) pour chacune des portes du contrôleur, avec notification. Elle n'est JAMAIS affichée « fermée » ni « Normal » faute de savoir.

**Mesure** `liaison_perdue_s` — Délai jusqu'à Défaut / Hors ligne : au plus 180 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 15. Rétablissement `linkback` — OBLIGATOIRE

**À faire** : Rebrancher le câble réseau du contrôleur. Noter l'heure.

**Résultat attendu** : Reprise automatique, sans intervention ni redémarrage, en moins de 180 s. L'état affiché est l'état réel (Normal, ou alarme si le fait persiste).

**Mesure** `reprise_s` — Délai de reprise : au plus 180 s. Valeur relevée : ________ s

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
- Les 13 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Une porte dont le contrôleur ne répond plus est affichée « Hors ligne », jamais « fermée » ni « Normal ».
- Aucun passage n'est perdu ni doublé après une coupure du réseau, du PSIM ou de la passerelle.
- Le contrôleur décide seul de l'ouverture par badge ; le PSIM n'intervient jamais dans cette décision.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Une serrure d'issue de secours qui reste verrouillée sans courant, ou qu'un ordre à distance peut verrouiller.
- Un ordre à distance qui passe ailleurs que par le canal de commande signé, ou qui installe un « toujours fermé ».
- Un lecteur qui accepte une carte EM 125 kHz (clonable), ou une barrière qui continue de se fermer sur un obstacle.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


