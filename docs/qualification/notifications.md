<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->
# Fiches de recette : Canaux de notification (e-mail, Telegram, WhatsApp, CallMeBot, webhook)

> Qualification d'un canal de notification : réception réelle chez un vrai destinataire, délai, escalade, détecteur muet, panne du canal.

Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.

| Profil | Libellé | Étapes obligatoires |
|---|---|---|
| [`email`](#profil-email) | E-mail (SMTP) | 11 sur 11 |
| [`telegram`](#profil-telegram) | Telegram | 11 sur 11 |
| [`whatsapp`](#profil-whatsapp) | WhatsApp (API Meta) | 11 sur 11 |
| [`callmebot`](#profil-callmebot) | CallMeBot | 11 sur 11 |
| [`webhook`](#profil-webhook) | Webhook signé | 11 sur 11 |

<a id="profil-email"></a>

## Fiche de recette : Canaux de notification (e-mail, Telegram, WhatsApp, CallMeBot, webhook)

**Profil : E-mail (SMTP)** (`email`)  
Fiche `notifications` version 1 — empreinte `f7f5dfbc43ac98e6`  
Référence : docs/MISE-EN-SERVICE.md (section 6) ; docs/WHATSAPP.md

> Qualification d'un canal de notification : réception réelle chez un vrai destinataire, délai, escalade, détecteur muet, panne du canal.

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

- Le compte du canal (serveur SMTP, bot Telegram, numéro WhatsApp Business, compte CallMeBot ou URL de webhook) et ses identifiants dans le fichier d'environnement du PSIM de recette
- Deux destinataires réels avec téléphone en main (niveau 1 et niveau 2), dans la zone de couverture réelle du site
- PSIM de recette ; `npm run commission` pour tester la connexion sans envoyer
- Chronomètre ; accès pour couper Internet du poste

### Montage du banc d'essai

1. Renseigner les variables du canal dans le fichier d'environnement du PSIM de recette (jamais dans la fiche) ; démarrer le PSIM.
2. Lancer `npm run commission` : le contrôle du canal doit être OK (connexion et authentification vérifiées sans envoi).
3. Dans « Personnes prévenues », ajouter les destinataires de niveau 1 et de niveau 2.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Noter la version du service (fournisseur, compte, numéro d'expéditeur ou domaine) à la place du numéro de série, et la référence du modèle de message approuvé s'il y en a un.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (canal de notification)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Contrôle de la connexion `notif-commission` — OBLIGATOIRE

**À faire** : Lancer `npm run commission` (sans envoi) et lire le contrôle du canal.

**Résultat attendu** : Le contrôle du canal est OK (connexion et authentification vérifiées).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Message de test reçu `notif-test` — OBLIGATOIRE

**À faire** : Bouton « Envoyer un message de test » pour chaque destinataire. Chronométrer l'arrivée sur le téléphone.

**Résultat attendu** : Chaque destinataire confirme la réception, texte lisible (accents, longueur), en moins de 60 s.

**Mesure** `delai_notification_s` — Pire délai d'arrivée : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Notification d'une vraie alarme `notif-alarme` — OBLIGATOIRE

**À faire** : Ouvrir un incident avec un détecteur de recette (ou `npm run sim`). Lire la notification reçue.

**Résultat attendu** : La notification de niveau 1 arrive avec le nom du détecteur, la zone, l'étage, le motif et l'heure (et l'image jointe si le canal le permet).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Escalade `notif-escalade` — OBLIGATOIRE

**À faire** : Ne pas acquitter. Chronométrer l'arrivée de la notification de niveau 2 après le délai réglé.

**Résultat attendu** : Le niveau 2 est prévenu au délai réglé, à 10 % près ; l'acquittement arrête l'escalade.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Fiabilité sur 20 envois `notif-fiabilite` — OBLIGATOIRE

**À faire** : Envoyer 20 messages de test espacés de 1 minute. Compter les messages reçus.

**Résultat attendu** : 20 sur 20 reçus.

**Mesure** `envois_recus` — Messages reçus sur 20 : au moins 20 messages. Valeur relevée : ________ messages

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 8. Notification « Détecteur muet » `notif-muet` — OBLIGATOIRE

**À faire** : Rendre muet un détecteur supervisé de recette et attendre son délai.

**Résultat attendu** : La notification « Détecteur muet » arrive chez les destinataires prévus.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Canal en panne `notif-panne-canal` — OBLIGATOIRE

**À faire** : Rendre le canal injoignable (mauvais mot de passe, ou Internet coupé 5 minutes), ouvrir un incident, puis rétablir.

**Résultat attendu** : L'échec est visible dans le journal et l'écran Système, les autres canaux partent quand même, aucun incident n'est perdu. Noter si la notification manquée est renvoyée au retour.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 10. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, le relancer, puis déclencher un incident.

**Résultat attendu** : Les notifications repartent sans reconfiguration ; la notification de reprise après période sans surveillance arrive si la période dépasse le seuil réglé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 11. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 11 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le délai d'arrivée est mesuré sur un vrai téléphone, pas sur le journal du PSIM.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un incident ouvert sans aucune notification reçue alors que le canal est donné comme OK.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-telegram"></a>

## Fiche de recette : Canaux de notification (e-mail, Telegram, WhatsApp, CallMeBot, webhook)

**Profil : Telegram** (`telegram`)  
Fiche `notifications` version 1 — empreinte `4aeec6ff6d20133c`  
Référence : docs/MISE-EN-SERVICE.md (section 6) ; docs/WHATSAPP.md

> Qualification d'un canal de notification : réception réelle chez un vrai destinataire, délai, escalade, détecteur muet, panne du canal.

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

- Le compte du canal (serveur SMTP, bot Telegram, numéro WhatsApp Business, compte CallMeBot ou URL de webhook) et ses identifiants dans le fichier d'environnement du PSIM de recette
- Deux destinataires réels avec téléphone en main (niveau 1 et niveau 2), dans la zone de couverture réelle du site
- PSIM de recette ; `npm run commission` pour tester la connexion sans envoyer
- Chronomètre ; accès pour couper Internet du poste

### Montage du banc d'essai

1. Renseigner les variables du canal dans le fichier d'environnement du PSIM de recette (jamais dans la fiche) ; démarrer le PSIM.
2. Lancer `npm run commission` : le contrôle du canal doit être OK (connexion et authentification vérifiées sans envoi).
3. Dans « Personnes prévenues », ajouter les destinataires de niveau 1 et de niveau 2.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Noter la version du service (fournisseur, compte, numéro d'expéditeur ou domaine) à la place du numéro de série, et la référence du modèle de message approuvé s'il y en a un.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (canal de notification)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Contrôle de la connexion `notif-commission` — OBLIGATOIRE

**À faire** : Lancer `npm run commission` (sans envoi) et lire le contrôle du canal.

**Résultat attendu** : Le contrôle du canal est OK (connexion et authentification vérifiées).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Message de test reçu `notif-test` — OBLIGATOIRE

**À faire** : Bouton « Envoyer un message de test » pour chaque destinataire. Chronométrer l'arrivée sur le téléphone.

**Résultat attendu** : Chaque destinataire confirme la réception, texte lisible (accents, longueur), en moins de 60 s.

**Mesure** `delai_notification_s` — Pire délai d'arrivée : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Notification d'une vraie alarme `notif-alarme` — OBLIGATOIRE

**À faire** : Ouvrir un incident avec un détecteur de recette (ou `npm run sim`). Lire la notification reçue.

**Résultat attendu** : La notification de niveau 1 arrive avec le nom du détecteur, la zone, l'étage, le motif et l'heure (et l'image jointe si le canal le permet).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Escalade `notif-escalade` — OBLIGATOIRE

**À faire** : Ne pas acquitter. Chronométrer l'arrivée de la notification de niveau 2 après le délai réglé.

**Résultat attendu** : Le niveau 2 est prévenu au délai réglé, à 10 % près ; l'acquittement arrête l'escalade.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Fiabilité sur 20 envois `notif-fiabilite` — OBLIGATOIRE

**À faire** : Envoyer 20 messages de test espacés de 1 minute. Compter les messages reçus.

**Résultat attendu** : 20 sur 20 reçus.

**Mesure** `envois_recus` — Messages reçus sur 20 : au moins 20 messages. Valeur relevée : ________ messages

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 8. Notification « Détecteur muet » `notif-muet` — OBLIGATOIRE

**À faire** : Rendre muet un détecteur supervisé de recette et attendre son délai.

**Résultat attendu** : La notification « Détecteur muet » arrive chez les destinataires prévus.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Canal en panne `notif-panne-canal` — OBLIGATOIRE

**À faire** : Rendre le canal injoignable (mauvais mot de passe, ou Internet coupé 5 minutes), ouvrir un incident, puis rétablir.

**Résultat attendu** : L'échec est visible dans le journal et l'écran Système, les autres canaux partent quand même, aucun incident n'est perdu. Noter si la notification manquée est renvoyée au retour.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 10. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, le relancer, puis déclencher un incident.

**Résultat attendu** : Les notifications repartent sans reconfiguration ; la notification de reprise après période sans surveillance arrive si la période dépasse le seuil réglé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 11. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 11 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le délai d'arrivée est mesuré sur un vrai téléphone, pas sur le journal du PSIM.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un incident ouvert sans aucune notification reçue alors que le canal est donné comme OK.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-whatsapp"></a>

## Fiche de recette : Canaux de notification (e-mail, Telegram, WhatsApp, CallMeBot, webhook)

**Profil : WhatsApp (API Meta)** (`whatsapp`)  
Fiche `notifications` version 1 — empreinte `c256d1004d1c3fbe`  
Référence : docs/MISE-EN-SERVICE.md (section 6) ; docs/WHATSAPP.md

> Qualification d'un canal de notification : réception réelle chez un vrai destinataire, délai, escalade, détecteur muet, panne du canal.

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

- Le compte du canal (serveur SMTP, bot Telegram, numéro WhatsApp Business, compte CallMeBot ou URL de webhook) et ses identifiants dans le fichier d'environnement du PSIM de recette
- Deux destinataires réels avec téléphone en main (niveau 1 et niveau 2), dans la zone de couverture réelle du site
- PSIM de recette ; `npm run commission` pour tester la connexion sans envoyer
- Chronomètre ; accès pour couper Internet du poste

### Montage du banc d'essai

1. Renseigner les variables du canal dans le fichier d'environnement du PSIM de recette (jamais dans la fiche) ; démarrer le PSIM.
2. Lancer `npm run commission` : le contrôle du canal doit être OK (connexion et authentification vérifiées sans envoi).
3. Dans « Personnes prévenues », ajouter les destinataires de niveau 1 et de niveau 2.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Noter la version du service (fournisseur, compte, numéro d'expéditeur ou domaine) à la place du numéro de série, et la référence du modèle de message approuvé s'il y en a un.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (canal de notification)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Contrôle de la connexion `notif-commission` — OBLIGATOIRE

**À faire** : Lancer `npm run commission` (sans envoi) et lire le contrôle du canal.

**Résultat attendu** : Le contrôle du canal est OK (connexion et authentification vérifiées).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Message de test reçu `notif-test` — OBLIGATOIRE

**À faire** : Bouton « Envoyer un message de test » pour chaque destinataire. Chronométrer l'arrivée sur le téléphone.

**Résultat attendu** : Chaque destinataire confirme la réception, texte lisible (accents, longueur), en moins de 60 s.

**Mesure** `delai_notification_s` — Pire délai d'arrivée : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Notification d'une vraie alarme `notif-alarme` — OBLIGATOIRE

**À faire** : Ouvrir un incident avec un détecteur de recette (ou `npm run sim`). Lire la notification reçue.

**Résultat attendu** : La notification de niveau 1 arrive avec le nom du détecteur, la zone, l'étage, le motif et l'heure (et l'image jointe si le canal le permet).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Escalade `notif-escalade` — OBLIGATOIRE

**À faire** : Ne pas acquitter. Chronométrer l'arrivée de la notification de niveau 2 après le délai réglé.

**Résultat attendu** : Le niveau 2 est prévenu au délai réglé, à 10 % près ; l'acquittement arrête l'escalade.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Fiabilité sur 20 envois `notif-fiabilite` — OBLIGATOIRE

**À faire** : Envoyer 20 messages de test espacés de 1 minute. Compter les messages reçus.

**Résultat attendu** : 20 sur 20 reçus.

**Mesure** `envois_recus` — Messages reçus sur 20 : au moins 20 messages. Valeur relevée : ________ messages

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 8. Notification « Détecteur muet » `notif-muet` — OBLIGATOIRE

**À faire** : Rendre muet un détecteur supervisé de recette et attendre son délai.

**Résultat attendu** : La notification « Détecteur muet » arrive chez les destinataires prévus.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Canal en panne `notif-panne-canal` — OBLIGATOIRE

**À faire** : Rendre le canal injoignable (mauvais mot de passe, ou Internet coupé 5 minutes), ouvrir un incident, puis rétablir.

**Résultat attendu** : L'échec est visible dans le journal et l'écran Système, les autres canaux partent quand même, aucun incident n'est perdu. Noter si la notification manquée est renvoyée au retour.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 10. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, le relancer, puis déclencher un incident.

**Résultat attendu** : Les notifications repartent sans reconfiguration ; la notification de reprise après période sans surveillance arrive si la période dépasse le seuil réglé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 11. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 11 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le délai d'arrivée est mesuré sur un vrai téléphone, pas sur le journal du PSIM.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un incident ouvert sans aucune notification reçue alors que le canal est donné comme OK.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-callmebot"></a>

## Fiche de recette : Canaux de notification (e-mail, Telegram, WhatsApp, CallMeBot, webhook)

**Profil : CallMeBot** (`callmebot`)  
Fiche `notifications` version 1 — empreinte `2eecd3d81954da7d`  
Référence : docs/MISE-EN-SERVICE.md (section 6) ; docs/WHATSAPP.md

> Qualification d'un canal de notification : réception réelle chez un vrai destinataire, délai, escalade, détecteur muet, panne du canal.

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

- Le compte du canal (serveur SMTP, bot Telegram, numéro WhatsApp Business, compte CallMeBot ou URL de webhook) et ses identifiants dans le fichier d'environnement du PSIM de recette
- Deux destinataires réels avec téléphone en main (niveau 1 et niveau 2), dans la zone de couverture réelle du site
- PSIM de recette ; `npm run commission` pour tester la connexion sans envoyer
- Chronomètre ; accès pour couper Internet du poste

### Montage du banc d'essai

1. Renseigner les variables du canal dans le fichier d'environnement du PSIM de recette (jamais dans la fiche) ; démarrer le PSIM.
2. Lancer `npm run commission` : le contrôle du canal doit être OK (connexion et authentification vérifiées sans envoi).
3. Dans « Personnes prévenues », ajouter les destinataires de niveau 1 et de niveau 2.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Noter la version du service (fournisseur, compte, numéro d'expéditeur ou domaine) à la place du numéro de série, et la référence du modèle de message approuvé s'il y en a un.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (canal de notification)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Contrôle de la connexion `notif-commission` — OBLIGATOIRE

**À faire** : Lancer `npm run commission` (sans envoi) et lire le contrôle du canal.

**Résultat attendu** : Le contrôle du canal est OK (connexion et authentification vérifiées).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Message de test reçu `notif-test` — OBLIGATOIRE

**À faire** : Bouton « Envoyer un message de test » pour chaque destinataire. Chronométrer l'arrivée sur le téléphone.

**Résultat attendu** : Chaque destinataire confirme la réception, texte lisible (accents, longueur), en moins de 60 s.

**Mesure** `delai_notification_s` — Pire délai d'arrivée : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Notification d'une vraie alarme `notif-alarme` — OBLIGATOIRE

**À faire** : Ouvrir un incident avec un détecteur de recette (ou `npm run sim`). Lire la notification reçue.

**Résultat attendu** : La notification de niveau 1 arrive avec le nom du détecteur, la zone, l'étage, le motif et l'heure (et l'image jointe si le canal le permet).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Escalade `notif-escalade` — OBLIGATOIRE

**À faire** : Ne pas acquitter. Chronométrer l'arrivée de la notification de niveau 2 après le délai réglé.

**Résultat attendu** : Le niveau 2 est prévenu au délai réglé, à 10 % près ; l'acquittement arrête l'escalade.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Fiabilité sur 20 envois `notif-fiabilite` — OBLIGATOIRE

**À faire** : Envoyer 20 messages de test espacés de 1 minute. Compter les messages reçus.

**Résultat attendu** : 20 sur 20 reçus.

**Mesure** `envois_recus` — Messages reçus sur 20 : au moins 20 messages. Valeur relevée : ________ messages

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 8. Notification « Détecteur muet » `notif-muet` — OBLIGATOIRE

**À faire** : Rendre muet un détecteur supervisé de recette et attendre son délai.

**Résultat attendu** : La notification « Détecteur muet » arrive chez les destinataires prévus.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Canal en panne `notif-panne-canal` — OBLIGATOIRE

**À faire** : Rendre le canal injoignable (mauvais mot de passe, ou Internet coupé 5 minutes), ouvrir un incident, puis rétablir.

**Résultat attendu** : L'échec est visible dans le journal et l'écran Système, les autres canaux partent quand même, aucun incident n'est perdu. Noter si la notification manquée est renvoyée au retour.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 10. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, le relancer, puis déclencher un incident.

**Résultat attendu** : Les notifications repartent sans reconfiguration ; la notification de reprise après période sans surveillance arrive si la période dépasse le seuil réglé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 11. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 11 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le délai d'arrivée est mesuré sur un vrai téléphone, pas sur le journal du PSIM.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un incident ouvert sans aucune notification reçue alors que le canal est donné comme OK.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |



<a id="profil-webhook"></a>

## Fiche de recette : Canaux de notification (e-mail, Telegram, WhatsApp, CallMeBot, webhook)

**Profil : Webhook signé** (`webhook`)  
Fiche `notifications` version 1 — empreinte `9afb6de103698b70`  
Référence : docs/MISE-EN-SERVICE.md (section 6) ; docs/WHATSAPP.md

> Qualification d'un canal de notification : réception réelle chez un vrai destinataire, délai, escalade, détecteur muet, panne du canal.

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

- Le compte du canal (serveur SMTP, bot Telegram, numéro WhatsApp Business, compte CallMeBot ou URL de webhook) et ses identifiants dans le fichier d'environnement du PSIM de recette
- Deux destinataires réels avec téléphone en main (niveau 1 et niveau 2), dans la zone de couverture réelle du site
- PSIM de recette ; `npm run commission` pour tester la connexion sans envoyer
- Chronomètre ; accès pour couper Internet du poste

### Montage du banc d'essai

1. Renseigner les variables du canal dans le fichier d'environnement du PSIM de recette (jamais dans la fiche) ; démarrer le PSIM.
2. Lancer `npm run commission` : le contrôle du canal doit être OK (connexion et authentification vérifiées sans envoi).
3. Dans « Personnes prévenues », ajouter les destinataires de niveau 1 et de niveau 2.

### Étapes

Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».

#### Préparation

##### 1. Identifier l'équipement `prep-identif` — OBLIGATOIRE

**À faire** : Noter la version du service (fournisseur, compte, numéro d'expéditeur ou domaine) à la place du numéro de série, et la référence du modèle de message approuvé s'il y en a un.

**Résultat attendu** : Les trois informations sont lisibles et notées. La référence correspond à l'entrée du registre ; sinon, s'arrêter et créer une nouvelle entrée (un autre modèle n'est pas qualifié par le voisin).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 2. Monter le banc d'essai `prep-banc` — OBLIGATOIRE

**À faire** : Monter le banc décrit plus haut, démarrer le PSIM de recette (jamais le PSIM de production) et déclarer l'équipement avec l'identifiant exact BANC-01 (catégorie : Sans objet (canal de notification)).

**Résultat attendu** : L'équipement figure sur le plan. Aucun incident ouvert. Les destinataires de test sont prévenus qu'une recette commence.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 3. Contrôle de la connexion `notif-commission` — OBLIGATOIRE

**À faire** : Lancer `npm run commission` (sans envoi) et lire le contrôle du canal.

**Résultat attendu** : Le contrôle du canal est OK (connexion et authentification vérifiées).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Détection

##### 4. Message de test reçu `notif-test` — OBLIGATOIRE

**À faire** : Bouton « Envoyer un message de test » pour chaque destinataire. Chronométrer l'arrivée sur le téléphone.

**Résultat attendu** : Chaque destinataire confirme la réception, texte lisible (accents, longueur), en moins de 60 s.

**Mesure** `delai_notification_s` — Pire délai d'arrivée : au plus 60 s. Valeur relevée : ________ s

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 5. Notification d'une vraie alarme `notif-alarme` — OBLIGATOIRE

**À faire** : Ouvrir un incident avec un détecteur de recette (ou `npm run sim`). Lire la notification reçue.

**Résultat attendu** : La notification de niveau 1 arrive avec le nom du détecteur, la zone, l'étage, le motif et l'heure (et l'image jointe si le canal le permet).

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 6. Escalade `notif-escalade` — OBLIGATOIRE

**À faire** : Ne pas acquitter. Chronométrer l'arrivée de la notification de niveau 2 après le délai réglé.

**Résultat attendu** : Le niveau 2 est prévenu au délai réglé, à 10 % près ; l'acquittement arrête l'escalade.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 7. Fiabilité sur 20 envois `notif-fiabilite` — OBLIGATOIRE

**À faire** : Envoyer 20 messages de test espacés de 1 minute. Compter les messages reçus.

**Résultat attendu** : 20 sur 20 reçus.

**Mesure** `envois_recus` — Messages reçus sur 20 : au moins 20 messages. Valeur relevée : ________ messages

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Liaison et silence

##### 8. Notification « Détecteur muet » `notif-muet` — OBLIGATOIRE

**À faire** : Rendre muet un détecteur supervisé de recette et attendre son délai.

**Résultat attendu** : La notification « Détecteur muet » arrive chez les destinataires prévus.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

##### 9. Canal en panne `notif-panne-canal` — OBLIGATOIRE

**À faire** : Rendre le canal injoignable (mauvais mot de passe, ou Internet coupé 5 minutes), ouvrir un incident, puis rétablir.

**Résultat attendu** : L'échec est visible dans le journal et l'écran Système, les autres canaux partent quand même, aucun incident n'est perdu. Noter si la notification manquée est renvoyée au retour.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Reprise du PSIM

##### 10. Redémarrage du PSIM `psimrestart` — OBLIGATOIRE

**À faire** : Tuer brutalement le PSIM de recette, le relancer, puis déclencher un incident.

**Résultat attendu** : Les notifications repartent sans reconfiguration ; la notification de reprise après période sans surveillance arrive si la période dépasse le seuil réglé.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

#### Clôture

##### 11. Synthèse et signatures `closeout` — OBLIGATOIRE

**À faire** : Remplir la page de synthèse : conclusion (qualifié / à refaire / rejeté), nom du testeur, signature du responsable d'atelier. Ranger la fiche papier ou PDF signée avec le fichier de résultat.

**Résultat attendu** : Fiche signée. Le résultat est enregistré avec `npm run qualify -- record`.

Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________

### Critères de réussite

- Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).
- Les 11 étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».
- Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).
- Toute étape « na » est justifiée par écrit dans la remarque.
- Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.
- Le délai d'arrivée est mesuré sur un vrai téléphone, pas sur le journal du PSIM.

### Critères d'échec

- Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.
- Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».
- Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.
- Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.
- Un incident ouvert sans aucune notification reçue alors que le canal est donné comme OK.

### Synthèse et signatures

Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________

| Testeur : nom, date, signature | Responsable d'atelier : nom, date, signature |
|---|---|
| <br><br><br> | <br><br><br> |


