/**
 * Bout en bout, sans aucun faux maillon cote PSIM : automate Modbus TCP (petit serveur d'essai) -> module modbus -> socle
 * de la passerelle (file disque, liaison MQTT) -> broker du PSIM (server/mqtt.ts, compte de passerelle) -> moteur du PSIM
 * (server/engine.ts, base SQLite) -> incident ouvert avec le bon motif (event).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { startBroker } from '../../server/mqtt.ts';
import { loadConfig } from '../src/config.ts';
import { startRuntime } from '../src/runtime.ts';
import { freePort, GW_PASSWORD, GW_USER, memoryLogger, tempDir, waitFor, writeConfig } from './helpers.ts';

/** Automate minimal : entrees TOR (fonction 2) seulement, adresses 0..15. */
function fakePlc() {
  const inputs = new Array<boolean>(16).fill(false);
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => undefined);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 12) {
        const f = buf.subarray(0, 12);
        buf = buf.subarray(12);
        const tid = f.readUInt16BE(0);
        const unit = f.readUInt8(6);
        const fn = f.readUInt8(7);
        const address = f.readUInt16BE(8);
        const quantity = f.readUInt16BE(10);
        let pdu: Buffer;
        if (fn !== 2 || address + quantity > inputs.length) pdu = Buffer.from([fn | 0x80, 2]);
        else {
          const bytes = Buffer.alloc(Math.ceil(quantity / 8));
          for (let i = 0; i < quantity; i++) if (inputs[address + i]) bytes[i >> 3]! |= 1 << (i & 7);
          pdu = Buffer.concat([Buffer.from([fn, bytes.length]), bytes]);
        }
        const h = Buffer.alloc(7);
        h.writeUInt16BE(tid, 0);
        h.writeUInt16BE(0, 2);
        h.writeUInt16BE(pdu.length + 1, 4);
        h.writeUInt8(unit, 6);
        sock.write(Buffer.concat([h, pdu]));
      }
    });
  });
  return {
    inputs,
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});

describe('bout en bout : module -> socle -> broker du PSIM -> moteur -> incident', () => {
  it('une coupure secteur lue sur un automate Modbus ouvre un incident « power_loss » dans le PSIM, puis le retour est vu', { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    // PSIM : vraie base, vrai moteur, vrai broker avec un compte de passerelle limite a « M-* »
    const db = openDb(join(dir, 'psim.db'));
    cleanup.push(() => db.close());
    const engine = createEngine(db, () => {}, Date.now, { isArmed: () => false });
    engine.createDevice('admin', { id: 'M-SECTEUR', kind: 'detector', name: 'Arrivee secteur TGBT', category: 'energy' });
    const port = await freePort();
    const broker = await startBroker(engine, {
      host: '127.0.0.1',
      port,
      user: 'psim',
      password: 'Mot-de-passe-mqtt-solide-3',
      gateways: [{ user: GW_USER, password: GW_PASSWORD, detectors: ['M-*'] }],
    });
    cleanup.push(() => broker.close());

    // Automate : entree 3 = presence secteur (contact ferme = secteur present)
    const plc = fakePlc();
    const plcPort = await plc.listen();
    cleanup.push(() => plc.close());
    plc.inputs[3] = true;

    // Passerelle : le vrai module modbus, charge par le socle depuis gateway/src/modules
    const file = writeConfig(dir, {
      psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, password: GW_PASSWORD, detectors: ['M-*'] },
      dataDir: 'gw-data',
      retry: { minMs: 100, maxMs: 400 },
      moduleRetry: { minMs: 100, maxMs: 400 },
      log: { file: false },
      modules: [{
        name: 'modbus',
        config: {
          devices: [{
            name: 'tgbt', host: '127.0.0.1', port: plcPort, pollMs: 100, timeoutMs: 1000, heartbeatMs: 0,
            points: [{ id: 'M-SECTEUR', type: 'discrete', address: 3, invert: true, onTrue: { event: 'power_loss' }, onFalse: { event: 'power_restored' } }],
          }],
        },
      }],
    });
    const logger = memoryLogger();
    const rt = await startRuntime({ config: loadConfig(file), logger });
    cleanup.push(() => rt.stop());

    const device = () => engine.getDevice('M-SECTEUR')!;
    const open = () => engine.getSnapshot().incidents.filter((i) => i.detectorId === 'M-SECTEUR' && i.status !== 'closed');
    await waitFor(() => device().lastSeen !== null, 10_000, 'premier etat (secteur present) recu par le moteur');
    assert.equal(device().status, 'normal');
    assert.equal(open().length, 0);

    plc.inputs[3] = false; // coupure secteur
    await waitFor(() => open().length === 1, 10_000, 'incident ouvert par le moteur');
    const incident = open()[0]!;
    assert.equal(incident.event, 'power_loss', 'motif de l\'incident : coupure secteur');
    assert.equal(incident.category, 'energy');
    assert.equal(device().status, 'alarm');

    plc.inputs[3] = true; // retour secteur
    await waitFor(() => device().status === 'normal', 10_000, 'retour a la normale vu par le moteur');
    assert.equal(rt.status().queue.pending, 0, 'file de la passerelle videe');
    assert.equal(logger.has(/rejete|refuse/), false, logger.lines.map((l) => l.text).join('\n'));
  });
});
