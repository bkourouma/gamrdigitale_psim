# PRD — Contrôle d'accès dans le PSIM

Rédigé le 17 octobre 2026 par le chef de projet. Statut : **proposition, à valider par l'utilisateur** (section 15).
Références : `PRODUCT.md`, `docs/Catalogue-equipements-et-pilote-SODEFOR.docx` (§ 3.6, § 6), `docs/COMMANDES.md`
(branche `commandes-actionneurs`), `docs/PRESENCE-REGLES.md`, `docs/VISAGES.md`.

---

## 1. Résumé

Donner au PSIM la maîtrise des **portes, barrières et badges** d'un site : voir en temps réel l'état de chaque porte,
tenir le **journal des passages** (qui, où, quand, accepté ou refusé), lever une **alarme** quand une porte est forcée ou
reste ouverte, **ouvrir à distance** une porte ou une barrière depuis la fiche d'un incident, et, dans un second temps,
**gérer les titulaires de badges** (personnes, droits, horaires, badges visiteurs) depuis le PSIM.

Principe directeur : **le contrôleur d'accès décide, le PSIM supervise et commande.** La décision d'ouvrir une porte
pour un badge reste dans le contrôleur, sur place, et continue de fonctionner si le PSIM, le réseau ou le PC tombent.

## 2. Problème

- Le catalogue propose lecteurs, contrôleurs, serrures, barrières, interphones et tourniquets, mais le PSIM **ne gère ni
  badges ni portes** (catalogue § 3.6). Aujourd'hui un client doit utiliser le logiciel du fabricant à côté du PSIM :
  deux écrans, deux journaux, aucune corrélation avec les caméras et les alarmes.
- Les incidents d'accès (porte forcée, porte maintenue ouverte) sont déjà **compris** par le PSIM (`server/sources.ts` :
  `door_forced`, `door_held_open`, `badge_denied_repeated`), mais rien ne les **produit** : aucun contrôleur n'est
  raccordé, et les passages normaux (`badge_granted`, `door_opened`) ne sont que des signes de vie, **jamais conservés**.
- Résidences sécurisées, bureaux, banques, écoles, hôtels (segments du catalogue) placent l'accès en tête de leurs
  besoins, avec la vidéo.

## 3. Utilisateurs

| Profil (PRODUCT.md) | Besoin principal |
|---|---|
| Agent au poste de garde (opérateur) | Voir qu'une porte est forcée, regarder la caméra de la porte, ouvrir la barrière à un livreur attendu, savoir qui est passé |
| Responsable sécurité (administrateur) | Gérer qui a accès où et quand, retirer un badge perdu, sortir le journal des passages d'une période, recevoir le rapport |
| Technicien installateur | Déclarer les contrôleurs et les portes, les placer sur le plan, lier les caméras, faire la recette |
| Direction (portail) | Savoir que les accès fonctionnent et combien d'incidents d'accès, **sans noms** |

## 4. Objectifs et non-objectifs

**Objectifs**
1. Toute porte raccordée apparaît sur le plan avec son état (fermée, ouverte, forcée, maintenue ouverte, hors ligne).
2. Chaque passage est conservé, consultable, filtrable et exportable ; il est relié aux caméras de la porte.
3. Les situations anormales deviennent des incidents avec le circuit habituel (son, notifications, escalade, preuve).
4. L'opérateur ouvre une porte ou une barrière à distance, de façon sûre et tracée.
5. (Phase 2) L'administrateur gère titulaires, badges, groupes et horaires dans le PSIM, poussés vers les contrôleurs.

**Non-objectifs**
- Remplacer le contrôleur ou décider l'ouverture dans le PSIM (jamais de « badge → PSIM → ouverture » en ligne).
- Gérer la sécurité incendie des issues : le déverrouillage des issues de secours reste **matériel** (sécurité positive,
  centrale incendie). Le PSIM peut aider (section 8.6), il n'en est jamais l'unique moyen.
- Paie, pointage des heures de travail : hors périmètre (les pointeuses restent un produit à part).
- Interphonie audio/vidéo complète (SIP) : phase 3, PRD séparé.

## 5. Existant à réutiliser

| Élément | Où | Usage ici |
|---|---|---|
| Catégorie `access` et événements d'accès | `server/sources.ts` | Alarmes porte forcée / maintenue / refus répétés : déjà définies, libellés français compris |
| Détecteurs, zones, plan, caméras liées, images d'incident | `server/engine.ts`, `snapshots.ts` | Une **porte** est un détecteur de catégorie `access` ; ses caméras liées s'affichent à l'alarme |
| Passerelle GAMR (modules, file disque, renvoi) | `gateway/` | Les pilotes de contrôleurs sont des **modules de passerelle** |
| Canal de commande signé (`lock`, `gate`) | branche `commandes-actionneurs`, `docs/COMMANDES.md` | Ouverture à distance — **à fusionner d'abord** (5 correctifs obligatoires de la revue) |
| Plages horaires | `server/arming.ts` (`Window`) | Horaires d'accès des groupes |
| Moteur de règles de présence | `server/rules.ts` | Règles d'accès (« badge utilisé hors horaires »), phase 3 |
| Journal infalsifiable, dossier de preuve | `auditchain.ts`, `proofpack.ts` | Actions d'administration et ouvertures à distance ; passages joints aux preuves |
| Portail | `portal/` | Indicateurs d'accès agrégés, sans données nominatives |

## 6. Parcours

**P1 — Porte forcée la nuit.** Le contrôleur signale « porte ouverte sans badge ». Le PSIM ouvre un incident critique
« Porte forcée — Entrée personnel », affiche la caméra de la porte et l'image prise à l'instant, sonne et prévient. L'agent
regarde, voit un intrus, qualifie « événement réel » ; le dossier de preuve contient l'image, l'heure et les 10 derniers
passages de cette porte.

**P2 — Livreur à la barrière.** L'agent voit le camion sur la caméra du portail, ouvre la fiche de la barrière, clique
« Ouvrir », saisit la raison (« livraison gaz ») et son mot de passe ; la barrière s'ouvre, l'action est journalisée.

**P3 — Badge perdu (phase 2).** Le responsable cherche « Konan », clique « Désactiver le badge 0012345 » ; le PSIM le
retire de tous les contrôleurs en quelques secondes ; une tentative ultérieure apparaît « Badge désactivé — refusé ».

**P4 — Qui est entré dans la salle serveur hier ?** Le responsable filtre le journal (porte « Salle serveur », date d'hier),
obtient la liste et l'exporte en CSV, avec un lien vers la vidéo de chaque passage.

**P5 — Contrôleur hors ligne.** Le contrôleur ne répond plus : la porte passe « hors ligne » (jamais « fermée » à tort),
un avertissement apparaît ; les badges continuent de fonctionner localement ; les passages sont récupérés au retour.

## 7. Exigences fonctionnelles

Priorité : **M** obligatoire (phase 1), **S** souhaitable (phase 2), **C** plus tard (phase 3).

### 7.1 Équipements
| # | Exigence | Prio |
|---|---|---|
| F1 | Déclarer un **contrôleur** (marque, modèle, adresse, identifiants scellés, passerelle) et ses **portes** (1 à 4 par contrôleur). Chaque porte est un détecteur `access` placé sur le plan, avec zone, étage et caméras liées. | M |
| F2 | État de porte : `fermée`, `ouverte` (passage normal), `forcée`, `maintenue ouverte`, `hors ligne`, `en défaut`. Une porte dont le contrôleur se tait est **hors ligne**, jamais « fermée ». | M |
| F3 | Lecteurs, contacts de porte, boutons de sortie : remontés par le contrôleur, pas déclarés un à un. | M |
| F4 | Barrières, portails, tourniquets raccordés au contrôleur : traités comme des portes (même modèle). | S |

### 7.2 Journal des passages
| # | Exigence | Prio |
|---|---|---|
| F5 | Conserver chaque événement : heure **du contrôleur** et heure de réception, porte, sens (entrée/sortie si connu), **identifiant de badge**, nom du titulaire si connu, méthode (badge, code, empreinte, visage, bouton de sortie, ouverture à distance), résultat (accepté / refusé + motif). | M |
| F6 | Écran « Accès » : liste filtrable (période, porte, titulaire, badge, résultat), pagination, lien « voir la vidéo » (enregistrement à l'heure du passage). | M |
| F7 | Export CSV d'une sélection ; l'export est journalisé (qui, quoi, quand). | M |
| F8 | Récupération des passages **manqués** pendant une coupure (le contrôleur garde sa mémoire hors ligne) : dédoublonnage par identifiant d'événement, marqués « reçus en différé ». | M |
| F9 | Durée de conservation réglable (par défaut 3 mois, à valider juridiquement), purge automatique, journalisée. | M |
| F10 | Vue « dernier passage » par porte sur la fiche de la porte. | S |

### 7.3 Alarmes
| # | Exigence | Prio |
|---|---|---|
| F11 | `door_forced` → alarme critique ; `door_held_open` → pré-alarme, puis alarme si toujours ouverte après N minutes (réglable par porte) ; `badge_denied_repeated` → pré-alarme (le contrôleur ou le module de passerelle compte les refus : X refus en Y secondes sur une porte). | M |
| F12 | Un refus isolé n'est **jamais** une alarme (fait courant) mais il est journalisé. | M |
| F13 | Sabotage du lecteur ou du contrôleur (`tamper`) → alarme toujours active, même zone désarmée. | M |
| F14 | Armement : une porte peut être rattachée à une zone armée ; pendant l'armement, **toute** ouverture (même badge accepté) devient pré-alarme, sauf groupes autorisés la nuit. | S |
| F15 | Règles d'accès dans le moteur de règles : « badge du groupe X hors de ses horaires », « badge Y utilisé », « deux refus sur deux portes en 1 min ». | C |
| F16 | Corrélation **badge + visage** (anti-prêt de badge) avec la caméra visage (`docs/VISAGES.md`). | C |

### 7.4 Ouverture et verrouillage à distance
| # | Exigence | Prio |
|---|---|---|
| F17 | Boutons « Ouvrir (impulsion) », « Ouvrir N minutes », « Verrouiller » sur la fiche d'une porte et dans la fiche d'un incident d'accès ; passent **exclusivement** par le canal de commande signé (`docs/COMMANDES.md`) : raison obligatoire, mot de passe redemandé, limite de fréquence, accusé, retour automatique à l'état sûr. | M |
| F18 | Une porte d'**issue de secours** n'accepte jamais « Verrouiller ». | M |
| F19 | Mode « porte ouverte » programmé (heures de bureau) : géré **dans le contrôleur** (phase 2), affiché dans le PSIM. | S |
| F20 | « Tout ouvrir » (évacuation) : réservé administrateur, double confirmation, journalisé ; ne remplace jamais le déverrouillage matériel par la centrale incendie. | S |

### 7.5 Titulaires et droits (phase 2)
| # | Exigence | Prio |
|---|---|---|
| F21 | Titulaires : nom, prénom, groupe(s), badges (un ou plusieurs), code PIN facultatif, date de début et de fin, photo facultative, statut (actif, suspendu). | S |
| F22 | Groupes d'accès : portes autorisées × plages horaires (format `Window` de l'armement) × jours fériés. | S |
| F23 | Badges visiteurs : durée limitée (fin automatique), accompagnateur, motif ; liste des visiteurs présents. | S |
| F24 | Synchronisation PSIM → contrôleurs : création, modification, suspension, suppression ; état « synchronisé / en attente / échec » par contrôleur ; reprise automatique ; le PSIM n'efface jamais en masse sans confirmation. | S |
| F25 | Import CSV des titulaires (mise en service d'un site existant) avec rapport d'erreurs. | S |
| F26 | Droits PSIM : opérateur = consulter le journal et ouvrir selon les droits du canal de commande ; administrateur = gérer titulaires, groupes et portes. | S |

### 7.6 Rapports et portail
| # | Exigence | Prio |
|---|---|---|
| F27 | Rapport périodique (e-mail existant) : incidents d'accès, portes les plus en défaut, refus par porte. Sans liste nominative par défaut. | S |
| F28 | Portail : nombre de portes, disponibilité, incidents d'accès ; **jamais** de noms ni de numéros de badge. | S |

## 8. Exigences non fonctionnelles

1. **Autonomie** : aucune ouverture de porte par badge ne dépend du PSIM ; la perte du PSIM n'empêche personne d'entrer
   ni de sortir.
2. **Sécurité des commandes** : uniquement via le canal signé (HMAC, TTL, anti-rejeu, rôles, mot de passe redemandé) ;
   aucun autre chemin vers une serrure.
3. **Secrets** : identifiants des contrôleurs scellés (`server/secrets.ts`), jamais renvoyés au navigateur ni journalisés.
4. **Données personnelles** : numéros de badge et noms visibles des seuls rôles qui en ont besoin ; journal des
   consultations et des exports ; durée de conservation appliquée ; aucune donnée nominative vers le portail.
5. **Biométrie** (lecteurs à empreinte ou visage) : les gabarits restent **dans le lecteur** ; le PSIM n'en stocke pas.
6. **Volume** : 10 000 passages par jour sur un site sans ralentir l'écran de supervision ; recherche sur 3 mois < 2 s.
7. **Horloge** : heure du contrôleur conservée ; écart > 2 min signalé comme défaut de l'équipement.
8. **Accessibilité / langue** : français courant, chaque état dit ce qu'il signifie et ce qu'il faut faire
   (`PRODUCT.md`).
9. **Sécurité incendie** : une alarme feu peut demander l'ouverture des portes « de secours » configurées, mais
   l'installation doit fonctionner sans cela (sécurité positive des serrures) — la recette le vérifie.

## 9. Architecture proposée

```
Lecteurs ── Contrôleur d'accès ──(réseau)── Passerelle GAMR : module « acces-<marque> » ──MQTT──► PSIM
                                                   ▲                                              │
                                                   └──────── ordres signés (lock/gate) ◄──────────┘
```

- **Pilotes = modules de passerelle** (`gateway/src/modules/acces-<marque>/`), un par famille de contrôleurs :
  - **Dahua** (contrôleurs ASC, terminaux visage ASI) : même flux d'événements HTTP que `server/dahua.ts`
    (code `AccessControl`, `DoorStatus`…) — **premier candidat**, cohérent avec le parc Dahua du client.
  - **ZKTeco** (très répandu en Côte d'Ivoire, vendu localement) : protocole « push » HTTP du constructeur — second
    candidat.
  - **Contact sec / Wiegand** générique via un relais IP : porte simple sans gestion de titulaires (dégradé).
- Le module traduit vers des messages existants (`{event: "door_forced"}`, etc.) **plus** un nouveau message de
  passage `{type: "access", ...}` (F5) ; il garde en file disque ce qui n'a pas pu partir (socle existant).
- **Commandes** : le contrat `ModuleContext` de la passerelle est aujourd'hui en sortie seule ; l'ouverture à distance
  exige le **pilote côté passerelle** décrit dans `docs/COMMANDES.md` § 5 (réception, vérification de signature et de
  TTL, anti-rejeu, exécution, accusé).
- **PSIM** : nouveau module `server/access.ts` (table `access_event`, recherche, export, purge) ; phase 2
  `server/accessholders.ts` (titulaires, groupes, synchronisation) ; routes `/api/access/*` ; écran `web/access.js`.
- **Modèle de données (phase 1)** : `access_controller` (id, marque, modèle, hôte, identifiants scellés, passerelle),
  `access_door` (id = détecteur `access`, contrôleur, numéro de porte, issue de secours, délai « maintenue ouverte »),
  `access_event` (id, door_id, at_device, at_received, direction, credential, holder_id, method, result, reason,
  device_event_id unique par contrôleur, late).

## 10. Matériel cible et qualification

| Matériel | Exigences (catalogue § 3.6) | Qualification |
|---|---|---|
| Contrôleur 1 à 4 portes | Mémoire hors ligne ≥ 50 000 événements, batterie, IP, API documentée ou protocole push | Fiche de recette à créer dans `qualification/` |
| Lecteur badge | MIFARE chiffré (pas d'EM 125 kHz, clonable), Wiegand ou OSDP | Via le contrôleur |
| Serrure / ventouse / gâche | Sécurité positive pour les issues de secours | Recette : coupure de courant → porte libre |
| Barrière, portail | Boucle de détection, cellules | Recette : commande + sécurité de fermeture |

Aucune référence n'entre dans un pack sans recette signée (règle du catalogue § 7).

## 11. Cadre légal (à faire valider par un juriste)

- Journal des passages = données personnelles (loi n° 2013-450) : information des titulaires, finalité, durée de
  conservation limitée, accès restreint.
- Lecteurs biométriques : autorisation préalable de l'ARTCI (art. 7) — même analyse que `docs/VISAGES.md` § 5.
- Contrôle des salariés : information préalable du personnel.

## 12. Mesures de succès

- Délai entre « porte forcée » sur le contrôleur et l'alarme dans le PSIM : < 3 s (médiane) sur réseau local.
- 0 passage perdu après une coupure du PSIM de 1 h (récupération F8).
- Ouverture à distance : accusé reçu < 2 s dans 95 % des cas ; 100 % des ouvertures journalisées avec raison.
- Recette d'un site de 4 portes en moins d'une demi-journée.

## 13. Phasage et lots (pour les superviseurs)

| Lot | Contenu | Dépend de | Fichiers principaux |
|---|---|---|---|
| **AC0** | Fusion du canal de commande avec ses 5 correctifs obligatoires + pilote côté passerelle | — | branche `commandes-actionneurs`, `gateway/src/` |
| **AC1** | Module passerelle Dahua accès (événements + passages + file) avec faux contrôleur de test | — | `gateway/src/modules/acces-dahua/` |
| **AC2** | Journal des passages côté PSIM : stockage, recherche, export, purge, différé | AC1 (format) | `server/access.ts`, `test/access*.test.ts` |
| **AC3** | Écran « Accès » + portes sur le plan + fiche de porte | AC2 | `web/access.js`, `web/access.css`, `web/plan.js` |
| **AC4** | Ouverture à distance depuis la porte et l'incident | AC0, AC3 | `web/incidents.js`, `server/api.ts` |
| **AC5** | Titulaires, groupes, badges visiteurs, synchronisation (phase 2) | AC2 | `server/accessholders.ts`, `web/holders.js` |
| **AC6** | Module ZKTeco | AC1 (modèle) | `gateway/src/modules/acces-zkteco/` |
| **AC7** | Règles d'accès, badge + visage, rapports, portail (phase 3) | AC5, V5 | `server/rules.ts`, `server/reports.ts`, `portal/` |

AC1 et AC0 peuvent démarrer en parallèle ; AC2 dès que le format de AC1 est figé.

## 14. Risques

| Risque | Réponse |
|---|---|
| API du contrôleur non documentée ou fermée | Qualifier avant d'acheter ; exiger API/protocole au cahier des charges |
| Ouverture à distance détournée | Canal signé, mot de passe redemandé, rôles, journal, limite de fréquence (revue de sécurité déjà faite) |
| Désynchronisation des badges | État par contrôleur, reprise, rapport « en attente / échec » visible |
| Issue de secours verrouillée par erreur | Interdit au niveau du modèle et à l'exécution (F18) ; recette matérielle |
| Volume du journal | Index par date et porte, purge, pagination |

## 15. Questions pour l'utilisateur

1. Première marque de contrôleurs à qualifier : **Dahua** (recommandé, parc existant) ou **ZKTeco** ?
2. Un site pilote : la Résidence KOUROUMA a-t-elle une porte ou un portail à équiper ?
3. Durée de conservation du journal : 3 mois par défaut, d'accord ?
4. La gestion des titulaires (phase 2) dans le PSIM est-elle nécessaire, ou le logiciel du fabricant suffit-il au début ?
5. Confirmez-vous que AC0 (fusion du canal de commande) passe en premier ?
