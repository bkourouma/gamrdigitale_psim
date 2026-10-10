/** File d'envoi sur disque : persistance, lignes tronquees, bornes, compactage. */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DiskQueue } from '../src/queue.ts';
import { memoryLogger, tempDir } from './helpers.ts';

const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((f) => f()));

const open = (dir: string, max = { maxMessages: 10_000, maxBytes: 4 * 1024 * 1024 }, sync = true) => {
  const log = memoryLogger();
  const q = new DiskQueue(dir, { ...max, log, sync });
  q.open();
  return { q, log };
};
const msg = (n: number) => ({ state: 'alarm', ts: 1_760_000_000_000 + n, msgId: `m-${n}` });

describe("file d'envoi sur disque", () => {
  it('un message en file survit a la reouverture (meme contenu, meme msgId, meme ordre) ; un message accuse ne revient pas', () => {
    const dir = tempDir(cleanup);
    const { q } = open(dir);
    for (let i = 1; i <= 5; i++) q.push('D-01', msg(i));
    q.ack(q.peek()!.seq);
    q.ack(q.peek()!.seq);
    // Pas de close() : comme un processus tue net, seul ce qui est sur disque compte.
    const { q: q2 } = open(dir);
    assert.deepEqual(q2.pending().map((e) => e.m.msgId), ['m-3', 'm-4', 'm-5']);
    // La numerotation continue : un nouveau message passe APRES les anciens.
    const e = q2.push('D-02', msg(6));
    assert.ok(e.seq > q2.pending()[2].seq);
    q2.close();
  });

  it('une ligne tronquee par une coupure de courant est ignoree, les autres sont gardees, et le fichier est repare', () => {
    const dir = tempDir(cleanup);
    const { q } = open(dir);
    q.push('D-01', msg(1));
    q.push('D-01', msg(2));
    q.close();
    appendFileSync(join(dir, 'queue.jsonl'), '{"seq":3,"id":"D-01","m":{"state":"al'); // ecriture interrompue
    const { q: q2, log } = open(dir);
    assert.deepEqual(q2.pending().map((e) => e.m.msgId), ['m-1', 'm-2']);
    assert.ok(log.has(/ligne\(s\) illisible\(s\)/));
    q2.push('D-01', msg(4)); // ecrit sur une ligne propre, pas collee au morceau tronque
    q2.close();
    const { q: q3 } = open(dir);
    assert.deepEqual(q3.pending().map((e) => e.m.msgId), ['m-1', 'm-2', 'm-4']);
    q3.close();
  });

  it('bornee en nombre : les plus ANCIENS sont abandonnes, compteur et journal', () => {
    const dir = tempDir(cleanup);
    const { q, log } = open(dir, { maxMessages: 3, maxBytes: 1024 * 1024 });
    for (let i = 1; i <= 7; i++) q.push('D-01', msg(i));
    assert.deepEqual(q.pending().map((e) => e.m.msgId), ['m-5', 'm-6', 'm-7']);
    assert.equal(q.stats().dropped, 4);
    assert.ok(log.has(/file d'envoi pleine/));
    q.close();
    const { q: q2 } = open(dir, { maxMessages: 3, maxBytes: 1024 * 1024 });
    assert.deepEqual(q2.pending().map((e) => e.m.msgId), ['m-5', 'm-6', 'm-7'], "l'abandon est persiste");
    q2.close();
  });

  it('bornee en octets', () => {
    const dir = tempDir(cleanup);
    const { q } = open(dir, { maxMessages: 1000, maxBytes: 4096 });
    for (let i = 1; i <= 100; i++) q.push('D-01', msg(i));
    assert.ok(q.stats().bytes <= 4096);
    assert.ok(q.stats().dropped > 0);
    assert.equal(q.pending().at(-1)?.m.msgId, 'm-100', 'le plus recent est toujours garde');
    q.close();
  });

  it('une file reduite apres coup (configuration changee) est ramenee a ses bornes au chargement', () => {
    const dir = tempDir(cleanup);
    const { q } = open(dir);
    for (let i = 1; i <= 10; i++) q.push('D-01', msg(i));
    q.close();
    const { q: q2 } = open(dir, { maxMessages: 4, maxBytes: 1024 * 1024 });
    assert.deepEqual(q2.pending().map((e) => e.m.msgId), ['m-7', 'm-8', 'm-9', 'm-10']);
    q2.close();
  });

  it('compactage : le fichier ne grossit pas indefiniment, et rien ne se perd', () => {
    const dir = tempDir(cleanup);
    const { q } = open(dir, undefined, false);
    let peak = 0;
    for (let i = 1; i <= 8000; i++) {
      q.push('D-01', msg(i));
      if (i % 2 === 0) q.ack(q.peek()!.seq);
      peak = Math.max(peak, statSync(join(dir, 'queue.jsonl')).size);
    }
    // 4000 en attente (environ 400 Ko) : le fichier ne depasse jamais de beaucoup la file elle-meme.
    assert.ok(peak < 2 * q.stats().bytes + 300 * 1024, `fichier de ${peak} octets pour ${q.stats().bytes} en attente`);
    while (q.pending().length > 1) q.ack(q.peek()!.seq);
    assert.ok(statSync(join(dir, 'queue.jsonl')).size < 300 * 1024, 'fichier compacte');
    q.close();
    const { q: q2 } = open(dir);
    assert.deepEqual(q2.pending().map((e) => e.m.msgId), ['m-8000']);
    q2.close();
  });

  it('un fichier temporaire de compactage abandonne (coupure pendant le compactage) est ignore : le fichier principal fait foi', () => {
    const dir = tempDir(cleanup);
    const { q } = open(dir);
    q.push('D-01', msg(1));
    q.close();
    writeFileSync(join(dir, 'queue.jsonl.tmp'), '{"ack":0}\n{"seq":1,"id":"D-01","m":{"state":"normal"}}\n{"se');
    const { q: q2 } = open(dir);
    assert.deepEqual(q2.pending().map((e) => e.m.msgId), ['m-1']);
    q2.close();
    assert.ok(!readFileSync(join(dir, 'queue.jsonl'), 'utf8').includes('"se\n'));
  });
});
