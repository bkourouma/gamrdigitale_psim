# Application des agents et rondes — contrat de conception

Rédigé le 17 octobre 2026 par le chef de projet, à partir de `docs/PRD-APPLICATION-AGENTS.md` (à lire d'abord).
Ce document est **le contrat commun** des superviseurs : noms de fichiers, tables, routes et formes JSON ci-dessous
sont figés. Un écart nécessaire se signale au chef, il ne s'improvise pas.

## Décisions de l'utilisateur (17 octobre 2026)

1. **PWA d'abord** (servie par le PSIM, `web/agent/`), coquille Android en phase 2 (lot AG6, hors de ce chantier).
2. Étiquettes **NFC et QR** acceptées toutes les deux, même contenu.
3. Périmètre : **toutes les exigences M + les S faisables sans Android** (F8 vidéo, F15 rapport, F25 portail).
   Hors chantier : F7, F19 repli SMS, F20, F21, F23, F24, F16.
4. Position = **dernier point de contrôle scanné** uniquement (pas de GPS).
5. Pilote : **Résidence KOUROUMA** ; les agents du pilote sont salariés du client, qui les informe par écrit et
   fait la déclaration ARTCI.

## Décisions techniques du chef

- Le téléphone est un **navigateur** (Chrome Android) sur la même origine que le PSIM : on garde le cookie de
  session `psim_session` pour l'agent, pas de jeton Bearer.
- **Appairage** : clé de téléphone propre, sur le modèle de `server/devicekeys.ts` (empreinte SHA-256, comparaison en
  temps constant, révocation), remise au téléphone dans un **cookie HttpOnly** `psim_phone`
  (`HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` + `Secure` si TLS). Le JavaScript du téléphone ne voit jamais
  la clé.
- **Agents = utilisateurs** de `app_user` avec le rôle `agent` (mot de passe aléatoire inutilisable, `/api/login` refuse
  ce rôle) + profil `agent_profile` (code personnel, zones). Connexion sur un téléphone appairé : l'agent touche son
  nom puis tape son code (4 à 6 chiffres).
- Pas de WebSocket pour l'agent : l'application **interroge** `/api/agent/alarms` toutes les **4 s** quand elle est au
  premier plan (objectif « < 10 s »), 30 s sinon. Le WebSocket `/ws` refuse le rôle `agent`.
- **Contenu d'une étiquette** (QR et enregistrement NDEF URL identiques) :
  `https://<hôte-du-PSIM>/agent/#cp=<code>` où `<code>` = 10 caractères base32 minuscules aléatoires
  (`[a-z2-7]{10}`), unique, propre au point de contrôle, régénérable. Le code est aussi imprimé en clair sous le QR
  (saisie manuelle de secours).
- QR codes générés **côté serveur en SVG** avec la dépendance `qrcode` déjà présente (pas de bibliothèque dans le
  navigateur, CSP inchangée).
- Lecture QR dans l'application : API `BarcodeDetector` de Chrome Android, à défaut saisie du code. NFC : `NDEFReader`
  (Web NFC). Aucune dépendance externe.
- File hors ligne : IndexedDB dans le téléphone ; chaque envoi porte un `clientId` (UUID v4 généré par le téléphone)
  qui rend l'envoi **idempotent** côté serveur.
- Toute l'heure côté serveur est en millisecondes epoch (`number`), comme le reste du PSIM.

## Fichiers et propriétaires

| Lot | Superviseur | Fichiers possédés |
|---|---|---|
| **S1 = AG1 + AG2** (serveur) | superviseur serveur | `server/agents.ts` (nouveau), `server/patrols.ts` (nouveau), `server/types.ts`, `server/db.ts`, `server/users.ts`, `server/auth.ts`, `server/api.ts`, `server/sources.ts`, `server/visibility.ts`, `server/main.ts`, `test/agents*.test.ts`, `test/patrols*.test.ts` |
| **S2 = AG3** (écran administrateur) | superviseur écran | `web/patrols.js`, `web/patrols.css` (nouveaux), `web/agents-admin.js` (nouveau), `web/index.html` (sections ajoutées seulement), `web/app.js` (entrées `ROUTES`, chargement), `web/users.js` si l'écran des comptes doit masquer les agents |
| **S3 = AG4** (application agent) | superviseur application | tout `web/agent/` (nouveau) |
| **S4 = AG5** (après S1) | à lancer ensuite | `web/plan.js`, `web/incidents.js` (affichage « qui se déplace »), `server/reports.ts`, `server/portal.ts`, `portal/**` |

S2 et S3 développent contre ce contrat **sans attendre** S1 (simulation des réponses dans leurs tests si besoin) ;
l'intégration se fait à la fusion. Personne d'autre que S1 ne touche `server/`.

## Modèle de données (S1, tables créées par `db.exec(SCHEMA)` dans les constructeurs de module)

```sql
-- server/agents.ts
agent_profile(username TEXT PRIMARY KEY REFERENCES app_user(username) ON DELETE CASCADE,
  display_name TEXT NOT NULL, pin_hash TEXT NOT NULL,          -- scrypt comme les mots de passe
  zones TEXT NOT NULL DEFAULT '[]',                             -- JSON string[] ; [] = toutes les zones
  failed_pins INTEGER NOT NULL DEFAULT 0, locked_at INTEGER,    -- verrou après 5 codes faux, levé par l'admin
  max_shift_minutes INTEGER NOT NULL DEFAULT 720)
agent_phone(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, key_hash TEXT UNIQUE,
  pair_hash TEXT UNIQUE, pair_expires_at INTEGER,               -- code d'appairage à usage unique, 15 min
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, paired_at INTEGER,
  revoked_at INTEGER, revoked_by TEXT, last_seen_at INTEGER)
agent_shift(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, phone_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,         -- fin automatique prévue
  ended_at INTEGER, end_reason TEXT)                            -- 'agent'|'timeout'|'revoked'|'admin'
agent_position(username TEXT PRIMARY KEY, checkpoint_id INTEGER NOT NULL, at INTEGER NOT NULL)
agent_dispatch(id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, username TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('en_route','on_site')), at INTEGER NOT NULL)
-- server/patrols.ts
checkpoint(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '',
  floor_id INTEGER NOT NULL, x REAL NOT NULL DEFAULT 50, y REAL NOT NULL DEFAULT 50,   -- % comme les équipements
  code TEXT NOT NULL UNIQUE, archived_at INTEGER)
patrol_route(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  checkpoints TEXT NOT NULL,          -- JSON number[] (ids, dans l'ordre)
  ordered INTEGER NOT NULL DEFAULT 0, max_minutes INTEGER NOT NULL,
  schedule TEXT NOT NULL,             -- JSON Window[] (server/arming.ts) : heure de DÉBUT = from
  agents TEXT NOT NULL DEFAULT '[]',  -- JSON string[] usernames ; [] = tout agent en service
  grace_minutes INTEGER NOT NULL DEFAULT 10,   -- délai pré-alarme -> critique
  enabled INTEGER NOT NULL DEFAULT 1, archived_at INTEGER)
patrol_run(id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL,
  due_start INTEGER NOT NULL, due_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','done','incomplete','missed')),
  started_by TEXT, started_at INTEGER, finished_at INTEGER,
  UNIQUE(route_id, due_start))
patrol_scan(id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE,
  run_id INTEGER, checkpoint_id INTEGER NOT NULL, username TEXT NOT NULL, phone_id INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('nfc','qr','manual')),
  phone_at INTEGER NOT NULL, server_at INTEGER NOT NULL, deferred INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL)              -- 'ok'|'out_of_route'|'out_of_order'|'no_run'|'duplicate'
logbook_entry(id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL, category TEXT NOT NULL,   -- 'anomaly'|'damage'|'visitor'|'other'
  text TEXT NOT NULL, checkpoint_id INTEGER, photo_file TEXT, photo_sha256 TEXT,
  phone_at INTEGER NOT NULL, server_at INTEGER NOT NULL, deferred INTEGER NOT NULL DEFAULT 0,
  incident_id INTEGER)                -- rempli si le chef de poste en fait un incident
```

Rôle `agent` : `Role = 'operator' | 'admin' | 'agent'` ; la contrainte CHECK de `app_user` est recréée sur le modèle
de `migrateRecipientChannels` ; `needsTotp('agent') = false`.

`deferred = 1` quand `server_at - phone_at > 120 000` ms (« reçu en différé »). Le serveur refuse un `phone_at`
situé plus de 5 min dans le futur ou plus de 24 h dans le passé.

## Événements (S1, `server/sources.ts`)

| Événement | Effet | Libellé | Toujours actif |
|---|---|---|---|
| `patrol_incomplete` | `prealarm` | « Ronde incomplète » | oui |
| `patrol_missed` | `alarm` | « Ronde non faite » | oui |
| `sos` (existe) | `alarm` | « Appel de détresse (SOS) » | oui (déjà) |
| `logbook_report` | `prealarm` | « Signalement d'un agent » | non |

`agent_still` n'est pas ajouté (F20 hors chantier).

**Détecteurs virtuels** (même principe que les règles `R-<id>`), catégorie `people`, `heartbeatS: 0` :
- `P-<routeId>` par circuit, créé/renommé/archivé avec le circuit, zone = zone du premier point, position = premier
  point.
- `A-<username>` par agent, créé avec le profil (nom affiché), zone = zone de sa dernière position.

Le SOS fait `engine.handleDetectorMessage('A-<username>', {event:'sos'})` ; la ronde ratée fait
`handleDetectorMessage('P-<routeId>', {event:'patrol_incomplete'|'patrol_missed'})`. Le motif détaillé
(« 3 points manqués : Parking, Arrière-cour, Local bouteilles », « dernier point : Arrière-cour, il y a 2 min ») est
porté par le champ texte que le moteur accepte déjà pour un événement ; s'il n'en existe pas, S1 l'ajoute de façon
compatible (signalé au chef).

## Machine des rondes (S1, `server/patrols.ts`)

`createPatrolMachine(route, now)` **pure** (le temps est passé en argument, comme `createRuleMachine`) ;
`createPatrols({db, engine, agents, now?})` l'utilise, `patrols.tick()` est appelé chaque seconde depuis `main.ts`.

- À chaque début de plage (`Window.from`) d'un circuit actif : création de `patrol_run` `pending`,
  `due_start` = début, `due_end` = début + `max_minutes`.
- Premier scan valide d'un point du circuit pendant `[due_start - 15 min, due_end]` par un agent autorisé : `active`.
- Tous les points scannés : `done` (un circuit `ordered` exige l'ordre ; un point hors ordre est noté
  `out_of_order` et ne compte pas).
- À `due_end` : si aucun scan → `missed` et `patrol_missed` (alarme) ; si des points manquent → `incomplete` et
  `patrol_incomplete` (pré-alarme) ; puis, sans scan supplémentaire pendant `grace_minutes`, `patrol_missed`
  (critique). Un scan qui complète la ronde avant cette échéance remet le détecteur `P-` à `clear`.
- Redémarrage du serveur : rien n'est perdu (état reconstruit depuis `patrol_run` / `patrol_scan`).

## API agent (S1) — `/api/agent/*`, rôle `agent` sauf mention

Toutes les réponses d'erreur : `{ error: "message en français" }` + code HTTP. Toutes ces routes exigent aussi un
cookie `psim_phone` valide (non révoqué) **sauf** `pair`.

| Méthode, route | Corps → réponse |
|---|---|
| `POST /api/agent/pair` (public, limité à 10/min par IP) | `{ code }` (code d'appairage) → pose `psim_phone` ; `{ phone: { id, label } }` |
| `GET /api/agent/phone` (téléphone appairé, sans session) | `{ phone: {id,label}, agents: [{ username, displayName, locked }] }` |
| `POST /api/agent/login` (téléphone appairé) | `{ username, pin }` → pose `psim_session` (durée = `max_shift_minutes`) ; `{ me: AgentMe }` ; 423 si verrouillé ; 401 sinon (5 échecs → verrou) |
| `POST /api/agent/logout` | — → fin de session (le service continue s'il n'est pas terminé) |
| `GET /api/agent/me` | `{ me: AgentMe }` |
| `POST /api/agent/shift/start` | — → `{ me: AgentMe }` |
| `POST /api/agent/shift/end` | — → `{ ok: true }` + fin de session ; les données locales doivent être effacées par l'application |
| `GET /api/agent/alarms` | `{ alarms: AgentAlarm[], serverAt }` incidents non clos des zones de l'agent, le plus grave d'abord puis le plus ancien |
| `POST /api/agent/alarms/:id/ack` | — → `{ ok: true }` (acquittement moteur, acteur = agent) |
| `POST /api/agent/alarms/:id/dispatch` | `{ status: 'en_route'|'on_site' }` → `{ ok: true }` |
| `GET /api/agent/alarms/:id/snapshot` | image JPEG/PNG de la dernière image de l'incident (mêmes en-têtes que `/api/snapshots/:id`) |
| `GET /api/agent/alarms/:id/live` | flux de la caméra liée (F8) : **réutilise** le mécanisme direct existant du poste de garde (sous-flux), autorisé au rôle `agent` pour une caméra liée à un incident de ses zones seulement |
| `GET /api/agent/runs` | `{ runs: AgentRun[] }` rondes `pending`/`active` du jour concernant l'agent, plus la prochaine à venir |
| `POST /api/agent/scans` | `{ clientId, code, method, phoneAt }` → `{ scan: { verdict, checkpoint: {id,name}, run: AgentRun | null, deferred } }` ; un `clientId` déjà reçu renvoie la même réponse (idempotent) ; code inconnu → 404 `Étiquette inconnue` |
| `POST /api/agent/logbook` | `{ clientId, category, text (≤ 1000), checkpointId?, phoneAt, photo? }` (`photo` = JPEG base64 ≤ 400 Ko, limite JSON de cette route : 600 Ko) → `{ entry: { id } }`, idempotent |
| `POST /api/agent/sos` | `{ clientId, phoneAt, discreet: boolean }` → `{ ok: true, incidentId }`, idempotent ; **accepté même hors service** (un agent connecté en danger doit pouvoir alerter) |

```ts
interface AgentMe { username: string; displayName: string; zones: string[];
  shift: { id: number; startedAt: number; endsAt: number } | null;
  position: { checkpointId: number; name: string; at: number } | null }
interface AgentAlarm { id: number; severity: 'critical'|'warning'; title: string; detail: string;
  deviceName: string; zone: string; floorName: string; openedAt: number; acknowledged: boolean;
  acknowledgedBy: string | null; hasSnapshot: boolean; hasLive: boolean;
  dispatch: { username: string; displayName: string; status: 'en_route'|'on_site'; at: number }[] }
interface AgentRun { id: number; routeId: number; name: string; status: 'pending'|'active'|'done'|'incomplete'|'missed';
  dueStart: number; dueEnd: number; ordered: boolean;
  checkpoints: { id: number; name: string; zone: string; done: boolean; doneAt: number | null }[] }
```

Le rôle `agent` est **refusé** sur toutes les autres routes `/api/*` (sauf `/api/me` en lecture) et sur `/ws`.

## API d'administration (S1) — rôle `admin` sauf mention

| Méthode, route | Usage |
|---|---|
| `GET /api/agents` | `[{ username, displayName, zones, locked, maxShiftMinutes, shift, position }]` |
| `POST /api/agents` | `{ username, displayName, pin, zones, maxShiftMinutes? }` |
| `PATCH /api/agents/:username` | `{ displayName?, pin?, zones?, maxShiftMinutes?, unlock? }` |
| `DELETE /api/agents/:username` | désactive (statut du compte), pas de suppression des traces |
| `POST /api/agents/:username/end-shift` | fin de service forcée |
| `GET /api/agent-phones` | `[{ id, label, pairedAt, revokedAt, lastSeenAt, pending }]` |
| `POST /api/agent-phones` | `{ label }` → `{ id, pairUrl, expiresAt }` avec `pairUrl = https://<hôte>/agent/#pair=<code>` |
| `GET /api/agent-phones/:id/pair.svg` | QR de `pairUrl` (tant que l'appairage est en attente) |
| `POST /api/agent-phones/:id/revoke` | révocation en un clic : ferme sessions et service en cours |
| `GET /api/agent-cert` (public) | certificat public du PSIM (`PSIM_TLS_CERT`) en `application/x-x509-ca-cert`, 404 si pas de TLS ; `GET /api/agent-cert.svg` (admin) son QR |
| `GET/POST /api/patrols/checkpoints`, `PATCH/DELETE /api/patrols/checkpoints/:id` | `{ name, zone, floorId, x, y }` ; `POST .../:id/recode` régénère le code |
| `GET /api/patrols/checkpoints/:id/qr.svg` | QR de l'étiquette |
| `GET/POST /api/patrols/routes`, `PATCH/DELETE /api/patrols/routes/:id` | `{ name, checkpoints, ordered, maxMinutes, schedule, agents, graceMinutes, enabled }` |
| `GET /api/patrols/runs?from&to&routeId&username` (admin + operator) | rondes avec scans |
| `GET /api/patrols/logbook?from&to` (admin + operator) | main courante ; `GET /api/patrols/logbook/:id/photo` |
| `POST /api/patrols/logbook/:id/incident` (admin + operator) | crée un incident depuis l'entrée : événement `logbook_report` (`prealarm`, « Signalement d'un agent », pas toujours actif) sur le détecteur `A-<username>` |
| `GET /api/patrols/positions` (admin + operator) | `[{ username, displayName, checkpointId, name, floorId, x, y, at }]` agents **en service** seulement |
| `GET /api/patrols/report?from&to` (admin + operator) et `.csv` | taux par jour / circuit / agent (S4) |

L'accès à l'historique des positions (`patrol_scan` par agent) est journalisé dans l'audit (`patrol_history_read`).
Conservation : `agent_position` effacée à la fin du service ; `patrol_scan` et `logbook_entry` conservés 400 jours
(réglable plus tard).

## Application agent (S3, `web/agent/`)

`index.html`, `app.js` (module), `agent.css`, `sw.js` (portée `/agent/`), `manifest.webmanifest`, icônes SVG/PNG.
CSP du PSIM inchangée : aucun script ni style en ligne. Trois onglets : **Alarmes**, **Ronde**, **SOS** (le bouton SOS
reste visible sur tous les écrans). Écrans hors session : appairage (`#pair=`), choix de l'agent + code, prise de
service. Écran « Main courante » accessible depuis Ronde.

- Alarmes : interrogation 4 s, son + vibration tant qu'une alarme n'est acquittée par personne (F6), détail avec
  image, boutons « Acquitter », « J'y vais », « Sur place », vidéo en direct si `hasLive`.
- Ronde : liste des points, scan NFC (`NDEFReader`) ou QR (`BarcodeDetector` sur la caméra arrière) ou saisie du
  code ; coche verte + vibration ; ouvrir l'application par l'URL `#cp=` (étiquette NFC lue téléphone déverrouillé)
  enregistre aussi le scan.
- SOS : appui maintenu 2 s avec anneau de progression ; mode discret (réglage local) sans son ni changement d'écran ;
  état « SOS envoyé ✓ » ou, en rouge, « SOS non transmis — nouvel essai… » avec essai toutes les 10 s jusqu'au succès.
- File hors ligne IndexedDB pour scans, main courante, SOS ; badge « N envois en attente » ; vidage au retour du
  réseau et toutes les 15 s ; effacement de la base locale à la fin du service.
- Photo de main courante : réduite dans un `<canvas>` à 1280 px max, JPEG qualité 0,7, ≤ 400 Ko.
- Grosses cibles (≥ 56 px), fort contraste lisible au soleil, français courant.

## Écran administrateur (S2)

Nouvelle entrée `ROUTES` « Rondes » (admin ; lecture pour operator du journal et de la main courante) :
1. **Points de contrôle** : liste + placement sur le plan de l'étage (glisser, comme `plan.js`, sans modifier
   `plan.js`), impression d'une planche d'étiquettes (QR SVG + nom + code en clair, CSS `@media print`).
2. **Circuits** : ordre des points, durée, plages (réutiliser l'éditeur de plages s'il est exportable, sinon un
   éditeur simple jours + de/à), agents concernés, délai de grâce.
3. **Agents** : création (nom, identifiant, code, zones), déverrouillage, fin de service forcée.
4. **Téléphones** : ajouter → QR d'appairage + QR « Installer le certificat » ; liste, révocation en un clic.
5. **Journal** : rondes du jour et main courante (bouton « En faire un incident »).

## Lot S4 (AG5, après fusion de S1)

Pastilles des agents en service sur le plan du poste de garde (`/api/patrols/positions`, « il y a 4 min »),
« qui se déplace » dans le détail d'incident, rapport de rondes (F15 : CSV + section dans le rapport e-mail),
portail (F25 : `SiteSummary.patrols?` facultatif = taux par semaine + nombre de SOS, **sans noms ni positions**).

## Vérification attendue de chaque lot

`npm run typecheck` vert, tests ciblés verts puis `npm test` complet avant le compte rendu, captures du navigateur
intégré pour S2 et S3 (vue téléphone 375 × 812 pour S3), aucun fichier hors de sa liste modifié.
