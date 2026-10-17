/**
 * Application d'un pack a une base du PSIM : TOUT OU RIEN, en une seule transaction (point de sauvegarde SQLite).
 *
 * Chaque element passe par la fonction du PSIM qui le gere depuis l'interface (moteur, etages, sources video, Dahua,
 * Tuya, supervision reseau, armement, risque, destinataires) : memes controles, meme journal scelle, memes regles de
 * supervision. Ces fonctions ouvrent parfois leur propre transaction (BEGIN) : `nestable` les transforme en points de
 * sauvegarde imbriques, si bien qu'un echec n'importe ou annule l'ensemble, y compris les entrees du journal.
 *
 * Pour chaque element du pack : absent -> cree ; present et identique -> rien (« deja conforme ») ; present et different ->
 * CONFLIT. Par defaut un conflit fait tout refuser (rien n'est ecrase) ; `update` remplace par la valeur du pack ;
 * `keep` garde l'existant et applique le reste. Les elements du site absents du pack ne sont jamais touches.
 *
 * Simulation (`dryRun`) : le meme deroulement, puis retour en arriere systematique. Les valeurs a saisir encore inconnues
 * sont remplacees par des valeurs fictives valides (jamais comparees a l'existant).
 *
 * Plans d'etage : fichiers NOUVEAUX (`plan-<etage>-<version>`), ecrits juste avant la validation (fichier temporaire puis
 * renommage) et supprimes si la transaction echoue ; les anciens plans ne sont supprimes qu'apres la validation. La base
 * ne reference donc jamais un fichier absent, et un echec ne laisse aucun fichier.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createArming } from '../../server/arming.ts';
import { createDahuaEvents } from '../../server/dahua.ts';
import { createEngine } from '../../server/engine.ts';
import { createFloors, DEFAULT_FLOOR_NAME, listFloors, PLAN_FILE_PATTERN } from '../../server/floors.ts';
import { createNetworkTargets } from '../../server/networkhealth.ts';
import { createRecipientsService, maskAddress } from '../../server/recipients.ts';
import type { ChannelId } from '../../server/recipients.ts';
import { createRiskService } from '../../server/risk.ts';
import { unseal } from '../../server/secrets.ts';
import { createTuya } from '../../server/tuya.ts';
import type { TuyaClient } from '../../server/tuya.ts';
import { createVideoService } from '../../server/video.ts';
import { markerKey, resolveValue } from './load.ts';
import type { Answers, PlanFile } from './load.ts';
import type { CameraSource, DetectorSource, Pack, Value, ValueKind } from './schema.ts';

export type Section = 'etage' | 'plan' | 'equipement' | 'source' | 'liens' | 'armement' | 'risque' | 'destinataire';
export type Action = 'create' | 'update' | 'same' | 'conflict' | 'skip';

export interface Item {
  section: Section;
  ref: string;
  action: Action;
  detail: string;
}

export interface Report {
  items: Item[];
  warnings: string[];
  /** Raison de l'echec (rien n'a ete applique), ou null. */
  error: string | null;
  /** Vrai seulement si la transaction a ete validee. */
  committed: boolean;
  summary: string;
}

export type Mode = 'strict' | 'update' | 'keep';

export interface ApplyOptions {
  /** Dossier des donnees du PSIM : plans d'etage (lus pour comparer, ecrits a l'application). */
  dataDir: string;
  mode: Mode;
  dryRun: boolean;
  answers: Answers;
  /** Cle de chiffrement des identifiants des cameras (celle du PSIM pour une vraie application). */
  key: Buffer;
  /** Faux : la cle n'est pas celle du PSIM, les mots de passe deja enregistres ne sont pas compares. */
  keyIsReal: boolean;
  plans: Map<string, PlanFile>;
  /** Canaux de notification configures (on n'ajoute de destinataire qu'a ceux-la, comme dans l'interface). */
  channels: Record<ChannelId, boolean>;
  envRecipients?: Record<ChannelId, string[][]>;
  /** Auteur dans le journal (« console » comme les autres outils), et installateur cite dans l'entree `pack_applique`. */
  actor?: string;
  by?: string | null;
  sha256?: string;
  /** Nombre de modeles a qualifier acceptes (--allow-unqualified), cite au journal. */
  unqualified?: number;
  now?: () => number;
  /** Essais uniquement : appele juste avant la validation (simuler une panne au dernier moment). */
  beforeCommit?: () => void;
}

/** Table des equipements poses par un pack : modele catalogue et statut, pour l'export et la recette. */
export const PACK_DEVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pack_device (
  device_id TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  model TEXT NOT NULL,
  qualification TEXT NOT NULL
);
`;

/**
 * Vue de la base ou BEGIN / COMMIT / ROLLBACK deviennent des points de sauvegarde imbriques : les fonctions du PSIM qui
 * ouvrent leur propre transaction s'executent ainsi DANS celle du pack (SQLite refuse une transaction dans une autre).
 */
export function nestable(db: DatabaseSync): DatabaseSync {
  const stack: string[] = [];
  let n = 0;
  const exec = (sql: string): void => {
    const s = sql.trim().replace(/;\s*$/, '').trim().toUpperCase();
    if (/^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?$/.test(s)) {
      const name = `pack_inner_${++n}`;
      stack.push(name);
      return db.exec(`SAVEPOINT ${name}`);
    }
    if (/^(COMMIT|END)(\s+TRANSACTION)?$/.test(s) && stack.length) return db.exec(`RELEASE ${stack.pop()}`);
    if (/^ROLLBACK(\s+TRANSACTION)?$/.test(s) && stack.length) {
      const name = stack.pop();
      return db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    }
    return db.exec(sql);
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') return exec;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const fold = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('fr');
const show = (v: unknown): string => (v === null || v === undefined ? 'aucun' : typeof v === 'string' ? `« ${v} »` : JSON.stringify(v));
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Valeur fictive mais valide, pour simuler sans reponse (jamais comparee a l'existant). */
function placeholder(kind: ValueKind, n: number): string {
  const k = String(n).padStart(4, '0');
  switch (kind) {
    case 'host':
      return `192.0.2.${(n % 250) + 1}`;
    case 'username':
      return 'utilisateur';
    case 'password':
      return 'mot-de-passe-fictif';
    case 'tuyaId':
      return `packfictif${k}`;
    case 'address:email':
      return `destinataire-${k}@exemple.invalid`;
    case 'address:telegram':
      return `-100000${k}`;
    case 'address:whatsapp':
      return `+22500000${k}`;
    case 'address:webhook':
      return `https://exemple.invalid/pack/${k}`;
  }
}

class ConflictRefusal extends Error {}

export function applyPack(db: DatabaseSync, pack: Pack, opts: ApplyOptions): Report {
  const now = opts.now ?? Date.now;
  const actor = opts.actor ?? 'console';
  const items: Item[] = [];
  const warnings: string[] = [];
  const fatal: string[] = [];
  const written: string[] = [];
  const add = (section: Section, ref: string, action: Action, detail: string) => items.push({ section, ref, action, detail });
  const placeholders = new Map<string, string>();

  /** Valeur effective ; `known` faux = valeur fictive (simulation sans reponse). */
  const value = (v: Value, kind: ValueKind): { value: string; known: boolean } => {
    const resolved = resolveValue(v, opts.answers);
    if (resolved !== null) return { value: resolved, known: true };
    if (!opts.dryRun) throw new Error(`valeur a fournir manquante : « ${typeof v === 'string' ? v : markerKey(v)} »`);
    const key = typeof v === 'string' ? v : markerKey(v);
    if (!placeholders.has(key)) placeholders.set(key, placeholder(kind, placeholders.size + 1));
    return { value: placeholders.get(key)!, known: false };
  };
  const label = (v: Value, r: { value: string; known: boolean }) => (r.known ? r.value : `<a saisir : ${typeof v === 'string' ? v : markerKey(v)}>`);

  const tx = nestable(db);
  db.exec('SAVEPOINT pack_apply');
  let committed = false;
  let error: string | null = null;
  try {
    const engine = createEngine(tx, () => {}, now);
    const noop = () => {};
    const floors = createFloors({ db: tx, dataDir: opts.dataDir, audit: engine.audit, publishConfig: noop });
    const video = createVideoService({ db: tx, engine, key: opts.key, publish: noop });
    // Services de lecture : arretes avant usage, ils n'ouvrent aucune connexion (rien ne part sur le reseau).
    const dahua = createDahuaEvents({ db: tx, engine, key: opts.key, log: noop, open: () => { throw new Error('aucune connexion pendant un pack'); } });
    dahua.stop();
    // Client Tuya jamais appele (service arrete) : le compte Tuya n'est pas necessaire pour enregistrer la source.
    const tuya = createTuya({ db: tx, engine, account: null, client: {} as TuyaClient, pollS: 60, log: noop });
    tuya.stop();
    const targets = createNetworkTargets({ db: tx, audit: engine.audit, now });
    const arming = createArming(tx, engine.audit, now);
    const risk = createRiskService(tx, engine, { now });
    const recipients = createRecipientsService({
      db: tx, audit: engine.audit, now, available: { ...opts.channels, callmebot: false },
      env: opts.envRecipients ?? { email: [[], []], telegram: [[], []], whatsapp: [[], []], callmebot: [[], []], vonage: [[], []], webhook: [[], []] },
    });
    const conflict = (section: Section, ref: string, diffs: string[]): boolean => {
      // Vrai = il faut appliquer la valeur du pack (mode update).
      if (opts.mode === 'update') {
        add(section, ref, 'update', diffs.join(' ; '));
        return true;
      }
      add(section, ref, 'conflict', `${diffs.join(' ; ')}${opts.mode === 'keep' ? ' (existant conserve)' : ''}`);
      return false;
    };

    // ---- 1. Etages
    const floorId = new Map<string, number>();
    const existingFloors = listFloors(tx);
    const devicesOn = (id: number) => (tx.prepare('SELECT COUNT(*) AS n FROM device WHERE floor_id = ?').get(id) as { n: number }).n;
    if (
      existingFloors.length === 1 && existingFloors[0].name === DEFAULT_FLOOR_NAME && !existingFloors[0].hasPlan && devicesOn(existingFloors[0].id) === 0 &&
      !pack.floors.some((f) => fold(f.name) === fold(DEFAULT_FLOOR_NAME))
    ) {
      // Base neuve : l'etage cree d'office prend le nom du premier etage du pack (au lieu d'un etage vide en plus).
      floors.update(actor, existingFloors[0].id, { name: pack.floors[0].name });
      add('etage', pack.floors[0].name, 'update', `etage par defaut « ${DEFAULT_FLOOR_NAME} » (vide) renomme`);
      floorId.set(pack.floors[0].id, existingFloors[0].id);
    }
    for (const f of pack.floors) {
      if (floorId.has(f.id)) continue;
      const match = listFloors(tx).find((x) => fold(x.name) === fold(f.name));
      if (match) {
        floorId.set(f.id, match.id);
        add('etage', f.name, 'same', 'existe deja');
      } else {
        floorId.set(f.id, floors.create(actor, { name: f.name }).id);
        add('etage', f.name, 'create', '');
      }
    }

    // ---- 2. Plans d'etage (fichiers ecrits juste avant la validation)
    const pendingPlans: { file: string; body: Buffer }[] = [];
    for (const f of pack.floors) {
      const plan = opts.plans.get(f.id);
      if (!plan) continue;
      const id = floorId.get(f.id)!;
      const row = tx.prepare('SELECT plan_file, plan_version FROM floor WHERE id = ?').get(id) as { plan_file: string | null; plan_version: number };
      let apply = true;
      if (row.plan_file) {
        const current = resolve(opts.dataDir, row.plan_file);
        const same = PLAN_FILE_PATTERN.test(row.plan_file) && existsSync(current) && readFileSync(current).equals(plan.body);
        if (same) {
          add('plan', f.name, 'same', 'plan identique');
          apply = false;
        } else apply = conflict('plan', f.name, ['plan different de celui du pack']);
      } else add('plan', f.name, 'create', `${(plan.body.length / 1024).toFixed(0)} Ko`);
      if (!apply) continue;
      const version = row.plan_version + 1;
      const file = `plan-${id}-${version}.${plan.ext}`;
      tx.prepare('UPDATE floor SET plan_file = ?, plan_version = ? WHERE id = ?').run(file, version, id);
      engine.audit(actor, 'plan_updated', { details: `${f.name} - ${(plan.body.length / 1024).toFixed(0)} Ko (pack ${pack.id})` });
      pendingPlans.push({ file, body: plan.body });
    }

    // ---- 3. Equipements
    tx.exec(PACK_DEVICE_SCHEMA);
    const kept = new Set<string>(); // equipements en conflit conserves : ni leur source, ni leurs liens ne sont touches
    for (const d of pack.devices) {
      const fid = floorId.get(d.floor)!;
      const settings = d.kind === 'detector' ? { category: d.category, valueUnit: d.unit, warnAt: d.warnAt, alarmAt: d.alarmAt, direction: d.direction, heartbeatS: d.heartbeatS } : {};
      const current = engine.getDevice(d.id);
      if (!current) {
        engine.createDevice(actor, { id: d.id, kind: d.kind, name: d.name, zone: d.zone, x: d.x, y: d.y, floorId: fid, ...settings });
        add('equipement', d.id, 'create', `${d.kind === 'camera' ? 'camera' : `detecteur ${d.category}`} « ${d.name} »${d.zone ? `, zone ${d.zone}` : ''} ; modele ${d.model}${d.qualification === 'qualified' ? '' : ' (a qualifier)'}`);
      } else if (current.kind !== d.kind) {
        fatal.push(`equipement ${d.id} : c'est un(e) ${current.kind === 'camera' ? 'camera' : 'detecteur'} dans le PSIM, ${d.kind === 'camera' ? 'une camera' : 'un detecteur'} dans le pack (changer l'identifiant dans le pack)`);
        add('equipement', d.id, 'conflict', 'type different (camera / detecteur) : irreconciliable');
        kept.add(d.id);
        continue;
      } else {
        const diffs: string[] = [];
        const cmp = (field: string, a: unknown, b: unknown) => {
          if (a !== b) diffs.push(`${field} ${show(a)} -> ${show(b)}`);
        };
        cmp('nom', current.name, d.name);
        cmp('zone', current.zone, d.zone);
        cmp('x', current.x, d.x);
        cmp('y', current.y, d.y);
        if (current.floorId !== fid) diffs.push(`etage -> « ${pack.floors.find((f) => f.id === d.floor)!.name} »`);
        if (d.kind === 'detector') {
          cmp('categorie', current.category, d.category);
          cmp('unite', current.valueUnit, d.unit);
          cmp('prealarme', current.warnAt, d.warnAt);
          cmp('alarme', current.alarmAt, d.alarmAt);
          cmp('sens', current.direction, d.direction);
          cmp('supervision (s)', current.heartbeatS, d.heartbeatS);
        }
        if (diffs.length === 0) add('equipement', d.id, 'same', 'configuration identique');
        else if (conflict('equipement', d.id, diffs)) engine.updateDevice(actor, d.id, { name: d.name, zone: d.zone, x: d.x, y: d.y, floorId: fid, ...settings });
        else {
          kept.add(d.id);
          continue;
        }
      }
      tx.prepare(
        `INSERT INTO pack_device (device_id, pack_id, pack_version, model, qualification) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET pack_id = excluded.pack_id, pack_version = excluded.pack_version, model = excluded.model, qualification = excluded.qualification
         WHERE pack_id <> excluded.pack_id OR pack_version <> excluded.pack_version OR model <> excluded.model OR qualification <> excluded.qualification`,
      ).run(d.id, pack.id, pack.version, d.model, d.qualification);
    }

    // Type d'equipement irreconciliable : inutile d'aller plus loin (les sources et liens en dependent).
    if (fatal.length) throw new Error(fatal.join(' ; '));

    // ---- 4. Sources des cameras (avant celles des detecteurs : un detecteur Dahua lit les identifiants de sa camera)
    for (const d of pack.devices) {
      if (d.kind !== 'camera' || !d.source || kept.has(d.id)) continue;
      const s = d.source as CameraSource;
      const host = value(s.host, 'host');
      const user = s.credentials ? value(s.credentials.username, 'username') : null;
      const pass = s.credentials ? value(s.credentials.password, 'password') : null;
      const row = tx.prepare('SELECT * FROM camera_source WHERE device_id = ?').get(d.id) as Record<string, unknown> | undefined;
      const describe = `${s.type} ${label(s.host, host)}:${s.port}${s.credentials ? ', avec identifiants' : ''}`;
      const input = { kind: s.type, host: host.value, port: s.port, rtspPath: s.path, username: user?.value ?? null, password: pass?.value ?? null, aspect: s.aspect };
      if (!row) {
        video.setSource(actor, d.id, input);
        add('source', d.id, 'create', describe);
        continue;
      }
      const diffs: string[] = [];
      if (row.kind !== s.type) diffs.push(`type ${show(row.kind)} -> ${show(s.type)}`);
      if (host.known && row.host !== host.value) diffs.push(`adresse ${show(row.host)} -> ${show(host.value)}`);
      if (row.port !== s.port) diffs.push(`port ${row.port} -> ${s.port}`);
      if ((row.rtsp_path ?? null) !== s.path) diffs.push(`chemin ${show(row.rtsp_path)} -> ${show(s.path)}`);
      if (row.aspect !== s.aspect) diffs.push(`format ${show(row.aspect)} -> ${show(s.aspect)}`);
      if (user && user.known && row.username !== user.value) diffs.push('identifiant different');
      if (!s.credentials && row.username) diffs.push('identifiants enregistres, absents du pack');
      if (pass && pass.known) {
        if (!row.secret) diffs.push('mot de passe absent');
        else if (opts.keyIsReal) {
          let same = false;
          try {
            same = unseal(opts.key, row.secret as string) === pass.value;
          } catch {
            same = false;
          }
          if (!same) diffs.push('mot de passe different');
        }
      }
      const partial = !host.known || (pass !== null && (!pass.known || !opts.keyIsReal));
      if (diffs.length === 0) add('source', d.id, 'same', `${describe}${partial ? ' (valeurs a saisir ou mot de passe non compares)' : ''}`);
      else if (conflict('source', d.id, diffs)) video.setSource(actor, d.id, input);
    }

    // ---- 5. Sources des detecteurs (Dahua, Tuya, supervision reseau)
    for (const d of pack.devices) {
      if (d.kind !== 'detector' || !d.source || kept.has(d.id)) continue;
      const s = d.source as DetectorSource;
      const rows = {
        dahua: tx.prepare('SELECT * FROM detector_source WHERE device_id = ?').get(d.id) as Record<string, unknown> | undefined,
        tuya: tx.prepare('SELECT * FROM tuya_source WHERE device_id = ?').get(d.id) as Record<string, unknown> | undefined,
        network: tx.prepare('SELECT * FROM network_target WHERE device_id = ?').get(d.id) as Record<string, unknown> | undefined,
      };
      const others = (['dahua', 'tuya', 'network'] as const).filter((t) => t !== s.type && rows[t]);
      let input: Record<string, unknown>;
      let describe: string;
      const diffs: string[] = others.map((t) => `source ${t} deja enregistree`);
      let known = true;
      if (s.type === 'dahua') {
        input = { cameraId: s.camera, channel: s.channel, events: s.events, httpPort: s.httpPort };
        describe = `enregistreur Dahua via ${s.camera}, voie ${s.channel} : ${s.events.join('+')}`;
        const r = rows.dahua;
        if (r) {
          if (r.camera_id !== s.camera) diffs.push(`camera ${show(r.camera_id)} -> ${show(s.camera)}`);
          if (r.channel !== s.channel) diffs.push(`voie ${r.channel} -> ${s.channel}`);
          if (!sameSet(JSON.parse(r.events as string) as string[], s.events)) diffs.push(`evenements ${r.events as string} -> ${JSON.stringify(s.events)}`);
          if (r.http_port !== s.httpPort) diffs.push(`port HTTP ${r.http_port} -> ${s.httpPort}`);
        }
      } else if (s.type === 'tuya') {
        const tid = value(s.tuyaId, 'tuyaId');
        known = tid.known;
        input = { deviceId: tid.value, sensorType: s.sensorType ?? 'auto' };
        describe = `capteur Tuya ${label(s.tuyaId, tid)}${s.sensorType ? ` (${s.sensorType})` : ''}`;
        const r = rows.tuya;
        if (r) {
          if (tid.known && r.tuya_id !== tid.value) diffs.push(`appareil ${show(r.tuya_id)} -> ${show(tid.value)}`);
          if ((r.sensor_type ?? null) !== s.sensorType) diffs.push(`type ${show(r.sensor_type)} -> ${show(s.sensorType)}`);
        }
      } else {
        const host = value(s.host, 'host');
        known = host.known;
        input = { host: host.value, port: s.port };
        describe = `supervision reseau ${label(s.host, host)}:${s.port}`;
        const r = rows.network;
        if (r) {
          if (host.known && r.host !== host.value) diffs.push(`adresse ${show(r.host)} -> ${show(host.value)}`);
          if (r.port !== s.port) diffs.push(`port ${r.port} -> ${s.port}`);
        }
      }
      const set = () => {
        for (const t of others) {
          if (t === 'dahua') dahua.removeSource(actor, d.id);
          else if (t === 'tuya') tuya.removeSource(actor, d.id);
          else targets.remove(actor, d.id);
        }
        if (s.type === 'dahua') dahua.setSource(actor, d.id, input);
        else if (s.type === 'tuya') tuya.setSource(actor, d.id, input);
        else targets.set(actor, d.id, input);
      };
      if (!rows[s.type] && others.length === 0) {
        set();
        add('source', d.id, 'create', describe);
      } else if (diffs.length === 0) add('source', d.id, 'same', `${describe}${known ? '' : ' (valeur a saisir non comparee)'}`);
      else if (conflict('source', d.id, diffs)) set();
    }

    // ---- 6. Liens detecteur -> cameras
    for (const [det, cams] of Object.entries(pack.links)) {
      if (kept.has(det)) continue;
      const current = (tx.prepare('SELECT camera_id FROM device_link WHERE detector_id = ? ORDER BY camera_id').all(det) as { camera_id: string }[]).map((r) => r.camera_id);
      if (sameSet(current, cams)) add('liens', det, 'same', cams.join(', '));
      else if (current.length === 0) {
        engine.setLinks(actor, det, cams);
        add('liens', det, 'create', cams.join(', '));
      } else if (conflict('liens', det, [`cameras ${current.join(', ')} -> ${cams.join(', ')}`])) engine.setLinks(actor, det, cams);
    }

    // ---- 7. Planning d'armement
    for (const a of pack.arming) {
      const row = tx.prepare('SELECT schedule FROM arming_zone WHERE zone = ?').get(a.zone) as { schedule: string | null } | undefined;
      const wanted = JSON.stringify(a.schedule);
      const text = a.schedule.map((w) => `${w.days.join(',')} ${w.from}-${w.to}`).join(' ; ');
      if (!row?.schedule) {
        arming.setSchedule(actor, a.zone, a.schedule);
        add('armement', a.zone, 'create', text);
      } else if (row.schedule === wanted) add('armement', a.zone, 'same', text);
      else if (conflict('armement', a.zone, [`planning different (pack : ${text})`])) arming.setSchedule(actor, a.zone, a.schedule);
    }

    // ---- 8. Evaluation de risque
    for (const r of pack.risk) {
      const row = tx.prepare('SELECT * FROM risk_zone WHERE zone = ?').get(r.zone) as Record<string, unknown> | undefined;
      const input = { probability: r.probability, defenses: r.defenses, impactImage: r.impacts.image, impactEconomy: r.impacts.economy, impactHuman: r.impacts.human, notes: r.notes };
      const text = `probabilite ${r.probability}, impacts ${r.impacts.image}/${r.impacts.economy}/${r.impacts.human}, ${r.defenses.length} defense(s)`;
      if (!row) {
        risk.assess(actor, r.zone, input);
        add('risque', r.zone, 'create', text);
        continue;
      }
      const diffs: string[] = [];
      if (row.probability !== r.probability) diffs.push(`probabilite ${row.probability} -> ${r.probability}`);
      if (!sameSet(JSON.parse(row.defenses as string) as string[], r.defenses)) diffs.push('lignes de defense differentes');
      if (row.impact_image !== r.impacts.image || row.impact_economy !== r.impacts.economy || row.impact_human !== r.impacts.human) {
        diffs.push(`impacts ${row.impact_image}/${row.impact_economy}/${row.impact_human} -> ${r.impacts.image}/${r.impacts.economy}/${r.impacts.human}`);
      }
      if ((row.notes ?? '') !== r.notes) diffs.push('notes differentes');
      if (diffs.length === 0) add('risque', r.zone, 'same', text);
      else if (conflict('risque', r.zone, diffs)) risk.assess(actor, r.zone, input);
    }

    // ---- 9. Destinataires
    for (const r of pack.recipients) {
      const ref = `${r.label} (${r.channel}, niveau ${r.level})`;
      if (!opts.channels[r.channel]) {
        add('destinataire', ref, 'skip', `canal ${r.channel} non configure dans le .env`);
        warnings.push(`destinataire « ${r.label} » (${r.channel}) non ajoute : canal non configure. Le configurer (voir .env.example), puis reappliquer le pack.`);
        continue;
      }
      const address = value(r.address, `address:${r.channel}` as ValueKind);
      if (address.known && address.value === '') {
        add('destinataire', ref, 'skip', 'adresse non fournie : a ajouter plus tard dans Notifications');
        continue;
      }
      const shown = address.known ? maskAddress(r.channel, address.value) : '<a saisir>';
      const row = address.known
        ? (tx.prepare('SELECT * FROM notification_recipient WHERE channel = ? AND address = ? AND level = ?').get(r.channel, address.value, r.level) as Record<string, unknown> | undefined)
        : undefined;
      const input = { channel: r.channel, address: address.value, level: r.level, label: r.label, zones: r.zones };
      if (!row) {
        recipients.add(actor, input);
        add('destinataire', ref, 'create', `${shown}${r.zones ? ` ; zones : ${r.zones.join(', ')}` : ''}`);
        continue;
      }
      const diffs: string[] = [];
      if (row.label !== r.label) diffs.push(`libelle ${show(row.label)} -> ${show(r.label)}`);
      const zones = row.zones ? (JSON.parse(row.zones as string) as string[]) : null;
      if (!(zones === null && r.zones === null) && !(zones && r.zones && sameSet(zones, r.zones))) diffs.push(`zones ${show(zones)} -> ${show(r.zones)}`);
      if (row.active !== 1) diffs.push('desactive -> actif');
      if (diffs.length === 0) add('destinataire', ref, 'same', shown);
      else if (conflict('destinataire', ref, diffs)) recipients.update(actor, row.id as number, { label: r.label, zones: r.zones, active: true });
    }

    // ---- Bilan
    const count = (a: Action) => items.filter((i) => i.action === a).length;
    const conflicts = count('conflict');
    if (fatal.length) throw new Error(fatal.join(' ; '));
    if (conflicts && opts.mode === 'strict' && !opts.dryRun) {
      throw new ConflictRefusal(`${conflicts} conflit(s) avec l'existant : rien n'a ete applique. Relancer avec --update (valeurs du pack) ou --keep-existing (garder l'existant).`);
    }
    const summary = `${count('create')} cree(s), ${count('update')} modifie(s), ${count('same')} deja conforme(s), ${conflicts} conflit(s)${conflicts && opts.mode === 'keep' ? ' conserve(s)' : ''}, ${count('skip')} ignore(s)`;
    engine.audit(actor, 'pack_applique', {
      details: `${pack.id}@${pack.version} (${pack.segment}, ${pack.level}${opts.sha256 ? `, empreinte ${opts.sha256.slice(0, 12)}` : ''}) : ${summary}${opts.unqualified ? ` ; ${opts.unqualified} equipement(s) de modele a qualifier accepte(s)` : ''}${opts.by ? ` ; par ${opts.by}` : ''}`,
    });

    if (opts.dryRun) {
      db.exec('ROLLBACK TO pack_apply; RELEASE pack_apply');
      return { items, warnings, error: null, committed: false, summary };
    }
    // Fichiers de plan : nouveaux noms, ecriture atomique (temporaire puis renommage), AVANT la validation.
    if (pendingPlans.length) mkdirSync(opts.dataDir, { recursive: true });
    for (const p of pendingPlans) {
      const final = join(opts.dataDir, p.file);
      const temp = `${final}.tmp-${process.pid}`;
      writeFileSync(temp, p.body);
      written.push(temp);
      renameSync(temp, final);
      written[written.length - 1] = final;
    }
    opts.beforeCommit?.();
    db.exec('RELEASE pack_apply');
    committed = true;
    if (pendingPlans.length) removeUnusedPlans(db, opts.dataDir);
    return { items, warnings, error: null, committed, summary };
  } catch (err) {
    if (!committed) {
      try {
        db.exec('ROLLBACK TO pack_apply; RELEASE pack_apply');
      } catch {
        // transaction deja annulee par SQLite
      }
      for (const f of written) {
        try {
          unlinkSync(f);
        } catch {
          // deja absent
        }
      }
    }
    error = err instanceof ConflictRefusal ? err.message : `${(err as Error).message} : rien n'a ete applique`;
    const count = (a: Action) => items.filter((i) => i.action === a).length;
    return { items, warnings, error, committed: false, summary: `${count('conflict')} conflit(s) ; echec` };
  }
}

/** Supprime les fichiers de plan qu'aucun etage ne reference plus (apres validation seulement). */
function removeUnusedPlans(db: DatabaseSync, dataDir: string): void {
  if (!existsSync(dataDir)) return;
  const used = new Set((db.prepare('SELECT plan_file FROM floor WHERE plan_file IS NOT NULL').all() as { plan_file: string }[]).map((r) => r.plan_file));
  for (const name of readdirSync(dataDir)) {
    if (!PLAN_FILE_PATTERN.test(name) || used.has(name)) continue;
    try {
      unlinkSync(join(dataDir, name));
    } catch {
      // fichier en cours de lecture (Windows) : sera supprime au prochain remplacement
    }
  }
}
