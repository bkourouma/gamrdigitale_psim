import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUser } from '../../portal/server/accounts.ts';
import type { NewUser } from '../../portal/server/accounts.ts';
import { addOrganization, addSite } from '../../portal/server/admin.ts';
import { createPortalApp } from '../../portal/server/api.ts';
import { openPortalDb } from '../../portal/server/db.ts';
import { siteKey } from '../../portal/server/keys.ts';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { beginHistory } from '../../server/history.ts';
import { SIGNATURE_HEADER, SITE_HEADER, TIME_HEADER, buildSiteSummary, sign } from '../../server/portal.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { createRiskService } from '../../server/risk.ts';
import { seedDemo } from '../../server/seed.ts';

export const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
export const HOUR = 3_600_000;
export const MASTER = Buffer.alloc(32, 7);
export const PASSWORD = 'Un-vrai-mot-de-passe-9';

export interface Portal {
  db: ReturnType<typeof openPortalDb>;
  base: string;
  setNow: (t: number) => void;
  now: () => number;
  close: () => Promise<void>;
}

/** Un vrai portail (base en memoire, serveur HTTP sur un port libre) avec une horloge que le test commande. */
export async function startPortal(staleAfterMs = 900_000): Promise<Portal> {
  const db = openPortalDb(':memory:');
  let clock = NOW;
  const app = createPortalApp({ db, master: MASTER, now: () => clock, staleAfterMs, webDir: join(import.meta.dirname, '..', '..', 'portal', 'web') });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    db,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setNow: (t) => void (clock = t),
    now: () => clock,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Organisation + site + (optionnel) comptes, comme le ferait la ligne de commande d'administration. */
export function provision(db: Portal['db'], org: string, siteId: string, siteName: string): { orgId: number } {
  const orgId = db.prepare('SELECT id FROM organization WHERE name = ?').get(org)
    ? (db.prepare('SELECT id FROM organization WHERE name = ?').get(org) as { id: number }).id
    : addOrganization(db, org, NOW);
  addSite(db, org, siteId, siteName, NOW);
  return { orgId };
}

export function addUser(db: Portal['db'], user: NewUser, password = PASSWORD, mustChange = false): void {
  createUser(db, user, password, NOW);
  if (!mustChange) db.prepare('UPDATE portal_user SET must_change_password = 0 WHERE username = ?').run(user.username);
}

/** Un resume REEL : produit par le PSIM (moteur, historique, construction du resume), pas ecrit a la main. */
export function makeSummary(siteId: string, opts: { at?: number; risk?: boolean; mutate?: (engine: ReturnType<typeof createEngine>, goTo: (t: number) => void) => void } = {}): SiteSummary {
  const at = opts.at ?? NOW;
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', '..', 'seed'));
  let clock = at - 30 * 24 * HOUR;
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  opts.mutate?.(engine, (t) => void (clock = t));
  // Avec `risk` : l'indice GAMR des evaluations de demonstration, et un point d'historique la veille et le jour meme.
  const risk = opts.risk ? createRiskService(db, engine, { now: () => clock }) : null;
  if (risk) {
    clock = at - 24 * HOUR;
    risk.recordHistory();
    clock = at;
    risk.recordHistory();
  }
  return buildSiteSummary(db, { siteId, version: '9.9.9', startedAt: at - 1000, now: at, ...(risk ? { risk: () => risk.overview() } : {}) });
}

export interface SignedPost {
  siteId?: string;
  key?: string;
  timestamp?: number;
  body: string;
  headers?: Record<string, string>;
}

/** Envoie un corps signe comme le fait le PSIM (ou, en changeant un champ, comme le ferait un faussaire). */
export async function post(portal: Portal, s: SignedPost): Promise<{ status: number; json: Record<string, unknown> }> {
  const siteId = s.siteId ?? 'site-a';
  const timestamp = s.timestamp ?? portal.now();
  const key = s.key ?? siteKey(MASTER, siteId, 1);
  const res = await fetch(`${portal.base}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SITE_HEADER]: siteId, [TIME_HEADER]: String(timestamp), [SIGNATURE_HEADER]: sign(key, siteId, timestamp, s.body), ...s.headers },
    body: s.body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Ouvre une session et renvoie le cookie a presenter ensuite. */
export async function login(portal: Portal, username: string, password = PASSWORD): Promise<string> {
  const res = await fetch(`${portal.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (res.status !== 200) throw new Error(`connexion refusee (${res.status})`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

export async function get(portal: Portal, path: string, cookie?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${portal.base}${path}`, { headers: cookie ? { cookie } : {} });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
