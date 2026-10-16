# Présence, règles et reconnaissance faciale — contrat de conception

Rédigé le 16 octobre 2026 par le chef de projet (session « reconnaissance faciale »). Ce document est la **référence commune**
de tous les lots : interfaces, propriété des fichiers, ordre. Un lot qui doit s'en écarter le signale au chef au lieu de
changer le contrat seul.

## Objectif

Site pilote : **Résidence KOUROUMA** (enregistreur Dahua **DH-XVR5108HS-I3/T**, logiciel 4.000 du 5 juillet 2025, 8 voies
analogiques, internet disponible). Trois cas retenus :

1. **Présence dans une zone** : quelqu'un est vu dans une zone, à certaines heures, ou y reste trop longtemps.
2. **Personne interdite** : un visage de la liste « Interdits » est reconnu → alarme critique.
3. **Inconnu en zone réservée** : un visage absent de la liste « Résidents et personnel » est vu dans une zone réservée.

Les règles sont **souples** (créées par l'utilisateur final) et, à terme, rédigées par une **IA** à partir d'une phrase en
français. L'IA ne décide jamais d'une alarme : elle propose une règle, le PSIM la vérifie, l'humain valide, puis le moteur
local et déterministe l'applique (même sans internet).

## Faits vérifiés sur l'enregistreur (lecture seule, 16/10/2026)

- `SmartMotionDetect` (SMD Plus, humain + véhicule) **actif sur les 8 voies** : `SmartMotionHuman` Start/Stop arrive déjà
  par `eventManager.cgi?action=attach&codes=[All]` (le flux que lit `server/dahua.ts`).
- Événements exposés : `FaceDetection`, `FaceRecognition`, `CrossLineDetection`, `CrossRegionDetection`, `SmartMotionHuman`…
- Règles d'analyse `FaceAttribute` présentes sur chaque voie, **désactivées**. `faceRecognitionServer.cgi?action=findGroup`
  répond 200, vide : **aucune base de visages**.
- Fiche constructeur : reconnaissance faciale sur **2 voies**, 10 bases, 10 000 photos.
- Voies choisies pour les visages (décision utilisateur) : **voie 5 « Avant cour » (D05)** et **voie 8 « Escalier » (D08)**.
  ⚠️ La voie 8 porte déjà le détecteur « Présence Escalier » (P-D08, SmartMotionHuman) : vérifier que la reconnaissance
  faciale ne coupe pas SMD sur cette voie avant de l'activer (mise en service, lot V4, avec l'accord de l'utilisateur).

## Architecture

```
XVR ──flux d'événements──► dahua.ts ──onObservation──► presence.ts ──changements──► rules.ts ──► détecteur virtuel R-<id>
                                     └─(données visage, étape 3)──► faces.ts ───────┘              │
                                                                                  engine.handleDetectorMessage(R-<id>, {event})
                                                                                  → incident, caméras liées, images, notifications,
                                                                                    escalade, journal (tout l'existant)
```

**Une règle = un détecteur virtuel.** Chaque règle possède un équipement `R-<id>` (`kind: 'detector'`, catégorie
`access`, `heartbeat_s = 0` : non supervisé), lié (`device_link`) aux caméras de sa portée. Quand la règle se déclenche, le
moteur de règles envoie un événement nommé à ce détecteur ; quand la condition cesse, il envoie `clear`. On réutilise ainsi
tout le traitement d'alarme existant (on ne clôture pas tant que ça sonne, escalade, son, notifications, preuve).
Catégorie `access` et non `intrusion` : l'armement ne doit pas masquer une règle « toujours » ; c'est la règle qui porte
ses horaires (`when`).

### Événements ajoutés à `server/sources.ts` (lot P2)

| Événement | Effet | Motif affiché |
|---|---|---|
| `person_detected` | alarm | Présence détectée |
| `person_lingering` | alarm | Présence prolongée |
| `person_noticed` | prealarm | Présence signalée |
| `face_banned` | alarm | Personne interdite reconnue |
| `face_unknown` | alarm | Visage inconnu en zone réservée |
| `face_noticed` | prealarm | Visage signalé |

Gravité `warning` → `person_noticed` / `face_noticed` ; gravité `critical` → l'événement spécifique.

## Contrats d'interface

### `server/dahua.ts` (lot P1)

```ts
export interface DahuaEvent { code: string; action: string; channel: number; data: string | null } // data : JSON brut après « data= »
// DahuaDeps, ajouts (tous optionnels, comportement actuel inchangé s'ils sont absents) :
onObservation?: (o: { host: string; channel: number; code: string; action: string; at: number; data: string | null }) => void;
onLinkLost?: (host: string) => void;     // flux perdu : les présences de cet hôte doivent se terminer
observeAll?: () => boolean;              // vrai : ouvrir aussi un flux vers chaque hôte de camera_source dont rtsp_path
                                         // contient « channel=N » (enregistreur Dahua), même sans détecteur lié
```
Le port HTTP d'un hôte sans détecteur est 80. Une seule connexion par hôte (les liens existants sont réutilisés).

### `server/presence.ts` (lot P1, nouveau)

```ts
export const PRESENCE_CODES = ['SmartMotionHuman'] as const;
export interface PresenceChange { cameraId: string; kind: 'start' | 'stop'; at: number; source: string }
export function createPresence(deps: { db: DatabaseSync; now?: () => number; retentionDays?: number /* 30 */ }): {
  observe(o: { host: string; channel: number; code: string; action: string; at: number }): void; // (hôte, voie) -> caméra
  linkLost(host: string): void;                       // « stop » pour chaque caméra occupée de cet hôte
  occupied(cameraId: string): { since: number } | null;
  current(): Record<string, { since: number }>;
  subscribe(fn: (c: PresenceChange) => void): () => void;
  history(from: number, to: number, cameraIds?: string[]): PresenceChange[]; // trié par `at`
  purge(): number;                                    // efface au-delà de retentionDays
};
```
Table possédée par le module (`CREATE TABLE IF NOT EXISTS`, comme `devicekeys.ts`) :
`presence_event (id INTEGER PRIMARY KEY, camera_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('start','stop')), at INTEGER NOT NULL, source TEXT NOT NULL)` + index sur `at`.
Correspondance caméra : `camera_source.host` = hôte de l'observation et `rtsp_path` contient `channel=<voie>` (insensible à
la casse). Les présences brutes sont stockées telles quelles ; le lissage est fait par les règles (voir plus bas).

### `server/rules.ts` (lot P2, nouveau)

```ts
import type { Window } from './arming.ts'; // même format de plages horaires que l'armement
export type Who = { type: 'anyone' };       // étape 3 : | { type: 'list'; listId } | { type: 'person'; personId } | { type: 'unknown' }
export interface RuleSpec {
  who: Who;
  where: { cameras: string[] } | { zones: string[] };
  when: { type: 'always' } | { type: 'windows'; windows: Window[] } | { type: 'armed' };
  trigger: { type: 'appears' } | { type: 'stays'; minutes: number };   // minutes : 1..1440
  then: { severity: 'warning' | 'critical' };
  cooldownMinutes: number;                                              // 0..1440, défaut 10
}
export interface Rule {
  id: number; name: string; enabled: boolean; spec: RuleSpec; deviceId: string; summary: string;
  sourceText: string | null; createdBy: string; createdAt: number; updatedBy: string; updatedAt: number;
}
export function validateSpec(input: unknown, ctx: { cameraIds: ReadonlySet<string>; zones: ReadonlySet<string> }): RuleSpec; // PsimError(400, message FR)
export function describeRule(spec: RuleSpec, ctx: { cameraName: (id: string) => string }): string; // phrase française courante
export function createRuleMachine(spec: RuleSpec, ctx: MachineContext): RuleMachine; // PUR : sert au direct ET à l'essai sur le passé
export function createRules(deps: {
  db: DatabaseSync;
  engine: Pick<Engine, 'handleDetectorMessage' | 'audit' | 'getDevice' | 'createDevice' | 'updateDevice' | 'deleteDevice' | 'setLinks' | 'getSnapshot'>;
  presence: Pick<Presence, 'subscribe' | 'history' | 'current'>;
  isArmed: (zone: string) => boolean;
  now?: () => number;
}): {
  list(): Rule[]; get(id: number): Rule | null;
  create(actor: string, input: { name: string; spec: unknown; sourceText?: string | null; enabled?: boolean }): Rule;
  update(actor: string, id: number, input: { name?: string; spec?: unknown; enabled?: boolean }): Rule;
  remove(actor: string, id: number): void;
  tick(): void;                                               // ~1 s : durées, plages horaires, repos
  simulate(spec: unknown, from: number, to: number): { summary: string; triggers: { at: number; endedAt: number | null; cameraId: string }[] };
};
```
Table possédée : `presence_rule (id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, spec TEXT NOT NULL, device_id TEXT NOT NULL UNIQUE, source_text TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)`.

Règles de fonctionnement :
- **Lissage** : une présence continue si un `stop` est suivi d'un `start` sur une caméra de la portée en moins de **60 s**.
  La condition « quelqu'un est là » cesse 60 s après le dernier `stop` sans reprise.
- `appears` : déclenche au premier `start` dans la portée pendant une période active (`when`).
  `stays` : déclenche quand la présence lissée dure ≥ `minutes` pendant une période active.
- Fin : `clear` quand la présence lissée cesse. Puis **repos** de `cooldownMinutes` avant un nouveau déclenchement.
- `when.armed` : active si la zone de **la caméra concernée** est armée (`isArmed`).
- Détecteur virtuel : nom = nom de la règle, zone/étage/position = ceux de la première caméra de la portée, liens = caméras
  de la portée. Créé avec la règle, mis à jour avec elle, supprimé avec elle. Règle désactivée : `clear` puis plus rien.
- Journal : `rule_created`, `rule_updated`, `rule_enabled`, `rule_disabled`, `rule_deleted` ; la phrase d'origine
  (`sourceText`) est inscrite à la création.
- Ces détecteurs comptent dans l'indice de risque de leur zone (comme tout détecteur) : c'est voulu.

### API et écran (lot P3)

| Méthode | Route | Droit | Corps / réponse |
|---|---|---|---|
| GET | `/api/rules` | tout utilisateur | `Rule[]` |
| POST | `/api/rules` | admin | `{ name, spec, sourceText? }` → `Rule` |
| PUT | `/api/rules/:id` | admin | `{ name?, spec?, enabled? }` → `Rule` |
| DELETE | `/api/rules/:id` | admin | 204 |
| POST | `/api/rules/simulate` | admin | `{ spec, days }` (1..30) → `{ summary, triggers }` |
| GET | `/api/presence` | tout utilisateur | `{ [cameraId]: { since } }` |
| POST | `/api/rules/assist` | admin | (lot A2) `{ text, history? }` → proposition de l'assistant |

Écran « Règles » (menu administration) : liste des règles (phrase en français, interrupteur actif/inactif), formulaire
« 5 cases » **Qui / Où / Quand / Si / Alors**, bouton « Essayer sur les 7 derniers jours » avant d'enregistrer.
Respecter `PRODUCT.md` et `DESIGN.md` (français courant, pas de jargon, CSP stricte : aucun script ni `style` en ligne).

### Assistant IA (lot A1, puis A2)

`server/ruleassist.ts` : `createRuleAssistant({ apiKey, model?, fetch?, validate, describe, context })` →
`propose(text, history?)` renvoie `{ kind: 'rule', name, spec, summary }`, `{ kind: 'question', question }` ou
`{ kind: 'refused', reason }`. N'envoie **que des noms** (caméras, zones, listes) : jamais d'image ni d'empreinte. Sortie
imposée par schéma, revérifiée par `validate` (même validation qu'une saisie manuelle), un seul nouvel essai si invalide.
Clé absente : erreur 503 « Assistant non configuré ». Variables (câblées au lot A2) : `PSIM_ASSIST_API_KEY`,
`PSIM_ASSIST_MODEL`.

### Visages (étape 3)

`server/faces.ts` (lot V1) : lecture des parties `FaceRecognition` / `FaceDetection` (champ `data`) →
`FaceObservation { channel, at, kind: 'recognized' | 'unknown' | 'detected', personId?, personName?, groupId?, groupName?, similarity? }`
et lecture des bases de visages de l'enregistreur (`findGroup`). Le format exact des événements visage est **à confirmer
sur le vrai XVR** (lot V4) : les jeux d'essai viennent de la documentation Dahua jusque-là.

## Lots

| Lot | Contenu | Fichiers possédés | Dépend de | État |
|---|---|---|---|---|
| **P1** | Observations Dahua sur toutes les voies, présences | `server/dahua.ts`, `server/presence.ts`, `test/presence.test.ts`, `test/dahua.test.ts` | — | **fait** (36dfa1c) |
| **P2** | Moteur de règles, détecteurs virtuels, essai sur le passé, nouveaux événements | `server/rules.ts`, `server/sources.ts`, `test/presencerules.test.ts`, `test/sources.test.ts` | contrat P1 | **fait** (36dfa1c) |
| **P3** | Branchement, API, écran « Règles » | `server/main.ts`, `server/api.ts`, `web/rules.js`, `web/rules.css`, `web/index.html`, `web/app.js`, `web/icons.svg`, `test/e2e-rules.test.ts` | P1, P2 | **fait** (36dfa1c) |
| **A1** | Assistant IA (cœur, sans branchement) | `server/ruleassist.ts`, `test/ruleassist.test.ts` | contrat P2 | **fait** (1592eed) |
| **A2** | Assistant dans l'API et l'écran, configuration | `server/config.ts`, `.env.example`, `server/api.ts`, `server/main.ts`, `web/rules.js` | P3, A1 | **fait** (437c35a) |
| **V1** | Lecture des événements et bases visage Dahua | `server/faces.ts`, `test/faces.test.ts`, `test/fixtures/dahua-face-*` | — | **fait** (98774b4) |
| **V2** | Mise en service visages : procédure, essai de fiabilité, information du personnel | `docs/VISAGES.md` | — | **fait** (98774b4) |
| **V3** | Règles d'identité (`who` : liste, personne, inconnu), écran des listes | `server/rules.ts`, `server/presence.ts`, `web/rules.js`, … | P3, V1 | **fait** (437c35a) |
| **V4** | Sur le vrai XVR : activer la reconnaissance voies 5 et 8, créer les bases, enregistrer, mesurer | (matériel) | V1, V2 | **avec l'accord de l'utilisateur, par le chef** |

Règles communes : un fichier n'appartient qu'à un lot actif à la fois ; personne ne touche `data-prod/`, le PSIM de
production, ni le vrai enregistreur (sauf V4, par le chef) ; tests ciblés + `npm run typecheck` avant chaque commit ;
commits sur la branche du lot uniquement, jamais sur `main` (c'est le chef qui fusionne).

## Décisions de l'utilisateur (16 octobre 2026)

- **Conflit reconnaissance faciale / détection de personne** : « AI Mode » Face exclut SMD et IVS&SMD sur ce XVR, et on ne sait
  pas si le réglage est par voie ou global. Si l'essai V4 montre que la reconnaissance coupe la détection de personne, on
  **ajoute une caméra IP Dahua à reconnaissance faciale embarquée** (ses événements sont lus directement, comme le XVR)
  plutôt que de perdre la présence.
- **Cadre légal** : **essai familial seulement** (membres de la famille consentants ; ni personnel, ni liste « Interdits »)
  en attendant un avis sur la loi n° 2013-450 (art. 7, autorisation préalable de l'ARTCI). Voir `docs/VISAGES.md`.
- **Gravité** : les règles visage sont en **signalement (pré-alarme)** tant que l'essai de fiabilité n'est pas concluant.

## Écarts acceptés à la fusion des lots P

`rules.close()` ; identifiant de règle = max(règles, `R-n`) + 1 ; une règle qui a déclenché des incidents ne se supprime
pas (409, l'écran propose « Désactiver ») ; `when.armed` simulé avec l'armement actuel (`armedNote`) ; repos non mémorisé
entre deux démarrages ; purge de présence au démarrage puis toutes les 6 h ; `DELETE /api/devices/:id` d'un détecteur de
règle → 409 ; `days` entier 1..30. Ouverts : le 409 est reconnu à l'écran par son message (exposer le statut HTTP dans
`web/core.js` serait plus sûr) ; un enregistreur sans détecteur lié est observé sur le port 80 seulement.

## Lot V4 — constat sur le XVR (16 octobre 2026) et caméra visage dédiée

Constaté dans l'interface web du XVR (lecture seule, rien modifié) : *Mode AI* est **global à l'enregistreur** (valeur *SMD*,
menu grisé tant que l'amélioration de l'encodage est active). Passer en reconnaissance faciale couperait la détection de
personne sur les 8 voies. Conformément à la décision de l'utilisateur, **l'enregistreur reste en SMD** et la reconnaissance
faciale passe par une **caméra IP Dahua à reconnaissance faciale embarquée** (base de visages dans la caméra) :

- Elle est branchée **sur le réseau**, et **pas** ajoutée à l'enregistreur comme voie IP (la fiche du XVR : avec des voies IP,
  les fonctions IA avancées sont désactivées). Son enregistrement vidéo se fait sur sa carte mémoire.
- Le PSIM la déclare comme une caméra ordinaire (`camera_source` : son adresse, `rtsp_path` contenant `channel=1`) : le flux
  d'événements de `dahua.ts` s'y connecte comme à un enregistreur (`observeAll`), `faces.ts`/`faceobs.ts` lisent ses
  `FaceRecognition`, et les bases se lisent par `findGroup` sur la caméra elle-même. Aucun nouveau code n'est prévu ;
  à qualifier avec le vrai matériel (format des événements, `findGroup`).
- Choix du modèle : une caméra de la gamme Dahua à reconnaissance faciale embarquée (base de visages dans la caméra),
  placée au point de passage (portail ou entrée), à hauteur de visage, 2 à 4 m ; référence exacte à confirmer avec le
  fournisseur et à inscrire au registre de qualification. Essai familial seulement (décision du 16 octobre).

## Lots A2 et V3 fusionnés (437c35a, 16 octobre 2026)

Assistant IA dans l'écran « Règles » (`GET/POST /api/rules/assist`, 20 propositions/heure/administrateur, journal
`rule_assist` sans le texte) ; règles d'identité (`who` : liste, personne, inconnu ; `appears` seulement ; retour au calme
60 s après la dernière observation ; signalement par défaut) ; observations visage `server/faceobs.ts` (sans photo, 30 jours) ;
`GET /api/faces/lists` (bases lues sur toutes les caméras Dahua), `GET /api/faces/recent`. Réglages : `PSIM_ASSIST_API_KEY`,
`PSIM_ASSIST_MODEL`, `PSIM_ASSIST_API_URL` (essais seulement : https partout, http seulement vers cette machine).

Points ouverts : deux caméras peuvent numéroter leurs listes pareil (`who.listId` seul se confondrait : ajouter la caméra
source à la règle si une deuxième caméra visage arrive) ; doublon Start/Pulse dédoublonné seulement à heure identique (à
vérifier sur la vraie caméra) ; `scripts/check-config.ts` ne contrôle pas encore `PSIM_ASSIST_*` ; le texte d'accueil de
`web/index.html` ne parle pas des visages ; le 409 de suppression reconnu par son message à l'écran.
Reste : **la caméra visage** (achat, pose, qualification : format réel de `FaceRecognition` et de `findGroup`), puis l'essai
familial décrit dans `docs/VISAGES.md`.
