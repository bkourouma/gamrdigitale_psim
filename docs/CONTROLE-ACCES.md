# Contrat commun — chantier « Contrôle d'accès »

Rédigé le 17 octobre 2026 par le chef de projet. Référence : `docs/PRD-CONTROLE-ACCES.md` (le PRD), `docs/COMMANDES.md`
(branche `commandes-actionneurs`, canal de commande signé), `docs/PASSERELLE.md`, `PRODUCT.md`.
Ce document **fige** ce que plusieurs lots partagent. Le modifier = décision du chef. Tout le reste est laissé aux
superviseurs.

## 1. Décisions du chef

1. Une **porte** (ou barrière, portail, tourniquet) = un **détecteur** PSIM de catégorie `access` (table `device`
   existante). Le contrôleur et le numéro de porte sont des attributs (table `access_door`, § 4).
2. Les passages arrivent par le **même chemin** que les autres messages d'équipements : topic
   `psim/detectors/<doorId>/state` (ou `POST /api/ingest/<doorId>`), avec `ts`, `msgId` et un champ **`access`** (§ 2).
   Déduplication, file disque, renvoi après coupure, contrôle des droits MQTT : tout l'existant s'applique.
3. Le contrôleur décide ; le PSIM ne prend **jamais** part à l'ouverture d'une porte par badge.
4. Ouverture à distance : **uniquement** par le canal de commande signé (`docs/COMMANDES.md`). Une porte peut être liée à
   un actionneur `lock` ou `gate` (`access_door.actuator_id`). Le pilote côté passerelle (lot AC0) appelle le module
   d'accès par l'interface du § 3.
5. Identifiants des contrôleurs : en phase 1 ils vivent dans la **configuration de la passerelle** (comme les autres
   modules). Le PSIM peut en garder une copie **scellée** (`server/secrets.ts`) pour la phase 2, jamais renvoyée au
   navigateur ni journalisée.
6. L'escalade « porte maintenue ouverte » (pré-alarme → alarme après N secondes, réglable par porte) est faite **par le
   PSIM** (la configuration est dans `access_door`). Elle ne doit jamais rajeunir `last_seen` (une porte muette doit
   pouvoir passer hors ligne).
7. Le comptage des refus (`badge_denied_repeated`) est fait **par le module de passerelle** (X refus en Y secondes sur une
   porte ; défaut 3 refus en 60 s, réglable dans la configuration du module).
8. Conservation du journal des passages : **90 jours** par défaut (réglable), purge automatique journalisée.
9. Marque prioritaire : **Dahua** (AC1), puis **ZKTeco** (AC6). Les deux sont développées avec un faux contrôleur ;
   aucune n'est « qualifiée » sans essai sur matériel réel (registre `qualification/`).

## 2. Message de passage (passerelle → PSIM)

Événements d'état de porte (déjà connus de `server/sources.ts`, sauf `clock_drift`, ajouté par le lot AC1) :

| Situation | Message |
|---|---|
| Porte ouverte / refermée | `{"event":"door_opened"}` / `{"event":"door_closed"}` |
| Porte forcée | `{"event":"door_forced"}` (alarme) |
| Porte maintenue ouverte | `{"event":"door_held_open"}` (pré-alarme ; le PSIM escalade, § 1.6) |
| Refus répétés | `{"event":"badge_denied_repeated"}` (pré-alarme) |
| Sabotage lecteur / contrôleur | `{"event":"tamper"}` (alarme toujours active) |
| Contrôleur injoignable | `{"state":"offline"}` pour chacune de ses portes (jamais « fermée » à tort) |
| Horloge du contrôleur à plus de 2 min | `{"event":"clock_drift"}` (défaut, libellé « Horloge de l'équipement déréglée ») |
| Signe de vie, contrôleur joignable | `{"event":"heartbeat"}` par porte, toutes les 60 s par défaut |

**Passage** (badge, code, empreinte, visage, bouton de sortie, ouverture à distance) : un message par passage,
`event` = `badge_granted` si accepté, `badge_denied` sinon, quelle que soit la méthode :

```json
{"event":"badge_granted","ts":1760000000000,"msgId":"acc:CTL-1:123456",
 "access":{"v":1,"controllerId":"CTL-1","eventId":"123456","direction":"in","credential":"0012345",
           "holderName":"KONAN Yao","holderRef":"101","method":"badge","result":"granted","reason":null,"deferred":false}}
```

| Champ | Format | Sens |
|---|---|---|
| `ts` | entier ms | **Heure du contrôleur** à l'événement (obligatoire pour un passage) |
| `msgId` | `acc:<controllerId>:<eventId>` (≤ 64 car., alphabet de `MSG_ID_PATTERN`) | Déduplication du socle |
| `access.v` | `1` | Version |
| `access.controllerId` | `^[A-Za-z0-9_-]{1,32}$` | Identifiant PSIM du contrôleur (`access_controller.id`) |
| `access.eventId` | `^[A-Za-z0-9._:-]{1,40}$` | Identifiant de l'événement **dans le contrôleur** (n° d'enregistrement) ; unique par contrôleur |
| `access.direction` | `in` \| `out` \| `null` | Sens si connu |
| `access.credential` | chaîne ≤ 32 car. ou `null` | Numéro de badge, ou `null` (bouton, ouverture à distance) ; jamais un code PIN |
| `access.holderName` | chaîne ≤ 64 car. ou `null` | Nom connu du contrôleur |
| `access.holderRef` | chaîne ≤ 32 car. ou `null` | Identifiant du titulaire dans le contrôleur |
| `access.method` | `badge` \| `code` \| `fingerprint` \| `face` \| `exit_button` \| `remote` \| `unknown` | |
| `access.result` | `granted` \| `denied` | |
| `access.reason` | `null` \| `unknown_credential` \| `expired` \| `out_of_schedule` \| `disabled` \| `wrong_pin` \| `antipassback` \| `door_locked` \| `other` | Motif du refus |
| `access.deferred` | booléen | `true` si récupéré dans la mémoire du contrôleur après une coupure (F8) |

Le message complet tient sous **1 024 octets** (limite du broker) : le module tronque `holderName` si besoin. Jamais de
gabarit biométrique, jamais de code PIN.

Côté PSIM : passage reçu « en différé » (`late = 1`) si `deferred` est vrai ou si le retard dépasse `LATE_AFTER_MS`.
Déduplication définitive par l'index unique `(controller_id, device_event_id)` (la mémoire `msgId` du socle est bornée).

## 3. Interface module ↔ pilote de commandes (passerelle)

Ajout à `gateway/src/module.ts` **par le lot AC0** (seul propriétaire de `ModuleContext`) :

```ts
/** Ordre deja verifie par le socle (signature, fraicheur, anti-rejeu, plafonds locaux). */
export interface ActuatorRequest {
  actuatorId: string;
  cmdId: string;
  action: string;          // ex. 'unlock', 'lock', 'open', 'close', 'stop'
  durationS?: number;      // present pour une action temporisee
  clip?: string;
}
export interface ActuatorOutcome { result: 'done' | 'refused' | 'error'; code?: string }
export type ActuatorHandler = (req: ActuatorRequest) => Promise<ActuatorOutcome>;

// dans ModuleContext :
  /** Le module pilote l'actionneur `actuatorId` declare dans la configuration de la passerelle. */
  onActuator(actuatorId: string, handler: ActuatorHandler): void;
```

Le **socle** garde la vérification, les plafonds locaux (configuration de la passerelle, section `actuators`), le refus
de `lock` sur une issue de secours, le retour local au repos à la fin de `durationS` et l'accusé signé. Le **module** ne
fait qu'exécuter l'action sur son équipement et dire si elle a réussi.

Tant que AC0 n'est pas fusionné, les modules d'accès (AC1, AC6) écrivent leur gestionnaire et l'enregistrent par un type
local structurel (`ctx as ModuleContext & { onActuator?: ... }`, appel `?.`), testé directement ; le chef nettoie à la
fusion.

Ajout à `gateway/src/module.ts` **par le lot AC1** : le type du champ `access` de `DeviceMessage` (§ 2).

## 4. Modèle de données PSIM (lot AC2)

- `access_controller` : `id` (PK), `name`, `brand` (`dahua` | `zkteco` | `relay`), `model`, `host`, `gateway_id`,
  `credentials_sealed` (nullable), `clock_offset_ms`, `last_seen`, dates et auteurs.
- `access_door` : `detector_id` (PK = `device.id`, catégorie `access`), `controller_id`, `door_no` (1 à 4), `kind`
  (`door` | `gate` | `barrier` | `turnstile`), `emergency_exit` (0/1), `held_alarm_after_s` (défaut 300),
  `actuator_id` (nullable, lot AC4), `door_state` (`closed` | `open` | `unknown`), `door_state_at`, `last_passage_at`.
- `access_event` : `id`, `door_id`, `controller_id`, `at_device`, `at_received`, `direction`, `credential`,
  `holder_name`, `holder_ref`, `holder_id` (nullable, phase 2), `method`, `result`, `reason`, `device_event_id`, `late`.
  Index unique `(controller_id, device_event_id)` ; index `(at_device)`, `(door_id, at_device)`, `(credential, at_device)`.
- Migrations : `CREATE TABLE IF NOT EXISTS` / index uniquement, comme `docs/COMMANDES.md` § 4.

État affiché d'une porte (F2), par priorité : `hors ligne` (détecteur offline) > `en défaut` > `forcée` >
`maintenue ouverte` > `ouverte` > `fermée` (> `inconnu` tant qu'aucun message).

Données personnelles : numéros de badge et noms visibles des seuls rôles connectés opérateur et administrateur (jamais
du portail) ; toute recherche par titulaire ou badge et tout export CSV sont journalisés (`auditchain`).

## 5. Lots, branches et propriété des fichiers

| Vague | Superviseur | Lots | Branche (worktree `.claude/worktrees/<branche>`) |
|---|---|---|---|
| 1 | Canal de commande | AC0 | `acces-ac0` (part de `commandes-actionneurs`, fusionne `main`) |
| 1 | Passerelle accès | AC1 + AC6 | `acces-passerelle` |
| 1 | Journal et écran | AC2 + AC3 | `acces-journal` |
| 2 | (après fusion des trois) | AC4 ouverture à distance + essai bout en bout réel | à définir |
| 2 | (si validé par l'utilisateur) | AC5 titulaires, groupes, visiteurs, synchronisation, F14, F19, F20, F27, F28 | à définir |
| 3 | (si validé par l'utilisateur) | AC7 règles d'accès, badge + visage | à définir |

Fichiers **partagés entre branches** (modifications minimales et additives, le code neuf va dans des fichiers neufs ;
le chef résout les conflits à la fusion) :

| Fichier | Qui y touche |
|---|---|
| `gateway/src/module.ts` | AC0 (`ModuleContext.onActuator` et types du § 3), AC1 (`DeviceMessage.access`) |
| `gateway/src/validate.ts`, `server/sources.ts` | AC1 seulement |
| `gateway/src/runtime.ts`, `gateway/src/config.ts`, `gateway/src/psimlink.ts`, `server/mqtt.ts` | AC0 (AC1 seulement si un module doit être déclaré : une ligne) |
| `server/engine.ts`, `server/db.ts`, `server/api.ts`, `server/main.ts`, `server/config.ts`, `server/types.ts` | AC0 (fusion) et AC2 (un point d'accroche chacun, au plus quelques lignes) |
| `web/index.html`, `web/app.js`, `web/core.js`, `web/incidents.js`, `web/plan.js` | AC0 (fusion) et AC3 (ajouts) |
| `.env.example` | AC0, AC2 — ne jamais toucher les `.env*` réels |

Le dépôt principal contient des modifications **non commitées** d'une autre session (téléphone Android : `.env.example`,
`server/config.ts`, `server/main.ts`, `server/notifications.ts`, `test/phonegateway.test.ts`). Personne n'y touche ; le
chef les met de côté puis les réapplique à chaque fusion.

## 6. Règles communes

- Superviseur : découpe, confie à `executant` (simple) ou `executant-expert` (complexe), exceptionnellement à
  `executant-expert` avec `model: "opus"` pour la tâche la plus difficile (sécurité, concurrence). Deux agents ne
  modifient jamais le même fichier en même temps.
- Tests `node:test`, horloge injectée. Avant de rendre : `npm run typecheck` propre, tests ciblés verts, puis
  `npm test` complet une fois (signaler les instabilités connues de `docs/HANDOFF-catalogue.md`).
- Commits sur la branche du lot seulement, message en français terminé par
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Jamais sur `main`, jamais de `git push`, jamais de
  `git worktree remove`, ne jamais supprimer la jonction `node_modules`.
- Interdits : `data-prod/`, `data/`, `.env*` réels, PSIM de production, vrai enregistreur Dahua (192.168.1.13), ports
  3034, 3044-3046, 4301-4302. Navigateur intégré partagé : toujours cibler son propre `tabId`.
- Compte rendu au chef : fait, commits, tests (chiffres), écarts au contrat, points ouverts, **questions métier** (le chef
  les pose à l'utilisateur ; ne pas bloquer dessus : prendre l'hypothèse la plus prudente et la signaler).
