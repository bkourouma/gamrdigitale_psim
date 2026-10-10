# Détecteurs de fumée WiFi Tuya / Smart Life

Les détecteurs de fumée WiFi vendus avec l'application **Smart Life** (« Intelligent WiFi Strobe Smoke Detector », pile 9 V) fonctionnent sur la plateforme **Tuya**. Le PSIM lit leur état dans le **cloud Tuya** et l'affiche comme un détecteur incendie : pastille sur le plan, incident, caméras liées, notifications, escalade.

> Les autres capteurs Tuya courants (contact de porte ou fenêtre, mouvement, fuite d'eau, température, gaz, monoxyde de carbone, bouton SOS) sont décrits plus bas, section « Autres capteurs Tuya / Smart Life (à qualifier) » : ils ne sont pas encore validés avec un appareil réel.

## Ce qu'il faut savoir avant de commencer

- **La sirène du détecteur sonne seule, sur place**, que le PSIM l'entende ou non. Le PSIM ajoute l'incident et les notifications ; il ne remplace pas la sirène.
- **Internet est nécessaire.** Un détecteur WiFi sur pile dort presque toujours : il ne répond pas sur le réseau local, seul le cloud connaît son état. Si le poste du PSIM perd Internet, ou si le cloud Tuya ne répond plus, **les détecteurs passent « Hors ligne » au bout de 5 minutes** et la notification « détecteur muet » part. Rien ne reste « Normal » à tort.
- **Délai** : le PSIM lit le cloud toutes les **60 secondes** par défaut (`PSIM_TUYA_POLL_S`, 10 à 120). Une alarme arrive donc dans le PSIM au plus une minute après le détecteur, plus le temps que le détecteur la remonte au cloud.
- **Quota Tuya** : l'essai gratuit du projet Tuya limite le nombre d'appels par mois (de l'ordre de 100 000, à vérifier dans la console Tuya). Le PSIM fait **une seule requête groupée** pour tous les détecteurs (20 par requête) : à 60 s, cela fait environ 43 000 appels par mois, quel que soit le nombre de détecteurs jusqu'à 20. Descendre à 10 s consommerait environ 260 000 appels : il faudrait alors un forfait payant.
- C'est une détection **complémentaire** : un détecteur WiFi grand public n'est pas une centrale incendie certifiée.

## 1. Appairer les détecteurs dans Smart Life

Selon la notice du détecteur :

1. Installer l'application **Smart Life** sur un téléphone connecté au WiFi du site (en 2,4 GHz).
2. Dans l'application : *Ajouter un appareil* → *Capteur de sécurité* → *Capteur (WiFi)*.
3. Sur le détecteur, **appuyer 5 s sur TEST** jusqu'au clignotement de la LED avec un court « Di » (dans les 20 s après la mise en place de la pile), puis saisir le mot de passe WiFi dans l'application. Un long « Di » avec la LED allumée 10 s = appairé.

## 2. Créer le projet Tuya (une seule fois pour tout le site)

1. Créer un compte gratuit sur **iot.tuya.com** (console développeur).
2. *Cloud* → *Development* → *Create Cloud Project*. Choisir le **centre de données** (pour l'Afrique : *Central Europe*) et les services **Smart Home** ou équivalent.
3. Dans le projet, onglet *Service API* : vérifier que *Authorization Token Management* et *Device Status Notification* / *IoT Core* sont souscrits (l'essai est gratuit).
4. Onglet *Devices* → *Link App Account* → *Add App Account* : scanner le QR code avec l'application Smart Life (*Moi* → icône de scan). Les détecteurs apparaissent alors dans la liste ; noter la colonne **Device ID** de chacun.
5. Onglet *Overview* du projet : relever l'**Access ID / Client ID** et l'**Access Secret / Client Secret**.

## 3. Régler le PSIM

Dans le fichier `.env` (ou `.env.production`) du serveur :

```
PSIM_TUYA_ACCESS_ID=<Access ID du projet>
PSIM_TUYA_ACCESS_SECRET=<Access Secret du projet>
PSIM_TUYA_REGION=eu
```

`PSIM_TUYA_REGION` : `eu` (Europe centrale, Afrique comprise), `eu-w` (Europe de l'Ouest), `us` (Amérique de l'Ouest), `us-e` (Amérique de l'Est), `in` (Inde), `sg` (Singapour), `cn` (Chine). C'est le centre de données choisi à la création du projet. Redémarrer le PSIM.

Le secret ne quitte jamais le serveur : il n'est ni en base, ni dans l'interface, ni dans les journaux.

## 4. Déclarer chaque détecteur dans le PSIM

1. Interface administrateur → *Équipements et plan* → ajouter un **détecteur**, catégorie **Incendie**, avec un nom, une zone et sa place sur le plan.
2. Dans son éditeur, section **Détecteur de fumée WiFi (Smart Life)** : coller le **Device ID** Tuya.
3. **Tester la lecture** : le PSIM lit l'appareil une fois et affiche les données reçues (`smoke_sensor_status`, batterie…). Rien n'est envoyé au moteur : un essai n'ouvre jamais d'incident.
4. **Enregistrer la source**. Une supervision de 300 s est posée automatiquement.
5. **Recette** : appuyer 2 s sur **TEST** sur le détecteur (déclenche sirène et alarme). L'incident doit apparaître dans le PSIM dans la minute.

## États affichés

| Cloud Tuya | État du détecteur dans le PSIM |
|---|---|
| fumée détectée (`alarm`) | **Alarme** (incident incendie), même si l'appareil est déclaré hors ligne |
| aucune fumée, en ligne | Normal |
| pile faible (`battery_state` = `low` ou ≤ 15 %) | Défaut |
| aucune donnée de fumée connue (autre modèle) | Défaut, avec les données reçues dans le message |
| appareil hors ligne pour Tuya, sans alarme | rien n'est envoyé : Hors ligne après 5 min |
| cloud injoignable, clés refusées | rien n'est envoyé : Hors ligne après 5 min, cause affichée dans l'éditeur |

Données de fumée reconnues : `smoke_sensor_status`, `smoke_sensor_state`, `smoke_alarm`. Si le modèle publie un autre nom, l'essai le montre : la liste est dans `server/tuya.ts`.

## Dépannage

- **« Access ID ou Access Secret incorrect »** : clés mal copiées, ou mauvaise région (`PSIM_TUYA_REGION`).
- **« permission refusée »** / **« service API non souscrit »** : souscrire aux services API du projet (étape 2.3) et lier le compte Smart Life (étape 2.4).
- **« appareil introuvable dans le compte Tuya »** : mauvais Device ID, ou compte Smart Life pas lié au projet.
- **Abonnement d'essai expiré** : le renouveler dans la console Tuya (les essais gratuits ont une durée limitée).
- **Un détecteur reste « Hors ligne »** : vérifier sa pile, son WiFi, et qu'il apparaît « En ligne » dans Smart Life.

# Autres capteurs Tuya / Smart Life (à qualifier)

Le même mécanisme (compte Tuya, lecture groupée toutes les 60 s, supervision de 300 s) lit aussi les capteurs courants « intrusion bon marché » des villas et appartements. **État de validation : seul le détecteur de fumée a été essayé avec un appareil réel. Tous les capteurs de cette section sont écrits d'après la documentation Tuya (« Standard Instruction Set ») et testés contre de fausses réponses du cloud : chaque modèle est À QUALIFIER avec un capteur réel avant tout usage en production.** L'essai (« Tester la lecture ») montre les données exactes que Tuya renvoie pour un modèle : c'est la première chose à faire.

## Modèles pris en charge

Le type de capteur se déduit de la **catégorie du produit Tuya** (champ `category` de l'appareil) ; à défaut, des fonctions présentes ; on peut aussi le **forcer** dans la liste « Type de capteur » de l'éditeur (cas d'un produit reconnu de travers). La section *Capteur WiFi Tuya (Smart Life)* de l'éditeur apparaît pour les détecteurs de catégorie Incendie, Intrusion, Contrôle d'accès, Environnement et Personnes.

| Type | Catégorie Tuya | Fonction lue (DP code) | Catégorie PSIM | Événement envoyé au PSIM |
|---|---|---|---|---|
| Fumée (validé) | `ywbj` | `smoke_sensor_status`, `smoke_sensor_state`, `smoke_alarm` | Incendie | alarme / normal / défaut (inchangé) |
| Contact de porte ou fenêtre | `mcs` | `doorcontact_state` (**vrai = ouvert**) | Intrusion | ouvert : `intrusion` (alarme si la zone est armée) ; fermé : `door_closed` |
| | | | Contrôle d'accès | ouvert : `door_opened` (information, jamais d'incident) ; fermé : `door_closed` |
| Mouvement (PIR) | `pir` | `pir` (`pir` = mouvement, `none` = calme) | Intrusion | `motion` / `clear` |
| Fuite d'eau | `sj` | `watersensor_state` (`alarm` / `normal`) | Environnement | `leak` / `dry` |
| Température et humidité | `wsdcg` | `va_temperature` ou `temp_current` ; `va_humidity` ou `humidity_value` | Environnement | mesure (`value`, en °C) ; **les seuils sont ceux du PSIM** |
| Gaz | `rqbj` (`jwbj`) | `gas_sensor_status`, `gas_sensor_state` (`alarm` / `normal`) | Environnement | `gas` / retour à la normale |
| Monoxyde de carbone | `cobj` | `co_status`, `co_state` (`alarm` / `normal`) | Environnement | `co` / retour à la normale |
| Bouton SOS | `sos` | `sos_state` (vrai = appui) | Personnes | `sos` (toujours actif, même zone désarmée) / `alarm_reset` |

Fonctions communes (tous les types sauf la fumée) : `tamper_alarm` ou `temper_alarm` vrai → événement `tamper` (sabotage, toujours actif, même zone désarmée) ; `battery_state` = `low`, ou `battery_percentage` / `residual_electricity` ≤ 15 % → **Défaut** « pile faible » (`low_battery`). Une alarme n'est jamais écrasée par une pile faible.

**Codes dont la documentation n'est pas certaine** (à confirmer à la première lecture réelle) : `jwbj` comme catégorie « gaz méthane » ; `residual_electricity` comme niveau de pile de certains modèles ; les noms `co_state` / `gas_sensor_state` (variantes selon les fabricants) ; `temp_current` / `humidity_value` (anciens produits) ; l'existence d'une valeur de pré-chauffe pour les détecteurs de gaz (traitée en défaut). Si un produit publie un autre nom, il est signalé en défaut ; la liste est dans `server/tuyasensors.ts`.

## Règles de sûreté (les mêmes que pour la fumée)

- **Jamais « Normal » faute de savoir.** Un appareil dont aucune fonction n'est reconnue est en **Défaut « modèle non pris en charge »** avec les données reçues dans le message ; une valeur inattendue (par exemple `doorcontact_state` qui n'est pas un booléen, `pir` = `big_move`) est un défaut, pas un « fermé ».
- **Le PSIM décide.** Le capteur ne donne qu'un fait. Un contact ouvert sur un détecteur d'intrusion n'ouvre un incident que si la zone est **armée** ; sur un détecteur de contrôle d'accès, c'est une information. Le sabotage, le SOS et la chute restent actifs même zone désarmée.
- **Température** : Tuya renvoie un entier dont l'échelle dépend du produit (`scale` : 215 = 21,5 °C pour `scale` 1). Le PSIM lit cette échelle dans les **spécifications de l'appareil** (un appel supplémentaire par appareil, mis en mémoire 24 h) ; si elles ne sont pas lisibles, aucune mesure n'est inventée : **Défaut** « échelle inconnue », nouvel essai après 5 minutes. Une valeur hors de -40 à 125 °C est refusée comme incohérente. Réglez les seuils d'alerte et la direction dans « Réglages de mesure » du détecteur.
- **Hors ligne** : un appareil déclaré hors ligne par Tuya (pile, WiFi) n'envoie rien, comme la fumée → « Hors ligne » après 5 minutes ; une alarme déjà lue reste prioritaire.
- **Une seule source par détecteur** : un détecteur qui lit un capteur Tuya ne peut pas en même temps lire un enregistreur Dahua (intrusion) ni être sous **supervision réseau** (environnement), et inversement : retirer d'abord l'autre source. (La supervision réseau désactive le délai « aucun message » qu'exige un capteur Tuya.)
- Lecture en **niveau** : le PSIM lit l'état courant du cloud, pas des impulsions. Les appuis ou mouvements plus courts que l'intervalle de lecture peuvent passer inaperçus (voir ci-dessous).

## Limites du cloud Tuya gratuit

- **Quota d'appels** : l'essai gratuit du projet Tuya limite les appels par mois (de l'ordre de 100 000 à vérifier dans la console). Une lecture groupée couvre 20 appareils par requête. Les capteurs de température coûtent **un appel de spécifications en plus, une fois par jour et par appareil** ; l'essai « Tester la lecture » coûte un à deux appels. À 60 s, la base reste d'environ 43 000 appels par mois jusqu'à 20 appareils ; au-delà de 20, une requête de plus par tranche de 20.
- **Latence** : un événement met jusqu'à 60 s (intervalle de lecture) plus le délai de remontée de l'appareil au cloud. Un contact de porte ouvert puis refermé en moins d'une minute, un mouvement d'une seconde, un appui bref sur un bouton SOS **peuvent ne jamais apparaître** dans le PSIM. La lecture par événements poussés (messagerie Tuya) n'est pas utilisée.
- **Dépendance à Internet et au cloud** : sans Internet, tous les capteurs passent « Hors ligne » au bout de 5 minutes (jamais « Normal » figé). Un capteur WiFi sur pile dort et peut mettre du temps à se réveiller.
- **Ne remplace pas un système d'alarme** : capteurs grand public, sirène locale éventuelle indépendante du PSIM.

**Recommandation : pour les sites à forte densité (au-delà d'une dizaine de capteurs), ou pour tout capteur de sécurité à événement bref (contact, PIR, SOS), préférez des capteurs Zigbee reliés à la Passerelle GAMR** : événements instantanés sans quota ni dépendance à Internet. Les capteurs Tuya WiFi conviennent à quelques points isolés d'une villa ou d'un appartement.

## Recette d'un capteur (par modèle)

1. Appairer le capteur dans Smart Life, le retrouver dans la console Tuya (Device ID).
2. Créer le détecteur dans le PSIM (catégorie adaptée au type), coller le Device ID, **Tester la lecture** : vérifier le type reconnu et les données (`doorcontact_state`, `pir`…).
3. Enregistrer, puis provoquer le fait réel (ouvrir la porte, passer devant le PIR, tremper la sonde…) : l'état doit changer dans la minute. Noter dans le dossier du site le modèle et la date de qualification.
4. Retirer la pile ou débrancher le Wi-Fi : le détecteur doit passer « Hors ligne » au bout de 5 minutes.
