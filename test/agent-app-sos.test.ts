/**
 * Application des agents, SOS : parties pures (progression et geste de l'appui maintenu, machine d'envoi et d'essais).
 * Aucun DOM, aucune attente reelle : fausse horloge, faux minuteurs, fausse file d'attente.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses parties pures
import { ATTEMPT_TIMEOUT_MS, createHoldGesture, createSosMachine, holdProgress, HOLD_MS, RETRY_MS, retryCountdown, SENT_VISIBLE_MS, sosItems } from '../web/agent/sos.js';

/** Laisse passer toutes les promesses en attente (sans attente reelle). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

interface QueueItem {
  kind: 'sos';
  clientId: string;
  payload: { clientId: string; phoneAt: number; discreet: boolean };
  createdAt: number;
  lastError?: string;
}

/**
 * Banc d'essai : horloge et minuteurs factices + une file qui se comporte comme queue.js
 * (submit ecrit d'abord puis envoie, flush vide, pending liste) avec un reseau qu'on coupe et remet.
 */
function bench(options: { discreet?: boolean } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  let timers: Timer[] = [];
  const events: string[] = [];
  const phases: string[] = [];
  const submitted: Array<{ clientId: string; phoneAt: number; discreet: boolean }> = [];
  const calls = { submit: 0, flush: 0, pending: 0 };
  const net = { up: false, rejectWith: null as string | null, submitThrows: false, hang: false };
  let items: QueueItem[] = [];
  let ids = 0;

  const setTimer = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.push({ id, at: clock + ms, fn });
    return id;
  };
  const clearTimer = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };

  /** Fait avancer l'horloge en declenchant les minuteurs dans l'ordre. */
  async function advance(ms: number) {
    const target = clock + ms;
    for (;;) {
      await settle();
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      clock = due.at;
      due.fn();
    }
    await settle();
    clock = target;
  }

  const queue = {
    async submit(payload: { clientId: string; phoneAt: number; discreet: boolean }) {
      calls.submit += 1;
      submitted.push({ ...payload });
      if (net.submitThrows) throw new Error('IndexedDB indisponible');
      if (net.hang) return new Promise<never>(() => {});
      if (net.rejectWith) return { clientId: payload.clientId, sent: false, rejected: true, error: net.rejectWith };
      if (net.up) return { clientId: payload.clientId, sent: true };
      if (!items.some((i) => i.clientId === payload.clientId)) items.push({ kind: 'sos', clientId: payload.clientId, payload, createdAt: clock });
      return { clientId: payload.clientId, sent: false, error: 'Pas de réseau' };
    },
    async flush() {
      calls.flush += 1;
      if (!net.up) return { sent: 0, remaining: items.length };
      const sent = items.length;
      items = [];
      return { sent, remaining: 0 };
    },
    async pending() {
      calls.pending += 1;
      return items.map((i) => ({ ...i }));
    },
  };

  const machine = createSosMachine({
    submit: (payload: { clientId: string; phoneAt: number; discreet: boolean }) => queue.submit(payload),
    flush: () => queue.flush(),
    pending: () => queue.pending(),
    newId: () => `id-${++ids}`,
    now: () => clock,
    setTimer,
    clearTimer,
    onState: (snap: { phase: string }, event: string) => {
      events.push(event);
      phases.push(snap.phase);
    },
  });

  return {
    machine,
    queue,
    net,
    events,
    phases,
    submitted,
    calls,
    advance,
    get now() {
      return clock;
    },
    get items() {
      return items;
    },
    set items(value: QueueItem[]) {
      items = value;
    },
    get timers() {
      return timers.length;
    },
    discreet: options.discreet ?? false,
    async press() {
      const result = machine.trigger({ discreet: options.discreet ?? false });
      await settle();
      return result;
    },
  };
}

describe('holdProgress', () => {
  it('va de 0 a 1 en 2 secondes par defaut', () => {
    assert.equal(HOLD_MS, 2000);
    assert.equal(holdProgress(0), 0);
    assert.equal(holdProgress(500), 0.25);
    assert.equal(holdProgress(1000), 0.5);
    assert.equal(holdProgress(2000), 1);
  });

  it('reste borne entre 0 et 1', () => {
    assert.equal(holdProgress(-300), 0);
    assert.equal(holdProgress(60_000), 1);
    assert.equal(holdProgress(Infinity), 1);
    assert.equal(holdProgress(-Infinity), 0);
  });

  it('donne 0 pour une valeur invalide', () => {
    assert.equal(holdProgress(Number.NaN), 0);
    assert.equal(holdProgress(undefined as unknown as number), 0);
    assert.equal(holdProgress('1000' as unknown as number), 0);
  });

  it('accepte une autre duree et ne divise jamais par zero', () => {
    assert.equal(holdProgress(500, 1000), 0.5);
    assert.equal(holdProgress(10, 0), 1);
    assert.equal(holdProgress(0, 0), 0);
    assert.equal(holdProgress(10, -5), 1);
    assert.equal(holdProgress(10, Number.NaN), 1);
  });
});

describe('retryCountdown', () => {
  it('arrondit au-dessus et ne descend jamais sous zero', () => {
    assert.equal(retryCountdown(10_000, 0), 10);
    assert.equal(retryCountdown(10_000, 1), 10);
    assert.equal(retryCountdown(10_000, 9_001), 1);
    assert.equal(retryCountdown(10_000, 10_000), 0);
    assert.equal(retryCountdown(10_000, 50_000), 0);
    assert.equal(retryCountdown(null as unknown as number, 5), 0);
  });
});

describe('sosItems', () => {
  it('ne garde que les SOS valides de la file', () => {
    const list = [
      { kind: 'scan', clientId: 'a' },
      { kind: 'sos', clientId: 'b' },
      { kind: 'sos' },
      null,
      { kind: 'sos', clientId: 'c' },
    ];
    assert.deepEqual(
      sosItems(list).map((i: { clientId: string }) => i.clientId),
      ['b', 'c'],
    );
    assert.deepEqual(sosItems(undefined), []);
    assert.deepEqual(sosItems('x'), []);
  });
});

describe('createHoldGesture', () => {
  function gesture() {
    let t = 5000;
    const progress: number[] = [];
    let completed = 0;
    const g = createHoldGesture({
      now: () => t,
      onProgress: (p: number) => progress.push(p),
      onComplete: () => {
        completed += 1;
      },
    });
    return {
      g,
      progress,
      get completed() {
        return completed;
      },
      move: (ms: number) => {
        t += ms;
      },
    };
  }

  it('suit la progression et complete exactement a 2 secondes', () => {
    const x = gesture();
    assert.equal(x.g.active, false);
    assert.equal(x.g.start(), true);
    assert.equal(x.g.active, true);
    x.move(500);
    assert.equal(x.g.tick(), 0.25);
    x.move(1000);
    assert.equal(x.g.tick(), 0.75);
    assert.equal(x.completed, 0);
    x.move(499);
    assert.ok(x.g.tick() < 1);
    assert.equal(x.completed, 0);
    x.move(1);
    assert.equal(x.g.tick(), 1);
    assert.equal(x.completed, 1);
    assert.equal(x.g.active, false);
  });

  it('ne complete qu une fois, meme si on continue d appeler tick', () => {
    const x = gesture();
    x.g.start();
    x.move(2500);
    x.g.tick();
    x.move(100);
    assert.equal(x.g.tick(), 0);
    x.g.tick();
    assert.equal(x.completed, 1);
  });

  it('annule et remet l anneau a zero si on relache avant 2 secondes', () => {
    const x = gesture();
    x.g.start();
    x.move(1900);
    x.g.tick();
    assert.equal(x.g.cancel(), true);
    assert.equal(x.progress.at(-1), 0);
    assert.equal(x.g.active, false);
    x.move(5000);
    assert.equal(x.g.tick(), 0);
    assert.equal(x.completed, 0);
  });

  it('un nouvel appui repart de zero (il faut a nouveau 2 secondes pleines)', () => {
    const x = gesture();
    x.g.start();
    x.move(1900);
    x.g.cancel();
    x.g.start();
    x.move(1900);
    assert.ok(x.g.tick() < 1);
    assert.equal(x.completed, 0);
    x.move(100);
    x.g.tick();
    assert.equal(x.completed, 1);
  });

  it('ignore un second start et un cancel sans appui', () => {
    const x = gesture();
    assert.equal(x.g.cancel(), false);
    assert.equal(x.g.start(), true);
    x.move(1000);
    assert.equal(x.g.start(), false);
    assert.equal(x.g.tick(), 0.5);
  });

  it('une horloge qui recule ne fait ni completer ni avancer', () => {
    const x = gesture();
    x.g.start();
    x.move(-3000);
    assert.equal(x.g.tick(), 0);
    assert.equal(x.completed, 0);
  });
});

describe('createSosMachine : envoi', () => {
  it('succes immediat : sending puis sent, un seul envoi, puis retour au repos apres 60 s', async () => {
    const b = bench();
    b.net.up = true;
    const sentAt = b.now;
    const { started } = await b.press();
    assert.equal(started, true);
    const snap = b.machine.snapshot();
    assert.equal(snap.phase, 'sent');
    assert.equal(snap.sentAt, sentAt);
    assert.equal(snap.attempts, 1);
    assert.equal(b.calls.submit, 1);
    assert.equal(b.calls.flush, 0);
    assert.deepEqual(b.submitted[0], { clientId: 'id-1', phoneAt: sentAt, discreet: false });
    assert.deepEqual(b.events, ['sending', 'sent']);

    await b.advance(SENT_VISIBLE_MS - 1);
    assert.equal(b.machine.snapshot().phase, 'sent');
    await b.advance(1);
    const after = b.machine.snapshot();
    assert.equal(after.phase, 'idle');
    assert.equal(after.lastSentAt, sentAt);
    assert.equal(b.events.at(-1), 'idle');
    assert.equal(b.timers, 0);
  });

  it('le mode discret part dans la charge utile et dans l etat', async () => {
    const b = bench({ discreet: true });
    b.net.up = true;
    await b.press();
    assert.equal(b.submitted[0]?.discreet, true);
    assert.equal(b.machine.snapshot().discreet, true);
    assert.equal(b.machine.snapshot().lastSentDiscreet, true);
  });

  it('echec puis succes au 3e essai, essais espaces de 10 s, jamais au repos entre-temps', async () => {
    const b = bench();
    const t0 = b.now;
    await b.press();
    let snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.trying, false);
    assert.equal(snap.nextRetryAt, t0 + RETRY_MS);
    assert.equal(snap.rejected, false);
    assert.equal(b.calls.submit, 1);
    assert.equal(b.items.length, 1);

    await b.advance(RETRY_MS - 1);
    assert.equal(b.calls.flush, 0);
    await b.advance(1); // 2e essai : toujours coupe
    assert.equal(b.calls.flush, 1);
    snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.attempts, 2);
    assert.equal(snap.nextRetryAt, t0 + 2 * RETRY_MS);

    b.net.up = true;
    await b.advance(RETRY_MS - 1);
    assert.equal(b.calls.flush, 1);
    await b.advance(1); // 3e essai : le reseau est la
    assert.equal(b.calls.flush, 2);
    snap = b.machine.snapshot();
    assert.equal(snap.phase, 'sent');
    assert.equal(snap.attempts, 3);
    assert.equal(b.calls.submit, 1, 'les essais passent par la file, pas par de nouveaux SOS');
    assert.equal(b.items.length, 0);
    assert.ok(!b.phases.includes('idle'));
    assert.deepEqual(b.events, ['sending', 'failed', 'trying', 'failing', 'trying', 'sent']);
  });

  it('un seul clientId pour tous les essais d un SOS hors rejet', async () => {
    const b = bench();
    await b.press();
    await b.advance(RETRY_MS * 3);
    assert.equal(b.submitted.length, 1);
    assert.equal(b.machine.snapshot().clientId, 'id-1');
  });

  it('ne renonce jamais : 50 essais plus tard, toujours en echec avec un minuteur arme', async () => {
    const b = bench();
    await b.press();
    await b.advance(RETRY_MS * 50);
    const snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.attempts, 51);
    assert.equal(b.timers, 1);
    assert.ok(!b.phases.includes('idle'));
  });

  it('un seul « failed » (celui qui declenche la vibration), les suivants sont des « failing »', async () => {
    const b = bench();
    await b.press();
    await b.advance(RETRY_MS * 4);
    assert.equal(b.events.filter((e) => e === 'failed').length, 1);
    assert.equal(b.events.filter((e) => e === 'failing').length, 4);
  });

  it('l ecriture dans la file echoue : le SOS est garde en memoire et renvoye tel quel', async () => {
    const b = bench();
    b.net.submitThrows = true;
    await b.press();
    assert.equal(b.machine.snapshot().phase, 'failed');
    await b.advance(RETRY_MS);
    assert.equal(b.calls.submit, 2);
    assert.equal(b.calls.flush, 0);
    b.net.submitThrows = false;
    b.net.up = true;
    await b.advance(RETRY_MS);
    assert.equal(b.machine.snapshot().phase, 'sent');
    assert.deepEqual(
      b.submitted.map((p) => p.clientId),
      ['id-1', 'id-1', 'id-1'],
    );
    assert.equal(b.submitted[2]?.phoneAt, b.submitted[0]?.phoneAt);
  });

  it('un element disparu de la file sans avoir ete envoye par ce vidage est re-soumis (le serveur dedoublonne)', async () => {
    const b = bench();
    await b.press();
    b.items = []; // vidange periodique de la file, ou retire : on ne sait pas
    b.net.up = true;
    // le vidage ne trouve rien a envoyer ; la re-soumission dit la verite
    b.queue.flush = async () => ({ sent: 0, remaining: 0 });
    await b.advance(RETRY_MS);
    assert.equal(b.machine.snapshot().phase, 'sent');
    assert.equal(b.calls.submit, 2);
    assert.equal(b.submitted[1]?.clientId, 'id-1');
  });

  it('un element retire de la file puis rejete n est pas pris pour un succes', async () => {
    const b = bench();
    await b.press();
    b.items = [];
    b.queue.flush = async () => ({ sent: 0, remaining: 0 });
    b.net.rejectWith = 'Heure du téléphone décalée';
    await b.advance(RETRY_MS);
    const snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.rejected, true);
  });

  it('le vidage qui leve est tolere : on regarde quand meme la file', async () => {
    const b = bench();
    await b.press();
    b.queue.flush = async () => {
      throw new Error('boum');
    };
    await b.advance(RETRY_MS);
    assert.equal(b.machine.snapshot().phase, 'failed');
    b.net.up = true;
    b.items = [];
    await b.advance(RETRY_MS);
    assert.equal(b.machine.snapshot().phase, 'sent');
  });

  it('la file illisible compte comme un echec', async () => {
    const b = bench();
    await b.press();
    b.queue.pending = async () => {
      throw new Error('IndexedDB');
    };
    await b.advance(RETRY_MS);
    assert.equal(b.machine.snapshot().phase, 'failed');
    assert.equal(b.machine.snapshot().attempts, 2);
  });

  it('un onState qui leve ne casse pas l envoi', async () => {
    const m = createSosMachine({
      submit: async () => ({ sent: true }),
      flush: async () => ({ sent: 0, remaining: 0 }),
      pending: async () => [],
      newId: () => 'x',
      now: () => 1,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onState: () => {
        throw new Error('affichage casse');
      },
    });
    m.trigger({ discreet: false });
    await settle();
    assert.equal(m.snapshot().phase, 'sent');
  });
});

describe('createSosMachine : rejet du serveur', () => {
  it('rejet : message du serveur conserve, puis NOUVEL SOS (nouveau clientId, phoneAt a jour) a chaque essai', async () => {
    const b = bench();
    b.net.rejectWith = 'Heure du téléphone trop éloignée';
    const t0 = b.now;
    await b.press();
    let snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.rejected, true);
    assert.equal(snap.error, 'Heure du téléphone trop éloignée');
    assert.equal(b.calls.flush, 0);

    await b.advance(RETRY_MS);
    assert.equal(b.calls.submit, 2);
    assert.equal(b.calls.flush, 0, 'un SOS rejete n est plus dans la file : on en soumet un nouveau');
    assert.notEqual(b.submitted[1]?.clientId, b.submitted[0]?.clientId);
    assert.equal(b.submitted[1]?.phoneAt, t0 + RETRY_MS);
    snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.rejected, true);

    b.net.rejectWith = null;
    b.net.up = true;
    await b.advance(RETRY_MS);
    snap = b.machine.snapshot();
    assert.equal(snap.phase, 'sent');
    assert.equal(snap.rejected, false);
    assert.equal(b.calls.submit, 3);
    assert.equal(b.submitted[2]?.phoneAt, t0 + 2 * RETRY_MS);
    assert.equal(new Set(b.submitted.map((p) => p.clientId)).size, 3);
    assert.ok(!b.phases.includes('idle'));
  });

  it('rejets repetes : ne renonce jamais', async () => {
    const b = bench();
    b.net.rejectWith = 'Refusé';
    await b.press();
    await b.advance(RETRY_MS * 20);
    const snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(b.calls.submit, 21);
    assert.equal(b.timers, 1);
  });

  it('un rejet sans message donne un texte par defaut ; un message hostile est nettoye et borne', async () => {
    const b = bench();
    b.net.rejectWith = '   ';
    await b.press();
    assert.equal(b.machine.snapshot().error, 'SOS refusé');

    const c = bench();
    c.net.rejectWith = `ligne1\n\n   ligne2 ${'x'.repeat(500)}`;
    await c.press();
    const msg = c.machine.snapshot().error as string;
    assert.ok(msg.length <= 160);
    assert.ok(!msg.includes('\n'));
    assert.ok(msg.startsWith('ligne1 ligne2 '));
  });

  it('rejet puis coupure reseau : le nouveau SOS passe par la file', async () => {
    const b = bench();
    b.net.rejectWith = 'Refusé';
    await b.press();
    b.net.rejectWith = null; // reseau coupe : le nouvel SOS est mis en file
    await b.advance(RETRY_MS);
    assert.equal(b.machine.snapshot().rejected, false);
    assert.equal(b.items.length, 1);
    b.net.up = true;
    await b.advance(RETRY_MS);
    assert.equal(b.calls.flush, 1);
    assert.equal(b.machine.snapshot().phase, 'sent');
  });
});

describe('createSosMachine : second appui, relance manuelle', () => {
  it('pas de doublon sur double appui pendant l envoi', async () => {
    const b = bench();
    b.net.hang = true;
    const first = b.machine.trigger({ discreet: false });
    const second = b.machine.trigger({ discreet: false });
    await settle();
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(b.calls.submit, 1);
    assert.equal(b.machine.snapshot().phase, 'sending');
    assert.equal(b.machine.snapshot().clientId, 'id-1');
  });

  it('pas de doublon pendant « non transmis » : meme clientId, pas de nouvel SOS', async () => {
    const b = bench();
    await b.press();
    const again = await b.press();
    assert.equal(again.started, false);
    assert.equal(b.calls.submit, 1);
    assert.equal(b.machine.snapshot().clientId, 'id-1');
    assert.equal(b.machine.snapshot().phase, 'failed');
  });

  it('un appui apres « envoye » cree un nouvel SOS, et annule le retour au repos de l ancien', async () => {
    const b = bench();
    b.net.up = true;
    await b.press();
    await b.advance(30_000);
    b.net.up = false;
    const again = await b.press();
    assert.equal(again.started, true);
    assert.equal(b.machine.snapshot().clientId, 'id-2');
    assert.equal(b.machine.snapshot().phase, 'failed');
    await b.advance(SENT_VISIBLE_MS); // l ancien minuteur de 60 s aurait remis au repos
    assert.equal(b.machine.snapshot().phase, 'failed');
    assert.ok(!b.phases.slice(2).includes('idle'));
  });

  it('retryNow : essai immediat, sans attendre, et le minuteur de 10 s n est pas double', async () => {
    const b = bench();
    await b.press();
    await b.advance(4000);
    b.net.up = true;
    assert.equal(await b.machine.retryNow(), true);
    assert.equal(b.machine.snapshot().phase, 'sent');
    assert.equal(b.calls.flush, 1);
    await b.advance(RETRY_MS * 2);
    assert.equal(b.calls.flush, 1);
  });

  it('retryNow en echec : le prochain essai est repousse de 10 s a partir de maintenant', async () => {
    const b = bench();
    await b.press();
    await b.advance(6000);
    await b.machine.retryNow();
    assert.equal(b.machine.snapshot().nextRetryAt, b.now + RETRY_MS);
    assert.equal(b.timers, 1);
    assert.equal(b.calls.flush, 1);
  });

  it('retryNow est ignore hors « non transmis » ou si un essai est deja en cours', async () => {
    const b = bench();
    assert.equal(await b.machine.retryNow(), false);
    b.net.up = true;
    await b.press();
    assert.equal(await b.machine.retryNow(), false);

    const c = bench();
    await c.press();
    c.queue.flush = () => new Promise(() => {}); // un essai qui ne finit pas
    const running = c.machine.retryNow();
    await settle();
    assert.equal(c.machine.snapshot().trying, true);
    assert.equal(await c.machine.retryNow(), false);
    assert.equal(c.calls.submit, 1);
    void running;
  });
});

describe('createSosMachine : essai sans reponse', () => {
  it('un essai muet compte comme echoue apres le delai, puis les essais reprennent', async () => {
    const b = bench();
    b.net.hang = true;
    await b.press();
    assert.equal(b.machine.snapshot().phase, 'sending');
    await b.advance(ATTEMPT_TIMEOUT_MS);
    const snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.trying, false);
    assert.equal(snap.nextRetryAt, b.now + RETRY_MS);
    assert.equal(b.timers, 1);
  });

  it('la reponse positive tardive d un essai expire est quand meme prise en compte', async () => {
    let release: (value: unknown) => void = () => undefined;
    let clock = 0;
    let seq = 0;
    let timers: Timer[] = [];
    const m = createSosMachine({
      submit: () => new Promise((resolve) => (release = resolve)),
      flush: async () => ({ sent: 0, remaining: 1 }),
      pending: async () => [],
      newId: () => 'tardif',
      now: () => clock,
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ id: ++seq, at: clock + ms, fn });
        return seq;
      },
      clearTimer: (id: number) => {
        timers = timers.filter((t) => t.id !== id);
      },
    });
    m.trigger({ discreet: false });
    await settle();
    clock = ATTEMPT_TIMEOUT_MS;
    timers.find((t) => t.at <= clock)?.fn();
    await settle();
    assert.equal(m.snapshot().phase, 'failed');
    release({ sent: true });
    await settle();
    assert.equal(m.snapshot().phase, 'sent');
    m.dispose();
  });
});

describe('createSosMachine : reprise au demarrage', () => {
  function queued(over: Partial<QueueItem> = {}): QueueItem {
    return { kind: 'sos', clientId: 'ancien', payload: { clientId: 'ancien', phoneAt: 12345, discreet: true }, createdAt: 12000, lastError: 'Pas de réseau', ...over };
  }

  it('rien dans la file : reste au repos', async () => {
    const b = bench();
    assert.equal(await b.machine.resume(), false);
    assert.equal(b.machine.snapshot().phase, 'idle');
    assert.deepEqual(b.events, []);
  });

  it('seulement des scans dans la file : reste au repos', async () => {
    const b = bench();
    b.items = [{ ...queued(), kind: 'scan' } as unknown as QueueItem];
    assert.equal(await b.machine.resume(), false);
    assert.equal(b.machine.snapshot().phase, 'idle');
  });

  it('un SOS en file, reseau coupe : « non transmis » tout de suite, puis reprise des essais toutes les 10 s', async () => {
    const b = bench();
    b.items = [queued()];
    assert.equal(await b.machine.resume(), true);
    let snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.clientId, 'ancien');
    assert.equal(snap.phoneAt, 12345);
    assert.equal(snap.discreet, true);
    assert.equal(snap.attempts, 1);
    assert.equal(b.calls.flush, 1, 'un premier essai immediat');
    assert.equal(b.calls.submit, 0);
    assert.deepEqual(b.events.slice(0, 3), ['resumed', 'trying', 'failed']);

    b.net.up = true;
    await b.advance(RETRY_MS);
    snap = b.machine.snapshot();
    assert.equal(snap.phase, 'sent');
    assert.equal(snap.attempts, 2);
    assert.equal(b.items.length, 0);
    assert.ok(!b.phases.includes('idle'));
  });

  it('un SOS en file, reseau present : parti des la reprise', async () => {
    const b = bench();
    b.items = [queued()];
    b.net.up = true;
    await b.machine.resume();
    assert.equal(b.machine.snapshot().phase, 'sent');
    assert.equal(b.calls.flush, 1);
    assert.equal(b.items.length, 0);
  });

  it('plusieurs SOS en file : on suit le plus recent', async () => {
    const b = bench();
    b.items = [queued({ clientId: 'vieux', createdAt: 100 }), queued({ clientId: 'recent', createdAt: 900 }), queued({ clientId: 'milieu', createdAt: 500 })];
    await b.machine.resume();
    assert.equal(b.machine.snapshot().clientId, 'recent');
  });

  it('un element abime (charge utile absente) ne fait pas planter la reprise', async () => {
    const b = bench();
    b.items = [{ kind: 'sos', clientId: 'abime', createdAt: 777 } as unknown as QueueItem];
    await b.machine.resume();
    const snap = b.machine.snapshot();
    assert.equal(snap.phase, 'failed');
    assert.equal(snap.phoneAt, 777);
    assert.equal(snap.discreet, false);
  });

  it('la file illisible : pas de reprise, pas de plantage', async () => {
    const b = bench();
    b.queue.pending = async () => {
      throw new Error('IndexedDB');
    };
    assert.equal(await b.machine.resume(), false);
    assert.equal(b.machine.snapshot().phase, 'idle');
  });

  it('un SOS deja en cours : la reprise ne fait rien de plus', async () => {
    const b = bench();
    await b.press();
    const before = b.calls.flush;
    assert.equal(await b.machine.resume(), true);
    assert.equal(b.calls.flush, before);
    assert.equal(b.machine.snapshot().clientId, 'id-1');
  });

  it('un appui pendant la lecture de la file passe avant la reprise', async () => {
    const b = bench();
    b.items = [queued()];
    const slow = b.queue.pending;
    b.queue.pending = async () => {
      const items = await slow();
      b.machine.trigger({ discreet: false });
      return items;
    };
    await b.machine.resume();
    await settle();
    assert.equal(b.machine.snapshot().clientId, 'id-1');
  });
});

describe('createSosMachine : arret', () => {
  it('dispose arrete les minuteurs : plus aucun essai', async () => {
    const b = bench();
    await b.press();
    b.machine.dispose();
    assert.equal(b.timers, 0);
    await b.advance(RETRY_MS * 3);
    assert.equal(b.calls.flush, 0);
  });
});
