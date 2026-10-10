/** Outils communs des essais de la passerelle : dossier temporaire, broker du PSIM (le vrai, server/mqtt.ts), attente. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startBroker } from '../../server/mqtt.ts';
import type { Broker, Gateway } from '../../server/mqtt.ts';
import { loadConfig } from '../src/config.ts';
import type { GatewayConfig } from '../src/config.ts';
import type { Level, Logger } from '../src/log.ts';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const FIXTURES = join(import.meta.dirname, 'fixtures', 'modules');
export const GW_USER = 'gw1';
export const GW_PASSWORD = 'Mot-de-passe-passerelle-1';

export function tempDir(cleanup: (() => void)[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gamr-gw-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

export interface Received {
  id: string;
  payload: { state?: string; event?: string; value?: number; ts?: number; msgId?: string };
}

/** Broker du PSIM (code reel) avec un moteur factice qui enregistre ce qu'il recoit. */
export async function psimBroker(port: number, received: Received[], gateways?: Gateway[]): Promise<Broker> {
  const engine = { handleDetectorMessage: (id: string, payload: unknown) => void received.push({ id, payload: payload as Received['payload'] }) } as never;
  return startBroker(engine, {
    host: '127.0.0.1',
    port,
    user: 'psim',
    password: 'Mot-de-passe-mqtt-solide-3',
    gateways: gateways ?? [{ user: GW_USER, password: GW_PASSWORD, detectors: ['D-*', 'GW-*'] }],
  });
}

export function writeConfig(dir: string, cfg: Record<string, unknown>, name = 'config.json'): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

/** Configuration d'essai : temporisations courtes, modules factices. */
export function testConfig(dir: string, port: number, modules: unknown[] = [], extra: Record<string, unknown> = {}): GatewayConfig {
  const file = writeConfig(dir, {
    psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, password: GW_PASSWORD },
    dataDir: 'data',
    retry: { minMs: 100, maxMs: 400 },
    moduleRetry: { minMs: 100, maxMs: 400 },
    log: { file: false },
    modules,
    ...extra,
  });
  return loadConfig(file, { modulesDir: FIXTURES });
}

export function memoryLogger(): Logger & { lines: { level: Level; text: string }[]; has(re: RegExp): boolean } {
  const lines: { level: Level; text: string }[] = [];
  return {
    lines,
    log(level, text) {
      lines.push({ level, text });
    },
    has: (re) => lines.some((l) => re.test(l.text)),
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`delai depasse en attendant : ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
