/**
 * Detecteurs de fumee WiFi Tuya / Smart Life : l'etat de l'appareil, lu dans le cloud Tuya, devient l'etat d'un detecteur
 * INCENDIE du PSIM.
 *
 * Principe : un compte developpeur Tuya (Access ID + Access Secret, dans le .env) lie au compte Smart Life qui a appaire les
 * detecteurs. Le PSIM interroge l'API cloud Tuya a intervalle regulier (UNE requete groupee pour tous les detecteurs) et envoie
 * au moteur l'etat lu. Un detecteur WiFi sur pile dort presque toujours : il ne repond pas sur le reseau local, seul le cloud
 * connait son etat.
 *
 * Surete :
 *  - la sirene du detecteur sonne seule, sur place, que le PSIM l'entende ou non ; le PSIM ajoute l'incident et la notification ;
 *  - chaque lecture reussie vaut signe de vie : si le cloud ou Internet ne repond plus, les detecteurs passent « hors ligne »
 *    au bout de TUYA_SUPERVISION_S et la notification « detecteur muet » part (jamais un « Normal » fige) ;
 *  - un appareil connu du cloud mais declare « hors ligne » par Tuya (pile morte, WiFi coupe) n'envoie rien : meme effet ;
 *  - une alarme lue est renvoyee a chaque lecture tant qu'elle dure, et reste prioritaire meme si l'appareil est hors ligne ;
 *  - un appareil qui ne publie aucune donnee de fumee connue passe en « defaut » (jamais un « Normal » trompeur) ;
 *  - le secret Tuya n'apparait jamais dans un message, un journal ou une reponse ; aucune redirection n'est suivie.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './engine.ts';
import { PsimError } from './errors.ts';

/** Supervision posee sur un detecteur Tuya : plus longue que 2 lectures (cadence maximale 120 s), sinon « hors ligne » en boucle. */
export const TUYA_SUPERVISION_S = 300;

const REQUEST_TIMEOUT_MS = 10_000;
const BATCH = 20; // l'API accepte 20 appareils par requete groupee
const TOKEN_MARGIN_MS = 120_000;
const LOW_BATTERY_PERCENT = 15;
export const TUYA_ID = /^[A-Za-z0-9]{8,64}$/;

/** Codes de donnees « fumee » des detecteurs Tuya (selon le modele) ; la valeur « alarm » (ou vrai) signale de la fumee. */
const SMOKE_CODES = ['smoke_sensor_status', 'smoke_sensor_state', 'smoke_alarm'];

export interface TuyaStatusItem {
  code: string;
  value: unknown;
}

export interface TuyaDevice {
  id: string;
  name?: string;
  online?: boolean;
  status?: TuyaStatusItem[];
}

export type TuyaReading =
  | { kind: 'alarm' | 'normal' | 'fault'; reason: string }
  | { kind: 'silent'; reason: string }; // appareil hors ligne et sans alarme : on n'envoie rien

/** Etat PSIM d'un appareil Tuya (fonction pure, testee a part). */
export function readDevice(device: TuyaDevice): TuyaReading {
  const status = Array.isArray(device.status) ? device.status : [];
  const smoke = status.find((s) => s && typeof s.code === 'string' && SMOKE_CODES.includes(s.code));
  const alarming = (v: unknown) => v === 'alarm' || v === true || v === 1 || v === '1';
  if (smoke && alarming(smoke.value)) return { kind: 'alarm', reason: 'fumee detectee' };
  if (device.online === false) return { kind: 'silent', reason: "l'appareil est hors ligne pour Tuya (pile, WiFi)" };
  if (!smoke) {
    const codes = status.map((s) => s?.code).filter(Boolean).join(', ') || 'aucune';
    return { kind: 'fault', reason: `aucune donnee de fumee reconnue (${SMOKE_CODES.join(', ')}) ; donnees recues : ${codes}` };
  }
  const battery = status.find((s) => s?.code === 'battery_state')?.value;
  const percent = status.find((s) => s?.code === 'battery_percentage')?.value;
  if (battery === 'low' || (typeof percent === 'number' && percent <= LOW_BATTERY_PERCENT)) return { kind: 'fault', reason: 'pile faible' };
  return { kind: 'normal', reason: 'aucune fumee' };
}

// ---------------------------------------------------------------- client de l'API cloud

export class TuyaError extends Error {
  code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}

const FRIENDLY: Record<number, string> = {
  1004: "signature refusee : Access ID ou Access Secret incorrect (ou region du centre de donnees differente)",
  1106: 'permission refusee : lier le compte Smart Life au projet Tuya et souscrire aux services API du projet',
  28841002: "service API non souscrit au projet Tuya (onglet « Service API » du projet)",
  28841105: "le compte du projet n'a pas acces a cette region : verifier PSIM_TUYA_REGION",
  2406: "l'abonnement d'essai du projet Tuya est expire : le renouveler dans la console Tuya",
};

export interface TuyaClientDeps {
  accessId: string;
  accessSecret: string;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Signature des requetes Tuya (HMAC-SHA256, algorithme « nonce + en-tetes signes »). */
export function sign(accessId: string, secret: string, token: string, t: string, nonce: string, method: string, pathAndQuery: string, body = ''): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const stringToSign = `${method}\n${bodyHash}\n\n${pathAndQuery}`;
  return createHmac('sha256', secret).update(`${accessId}${token}${t}${nonce}${stringToSign}`).digest('hex').toUpperCase();
}

export function createTuyaClient(deps: TuyaClientDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let token: { value: string; expires: number } | null = null;

  async function call(method: 'GET', path: string, query: Record<string, string>, withToken: boolean): Promise<unknown> {
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${k}=${query[k]}`)
      .join('&');
    const pathAndQuery = qs ? `${path}?${qs}` : path;
    const t = String(now());
    const nonce = randomUUID();
    const tok = withToken ? await accessToken() : '';
    const headers: Record<string, string> = {
      client_id: deps.accessId,
      t,
      nonce,
      sign: sign(deps.accessId, deps.accessSecret, tok, t, nonce, method, pathAndQuery),
      sign_method: 'HMAC-SHA256',
    };
    if (withToken) headers.access_token = tok;
    let res: Response;
    try {
      res = await doFetch(`${deps.baseUrl}${pathAndQuery}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const e = err as Error;
      throw new TuyaError(e.name === 'TimeoutError' ? 'le cloud Tuya ne repond pas (delai depasse)' : `cloud Tuya injoignable (${e.message})`);
    }
    let body: { success?: boolean; result?: unknown; code?: number; msg?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TuyaError(`reponse illisible du cloud Tuya (HTTP ${res.status})`);
    }
    if (body.success !== true) {
      const code = typeof body.code === 'number' ? body.code : null;
      // Jeton refuse : on le jette, la prochaine requete en demande un neuf.
      if (code === 1010 || code === 1011) token = null;
      throw new TuyaError(code !== null && FRIENDLY[code] ? FRIENDLY[code] : `${String(body.msg ?? 'erreur Tuya').slice(0, 200)} (code ${code ?? res.status})`, code);
    }
    return body.result;
  }

  async function accessToken(): Promise<string> {
    if (token && token.expires - TOKEN_MARGIN_MS > now()) return token.value;
    token = null;
    const result = (await call('GET', '/v1.0/token', { grant_type: '1' }, false)) as { access_token?: unknown; expire_time?: unknown } | null;
    if (!result || typeof result.access_token !== 'string' || !result.access_token) throw new TuyaError('reponse de jeton inattendue du cloud Tuya');
    const seconds = typeof result.expire_time === 'number' && result.expire_time > 0 ? result.expire_time : 7200;
    token = { value: result.access_token, expires: now() + seconds * 1000 };
    return token.value;
  }

  /** Etat de plusieurs appareils (par groupes de 20). Un appareil inconnu du compte est simplement absent du resultat. */
  async function devices(ids: string[]): Promise<TuyaDevice[]> {
    const out: TuyaDevice[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      if (chunk.some((id) => !TUYA_ID.test(id))) throw new TuyaError('identifiant Tuya invalide');
      const result = (await call('GET', '/v1.0/devices', { device_ids: chunk.join(',') }, true)) as { devices?: unknown; list?: unknown } | unknown[] | null;
      const list = Array.isArray(result) ? result : Array.isArray(result?.devices) ? result.devices : Array.isArray(result?.list) ? result.list : [];
      for (const d of list as TuyaDevice[]) if (d && typeof d.id === 'string') out.push(d);
    }
    return out;
  }

  return { devices };
}

export type TuyaClient = ReturnType<typeof createTuyaClient>;

// ---------------------------------------------------------------- service

interface Row {
  device_id: string;
  tuya_id: string;
}

interface Link {
  state: 'connecting' | 'connected' | 'error';
  since: number;
  error: string | null;
  lastPoll: number | null;
  online: boolean | null;
  kind: string | null;
  reason: string | null;
}

export interface TuyaSourceView {
  configured: boolean;
  tuyaId: string | null;
  connection: { state: Link['state']; since: number; error: string | null; lastPoll: number | null; online: boolean | null; reading: string | null; reason: string | null } | null;
}

export interface TuyaDeps {
  db: DatabaseSync;
  engine: Pick<Engine, 'handleDetectorMessage' | 'audit' | 'getDevice'>;
  /** Absent : compte Tuya non configure (la source ne peut pas etre enregistree). */
  account: { accessId: string; accessSecret: string; baseUrl: string } | null;
  pollS: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Pour les tests : client deja construit (sinon le vrai reseau). */
  client?: TuyaClient;
}

export function createTuya(deps: TuyaDeps) {
  const { db, engine } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[tuya] ${m}`));
  const client = deps.client ?? (deps.account ? createTuyaClient(deps.account) : null);
  const links = new Map<string, Link>();
  let polling = false;
  let stopped = false;

  const rows = (): Row[] =>
    db
      .prepare("SELECT s.device_id, s.tuya_id FROM tuya_source s JOIN device d ON d.id = s.device_id WHERE d.kind = 'detector' AND d.category = 'fire'")
      .all() as unknown as Row[];

  function setLink(id: string, patch: Partial<Link>): void {
    const link = links.get(id) ?? { state: 'connecting', since: now(), error: null, lastPoll: null, online: null, kind: null, reason: null };
    if (patch.state && patch.state !== link.state) link.since = now();
    Object.assign(link, patch);
    links.set(id, link);
  }

  function fail(ids: string[], message: string): void {
    for (const id of ids) {
      if (links.get(id)?.error !== message) log(`${id} : ${message}`);
      setLink(id, { state: 'error', error: message });
    }
  }

  /** Une lecture de tous les detecteurs Tuya, en une requete groupee. Ne leve jamais d'exception. */
  async function poll(): Promise<void> {
    if (stopped || polling) return;
    const list = rows();
    if (list.length === 0) return;
    const ids = list.map((r) => r.device_id);
    if (!client) return fail(ids, "compte Tuya non configure sur le serveur (PSIM_TUYA_ACCESS_ID et PSIM_TUYA_ACCESS_SECRET)");
    polling = true;
    try {
      const found = new Map((await client.devices(list.map((r) => r.tuya_id))).map((d) => [d.id, d]));
      if (stopped) return;
      for (const row of list) {
        const device = found.get(row.tuya_id);
        if (!device) {
          fail([row.device_id], "appareil introuvable dans le compte Tuya (verifier son identifiant, et que le compte Smart Life est lie au projet Tuya)");
          continue;
        }
        const reading = readDevice(device);
        setLink(row.device_id, { state: 'connected', error: null, lastPoll: now(), online: device.online ?? null, kind: reading.kind, reason: reading.reason });
        if (reading.kind === 'silent') continue; // aucun signe de vie : la supervision fera son travail
        engine.handleDetectorMessage(row.device_id, { state: reading.kind });
      }
    } catch (err) {
      fail(ids, err instanceof TuyaError ? err.message : `erreur inattendue (${(err as Error).message})`);
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => void poll(), Math.max(10, deps.pollS) * 1000);
  timer.unref?.();

  /** Relit la configuration (apres un changement de source) : oublie les detecteurs retires, lit tout de suite. */
  function reload(): void {
    if (stopped) return;
    const wanted = new Set(rows().map((r) => r.device_id));
    for (const id of links.keys()) if (!wanted.has(id)) links.delete(id);
    // Lecture immediate seulement pour un detecteur nouveau : un simple deplacement sur le plan ne consomme aucun appel du cloud.
    let added = false;
    for (const id of wanted) {
      if (links.has(id)) continue;
      setLink(id, {});
      added = true;
    }
    if (added) void poll();
  }

  function view(detectorId: string): TuyaSourceView {
    const row = db.prepare('SELECT tuya_id FROM tuya_source WHERE device_id = ?').get(detectorId) as { tuya_id: string } | undefined;
    const configured = client !== null;
    if (!row) return { configured, tuyaId: null, connection: null };
    const link = links.get(detectorId);
    const connection: NonNullable<TuyaSourceView['connection']> = link
      ? { state: link.state, since: link.since, error: link.error, lastPoll: link.lastPoll, online: link.online, reading: link.kind, reason: link.reason }
      : { state: 'error', since: now(), error: 'lecture non demarree', lastPoll: null, online: null, reading: null, reason: null };
    return { configured, tuyaId: row.tuya_id, connection };
  }

  function needClient(): TuyaClient {
    if (!client) throw new PsimError(400, "Le compte Tuya n'est pas configure sur le serveur : renseigner PSIM_TUYA_ACCESS_ID et PSIM_TUYA_ACCESS_SECRET dans le fichier .env, puis redemarrer le PSIM (voir docs/TUYA.md)");
    return client;
  }

  function cleanId(value: unknown): string {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!TUYA_ID.test(id)) throw new PsimError(400, "Identifiant d'appareil Tuya invalide (lettres et chiffres, tel qu'affiche dans la console Tuya)");
    return id;
  }

  function setSource(actor: string, detectorId: string, input: Record<string, unknown>): TuyaSourceView {
    const detector = engine.getDevice(detectorId);
    if (!detector || detector.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    if (detector.category !== 'fire') throw new PsimError(400, 'Un detecteur de fumee Tuya alimente un detecteur INCENDIE : changer d\'abord sa categorie');
    needClient();
    const tuyaId = cleanId(input.deviceId);
    const taken = db.prepare('SELECT device_id FROM tuya_source WHERE tuya_id = ? AND device_id <> ?').get(tuyaId, detectorId) as { device_id: string } | undefined;
    if (taken) throw new PsimError(409, `Cet appareil Tuya alimente deja le detecteur ${taken.device_id}`);
    db.prepare('INSERT INTO tuya_source (device_id, tuya_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET tuya_id = excluded.tuya_id').run(detectorId, tuyaId);
    // Supervision obligatoire : sans elle, un cloud muet laisserait le detecteur « Normal » indefiniment.
    let supervision = '';
    if (!detector.heartbeatS || detector.heartbeatS < TUYA_SUPERVISION_S) {
      db.prepare('UPDATE device SET heartbeat_s = ? WHERE id = ?').run(TUYA_SUPERVISION_S, detectorId);
      supervision = ` ; supervision ${TUYA_SUPERVISION_S} s`;
    }
    engine.audit(actor, 'tuya_source_updated', { deviceId: detectorId, details: `appareil Tuya ${tuyaId}${supervision}` });
    links.delete(detectorId);
    reload();
    return view(detectorId);
  }

  function removeSource(actor: string, detectorId: string): void {
    const res = db.prepare('DELETE FROM tuya_source WHERE device_id = ?').run(detectorId);
    if (Number(res.changes) === 0) throw new PsimError(404, 'Aucune source Tuya pour ce detecteur');
    engine.audit(actor, 'tuya_source_removed', { deviceId: detectorId });
    links.delete(detectorId);
  }

  /** Essai : lit l'appareil une fois et montre ce que le cloud en dit (jamais d'incident, rien n'est envoye au moteur). */
  async function test(tuyaIdRaw: unknown): Promise<{ ok: boolean; message: string; name: string | null; online: boolean | null; reading: string | null; data: { code: string; value: string }[] }> {
    const c = needClient();
    const tuyaId = cleanId(tuyaIdRaw);
    let device: TuyaDevice | undefined;
    try {
      device = (await c.devices([tuyaId])).find((d) => d.id === tuyaId);
    } catch (err) {
      return { ok: false, message: err instanceof TuyaError ? err.message : (err as Error).message, name: null, online: null, reading: null, data: [] };
    }
    if (!device) {
      return { ok: false, message: "Compte Tuya joint, mais cet appareil n'y est pas : verifier l'identifiant et que le compte Smart Life est lie au projet Tuya (onglet « Appareils » du projet)", name: null, online: null, reading: null, data: [] };
    }
    const reading = readDevice(device);
    const data = (device.status ?? []).slice(0, 40).map((s) => ({ code: String(s.code).slice(0, 60), value: String(JSON.stringify(s.value) ?? '').slice(0, 60) }));
    const online = device.online ?? null;
    const ok = reading.kind === 'normal' || reading.kind === 'alarm' || (reading.kind === 'fault' && reading.reason === 'pile faible');
    const text =
      reading.kind === 'alarm'
        ? 'FUMEE signalee par le detecteur en ce moment'
        : reading.kind === 'silent'
          ? `l'appareil est connu mais ${reading.reason}`
          : reading.kind === 'fault'
            ? reading.reason
            : 'connecte ; aucune fumee, appareil en ligne';
    return { ok, message: `${ok ? 'Appareil lu' : 'Appareil lu, mais'} : ${text}`, name: device.name ? String(device.name).slice(0, 80) : null, online, reading: reading.kind, data };
  }

  function stop(): void {
    stopped = true;
    clearInterval(timer);
    links.clear();
  }

  return { reload, view, setSource, removeSource, test, poll, stop };
}

export type TuyaService = ReturnType<typeof createTuya>;
