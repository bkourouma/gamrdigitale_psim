/**
 * File d'envoi sur DISQUE (store-and-forward) : un message accepte par la passerelle survit a un arret, un plantage ou
 * une coupure de courant, et repart tel quel (meme `ts`, meme `msgId`) quand le PSIM redevient joignable.
 *
 * Format : `<dossier>/queue.jsonl`, une ligne JSON par enregistrement, en ajout seulement :
 *   {"seq":12,"id":"D-01","m":{"state":"alarm","ts":1760000000000,"msgId":"..."}}   message a envoyer
 *   {"ack":12}                                                                        tout ce qui est <= 12 est traite
 * Chaque message est ecrit et force sur le disque (fsync) AVANT que `push` rende la main. Un accuse de reception perdu
 * (coupure juste apres l'envoi) provoque seulement un renvoi, sans effet cote PSIM grace au `msgId`.
 *
 * Robustesse :
 *  - une ligne tronquee par une coupure est ignoree au chargement (et signalee), les autres sont gardees ;
 *  - le fichier est compacte (reecrit sans les messages traites) dans un fichier temporaire force sur disque puis renomme :
 *    a tout instant, l'ancien ou le nouveau fichier est complet ;
 *  - taille bornee en nombre de messages et en octets : au-dela, les plus ANCIENS sont abandonnes (compteur journalise),
 *    pour que la passerelle ne remplisse jamais le disque pendant une longue coupure.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './log.ts';
import { DEVICE_ID } from './validate.ts';

export interface QueueEntry {
  seq: number;
  id: string;
  m: Record<string, unknown>;
  /** Taille de la ligne sur disque (octets, retour a la ligne compris). */
  size: number;
}

export interface QueueOptions {
  maxMessages: number;
  maxBytes: number;
  log: Logger;
  /** Ecriture forcee sur disque a chaque message (vrai par defaut ; faux seulement pour des essais de performance). */
  sync?: boolean;
}

export interface QueueStats {
  pending: number;
  bytes: number;
  /** Messages abandonnes depuis le demarrage (file pleine). */
  dropped: number;
  /** Messages refuses par le PSIM, mis de cote dans rejected.jsonl. */
  rejected: number;
}

const FILE = 'queue.jsonl';
const REJECTED = 'rejected.jsonl';
const REJECTED_MAX_BYTES = 1024 * 1024;

/** Pause synchrone courte (renommage refuse par un antivirus sous Windows : on reessaie). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      pause(50 * (i + 1));
    }
  }
}

export class DiskQueue {
  readonly path: string;
  private readonly dir: string;
  private readonly opts: QueueOptions;
  private entries: QueueEntry[] = [];
  private pendingBytes = 0;
  private fileBytes = 0;
  private fd: number | null = null;
  private nextSeq = 1;
  private lastAck = 0;
  private dropped = 0;
  private rejectedCount = 0;
  private lastDropLog = 0;
  private droppedSinceLog = 0;

  constructor(dir: string, opts: QueueOptions) {
    this.dir = dir;
    this.path = join(dir, FILE);
    this.opts = opts;
  }

  /** Charge la file existante (messages non envoyes lors du dernier arret), puis la compacte. */
  open(): void {
    mkdirSync(this.dir, { recursive: true });
    rmSync(`${this.path}.tmp`, { force: true }); // compactage interrompu : l'ancien fichier est intact
    const loaded = new Map<number, QueueEntry>();
    let bad = 0;
    if (existsSync(this.path)) {
      const text = readFileSync(this.path, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          bad++;
          continue;
        }
        const r = rec as { seq?: unknown; id?: unknown; m?: unknown; ack?: unknown };
        if (typeof r.ack === 'number' && Number.isSafeInteger(r.ack)) {
          this.lastAck = Math.max(this.lastAck, r.ack);
        } else if (
          typeof r.seq === 'number' && Number.isSafeInteger(r.seq) && r.seq > 0 &&
          typeof r.id === 'string' && DEVICE_ID.test(r.id) &&
          typeof r.m === 'object' && r.m !== null && !Array.isArray(r.m)
        ) {
          loaded.set(r.seq, { seq: r.seq, id: r.id, m: r.m as Record<string, unknown>, size: Buffer.byteLength(line) + 1 });
        } else {
          bad++;
        }
      }
    }
    const seqs = [...loaded.keys()];
    this.nextSeq = Math.max(this.lastAck, ...seqs, 0) + 1;
    this.entries = [...loaded.values()].filter((e) => e.seq > this.lastAck).sort((a, b) => a.seq - b.seq);
    this.pendingBytes = this.entries.reduce((n, e) => n + e.size, 0);
    if (bad > 0) this.opts.log.log('warn', `file d'envoi : ${bad} ligne(s) illisible(s) ignoree(s) (coupure de courant pendant une ecriture ?)`);
    if (this.entries.length > 0) this.opts.log.log('info', `file d'envoi : ${this.entries.length} message(s) en attente repris du dernier arret`);
    this.enforceBounds();
    this.compact();
  }

  /** Ajoute un message ; il est sur le disque quand la fonction rend la main. */
  push(id: string, m: Record<string, unknown>): QueueEntry {
    if (this.fd === null) throw new Error("file d'envoi fermee");
    const seq = this.nextSeq++;
    const line = `${JSON.stringify({ seq, id, m })}\n`;
    const buf = Buffer.from(line);
    writeSync(this.fd, buf);
    if (this.opts.sync !== false) fsyncSync(this.fd);
    this.fileBytes += buf.length;
    const entry: QueueEntry = { seq, id, m, size: buf.length };
    this.entries.push(entry);
    this.pendingBytes += buf.length;
    this.enforceBounds();
    return entry;
  }

  peek(): QueueEntry | undefined {
    return this.entries[0];
  }

  /** Message traite (accuse par le PSIM) : il ne sera plus envoye. */
  ack(seq: number): void {
    if (seq <= this.lastAck) return;
    this.removeUpTo(seq);
    this.appendAck(seq);
    this.maybeCompact();
  }

  /** Message refuse par le PSIM a repetition : mis de cote dans rejected.jsonl (pour analyse), puis retire de la file. */
  reject(entry: QueueEntry, reason: string): void {
    this.rejectedCount++;
    const file = join(this.dir, REJECTED);
    try {
      // Fichier borne : on repart de zero s'il devient trop gros (il ne sert qu'au diagnostic).
      if (existsSync(file) && readFileSync(file).length > REJECTED_MAX_BYTES) renameWithRetry(file, `${file}.1`);
      const fd = openSync(file, 'a');
      try {
        writeSync(fd, `${JSON.stringify({ at: Date.now(), reason, id: entry.id, m: entry.m })}\n`);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.opts.log.log('error', `impossible d'ecrire ${REJECTED} : ${(err as Error).message}`);
    }
    this.ack(entry.seq);
  }

  pending(): readonly QueueEntry[] {
    return this.entries;
  }

  stats(): QueueStats {
    return { pending: this.entries.length, bytes: this.pendingBytes, dropped: this.dropped, rejected: this.rejectedCount };
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fsyncSync(this.fd);
    } catch {
      // rien a faire : les messages ont deja ete forces sur disque un par un
    }
    closeSync(this.fd);
    this.fd = null;
  }

  private removeUpTo(seq: number): void {
    let n = 0;
    while (n < this.entries.length && this.entries[n].seq <= seq) {
      this.pendingBytes -= this.entries[n].size;
      n++;
    }
    if (n > 0) this.entries.splice(0, n);
    this.lastAck = seq;
  }

  private appendAck(seq: number): void {
    if (this.fd === null) return;
    // Pas de fsync : un accuse perdu ne fait qu'un renvoi, ignore par le PSIM (meme msgId).
    const buf = Buffer.from(`{"ack":${seq}}\n`);
    writeSync(this.fd, buf);
    this.fileBytes += buf.length;
  }

  /** Abandonne les plus anciens messages tant que la file depasse ses bornes. */
  private enforceBounds(): void {
    let lastDropped = 0;
    let n = 0;
    while (this.entries.length > 0 && (this.entries.length > this.opts.maxMessages || this.pendingBytes > this.opts.maxBytes)) {
      const e = this.entries.shift() as QueueEntry;
      this.pendingBytes -= e.size;
      lastDropped = e.seq;
      n++;
    }
    if (n === 0) return;
    this.lastAck = Math.max(this.lastAck, lastDropped);
    this.appendAck(lastDropped);
    this.dropped += n;
    this.droppedSinceLog += n;
    const t = Date.now();
    // Journal limite a une ligne par minute, avec le total : une longue coupure ne doit pas noyer le journal.
    if (t - this.lastDropLog >= 60_000) {
      this.opts.log.log(
        'warn',
        `file d'envoi pleine (${this.opts.maxMessages} messages / ${this.opts.maxBytes} octets) : ${this.droppedSinceLog} message(s) le(s) plus ancien(s) abandonne(s), ${this.dropped} depuis le demarrage`,
      );
      this.lastDropLog = t;
      this.droppedSinceLog = 0;
    }
  }

  private maybeCompact(): void {
    // Compacte quand la partie deja traitee domine : le fichier reste proche de la taille de la file.
    const garbage = this.fileBytes - this.pendingBytes;
    if ((this.entries.length === 0 && this.fileBytes > 64 * 1024) || garbage > Math.max(256 * 1024, this.pendingBytes)) this.compact();
  }

  /** Reecrit le fichier avec les seuls messages en attente (fichier temporaire force sur disque, puis renomme). */
  private compact(): void {
    const tmp = `${this.path}.tmp`;
    // L'accuse en tete garde la numerotation apres compactage (sans message en attente : le dernier numero distribue).
    const head = this.entries.length === 0 ? this.nextSeq - 1 : this.lastAck;
    const lines = [`{"ack":${head}}\n`];
    for (const e of this.entries) lines.push(`${JSON.stringify({ seq: e.seq, id: e.id, m: e.m })}\n`);
    const data = Buffer.from(lines.join(''));
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    try {
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameWithRetry(tmp, this.path);
      this.fileBytes = data.length;
      this.lastAck = head;
    } catch (err) {
      // L'ancien fichier est intact : on continue d'y ajouter, le compactage sera retente plus tard.
      rmSync(tmp, { force: true });
      this.opts.log.log('warn', `file d'envoi : compactage impossible (${(err as Error).message}), nouvel essai plus tard`);
    }
    this.fd = openSync(this.path, 'a');
  }
}
