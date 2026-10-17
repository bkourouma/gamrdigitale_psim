# Planning de mise en œuvre et de déploiement du PSIM GAMR-DIGITALE

**Version de travail : 17 octobre 2026.** Point de départ proposé : lundi 19 octobre 2026. Les dates sont des cibles, conditionnées à la disponibilité du matériel, du site et des personnes chargées de la recette. Une étape ne passe au déploiement que lorsque ses critères de sortie sont prouvés.

## 1. Résultat visé et périmètre

Le premier résultat commercialisable est une installation de bâtiment qui traite une alarme de bout en bout : équipement réel → incident sur le bon plan → caméras et image → alerte et escalade → acquittement et qualification → journal et rapport → suivi du site sur le portail. Le pack standard « 4 caméras et 2 détecteurs de fumée » sert de configuration de référence. La Résidence KOUROUMA sert de pilote opérationnel pour son PSIM existant, les agents et le contrôleur d'accès Dahua. Ses 8 caméras actuelles ne constituent **pas** une recette du pack standard à 4 caméras : il faut désigner un site d'essai pour le pack exact, qui peut être KOUROUMA seulement si ces références y sont effectivement installées.

Trois livraisons sont distinguées :

| Livraison | Engagement vérifiable | Cible sous hypothèses ci-dessous |
|---|---|---|
| **R1 — PSIM de site, portail et pack standard** | Installation reproductible et recette signée sur les références réellement retenues ; alertes et reprise après panne prouvées. Le pack exact exige son propre essai sur site. | 27 novembre 2026 si le site d'essai et le matériel sont disponibles |
| **R2 — Agents sur application web installable** | QR, puis NFC, rondes, SOS, main courante et alarmes **application ouverte** ; semaine d'essai de nuit signée. | 27 novembre 2026, en parallèle de R1 |
| **R3 — Contrôle d'accès Dahua** | Portes, passages, incidents, commandes, titulaires et règles retenues, essayés sur le contrôleur du pilote ; sécurité des issues vérifiée. | 18 décembre 2026 |

La notification lorsque l'application est fermée ou que l'écran est éteint, le repli SMS du SOS et la fonction « homme mort » dépendent du lot Android **AG6, non commencé**. Ils feront l'objet d'une livraison R4 et d'un calendrier établi après le pilote PWA. Le catalogue forestier/SODEFOR, drones, satellite, biométrie, lecture de plaques et intégration de tous les modèles du catalogue constituent des projets distincts. Ils ne sont pas couverts par les dates R1 à R3.

**Promesse à corriger avant diffusion du pack :** les détecteurs Heiman reliés localement peuvent soutenir l'objectif « surveillance sur site sans Internet » après qualification. Le détecteur WiFi Tuya déjà essayé dépend du cloud : si cette variante est retenue, la fiche commerciale et la recette doivent dire explicitement que les alarmes distantes du détecteur nécessitent Internet. L'indice GAMR **augmente** lorsqu'un détecteur tombe en panne ; la phrase du document commercial qui annonce une baisse doit être corrigée. Aucun détecteur grand public ne doit être présenté comme le remplacement d'une centrale incendie certifiée.

## 2. Situation de départ au 17 octobre

- `main` contient le socle PSIM, le portail, l'application des agents et les lots logiciels de contrôle d'accès : titulaires, synchronisation, règles et armement des portes. Les changements locaux non commités du chantier « téléphone Android » ont été préservés ; produire une version candidate identifiée avant recette et publier les commits locaux retenus.
- Le registre de qualification compte **2 références qualifiées et 102 à qualifier**. Les deux qualifiées sont une voie précise d'enregistreur Dahua XVR5108HS-I3/T et un détecteur de fumée WiFi Tuya précis. Le pack standard vise d'autres références (XVR5104HS-I3, caméras HAC-HFW1500TH-I8, Heiman HS1SA-E, passerelle) : aucune de ces références n'est encore qualifiée pour ce pack.
- Les titulaires, la synchronisation, les règles d'accès et l'armement des portes sont intégrés dans `main`. La suite complète sur l'arbre final passe **4 720 tests sur 4 720**, sans échec ni test ignoré. Aucun contrôleur d'accès réel n'a été essayé ; le parcours visuel reste à revoir.
- L'application des agents a été testée avec des téléphones simulés ; QR, NFC, son, vibration, autonomie et réception sur un téléphone réel restent à mesurer. Le guide de KOUROUMA prévoit une nuit accompagnée puis une semaine d'essai.
- Le contrôle TypeScript passe sur l'arbre actuel. Le test ciblé de la passerelle d'appel Android a d'abord donné 2 réussites sur 4 dans le bac à sable, qui bloque les connexions au faux téléphone local. Relancé avec accès réseau local, il donne **4 réussites sur 4**. L'essai sur un vrai téléphone reste à faire avant d'activer ce canal.
- La nouvelle suite complète sur `main` passe **4 720 tests sur 4 720** après les deux intégrations et la réapplication des modifications téléphoniques. `npm run pack -- check packs/pack-standard-4cam-2fumee` valide le format et signale **9 équipements à qualifier** ; cette commande ne constitue pas une qualification matérielle.
- Les ports locaux 3033 et 4300 ne répondaient pas lors de ce contrôle. Cela ne prouve pas l'état de la production sur site : vérifier les services et leurs journaux au démarrage du chantier, sans supposer qu'ils sont actifs.

## 3. Hypothèses de capacité et chemin critique

Le calendrier suppose **un responsable technique**, **un développeur/intégrateur logiciel**, **un installateur matériel**, **un exploitant du site** et **un agent volontaire** pendant l'essai. Une même personne peut cumuler des rôles, mais les dates glisseront si elle ne peut pas mener logiciel, achat, pose et recette en parallèle.

Le chemin critique est : choix et réception des références exactes → qualification en atelier → installation et recette sur site → observation d'une semaine → correction des écarts → accord de mise en service. Pour R3 s'ajoutent l'intégration des branches de synchronisation et de règles, puis la disponibilité du contrôleur Dahua réel. **Une commande tardive ou un matériel différent décale le jalon ; elle ne se compense pas par une simulation.**

| Entrée nécessaire au plus tard le 23 octobre | Responsable | Preuve attendue |
|---|---|---|
| Plan, zones et inventaire réel de KOUROUMA ; liste des caméras, détecteurs, destinataires et procédures de garde | Client + installateur | Inventaire daté et plan approuvé |
| Site d'essai où sera réellement posé le pack standard exact, ou accord pour le poser à KOUROUMA | Client + installateur | Site et créneau de recette confirmés |
| Références exactes, devis et délai de livraison des 4 caméras, du XVR, des 2 détecteurs, de la liaison locale Zigbee, du disque, de l'onduleur et du contrôleur Dahua | Achat + installateur | Commande ou matériel disponible, avec modèles confirmés |
| Accès au poste, au routeur et au téléphone Android ; créneau d'essai de nuit et interlocuteur de décision | Client | Créneau et responsables désignés |
| Revue des informations aux agents, de la conservation des passages et des démarches applicables aux données personnelles | Client + conseil compétent | Décisions écrites avant collecte réelle |

## 4. Calendrier de travail

| Période | Travail à exécuter | Livrable et condition de sortie |
|---|---|---|
| **19–23 oct. — J0 : cadrer et stabiliser** | Comparer la fiche de vente, `PRODUCT.md`, le pack JSON et les fonctions réellement livrables. Choisir Heiman local ou une autre référence locale à qualifier ; décider si Tuya est une variante connectée. Inventorier les engagements WhatsApp/appels. Identifier et isoler les changements Android non commités, intégrer seulement le travail prêt, lancer typecheck, tests ciblés et suite complète sur une version figée. Vérifier PSIM, portail, tâches de démarrage, journaux et sauvegardes sur la machine du site. | **Matrice des engagements** « disponible / à qualifier / ultérieur », liste des anomalies, version de recette identifiée, commandes matérielles lancées. Aucun déploiement élargi avec une branche ou des fichiers non figés. |
| **26 oct.–6 nov. — J1 : qualifier le pack et fiabiliser l'exploitation** | Banc atelier sur les **références et firmwares exacts** du pack : quatre voies vidéo et relecture, événement intrusion de l'enregistreur si vendu, deux alarmes fumée, retour au repos, pile faible/silence, perte réseau et courant. Tester la passerelle Zigbee et les messages au PSIM. Faire démarrer le portail durablement, tester l'envoi signé, les comptes, les alertes et la sauvegarde/restauration sur machine séparée. Vérifier l'accès téléphone au PSIM, certificat et pare-feu. | Fiches de qualification par modèle, numéro de série et firmware, signées ; `pack check`, `pack plan`, `commission` et restauration vérifiés. Si un modèle échoue, corriger ou le remplacer par une référence **essayée**, puis mettre à jour le pack et l'offre. |
| **2–13 nov. — J2 : préparer agents et contrôle d'accès** | En parallèle du banc : installer QR, créer circuit, compte agent, téléphone et destinataires ; `check-agents:prod -- --live` entièrement vert après configuration. Les lots titulaires, synchronisation, F14/F15 et leurs essais logiciels sont déjà fusionnés ; revoir les écrans, préparer le banc et la fiche du contrôleur Dahua. | Parcours agent prêt pour une nuit accompagnée ; contrôle d'accès vérifié visuellement puis sur matériel réel ; aucun ordre d'ouverture réel avant recette de sécurité. |
| **9–20 nov. — J3 : éprouver R1/R2 sur site** | À KOUROUMA, recette du PSIM existant et de tout détecteur ajouté : alarme → image → notification → escalade → clôture ; tests de coupure Internet, réseau et courant, redémarrage, détecteur muet, sauvegarde/restauration. **Sur le site désigné pour le pack exact**, recette des quatre caméras et des deux détecteurs installés. Première nuit agent accompagnée à KOUROUMA, puis **7 nuits** avec rondes à 22 h, 0 h, 2 h et 4 h ; QR d'abord, NFC ensuite. Mesurer réception, SOS, batterie et trous WiFi. Corriger et rejouer tout cas échoué. | Fiches de recette signées pour chaque installation, journal des mesures, rapport de 7 nuits, incidents résolus ou limites explicites. Aucun « prêt » sur la seule base des tests simulés ou d'un autre modèle de caméra. |
| **23–27 nov. — J4 : décision R1/R2** | Refaire la régression sur la version candidate ; démontrer les parcours à l'exploitant, former poste de garde/administrateur, remettre procédures, contacts, sauvegardes et limites. Mettre à jour le descriptif commercial selon les modèles effectivement validés. | **Go / no-go R1 et R2** signé séparément. Si un seuil essentiel échoue, prolonger le pilote ; publier seulement les fonctions dont la recette est réussie. |
| **23 nov.–4 déc. — J5 : contrôleur Dahua réel** | Installer le contrôleur sur banc puis sur une porte pilote. Vérifier passages acceptés/refusés, porte forcée/maintenue, relecture vidéo, synchronisation badge, désactivation, coupure d'une heure et rattrapage, commandes et accusés, retour à l'état sûr. Constater physiquement le comportement d'une issue de secours sans PSIM. Vérifier les droits des rôles et les journaux. | Fiche de qualification Dahua signée ; écarts de protocole corrigés ; aucun usage d'ouverture à distance si la porte ou son repli ne sont pas sûrs. |
| **7–11 déc. — J6 : pilote R3 et recette utilisateur** | Une semaine de passages réels sous supervision du responsable sécurité ; essai d'une perte de liaison et des cas de badge perdu. Revue visuelle des écrans Accès/Titulaires/Règles, export, rapports et portail sans données nominatives. Rejouer la suite complète et les scénarios de sécurité. | Recette R3, mesures de latence et absence de passages perdus, liste des limites acceptées par le client. |
| **14–18 déc. — J7 : décision R3 et remise** | Correction finale, version étiquetée, configuration reproduisible, sauvegarde et retour arrière testés, formation, procédures de porte/évacuation et astreinte. | **Go / no-go R3** signé ; déploiement limité aux contrôleurs et fonctions qualifiés. Revue d'exploitation programmée un mois plus tard. |

Les dates R1/R2 et R3 sont des **cibles de projet**, pas des dates de livraison garanties. Une semaine supplémentaire est à prévoir si la première qualification matérielle échoue ; le délai de commande peut ajouter davantage.

## 5. Portes de qualité avant chaque mise en service

### G0 — Version maîtrisée

- Un commit/tag candidat identifie exactement le code et les packs déployés ; les changements Android non commités ont un statut explicite.
- `npm run typecheck` et la suite pertinente sont verts sur la version candidate. Un test instable est diagnostiqué et relancé avec preuve ; un échec reproductible bloque la fonction concernée.
- Revue des rôles, secrets, clés de passerelle, sauvegardes et possibilité de revenir à la version précédente.

### G1 — Matériel et parcours PSIM

- Chaque **modèle exact** vendu est `qualified` dans le registre après essai réel signé ; modèle/firmware/numéro de série sont consignés. Le pack exact est installé et reçu sur un site désigné. Un pack ne passe pas en production avec `--allow-unqualified`.
- Pour chaque détecteur : alarme, état normal, défaut et silence ; image de la caméra liée ; notification de niveau 1 et escalade de niveau 2 constatées par les destinataires. Le délai **< 5 s** du guide ne peut être promis que sur une source qui le permet ; le polling Tuya à 60 s ne le permet pas.
- Pour chaque caméra : image réelle, flux utilisable et relecture depuis l'enregistreur ; arrêt d'une caméra et retour en ligne observés.
- Portail : résumé reçu, droits client vérifiés, service relancé après redémarrage, période sans surveillance visible. Sauvegarde restaurée sur une autre machine et supervision externe prouvées.
- La surveillance locale sans Internet est démontrée **sur la variante locale retenue**. L'envoi d'alertes à distance est testé séparément sur le moyen disponible.

### G2 — Application des agents

- `check-agents` est vert après configuration ; un agent réussit QR puis NFC sur le vrai téléphone.
- Durant 7 nuits : quatre rondes prévues par nuit, anomalies et rondes manquées détectées, rapports cohérents ; l'agent peut terminer un poste de 12 h sans recharge selon l'objectif du guide.
- Mesures du guide : alarme reçue en moins de 10 s **application ouverte** ; SOS au poste en moins de 5 s dans 99 % des essais, aucun SOS perdu sans avertissement ; formation de l'agent en moins de 15 minutes. Toute mesure non atteinte devient un écart à corriger, pas une conformité présumée.
- Les personnes prévenues connaissent les essais ; les données du personnel et la durée de conservation ont été cadrées avant exploitation.

### G3 — Contrôle d'accès

- Sur matériel Dahua réel : porte forcée → incident en moins de 3 s en médiane ; ordre d'ouverture → accusé en moins de 2 s au 95e percentile ; **100 %** des ouvertures portent un motif au journal.
- Après 1 h d'arrêt du PSIM, aucun passage perdu ; les badges continuent de fonctionner dans le contrôleur local. La désactivation d'un badge est vérifiée sur la porte, pas seulement à l'écran.
- La coupure de courant et la défaillance du PSIM n'empêchent pas l'évacuation par une issue de secours. Le PSIM ne déclenche jamais seul une ouverture sur une alarme incendie.
- Les écrans, exports et rapports sont revus avec l'exploitant ; le portail ne reçoit aucun nom ni numéro de badge.

## 6. Pilotage hebdomadaire

Chaque vendredi, publier un tableau à cinq lignes : jalon prévu/réalisé, essais réussis/échoués, matériel reçu/manquant, décisions client attendues, date cible révisée. Un écart bloquant reçoit un responsable et une date de reprise. Le responsable technique tranche le **go/no-go** sur les preuves ; le client valide la recette du site et le périmètre commercial.

Au démarrage, confirmer uniquement ces décisions structurantes : **référence locale de détection fumée et fournisseur**, **site d'essai du pack exact et contenu de la première offre vendable**, **contrôleur Dahua du pilote**, **personnes et créneaux de recette**. Les variantes non retenues n'entrent pas dans les critères de R1 à R3.

## Sources internes à maintenir à jour

- `PRODUCT.md` ; `docs/Pack-standard-4-cameras-2-detecteurs.docx` ; `packs/pack-standard-4cam-2fumee/pack.json` ; `qualification/registry.json`.
- `docs/HANDOFF-agents-2026-10-17.md` ; `docs/ESSAI-AGENTS-KOUROUMA.md` ; `docs/HANDOFF-controle-acces.md` ; `docs/PRD-CONTROLE-ACCES.md`.
- `docs/MISE-EN-SERVICE.md` ; `docs/QUALIFICATION.md` ; `docs/PORTAIL.md` ; `docs/HANDOFF-prod-2026-10-11.md`.
