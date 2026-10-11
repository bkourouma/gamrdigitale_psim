/**
 * Export de l'installation courante en pack (pour reproduire un site) : etages et plans, zones, equipements, sources,
 * liens, armement, risque, destinataires en gabarit. SANS AUCUN SECRET : les identifiants des cameras deviennent des
 * questions (`$ask`), les adresses des destinataires aussi ; le resultat est verifie par la meme detection de secrets
 * que l'import, et l'export est refuse s'il en reste un (ex. mot de passe ecrit dans un chemin RTSP).
 *
 * Lecture seule de la base. Le modele catalogue de chaque equipement vient de la table `pack_device` (equipements poses
 * par un pack) ; a defaut : « a-renseigner », a qualifier.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PLAN_FILE_PATTERN } from '../../server/floors.ts';
import { findSecrets, validatePack } from './schema.ts';
import type { Pack } from './schema.ts';

type Row = Record<string, unknown>;

export interface ExportMeta {
  id: string;
  name: string;
  segment: Pack['segment'];
  level: Pack['level'];
  version: string;
  description?: string;
  /** Comptes de passerelle du .env (noms et equipements, jamais le mot de passe). */
  gatewayAccounts?: { user: string; detectors: string[] }[];
}

export interface ExportResult {
  /** Contenu de pack.json (objet JSON pret a ecrire), ou null en cas d'erreur. */
  pack: Record<string, unknown> | null;
  files: { path: string; body: Buffer }[];
  errors: string[];
  notes: string[];
}

const tableExists = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

export function exportPack(db: DatabaseSync, dataDir: string, meta: ExportMeta): ExportResult {
  const notes: string[] = [];
  const files: ExportResult['files'] = [];
  const floorRows = db.prepare('SELECT id, name, plan_file FROM floor ORDER BY position, id').all() as Row[];
  const floorKey = new Map<number, string>();
  const floors = floorRows.map((f, i) => {
    const key = `etage-${i}`;
    floorKey.set(f.id as number, key);
    const out: Record<string, unknown> = { id: key, name: f.name };
    const planFile = f.plan_file as string | null;
    if (planFile && PLAN_FILE_PATTERN.test(planFile)) {
      const path = resolve(dataDir, planFile);
      if (path.startsWith(resolve(dataDir) + sep) && existsSync(path)) {
        const name = `plans/${key}.${planFile.split('.').pop()}`;
        files.push({ path: name, body: readFileSync(path) });
        out.plan = name;
      } else notes.push(`plan de l'etage « ${f.name} » introuvable dans ${dataDir} : non exporte`);
    }
    return out;
  });
  const defaultFloor = floorRows[0]?.id as number;

  const devices = db.prepare('SELECT * FROM device ORDER BY kind DESC, id').all() as Row[];
  const models = new Map<string, Row>();
  if (tableExists(db, 'pack_device')) for (const r of db.prepare('SELECT * FROM pack_device').all() as Row[]) models.set(r.device_id as string, r);
  const zones = new Map<string, string>();
  for (const d of devices) if (d.zone) zones.set(d.zone as string, floorKey.get((d.floor_id as number | null) ?? defaultFloor)!);

  const cameraSources = new Map((db.prepare('SELECT * FROM camera_source').all() as Row[]).map((r) => [r.device_id as string, r]));
  const dahua = new Map((db.prepare('SELECT * FROM detector_source').all() as Row[]).map((r) => [r.device_id as string, r]));
  const tuya = new Map((db.prepare('SELECT * FROM tuya_source').all() as Row[]).map((r) => [r.device_id as string, r]));
  const network = new Map((db.prepare('SELECT * FROM network_target').all() as Row[]).map((r) => [r.device_id as string, r]));
  let unknownModels = 0;

  const outDevices = devices.map((d) => {
    const id = d.id as string;
    const m = models.get(id);
    if (!m) unknownModels += 1;
    const out: Record<string, unknown> = { id, kind: d.kind, name: d.name };
    if (d.zone) out.zone = d.zone;
    else out.floor = floorKey.get((d.floor_id as number | null) ?? defaultFloor);
    out.x = d.x;
    out.y = d.y;
    out.model = (m?.model as string | undefined) ?? 'a-renseigner';
    out.qualification = (m?.qualification as string | undefined) ?? 'to_qualify';
    if (d.kind === 'detector') {
      out.category = d.category ?? 'fire';
      if (d.value_unit) out.unit = d.value_unit;
      if (d.warn_at !== null) out.warnAt = d.warn_at;
      if (d.alarm_at !== null) out.alarmAt = d.alarm_at;
      if (d.direction && d.direction !== 'above') out.direction = d.direction;
      out.heartbeatS = d.heartbeat_s ?? null;
      const s = dahua.get(id);
      const t = tuya.get(id);
      const n = network.get(id);
      if (s) out.source = { type: 'dahua', camera: s.camera_id, channel: s.channel, events: JSON.parse(s.events as string), ...(s.http_port !== 80 ? { httpPort: s.http_port } : {}) };
      else if (t) out.source = { type: 'tuya', tuyaId: t.tuya_id, ...(t.sensor_type ? { sensorType: t.sensor_type } : {}) };
      else if (n) out.source = { type: 'network', host: n.host, port: n.port };
    } else {
      const c = cameraSources.get(id);
      if (c) {
        // Identifiants : questions, regroupees par appareil (les voies d'un meme enregistreur partagent ses identifiants).
        const creds = c.username || c.secret ? { username: { $ask: `Identifiant de l'appareil ${c.host}` }, password: { $ask: `Mot de passe de l'appareil ${c.host}` } } : undefined;
        out.source = {
          type: c.kind, host: c.host, port: c.port, ...(c.kind === 'rtsp' && c.rtsp_path ? { path: c.rtsp_path } : {}), ...(c.aspect && c.aspect !== 'auto' ? { aspect: c.aspect } : {}),
          ...(creds ? { credentials: creds } : {}),
        };
      }
    }
    return out;
  });
  if (unknownModels) notes.push(`${unknownModels} equipement(s) sans modele connu (poses hors pack) : « a-renseigner », a qualifier. Completer « model » avant de reutiliser ce pack.`);

  const links: Record<string, string[]> = {};
  for (const r of db.prepare('SELECT detector_id, camera_id FROM device_link ORDER BY detector_id, camera_id').all() as Row[]) (links[r.detector_id as string] ??= []).push(r.camera_id as string);

  const intrusionZones = new Set(devices.filter((d) => d.kind === 'detector' && d.category === 'intrusion' && d.zone).map((d) => d.zone as string));
  const arming = (db.prepare('SELECT zone, schedule FROM arming_zone WHERE schedule IS NOT NULL ORDER BY zone').all() as Row[]).flatMap((r) => {
    if (!intrusionZones.has(r.zone as string)) {
      notes.push(`planning de la zone « ${r.zone} » non exporte : plus de detecteur d'intrusion dans cette zone`);
      return [];
    }
    return [{ zone: r.zone, schedule: JSON.parse(r.schedule as string) }];
  });
  const risk = (db.prepare('SELECT * FROM risk_zone ORDER BY zone').all() as Row[]).flatMap((r) => {
    if (!zones.has(r.zone as string)) return [];
    return [{ zone: r.zone, probability: r.probability, defenses: JSON.parse((r.defenses as string) || '[]'), impacts: { image: r.impact_image, economy: r.impact_economy, human: r.impact_human }, ...(r.notes ? { notes: r.notes } : {}) }];
  });
  const detectorZones = new Set(devices.filter((d) => d.kind === 'detector' && d.zone).map((d) => d.zone as string));
  const labels = new Set<string>();
  const recipients = (db.prepare("SELECT * FROM notification_recipient WHERE active = 1 AND channel IN ('email', 'telegram', 'whatsapp', 'webhook') ORDER BY channel, level, id").all() as Row[]).map((r, i) => {
    const zonesOf = r.zones ? (JSON.parse(r.zones as string) as string[]).filter((z) => detectorZones.has(z)) : null;
    // Libelle unique par canal et niveau : il nomme la question posee a la reinstallation.
    const base = ((r.label as string) || `Destinataire ${i + 1}`).slice(0, 70);
    let label = base;
    for (let n = 2; labels.has(`${r.channel}|${r.level}|${label}`); n++) label = `${base} (${n})`;
    labels.add(`${r.channel}|${r.level}|${label}`);
    return {
      channel: r.channel, level: r.level, label,
      address: { $ask: `${label} : adresse ${r.channel} (niveau ${r.level})` },
      ...(zonesOf && zonesOf.length ? { zones: zonesOf } : {}),
    };
  });
  const accounts = (meta.gatewayAccounts ?? []).map((g) => ({ name: g.user, devices: g.detectors }));

  const pack: Record<string, unknown> = {
    packVersion: 1,
    id: meta.id,
    name: meta.name,
    segment: meta.segment,
    level: meta.level,
    version: meta.version,
    description: meta.description ?? 'Exporte depuis une installation existante (npm run pack -- export).',
    floors,
    zones: [...zones].map(([name, floor]) => ({ name, floor })),
    devices: outDevices,
    ...(Object.keys(links).length ? { links } : {}),
    ...(arming.length ? { arming } : {}),
    ...(risk.length ? { risk } : {}),
    ...(recipients.length ? { recipients } : {}),
    ...(accounts.length ? { gateway: { accounts } } : {}),
  };

  // Garde-fou : jamais de secret dans un export (meme verification qu'a l'import), et un pack reimportable.
  const secrets = findSecrets(pack);
  if (secrets.length) return { pack: null, files, errors: secrets.map((s) => `export refuse, ${s} (corriger la donnee dans le PSIM)`), notes };
  const check = validatePack(pack);
  if (check.errors.length) return { pack: null, files, errors: check.errors.map((e) => `export invalide : ${e}`), notes };
  return { pack, files, errors: [], notes };
}
