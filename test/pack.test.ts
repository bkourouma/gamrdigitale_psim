/**
 * Packs d'installation (scripts/pack.ts) : format strict et detection des secrets, plan sans ecriture, application
 * complete, idempotence, conflits, atomicite (base et fichiers de plan), export puis reimport, journal sans secret,
 * modeles a qualifier, verrou du PSIM, recette « le pack est complet ».
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { buildSheet } from '../scripts/commission/sheet.ts';
import { applyPack, nestable } from '../scripts/pack/apply.ts';
import type { ApplyOptions } from '../scripts/pack/apply.ts';
import { appliedPacks, checkPack } from '../scripts/pack/checks.ts';
import { exportPack } from '../scripts/pack/export.ts';
import { collectAnswers, loadPack } from '../scripts/pack/load.ts';
import type { Answers } from '../scripts/pack/load.ts';
import { qualify, readRegistry } from '../scripts/pack/qualification.ts';
import { findSecrets, validatePack } from '../scripts/pack/schema.ts';
import type { Pack } from '../scripts/pack/schema.ts';
import { formatReport } from '../scripts/pack.ts';
import { verify } from '../server/auditchain.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { unseal } from '../server/secrets.ts';
import { seedEmptySite } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const KEY = randomBytes(32);
const PASSWORD = 'Tr3s-Secret-XVR!';
const USERNAME = 'psimlecture';
const EMAIL = 'proprietaire@exemple.ci';
const PHONE = '+2250700000002';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>rdc</title></svg>');
const ALL_CHANNELS = { email: true, telegram: true, whatsapp: true, callmebot: false, webhook: true };

const ANSWERS: Record<string, string> = {
  'IP enregistreur': '192.168.1.108',
  'Identifiant enregistreur': USERNAME,
  'Mot de passe enregistreur': PASSWORD,
  'Tuya sejour': 'bf466dd7b79fe07dd5jizp',
  'Email proprietaire': EMAIL,
  'WhatsApp gardien': PHONE,
};

/** Pack d'essai : toutes les sortes d'elements (sources, liens, armement, risque, destinataires, passerelle, plan). */
function basePack(): Record<string, unknown> {
  return {
    packVersion: 1,
    id: 'essai-complet',
    name: 'Pack d\'essai complet',
    segment: 'villa',
    level: 'confort',
    version: '1.2.0',
    description: 'Pack de test.',
    floors: [
      { id: 'rdc', name: 'Rez-de-chaussée', plan: 'plans/rdc.svg' },
      { id: 'etage', name: 'Étage' },
    ],
    zones: [
      { name: 'Entrée', floor: 'rdc' },
      { name: 'Séjour', floor: 'rdc' },
      { name: 'Technique', floor: 'rdc' },
      { name: 'Chambre', floor: 'etage' },
    ],
    devices: [
      {
        id: 'CAM-1', kind: 'camera', name: 'Camera entree', zone: 'Entrée', x: 10, y: 10, model: 'dahua-hac-hfw1500th-i8', qualification: 'to_qualify',
        source: { type: 'rtsp', host: { $ask: 'IP enregistreur' }, port: 554, path: '/cam/realmonitor?channel=1&subtype=1', credentials: { username: { $ask: 'Identifiant enregistreur' }, password: { $ask: 'Mot de passe enregistreur' } } },
      },
      { id: 'CAM-2', kind: 'camera', name: 'Camera sejour', zone: 'Séjour', model: 'camera-ip-onvif', qualification: 'qualified', source: { type: 'onvif', host: '192.168.1.30' } },
      { id: 'I-1', kind: 'detector', name: 'Personne a l\'entree', zone: 'Entrée', model: 'dahua-xvr-voie-evenements', qualification: 'qualified', category: 'intrusion', source: { type: 'dahua', camera: 'CAM-1', channel: 1, events: ['SmartMotionHuman'] } },
      { id: 'F-1', kind: 'detector', name: 'Fumee sejour', zone: 'Séjour', x: 40, y: 40, model: 'fumee-wifi-tuya-ywbj', qualification: 'qualified', category: 'fire', source: { type: 'tuya', tuyaId: { $ask: 'Tuya sejour' }, sensorType: 'smoke' } },
      { id: 'F-2', kind: 'detector', name: 'Fumee chambre', zone: 'Chambre', model: 'heiman-hs1sa-e', qualification: 'to_qualify', category: 'fire', heartbeatS: 180 },
      { id: 'T-1', kind: 'detector', name: 'Temperature baie', zone: 'Technique', model: 'sonde-temperature', qualification: 'qualified', category: 'environment', unit: '°C', warnAt: 30, alarmAt: 40, heartbeatS: 600 },
      { id: 'R-1', kind: 'detector', name: 'Routeur', zone: 'Technique', model: 'routeur-4g', qualification: 'qualified', category: 'environment', source: { type: 'network', host: '192.168.1.1', port: 80 } },
    ],
    links: { 'F-1': ['CAM-2', 'CAM-1'], 'I-1': ['CAM-1'] },
    arming: [{ zone: 'Entrée', schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' }] }],
    risk: [{ zone: 'Séjour', probability: 2, defenses: ['extincteurs'], impacts: { image: 2, economy: 3, human: 4 }, notes: 'Multiprises.' }],
    recipients: [
      { channel: 'email', level: 1, label: 'Proprietaire', address: { $ask: 'Email proprietaire' } },
      { channel: 'whatsapp', level: 2, label: 'Gardien', address: { $ask: 'WhatsApp gardien' }, zones: ['Entrée'] },
    ],
    gateway: { accounts: [{ name: 'gw1', devices: ['F-2', 'T-*'] }], modules: [{ module: 'heartbeat' }, { module: 'zigbee', note: 'F-2 type smoke' }] },
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function writePack(obj: unknown, plans: Record<string, Buffer> = { 'plans/rdc.svg': SVG }): string {
  const dir = mkdtempSync(join(tmpdir(), 'psim-pack-'));
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(obj, null, 2));
  for (const [path, body] of Object.entries(plans)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** Site neuf, comme au premier demarrage du PSIM. */
function freshSite(): { dir: string; dbFile: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'psim-site-'));
  const dbFile = join(dir, 'psim.db');
  const db = openDb(dbFile);
  seedEmptySite(db, 'Villa essai');
  return { dir, dbFile, db };
}

function loaded(obj: unknown = basePack()) {
  const l = loadPack(writePack(obj));
  assert.deepEqual(l.errors, []);
  return l;
}

const answersMap = (values: Record<string, string> = ANSWERS): Answers => new Map(Object.entries(values));

function options(dataDir: string, l: ReturnType<typeof loaded>, over: Partial<ApplyOptions> = {}): ApplyOptions {
  return { dataDir, mode: 'strict', dryRun: false, answers: answersMap(), key: KEY, keyIsReal: true, plans: l.plans, channels: ALL_CHANNELS, sha256: l.sha256, ...over };
}

/** Tout le contenu de la base, table par table (pour « base inchangee »). */
function dump(db: DatabaseSync): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
}

/** L'installation (sans dates ni identifiants techniques) : sert a comparer deux sites. */
function installation(db: DatabaseSync, key: Buffer) {
  const q = (sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  return {
    floors: q('SELECT name, position, plan_version, plan_file IS NOT NULL AS has_plan FROM floor ORDER BY position'),
    devices: q('SELECT d.id, kind, d.name, zone, x, y, category, value_unit, warn_at, alarm_at, direction, heartbeat_s, stream_kind, f.name AS floor FROM device d JOIN floor f ON f.id = d.floor_id ORDER BY d.id'),
    cameras: q('SELECT device_id, kind, host, port, rtsp_path, username, aspect, secret FROM camera_source ORDER BY device_id').map((r): Record<string, unknown> => ({ ...r, secret: r.secret ? unseal(key, r.secret as string) : null })),
    dahua: q('SELECT device_id, camera_id, channel, events, http_port FROM detector_source ORDER BY device_id'),
    tuya: q('SELECT * FROM tuya_source ORDER BY device_id'),
    network: q('SELECT * FROM network_target ORDER BY device_id'),
    links: q('SELECT * FROM device_link ORDER BY detector_id, camera_id'),
    arming: q('SELECT zone, schedule FROM arming_zone ORDER BY zone'),
    risk: q('SELECT zone, probability, defenses, impact_image, impact_economy, impact_human, notes FROM risk_zone ORDER BY zone'),
    recipients: q('SELECT channel, address, level, label, active, zones FROM notification_recipient ORDER BY channel, level, address'),
    models: q('SELECT device_id, model, qualification FROM pack_device ORDER BY device_id'),
  };
}

function cli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PSIM_') && v !== undefined) env[k] = v;
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack.ts'), ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', cwd: ROOT, timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const errorsOf = (obj: unknown) => validatePack(obj).errors;

// ---------------------------------------------------------------- format et validation

describe('pack : format strict et messages situes', () => {
  it('les trois packs livres sont valides et sans secret', () => {
    for (const name of ['pack-standard-4cam-2fumee', 'villa-essentiel', 'appartement-confort']) {
      const l = loadPack(join(ROOT, 'packs', name));
      assert.deepEqual(l.errors, [], name);
      assert.equal(l.pack!.id, name);
      assert.deepEqual(findSecrets(JSON.parse(readFileSync(join(ROOT, 'packs', name, 'pack.json'), 'utf8'))), [], name);
    }
    const standard = loadPack(join(ROOT, 'packs', 'pack-standard-4cam-2fumee')).pack!;
    assert.equal(standard.devices.filter((d) => d.kind === 'camera' && d.model === 'dahua-hac-hfw1500th-i8').length, 4);
    assert.equal(standard.devices.filter((d) => d.model === 'heiman-hs1sa-e').length, 2);
    assert.ok(standard.devices.some((d) => d.model === 'dahua-xvr5104hs-i3'));
    // Seule la voie d'enregistreur Dahua est qualifiee dans ce pack (le fumee WiFi Tuya l'est dans les autres).
    assert.deepEqual([...new Set(standard.devices.filter((d) => d.qualification === 'qualified').map((d) => d.model))], ['dahua-xvr-voie-evenements']);
  });

  it('refuse toute cle inconnue, en situant le chemin', () => {
    const p = basePack();
    (p as Record<string, unknown>).couleur = 'rouge';
    ((p.devices as Record<string, unknown>[])[1]).marque = 'Dahua';
    (((p.devices as Record<string, unknown>[])[0]).source as Record<string, unknown>).codec = 'h265';
    const errors = errorsOf(p);
    assert.ok(errors.some((e) => /^couleur : cle inconnue/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /^devices\[1\] « CAM-2 »\.marque : cle inconnue/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /^devices\[0\] « CAM-1 »\.source\.codec : cle inconnue/.test(e)), errors.join('\n'));
    // Reglages de capteur sur une camera : refuses.
    const q = basePack();
    ((q.devices as Record<string, unknown>[])[1]).heartbeatS = 60;
    assert.ok(errorsOf(q).some((e) => /CAM-2 »\.heartbeatS : cle inconnue/.test(e)));
    assert.ok(errorsOf({ ...basePack(), packVersion: 2 }).some((e) => /^packVersion : version de format non prise en charge/.test(e)));
  });

  it('refuse les identifiants invalides et les doublons', () => {
    const p = basePack();
    const devices = p.devices as Record<string, unknown>[];
    devices[2].id = 'I 1 !';
    devices.push({ ...clone(devices[5]) });
    (p.floors as Record<string, unknown>[]).push({ id: 'autre', name: 'ÉTAGE' });
    (p.zones as Record<string, unknown>[]).push({ name: 'séjour', floor: 'rdc' });
    p.id = 'Pack Majuscules';
    const errors = errorsOf(p);
    assert.ok(errors.some((e) => /devices\[2\] « I 1 ! »\.id : format invalide/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /identifiant d'equipement en double \(« T-1 »\)/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /nom d'etage en double/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /zone en double/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /^id : format invalide/.test(e)), errors.join('\n'));
  });

  it('refuse les references cassees', () => {
    const p = basePack();
    const devices = p.devices as Record<string, unknown>[];
    devices[4].zone = 'Grenier';
    devices[5].floor = 'cave';
    (p.links as Record<string, string[]>)['F-1'] = ['CAM-9'];
    (devices[2].source as Record<string, unknown>).camera = 'CAM-2'; // camera sans identifiants
    (p.arming as Record<string, unknown>[])[0].zone = 'Séjour';
    (p.recipients as Record<string, unknown>[])[1].zones = ['Garage'];
    (p.gateway as { accounts: { devices: string[] }[] }).accounts[0].devices = ['Z-*'];
    const errors = errorsOf(p);
    for (const re of [
      /devices\[4\] « F-2 »\.zone : zone non declaree/,
      /devices\[5\] « T-1 »\.floor : etage inconnu « cave »/,
      /links\.F-1\[0\] : camera inconnue dans le pack \(« CAM-9 »\)/,
      /devices « I-1 »\.source\.camera : la camera « CAM-2 » doit avoir une source rtsp ou onvif avec des identifiants/,
      /arming\[0\] « Séjour »\.zone : aucun detecteur d'intrusion/,
      /recipients\[1\]\.zones\[0\] : zone sans detecteur/,
      /gateway\.accounts\[0\] « gw1 »\.devices\[0\] : ne designe aucun equipement/,
      /zones « Chambre » : zone declaree sans aucun equipement/,
    ]) assert.ok(errors.some((e) => re.test(e)), `${re}\n${errors.join('\n')}`);
  });

  it('applique les regles des sources du PSIM (categorie, supervision)', () => {
    const p = basePack();
    const devices = p.devices as Record<string, unknown>[];
    devices[2].category = 'fire'; // Dahua -> intrusion seulement
    devices[3].heartbeatS = 60; // Tuya : au moins 300 s
    devices[6].heartbeatS = 120; // reseau : 0
    const errors = errorsOf(p);
    assert.ok(errors.some((e) => /I-1 ».source : la detection d'un enregistreur Dahua alimente un detecteur d'intrusion/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /F-1 »\.heartbeatS : un capteur Tuya est supervise au moins 300 s/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /R-1 »\.heartbeatS : un equipement supervise par le reseau/.test(e)), errors.join('\n'));
    // Valeurs effectives : ce sont elles qui seront comparees a l'existant.
    const pack = validatePack(basePack()).pack!;
    const hb = Object.fromEntries(pack.devices.map((d) => [d.id, d.heartbeatS]));
    assert.deepEqual(hb, { 'CAM-1': null, 'CAM-2': null, 'I-1': 120, 'F-1': 300, 'F-2': 180, 'T-1': 600, 'R-1': 0 });
  });

  it('marqueurs : bien formes, seulement aux endroits prevus, un libelle Tuya par appareil', () => {
    const p = basePack();
    const devices = p.devices as Record<string, unknown>[];
    devices[0].name = { $ask: 'Nom' };
    ((devices[0].source as Record<string, unknown>).credentials as Record<string, unknown>).username = { $env: 'mauvais-nom' };
    (devices[3].source as Record<string, unknown>).tuyaId = { $ask: 'IP enregistreur' };
    const errors = errorsOf(p);
    assert.ok(errors.some((e) => /CAM-1 »\.name : un texte est attendu/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /credentials\.username\.\$env : nom de variable invalide/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /F-1 »\.source\.tuyaId : le libelle « IP enregistreur » designe deja une autre sorte de valeur/.test(e)), errors.join('\n'));
    const q = basePack();
    const d = q.devices as Record<string, unknown>[];
    d.push({ ...clone(d[3]), id: 'F-3', zone: 'Chambre' });
    assert.ok(errorsOf(q).some((e) => /le libelle « Tuya sejour » est deja utilise pour un autre capteur Tuya/.test(e)));
    // Questions : un libelle = une question, meme utilise plusieurs fois.
    const v = validatePack(basePack());
    assert.deepEqual(v.questions.map((x) => [x.label, x.kind, x.secret]), [
      ['IP enregistreur', 'host', false], ['Identifiant enregistreur', 'username', false], ['Mot de passe enregistreur', 'password', true],
      ['Tuya sejour', 'tuyaId', false], ['Email proprietaire', 'address:email', false], ['WhatsApp gardien', 'address:whatsapp', false],
    ]);
  });
});

describe('pack : jamais de secret', () => {
  const secretErrors = (p: unknown) => errorsOf(p).filter((e) => /secret en clair interdit/.test(e));

  it('un mot de passe ecrit dans le pack est REFUSE', () => {
    const p = basePack();
    (((p.devices as Record<string, unknown>[])[0].source as Record<string, unknown>).credentials as Record<string, unknown>).password = 'admin123';
    const v = validatePack(p);
    assert.equal(v.pack, null);
    assert.ok(secretErrors(p).some((e) => /^devices\[0\]\.source\.credentials\.password : secret en clair/.test(e)), v.errors.join('\n'));
  });

  it('identifiants dans une adresse ou un chemin, cle de type secret, jeton reconnaissable : refuses', () => {
    const cases: [string, (p: Record<string, unknown>) => void, RegExp][] = [
      ['chemin', (p) => (((p.devices as Record<string, unknown>[])[0].source as Record<string, unknown>).path = '/cam/realmonitor?channel=1&password=admin'), /devices\[0\]\.source\.path : secret en clair/],
      ['adresse', (p) => (((p.devices as Record<string, unknown>[])[1].source as Record<string, unknown>).host = 'rtsp://admin:motdepasse@192.168.1.30'), /devices\[1\]\.source\.host : secret en clair.*utilisateur:motdepasse@/],
      ['cle inconnue', (p) => ((p.gateway as Record<string, unknown>).token = 'abcdef123456'), /gateway\.token : secret en clair/],
      ['nombre', (p) => ((p.devices as Record<string, unknown>[])[4].pin = 1234), /devices\[4\]\.pin : secret en clair/],
      ['secret Tuya', (p) => (p.description = 'cle du projet 0123456789abcdef0123456789abcdef'), /description : secret en clair.*cle hexadecimale/],
      ['texte', (p) => ((p.risk as Record<string, unknown>[])[0].notes = 'mot de passe : Admin2026'), /risk\[0\]\.notes : secret en clair/],
      ['jeton Telegram', (p) => ((p.recipients as Record<string, unknown>[])[0].label = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'), /recipients\[0\]\.label : secret en clair.*Telegram/],
    ];
    for (const [name, mutate, re] of cases) {
      const p = basePack();
      mutate(p);
      const v = validatePack(p);
      assert.equal(v.pack, null, name);
      assert.ok(secretErrors(p).some((e) => re.test(e)), `${name}\n${v.errors.join('\n')}`);
    }
  });

  it('une adresse de destinataire ecrite en clair est refusee (gabarit seulement)', () => {
    const p = basePack();
    (p.recipients as Record<string, unknown>[])[0].address = EMAIL;
    assert.ok(errorsOf(p).some((e) => /recipients\[0\]\.address : adresse a remplir a l'installation/.test(e)));
  });

  it('les marqueurs ne sont pas des secrets ; un pack sans secret passe', () => {
    assert.deepEqual(findSecrets(basePack()), []);
  });
});

// ---------------------------------------------------------------- application

describe('pack : plan, application, idempotence, conflits', () => {
  it('le plan (CLI) ne modifie rien, octet pour octet', () => {
    const site = freshSite();
    site.db.close();
    const before = readFileSync(site.dbFile);
    const files = readdirSync(site.dir).filter((f) => !/-(wal|shm)$/.test(f));
    const dir = writePack(basePack());
    const r = cli(['plan', dir, '--data-dir', site.dir]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /SIMULATION : rien n'est ecrit/);
    assert.match(r.out, /\+ a creer\s+CAM-1 {2}- {2}camera/);
    assert.match(r.out, /AVERTISSEMENT : 2 equipement\(s\) d'un modele A QUALIFIER/);
    assert.match(r.out, /compte « gw1 » absent dans PSIM_MQTT_GATEWAYS/);
    assert.ok(readFileSync(site.dbFile).equals(before), 'base modifiee par le plan');
    assert.deepEqual(readdirSync(site.dir).filter((f) => !/-(wal|shm)$/.test(f)), files);
    // Simulation en bibliotheque : meme garantie, et elle va jusqu'au bout (valeurs fictives sans reponse).
    const db = openDb(site.dbFile);
    const snap = dump(db);
    const l = loaded();
    const report = applyPack(db, l.pack!, options(site.dir, l, { dryRun: true, answers: new Map() }));
    assert.equal(report.error, null);
    assert.equal(report.committed, false);
    assert.equal(dump(db), snap);
    assert.ok(report.items.some((i) => i.ref === 'CAM-1' && i.section === 'source' && /<a saisir : IP enregistreur>/.test(i.detail)));
    db.close();
  });

  it('apply complet puis relecture', () => {
    const site = freshSite();
    const l = loaded();
    const report = applyPack(site.db, l.pack!, options(site.dir, l, { by: 'Kone Ibrahim', unqualified: 2 }));
    assert.equal(report.error, null, formatReport(report, true));
    assert.equal(report.committed, true);
    const inst = installation(site.db, KEY);
    assert.deepEqual(inst.floors.map((f) => [f.name, f.position, f.has_plan]), [['Rez-de-chaussée', 0, 1], ['Étage', 1, 0]]);
    assert.equal(inst.devices.length, 7);
    const t1 = inst.devices.find((d) => d.id === 'T-1')!;
    assert.deepEqual([t1.category, t1.value_unit, t1.warn_at, t1.alarm_at, t1.heartbeat_s, t1.floor], ['environment', '°C', 30, 40, 600, 'Rez-de-chaussée']);
    assert.equal(inst.devices.find((d) => d.id === 'F-2')!.floor, 'Étage');
    assert.deepEqual(inst.cameras.map((c) => [c.device_id, c.kind, c.host, c.port, c.username, c.secret]), [
      ['CAM-1', 'rtsp', '192.168.1.108', 554, USERNAME, PASSWORD],
      ['CAM-2', 'onvif', '192.168.1.30', 80, null, null],
    ]);
    assert.deepEqual(inst.dahua, [{ device_id: 'I-1', camera_id: 'CAM-1', channel: 1, events: '["SmartMotionHuman"]', http_port: 80 }]);
    assert.deepEqual(inst.tuya, [{ device_id: 'F-1', tuya_id: 'bf466dd7b79fe07dd5jizp', sensor_type: 'smoke' }]);
    assert.deepEqual(inst.network, [{ device_id: 'R-1', host: '192.168.1.1', port: 80 }]);
    assert.deepEqual(inst.links.map((x) => `${x.detector_id}>${x.camera_id}`), ['F-1>CAM-1', 'F-1>CAM-2', 'I-1>CAM-1']);
    assert.deepEqual(inst.arming, [{ zone: 'Entrée', schedule: '[{"days":[0,1,2,3,4,5,6],"from":"22:00","to":"06:00"}]' }]);
    assert.deepEqual(inst.risk.map((r) => [r.zone, r.probability, r.impact_human]), [['Séjour', 2, 4]]);
    assert.deepEqual(inst.recipients.map((r) => [r.channel, r.address, r.level, r.label, r.zones]), [['email', EMAIL, 1, 'Proprietaire', null], ['whatsapp', PHONE, 2, 'Gardien', '["Entrée"]']]);
    assert.equal(inst.models.length, 7);
    // Plan d'etage : fichier present et reference.
    const planFile = (site.db.prepare("SELECT plan_file FROM floor WHERE name = 'Rez-de-chaussée'").get() as { plan_file: string }).plan_file;
    assert.ok(readFileSync(join(site.dir, planFile)).equals(SVG));
    // Journal : chaque element journalise par sa fonction habituelle, puis l'entree du pack ; chaine intacte.
    const actions = (site.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((a) => a.action);
    for (const a of ['device_created', 'camera_source_updated', 'detector_source_updated', 'tuya_source_updated', 'network_target_updated', 'links_updated', 'arming_schedule', 'risk_assessed', 'recipient_added', 'floor_created', 'plan_updated']) assert.ok(actions.includes(a), a);
    assert.equal(actions.at(-1), 'pack_applique');
    const entry = site.db.prepare("SELECT actor, details FROM audit_log WHERE action = 'pack_applique'").get() as { actor: string; details: string };
    assert.equal(entry.actor, 'console');
    assert.match(entry.details, /^essai-complet@1\.2\.0 \(villa, confort, empreinte [0-9a-f]{12}\) : \d+ cree\(s\), 0 modifie\(s\)/);
    assert.match(entry.details, /2 equipement\(s\) de modele a qualifier accepte\(s\) ; par Kone Ibrahim$/);
    assert.equal(verify(site.db).ok, true);
    assert.deepEqual(appliedPacks(site.db).map((p) => [p.id, p.version, p.by]), [['essai-complet', '1.2.0', 'Kone Ibrahim']]);
    site.db.close();
  });

  it('idempotent : reappliquer ne cree aucun doublon et ne change rien', () => {
    const site = freshSite();
    const l = loaded();
    assert.equal(applyPack(site.db, l.pack!, options(site.dir, l)).committed, true);
    const before = installation(site.db, KEY);
    const plans = readdirSync(site.dir).filter((f) => f.startsWith('plan-'));
    const again = applyPack(site.db, l.pack!, options(site.dir, l));
    assert.equal(again.committed, true, again.error ?? '');
    assert.deepEqual(again.items.filter((i) => i.action !== 'same').map((i) => `${i.section} ${i.ref} ${i.action}`), []);
    assert.deepEqual(installation(site.db, KEY), before);
    assert.deepEqual(readdirSync(site.dir).filter((f) => f.startsWith('plan-')), plans);
    assert.equal((site.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pack_applique'").get() as { n: number }).n, 2);
    site.db.close();
  });

  it('conflit : refuse par defaut (rien n\'est applique), --keep-existing garde, --update remplace', () => {
    const site = freshSite();
    const l = loaded();
    assert.equal(applyPack(site.db, l.pack!, options(site.dir, l)).committed, true);
    const engine = createEngine(site.db, () => {});
    engine.updateDevice('admin', 'T-1', { name: 'Sonde renommee', alarmAt: 45 });
    site.db.prepare("UPDATE camera_source SET port = 8554 WHERE device_id = 'CAM-1'").run();
    // Une nouveaute dans le pack : elle ne doit PAS passer tant que le conflit n'est pas tranche.
    const p = basePack();
    (p.devices as Record<string, unknown>[]).push({ id: 'F-9', kind: 'detector', name: 'Fumee cuisine', zone: 'Séjour', model: 'heiman-hs1sa-e', qualification: 'to_qualify', heartbeatS: 180 });
    const l2 = loaded(p);
    const snap = dump(site.db);
    const strict = applyPack(site.db, l2.pack!, options(site.dir, l2));
    assert.equal(strict.committed, false);
    assert.match(strict.error!, /2 conflit\(s\) avec l'existant : rien n'a ete applique/);
    const t1 = strict.items.find((i) => i.ref === 'T-1')!;
    assert.equal(t1.action, 'conflict');
    assert.match(t1.detail, /nom « Sonde renommee » -> « Temperature baie » ; alarme 45 -> 40/);
    assert.equal(strict.items.find((i) => i.ref === 'CAM-1' && i.section === 'source')!.action, 'conflict');
    assert.equal(dump(site.db), snap);

    const keep = applyPack(site.db, l2.pack!, options(site.dir, l2, { mode: 'keep' }));
    assert.equal(keep.committed, true, keep.error ?? '');
    assert.equal(engine.getDevice('T-1')!.name, 'Sonde renommee');
    assert.ok(engine.getDevice('F-9'));

    const update = applyPack(site.db, l2.pack!, options(site.dir, l2, { mode: 'update' }));
    assert.equal(update.committed, true, update.error ?? '');
    assert.equal(engine.getDevice('T-1')!.name, 'Temperature baie');
    assert.equal(engine.getDevice('T-1')!.alarmAt, 40);
    assert.equal((site.db.prepare("SELECT port FROM camera_source WHERE device_id = 'CAM-1'").get() as { port: number }).port, 554);
    // Mot de passe change cote PSIM : detecte (la cle du PSIM permet de comparer sans jamais l'afficher).
    const other = applyPack(site.db, l2.pack!, options(site.dir, l2, { answers: answersMap({ ...ANSWERS, 'Mot de passe enregistreur': 'autre-mot-de-passe' }) }));
    assert.match(other.items.find((i) => i.ref === 'CAM-1' && i.section === 'source')!.detail, /mot de passe different/);
    assert.ok(!JSON.stringify(other).includes('autre-mot-de-passe'));
    site.db.close();
  });

  it('un equipement de meme id mais d\'un autre type est irreconciliable, meme avec --update', () => {
    const site = freshSite();
    createEngine(site.db, () => {}).createDevice('admin', { id: 'CAM-2', kind: 'detector', name: 'Ancien detecteur' });
    const l = loaded();
    const snap = dump(site.db);
    const r = applyPack(site.db, l.pack!, options(site.dir, l, { mode: 'update' }));
    assert.equal(r.committed, false);
    assert.match(r.error!, /equipement CAM-2 : c'est un\(e\) detecteur dans le PSIM, une camera dans le pack/);
    assert.equal(dump(site.db), snap);
    site.db.close();
  });
});

describe('pack : tout ou rien', () => {
  it('echec au milieu (destinataire refuse en fin de parcours) : base inchangee, aucun fichier de plan', () => {
    const site = freshSite();
    const l = loaded();
    const snap = dump(site.db);
    const env = { email: [[EMAIL], []], telegram: [[], []], whatsapp: [[], []], callmebot: [[], []], webhook: [[], []] };
    const r = applyPack(site.db, l.pack!, options(site.dir, l, { envRecipients: env }));
    assert.equal(r.committed, false);
    assert.match(r.error!, /deja defini dans le \.env : rien n'a ete applique/);
    // Beaucoup avait deja ete fait avant l'echec...
    assert.ok(r.items.filter((i) => i.action === 'create').length > 15);
    // ... et tout est annule : equipements, sources, journal, etages, plan.
    assert.equal(dump(site.db), snap);
    assert.deepEqual(readdirSync(site.dir).filter((f) => f.startsWith('plan-')), []);
    site.db.close();
  });

  it('panne au tout dernier moment (fichiers de plan ecrits) : base inchangee, fichiers retires', () => {
    const site = freshSite();
    const l = loaded();
    const snap = dump(site.db);
    let filesAtFailure: string[] = [];
    const r = applyPack(site.db, l.pack!, options(site.dir, l, {
      beforeCommit: () => {
        filesAtFailure = readdirSync(site.dir).filter((f) => f.startsWith('plan-'));
        throw new Error('coupure simulee');
      },
    }));
    assert.equal(r.committed, false);
    assert.match(r.error!, /coupure simulee : rien n'a ete applique/);
    assert.deepEqual(filesAtFailure, ['plan-1-1.svg']);
    assert.equal(dump(site.db), snap);
    assert.deepEqual(readdirSync(site.dir).filter((f) => f.startsWith('plan-') || f.includes('.tmp-')), []);
    site.db.close();
  });

  it('nestable : les BEGIN des fonctions du PSIM deviennent des points de sauvegarde', () => {
    const site = freshSite();
    const tx = nestable(site.db);
    site.db.exec('SAVEPOINT dehors');
    tx.exec('BEGIN IMMEDIATE');
    tx.prepare("INSERT INTO floor (name, position) VALUES ('A', 5)").run();
    tx.exec('ROLLBACK');
    tx.exec('BEGIN');
    tx.prepare("INSERT INTO floor (name, position) VALUES ('B', 6)").run();
    tx.exec('COMMIT');
    assert.equal(site.db.isTransaction, true);
    assert.deepEqual((site.db.prepare('SELECT name FROM floor WHERE position >= 5').all() as { name: string }[]).map((r) => r.name), ['B']);
    site.db.exec('ROLLBACK TO dehors; RELEASE dehors');
    assert.equal((site.db.prepare('SELECT COUNT(*) AS n FROM floor WHERE position >= 5').get() as { n: number }).n, 0);
    site.db.close();
  });
});

describe('pack : export, journal, qualification, verrou, recette', () => {
  it('export puis reimport donnent la meme installation, sans secret dans le pack', () => {
    const a = freshSite();
    const l = loaded();
    assert.equal(applyPack(a.db, l.pack!, options(a.dir, l)).committed, true);
    const ex = exportPack(a.db, a.dir, { id: 'site-a', name: 'Site A', segment: 'villa', level: 'confort', version: '1.0.0', gatewayAccounts: [{ user: 'gw1', detectors: ['F-2', 'T-*'] }] });
    assert.deepEqual(ex.errors, []);
    const text = JSON.stringify(ex.pack);
    for (const secret of [PASSWORD, USERNAME, EMAIL, PHONE]) assert.ok(!text.includes(secret), `export contient ${secret}`);
    assert.deepEqual(findSecrets(ex.pack), []);
    const dir = writePack(ex.pack, Object.fromEntries(ex.files.map((f) => [f.path, f.body])));
    const l2 = loadPack(dir);
    assert.deepEqual(l2.errors, []);
    // Reponses a la reinstallation : identifiants et adresses (les seules choses que le pack ne contient pas).
    const byKind: Record<string, string> = { username: USERNAME, password: PASSWORD, 'address:email': EMAIL, 'address:whatsapp': PHONE };
    const got = collectAnswers(l2.questions, Object.fromEntries(l2.questions.map((q) => [q.key, byKind[q.kind]])), {});
    assert.deepEqual([got.errors, got.missing], [[], []]);
    const b = freshSite();
    const r = applyPack(b.db, l2.pack!, options(b.dir, l2, { answers: got.answers }));
    assert.equal(r.error, null, formatReport(r, true));
    assert.deepEqual(installation(b.db, KEY), installation(a.db, KEY));
    const planOf = (s: { db: DatabaseSync; dir: string }) => readFileSync(join(s.dir, (s.db.prepare('SELECT plan_file FROM floor WHERE plan_file IS NOT NULL').get() as { plan_file: string }).plan_file));
    assert.ok(planOf(a).equals(planOf(b)));
    a.db.close();
    b.db.close();
  });

  it('export refuse s\'il resterait un secret (mot de passe ecrit dans un chemin RTSP)', () => {
    const site = freshSite();
    const l = loaded();
    applyPack(site.db, l.pack!, options(site.dir, l));
    site.db.prepare("UPDATE camera_source SET rtsp_path = '/live?user=admin&password=x1' WHERE device_id = 'CAM-1'").run();
    const ex = exportPack(site.db, site.dir, { id: 'x', name: 'X', segment: 'autre', level: 'essentiel', version: '1.0.0' });
    assert.equal(ex.pack, null);
    assert.match(ex.errors.join('\n'), /export refuse, devices\[\d\]\.source\.path : secret en clair/);
    site.db.close();
  });

  it('journal et rapport sans secret', () => {
    const site = freshSite();
    const l = loaded();
    const r = applyPack(site.db, l.pack!, options(site.dir, l));
    assert.equal(r.committed, true);
    const journal = JSON.stringify(site.db.prepare('SELECT * FROM audit_log').all());
    for (const secret of [PASSWORD, USERNAME]) assert.ok(!journal.includes(secret), `journal contient ${secret}`);
    assert.ok(!journal.includes(EMAIL), 'adresse complete au journal');
    const shown = formatReport(r, true);
    for (const secret of [PASSWORD, USERNAME, EMAIL]) assert.ok(!shown.includes(secret), `rapport contient ${secret}`);
    site.db.close();
  });

  it('qualification : le registre fait foi ; apply exige --allow-unqualified', () => {
    const l = loaded();
    assert.deepEqual(qualify(l.pack!, null).unqualified.map((u) => u.deviceId), ['CAM-1', 'F-2']);
    const dir = mkdtempSync(join(tmpdir(), 'psim-registre-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify({ models: { 'heiman-hs1sa-e': { status: 'qualified' }, 'camera-ip-onvif': { status: 'to_qualify' } } }));
    const q = qualify(l.pack!, readRegistry(file).registry);
    assert.deepEqual(q.unqualified.map((u) => `${u.deviceId}:${u.source}`), ['CAM-1:pack', 'CAM-2:registre']);
    assert.match(q.warnings.join(), /camera-ip-onvif declare « qualified » dans le pack, mais « to_qualify » dans le registre/);
    writeFileSync(file, '{ illisible');
    assert.match(readRegistry(file).warning!, /registre de qualification illisible/);

    const site = freshSite();
    site.db.close();
    const before = readFileSync(site.dbFile);
    const packDir = writePack(basePack());
    const answers = join(packDir, 'reponses.json');
    writeFileSync(answers, JSON.stringify(ANSWERS));
    const refused = cli(['apply', packDir, '--data-dir', site.dir, '--answers', answers, '--yes']);
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /Application refusee : 2 equipement\(s\) de modele a qualifier/);
    assert.ok(readFileSync(site.dbFile).equals(before));
    const ok = cli(['apply', packDir, '--data-dir', site.dir, '--answers', answers, '--yes', '--allow-unqualified', '--by', 'Kone Ibrahim'], { PSIM_SMTP_HOST: 'smtp.exemple.ci', PSIM_SMTP_FROM: 'psim@exemple.ci' });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /PLAN \(simulation sur une copie de la base\)/);
    assert.match(ok.out, /Pack applique et inscrit au journal \(pack_applique essai-complet@1\.2\.0\)/);
    assert.match(ok.out, /npm run commission -- sheet --pack .* --out recette-essai-complet\.html/);
    assert.ok(!ok.out.includes(PASSWORD) && !ok.out.includes(EMAIL));
    // Sans --yes et sans terminal : refuse apres avoir montre le plan.
    const noYes = cli(['apply', packDir, '--data-dir', site.dir, '--answers', answers, '--allow-unqualified']);
    assert.equal(noYes.status, 1);
    assert.match(noYes.out, /Confirmation requise : relancer avec --yes/);
  });

  it('refuse d\'appliquer pendant que le PSIM tourne (verrou du dossier de donnees)', () => {
    const site = freshSite();
    site.db.close();
    writeFileSync(join(site.dir, 'psim.lock'), String(process.pid));
    const packDir = writePack(basePack());
    const r = cli(['apply', packDir, '--data-dir', site.dir, '--yes', '--allow-unqualified']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Le PSIM tourne sur ce dossier de donnees \(PID \d+\)/);
    // Le plan, lui, reste possible PSIM en marche.
    assert.equal(cli(['plan', packDir, '--data-dir', site.dir]).status, 0);
  });

  it('check : erreurs listees, code de sortie 1', () => {
    const p = basePack();
    (((p.devices as Record<string, unknown>[])[0].source as Record<string, unknown>).credentials as Record<string, unknown>).password = 'admin123';
    const r = cli(['check', writePack(p)]);
    assert.equal(r.status, 1);
    assert.match(r.out, /Pack refuse : \d+ erreur\(s\)/);
    assert.match(r.out, /credentials\.password : secret en clair interdit/);
    assert.equal(cli(['check', join(ROOT, 'packs', 'villa-essentiel')]).status, 0);
  });

  it('recette : « le pack est complet », et la fiche cite le pack et sa version', () => {
    const site = freshSite();
    const l = loaded();
    applyPack(site.db, l.pack!, options(site.dir, l));
    const ctx = { gatewayAccounts: [{ user: 'gw1', detectors: ['F-2', 'T-*'] }], envLevel1: 0, unqualified: qualify(l.pack!, null).unqualified };
    const status = (checks: ReturnType<typeof checkPack>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
    assert.deepEqual(status(checkPack(site.db, l.pack!, ctx)), {
      'pack-devices': 'ok', 'pack-sources': 'ok', 'pack-cameras': 'ok', 'pack-silent': 'warn', 'pack-recipients': 'ok', 'pack-gateway': 'ok', 'pack-models': 'warn', 'pack-applied': 'ok',
    });
    // Source retiree, camera liee devenue simulee, detecteur hors ligne, compte de passerelle incomplet : signales.
    site.db.prepare("DELETE FROM tuya_source WHERE device_id = 'F-1'").run();
    site.db.prepare("DELETE FROM camera_source WHERE device_id = 'CAM-2'").run();
    site.db.prepare("UPDATE device SET status = 'offline' WHERE id = 'F-2'").run();
    const checks = checkPack(site.db, l.pack!, { ...ctx, gatewayAccounts: [{ user: 'gw1', detectors: ['F-2'] }] });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.match(by['pack-sources'].detail, /F-1 \(tuya\)/);
    assert.match(by['pack-cameras'].detail, /sans source reelle \(simulee\) : CAM-2/);
    assert.equal(by['pack-silent'].status, 'fail');
    assert.match(by['pack-gateway'].detail, /T-\* non autorise/);
    const html = buildSheet({ site: 'Villa essai', generatedAt: Date.now(), devices: [], pack: { id: 'essai-complet', version: '1.2.0', name: 'Pack', appliedAt: Date.now(), by: 'Kone Ibrahim' } });
    assert.match(html, /Recette du pack essai-complet, version 1\.2\.0/);
    assert.match(html, /par Kone Ibrahim/);
    site.db.close();
  });

  it('plan sans base : message clair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-vide-'));
    const r = cli(['plan', writePack(basePack()), '--data-dir', dir]);
    assert.equal(r.status, 2);
    assert.match(r.out, /Aucune base/);
    assert.equal(existsSync(join(dir, 'psim.db')), false);
  });
});
