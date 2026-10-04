# Guide de mise en service

Ce guide accompagne l'installation du PSIM sur un site réel, de la machine vide à la recette signée. Il s'appuie sur deux outils livrés avec le PSIM :

| Commande | Rôle |
|---|---|
| `npm run commission` | Contrôle l'installation réelle : heure, certificat, ffmpeg, e-mail, Telegram, webhooks, supervision externe, disque, sauvegardes, caméras, inventaire, journal. |
| `npm run commission -- watch` | Écoute les détecteurs et dit, message par message, ce que le PSIM en comprend. |
| `npm run commission -- sheet --out recette.html` | Produit la **fiche de recette** imprimable (une ligne par équipement, essais de bout en bout, signatures). |

> **Honnêteté sur ce qui est validé.** Tout le PSIM a été éprouvé avec des équipements **simulés** (caméras RTSP et ONVIF de démonstration, détecteurs simulés, faux serveurs SMTP et Telegram). **Aucun équipement réel n'a été testé.** Ce guide et ces outils existent pour que la première rencontre avec le matériel réel se fasse de façon méthodique : chaque point ci-dessous doit être constaté sur place, pas supposé.

Les contrôles de `npm run commission` sont en lecture seule et n'envoient **aucune alerte** : un message de test ne part que sur demande explicite (`--send-mail`, `--telegram-chat`).

---

## 0. Avant de venir

- [ ] **Machine** dédiée (ou au moins stable) : Windows ou Linux, Node 24 ou plus, ffmpeg installé, disque de données **et** disque de sauvegarde distincts de préférence.
- [ ] **Heure** : synchronisation automatique (NTP) activée et **bon fuseau horaire**. Les plannings d'armement, les rapports et le journal suivent l'heure du serveur.
- [ ] **Courant et réseau** : la machine sur onduleur si possible ; un réseau dédié ou protégé pour les détecteurs et les caméras.
- [ ] **Informations à obtenir du client** : liste des zones, plan du site (PNG, JPEG, WEBP ou SVG), liste des détecteurs et caméras avec leurs adresses, destinataires des alertes (niveau 1 : à l'ouverture ; niveau 2 : si personne n'acquitte), un serveur SMTP (ou un compte Telegram), une personne **extérieure au réseau du PSIM** pour la supervision externe.
- [ ] **Ports** à ouvrir ou à connaître : interface web (3033 par défaut), broker MQTT (1883 par défaut ; à n'ouvrir au réseau qu'avec TLS), SMTP sortant, HTTPS sortant (Telegram, supervision externe).

## 1. Installation et configuration

**Le plus simple** : `npm run init-production -- --host <nom-du-serveur> --host <adresse-IP>` (ajouter `--listen 0.0.0.0` pour ouvrir l'interface au réseau). Il écrit `.env.production` avec des **mots de passe aléatoires** (administrateur, opérateur, MQTT : jamais affichés, le fichier est réservé à votre compte), génère un **certificat HTTPS** auto-signé pour ces noms, choisit un dossier de données **séparé** de celui du développement (`data-prod`) et vérifie le résultat. Il **refuse d'écraser** un fichier existant, n'installe aucune tâche planifiée et ne démarre rien. Ensuite : `npm run start:prod` (ou `npm run supervise:prod`), `npm run check-config:prod`, `npm run commission:prod`.

À la main, c'est équivalent :

1. `npm install`, puis copier `.env.example` en `.env`.
2. Choisir **tous les mots de passe** (administrateur, opérateur, MQTT) : 12 caractères minimum, jamais ceux de démonstration.
3. Pour une exploitation réelle, mettre `PSIM_ENV=production` : le PSIM **refuse de démarrer** si la configuration est dangereuse. Vérifier d'abord : `npm run check-config`. En production, le PSIM crée un **site vide** (jamais de détecteurs de démonstration).
4. `PSIM_SIM_ENABLED=0` et `PSIM_DEMO_LOGIN=0` (le simulateur et les comptes cliquables n'ont rien à faire en exploitation).
5. HTTPS : `npm run make-cert -- <nom-du-serveur> <adresse-IP>` puis `PSIM_TLS_CERT` / `PSIM_TLS_KEY`, ou un proxy HTTPS (`PSIM_TRUST_PROXY=1`). Un certificat auto-signé chiffre bien, mais chaque poste affichera un avertissement tant qu'il ne l'a pas installé comme autorité de confiance.
6. Démarrer une première fois (`npm start`, ou `npm run supervise`) pour créer la base, puis lancer : `npm run commission`.

**Critère de passage** : aucun « ECHEC » dans le bilan, et chaque « ATTENTION » est soit corrigée, soit acceptée par écrit.

## 2. Comptes et sécurité

- [ ] Se connecter en administrateur, **changer** le mot de passe temporaire si demandé.
- [ ] Chaque administrateur active la **double authentification** (*Mon compte*) et **conserve ses codes de secours** hors de la machine. En production elle est imposée aux administrateurs.
- [ ] Créer **un compte par opérateur** (*Utilisateurs et accès*) ; ne jamais partager un compte.
- [ ] Vérifier qu'un opérateur ne voit ni les comptes, ni les destinataires, ni le simulateur.

## 3. Plan, zones et inventaire

- [ ] *Édition du plan* → remplacer le plan ; placer chaque pastille à son emplacement réel.
- [ ] Bâtiment à plusieurs niveaux : **ajouter les étages** (du bas vers le haut), importer le plan de chacun, ranger chaque équipement sur son étage (sélecteur *Étage*). Donner aux zones un nom **par niveau** (« Étage - Chambre 1 ») : `npm run commission` signale une zone présente sur deux étages et un étage sans plan.
- [ ] Déclarer chaque **détecteur** avec un **identifiant exact** (lettres, chiffres, `-`, `_`, 32 caractères au plus), un nom parlant, sa **zone** et sa **catégorie** (incendie, intrusion, accès, environnement). Cet identifiant est celui que l'équipement ou sa passerelle publiera : une faute de frappe et ses messages seront ignorés.
- [ ] Pour un capteur à mesure (température…) : unité, **seuils** de préalarme et d'alarme, sens. Pour un capteur qui n'émet qu'aux changements (contact de porte) : laisser la supervision à « non supervisé » ; pour un équipement qui émet en continu : régler son délai de signe de vie.
- [ ] **Lier** chaque détecteur aux caméras qui voient sa zone : c'est ce qui donne une image à l'opérateur à l'ouverture de l'incident.
- [ ] Zones d'intrusion : régler le **planning d'armement** (*Armement des zones*).
- [ ] Enregistreur Dahua : pour chaque détecteur d'intrusion alimenté par une caméra, *Source* → caméra, voie, type d'événement → **Tester (20 s)** en passant devant la caméra, puis *Enregistrer la source*. L'état « Connecté à l'appareil » doit s'afficher.
- [ ] Destinataires limités à une zone (gardien, voisin) : *Notifications* → *Zones…* ; vérifier qu'aucune zone n'est signalée « sans destinataire ».
- [ ] Évaluer le **risque** de chaque zone (vue *Risques*).

Une zone sans détecteur de même catégorie à proximité ne bénéficie pas de la confirmation par un voisin : c'est voulu, mais à savoir.

## 4. Détecteurs : brancher et faire la recette

### 4.1 Ce que le PSIM attend

Un message JSON sur le topic `psim/detectors/<identifiant>/state`, avec **l'un** de :

```json
{"state": "alarm"}            // normal | prealarm | alarm | fault | offline
{"event": "door_forced"}      // événement nommé (voir README, « Autres sources d'alarme »)
{"value": 41.5}               // mesure, comparée aux seuils réglés dans le PSIM
```

Connexion : broker MQTT du PSIM (local par défaut ; `PSIM_MQTT_HOST=0.0.0.0` **avec TLS** pour des détecteurs distants), identifiant `PSIM_MQTT_USER`, mot de passe `PSIM_MQTT_PASSWORD`. **Dès que plusieurs passerelles ou fournisseurs publient, donnez un compte à chacune** (`PSIM_MQTT_GATEWAYS`, limité à ses détecteurs) : avec un mot de passe partagé, n'importe quel équipement peut forger ou masquer l'alarme d'un autre. Les messages `retained` sont ignorés, 1 Ko maximum. Autres sources (contrôle d'accès, IoT) : `POST /api/ingest/<id>` avec `Authorization: Bearer <PSIM_INGEST_TOKEN>`.

**Les équipements réels ne parlent pas toujours ce langage.** Une centrale incendie, un contrôleur d'accès ou un capteur LoRa publient leurs propres formats. Il faut alors une **passerelle** (Node-RED, un script, le pont MQTT de l'équipementier) qui traduit leur message en l'un des trois ci-dessus et l'envoie avec le bon identifiant. Le PSIM ne parle ni BACnet, ni Modbus, ni OPC UA, ni Wiegand directement.

### 4.2 Recette détecteur par détecteur

1. Prévenir les destinataires qu'une **recette** commence (les messages reçus sont traités comme de vraies alarmes).
2. Imprimer la fiche : `npm run commission -- sheet --out recette.html`.
3. Lancer l'écoute : `npm run commission -- watch --minutes 30 --until-all`.
4. Déclencher chaque détecteur (bouton test de l'équipement, ou provocation maîtrisée). Pour chaque message, l'outil affiche ce que le PSIM en comprend :

| Affichage | Signification | Que faire |
|---|---|---|
| `OK  D-03 …  -> ALARME` | Message compris, l'incident s'ouvrira | Cocher « message reçu » |
| `INCONNU  Z-9` | L'identifiant n'est pas dans l'inventaire : ses messages sont ignorés | Corriger l'identifiant côté équipement, ou l'ajouter à l'inventaire **à l'identique** |
| `ILLISIBLE  D-02 : state invalide` | JSON incorrect, état ou événement inconnu, valeur non numérique, message de plus de 1 Ko | Corriger la traduction de la passerelle |
| `SILENCE  D-05` (au bilan) | Aucun message reçu | Alimentation, réseau, passerelle, identifiant, topic |

5. À la fin, **chaque détecteur** doit être « entendu » : le code de sortie est 0. Cocher dans la fiche : message reçu, alarme testée, **image visible** (caméra liée), **retour à la normale**.
6. Clôturer les incidents de la recette en « fausse alarme » avec le commentaire « recette ».

## 5. Caméras

- [ ] Pour chaque caméra réelle : *Édition du plan* → sélectionner → **Source vidéo** : *Rechercher sur le réseau* (ONVIF) ou saisie manuelle (adresse, port, identifiant, mot de passe, ou chemin RTSP).
- [ ] Bouton **Tester** : une image doit s'afficher. Sinon, le message indique la cause probable (identifiants refusés, mauvais port, flux non activé, caméra injoignable).
- [ ] Vérifier la **fluidité** et la **latence** sur le mur vidéo ; préférer le flux secondaire (plus léger) pour l'affichage.
- [ ] `npm run commission` teste aussi chaque caméra une à une (sans `--skip-cameras`).

La recherche ONVIF utilise la multidiffusion UDP : elle peut être bloquée par un pare-feu ou ne pas traverser un autre sous-réseau. La saisie manuelle fonctionne toujours.

## 6. Notifications

- [ ] `.env` : `PSIM_SMTP_*` (et/ou `PSIM_TELEGRAM_TOKEN`). `npm run commission` vérifie la connexion et l'authentification **sans envoyer** ; `--send-mail <adresse>` ou `--telegram-chat <id>` envoie un message de test.
- [ ] *Notifications* → ajouter les **destinataires** (niveau 1 et niveau 2). Bouton **Envoyer un message de test** : chacun doit confirmer la réception.
- [ ] Tester l'**escalade** : ouvrir un incident, ne pas l'acquitter, constater l'alerte de niveau 2 après le délai.
- [ ] Expliquer aux destinataires **quoi faire** à la réception d'une alerte (qui acquitte, qui appelle qui).
- [ ] Rapport automatique par e-mail : le régler (*Rapports et exports*) et **envoyer un test** (« Envoyer le dernier rapport maintenant »).

## 7. Reprise après panne et supervision externe

- [ ] **Supervision externe** : créer un moniteur de type « dead man's switch » (healthchecks.io, Uptime Kuma), renseigner `PSIM_HEARTBEAT_URL`, et choisir une alerte qui part vers **quelqu'un en dehors du réseau du PSIM**. `npm run commission` envoie un signal et vous demande de **constater** qu'il apparaît.
- [ ] **Relance automatique** au démarrage de la machine, au choix. **Poste ordinaire, sans droits d'administrateur** : `scripts/windows-service.ps1 -Action Install -EnvFile .env.production -AtLogon` (tâche de votre session : le PSIM démarre à l'ouverture de session et tourne sous votre compte ; à réserver à un poste de supervision toujours connecté). Avant, retirez aux utilisateurs ordinaires le droit de modifier le dossier : `scripts/windows-harden-folder.ps1` (`-WhatIf` pour voir les commandes ; à lancer vous-même, il modifie des droits d'accès). Sinon : Windows, `scripts/windows-service.ps1 -Action Install -EnvFile .env.production` (**refuse** d'installer si le dossier du PSIM est modifiable par des utilisateurs ordinaires : corrigez d'abord les droits ; le fichier d'environnement est lu en mode strict) (tâche planifiée qui relance le PSIM et contrôle sa santé chaque minute ; essayez d'abord avec `-WhatIf`, ce script n'a été validé qu'en simulation) ; Linux, `deploy/psim.service` (systemd) ; partout, une tâche de démarrage qui exécute `npm run supervise` (relance avec pause croissante, détection des blocages, arrêt propre).
- [ ] **Essai de panne** : tuer brutalement le processus du PSIM ; il doit être relancé, la **période sans surveillance** doit apparaître au journal et une notification doit partir.
- [ ] **Essai de coupure réseau** : débrancher le PSIM quelques minutes ; la supervision externe doit alerter.
- [ ] **Détecteur muet** : débrancher un détecteur supervisé ; il doit passer « hors ligne » après le délai, avec notification.

## 8. Sauvegardes et journal

- [ ] `PSIM_BACKUP_DIR` sur **un autre disque** ; `PSIM_BACKUP_EVERY_H=24`. Faire une première sauvegarde : `npm run backup`.
- [ ] **Copier les sauvegardes hors de la machine** (autre site, nuage chiffré) : une sauvegarde sur la même machine ne protège pas d'un incendie ou d'un vol.
- [ ] **Essai de restauration sur une autre machine** (`npm run restore`) : une sauvegarde jamais restaurée n'est pas une sauvegarde.
- [ ] **Journal infalsifiable** : `npm run verify-journal` doit répondre « INTEGRE ». **Noter l'ancre** (`1234:ab12…`) et la conserver hors de la machine (elle figure aussi dans les rapports par e-mail et le manifeste des sauvegardes).

## 9. Recette de bout en bout

Rejouer sur place, devant le client, les essais de la fiche de recette :

1. **Alarme réelle** : un détecteur déclenché → incident en moins de 5 s, alerte sonore, caméras liées, image jointe, notification chez chaque destinataire de niveau 1.
2. **Escalade** : non acquitté → le niveau 2 est prévenu.
3. **Fausse alarme** : acquitter, remettre à la normale, clôturer avec qualification.
4. **Détecteur coupé**, **PSIM tué**, **réseau coupé** (section 7).
5. **Rapport** reçu par e-mail avec ses pièces jointes.

Faire **signer** la fiche par l'installateur et le responsable du site, et en conserver un exemplaire.

## 10. Remise au client

- [ ] Fiche de recette signée, `.env` sauvegardé **hors de la machine** (il contient des mots de passe : le protéger).
- [ ] Clé `data/secret.key` (chiffre les mots de passe des caméras) sauvegardée avec le reste : sans elle, il faut ressaisir ces mots de passe.
- [ ] Liste des comptes, des destinataires, de la personne de la supervision externe.
- [ ] Procédures remises : que faire à une alerte, qui appeler, comment restaurer une sauvegarde, comment lire le panneau *Système*.
- [ ] Date de la **première revue** (un mois après) : contrôle du taux de fausses alarmes, des détecteurs jamais entendus, des sauvegardes, du rapport reçu.

---

## Dépannage rapide

| Symptôme | Piste |
|---|---|
| `npm run commission` : « base d'une version antérieure » | Démarrer le PSIM (version actuelle) une fois : il migre la base sans rien perdre. |
| Détecteur « jamais entendu » | `npm run commission -- watch` : l'identifiant, le topic, le format ; puis le réseau et l'alimentation. |
| Aucune image de caméra | Bouton *Tester* : le message nomme la cause. ffmpeg doit être installé (`PSIM_FFMPEG`). |
| Alertes e-mail non reçues | `npm run commission -- --send-mail <adresse>` ; vérifier `PSIM_SMTP_FROM`, les indésirables, le port (587 STARTTLS, 465 `PSIM_SMTP_SECURE=1`). |
| Le PSIM refuse de démarrer en production | Il l'explique ; `npm run check-config` donne le même verdict sans démarrer. |
| Heure fausse, plannings décalés | Fuseau et synchronisation de la machine (le contrôle `Heure du serveur` mesure l'écart si la supervision externe est réglée). |
