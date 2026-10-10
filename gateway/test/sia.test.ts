/**
 * Module SIA (recepteur SIA DC-09) : trames construites par un encodeur de test INDEPENDANT du module
 * (CRC, longueur, chiffrement AES), envoyees en TCP et en UDP sur 127.0.0.1 ; contexte factice (aucun PSIM).
 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';
import type { DeviceMessage, ModuleContext } from '../src/module.ts';
import { CID_CODES, SIA_CODES, translate } from '../src/modules/sia/codes.ts';
import { create, parseConfig, type SiaModule } from '../src/modules/sia/index.ts';
import { crc16, decryptBody, parseCidData, parseInner, parseOuter, parseSiaData, parseTimestamp } from '../src/modules/sia/protocol.ts';
import type { RawEvent } from '../src/modules/sia/protocol.ts';

// ---------------------------------------------------------------------------------------------------------------
// Encodeur de test (volontairement ecrit a part du module : un defaut du module ne s'y retrouve pas)
// ---------------------------------------------------------------------------------------------------------------

/** CRC-16/ARC par table. */
const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xa001 ^ (c >>> 1) : c >>> 1;
    t.push(c);
  }
  return t;
})();
function crcArc(s: string): number {
  let crc = 0;
  for (let i = 0; i < s.length; i++) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ s.charCodeAt(i)) & 0xff] as number);
  return crc;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `_${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())},${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${d.getUTCFullYear()}`;
}

interface FrameOpts {
  token?: string;
  seq?: string;
  rcvr?: string;
  pref?: string;
  acct?: string;
  data?: string;
  ext?: string[];
  /** ms epoch ; null = pas d'horodatage. Par defaut : maintenant. */
  ts?: number | null;
  key?: Buffer;
  badCrc?: boolean;
  badLength?: boolean;
}

/** Corps du message (du guillemet a la fin) selon DC-09. */
function message(o: FrameOpts): string {
  const token = o.token ?? 'SIA-DCS';
  const head = `${o.seq ?? '0001'}${o.rcvr ?? 'R0'}${o.pref ?? 'L0'}#${o.acct ?? '1234'}`;
  const tail = `${o.data ?? ''}]${(o.ext ?? []).map((x) => `[${x}]`).join('')}${o.ts === null ? '' : stamp(o.ts ?? Date.now())}`;
  if (!o.key) return `"${token}"${head}[${tail}`;
  const padLen = 16 - ((tail.length + 1) % 16);
  const pad = randomBytes(padLen)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, 'x')
    .slice(0, padLen)
    .padEnd(padLen, 'p');
  const c = createCipheriv(`aes-${o.key.length * 8}-cbc`, o.key, Buffer.alloc(16));
  c.setAutoPadding(false);
  const hex = Buffer.concat([c.update(`${pad}|${tail}`, 'latin1'), c.final()]).toString('hex').toUpperCase();
  return `"*${token}"${head}[${hex}`;
}

function wrap(msg: string, o: { badCrc?: boolean; badLength?: boolean } = {}): string {
  const crc = (crcArc(msg) ^ (o.badCrc ? 0x0101 : 0)).toString(16).toUpperCase().padStart(4, '0');
  const len = (msg.length + (o.badLength ? 1 : 0)).toString(16).toUpperCase().padStart(3, '0');
  return `\n${crc}0${len}${msg}\r`;
}

const build = (o: FrameOpts) => wrap(message(o), o);

/** Lit une reponse : verifie CRC et longueur, renvoie le message (du guillemet a la fin). */
function readReply(text: string): string {
  assert.ok(text.startsWith('\n') && text.endsWith('\r'), `reponse mal encadree : ${JSON.stringify(text)}`);
  const body = text.slice(1, -1);
  const msg = body.slice(8);
  assert.equal(parseInt(body.slice(5, 8), 16), msg.length, 'longueur de la reponse');
  assert.equal(parseInt(body.slice(0, 4), 16), crcArc(msg), 'CRC de la reponse');
  assert.equal(body[4], '0');
  return msg;
}

/** Dechiffre un ACK chiffre et renvoie le texte apres le bourrage. */
function openEncryptedAck(msg: string, key: Buffer): string {
  const hex = msg.slice(msg.indexOf('[') + 1);
  const d = createDecipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('latin1');
  return plain.slice(plain.indexOf('|') + 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Contexte factice et clients reseau
// ---------------------------------------------------------------------------------------------------------------

interface Fake {
  ctx: ModuleContext;
  emitted: { id: string; msg: DeviceMessage }[];
  logs: { level: string; text: string }[];
  order: string[];
  clock: { offset: number };
  failEmit: { on: boolean };
}

function fakeContext(): Fake {
  const f: Fake = {
    emitted: [],
    logs: [],
    order: [],
    clock: { offset: 0 },
    failEmit: { on: false },
    ctx: null as unknown as ModuleContext,
  };
  f.ctx = {
    emit(id, msg) {
      if (f.failEmit.on) throw new Error('file pleine');
      f.order.push('emit');
      f.emitted.push({ id, msg });
    },
    openMqtt: async () => {
      throw new Error('non utilise');
    },
    log(level, text) {
      f.logs.push({ level, text });
    },
    config: {},
    now: () => Date.now() + f.clock.offset,
  };
  return f;
}

const KEY128 = '000102030405060708090A0B0C0D0E0F';
const KEY256 = 'F0E1D2C3B4A5968778695A4B3C2D1E0FFFEEDDCCBBAA99887766554433221100';

function baseConfig(extra: Record<string, unknown> = {}, limits: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listen: { host: '127.0.0.1', port: 0, protocols: ['tcp', 'udp'] },
    accounts: {
      '1234': {
        panelName: 'Centrale bureaux',
        zones: { '1': { id: 'pir-hall' }, '2': { id: 'porte-entree' }, '5': { id: 'fumee-cuisine' } },
        partitions: { '1': { id: 'zone-bureaux' } },
        defaultId: 'centrale-bureaux',
      },
      AB12: {
        key: KEY128,
        panelName: 'Centrale entrepot',
        zones: { '*': { id: 'entrepot-zones' }, '3': { id: 'entrepot-porte' } },
        defaultId: 'centrale-entrepot',
      },
      '5678': {
        keyEnv: 'SIA_TEST_KEY_5678',
        panelName: 'Centrale magasin',
        zones: { '1': { id: 'magasin-pir' } },
      },
    },
    ...extra,
    limits: { frameTimeoutS: 0.4, idleTimeoutS: 5, ...limits },
  };
}

process.env.SIA_TEST_KEY_5678 = KEY256;

const running: SiaModule[] = [];
after(async () => {
  for (const m of running) await m.stop();
});

async function start(cfg: Record<string, unknown> = baseConfig()): Promise<{ mod: SiaModule; f: Fake; tcp: number; udp: number }> {
  const mod = create(cfg);
  const f = fakeContext();
  await mod.start(f.ctx);
  running.push(mod);
  const a = mod.addresses();
  return { mod, f, tcp: a.tcp ?? 0, udp: a.udp ?? 0 };
}

interface Client {
  sock: Socket;
  send(text: string): void;
  /** Prochaine reponse complete (jusqu'au CR), ou null si la connexion se ferme / delai depasse. */
  next(ms?: number): Promise<string | null>;
  closed: Promise<void>;
  isClosed(): boolean;
}

async function client(port: number, order?: string[]): Promise<Client> {
  const sock = connect({ host: '127.0.0.1', port });
  await new Promise<void>((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
  });
  sock.on('error', () => {});
  let buf = '';
  let closed = false;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  sock.on('data', (d) => {
    order?.push('reply');
    buf += d.toString('latin1');
    wake();
  });
  const closedP = new Promise<void>((res) => sock.on('close', () => {
    closed = true;
    wake();
    res();
  }));
  return {
    sock,
    send: (text) => sock.write(Buffer.from(text, 'latin1')),
    isClosed: () => closed,
    closed: closedP,
    async next(ms = 1500) {
      const end = Date.now() + ms;
      for (;;) {
        const cr = buf.indexOf('\r');
        if (cr >= 0) {
          const out = buf.slice(0, cr + 1);
          buf = buf.slice(cr + 1);
          return out;
        }
        if (closed || Date.now() > end) return null;
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, Math.max(5, end - Date.now()));
        });
      }
    },
  };
}

/** Une trame, une reponse, sur une connexion neuve. */
async function exchange(port: number, text: string, order?: string[]): Promise<string | null> {
  const c = await client(port, order);
  c.send(text);
  const r = await c.next();
  c.sock.destroy();
  return r;
}

async function udpExchange(port: number, text: string, ms = 800): Promise<string | null> {
  const s = createSocket('udp4');
  try {
    return await new Promise<string | null>((res) => {
      const timer = setTimeout(() => res(null), ms);
      s.on('message', (m) => {
        clearTimeout(timer);
        res(m.toString('latin1'));
      });
      s.send(Buffer.from(text, 'latin1'), port, '127.0.0.1');
    });
  } finally {
    s.close();
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('delai depasse');
    await wait(10);
  }
}

const token = (msg: string) => msg.slice(0, msg.indexOf('"', 1) + 1);

// ---------------------------------------------------------------------------------------------------------------

describe('SIA : decodage (sans reseau)', () => {
  it('CRC-16/ARC : vecteur de reference et accord avec l encodeur de test', () => {
    assert.equal(crc16('123456789'), 0xbb3d);
    for (const s of ['"NULL"0000R0L0#1234[]', '"SIA-DCS"0002R1L232#78919[#78919|NFA129]_11:10:00,10-12-2019']) assert.equal(crc16(s), crcArc(s));
  });

  it('horodatage : lecture stricte (dates impossibles refusees)', () => {
    assert.equal(parseTimestamp('_11:10:00,10-12-2019'), Date.UTC(2019, 9, 12, 11, 10, 0));
    for (const bad of ['_24:00:00,10-12-2019', '_11:10:00,02-30-2024', '_11:10:00,13-01-2024', '11:10:00,10-12-2019', '_1:10:00,10-12-2019']) {
      assert.equal(parseTimestamp(bad), null, bad);
    }
  });

  it('en-tete, donnees SIA-DCS (partition, zones multiples, texte) et Contact ID', () => {
    const raw = Buffer.from(build({ data: '#1234|Nri1/BA01/BA2^Hall^/ri2/FA005' }).slice(1, -1), 'latin1');
    const o = parseOuter(raw);
    assert.ok(o.ok);
    assert.equal(o.header.token, 'SIA-DCS');
    assert.equal(o.header.account, '1234');
    const inner = parseInner(o.header.body);
    assert.ok(inner.ok);
    const d = parseSiaData(inner.inner.data, '1234');
    assert.ok(d.ok);
    assert.deepEqual(
      d.events.map((e) => [e.code, e.zone, e.partition]),
      [['BA', '1', '1'], ['BA', '2', '1'], ['FA', '5', '2']],
    );
    assert.deepEqual(parseSiaData('NBA01', '1234').ok && parseSiaData('NBA01', '1234'), { ok: true, events: [{ format: 'sia', code: 'BA', qualifier: 'E', zone: '1', partition: null }] });
    const c = parseCidData('#1234|3130 01 015', '1234');
    assert.deepEqual(c, { ok: true, events: [{ format: 'cid', code: '130', qualifier: 'R', partition: '1', zone: '15' }] });
    assert.equal(parseCidData('#9999|1130 01 015', '1234').ok, false, 'compte des donnees different');
    assert.equal(parseSiaData('N??', '1234').ok, false);
    assert.equal(parseSiaData('Nri1', '1234').ok, false, 'aucun evenement');
  });

  it('fuzz : le decodeur ne leve jamais, quelle que soit l entree', () => {
    const seeds = [
      build({ data: '#1234|Nri1/BA01' }),
      build({ token: 'ADM-CID', data: '#1234|1130 01 015' }),
      build({ token: 'NULL' }),
      build({ data: '#AB12|NFA01', acct: 'AB12', key: Buffer.from(KEY128, 'hex') }),
    ];
    const alphabet = '\n\r"[]|#/^_:,-*0123456789ABCDEFNRLaxri \x00\xff';
    let rnd = 12345;
    const rand = (n: number) => {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      return rnd % n;
    };
    const key = Buffer.from(KEY128, 'hex');
    for (let i = 0; i < 6000; i++) {
      let s = seeds[rand(seeds.length)] as string;
      const edits = 1 + rand(6);
      for (let j = 0; j < edits; j++) {
        const pos = rand(s.length + 1);
        const op = rand(3);
        const ch = alphabet[rand(alphabet.length)] as string;
        if (op === 0) s = s.slice(0, pos) + ch + s.slice(pos);
        else if (op === 1) s = s.slice(0, pos) + s.slice(pos + 1);
        else s = s.slice(0, pos) + ch + s.slice(pos + 1);
      }
      if (rand(20) === 0) s = s.repeat(1 + rand(40));
      const raw = Buffer.from(s, 'latin1');
      const o = parseOuter(raw);
      const body = o.ok ? o.header.body : s;
      decryptBody(body, key);
      const inner = parseInner(body);
      const data = inner.ok ? inner.inner.data : s;
      parseSiaData(data, '1234');
      parseCidData(data, '1234');
      parseTimestamp(s);
    }
  });
});

describe('SIA : table de traduction des codes', () => {
  const sia = (code: string, zone: string | null = '1'): RawEvent => ({ format: 'sia', code, qualifier: 'E', zone, partition: null });
  const cid = (q: '1' | '3' | '6', code: string): RawEvent => ({ format: 'cid', code, qualifier: q === '3' ? 'R' : q === '6' ? 'P' : 'E', zone: '1', partition: '1' });
  const out = (ev: RawEvent) => {
    const r = translate(ev, []);
    return r ? [r.kind, r.out?.event ?? r.out?.state ?? null] : null;
  };

  it('codes SIA-DCS principaux', () => {
    const expected: Record<string, unknown> = {
      BA: ['alarm', 'intrusion'],
      BV: ['alarm', 'intrusion'],
      BR: ['restore-alarm', 'restored'],
      BH: ['restore-alarm', 'restored'],
      BB: ['fault', 'fault'],
      BU: ['restore-fault', 'restored'],
      BT: ['fault', 'fault'],
      BJ: ['restore-fault', 'restored'],
      FA: ['alarm', 'alarm'],
      FH: ['restore-alarm', 'restored'],
      FR: ['restore-alarm', 'restored'],
      FT: ['fault', 'fault'],
      FJ: ['restore-fault', 'restored'],
      KA: ['alarm', 'alarm'],
      HA: ['alarm', 'panic'],
      PA: ['alarm', 'panic'],
      PH: ['restore-alarm', 'restored'],
      MA: ['alarm', 'sos'],
      GA: ['alarm', 'gas'],
      GH: ['restore-alarm', 'restored'],
      WA: ['alarm', 'leak'],
      TA: ['alarm', 'tamper'],
      TR: ['restore-alarm', 'restored'],
      AT: ['fault', 'power_loss'],
      AR: ['restore-fault', 'power_restored'],
      YT: ['fault', 'low_battery'],
      YM: ['fault', 'low_battery'],
      XT: ['fault', 'low_battery'],
      DF: ['alarm', 'door_forced'],
      OP: ['heartbeat', null],
      CL: ['heartbeat', null],
      RP: ['heartbeat', null],
      RS: ['ignore', null],
    };
    for (const [code, exp] of Object.entries(expected)) assert.deepEqual(out(sia(code)), exp, code);
    assert.equal(translate(sia('VZ'), []), undefined, 'code inconnu : jamais devine');
    assert.equal(SIA_CODES.AT?.zone, false, 'perte secteur : evenement de centrale');
  });

  it('codes Contact ID principaux, qualificatifs E / R / P', () => {
    const expected: [string, string, unknown][] = [
      ['1', '110', ['alarm', 'alarm']],
      ['3', '110', ['restore-alarm', 'restored']],
      ['1', '111', ['alarm', 'alarm']],
      ['1', '120', ['alarm', 'panic']],
      ['1', '130', ['alarm', 'intrusion']],
      ['1', '131', ['alarm', 'intrusion']],
      ['1', '132', ['alarm', 'intrusion']],
      ['1', '133', ['alarm', 'intrusion']],
      ['1', '134', ['alarm', 'intrusion']],
      ['3', '134', ['restore-alarm', 'restored']],
      ['6', '130', ['alarm', 'intrusion']],
      ['1', '137', ['alarm', 'tamper']],
      ['1', '151', ['alarm', 'gas']],
      ['1', '154', ['alarm', 'leak']],
      ['1', '162', ['alarm', 'co']],
      ['1', '301', ['fault', 'power_loss']],
      ['3', '301', ['restore-fault', 'power_restored']],
      ['1', '302', ['fault', 'low_battery']],
      ['3', '302', ['restore-fault', 'restored']],
      ['1', '384', ['fault', 'low_battery']],
      ['1', '570', ['fault', 'fault']],
      ['3', '570', ['restore-fault', 'restored']],
      ['1', '401', ['heartbeat', null]],
      ['3', '401', ['heartbeat', null]],
      ['1', '602', ['heartbeat', null]],
    ];
    for (const [q, code, exp] of expected) assert.deepEqual(out(cid(q as '1', code)), exp, `${q}${code}`);
    assert.equal(translate(cid('1', '999'), []), undefined);
    assert.equal(CID_CODES['301']?.zone, false);
  });

  it('overrides : correction d une regle, ajout d un code, code ignore ; priorite compte > general', () => {
    const cfg = parseConfig({
      ...baseConfig(),
      overrides: { sia: { BA: { event: 'motion' }, VZ: { event: 'glass_break' } }, cid: { '130': 'ignore' } },
    });
    const acct = parseConfig({
      ...baseConfig(),
      accounts: { '1234': { defaultId: 'x', overrides: { sia: { BA: { event: 'forced_entry' } } } } },
    }).accounts.get('1234');
    assert.deepEqual(out2(translate(sia('BA'), [cfg.overrides])), ['alarm', 'motion']);
    assert.deepEqual(out2(translate(sia('VZ'), [cfg.overrides])), ['alarm', 'glass_break']);
    assert.deepEqual(out2(translate(cid('1', '130'), [cfg.overrides])), ['ignore', null]);
    assert.deepEqual(out2(translate(sia('BA'), [acct!.overrides, cfg.overrides])), ['alarm', 'forced_entry']);
    function out2(r: ReturnType<typeof translate>) {
      return r ? [r.kind, r.out?.event ?? r.out?.state ?? null] : null;
    }
  });
});

describe('SIA : configuration', () => {
  const bad = (cfg: Record<string, unknown>, pattern: RegExp) => assert.throws(() => create(cfg), (err: Error) => pattern.test(err.message) && !err.message.includes(KEY128) && !err.message.toLowerCase().includes(KEY128.toLowerCase()));

  it('refuse une configuration invalide avec un message clair', () => {
    bad({ accounts: baseConfig().accounts }, /listen est obligatoire/);
    bad({ ...baseConfig(), listen: { port: 4000 } }, /listen\.host doit etre l'adresse IP/);
    bad({ ...baseConfig(), listen: { host: 'localhost', port: 4000 } }, /listen\.host/);
    bad({ ...baseConfig(), listen: { host: '0.0.0.0', port: 4000 } }, /TOUTES les interfaces/);
    bad({ ...baseConfig(), listen: { host: '127.0.0.1', port: 70000 } }, /listen\.port/);
    bad({ ...baseConfig(), listen: { host: '127.0.0.1', port: 4000, protocols: ['sctp'] } }, /protocols/);
    bad({ ...baseConfig(), accounts: {} }, /accounts est obligatoire/);
    bad({ ...baseConfig(), accounts: { 'XYZ!': { defaultId: 'a' } } }, /numero de compte/);
    bad({ ...baseConfig(), accounts: { '1234': { key: KEY128.slice(2), defaultId: 'a' } } }, /32, 48 ou 64 caracteres hexadecimaux/);
    bad({ ...baseConfig(), accounts: { '1234': { key: KEY128, keyEnv: 'X', defaultId: 'a' } } }, /key OU keyEnv/);
    bad({ ...baseConfig(), accounts: { '1234': { keyEnv: 'SIA_ABSENTE_123', defaultId: 'a' } } }, /SIA_ABSENTE_123 n'est pas definie/);
    bad({ ...baseConfig(), accounts: { '1234': { requireEncryption: true, defaultId: 'a' } } }, /requireEncryption exige une cle/);
    bad({ ...baseConfig(), accounts: { '1234': { zones: { '1': { id: 'id avec espace' } } } } }, /identifiant PSIM/);
    bad({ ...baseConfig(), accounts: { '1234': { panelName: 'x' } } }, /aucune destination/);
    bad({ ...baseConfig(), accounts: { '1234': { defaultId: 'a', zone: {} } } }, /cle inconnue "zone"/);
    bad({ ...baseConfig(), maxClockSkewS: 0 }, /maxClockSkewS/);
    bad({ ...baseConfig(), overrides: { sia: { BA: { event: 'explosion' } } } }, /event inconnu du PSIM/);
    bad({ ...baseConfig(), overrides: { cid: { '13': 'ignore' } } }, /3 chiffres/);
    bad({ ...baseConfig(), limits: { maxConnections: 0 } }, /limits\.maxConnections/);
  });

  it('accepte 0.0.0.0 seulement avec allowAnyInterface ; chiffrement exige par defaut quand une cle est donnee', () => {
    const c = parseConfig({ ...baseConfig(), listen: { host: '0.0.0.0', port: 4000, allowAnyInterface: true } });
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.accounts.get('AB12')?.requireEncryption, true);
    assert.equal(c.accounts.get('1234')?.requireEncryption, false);
    assert.equal(c.accounts.get('5678')?.key?.length, 32, 'cle lue dans la variable d environnement');
    assert.equal(c.maxClockSkewMs, 20_000);
  });
});

describe('SIA : reception TCP et UDP', () => {
  it('TCP clair : BA zone 1 -> intrusion, ACK (meme sequence et compte) envoye APRES la transmission au PSIM', async () => {
    const { f, tcp } = await start();
    const ts = Date.now() - 2000;
    const reply = await exchange(tcp, build({ seq: '0042', rcvr: 'R1', pref: 'L2', data: '#1234|Nri1/BA01', ts }), f.order);
    assert.ok(reply);
    const msg = readReply(reply);
    assert.match(msg, /^"ACK"0042R1L2#1234\[\]_\d{2}:\d{2}:\d{2},\d{2}-\d{2}-\d{4}$/);
    const tsSec = Math.floor(ts / 1000) * 1000;
    assert.deepEqual(f.emitted, [{ id: 'pir-hall', msg: { event: 'intrusion', ts: tsSec, msgId: `1234-0042-${tsSec}` } }]);
    assert.deepEqual(f.order, ['emit', 'reply']);
  });

  it('TCP : plusieurs trames sur une meme connexion, decoupees arbitrairement', async () => {
    const { f, tcp } = await start();
    const c = await client(tcp);
    const all = build({ seq: '0001', data: '#1234|NBA02' }) + build({ seq: '0002', data: '#1234|NBR02' }) + build({ seq: '0003', token: 'NULL' });
    for (let i = 0; i < all.length; i += 7) {
      c.send(all.slice(i, i + 7));
      await wait(2);
    }
    for (const seq of ['0001', '0002', '0003']) assert.ok(readReply((await c.next()) as string).startsWith(`"ACK"${seq}R0L0#1234[]`));
    c.sock.destroy();
    assert.deepEqual(
      f.emitted.filter((e) => e.id === 'porte-entree' && e.msg.event !== 'heartbeat').map((e) => e.msg.event),
      ['intrusion', 'restored'],
    );
  });

  it('TCP chiffre AES-128 : trame *SIA-DCS -> evenement, ACK chiffre *ACK verifiable avec la cle', async () => {
    const { f, tcp } = await start();
    const key = Buffer.from(KEY128, 'hex');
    const reply = await exchange(tcp, build({ acct: 'AB12', seq: '0007', data: '#AB12|Nri1/FA05', key }));
    const msg = readReply(reply as string);
    assert.match(msg, /^"\*ACK"0007R0L0#AB12\[[0-9A-F]+$/);
    assert.match(openEncryptedAck(msg, key), /^\]_\d{2}:\d{2}:\d{2},\d{2}-\d{2}-\d{4}$/);
    assert.deepEqual(f.emitted.map((e) => [e.id, e.msg.state]), [['entrepot-zones', 'alarm']]);
  });

  it('UDP chiffre AES-256 (cle lue dans l environnement), Contact ID 1130 puis 3130', async () => {
    const { f, udp } = await start();
    const key = Buffer.from(KEY256, 'hex');
    const r1 = await udpExchange(udp, build({ token: 'ADM-CID', acct: '5678', seq: '0010', data: '#5678|1130 01 001', key }));
    assert.equal(token(readReply(r1 as string)), '"*ACK"');
    const r2 = await udpExchange(udp, build({ token: 'ADM-CID', acct: '5678', seq: '0011', data: '#5678|3130 01 001', key }));
    assert.equal(token(readReply(r2 as string)), '"*ACK"');
    assert.deepEqual(f.emitted.map((e) => [e.id, e.msg.event]), [['magasin-pir', 'intrusion'], ['magasin-pir', 'restored']]);
  });

  it('UDP clair : restauration, zone sans correspondance -> defaultId, panique', async () => {
    const { f, udp } = await start();
    assert.ok(await udpExchange(udp, build({ token: 'ADM-CID', seq: '0001', data: '#1234|1120 01 009' })));
    assert.ok(await udpExchange(udp, build({ token: 'ADM-CID', seq: '0002', data: '#1234|1301 00 000' })));
    assert.ok(await udpExchange(udp, build({ token: 'ADM-CID', seq: '0003', data: '#1234|3301 00 000' })));
    assert.deepEqual(f.emitted.map((e) => [e.id, e.msg.event]), [
      ['zone-bureaux', 'panic'],
      ['centrale-bureaux', 'power_loss'],
      ['centrale-bureaux', 'power_restored'],
    ]);
  });

  it('CRC faux ou longueur fausse -> NAK, rien transmis', async () => {
    const { f, tcp, udp } = await start();
    for (const r of [
      await exchange(tcp, build({ data: '#1234|NBA01', badCrc: true })),
      await exchange(tcp, build({ data: '#1234|NBA01', badLength: true })),
      await udpExchange(udp, build({ data: '#1234|NBA01', badCrc: true })),
    ]) {
      assert.match(readReply(r as string), /^"NAK"0000R0L0A0\[\]_/);
    }
    assert.equal(f.emitted.length, 0);
  });

  it('horodatage hors fenetre (+/- maxClockSkewS) ou absent -> NAK avec l heure du recepteur', async () => {
    const { f, tcp } = await start();
    for (const ts of [Date.now() - 60_000, Date.now() + 60_000, null]) {
      const r = readReply((await exchange(tcp, build({ data: '#1234|NBA01', ts }))) as string);
      assert.match(r, /^"NAK"0000R0L0A0\[\]_/);
      const back = parseTimestamp(r.slice(r.indexOf('_')));
      assert.ok(back !== null && Math.abs(back - Date.now()) < 5000);
    }
    assert.equal(f.emitted.length, 0);
    assert.ok(f.logs.some((l) => /horodatage hors fenetre/.test(l.text)));
  });

  it('allowMissingTimestamp : trame claire sans horodatage acceptee (msgId sans heure)', async () => {
    const cfg = baseConfig();
    ((cfg.accounts as Record<string, Record<string, unknown>>)['1234'] as Record<string, unknown>).allowMissingTimestamp = true;
    const { f, tcp } = await start(cfg);
    const r = readReply((await exchange(tcp, build({ seq: '0005', data: '#1234|NBA01', ts: null }))) as string);
    assert.equal(token(r), '"ACK"');
    assert.equal(f.emitted.length, 1);
    assert.equal(f.emitted[0]?.msg.ts, undefined);
    assert.match(f.emitted[0]?.msg.msgId ?? '', /^1234-0005-[0-9a-f]{12}$/);
  });

  it('compte inconnu -> NAK neutre, journalise une seule fois malgre la repetition', async () => {
    const { f, tcp } = await start();
    for (let i = 0; i < 6; i++) {
      const r = readReply((await exchange(tcp, build({ acct: '9999', seq: String(i).padStart(4, '0'), data: '#9999|NBA01' }))) as string);
      assert.match(r, /^"NAK"0000R0L0A0\[\]_/);
    }
    assert.equal(f.emitted.length, 0);
    assert.equal(f.logs.filter((l) => /compte inconnu/.test(l.text)).length, 1);
  });

  it('rejeu : meme trame -> ACK sans re-emission ; trame chiffree rejouee avec une autre sequence -> ACK sans re-emission', async () => {
    const { f, tcp } = await start();
    const frame = build({ seq: '0100', data: '#1234|NBA01' });
    assert.equal(token(readReply((await exchange(tcp, frame)) as string)), '"ACK"');
    assert.equal(token(readReply((await exchange(tcp, frame)) as string)), '"ACK"');
    assert.equal(f.emitted.length, 1);

    const key = Buffer.from(KEY128, 'hex');
    const msg = message({ acct: 'AB12', seq: '0200', data: '#AB12|NBA03', key });
    assert.equal(token(readReply((await exchange(tcp, wrap(msg))) as string)), '"*ACK"');
    const forged = msg.replace('"*SIA-DCS"0200', '"*SIA-DCS"0201');
    assert.equal(token(readReply((await exchange(tcp, wrap(forged))) as string)), '"*ACK"');
    assert.deepEqual(f.emitted.map((e) => e.id), ['pir-hall', 'entrepot-porte']);
  });

  it('compte requireEncryption : trame claire refusee (NAK) ; mauvaise cle -> NAK', async () => {
    const { f, tcp } = await start();
    assert.match(readReply((await exchange(tcp, build({ acct: 'AB12', data: '#AB12|NBA01' }))) as string), /^"NAK"/);
    const wrong = Buffer.from('FFEEDDCCBBAA99887766554433221100', 'hex');
    assert.match(readReply((await exchange(tcp, build({ acct: 'AB12', data: '#AB12|NBA01', key: wrong }))) as string), /^"NAK"/);
    assert.equal(f.emitted.length, 0);
  });

  it('DUH : format non pris en charge ou donnees incomprehensibles', async () => {
    const { f, tcp } = await start();
    assert.match(readReply((await exchange(tcp, build({ token: 'XYZ-ABC', seq: '0003', data: '#1234|NBA01' }))) as string), /^"DUH"0003R0L0#1234\[\]/);
    assert.match(readReply((await exchange(tcp, build({ seq: '0004', data: '#1234|N!!' }))) as string), /^"DUH"0004R0L0#1234\[\]/);
    assert.match(readReply((await exchange(tcp, build({ token: 'ADM-CID', seq: '0005', data: '#1234|9999' }))) as string), /^"DUH"/);
    assert.equal(f.emitted.length, 0);
  });

  it('ACK seulement si le PSIM a pris le message : emit en echec -> pas de reponse, la centrale renverra', async () => {
    const { f, tcp } = await start();
    f.failEmit.on = true;
    const frame = build({ seq: '0300', data: '#1234|NBA01' });
    assert.equal(await exchange(tcp, frame), null);
    f.failEmit.on = false;
    assert.equal(token(readReply((await exchange(tcp, frame)) as string)), '"ACK"', 'le renvoi est traite (pas pris pour un rejeu)');
    assert.equal(f.emitted.length, 1);
  });

  it('code inconnu : journalise une fois, ignore, acquitte (jamais d alarme inventee)', async () => {
    const { f, tcp } = await start();
    for (const seq of ['0001', '0002']) assert.equal(token(readReply((await exchange(tcp, build({ seq, data: '#1234|NVZ01' }))) as string)), '"ACK"');
    assert.equal(f.emitted.length, 0);
    assert.equal(f.logs.filter((l) => /SIA VZ inconnu/.test(l.text)).length, 1);
  });

  it('protection des alarmes : un derangement ne remplace pas une alarme en cours', async () => {
    const { f, tcp } = await start();
    await exchange(tcp, build({ seq: '0001', data: '#1234|NFA05' }));
    await exchange(tcp, build({ seq: '0002', data: '#1234|NFT05' }));
    await exchange(tcp, build({ seq: '0003', data: '#1234|NFR05' }));
    await exchange(tcp, build({ seq: '0004', data: '#1234|NFT05' }));
    assert.deepEqual(f.emitted.map((e) => e.msg.state ?? e.msg.event), ['alarm', 'restored', 'fault']);
  });
});

describe('SIA : resistance aux abus', () => {
  it('trame geante : connexion fermee aussitot (sans attendre le delai de trame), rien transmis', async () => {
    const { f, tcp } = await start(baseConfig({}, { frameTimeoutS: 10 }));
    const t0 = Date.now();
    const c = await client(tcp);
    c.send(`\n${'A'.repeat(1500)}`);
    await c.closed;
    const c2 = await client(tcp);
    c2.send(build({ data: `#1234|N${'BA01/'.repeat(250)}` }));
    await c2.closed;
    assert.equal(f.emitted.length, 0);
    const c3 = await client(tcp);
    c3.send('x'.repeat(3000));
    await c3.closed;
    assert.ok(Date.now() - t0 < 2000, 'fermetures des le depassement de 1024 octets');
  });

  it('connexion lente (slowloris) : fermee apres frameTimeoutS meme si des octets arrivent', async () => {
    const { tcp } = await start();
    const c = await client(tcp);
    const t0 = Date.now();
    const frame = build({ data: '#1234|NBA01' });
    let i = 0;
    const drip = setInterval(() => {
      if (!c.isClosed() && i < frame.length - 1) c.send(frame[i++] as string);
    }, 50);
    await c.closed;
    clearInterval(drip);
    const dt = Date.now() - t0;
    assert.ok(dt >= 300 && dt < 2000, `fermee apres ${dt} ms`);
  });

  it('connexion inactive fermee apres idleTimeoutS', async () => {
    const { tcp } = await start(baseConfig({}, { idleTimeoutS: 0.3 }));
    const c = await client(tcp);
    const t0 = Date.now();
    await c.closed;
    assert.ok(Date.now() - t0 < 2000);
  });

  it('flot de connexions : limite par adresse, les connexions admises fonctionnent', async () => {
    const { f, tcp } = await start(baseConfig({}, { maxConnectionsPerAddress: 3 }));
    const clients = await Promise.all(Array.from({ length: 8 }, () => client(tcp)));
    await wait(200);
    const open = clients.filter((c) => !c.isClosed());
    assert.equal(open.length, 3);
    open[0]?.send(build({ data: '#1234|NBA01' }));
    assert.equal(token(readReply((await open[0]?.next()) as string)), '"ACK"');
    for (const c of clients) c.sock.destroy();
    assert.equal(f.emitted.length, 1);
    assert.equal(f.logs.filter((l) => /connexion refusee/.test(l.text)).length, 1, 'journal non sature');
  });

  it('debit limite par adresse : au-dela, trames ignorees sans reponse', async () => {
    const { f, tcp } = await start(baseConfig({}, { perAddressPerMinute: 5 }));
    const c = await client(tcp);
    for (let i = 0; i < 8; i++) c.send(build({ token: 'NULL', seq: String(i + 1).padStart(4, '0') }));
    let n = 0;
    while ((await c.next(400)) !== null) n++;
    c.sock.destroy();
    assert.equal(n, 5);
    assert.ok(f.logs.some((l) => /debit trop eleve/.test(l.text)));
  });

  it('debit limite par compte (trames valides)', async () => {
    const { f, tcp } = await start(baseConfig({}, { perAccountPerMinute: 3 }));
    const c = await client(tcp);
    for (let i = 0; i < 6; i++) c.send(build({ seq: String(i + 1).padStart(4, '0'), data: `#1234|NBA0${i + 1}` }));
    let n = 0;
    while ((await c.next(400)) !== null) n++;
    c.sock.destroy();
    assert.equal(n, 3);
    assert.equal(f.emitted.length, 3);
  });

  it('fuzz reseau : trames alterees en rafale, le recepteur reste debout et repond ensuite normalement', async () => {
    const { f, tcp, udp } = await start(baseConfig({}, { perAddressPerMinute: 100000 }));
    const base = build({ data: '#1234|Nri1/BA01' });
    let rnd = 777;
    const rand = (n: number) => {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      return rnd % n;
    };
    const c = await client(tcp);
    for (let i = 0; i < 300; i++) {
      let s = base;
      for (let j = 0; j < 3; j++) {
        const p = 1 + rand(s.length - 2);
        s = s.slice(0, p) + String.fromCharCode(rand(256)) + s.slice(p + 1);
      }
      if (c.isClosed()) break;
      c.send(s);
      if (i % 50 === 0) await udpExchange(udp, s, 20);
    }
    c.sock.destroy();
    const r = await exchange(tcp, build({ seq: '0999', data: '#1234|NBA02' }));
    assert.equal(token(readReply(r as string)), '"ACK"');
    assert.ok(f.emitted.some((e) => e.id === 'porte-entree'));
  });

  it('aucune fuite de cle dans les journaux', async () => {
    const { f, tcp } = await start();
    const wrong = Buffer.from('FFEEDDCCBBAA99887766554433221100', 'hex');
    await exchange(tcp, build({ acct: 'AB12', data: '#AB12|NBA01', key: wrong }));
    await exchange(tcp, build({ acct: 'AB12', data: '#AB12|NBA01' }));
    await exchange(tcp, build({ acct: '5678', data: '#5678|NBA01', key: Buffer.from(KEY128, 'hex') }));
    await exchange(tcp, build({ acct: 'AB12', data: '#AB12|NBA01', key: Buffer.from(KEY128, 'hex'), ts: Date.now() - 999_000 }));
    const all = f.logs.map((l) => l.text).join('\n').toUpperCase();
    assert.ok(f.logs.length >= 3);
    for (const k of [KEY128, KEY256]) assert.ok(!all.includes(k.toUpperCase()) && !all.includes(k.slice(0, 16).toUpperCase()), 'cle absente des journaux');
  });
});

describe('SIA : supervision de la centrale', () => {
  it('NULL : signe de vie relaye ; silence -> defaut UNE fois (sauf alarme en cours) ; retour -> normal', async () => {
    const cfg = baseConfig({ supervisionS: 0.4 });
    for (const [k, a] of Object.entries(cfg.accounts as Record<string, Record<string, unknown>>)) if (k !== '1234') a.supervisionS = 0;
    const { f, tcp } = await start(cfg);
    const reply = readReply((await exchange(tcp, build({ token: 'NULL', seq: '0000' }))) as string);
    assert.match(reply, /^"ACK"0000R0L0#1234\[\]_/);
    const ids = ['pir-hall', 'porte-entree', 'fumee-cuisine', 'zone-bureaux', 'centrale-bureaux'];
    assert.deepEqual(f.emitted.map((e) => [e.id, e.msg.event]), ids.map((id) => [id, 'heartbeat']));

    await exchange(tcp, build({ seq: '0001', data: '#1234|NFA05' })); // fumee-cuisine en alarme
    f.emitted.length = 0;
    await until(() => f.emitted.length > 0, 3000);
    await wait(600); // pas de repetition du defaut
    const faulted = ids.filter((id) => id !== 'fumee-cuisine');
    assert.deepEqual(f.emitted.map((e) => [e.id, e.msg.state]), faulted.map((id) => [id, 'fault']));
    assert.ok(f.logs.some((l) => /aucune trame depuis/.test(l.text)));

    f.emitted.length = 0;
    await exchange(tcp, build({ token: 'NULL', seq: '0002' }));
    assert.deepEqual(f.emitted.map((e) => [e.id, e.msg.state]), faulted.map((id) => [id, 'normal']), 'retour ; heartbeat limite a un toutes les 30 s');
  });
});

describe('SIA : arret propre', () => {
  it('stop ferme les ports TCP et UDP et les connexions ouvertes ; port occupe -> erreur claire', async () => {
    const { mod, tcp } = await start();
    const c = await client(tcp);
    const busy = create({ ...baseConfig(), listen: { host: '127.0.0.1', port: tcp, protocols: ['tcp'] } });
    await assert.rejects(busy.start(fakeContext().ctx), /ecoute impossible sur 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
    await mod.stop();
    await c.closed;
    await assert.rejects(client(tcp));
    await mod.stop(); // idempotent
  });
});
