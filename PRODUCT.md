# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Deux interfaces, des publics qui ne sont pas informaticiens.

**PSIM (supervision d'un site)** — confirmé par l'utilisateur le 5 octobre 2026, tous ces profils s'en servent :

- **Agents au poste de garde** : l'écran reste allumé jour et nuit. Ils doivent voir une alarme, comprendre où elle est et la traiter en quelques secondes (regarder les caméras, acquitter, qualifier « événement réel » ou « fausse alarme »).
- **Responsable sécurité** : consulte l'état du site, l'indice de sécurité et les rapports ; règle l'armement des zones et les personnes prévenues.
- **Technicien / installateur** (le prestataire) : ajoute les équipements, place les détecteurs sur le plan, règle les caméras et leurs sources.
- **Sur téléphone** : le PSIM est aussi consulté en déplacement.

Deux rôles dans le logiciel : opérateur (supervise, acquitte, qualifie, consulte) et administrateur (tout, plus la configuration).

**Portail client « Suivi de vos sites »** (le « dashboard ») : la direction d'un client (plusieurs sites), le responsable d'un site (un seul site) et le prestataire (tous les clients). Lecture seule, langage courant : jamais de jargon (« MTBF »), une icône et un mot pour chaque état.

## Product Purpose

GAMR-DIGITALE PSIM supervise la sécurité d'un site : incendie, intrusion, contrôle d'accès, environnement et vidéosurveillance. Une alarme apparaît sur le plan du bon étage, les caméras liées s'affichent, l'opérateur acquitte puis qualifie l'incident ; tout est inscrit dans un journal infalsifiable. Les alarmes préviennent aussi des personnes hors de l'écran (e-mail, Telegram, WhatsApp, webhook) avec escalade.

La gestion des risques calcule un **indice de sécurité GAMR** par zone : Probabilité (1-3) × Vulnérabilité (1-4) × Répercussions (1-5), de 1 à 60. Niveaux : Faible ≤ 8, Modéré ≤ 20, Élevé ≤ 36, Critique ≤ 60. L'indice du site est celui de sa zone la plus exposée ; il réagit à l'état réel des équipements.

Le portail rassemble plusieurs sites pour le client, sans vidéo : état, disponibilité, temps d'arrêt, pannes, incidents, et (décision du 5 octobre 2026) l'indice de sécurité GAMR de chaque site.

Réussite : un non-informaticien trouve chaque activité dans un menu clair, et traite une alarme sans hésiter.

## Positioning

GAMR = « Grille d'Analyse des Menaces et Risques ». La plateforme ne se contente pas d'afficher des alarmes : elle tient un indice de sécurité sur 60 calculé à partir de l'état réel des détecteurs et des caméras, zone par zone, et dit quoi faire en premier. Slogan de la marque : « GAMR-DIGITALE, la sécurité de votre entreprise en un clic. »

## Operating Context

- Le PSIM tourne sur un PC du site (Windows, tâche planifiée), servi en HTTPS local ; on l'ouvre dans un navigateur, au poste de garde comme au bureau. Alerte sonore tant qu'un incident n'est pas acquitté.
- Contexte : Côte d'Ivoire et Afrique de l'Ouest francophone (résidences, entreprises, entrepôts). Interface en français.
- Le portail est un serveur central derrière un proxy HTTPS ; les sites lui envoient un résumé signé toutes les 5 minutes, il ne les appelle jamais. Son administration se fait en ligne de commande uniquement.
- Site réel en production : « Résidence KOUROUMA », 8 caméras derrière un enregistreur Dahua, pas encore de détecteur.

## Capabilities and Constraints

- Interfaces en JavaScript sans framework ni étape de compilation (`web/` pour le PSIM, `portal/web/` pour le portail), serveurs Express.
- Politique de sécurité de contenu stricte sur les deux serveurs : tout vient du serveur lui-même (`default-src 'self'`), aucun script ni attribut `style` en ligne dans le HTML, polices hébergées localement, images locales ou `data:`.
- Le PSIM de production sert les fichiers de `web/` de ce dépôt : une modification est visible au prochain rechargement de la page.
- Comportements de sécurité à préserver : une nouvelle alarme ramène l'opérateur sur la supervision et sur l'étage concerné ; une alarme n'est jamais cachée derrière une autre vue ; le son continue tant que rien n'est acquitté ; on ne clôture pas un incident tant que le détecteur sonne ; un désarmement expire toujours ; un détecteur muet est signalé comme hors service.
- `web/floors.js` exporte `floorSummary` et `stackGap` (testés) ; `web/report.css` est intégré aux rapports envoyés par e-mail.

## Brand Commitments

- Nom : **GAMR-DIGITALE** ; produit : **PSIM**. Le logo est le mot GAMR-DIGITALE (bleu, lettres arrondies et grasses) complété de la mention PSIM et d'un repère de surveillance tiré de la jauge de l'affiche (choix du 5 octobre 2026).
- L'ASP-CI (Académie de la Sécurité Professionnelle de Côte d'Ivoire), qui porte GAMR-DIGITALE, n'apparaît pas dans l'application.
- Repères de l'affiche : bleu de marque, jauge à trois couleurs (vert, jaune, rouge), formule « 30/60 — Niveau modéré ».
- Ton : français courant, concret, phrases courtes ; chaque état dit ce qu'il signifie et ce qu'il faut faire.

## Evidence on Hand

- Affiche de la marque : `docs/marque/affiche-gamr-digitale.jpg`.
- Données de démonstration : `npm run demo` (PSIM, caméras et scénarios simulés), `npm run portal:demo` (cinq sites fictifs), aperçu local `.tmp-plan/` (plan duplex).
- Aucun témoignage, logo client, chiffre commercial ou certification à afficher : ne rien inventer.

## Product Principles

1. Une alarme ne se cache jamais : elle prend la main sur l'écran, le son et le bon étage.
2. Un état, c'est une forme, une icône et un mot ; jamais la couleur seule.
3. Chaque activité a sa place, dans un menu nommé en français courant, au même endroit sur chaque écran.
4. Pas de chiffre inventé : ce qui n'est pas mesuré ou pas évalué le dit.
5. Le terrain d'abord : lisible de loin au poste de garde, la nuit comme en plein jour, et sur un téléphone.

## Accessibility & Inclusion

- Utilisateurs non informaticiens : grandes cibles, libellés explicites, pas d'action dangereuse sans confirmation.
- Contrastes WCAG AA au minimum, utilisable au clavier, mouvements réduits respectés, états lisibles par les daltoniens (forme et texte en plus de la couleur).
