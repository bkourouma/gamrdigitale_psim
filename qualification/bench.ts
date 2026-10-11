/**
 * Banc d'essai SIMULE : rejoue, sans aucun materiel, la sequence d'une fiche de recette contre un vrai moteur PSIM
 * (base temporaire, horloge simulee) pour VERIFIER LA FICHE ELLE-MEME : une etape qu'on ne sait pas derouler, ou dont le
 * resultat attendu contredit le comportement reel du PSIM, est un defaut de la fiche.
 *
 * Ce n'est JAMAIS un essai materiel : le rapport porte `real_hardware: false` en dur, ne cree aucun fichier de resultat et ne
 * touche pas au registre. Les etapes qui exigent un humain devant l'equipement (mesure, geste, signature) sont « physiques » :
 * elles ne sont pas rejouees et ne peuvent etre validees que sur le materiel reel.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCameraHealth } from '../server/camerahealth.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { beginHistory } from '../server/history.ts';
import { stepsFor, benchConfigFor } from './fiches.ts';
import type { BenchConfig, BenchKind, Fiche, Msg, Step } from './fiches.ts';

const T0 = Date.parse('2026-06-15T12:00:00Z');
const MIN = 60_000;
const BANC = 'BANC-01';

export type BenchOutcome = 'rejoue' | 'echec' | 'physique';
export interface BenchStepReport {
  id: string;
  titre: string;
  obligatoire: boolean;
  kind: BenchKind;
  outcome: BenchOutcome;
  detail: string;
}
export interface BenchReport {
  fiche: string;
  profile: string | null;
  /** Toujours faux : un banc simule n'est jamais un essai materiel. */
  real_hardware: false;
  steps: BenchStepReport[];
  replayed: number;
  physical: number;
  failed: number;
  ok: boolean;
}

const DEFAULT_CONFIG: BenchConfig = { categorie: 'intrusion', alarme: { event: 'intrusion' }, normal: { event: 'clear' }, silence_s: 120 };

interface IncidentRow {
  id: number;
  status: string;
  opened_at: number;
  received_at: number | null;
}

/** Un PSIM de demonstration jetable : base temporaire, horloge simulee, un detecteur de banc. */
function makeEnv(config: BenchConfig, persistent: boolean = false) {
  // Base en memoire (rapide) ; sur fichier seulement pour rejouer un arret brutal du PSIM.
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'psim-banc-')) : null;
  const file = dir ? join(dir, 'psim.db') : ':memory:';
  let clock = T0;
  let armed = true;
  const silent: string[] = [];
  const hooks: string[] = [];
  let db = openDb(file);
  const build = () =>
    createEngine(db, () => {}, () => clock, {
      silentTimeoutMs: 0,
      isArmed: () => armed,
      onDetectorSilent: (d) => silent.push(d.id),
      onIncidentEvent: (_i, kind) => hooks.push(kind),
    });
  let engine = build();
  const seuils = config.seuils;
  engine.createDevice('banc', {
    id: BANC,
    kind: 'detector',
    name: 'Equipement en recette',
    zone: 'Atelier',
    category: config.categorie,
    heartbeatS: config.silence_s ?? 0,
    ...(seuils ? { warnAt: seuils.warnAt, alarmAt: seuils.alarmAt, direction: seuils.direction, valueUnit: seuils.unit } : {}),
  });
  let seq = 0;
  const send = (m: Msg, extra: Record<string, unknown> = {}) => engine.ingest(BANC, { ...m, ...extra });
  const sendOk = (m: Msg, extra: Record<string, unknown> = {}) => {
    const r = send(m, extra);
    if (!r.ok) throw new Error(`le PSIM refuse le message ${JSON.stringify(m)} : ${r.error}`);
    return r;
  };
  return {
    get engine() {
      return engine;
    },
    get db() {
      return db;
    },
    dir,
    hooks,
    silent,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    setArmed: (v: boolean) => void (armed = v),
    nextId: () => `banc-${(seq += 1)}`,
    send,
    sendOk,
    status: () => engine.getDevice(BANC)?.status ?? 'inconnu',
    incidents: () => db.prepare('SELECT id, status, opened_at, received_at FROM incident WHERE detector_id = ? ORDER BY id').all(BANC) as unknown as IncidentRow[],
    /** Arret brutal puis relance du PSIM sur la meme base (rien n'est ferme proprement : pas de sauvegarde, pas d'arret). */
    restart: () => {
      if (!dir) throw new Error('redemarrage impossible sur une base en memoire');
      db.close();
      db = openDb(file);
      engine = build();
    },
    cleanup: () => {
      try {
        db.close();
      } catch {
        // deja ferme
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Env = ReturnType<typeof makeEnv>;

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`configuration de banc incomplete : ${what}`);
  return v;
};

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Ouvre un incident par le message d'alarme du banc et le renvoie. */
function trigger(env: Env, cfg: BenchConfig, extra: Record<string, unknown> = {}): IncidentRow {
  const before = env.incidents().length;
  env.sendOk(need(cfg.alarme, 'alarme'), { msgId: env.nextId(), ...extra });
  const rows = env.incidents();
  expect(rows.length === before + 1, `le declenchement n'a pas ouvert un incident (incidents : ${before} -> ${rows.length}, etat : ${env.status()})`);
  return rows[rows.length - 1];
}

function goOffline(env: Env, cfg: BenchConfig): void {
  const s = need(cfg.silence_s, 'silence_s');
  env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
  env.advance((s - 1) * 1000);
  expect(env.engine.checkSilentDetectors().length === 0 && env.status() === 'normal', `l'equipement ne doit pas etre declare muet avant ${s} s`);
  env.advance(2000);
  const muets = env.engine.checkSilentDetectors();
  expect(muets.includes(BANC), `apres ${s} s de silence l'equipement n'est pas declare muet (etat : ${env.status()})`);
  expect(env.status() === 'offline', `etat attendu « offline » apres le silence, obtenu « ${env.status()} »`);
}

type Scenario = (env: Env, cfg: BenchConfig) => string | Promise<string>;

const SCENARIOS: Record<Exclude<BenchKind, 'physique'>, Scenario> = {
  normal(env, cfg) {
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    expect(env.status() === 'normal', `etat attendu « normal », obtenu « ${env.status()} »`);
    expect(env.incidents().length === 0, 'un premier message normal ne doit ouvrir aucun incident');
    return 'premier message normal : etat Normal, aucun incident';
  },

  declenchement(env, cfg) {
    const inc = trigger(env, cfg);
    expect(['alarm', 'prealarm'].includes(env.status()), `etat attendu alarme, obtenu « ${env.status()} »`);
    expect(env.hooks.includes('opened'), "le declenchement n'a pas declenche la notification d'ouverture d'incident");
    return `message ${JSON.stringify(cfg.alarme)} -> incident n°${inc.id} ouvert, etat « ${env.status()} », notification d'ouverture appelee`;
  },

  retour(env, cfg) {
    const inc = trigger(env, cfg);
    env.advance(20_000);
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    expect(env.status() === 'normal', `etat attendu « normal » apres le retour, obtenu « ${env.status()} »`);
    const row = env.incidents().find((i) => i.id === inc.id);
    expect(row?.status === 'open', "le retour a la normale ne doit pas fermer l'incident tout seul");
    env.engine.acknowledge(inc.id, 'operateur');
    env.engine.close(inc.id, 'operateur', 'false_alarm', 'recette');
    return 'retour a Normal, incident encore ouvert jusqu\'a l\'acquittement puis la cloture par un operateur';
  },

  repetition(env, cfg) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const inc = trigger(env, cfg);
      env.advance(5000);
      env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
      env.engine.acknowledge(inc.id, 'operateur');
      env.engine.close(inc.id, 'operateur', 'false_alarm', 'recette');
      env.advance(5000);
    }
    expect(env.incidents().length === n, `${n} cycles auraient du ouvrir ${n} incidents, obtenu ${env.incidents().length}`);
    return `${n} cycles declenchement / retour : ${n} incidents, aucun manque, aucun double`;
  },

  latence(env, cfg) {
    env.advance(MIN);
    const ts = env.now() - 3000;
    const inc = trigger(env, cfg, { ts });
    expect(inc.opened_at === ts, "l'incident doit porter l'heure reelle du fait (ts du message)");
    return "incident ouvert a l'instant de la reception, date de l'heure du message ; la latence reelle se mesure sur le materiel";
  },

  defaut(env, cfg) {
    env.sendOk(need(cfg.defaut, 'defaut'), { msgId: env.nextId() });
    expect(env.status() === 'fault', `etat attendu « fault » apres le message de defaut, obtenu « ${env.status()} »`);
    expect(env.incidents().length === 0, 'un defaut ne doit pas ouvrir un incident');
    trigger(env, cfg);
    expect(['alarm', 'prealarm'].includes(env.status()), `une alarme pendant un defaut doit l'emporter (etat : ${env.status()})`);
    return 'defaut -> etat Defaut sans incident ; alarme pendant le defaut -> l\'alarme l\'emporte';
  },

  sabotage(env, cfg) {
    const alarme = need(cfg.alarme, 'alarme');
    const note: string[] = [];
    if (cfg.categorie === 'intrusion' && !['tamper', 'panic', 'sos', 'fall'].includes(alarme.event ?? '')) {
      env.setArmed(false);
      env.sendOk(alarme, { msgId: env.nextId() });
      expect(env.incidents().length === 0, 'zone desarmee : une intrusion ne doit pas ouvrir d\'incident');
      env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
      note.push('zone desarmee : l\'intrusion est ignoree');
    }
    env.setArmed(false);
    env.sendOk(need(cfg.sabotage, 'sabotage'), { msgId: env.nextId() });
    expect(env.incidents().length === 1, 'zone desarmee : le sabotage doit ouvrir un incident (toujours actif)');
    note.push('le sabotage ouvre un incident meme zone desarmee');
    return note.join(' ; ');
  },

  liaison(env, cfg) {
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    if (cfg.liaison_perdue) {
      env.sendOk(cfg.liaison_perdue, { msgId: env.nextId() });
      expect(env.status() !== 'normal', `apres la perte de liaison l'etat ne doit pas rester « normal » (obtenu « ${env.status()} »)`);
      return `la passerelle signale la perte de liaison (${JSON.stringify(cfg.liaison_perdue)}) : etat « ${env.status()} », jamais Normal`;
    }
    goOffline(env, cfg);
    return `liaison coupee, aucun message pendant ${cfg.silence_s} s : etat « offline » (muet), jamais Normal`;
  },

  reprise(env, cfg) {
    goOffline(env, cfg);
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    expect(env.status() === 'normal', `la reprise doit remettre l'etat reel « normal », obtenu « ${env.status()} »`);
    goOffline(env, cfg);
    const inc = trigger(env, cfg);
    expect(['alarm', 'prealarm'].includes(env.status()), "une alarme qui arrive a la reprise doit etre prise en compte");
    return `reprise : etat « normal » ; alarme arrivant juste apres la reprise : incident n°${inc.id} ouvert`;
  },

  silence(env, cfg) {
    const s = need(cfg.silence_s, 'silence_s');
    goOffline(env, cfg);
    expect(env.silent.includes(BANC), 'la notification « detecteur muet » n\'a pas ete appelee');
    const audit = env.engine.listAudit(50).some((a) => a.action === 'detector_silent' && a.deviceId === BANC);
    expect(audit, 'le journal ne contient pas l\'entree detector_silent');
    return `muet apres ${s} s, notification « detecteur muet » appelee, journal complete, jamais Normal`;
  },

  redemarrage(env, cfg) {
    const s = need(cfg.silence_s, 'silence_s');
    const inc = trigger(env, cfg);
    env.advance(30_000);
    env.restart();
    expect(env.status() === 'alarm' || env.status() === 'prealarm', `l'etat d'alarme doit survivre au redemarrage (obtenu « ${env.status()} »)`);
    expect(env.incidents().filter((i) => i.status !== 'closed').length === 1, "l'incident ouvert doit survivre au redemarrage, sans doublon");
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    env.engine.acknowledge(inc.id, 'operateur');
    env.engine.close(inc.id, 'operateur', 'false_alarm', 'recette');
    expect(env.engine.checkSilentDetectors().length === 0, "l'equipement ne doit pas etre declare muet des le redemarrage (delai de grace)");
    env.advance(s * 1000 + 1000);
    expect(env.engine.checkSilentDetectors().includes(BANC), 'apres le redemarrage, le silence doit etre juge a partir du demarrage');
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    trigger(env, cfg);
    return "alarme et incident retrouves apres arret brutal ; delai de grace respecte ; le declenchement suivant ouvre bien un incident";
  },

  renvoi(env, cfg) {
    const alarme = need(cfg.alarme, 'alarme');
    const normal = need(cfg.normal, 'normal');
    env.advance(10 * MIN);
    const t1 = env.now() - 5 * MIN;
    // Renvoi dans l'ordre : alarme datee puis retour a la normale date, recus 5 minutes plus tard.
    env.sendOk(alarme, { ts: t1, msgId: 'renvoi-a1' });
    env.sendOk(normal, { ts: t1 + 30_000, msgId: 'renvoi-n1' });
    let rows = env.incidents();
    expect(rows.length === 1, `le renvoi doit ouvrir un seul incident, obtenu ${rows.length}`);
    expect(rows[0].opened_at === t1, "l'incident doit etre date de l'heure reelle du fait, pas de celle du renvoi");
    expect(rows[0].received_at !== null, 'l\'incident doit etre marque « recu en differe »');
    expect(env.status() === 'normal', `l'etat final doit etre l'etat reel « normal », obtenu « ${env.status()} »`);
    const dup = env.send(alarme, { ts: t1, msgId: 'renvoi-a1' });
    expect(dup.ok && dup.duplicate === true, 'le meme message renvoye doit etre reconnu comme doublon');
    expect(env.incidents().length === 1, 'un doublon ne doit pas creer un second incident');
    // Renvoi dans le desordre (retour a la normale arrive avant l'alarme plus ancienne) : l'alarme n'est pas perdue.
    const env2 = makeEnv(cfg);
    try {
      env2.advance(10 * MIN);
      const t2 = env2.now() - 5 * MIN;
      env2.sendOk(normal, { ts: t2 + 30_000, msgId: 'renvoi-n2' });
      env2.sendOk(alarme, { ts: t2, msgId: 'renvoi-a2' });
      rows = env2.incidents();
      expect(rows.length === 1 && rows[0].opened_at === t2, "une alarme ancienne arrivant apres le retour a la normale doit quand meme ouvrir un incident date de son heure reelle");
      expect(env2.status() === 'normal', `l'etat actuel ne doit pas etre ecrase par un message plus ancien (obtenu « ${env2.status()} »)`);
    } finally {
      env2.cleanup();
    }
    return 'renvoi apres coupure : incident date de l\'heure reelle, marque recu en differe, aucun doublon, ordre inverse sans alarme perdue';
  },

  'renvoi-direct'(env, cfg) {
    goOffline(env, cfg);
    const inc = trigger(env, cfg);
    expect(['alarm', 'prealarm'].includes(env.status()), "une alarme lue au retour de la liaison doit ouvrir l'incident");
    env.advance(5000);
    env.sendOk(need(cfg.normal, 'normal'), { msgId: env.nextId() });
    expect(env.status() === 'normal', 'retour a la normale attendu');
    return `liaison coupee : equipement « offline » (jamais Normal) ; alarme lue au retour : incident n°${inc.id} ouvert`;
  },

  'info-sans-incident'(env, cfg) {
    const info = need(cfg.info, 'info');
    for (let i = 0; i < 5; i++) {
      env.sendOk(info.ouvre, { msgId: env.nextId() });
      env.sendOk(info.ferme, { msgId: env.nextId() });
    }
    expect(env.incidents().length === 0, 'ouvrir et fermer ne doit ouvrir aucun incident');
    expect(env.status() === 'normal', `l'etat doit rester « normal » (obtenu « ${env.status()} »)`);
    return '5 ouvertures / fermetures : informations seulement, aucun incident, etat Normal';
  },

  async 'camera-sante'(env) {
    // Une camera reelle (source RTSP) dont le port ne repond plus : « hors ligne » apres 3 mesures, puis retour.
    env.engine.createDevice('banc', { id: 'CAM-BANC', kind: 'camera', name: 'Camera en recette', zone: '' });
    env.db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES ('CAM-BANC', 'rtsp', '192.0.2.10', 554)").run();
    let up = true;
    const audits: string[] = [];
    beginHistory(env.db, env.now(), null, null);
    const health = createCameraHealth({
      db: env.db,
      everyMs: MIN,
      now: env.now,
      probe: async () => up,
      audit: (action, deviceId, details) => {
        audits.push(action);
        env.engine.audit('systeme', action, { deviceId, details });
      },
    });
    env.advance(MIN);
    await health.check();
    up = false;
    for (let i = 0; i < 3; i++) {
      env.advance(MIN);
      await health.check();
    }
    expect(audits.includes('camera_offline'), 'apres 3 mesures sans reponse la camera doit etre declaree hors ligne au journal');
    up = true;
    env.advance(MIN);
    await health.check();
    expect(audits.includes('camera_online'), 'au retour de la camera, « en ligne » doit etre inscrit au journal');
    return 'camera injoignable : « hors ligne » au journal apres 3 mesures ; retour : « en ligne » (le test TCP prouve que l\'appareil repond, pas que l\'image est bonne)';
  },

  hooks(env, cfg) {
    const c = { ...DEFAULT_CONFIG, ...cfg };
    trigger(env, c);
    expect(env.hooks.includes('opened'), "l'ouverture d'un incident doit appeler la notification (niveau 1)");
    const env2 = makeEnv(c);
    try {
      goOffline(env2, c);
      expect(env2.silent.includes(BANC), 'un detecteur muet doit appeler la notification « detecteur muet »');
    } finally {
      env2.cleanup();
    }
    return 'ouverture d\'incident et detecteur muet appellent bien la notification (le canal lui-meme se verifie sur le materiel)';
  },
};

/** Un rejeu ne depend que du type d'etape et de la configuration de banc : on ne le refait pas pour un meme couple. */
const memo = new Map<string, { ok: boolean; detail: string }>();

/** Rejoue toute la sequence d'une fiche pour un profil. Ne modifie rien de durable. */
export async function runBench(fiche: Fiche, profile: string | null, dir?: string): Promise<BenchReport> {
  const steps: Step[] = stepsFor(fiche, profile, dir);
  const config = benchConfigFor(fiche, profile) ?? DEFAULT_CONFIG;
  const out: BenchStepReport[] = [];
  for (const s of steps) {
    const base = { id: s.id, titre: s.titre, obligatoire: s.obligatoire, kind: s.bench };
    if (s.bench === 'physique') {
      out.push({ ...base, outcome: 'physique', detail: 'a faire sur le materiel reel (geste, mesure ou signature humaine)' });
      continue;
    }
    const key = `${s.bench}|${JSON.stringify(config)}`;
    let done = memo.get(key);
    if (!done) {
      const env = makeEnv(config, s.bench === 'redemarrage');
      try {
        done = { ok: true, detail: await SCENARIOS[s.bench](env, config) };
      } catch (err) {
        done = { ok: false, detail: (err as Error).message };
      } finally {
        env.cleanup();
      }
      memo.set(key, done);
    }
    out.push({ ...base, outcome: done.ok ? 'rejoue' : 'echec', detail: done.detail });
  }
  const failed = out.filter((s) => s.outcome === 'echec').length;
  return {
    fiche: fiche.id,
    profile,
    real_hardware: false,
    steps: out,
    replayed: out.filter((s) => s.outcome === 'rejoue').length,
    physical: out.filter((s) => s.outcome === 'physique').length,
    failed,
    ok: failed === 0,
  };
}

export function formatBench(report: BenchReport): string {
  const lines = [`Banc d'essai SIMULE - fiche ${report.fiche}${report.profile ? ` [${report.profile}]` : ''} (aucun materiel : ne qualifie rien)`];
  for (const s of report.steps) {
    const mark = s.outcome === 'rejoue' ? 'REJOUE ' : s.outcome === 'echec' ? 'ECHEC  ' : 'PHYSIQUE';
    lines.push(`  ${mark} ${s.id}${s.obligatoire ? '' : ' (facultative)'} : ${s.detail}`);
  }
  lines.push(`  => ${report.replayed} rejouee(s), ${report.physical} physique(s) a faire sur le materiel, ${report.failed} echec(s)${report.ok ? '' : ' : LA FICHE EST A CORRIGER'}`);
  return lines.join('\n');
}
