# Dossier de cadrage d'un test d'intrusion externe

Document à remettre à la société ou au testeur indépendant mandaté avant d'exposer le PSIM. Il dit **ce qu'il faut attaquer**, **ce qui a déjà été vérifié** (pour ne pas payer deux fois la même chose), **comment préparer l'instance** et **ce qu'on attend en retour**.

> Un PSIM supervise des alarmes incendie et intrusion : un test d'intrusion ne doit **jamais** être mené sur l'installation en service, ni avec de vrais destinataires d'alertes. Voir « Règles du test ».

## 1. Ce que le PSIM est

Serveur Node.js (TypeScript natif) unique, une instance, une base SQLite, sans composant externe obligatoire :

| Surface | Détail |
|---|---|
| **Interface web + API REST** | HTTPS (ou HTTP local), port 3033 par défaut. Sessions par cookie `HttpOnly; SameSite=Strict`, rôles *opérateur* et *administrateur*, double authentification TOTP, comptes gérés dans l'interface. ~50 routes (`server/api.ts`). |
| **WebSocket temps réel** | `/ws`, même cookie, flux à sens unique d'événements. |
| **Broker MQTT embarqué** | Port 1883 (local par défaut), un compte principal et des comptes de passerelle limités à leurs détecteurs (`PSIM_MQTT_GATEWAYS`). |
| **Entrée HTTP des équipements** | `POST /api/ingest/<id>` avec jeton partagé (désactivée sans `PSIM_INGEST_TOKEN`). |
| **Flux vidéo** | ffmpeg lancé vers des caméras RTSP/ONVIF configurées par l'administrateur ; images relayées aux utilisateurs connectés. |
| **Notifications sortantes** | SMTP, Telegram, webhooks (adresses saisies par l'administrateur). |
| **Fichiers** | Base `psim.db`, `secret.key` (chiffre les secrets), sauvegardes, journaux, plan du site téléversé. |
| **Outils en ligne de commande** | `set-password`, `reset-2fa`, `restore`, `commission`, `supervise`… (accès à la machine requis). |

Modèle de confiance : l'**administrateur** est de confiance (il peut viser des adresses internes via webhooks et caméras) ; l'**opérateur** est authentifié mais ne doit pouvoir ni administrer ni lire la configuration ; un **équipement** (détecteur, passerelle) ne doit pouvoir parler que pour lui-même.

## 2. Ce qui a déjà été fait (ne pas refaire à l'identique)

- **Relecture de code indépendante** (trois axes : authentification et sessions ; entrées, injections, réseau ; configuration, secrets, déploiement), chaque constat reproduit puis corrigé avec un test. Voir la section « Sécurité » du README.
- **Auto-test en boîte noire** (`test/e2e-attack.test.ts`, 17 attaques) contre un vrai serveur : matrice d'autorisations de **toutes** les routes (sans session, opérateur, session restreinte, variantes de chemin, verbes inattendus), fuzzing de tous les corps et paramètres (aucune erreur 5xx), entrée des équipements, téléversement du plan, requêtes HTTP malformées, en-têtes géants, connexions lentes, rafale. Résultat : aucune erreur interne, aucun plantage.
- Tests de régression de sécurité réels : `test/e2e-security.test.ts` (WebSocket, verrouillage, 2FA, CSRF, révocation), `test/hardening.test.ts` (MQTT, configuration, journal, rapports), `test/security.test.ts`.
- `npm audit --omit=dev` : 0 vulnérabilité connue (à re-vérifier au moment du test).

**Ce que ces vérifications ne disent pas** : elles ont été faites par l'équipe qui a écrit le code, sur des instances de test, jamais sur une installation réelle, jamais par un tiers, et jamais avec du matériel réel.

## 3. Ce que nous voulons voir attaqué en priorité

1. **Authentification et sessions** : contournement du mot de passe, de la 2FA (enrôlement, codes de secours, défi), fixation, vol de session, élévation opérateur → administrateur, comptes créés par un administrateur (mot de passe temporaire).
2. **Broker MQTT** : usurpation d'un détecteur par un autre compte, lecture des messages des autres, déni de service (paquets, connexions, `retain`), attaque sur la clé de session MQTT sur le réseau si le broker est exposé.
3. **Entrée HTTP des équipements** : jeton partagé, rejeu, inondation.
4. **WebSocket** : détournement inter-origines, survie après révocation, trames malformées.
5. **Injection** dans ce qui est rendu : noms d'équipements, commentaires d'incident, journal, rapports HTML et CSV (formules), e-mails, Telegram.
6. **SSRF et accès réseau interne** via webhooks, caméras (RTSP/ONVIF), heartbeat, tests d'envoi.
7. **Fichiers** : téléversement du plan (SVG, signatures), restauration de sauvegarde (manifeste forgé), traversée de chemin, permissions du dossier de données et de `secret.key`.
8. **Intégrité du journal** : modification ou suppression d'entrées avec accès à la base (sans, puis avec connaissance du mécanisme).
9. **Déploiement** : droits des fichiers et du dossier d'installation, tâche planifiée / service, chemin de mise à jour, secrets dans les journaux et les sauvegardes.
10. **Déni de service applicatif** : un utilisateur authentifié ou un équipement compromis peut-il bloquer la boucle de contrôle (le PSIM détecte alors son propre blocage et se fait relancer) ?

Limites **déjà connues et acceptées** (ne pas les remonter comme découvertes, sauf aggravation) : voir « Limites connues » dans la section Sécurité du README (mots de passe de caméras dans la ligne de commande de ffmpeg, jeton d'ingestion unique, opérateur pouvant désarmer une zone 24 h, sauvegardes non chiffrées, pas de step-up, HSTS long avec certificat auto-signé).

## 4. Préparer l'instance de test

1. **Machine ou VM dédiée**, sans accès au réseau de production ni à Internet (sauf si la sortie est testée).
2. Installer comme en production : `npm install`, puis `npm run init-production -- --host <nom> --host <ip> --listen 0.0.0.0` (génère `.env.production`, des mots de passe aléatoires et un certificat). Pour une instance peuplée, importer un plan et déclarer quelques équipements.
3. **Désactiver toute notification réelle** : ne renseigner ni SMTP, ni Telegram, ni webhook ; ne pas renseigner `PSIM_HEARTBEAT_URL`. Les alertes de test doivent rester sur l'écran.
4. Remettre au testeur, **par canal séparé** : un compte **administrateur** (2FA activée, avec ses codes de secours), un compte **opérateur**, le mot de passe MQTT principal, un compte de **passerelle** limité à quelques détecteurs, et le jeton d'ingestion. Un test **sans** identifiants (boîte noire) et un test **avec** (boîte grise) sont complémentaires.
5. Fournir le code source (le dépôt) pour une revue assistée, ou non, selon l'objectif.
6. Faire une **sauvegarde** de l'instance avant le test (`npm run backup`) pour pouvoir revenir en arrière.

## 5. Règles du test

- Périmètre : l'instance de test uniquement. Interdit : l'installation en service, les réseaux du client, tout service tiers (SMTP, Telegram, supervision externe) autrement qu'avec des comptes de test.
- Le déni de service **volumétrique** est hors périmètre ; le déni de service **applicatif** (une requête ou un message qui bloque ou plante le PSIM) est dans le périmètre.
- Toute découverte critique (exécution de code, contournement d'authentification, arrêt à distance sans identifiant) est signalée **immédiatement**, sans attendre le rapport.
- Confidentialité : les mots de passe, jetons et clés remis sont détruits à la fin du test.

## 6. Livrables attendus

- Une liste de constats classés (critique, élevée, moyenne, faible, information) avec, pour chacun : **la preuve reproductible**, l'impact réaliste, la correction proposée.
- Les points vérifiés et trouvés sains.
- Un **re-test** après correction (inclus dans le devis).
- Idéalement, un rapport utilisable tel quel par un assureur ou un client : périmètre, méthode, date, version testée (`git log -1`), conclusions.

## 7. Après le test

- Corriger, ajouter un **test de régression** par constat (le modèle existe : `test/e2e-security.test.ts`).
- Mettre à jour la section « Sécurité » du README avec les limites restantes.
- Refaire passer `npm test` (la suite complète) et `npm audit`.
- Conserver le rapport avec la version testée ; un changement important (nouvelle surface : accès distant, nouveau protocole) justifie un nouveau test.
