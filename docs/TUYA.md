# Détecteurs de fumée WiFi Tuya / Smart Life

Les détecteurs de fumée WiFi vendus avec l'application **Smart Life** (« Intelligent WiFi Strobe Smoke Detector », pile 9 V) fonctionnent sur la plateforme **Tuya**. Le PSIM lit leur état dans le **cloud Tuya** et l'affiche comme un détecteur incendie : pastille sur le plan, incident, caméras liées, notifications, escalade.

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
