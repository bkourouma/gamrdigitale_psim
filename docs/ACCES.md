# Contrôle d'accès dans le PSIM — journal des passages, portes, écran « Accès »

Lots AC2 (serveur) et AC3 (interface). Contrat commun : `docs/CONTROLE-ACCES.md` (§ 1 décisions, § 2 format des messages,
§ 4 modèle de données). PRD : `docs/PRD-CONTROLE-ACCES.md`. Ce document **fige l'interface** entre le serveur
(`server/access.ts`, `server/accessapi.ts`) et l'écran (`web/access.js`) ; il sert aussi de guide à l'installateur et à
l'opérateur (parties 6 et 7).

## 1. Principe

Une **porte** (porte, barrière, portail, tourniquet) est un détecteur PSIM de catégorie `access`. Le **contrôleur**
décide, seul, d'ouvrir ou non pour un badge ; le PSIM **enregistre** (journal des passages), **affiche** (état des
portes, plan) et **alerte** (porte forcée, maintenue ouverte). Il ne prend jamais part à l'ouverture par badge.

Les messages arrivent par le chemin des autres équipements : `psim/detectors/<idPorte>/state` (MQTT) ou
`POST /api/ingest/<idPorte>` (HTTP). Le champ `access` d'un message de passage est décrit au § 2 du contrat commun.

Rôles : **opérateur** = consulter (portes, journal, fiche, export) ; **administrateur** = tout, plus déclarer les
contrôleurs et les portes et régler la conservation. Le portail ne reçoit jamais de nom ni de numéro de badge.

## 2. Ce que fait le serveur d'un message reçu

Pour un détecteur de catégorie `access` :

1. **Message avec `access`** : validé strictement (voir § 3.1) ; refus HTTP 400 avec la raison s'il est invalide. Le passage
   est enregistré dans `access_event` ; un passage déjà connu (même `controllerId` + `eventId`) est un succès sans effet
   (`duplicate`), même si le `msgId` n'est plus en mémoire.
2. **Heure** : `at_device` = `ts` brut du contrôleur ; `at_received` = heure de réception. Le passage est marqué **reçu en
   différé** (`late = 1`) si `access.deferred` est vrai ou si le retard dépasse `LATE_AFTER_MS` (60 s).
3. **État physique de la porte** d'après les événements `door_opened` (ouverte), `door_closed` (fermée), `door_forced`
   (forcée), `door_held_open` (maintenue ouverte). Un message daté plus ancien que l'état connu ne l'écrase pas. Quand la
   porte était hors ligne, son état physique devient **inconnu** tant qu'aucun événement ne le confirme : on ne dit jamais
   « fermée » sans l'avoir su.
4. **Alarmes** : `door_forced` et `tamper` sont des alarmes (circuit habituel) ; `door_held_open` est une pré-alarme que le
   PSIM **escalade en alarme** après `held_alarm_after_s` secondes (300 par défaut, réglable par porte), sauf si la porte a
   été refermée ou est hors ligne. L'escalade ne modifie jamais `last_seen` : une porte muette peut passer hors ligne.
   Un refus de badge isolé n'est **jamais** une alarme (il est journalisé) ; les refus répétés sont comptés par la
   passerelle (`badge_denied_repeated`, pré-alarme).
5. **État affiché** (F2), par priorité : `hors ligne` > `en défaut` > `forcée` > `maintenue ouverte` > `ouverte` > `fermée`
   (> `inconnu` tant qu'aucun message). Le texte « ce que cela signifie / que faire » vient du serveur (`stateHint`).

## 3. API `/api/access/*`

Toutes les routes exigent une **session** (cookie) ; les mutations passent par l'anti-CSRF commun. Erreurs : `{"error":"…"}`
en français, codes 400 (donnée invalide), 401, 403 (droits), 404, 409 (conflit), 413, 429. Les identifiants des contrôleurs
sont **en écriture seule** : scellés (`server/secrets.ts`), jamais renvoyés ni journalisés.

| Méthode et route | Rôle | Rôle de la route |
|---|---|---|
| `GET /api/access/controllers` | admin | Liste des contrôleurs |
| `POST /api/access/controllers` | admin | Déclarer un contrôleur |
| `PUT /api/access/controllers/:id` | admin | Modifier (champs absents = inchangés) |
| `DELETE /api/access/controllers/:id` | admin | Supprimer (409 s'il a encore des portes) |
| `GET /api/access/doors` | tous | Les portes avec leur état |
| `GET /api/access/doors/:id` | tous | Fiche de porte |
| `POST /api/access/doors` | admin | Déclarer une porte (rattacher un détecteur `access`) |
| `PUT /api/access/doors/:id` | admin | Modifier une porte |
| `DELETE /api/access/doors/:id` | admin | Retirer la déclaration (l'historique des passages est conservé jusqu'à la purge) |
| `GET /api/access/events` | tous | Recherche de passages (filtres, pagination) |
| `GET /api/access/events.csv` | tous | Export CSV d'une sélection (journalisé) |
| `GET /api/access/settings` | tous | Conservation et dernière purge |
| `PUT /api/access/settings` | admin | Régler la durée de conservation |

`:id` d'une porte = identifiant du **détecteur**.

### 3.1 Objets

**Contrôleur** (`ControllerView`)

```json
{ "id": "CTL-1", "name": "Contrôleur entrée", "brand": "dahua", "model": "ASC1204B", "host": "192.168.1.50",
  "gatewayId": "gw-site", "hasCredentials": true, "clockOffsetMs": -1200, "lastSeen": 1760000000000,
  "doorCount": 2, "createdAt": 1759000000000, "createdBy": "admin", "updatedAt": 1759000000000, "updatedBy": "admin" }
```

Corps de création : `{ id, name, brand, model?, host?, gatewayId?, credentials? }`.
`id` : `^[A-Za-z0-9_-]{1,32}$`, immuable. `name` : 1 à 80 caractères sans caractère de contrôle (`hasForbiddenChar`).
`brand` : `dahua` | `zkteco` | `relay`. `model` : ≤ 40. `host` : `HOST_PATTERN` de `server/video.ts`. `gatewayId` : même
motif que `id`. `credentials` : `{ "username": "…", "password": "…" }` (chacun 1 à 128 caractères), **écriture seule** ;
`PUT` avec `credentials` = remplacement, `"credentials": null` = effacement ; `hasCredentials` dit seulement s'il y en a.
`clockOffsetMs` = heure du contrôleur − heure du PSIM au dernier passage reçu en direct (`null` si jamais).

**Porte** (`DoorView`)

```json
{ "detectorId": "P-ENTREE", "name": "Entrée personnel", "zone": "Rez-de-chaussée", "floorId": 1, "x": 42.5, "y": 18,
  "controllerId": "CTL-1", "controllerName": "Contrôleur entrée", "doorNo": 1, "kind": "door", "emergencyExit": false,
  "heldAlarmAfterS": 300, "actuatorId": null,
  "state": "held_open", "stateLabel": "Maintenue ouverte", "stateHint": "…", "stateSince": 1760000000000,
  "doorState": "open", "deviceStatus": "prealarm", "lastSeen": 1760000000000,
  "lastPassageAt": 1760000000000, "cameraIds": ["CAM-1"] }
```

- `state` : `closed` | `open` | `forced` | `held_open` | `offline` | `fault` | `unknown` (§ 2.5). `stateLabel` : « Fermée »,
  « Ouverte », « Forcée », « Maintenue ouverte », « Hors ligne », « En défaut », « État inconnu ».
- `stateHint` : une à deux phrases en français courant : ce que l'état signifie et ce qu'il faut faire (ex. forcée :
  « La porte s'est ouverte sans autorisation. Regardez la caméra, puis traitez l'alarme. »).
- `doorState` : `closed` | `open` | `unknown` (physique, sans la supervision). `deviceStatus` : statut du détecteur.
- `kind` : `door` | `gate` | `barrier` | `turnstile` ; `doorNo` : 1 à 4, unique par contrôleur.
- `actuatorId` : actionneur `lock` (porte) ou `gate` (barrière, portail, tourniquet) qui ouvre cette porte à distance, `null` si aucun (§ 11.1). `doorMode`, `doorModeLabel`, `doorModeAt` : dernier mode annoncé par le contrôleur (F19, § 11.4), `null` tant qu'aucun message n'est arrivé.
- Corps de création : `{ detectorId, controllerId, doorNo, kind?, emergencyExit?, heldAlarmAfterS?, actuatorId? }` ;
  `detectorId` doit être un détecteur existant de catégorie `access`, pas déjà déclaré (409) ; `controllerId` doit exister ;
  `heldAlarmAfterS` : 10 à 86 400 (défaut 300). Le nom, la zone, l'étage, la position et les caméras liées restent ceux du
  détecteur (écran Équipements) : cette API ne les change pas.

**Passage** (`PassageView`)

```json
{ "id": 98765, "doorId": "P-ENTREE", "doorName": "Entrée personnel", "controllerId": "CTL-1", "eventId": "123456",
  "atDevice": 1760000000000, "atReceived": 1760000001500, "direction": "in", "credential": "0012345",
  "holderName": "KONAN Yao", "holderRef": "101", "method": "badge", "methodLabel": "Badge",
  "result": "granted", "reason": null, "resultLabel": "Accepté", "late": false }
```

`resultLabel` : « Accepté » ; « Refusé — badge inconnu » (`unknown_credential`), « Refusé — badge expiré » (`expired`),
« Refusé — hors des horaires » (`out_of_schedule`), « Refusé — badge désactivé » (`disabled`), « Refusé — code erroné »
(`wrong_pin`), « Refusé — anti-retour » (`antipassback`), « Refusé — porte verrouillée » (`door_locked`), « Refusé »
(`other`). `methodLabel` : Badge, Code, Empreinte, Visage, Bouton de sortie, Ouverture à distance, Inconnue.
`doorName` : nom du détecteur, ou `null` si la porte n'existe plus.

### 3.2 Fiche de porte — `GET /api/access/doors/:id`

```json
{ "door": { "…DoorView…": "" }, "lastPassages": [ "…10 PassageView, du plus récent au plus ancien…" ],
  "cameras": [ { "id": "CAM-1", "name": "Caméra entrée", "status": "normal" } ],
  "remote": { "available": true, "reason": null, "actuatorId": "GACHE-1", "actuatorName": "Gâche entrée", "actuatorType": "lock" } }
```

La consultation de la fiche n'est pas journalisée (elle ne cherche personne). 404 si la porte n'est pas déclarée.

### 3.3 Recherche — `GET /api/access/events`

Paramètres (tous facultatifs) : `from`, `to` (ms ; `to` exclu ; sur l'heure du contrôleur), `door` (id du détecteur),
`holder` (texte, ≤ 64 : contient, sans tenir compte des majuscules ni des accents), `credential` (début du numéro, ≤ 32),
`result` (`granted` | `denied`), `late` (`1` : seulement les passages reçus en différé), `limit` (1 à 200, défaut 50),
`cursor` (opaque, rendu par la page précédente), `count` (`1` : demande le total).

```json
{ "items": [ "…PassageView…" ], "nextCursor": "1760000000000:98765", "total": 1234, "totalCapped": false }
```

Tri : du plus récent au plus ancien (`at_device` décroissant, puis `id`). `total` n'est calculé que si `count=1`,
plafonné à 10 000 (`totalCapped` vrai = « plus de 10 000 »). `nextCursor` est `null` sur la dernière page. Une recherche
par `holder` ou `credential` est **journalisée** (`access_search`, filtres et auteur ; une seule fois par page 1 et par
minute pour les mêmes filtres ; jamais le contenu des résultats).

### 3.4 Export — `GET /api/access/events.csv`

Mêmes filtres (sans `limit`, `cursor`, `count`). CSV `text/csv; charset=utf-8`, séparateur `;`, BOM, même convention que
`server/reports.ts` (`toCsv`), **plus** la neutralisation des cellules commençant par `=`, `+`, `-`, `@`, tabulation ou
retour chariot (préfixe `'`). Colonnes : Date et heure du contrôleur, Reçu le, Porte, Contrôleur, Sens, Badge, Titulaire,
Référence titulaire, Méthode, Résultat, Motif, Reçu en différé. Au plus **100 000 lignes** ; au-delà, l'en-tête
`X-Export-Truncated: 1` est ajouté (l'écran dit de réduire la période). En-tête `X-Export-Rows: <n>`. Toujours
journalisé (`access_export` : auteur, filtres, nombre de lignes).

### 3.5 Conservation — `/api/access/settings`

```json
{ "retentionDays": 90, "defaultDays": 90, "eventCount": 1234567, "oldestAt": 1752000000000,
  "lastPurge": { "at": 1760000000000, "deleted": 4200, "before": 1752000000000 } }
```

`PUT` : `{ "retentionDays": 120 }` (entier de 7 à 3 650) ; journalisé (`access_retention_changed`). La valeur par défaut
vient de `PSIM_ACCESS_RETENTION_DAYS` (90). La purge est automatique et journalisée (`access_purge` : nombre de lignes,
date limite).

### 3.6 Actions du journal infalsifiable

`access_controller_created`, `access_controller_updated`, `access_controller_deleted`, `access_door_declared`,
`access_door_updated`, `access_door_removed`, `access_search`, `access_export`, `access_retention_changed`, `access_purge`,
`access_door_held_escalated` (système). Aucun passage n'est inscrit au journal infalsifiable (volume) : ils vivent dans
`access_event`. Jamais d'identifiant de contrôleur dans un détail.

## 4. Interface interne `server/access.ts` (serveur seulement)

```ts
export interface AccessOptions {
  db: DatabaseSync;
  now?: () => number;                      // horloge injectée (tests)
  key: Buffer;                             // clé de server/secrets.ts
  audit: (actor: string, action: string, ref?: { deviceId?: string; details?: string }) => void;
  /** Changement d'état décidé par le PSIM (escalade) : ne touche pas last_seen. Faux si le détecteur n'existe pas. */
  setDeviceState: (deviceId: string, state: 'alarm', event: string) => boolean;
  retentionDays?: number;                  // défaut 90
}
export function createAccess(opts: AccessOptions): AccessService;
```

`AccessService` (liste non limitative, les noms exacts sont ceux de `server/access.ts`) : `onMessage` (point d'accroche du
moteur), `tick()` (escalade des portes maintenues ouvertes), `purge()`, `doors()`, `door(id)`, `search(filters)`,
`exportCsv(filters, actor)`, `controllers…`, `declareDoor…`, `settings()`, `setRetention(actor, days)`.

Point d'accroche du moteur (`server/engine.ts`, option `access?: AccessHook`), appelé dans `ingest` pour tout détecteur de
catégorie `access` (et tout message portant un champ `access`), **après** `interpret` et **avant** `applyReading` :

```ts
onMessage(input: { device: Device; payload: unknown; event: string | null; state: DetectorState | null; meta: MessageMeta }):
  { ok: true; duplicate?: true } | { ok: false; status: number; error: string };
```

`duplicate` : le moteur retient le `msgId` et répond « déjà traité » sans appliquer le message. Le moteur expose aussi
`setStateBySupervisor(deviceId, state, event)` (applique un état sans rajeunir `last_seen`).

## 5. Interface de l'écran (`web/access.js`)

Écran « Accès » dans le menu principal, au même endroit sur chaque écran. Trois onglets : **Journal**, **Portes**,
**Déclaration** (administrateur seulement). Fiche de porte en panneau ouvert depuis la liste des portes, le plan ou le
journal. Les portes se rafraîchissent à chaque événement temps réel d'un détecteur de catégorie `access` (relecture de
`GET /api/access/doors`, regroupée) et toutes les 15 s tant que l'écran est visible. Le plan colore et nomme l'état de
chaque porte (forme, icône et mot, jamais la couleur seule).

**Voir la vidéo** (exigence F6) : le lien du journal ouvre une fenêtre qui montre **l'enregistrement à l'heure du passage**
quand c'est possible, sinon l'image en direct, et qui dit toujours laquelle des deux est à l'écran.

- **Relecture (voies d'enregistreur Dahua)** : si la source de la caméra liée est de type `rtsp` et que son chemin est une
  voie d'enregistreur Dahua (`/cam/realmonitor?channel=N`, avec éventuellement `&subtype=M` ; N de 1 à 256), le serveur
  dérive l'adresse de relecture `rtsp://hôte:port/cam/playback?channel=N&subtype=0&starttime=AAAA_MM_JJ_HH_mm_ss&endtime=AAAA_MM_JJ_HH_mm_ss`
  (flux principal ; heure **locale du PSIM**, supposée être celle de l'enregistreur ; début = passage − 10 s, fin = passage + 20 s)
  avec les identifiants de la caméra. Le navigateur ne fournit **que l'heure** (`at`, entier en ms, celle du contrôleur :
  `atDevice`) ; l'adresse, l'hôte et le chemin viennent toujours de la source enregistrée, et aucun autre chemin RTSP, ni
  caméra ONVIF ou simulée, n'est relisible (fonction pure `playbackUrl`, `server/video.ts`).
- **Fenêtre** : elle s'ouvre tout de suite, lit `GET /api/cameras/replayable` (une fois par ouverture), puis affiche
  `<img src="/api/cameras/<id>/playback?at=<atDevice>">` avec le bandeau « Enregistrement du JJ/MM/AAAA à HH:MM:SS (10 s avant
  à 20 s après). ». Plusieurs caméras liées : un choix de caméra (la première relisible est ouverte d'abord ; les autres
  s'ouvrent en direct). Une caméra non relisible reste en **direct**, avec « Image en direct, pas l'enregistrement de HH:MM »
  et une phrase qui dit pourquoi (« Cette caméra ne permet pas la relecture depuis le PSIM. », ou : liste illisible,
  heure du passage inconnue). **Échec de la relecture** (image en erreur : pas d'enregistrement à cette heure, enregistreur
  injoignable, identifiants refusés) : message clair et bouton « Voir l'image en direct ». Échap ou « Fermer » coupe le flux.
- **Un ffmpeg par demande** (jamais partagé entre opérateurs, contrairement au direct) : même sortie multipart MJPEG ; arrêt à la
  fin du clip, à la fermeture de la réponse, ou après 45 s au plus (30 s de clip + marge). **Au plus 2 relectures simultanées**
  (la 3e reçoit 503 « Trop de relectures en cours »). Erreurs : « Aucun enregistrement a cette heure ou enregistreur injoignable »
  (502/504), 409 si la caméra n'est pas relisible, 400 si l'heure est invalide (dans le futur de plus d'une minute, plus vieille
  que 400 jours, non entière). Le mot de passe n'apparaît jamais dans une réponse, un en-tête ni un journal.

| Méthode et route | Rôle | Rôle de la route |
|---|---|---|
| `GET /api/cameras/replayable` | tous | `{ "ids": ["C-01", …] }` : les caméras relisibles (déclarée **avant** `:id`) |
| `GET /api/cameras/:id/playback?at=<ms>` | tous | Flux multipart MJPEG de l'enregistrement de `at − 10 s` à `at + 20 s` |

Chaque relecture acceptée est inscrite au journal infalsifiable : action **`camera_playback`** (acteur, caméra, « heure demandee
AAAA-MM-JJ HH:mm:ss » en heure du PSIM), une ligne par demande ; une demande refusée (heure invalide, caméra non relisible,
plafond) n'en produit pas.

## 6. Guide de l'installateur

1. **Équipements** : créer un détecteur de catégorie *Contrôle d'accès* par porte, le placer sur le plan, lui lier les caméras.
2. **Accès → Déclaration** : ajouter le contrôleur (marque, adresse, passerelle ; identifiants facultatifs, jamais relus
   ensuite), puis déclarer chaque porte : détecteur, contrôleur, n° de porte (1 à 4), type, issue de secours (cocher si la
   porte est une issue de secours), délai avant l'alarme « maintenue ouverte ».
3. **Recette** : badge accepté, badge inconnu, porte ouverte puis refermée, porte forcée, porte maintenue ouverte (attendre le
   délai), contrôleur débranché (la porte doit passer **Hors ligne**, jamais « Fermée »), rebranchement (les passages
   manqués arrivent « reçus en différé »).
4. **Horloge** : un écart de plus de 2 minutes entre le contrôleur et le PSIM est signalé comme défaut de l'équipement.

## 7. Guide de l'opérateur

- **Fermée** : tout va bien. **Ouverte** : passage en cours, rien à faire. **Forcée** : la porte s'est ouverte sans
  autorisation : regardez la caméra, traitez l'alarme. **Maintenue ouverte** : quelqu'un la retient ; après le délai de la
  porte, l'alarme sonne. **Hors ligne** : le PSIM n'a plus de nouvelles du contrôleur ; les badges fonctionnent toujours
  sur place ; faites vérifier l'alimentation et le réseau. **En défaut** : l'équipement signale une panne.
- Un **refus de badge** isolé est normal : il est dans le journal, pas dans les alarmes. Des refus répétés sur une porte
  déclenchent une pré-alarme.
- Les passages « reçus en différé » ont été récupérés dans la mémoire du contrôleur après une coupure : l'heure affichée est
  celle du contrôleur.
- Chercher un titulaire ou un badge, et exporter, sont **inscrits au journal** (qui, quoi, quand). Les données personnelles
  sont conservées 90 jours par défaut, puis supprimées automatiquement.

## 8. Volume (mesures du lot AC2)

Base de 900 000 passages (10 000 par jour sur 90 jours, 20 portes, 500 badges) ; `PSIM_VOLUME_TEST=1 node --test test/access-volume.test.ts` :

- toutes les recherches (période d'une semaine, porte, badge par préfixe, titulaire, total) : moins de 2 s ; pire cas, un titulaire absent (parcours complet) : 540 à 804 ms ;
- export de 100 000 lignes : 2,1 s ;
- ingestion d'un passage : 1,5 ms par message sur la base pleine, soit 1,25 fois le moteur seul ;
- la purge supprime par lots de 10 000 lignes (au plus 200 000 par passage du contrôle d'une seconde) et ne bloque pas l'écran.

## 9. Limites connues et points à qualifier

- **Âge maximal d'un passage** : `PSIM_INGEST_MAX_AGE_S` (7 jours par défaut, 30 jours au plus) borne l'âge de tout message daté, passage différé compris. Un contrôleur resté déconnecté plus longtemps perd les passages les plus anciens à la reconnexion (refus 400 "ts trop ancien"). Pour un site à connexion très instable, monter cette valeur.
- **Vidéo à l'heure du passage : relecture Dahua, À QUALIFIER sur matériel réel** (§ 5). Le mécanisme est testé contre un faux
  flux local ; ce qui suit n'a pas été vérifié sur un enregistreur et se contrôle à la recette :
  - **format de l'heure et fuseau** du `starttime`/`endtime` (`AAAA_MM_JJ_HH_mm_ss`, heure locale du PSIM supposée identique à
    celle de l'enregistreur) : à confirmer sur le modèle installé ; un décalage de fuseau ou d'heure d'été montre un autre moment ;
  - **sous-flux** : la relecture demande toujours `subtype=0` (flux principal enregistré) ; à confirmer que c'est bien celui
    que l'enregistreur conserve (certains n'enregistrent que le principal, d'autres aussi le secondaire) ;
  - **délai d'écriture sur disque** : un passage de moins de quelques secondes peut ne pas encore être relisible (l'enregistreur
    écrit par segments) ; l'opérateur voit alors « Aucun enregistrement à cette heure » et peut ouvrir le direct ;
  - **fin du clip** : l'enregistreur doit fermer la session RTSP à `endtime` ; sinon la relecture s'arrête d'elle-même après 45 s ;
  - **écart d'horloge** : l'heure demandée est celle du **contrôleur** (`atDevice`) ; un contrôleur ou un enregistreur mal réglé
    décale l'extrait (écart de plus de 2 minutes déjà signalé comme défaut, § 6).
- **Sabotage** : l'alarme `tamper` passe par l'incident habituel ; l'état affiché de la porte ne le montre pas séparément.

## 10. Rapports et portail (F27, F28)

Lot « Rapports et portail » (branche `acces-rapports`). Règle commune : **aucun nom de titulaire, numéro de badge, `holderRef`, identifiant ou adresse de contrôleur** ne sort du journal des passages vers un rapport ou vers le portail ; seulement des comptes et des noms de portes (le nom du détecteur). Il n'y a pas d'option nominative dans cette version.

### 10.1 Rapport périodique : section « Contrôle d'accès » (F27)

Le rapport d'incidents (écran imprimable `/api/reports/incidents`, pièce jointe HTML autonome et courriel hebdomadaire ou mensuel, texte et HTML) comporte, pour un site qui a au moins une porte déclarée, une section « Contrôle d'accès ». Elle est **absente** pour un site sans porte et quand le rapport est filtré sur une autre catégorie que « accès » : le rapport d'un site sans porte est identique à avant. Calcul en lecture seule dans `server/accessreport.ts`.

- chiffres clés : portes déclarées, passages, accordés, refusés, passages reçus en différé ;
- incidents d'accès par porte et par type (porte forcée, maintenue ouverte, refus répétés, sabotage, autre), d'après `incident.event` ;
- portes les plus en défaut ou hors ligne : durée cumulée, disponibilité, nombre de coupures, plus longue coupure ; le temps non surveillé (PSIM arrêté) est indiqué à part, jamais compté comme panne ;
- refus par porte et par motif ; les passages d'une porte retirée sont regroupés sous « Porte retirée » (ses incidents et pannes, eux, ne sont plus rapportés) ;
- si la période commence avant la durée de conservation du journal, une note prévient que les chiffres de passages et de refus peuvent être incomplets.

Les requêtes sont agrégées en SQL (filtre sur l'heure du contrôleur, comme le journal). Le CSV joint reste le CSV des incidents existant.

### 10.2 Portail (F28)

Le PSIM ajoute à son résumé un bloc **facultatif** `access` (le format reste `v: 1`), seulement si le site a une porte déclarée (`server/accessportal.ts`, qui ne lit ni `access_event` ni `access_controller`) :

```
access: { doors, states: { offline, fault, forced, heldOpen, open, closed, unknown },
          availability: { upS, downS, unmonitoredS, pct },     // portes, fenêtre de 35 jours
          incidents: { total, forced, heldOpen, repeatedDenials, tamper, other, openNow, byDay: [{ day, n }] } }
```

Le portail le valide champ par champ (bloc mal formé : résumé refusé en 400 ; champ inconnu : ignoré, jamais stocké) et affiche une carte « Contrôle d'accès » dans la Synthèse du site (absente sans porte, « Non transmis » si le site a des détecteurs d'accès mais aucun bloc), et, dans les groupes, le nombre de portes hors ligne ou en défaut (les sites muets à part, dans « À vérifier »). Périmètre et comptes limités à des groupes inchangés. Détails et lecture des chiffres : `docs/PORTAIL.md`.

**Compatibilité** (essai croisé réel avec le code de `dc21510`, dans les deux sens) : un portail ancien ignore le bloc ; un PSIM ancien n'en envoie pas et le portail récent le dit « non transmis ». Ordre de mise à jour inchangé : le portail avant les PSIM.

**Preuve de confidentialité** : `test/portal-access-privacy.test.ts` fouille le corps de `buildSiteSummary`, le corps réellement envoyé par `createPortalSender`, les réponses du portail pour cinq rôles et toutes les tables du portail, à la recherche du nom, du badge, de la `holderRef`, de l'identifiant et de l'hôte du contrôleur ; `test/e2e-portal-access.test.ts` le refait avec un vrai PSIM et un vrai portail, octets échangés enregistrés.

## 11. Ouverture à distance (AC4 : F17 à F20)

Principe : **le contrôleur décide, le PSIM commande**. L'ouverture à distance ne passe que par le **canal de commande signé** (`docs/COMMANDES.md`, `POST /api/actuators/:id/commands`) : raison obligatoire, mot de passe redemandé selon la configuration de l'actionneur, limite de fréquence, accusé, retour automatique à l'état sûr, journal infalsifiable. Il n'existe aucun autre chemin vers une serrure : l'écran Accès, la fiche d'incident et « Tout ouvrir » appellent tous le même service (`server/actuators.ts`).

### 11.1 Lien porte et actionneur

Une porte est liée à un actionneur déjà créé (écran Équipements, section Actionneurs) par `actuatorId` (fiche de la porte, bloc « Actionneur lié », administrateur ; ou `PUT /api/access/doors/:id`, ou `POST /api/access/doors` à la déclaration). Contrôles, sur l'état **résultant** (on revérifie aussi quand on change seulement le type ou l'issue de secours d'une porte déjà liée), refus avec un message clair :

| Règle | Refus |
|---|---|
| L'actionneur existe | 400 |
| Type cohérent : porte (`door`) avec un actionneur `lock` ; barrière, portail, tourniquet (`gate`, `barrier`, `turnstile`) avec un actionneur `gate` | 400 |
| Un actionneur ne sert qu'**une seule** porte | 409 |
| **F18 : issue de secours des deux côtés ou d'aucun** (porte `emergencyExit` et actionneur `emergencyExit`, ou ni l'un ni l'autre) | 400 |

`actuatorId: null` délie la porte. Un actionneur désactivé est accepté au lien, mais la fiche dit que l'ouverture est impossible. Le refus de `lock` sur une issue de secours existe aussi à l'exécution (`server/actuators.ts`, 403 si la configuration a été falsifiée en base, 400 sinon puisque l'action n'existe pas) : le PSIM n'envoie jamais l'ordre `lock` à une issue de secours.

La fiche d'une porte (`GET /api/access/doors/:id`) porte `remote` : `{ available, reason, actuatorId, actuatorName, actuatorType }`. `available` est vrai si le lien est valide, l'actionneur existe et est actif et que les types et l'issue de secours sont cohérents ; sinon `reason` dit pourquoi (aucun actionneur lié, actionneur supprimé, désactivé, type incohérent, issue de secours d'un seul côté). L'écran croise avec `GET /api/actuators` pour les droits de l'utilisateur.

### 11.2 Guide de l'installateur

1. Créer l'actionneur dans le PSIM (Équipements, Actionneurs) : type `lock` pour une porte, `gate` pour une barrière ou un portail, transport MQTT, **issue de secours cochée si la porte en est une** (une serrure d'issue de secours n'accepte jamais « verrouiller »). Copier la **clé de signature** (affichée une seule fois).
2. Autoriser le compte MQTT de la passerelle pour cet actionneur (`PSIM_MQTT_GATEWAYS`, liste `actuators`), voir `docs/PASSERELLE.md` § 8.1.
3. Déclarer l'actionneur dans la configuration de la passerelle **à deux endroits** : la section `actuators` du socle (identifiant, `keyFile`, `module: "acces-dahua"` ou `"acces-zkteco"`, actions et plafonds locaux `maxS`, `rest: "lock"`, `emergencyExit`) **et** la configuration du contrôleur dans le module (`actuators: { "GACHE-1": { "door": 1, "type": "lock" } }`, qui dit quelle porte du contrôleur il pilote). Le plafond local de la passerelle prime : un PSIM compromis ne peut pas tenir la porte ouverte plus longtemps. Pour que « Tout ouvrir » ouvre **15 minutes** (et non 10 s), la section `actuators` de la passerelle doit aussi **permettre l'action `evacuate`** : `"actions": { "unlock": { "maxS": 10 }, "evacuate": { "maxS": 900 }, "lock": {} }` pour une serrure, `"evacuate": {}` pour un portail ou une barrière. Sans cela la passerelle refuse l'ordre (`not_allowed`) ; la traduction de `evacuate` en opération sur le contrôleur est faite par les modules d'accès de la passerelle (lot d'intégration).
4. Fiche de la porte (Accès, Portes), bloc « Ouverture à distance », administrateur : choisir l'actionneur et cliquer « Lier ». La fiche de la porte doit afficher « Ouverture à distance » avec ses boutons ; sinon la raison est écrite.
5. **Recette** : ouvrir (impulsion) ; vérifier l'accusé « Accusée par l'équipement » ; vérifier que la porte se referme seule ; couper la passerelle (le bouton doit se désactiver : « Liaison coupée ») ; sur une issue de secours, vérifier que « Verrouiller » est absent et que le déverrouillage matériel (centrale incendie) fonctionne **sans** le PSIM.

### 11.3 Guide de l'opérateur (parcours P2, livreur à la barrière)

1. Regarder la caméra de la porte (« Voir la caméra » dans le bloc, ou la caméra de l'incident).
2. Cliquer **Ouvrir (impulsion)** (porte ou barrière), ou **Ouvrir N minutes** (porte, si l'équipement le permet). Une barrière propose Ouvrir, Fermer, Arrêter.
3. Saisir la **raison** (« livraison gaz ») et **votre mot de passe**, cocher la confirmation, envoyer.
4. Attendre l'état **« Accusée par l'équipement »** : « Envoyée » ne veut pas dire « ouverte ». « Échec : aucun accusé » veut dire que l'ordre a pu être exécuté : vérifier sur place.
5. **Verrouiller** remet la porte en fonctionnement normal (badges actifs) ; c'est une action immédiate, sans raison ni mot de passe, et elle n'existe jamais sur une issue de secours. **Arrêter** stoppe une barrière tout de suite.

**« Ouvrir N minutes »** : par défaut seule l'impulsion est proposée (la durée maximale d'une ouverture de serrure est de 10 s). L'administrateur relève la durée **porte par porte** : relever `maxS` de l'action `unlock` de l'actionneur dans le PSIM (Équipements, Actionneurs, Actions : par exemple `{"unlock":{"maxS":600}}`) **et** dans la section `actuators` de la passerelle (le plafond local prime) ; le bouton apparaît alors sur la fiche de la porte. Tant que ce n'est pas fait, le bouton est masqué et la fiche l'explique.

Dans la fiche d'un **incident d'accès** (porte forcée, maintenue ouverte, refus répétés), le bloc « Ouverture à distance » apparaît pour la porte de l'incident, et le bouton « Commandes » met l'actionneur de cette porte en tête ; la commande est rattachée à l'incident. Chaque ouverture est journalisée avec sa raison, son auteur et l'incident.

### 11.4 Mode de porte (F19)

Un contrôleur peut être réglé pour garder une porte ouverte ou fermée selon des horaires (par exemple porte ouverte aux heures de bureau). Ce réglage reste **dans le contrôleur**, le PSIM l'affiche. Message de la passerelle : `{"event":"door_mode","doorMode":"normal"|"always_open"|"always_closed","ts":...,"msgId":...}` à la connexion et à chaque changement. Le PSIM garde le dernier mode connu et sa date (`doorMode`, `doorModeLabel`, `doorModeAt` dans la vue de la porte) ; un message plus ancien n'écrase pas un plus récent, une valeur inconnue est ignorée ; un changement de mode est inscrit au journal (`access_door_mode`). Le champ `doorMode` est lu **quel que soit** l'événement du message. Tant qu'aucun message n'est arrivé : « non communiqué par le contrôleur ».

Dépendance de fusion : le moteur (`server/sources.ts`) répond aujourd'hui « event inconnu » à `{"event":"door_mode"}` ; la ligne `door_mode: 'alive'` est ajoutée par la branche de la passerelle. Tant qu'elle n'est pas fusionnée, un message `{"state":"normal","doorMode":...}` est pris en compte, pas l'événement `door_mode`.

### 11.5 « Tout ouvrir » (F20, évacuation)

Réservé à l'**administrateur**. **Cela ne remplace jamais le déverrouillage matériel par la centrale incendie** : les issues de secours doivent s'ouvrir par ce dispositif, le PSIM n'en est jamais l'unique moyen (PRD § 8.9, voir § 11.7).

**Action `evacuate`.** « Tout ouvrir » n'utilise pas l'impulsion de 10 s des opérateurs : le catalogue des actionneurs a une action propre, `evacuate`, réservée à l'administrateur (`roles` ne peut pas contenir `operator`), ajoutée par défaut aux **nouveaux** actionneurs `lock` et `gate` :

| Actionneur | `evacuate` | Retour |
|---|---|---|
| Serrure (`lock`) | ouverture de `maxS` secondes (défaut **900**, plafond 3 600) | retour automatique à `lock` à la fin, comme `unlock` (envoi `durationS` + 1 s, et l'équipement se referme seul) |
| Serrure **issue de secours** | ouverture de `maxS` secondes | **aucun ordre `lock` n'est jamais envoyé** par le PSIM : la porte revient à son état par le réglage de l'équipement (sécurité positive). Choix le plus sûr : on ouvre, on ne referme jamais |
| Portail, barrière (`gate`) | ouverture instantanée, **sans durée**, laissée ouverte | aucun retour automatique (§ 4.8 de `docs/COMMANDES.md` : fermer d'office sur une personne ou un véhicule est plus dangereux) ; fermeture sur place ou par un opérateur (« Fermer ») |

**Actionneurs existants** : une base existante ne gagne **pas** l'action en silence. Pour l'activer, l'administrateur modifie l'actionneur (Équipements, Actionneurs, Actions) : `{"unlock":{"maxS":10},"evacuate":{"maxS":900}}` (serrure) ou `{"open":{},"close":{},"evacuate":{}}` (portail). **Sans l'action `evacuate`**, « Tout ouvrir » se replie sur l'impulsion (`unlock` ou `open`, bornée par son `maxS`) et le dit : dans l'aperçu et dans le bilan, la porte porte l'avertissement « ne s'ouvrira que N s : ajoutez l'action évacuation ».

**Limite actuelle (passerelle)** : tant que les modules d'accès de la passerelle (`gateway/src/modules/acces-commun/actuator.ts`) ne traduisent pas `evacuate` (lot d'intégration), la passerelle refuse l'ordre (`not_supported` ou `not_allowed`) : la commande finit `refused`, la porte ne s'ouvre pas et l'écran ne la compte jamais ouverte. Seuls les actionneurs qui n'ont pas `evacuate` (se repliant sur `unlock` ou `open`) s'ouvrent aujourd'hui. À vérifier à la recette avant de compter sur « Tout ouvrir ».

- `GET /api/access/evacuation` : aperçu des portes liées à un actionneur, avec l'action (`evacuate`, ou `unlock` / `open` en repli), la durée maximale (`null` pour un portail en `evacuate`), si la porte est prête ou pourquoi elle ne l'est pas, et l'avertissement de repli (`warning`). Rien n'est envoyé.
- `POST /api/access/evacuation`, corps `{ reason, password, confirm: true, confirmPhrase: "TOUT OUVRIR", durationS? }` : **double confirmation** explicite (première boîte de dialogue avec l'avertissement, seconde avec raison, phrase `TOUT OUVRIR` et mot de passe). Durée par défaut **900 s** (15 minutes), ramenée au maximum configuré de chaque actionneur. 428 si la confirmation, la phrase ou la raison manque, 403 si le mot de passe est faux (rien n'est envoyé), 409 si aucune porte n'est liée, 429 au-delà de 2 évacuations par minute et par administrateur.
- Réponse : un résultat **par porte** (`sent`, `no_gateway` = aucune passerelle n'écoute l'actionneur, `refused` avec le message du service des commandes : mode maintenance, limite, actionneur inactif, lien incohérent ; `error`), avec l'action envoyée, la durée réellement demandée et l'éventuel avertissement. L'échec d'une porte n'arrête pas les autres. Les accusés arrivent ensuite en temps réel, comme pour une commande ordinaire ; l'écran ne compte une porte « ouverte » qu'après son accusé, et dit quelles portes sont à ouvrir ou vérifier sur place.
- Chaque ouverture est une vraie commande du canal signé (`commande_demandee`, raison `Tout ouvrir (lot xxxxxxxx) : ...`), donc soumise aux plafonds de la passerelle. Aucune file ni rejeu : si le PSIM redémarre, rien n'est renvoyé.
- Journal infalsifiable : `access_evacuation` (qui, raison, nombre de portes) **avant** l'envoi (si l'écriture échoue, rien ne part), `access_evacuation_bilan` après (portes en échec, portes ouvertes brièvement faute d'action `evacuate`) ; échec du mot de passe : `access_evacuation_reauth_echec`.
- Le bouton est dans Équipements, Actionneurs (administrateur).

### 11.6 Essai de bout en bout et mesures (PRD § 12)

`test/e2e-acces-chaine.test.ts` : faux contrôleur Dahua, module réel `acces-dahua`, socle réel de la passerelle (section `actuators`, clé de signature), broker MQTT du vrai PSIM, vrai PSIM (processus séparé, ports au hasard, base temporaire). Il couvre : passage accepté puis porte forcée (incident critique, passages dans `/api/access/events`) ; ouverture à distance avec raison et mot de passe (ordre signé, `openDoor` reçu par le faux contrôleur, accusé, retour à l'état sûr, journal) et ses refus ; issue de secours (`lock` refusé, liens refusés) ; coupure du contrôleur (porte « hors ligne », passages différés récupérés sans doublon) ; mode de porte.

Mesures locales (boucle locale, 20 essais chacune, deux lancements) :

| Objectif PRD § 12 | Mesure | Objectif |
|---|---|---|
| Porte forcée sur le contrôleur, alarme visible dans le PSIM, médiane | 4,0 et 6,3 ms (p95 6,3 et 11,8 ms) | moins de 3 s |
| Ordre d'ouverture, accusé reçu, 95e centile | 185 et 180 ms (médiane 124 ms) | moins de 2 s |

Ces valeurs sont obtenues en boucle locale avec un faux contrôleur : elles montrent que le PSIM et la passerelle n'ajoutent presque aucun délai, pas la latence du réseau du site ni celle du matériel réel (point à mesurer à la recette sur le contrôleur Dahua pilote).

### 11.7 Sécurité incendie : le PSIM n'ouvre jamais seul les issues de secours

Décision de l'utilisateur : une **alarme incendie n'ouvre pas automatiquement** les issues de secours depuis le PSIM. L'ouverture est **manuelle seulement** (bouton « Ouvrir » de l'opérateur ou « Tout ouvrir » de l'administrateur, avec raison et mot de passe).

- Le déverrouillage des issues en cas d'incendie relève de la **centrale incendie** et de la **sécurité positive des serrures** (la serrure se libère quand le courant ou le signal de la centrale tombe), pas du PSIM. L'installation doit fonctionner **sans** le PSIM : la recette le vérifie (coupure de courant : porte libre).
- Aucune règle du PSIM ne déclenche une commande d'ouverture à partir d'une alarme incendie ; un incident incendie ne crée jamais de commande. Le PSIM ne peut pas non plus verrouiller une issue de secours (F18).
- « Tout ouvrir » aide l'opérateur à ouvrir les portes d'accès et les barrières pendant une évacuation ; il ne remplace jamais le dispositif matériel.
