# PRD — Application des agents sur téléphone (alertes, rondes, SOS, position)

Rédigé le 17 octobre 2026 par le chef de projet. Statut : **proposition, à valider par l'utilisateur** (section 15).
Références : `PRODUCT.md`, `docs/Catalogue-equipements-et-pilote-SODEFOR.docx` (§ 3.9, § 6),
`docs/MISE-EN-SERVICE.md` (certificat HTTPS), `docs/TELEPHONE-ANDROID.md`, `docs/PRESENCE-REGLES.md`.

---

## 1. Résumé

Une application pour les **agents de terrain** (gardiens, rondiers, chef de poste) sur leur téléphone Android : recevoir
les alarmes de leur site et les acquitter, **faire leurs rondes** en scannant des points de contrôle (étiquettes NFC ou
QR codes), déclencher un **SOS** en un geste, et faire connaître leur **position** pendant le service. Le PSIM en tire des
alarmes « ronde manquée », « agent en détresse », un registre de main courante et un taux de rondes effectuées pour le
responsable et le portail.

Principe directeur : **les agents sont dehors, pas devant l'écran** (catalogue § 6). Le poste de garde reste le centre ;
l'application l'étend, elle ne le remplace pas.

## 2. Problème

- Aujourd'hui, l'agent qui fait sa ronde ne voit pas les alarmes ; il apprend un incident par téléphone ou par Telegram,
  sans pouvoir l'acquitter ni voir la caméra.
- Rien ne **prouve** qu'une ronde a été faite (heure, lieu, ordre) : c'est pourtant une demande récurrente des
  résidences, écoles, entrepôts et sociétés de gardiennage, et une preuve utile en cas de litige.
- Un agent seul, agressé ou blessé, n'a pas de moyen rapide et fiable de donner l'alerte avec sa position.
- Les canaux actuels (e-mail, Telegram, WhatsApp, appel par le téléphone Android du site) préviennent, mais sont **à
  sens unique**.

## 3. Utilisateurs

| Profil | Besoin |
|---|---|
| Agent de ronde / gardien | Savoir quoi contrôler, prouver son passage, signaler une anomalie avec une photo, appeler à l'aide |
| Chef de poste (opérateur) | Voir où sont les agents, envoyer un agent sur une alarme, savoir qu'une ronde est en retard |
| Responsable sécurité (administrateur) | Définir les circuits et horaires, suivre le taux de rondes, lire la main courante |
| Direction (portail) | Taux de rondes effectuées par site, sans noms ni positions |

Contexte : téléphones Android d'entrée et de milieu de gamme, souvent partagés entre équipes, réseau Wi-Fi du site
inégal, 4G variable, chaleur, pluie, piles faibles.

## 4. Objectifs et non-objectifs

**Objectifs**
1. Un agent reçoit les alarmes de ses zones et peut les acquitter et voir l'image en moins de 10 s.
2. Chaque ronde est horodatée, localisée par point de contrôle et comparée au circuit attendu ; une ronde manquée
   devient une alarme.
3. Un SOS part en un geste, avec l'identité et la dernière position connue, et arrive comme une alarme critique.
4. Le chef de poste voit sur le plan la dernière position de chaque agent en service.

**Non-objectifs**
- Remplacer le poste de garde ou la configuration (aucun réglage depuis l'application).
- Suivre un agent **hors service** (jamais de position hors service).
- Radio PTT / talkie-walkie (catalogue : « aucun raccordement »).
- iPhone en phase 1 (parc Android ; NFC et tâches de fond limités sur iOS).

## 5. Existant à réutiliser

| Élément | Où | Usage ici |
|---|---|---|
| Interface web responsive (le PSIM est déjà consulté sur téléphone) | `web/` | Base de l'application en phase 1 |
| Événements `sos`, `fall`, catégorie `people`, toujours actifs même désarmé | `server/sources.ts` | SOS et chute de l'agent |
| Incidents, acquittement, images, notifications, escalade | `server/engine.ts`, `notifications.ts` | Alarmes de l'application |
| Plan par étage, positions sur le plan | `web/plan.js`, `server/floors.ts` | Position des agents = point de contrôle sur le plan |
| Plages horaires | `server/arming.ts` (`Window`) | Horaires des rondes |
| Moteur de règles | `server/rules.ts` | « Ronde manquée », « agent immobile » réutilisent la machine à délais |
| Comptes, rôles, 2FA, sessions | `server/users.ts`, `auth.ts` | Nouveau rôle `agent` |
| Clés par équipement | `server/devicekeys.ts` | Appairage d'un téléphone au site |
| Journal infalsifiable, rapports, portail | `auditchain.ts`, `reports.ts`, `portal/` | Preuve des rondes, taux de rondes |

## 6. Parcours

**P1 — Prise de service.** L'agent ouvre l'application, saisit son code à 4-6 chiffres (téléphone déjà appairé au site),
appuie sur « Je prends mon service ». Le PSIM note l'heure ; le chef de poste le voit « en service ».

**P2 — Ronde.** À 22:00, l'application annonce « Ronde de nuit : 8 points, à finir avant 22:45 ». L'agent approche son
téléphone de l'étiquette « Portail » (NFC) ou scanne son QR code : vibration, coche verte, point suivant indiqué. Il
signale au point « Groupe électrogène » une anomalie avec une photo et un commentaire. À 22:41 la ronde est complète.

**P3 — Ronde manquée.** À 22:45 trois points n'ont pas été scannés : le PSIM ouvre une pré-alarme « Ronde incomplète —
3 points manqués (Parking, Arrière-cour, Local bouteilles) » au poste de garde ; sans nouvelle de l'agent 10 min plus tard,
elle devient critique.

**P4 — SOS.** L'agent est menacé : il maintient le bouton SOS 2 s (ou appuie 5 fois sur le bouton marche, phase 2).
Le poste de garde reçoit « SOS — Agent Kouassi — dernier point : Arrière-cour, il y a 2 min » ; les personnes prévenues
aussi. L'agent sent une vibration de confirmation. Un mode **SOS discret** (sans son ni écran) est proposé.

**P5 — Alarme pendant la ronde.** « Porte forcée — Entrée personnel » : l'agent la reçoit, voit l'image, appuie
« J'y vais » ; le poste de garde voit qui se déplace.

## 7. Exigences fonctionnelles

Priorité : **M** obligatoire (phase 1), **S** souhaitable (phase 2), **C** plus tard (phase 3).

### 7.1 Compte, appareil, service
| # | Exigence | Prio |
|---|---|---|
| F1 | Rôle **`agent`** : voit les alarmes de ses zones, acquitte, signale « j'y vais », fait des rondes, envoie SOS et main courante ; ne voit ni la configuration ni les autres sites ; ne qualifie ni ne clôture un incident. | M |
| F2 | **Appairage** d'un téléphone au site par QR code affiché dans le PSIM (administrateur) ; clé propre au téléphone (révocable, comme `devicekeys.ts`) ; téléphone perdu = révocation en un clic. | M |
| F3 | Connexion de l'agent par **code personnel** sur un téléphone appairé (téléphones partagés entre équipes) ; verrouillage après 5 essais ; session limitée à la durée du service. | M |
| F4 | Prise et fin de service ; fin automatique après la durée maximale du poste (réglable). | M |

### 7.2 Alarmes
| # | Exigence | Prio |
|---|---|---|
| F5 | Liste des alarmes ouvertes de ses zones, la plus grave d'abord ; détail avec image, étage, motif ; « Acquitter », « J'y vais », « Sur place ». | M |
| F6 | Signal sonore et vibration tant qu'une alarme n'est pas acquittée par quelqu'un (même règle que le poste de garde). | M |
| F7 | Réception **application fermée ou écran éteint** (notification système). | S |
| F8 | Vidéo en direct de la caméra liée (flux secondaire léger). | S |

### 7.3 Rondes
| # | Exigence | Prio |
|---|---|---|
| F9 | **Points de contrôle** : nom, emplacement sur le plan (étage, x, y), zone, identifiant d'étiquette ; étiquette **NFC** (NTAG) ou **QR code** imprimable par le PSIM. | M |
| F10 | **Circuits** : liste ordonnée ou non de points, durée maximale, plages de déclenchement (format `Window`), agents ou équipes concernés. | M |
| F11 | Scan d'un point : horodatage du téléphone **et** du serveur, contrôle que le point appartient au circuit en cours, retour immédiat (vibration, son, coche). | M |
| F12 | Fonctionnement **hors réseau** : les scans sont gardés sur le téléphone et envoyés au retour du réseau (marqués « reçus en différé »). | M |
| F13 | **Ronde manquée / incomplète** à l'échéance : pré-alarme listant les points manqués, critique après un délai réglable sans nouvelle (événement nommé, voir § 9). | M |
| F14 | **Main courante** : observation libre avec photo (compressée), catégorie (anomalie, dégradation, visiteur…), rattachée au point ou à la position. Peut devenir un incident sur décision du chef de poste. | M |
| F15 | Rapport de rondes : par jour, circuit, agent ; taux de points contrôlés à l'heure ; export CSV ; joint au rapport e-mail existant. | S |
| F16 | Étiquettes **anti-clonage** (NFC à message signé, type NTAG 424 DNA « SUN ») pour les sites exigeants. | C |

### 7.4 SOS et sécurité de l'agent
| # | Exigence | Prio |
|---|---|---|
| F17 | Bouton **SOS** toujours visible : appui maintenu 2 s (évite les faux appuis) ; envoie identité, heure, dernière position ; alarme **critique** catégorie `people`, événement `sos`, jamais masquée. | M |
| F18 | **SOS discret** : sans son ni changement d'écran côté agent. | M |
| F19 | Si l'envoi échoue : nouvel essai toutes les 10 s, puis **repli SMS** vers le numéro du poste (phase 2) ; l'agent voit clairement « SOS non transmis ». | M / S |
| F20 | **Homme mort** (agent immobile N minutes ou chute détectée par l'accéléromètre) : pré-alarme « Agent sans mouvement » avec 30 s pour annuler. | S |
| F21 | SOS déclenché par le bouton marche (5 appuis) ou un bouton Bluetooth. | C |

### 7.5 Position
| # | Exigence | Prio |
|---|---|---|
| F22 | Position = **dernier point de contrôle scanné** (fiable en intérieur) ; affichée sur le plan du poste de garde avec l'heure (« il y a 4 min »). | M |
| F23 | Position **GPS** facultative en extérieur, uniquement pendant le service, à intervalle réglable ; jamais conservée plus de la durée fixée. | S |
| F24 | Carte géographique des agents (sites étendus) : dépend de la carte géographique du catalogue (vague 1 forêt). | C |

### 7.6 Portail et rapports
| # | Exigence | Prio |
|---|---|---|
| F25 | Portail : taux de rondes effectuées par site et par semaine, nombre de SOS ; **jamais** de noms ni de positions. | S |

## 8. Exigences non fonctionnelles

1. **Fiabilité du SOS** avant tout : un SOS n'est jamais perdu en silence ; l'agent sait s'il est parti.
2. **Batterie** : une nuit de 12 h de service sur un téléphone d'entrée de gamme sans recharge (GPS désactivé par
   défaut ; pas de vidéo en continu).
3. **Hors ligne** : rondes et main courante utilisables sans réseau ; synchronisation dès le retour.
4. **Sécurité** : téléphone appairé + code agent ; clé par téléphone révocable ; aucune donnée sensible (mot de passe
   administrateur, clés) sur le téléphone ; données locales effacées à la fin du service ; HTTPS de bout en bout.
5. **Vie privée** : position seulement en service, durée de conservation courte, information écrite des agents
   (géolocalisation de salariés : loi n° 2013-450, à faire valider), accès à l'historique des positions réservé à
   l'administrateur et journalisé.
6. **Simplicité** : grosses cibles tactiles, lisible au soleil, français courant, utilisable avec des gants légers ;
   trois écrans principaux : Alarmes, Ronde, SOS.
7. **Réseau** : l'application parle au PSIM du site sur le Wi-Fi local ; hors du site, les canaux existants
   (Telegram, WhatsApp, appel) continuent d'alerter. Le portail reste en lecture seule et n'est **pas** un relais.

## 9. Architecture et choix techniques

### 9.1 Choix de la technologie (décision à prendre, recommandation)

| Option | Pour | Contre |
|---|---|---|
| **A. Application web installable (PWA)** servie par le PSIM | Même code et même style que `web/`, aucune boutique, mise à jour immédiate, NFC possible sur Chrome Android (Web NFC), caméra pour QR et photos | Exige un **certificat HTTPS reconnu** par le téléphone (le certificat auto-signé doit être installé) ; pas de réception fiable application fermée ; GPS de fond impossible |
| **B. Application Android native** (ou coquille Capacitor autour de A) | Notifications application fermée, SOS et homme mort en tâche de fond, GPS de fond, NFC plus robuste | Chaîne de construction Android, distribution (fichier APK ou Play Store), mises à jour à gérer |

**Recommandation : A en phase 1, B en phase 2** (coquille qui reprend le code de A et ajoute les fonctions de fond
F7, F19 repli SMS, F20, F23). Toutes les fonctions M de la section 7 tiennent dans A tant que l'application est ouverte
pendant le service — c'est le mode d'emploi en ronde.

### 9.2 Côté PSIM
- Nouveaux modules : `server/patrols.ts` (points, circuits, rondes, scans, échéances, main courante),
  `server/agents.ts` (rôle `agent`, appairage, service, positions).
- Tables : `checkpoint`, `patrol_route`, `patrol_run`, `patrol_scan` (id unique du téléphone pour dédoublonner les
  envois différés), `logbook_entry` (+ photo stockée comme les images d'incident), `agent_device`, `agent_shift`,
  `agent_position`.
- Événements ajoutés à `server/sources.ts` : `patrol_incomplete` (pré-alarme, « Ronde incomplète »), `patrol_missed`
  (alarme, « Ronde non faite »), `agent_still` (pré-alarme, « Agent sans mouvement ») ; `sos` existe déjà.
- Une ronde ou un agent porte un **détecteur virtuel** (même principe que les règles de présence : `docs/PRESENCE-REGLES.md`)
  pour réutiliser incidents, son, notifications et escalade sans les réécrire.
- Échéances calculées par une machine pure (horloge injectée), comme `createRuleMachine`.
- Routes `/api/agent/*` (rôle `agent`), `/api/patrols/*` (administration) ; écran administrateur « Rondes » dans `web/` ;
  application dans `web/agent/` (manifeste, service worker, CSP stricte maintenue).
- Certificat : `npm run make-cert` existe ; ajouter une page « Installer le certificat sur le téléphone » (QR code) au
  parcours d'appairage.

## 10. Matériel

| Élément | Exigence |
|---|---|
| Téléphone | Android 10+, NFC, 3 Go de RAM, batterie ≥ 4 000 mAh, étui renforcé ; durci IP68 pour l'extérieur (catalogue § 3.9) |
| Étiquettes | NFC NTAG213/215 autocollantes anti-métal, IP68 ; ou QR codes imprimés plastifiés ; phase 3 : NTAG 424 DNA |
| Bouton SOS Bluetooth | Phase 3, à qualifier |

## 11. Cadre légal (à faire valider)

Géolocalisation et contrôle de l'activité des salariés : information préalable et écrite des agents, finalité
(sécurité des personnes et preuve des rondes), pas de suivi hors service, durée de conservation limitée, déclaration
éventuelle à l'ARTCI (loi n° 2013-450). Les sociétés de gardiennage clientes restent employeurs et responsables.

## 12. Mesures de succès

- SOS : reçu au poste de garde en < 5 s dans 99 % des cas sur le Wi-Fi du site ; 0 SOS perdu sans avertissement.
- Taux de rondes effectuées visible dès la première semaine ; objectif fixé avec chaque client.
- Une nuit complète de service sans recharge.
- Un agent formé en moins de 15 minutes.

## 13. Phasage et lots (pour les superviseurs)

| Lot | Contenu | Dépend de | Fichiers principaux |
|---|---|---|---|
| **AG1** | Rôle `agent`, appairage par QR, code agent, service | — | `server/agents.ts`, `server/users.ts`, `server/api.ts` |
| **AG2** | Points de contrôle, circuits, rondes, échéances, alarmes « ronde incomplète / non faite », main courante | AG1 (identité) | `server/patrols.ts`, `server/sources.ts` |
| **AG3** | Écran administrateur « Rondes » (points sur le plan, QR imprimables, circuits, rapport) | AG2 | `web/patrols.js`, `web/patrols.css` |
| **AG4** | Application agent PWA : Alarmes, Ronde (NFC + QR), SOS, main courante, file hors ligne | AG1, AG2 | `web/agent/*` |
| **AG5** | Position par point de contrôle sur le plan du poste de garde ; rapport de rondes ; portail | AG2, AG4 | `web/plan.js`, `server/reports.ts`, `portal/` |
| **AG6** | Coquille Android (phase 2) : notifications de fond, SOS de fond et repli SMS, homme mort, GPS | AG4 | `mobile/android/` (nouveau) |

AG1 et la conception d'AG2 peuvent démarrer en parallèle ; AG3 et AG4 en parallèle dès qu'AG2 a figé son API.

## 14. Risques

| Risque | Réponse |
|---|---|
| Certificat HTTPS non reconnu par les téléphones (PWA bloquée) | Parcours d'installation du certificat guidé par QR ; à défaut, passage direct à l'option B |
| Faux scans (étiquette photographiée ou recopiée) | Horodatage serveur, ordre et durées plausibles ; étiquettes signées en phase 3 |
| Agent qui laisse le téléphone au poste | Homme mort et cohérence des scans (phase 2) ; c'est aussi une question d'encadrement |
| Wi-Fi absent dans certaines zones | File hors ligne (F12) ; SOS : repli SMS (phase 2) |
| Rejet par les agents (« flicage ») | Information claire, pas de suivi hors service, l'application protège d'abord l'agent (SOS) |

## 15. Questions pour l'utilisateur

1. Technologie : d'accord pour **PWA d'abord** (phase 1) puis coquille Android (phase 2) ?
2. NFC, QR code ou les deux pour les points de contrôle ?
3. Un site pilote et un ou deux agents volontaires (Résidence KOUROUMA ?) ;
4. GPS en extérieur dès la phase 2, ou position par point de contrôle seulement ?
5. Les agents sont-ils salariés du client ou d'une société de gardiennage (qui informe, qui déclare) ?
