# Passation — détecteurs de fumée WiFi Tuya / Smart Life

Dernière mise à jour : 7 octobre 2026. Tout ce travail est commité (`5d30464`), l'arbre de travail est propre.

## Objectif

Intégrer au PSIM les détecteurs de fumée WiFi vendus avec l'application **Smart Life** (« Intelligent WiFi Strobe Smoke Detector », pile 9 V, sirène intégrée), pour qu'une fumée détectée ouvre un incident **incendie** avec images des caméras liées, notifications et escalade.

Décisions prises avec l'utilisateur (Baba Kourouma, qui écrit en français) :

- Deux options lui ont été présentées : **A** passerelle externe (script indépendant), **B** module natif dans le PSIM, configurable depuis l'interface. Il a choisi **B**.
- Lecture par le **cloud Tuya**, pas en réseau local : ces détecteurs sur pile restent en veille et ne répondent pas sur le LAN. Conséquence assumée : sans Internet, le PSIM ne reçoit pas l'alarme (la sirène du détecteur sonne quand même, sur place).
- Clés du projet Tuya dans le `.env`, comme le mot de passe SMTP et le jeton Telegram : **jamais en base, jamais dans l'interface, jamais dans les journaux**.
- Détection **complémentaire** : ce n'est pas une centrale incendie certifiée. Écrit dans la documentation.

## Ce qui est fait et testé

**Serveur**
- `server/tuya.ts` (nouveau, 371 lignes) : client du cloud Tuya (signature HMAC-SHA256 avec `nonce`, jeton mis en cache environ 2 h, lecture groupée de 20 appareils par requête) ; `readDevice()` traduit l'état Tuya en état PSIM ; service de lecture périodique, `view` / `setSource` / `removeSource` / `test` / `stop`, sur le modèle de `dahua.ts`.
- `server/db.ts` : table `tuya_source (device_id PK, tuya_id UNIQUE)`. Créée par `CREATE TABLE IF NOT EXISTS`, donc **aucune migration à écrire** (contrairement à `detector_source`, dont la contrainte `CHECK` sur `kind` aurait imposé de recréer la table).
- `server/config.ts` : `TUYA_REGIONS` (7 centres de données) et `config.tuya`. Les deux clés vont ensemble : n'en donner qu'une est une erreur de démarrage.
- `server/api.ts` : `GET/PUT/DELETE /api/detectors/:id/tuya` et `POST /api/tuya/test` (un essai à la fois), administrateur seulement.
- `server/engine.ts` : un détecteur alimenté par Tuya reste **incendie** et supervisé au moins 300 s (comme la règle Dahua, qui impose intrusion + zone).
- `server/main.ts` : création, arrêt propre, et relecture de la configuration partagée avec Dahua (`sourcesReload`, anti-rebond 1 s).

**Interface** : `web/tuyasource.js` (nouveau) — section *Détecteur de fumée WiFi (Smart Life)* dans l'éditeur d'un détecteur incendie : identifiant de l'appareil, *Tester la lecture* (affiche les données brutes reçues), enregistrement, retrait. Libellés du journal dans `web/core.js`.

**Documentation** : `docs/TUYA.md` (appairage, création du projet Tuya, réglages, tableau des états, dépannage), section dans le `README.md`, variables dans `.env.example`.

**Tests** : `test/tuya.test.ts` — 9 tests, faux cloud Tuya qui **recalcule la signature indépendamment du code testé** (une signature fausse est refusée). Couvre : fumée vers alarme, alarme prioritaire sur « hors ligne », pile faible vers défaut, modèle inconnu vers défaut, jeton demandé une seule fois, découpage en lots de 20, secret refusé, cloud injoignable puis rétabli, appareil absent du compte, règles de `setSource`, essai sans effet sur le moteur. `npm run typecheck` propre. Suite complète lancée **fichier par fichier** : tout vert (voir les tests instables plus bas).

## Validé contre le vrai matériel (7 octobre)

L'utilisateur a renseigné ses clés, puis le cloud réel a été interrogé en lecture seule :

```
région eu -> https://openapi.tuyaeu.com
jeton : OK
détecteur bf466dd7b79fe07dd5jizp  « Smoke Alarm »  catégorie ywbj  modèle S01/S441/S433  en ligne
   smoke_sensor_status = "normal"      <- la donnée que le PSIM lit
   smoke_sensor_value  = 0
   battery_state       = "high"
   battery_percentage  = 93
   muffling            = false
--> lecture du PSIM : normal, « aucune fumée »
```

Le nom de la donnée correspond à ce qui était implémenté : **aucune correction nécessaire**.

## Reste à faire

1. **Redémarrer le PSIM de production** pour qu'il lise les nouvelles variables : `Stop-ScheduledTask -TaskName PSIM` puis `Start-ScheduledTask -TaskName PSIM`. **C'est à l'utilisateur** (bloqué par le système de permissions).
2. **Déclarer le détecteur** dans *Équipements et plan* : détecteur de catégorie **Incendie**, avec nom, zone et place sur le plan ; puis coller `bf466dd7b79fe07dd5jizp` dans la section Tuya et *Tester la lecture*. Le nom, la zone et la position sont les choix de l'utilisateur : ils ne lui ont pas encore été demandés.
3. **Recette** : appui de 2 s sur le bouton TEST du détecteur ; l'incident doit apparaître dans le PSIM **dans la minute**. Jamais fait : c'est la seule chose que les tests ne peuvent pas prouver.
4. Facultatif : `smoke_sensor_value` (concentration) n'est pas utilisé ; il pourrait alimenter `lastValue` pour l'affichage.

## Pièges rencontrés — à lire avant de travailler

- **Les variables sont dans `.env.production`, pas dans `.env`.** Le mode démonstration (`npm run demo`) ne les voit donc pas : la section Tuya s'y affiche avec « compte non réglé » et les boutons désactivés. C'est normal.
- **La console Tuya ne liste pas les appareils dans l'onglet du projet** : ils appartiennent au compte Smart Life lié. `/v1.3/iot-03/devices` renvoie 0, et `/v1.0/apps/schema/users` renvoie `1106 permission deny`. Pour retrouver un Device ID : `GET /v1.0/iot-01/associated-users/devices?size=50`.
- **Quota Tuya** : l'essai gratuit plafonne les appels par mois. Une lecture groupée toutes les 60 s fait environ 43 000 appels par mois, quel que soit le nombre de détecteurs jusqu'à 20. `PSIM_TUYA_POLL_S=10` en consommerait environ 260 000 : forfait payant nécessaire. D'où le défaut à 60 s et la borne haute à 120 s.
- **Signature Tuya** : la chaîne à signer est la méthode, l'empreinte SHA-256 du corps, une ligne vide, puis le chemin avec ses paramètres triés ; le tout précédé de `client_id + access_token + t + nonce`. Pour la demande de jeton, le jeton est vide. Une erreur ici donne `code 1004 sign invalid`, traduit en message clair dans `FRIENDLY`.
- **Fins de ligne CRLF** : tous les fichiers touchés sont en CRLF. Pour convertir : `sed -i 's/$//; s/$//' <fichier>`. **Ne pas vérifier avec `grep -c $''`** : dans le shell de cette machine le motif n'est pas interprété et le compte est faux. Compter les octets, par exemple en Python : `open(f,'rb').read().count(b'
')`. `docs/HANDOFF-portail.md`, `scripts/reset-2fa.ts` et `.claude/skills/run-psim-portal/SKILL.md` sont en LF : les laisser ainsi.
- **Un script d'essai doit vivre dans le dépôt** : lancé depuis `%TEMP%`, Node refuse les imports en chemin absolu Windows (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Créer le fichier à la racine du projet, le lancer, le supprimer.
- **Tests instables sur cette machine** (déjà signalé dans `docs/HANDOFF-portail.md`) : `hardening` et `e2e-resilience` ont échoué une fois chacun, puis sont repassés à l'identique au relancement. Sans lien avec ce travail. Lancer les fichiers un par un.
- **Aucune clé ni secret n'est consigné ici.** Le `local_key` du détecteur, renvoyé par le cloud, ne doit être ni journalisé ni recopié.

## Commandes utiles

```bash
npm run typecheck
node --test test/tuya.test.ts
node --env-file=.env.production scripts/check-config.ts
```

## Fichiers concernés par ce travail

Nouveaux : `server/tuya.ts`, `web/tuyasource.js`, `test/tuya.test.ts`, `docs/TUYA.md`, `docs/HANDOFF-tuya.md`. Modifiés : `server/api.ts`, `server/config.ts`, `server/db.ts`, `server/engine.ts`, `server/main.ts`, `web/core.js`, `web/equipment.js`, `README.md`, `.env.example`.

Le commit `5d30464` contient **aussi** des travaux sans rapport, qui étaient déjà dans l'arbre et que l'utilisateur a demandé de valider avec le reste : `set-password:prod` et l'option `--temp` (`package.json`, `scripts/set-password.ts`, `test/security.test.ts`), l'envoi immédiat d'un incident au portail (`server/portal.ts`, `server/main.ts`, `test/portal.test.ts`), la hauteur de la vue éclatée (`web/surveillance.css`), un chemin dans `scripts/reset-2fa.ts`, et le dossier `.claude/` (jusque-là non suivi).
