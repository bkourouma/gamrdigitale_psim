/**
 * WhatsApp : canal officiel (Meta, WhatsApp Cloud API) et canal CallMeBot, contre de faux services locaux (aucun message
 * reel n'est envoye). Format des envois, erreurs en clair, jeton et cles jamais reveles, configuration stricte du .env,
 * destinataires saisis dans l'interface, migration de la base, controles de mise en service.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { checkCallmebot, checkWhatsapp, registerWhatsappNumber } from '../scripts/commission/checks.ts';
import { preflight } from '../server/preflight.ts';
import type { PreflightInput } from '../server/preflight.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { callmebotChannel, clip, createNotifier, maskCallmebot, maskPhone, templateParam, whatsappChannel } from '../server/notifications.ts';
import type { Message, WhatsappConfig } from '../server/notifications.ts';
import { createRecipientsService } from '../server/recipients.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN = 'EAAGjetonSecret123';
const PHONE = '+2250700000042';
/** Chaine sans demi-caractere (surrogate isole) : encodeURIComponent la refuserait. */
const wellFormed = (text: string) => {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
};
const message: Message = {
  kind: 'opened',
  incidentId: 7,
  subject: '[PSIM] ALARME - a confirmer - Fumee sejour',
  text: 'ALARME - Fumee sejour\nZone : RDC - Sejour - Etage : Rez-de-chaussée\n\tEtat :     NON ACQUITTEE',
  data: { zone: 'RDC - Sejour', floor: 'Rez-de-chaussée' },
};

interface Seen {
  method: string;
  path: string;
  auth: string;
  body: any;
}

/** Faux service HTTP : enregistre chaque requete, repond ce qu'on lui dit. */
function fakeService() {
  const seen: Seen[] = [];
  let reply: { status: number; body: string } = { status: 200, body: '{}' };
  // Reponses par chemin (le premier motif qui correspond), sinon la reponse par defaut.
  let routes: [RegExp, number, unknown][] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: raw ? JSON.parse(raw) : null });
      const route = routes.find(([re]) => re.test(req.url ?? ''));
      const out = route ? { status: route[1], body: typeof route[2] === 'string' ? route[2] : JSON.stringify(route[2]) } : reply;
      res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(out.body);
    });
  });
  return {
    seen,
    routes: (list: [RegExp, number, unknown][]) => (routes = list),
    reply: (status: number, body: unknown) => (reply = { status, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => server.close(),
  };
}

// ---------------------------------------------------------------- WhatsApp officiel (Meta)

describe('WhatsApp officiel (Meta), faux Graph API local', () => {
  const meta = fakeService();
  let cfg: WhatsappConfig;
  before(async () => {
    cfg = { apiBase: `${await meta.start()}/v25.0/`, token: TOKEN, phoneId: '1234567890', template: 'psim_alerte', language: 'fr' };
  });
  after(() => meta.stop());
  const ok = () => meta.reply(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: '2250700000042' }], messages: [{ id: 'wamid.ABC' }] });

  it("envoie le modele approuve a 3 variables (titre, lieu, details), au bon numero, avec le jeton en en-tete", async () => {
    ok();
    const channel = whatsappChannel(cfg, [[PHONE, '0700000042', '+225 07'], []])!;
    assert.deepEqual(channel.recipients(1), [PHONE], 'seuls les numeros internationaux sans espace sont gardes');
    await channel.send(message, PHONE);
    const req = meta.seen.at(-1)!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v25.0/1234567890/messages');
    assert.equal(req.auth, `Bearer ${TOKEN}`);
    assert.equal(req.body.messaging_product, 'whatsapp');
    assert.equal(req.body.to, '2250700000042');
    assert.equal(req.body.type, 'template');
    assert.equal(req.body.template.name, 'psim_alerte');
    assert.deepEqual(req.body.template.language, { code: 'fr' });
    const params = req.body.template.components[0].parameters.map((p: { type: string; text: string }) => p.text);
    assert.deepEqual(params, [
      'ALARME - a confirmer - Fumee sejour',
      'RDC - Sejour - Rez-de-chaussée',
      'ALARME - Fumee sejour | Zone : RDC - Sejour - Etage : Rez-de-chaussée | Etat : NON ACQUITTEE',
    ]);
    for (const p of params) assert.ok(!/[\r\n\t]| {5,}/.test(p), `variable refusee par Meta : ${JSON.stringify(p)}`);
  });

  it("variables : jamais vides, jamais de retour a la ligne, bornees ; un message sans lieu dit « PSIM »", async () => {
    assert.equal(templateParam('', 10), '-');
    assert.equal(templateParam('a\r\n\r\nb\tc      d', 50), 'a | b | c d');
    assert.equal(templateParam('x'.repeat(700), 600).length, 600);
    assert.ok(templateParam('x'.repeat(700), 600).endsWith('...'));
    ok();
    await whatsappChannel(cfg, [[PHONE], []])!.send({ ...message, data: {} }, PHONE);
    assert.equal(meta.seen.at(-1)!.body.template.components[0].parameters[1].text, 'PSIM');
  });

  it("erreurs de Meta en clair (modele, jeton, numero de test), jeton jamais dans le message", async () => {
    const channel = whatsappChannel(cfg, [[PHONE], []])!;
    meta.reply(404, { error: { code: 132001, message: '(#132001) Template name does not exist in the translation' } });
    await assert.rejects(channel.send(message, PHONE), /code 132001\) : modele introuvable, pas encore approuve/);
    meta.reply(401, { error: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } });
    await assert.rejects(channel.send(message, PHONE), (err: Error) => /jeton refuse ou expire/.test(err.message) && !err.message.includes(TOKEN));
    meta.reply(400, { error: { code: 131030, message: 'Recipient phone number not in allowed list' } });
    await assert.rejects(channel.send(message, PHONE), /liste des destinataires autorises/);
    meta.reply(400, { error: { code: 99999, message: `Erreur inconnue avec ${TOKEN}` } });
    await assert.rejects(channel.send(message, PHONE), (err: Error) => /Erreur inconnue avec \*\*\*/.test(err.message) && !err.message.includes(TOKEN));
    meta.reply(200, { messaging_product: 'whatsapp' });
    await assert.rejects(channel.send(message, PHONE), /sans identifiant de message/);
    const down = whatsappChannel({ ...cfg, apiBase: 'http://127.0.0.1:1' }, [[PHONE], []])!;
    await assert.rejects(down.send(message, PHONE), (err: Error) => err.message === 'WhatsApp (Meta) injoignable');
  });

  it("sans jeton ou sans identifiant de numero : pas de canal ; numero masque a l'affichage", () => {
    assert.equal(whatsappChannel({ ...cfg, token: '' }, [[PHONE], []]), null);
    assert.equal(whatsappChannel({ ...cfg, phoneId: '' }, [[PHONE], []]), null);
    assert.equal(maskPhone(PHONE), '+225...42');
  });

  it("dans le notificateur : l'alarme part sur WhatsApp, le journal des envois ne garde que le numero masque", async () => {
    ok();
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-wa-')), join(ROOT, 'seed'));
    const engine = createEngine(db, () => {});
    const notifier = createNotifier({ db, engine, channels: [whatsappChannel(cfg, [[PHONE], []])!], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [TOKEN] });
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const before = meta.seen.length;
    await notifier.notifyIncident(engine.getSnapshot().incidents[0], 'opened');
    assert.equal(meta.seen.length, before + 1);
    assert.match(meta.seen.at(-1)!.body.template.components[0].parameters[0].text, /^ALARME/);
    assert.equal(meta.seen.at(-1)!.body.template.components[0].parameters[1].text, 'Accueil - Rez-de-chaussée', 'lieu : zone et etage');
    const logged = (db.prepare("SELECT channel, recipient, status FROM notification_log WHERE channel = 'whatsapp'").all() as object[]).map((r) => ({ ...r }));
    assert.deepEqual(logged, [{ channel: 'whatsapp', recipient: '+225...42', status: 'sent' }]);
  });

  describe('mise en service (lecture seule chez Meta)', () => {
    const PHONE_INFO: [RegExp, number, unknown] = [/fields=display_phone_number/, 200, { display_phone_number: '+225 01 02 03 04 05', verified_name: 'GAMR Securite', quality_rating: 'GREEN' }];
    const CLOUD: [RegExp, number, unknown] = [/fields=platform_type/, 200, { platform_type: 'CLOUD_API' }];
    const DEBUG: [RegExp, number, unknown] = [/debug_token/, 200, { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['W1'] }] } }];
    const template = (status: string, body = 'Alerte : {{1}}. Lieu : {{2}}. Details : {{3}} Ouvrez le PSIM.', language = 'fr'): [RegExp, number, unknown] => [
      /W1\/message_templates/,
      200,
      { data: [{ name: 'psim_alerte', status, language, components: [{ type: 'BODY', text: body }] }] },
    ];

    it("tout est en ordre : jeton, numero enregistre, modele approuve en fr a 3 variables ; rien n'est envoye", async () => {
      assert.equal((await checkWhatsapp({ ...cfg, token: '' }, [[], []])).status, 'skip');
      assert.equal((await checkWhatsapp({ ...cfg, token: '' }, [[], []], { dbRecipients: 2 })).status, 'fail', 'destinataires de l interface sans canal : echec');
      meta.routes([PHONE_INFO, CLOUD, DEBUG, template('APPROVED')]);
      const before = meta.seen.length;
      const good = await checkWhatsapp(cfg, [[PHONE], []], { dbRecipients: 1 });
      assert.equal(good.status, 'ok', good.detail);
      assert.match(good.detail, /expediteur \+225 01 02 03 04 05 « GAMR Securite », qualite GREEN \(Cloud API\) ; modele « psim_alerte » \(fr\) approuve, 3 variables ; 2 destinataire\(s\)/);
      assert.ok(meta.seen.slice(before).every((r) => r.method === 'GET'), 'lecture seule');
      assert.ok(!JSON.stringify(good).includes(TOKEN));
    });

    it("modele en attente, a 2 variables, absent ou dans une autre langue : ECHEC (aucune alerte ne partirait)", async () => {
      for (const [route, expected] of [
        [template('PENDING'), /au statut PENDING : il doit etre APPROUVE/],
        [template('APPROVED', 'Alerte : {{1}} a {{2}}.'), /2 variable\(s\) dans le corps, le PSIM en envoie 3/],
        [template('APPROVED', 'x {{1}} {{2}} {{3}}', 'en_US'), /pas en « fr » \(langues : en_US\)/],
        [[/W1\/message_templates/, 200, { data: [] }] as [RegExp, number, unknown], /introuvable dans le compte WhatsApp Business/],
      ] as [[RegExp, number, unknown], RegExp][]) {
        meta.routes([PHONE_INFO, CLOUD, DEBUG, route]);
        const res = await checkWhatsapp(cfg, [[PHONE], []]);
        assert.equal(res.status, 'fail', res.detail);
        assert.match(res.detail, expected);
      }
    });

    it("numero non enregistre sur la Cloud API : ECHEC avec la commande d'enregistrement", async () => {
      meta.routes([PHONE_INFO, [/fields=platform_type/, 200, { platform_type: 'NOT_APPLICABLE' }], DEBUG, template('APPROVED')]);
      const res = await checkWhatsapp(cfg, [[PHONE], []]);
      assert.equal(res.status, 'fail');
      assert.match(res.detail, /non enregistre sur la Cloud API/);
      assert.match(res.fix ?? '', /whatsapp-register:prod/);
    });

    it("modele impossible a verifier (jeton sans compte retrouvable) : avertissement, jamais « ok » ; PSIM_WHATSAPP_WABA_ID le permet", async () => {
      meta.routes([PHONE_INFO, CLOUD, [/debug_token/, 200, { data: {} }], template('APPROVED')]);
      const res = await checkWhatsapp(cfg, [[PHONE], []]);
      assert.equal(res.status, 'warn');
      assert.match(res.detail, /NON verifie.*PSIM_WHATSAPP_WABA_ID/);
      assert.equal((await checkWhatsapp({ ...cfg, wabaId: 'W1' }, [[PHONE], []])).status, 'ok');
    });

    it("jeton refuse : echec sans le jeton ; numero d'essai invalide refuse", async () => {
      meta.routes([[/fields=display_phone_number/, 401, { error: { code: 190, message: `expired ${TOKEN}` } }]]);
      const bad = await checkWhatsapp(cfg, [[PHONE], []]);
      assert.equal(bad.status, 'fail');
      assert.match(bad.detail, /jeton refuse ou expire/);
      assert.ok(!JSON.stringify(bad).includes(TOKEN));
      meta.routes([PHONE_INFO, CLOUD, DEBUG, template('APPROVED')]);
      assert.equal((await checkWhatsapp(cfg, [[], []], { to: '0700' })).status, 'fail', 'numero d essai invalide');
      meta.routes([]);
    });
  });

  it("reponses de Meta : modele mis en pause = echec ; numero non enregistre et detail de Meta en clair ; panne 5xx", async () => {
    const channel = whatsappChannel(cfg, [[PHONE], []])!;
    meta.reply(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.X', message_status: 'paused' }] });
    await assert.rejects(channel.send(message, PHONE), /mis en pause par Meta/);
    meta.reply(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.X', message_status: 'held_for_quality_assessment' }] });
    await channel.send(message, PHONE); // accepte (Meta peut le retenir quelque temps)
    meta.reply(400, { error: { code: 133010, message: 'Account not registered' } });
    await assert.rejects(channel.send(message, PHONE), /numero expediteur non enregistre sur la Cloud API/);
    meta.reply(400, { error: { code: 100, message: '(#100) Invalid parameter', error_data: { details: 'Param text cannot have new-line/tab characters' } } });
    await assert.rejects(channel.send(message, PHONE), /code 100\) : parametre refuse par Meta \(identifiant du numero, ou variable du modele\) - Param text cannot have new-line/);
    meta.reply(503, 'Service Unavailable');
    await assert.rejects(channel.send(message, PHONE), /WhatsApp HTTP 503 : Meta indisponible/);
  });

  it("variables : separateurs de ligne Unicode, espaces insecables et emojis coupes proprement", () => {
    const ls = String.fromCodePoint(0x2028);
    const nbsp = String.fromCodePoint(0xa0);
    const fire = String.fromCodePoint(0x1f525);
    assert.equal(templateParam(`a${ls}b${String.fromCodePoint(0x0b)}c${nbsp.repeat(6)}d`, 50), 'a | b | c d');
    const cut = templateParam(`${'y'.repeat(596)}${fire} suite`, 600);
    assert.ok(wellFormed(cut), 'jamais la moitie d un emoji');
    assert.equal(Array.from(cut).length, 600);
    assert.equal(clip(`ab${fire}${fire}`, 3), `ab${fire}`);
  });
});

// ---------------------------------------------------------------- CallMeBot

describe('WhatsApp par CallMeBot, faux service local', () => {
  const KEY = 'cleSecrete987';
  const RECIPIENT = `${PHONE}:${KEY}`;
  const bot = fakeService();
  let base = '';
  before(async () => {
    base = await bot.start();
  });
  after(() => bot.stop());
  const query = () => new URL(bot.seen.at(-1)!.path, 'http://x');

  it("envoie un GET whatsapp.php avec le numero, le texte (titre en gras) et la cle de CE destinataire", async () => {
    bot.reply(200, '<p>Message queued. You will receive it in a few seconds.</p>');
    const channel = callmebotChannel({ apiBase: `${base}/` }, [[RECIPIENT, 'pas-un-destinataire'], []])!;
    assert.equal(channel.id, 'callmebot');
    assert.deepEqual(channel.recipients(1), [RECIPIENT]);
    await channel.send(message, RECIPIENT);
    const q = query();
    assert.equal(q.pathname, '/whatsapp.php');
    assert.equal(q.searchParams.get('phone'), PHONE);
    assert.equal(q.searchParams.get('apikey'), KEY);
    assert.equal(q.searchParams.get('text'), `*${message.subject}*\n\n${message.text}`);
    assert.equal(channel.sendImages, undefined);
  });

  it("echecs (HTTP, reponse qui annonce une erreur, injoignable) ; la cle n'apparait jamais", async () => {
    const channel = callmebotChannel({ apiBase: base }, [[RECIPIENT], []])!;
    bot.reply(500, 'Internal error');
    await assert.rejects(channel.send(message, RECIPIENT), /CallMeBot HTTP 500/);
    bot.reply(200, `<b>APIKey is invalid.</b> apikey=${KEY}`);
    await assert.rejects(channel.send(message, RECIPIENT), (err: Error) => /CallMeBot refuse : APIKey is invalid/.test(err.message) && !err.message.includes(KEY));
    const down = callmebotChannel({ apiBase: 'http://127.0.0.1:1' }, [[RECIPIENT], []])!;
    await assert.rejects(down.send(message, RECIPIENT), (err: Error) => err.message === 'WhatsApp (CallMeBot) injoignable');
    assert.equal(maskCallmebot(RECIPIENT), '+225...42');
    assert.equal(callmebotChannel({ apiBase: base }, [[], []]), null);
  });

  it("un emoji a la limite de 1 500 caracteres ne fait pas echouer l'envoi (jamais la moitie d'un caractere)", async () => {
    bot.reply(200, 'Message queued');
    const fire = String.fromCodePoint(0x1f525);
    const channel = callmebotChannel({ apiBase: base }, [[RECIPIENT], []])!;
    const prefix = `*${message.subject}*\n\n`;
    await channel.send({ ...message, text: `${'z'.repeat(1499 - prefix.length)}${fire}${'z'.repeat(50)}` }, RECIPIENT);
    const sent = query().searchParams.get('text')!;
    assert.ok(wellFormed(sent));
    assert.equal(Array.from(sent).length, 1500);
  });

  it("essai demande avec des destinataires de niveau 2 seulement : l'essai part au niveau 2 (jamais « ok » sans envoi)", async () => {
    bot.reply(200, 'Message queued');
    const before = bot.seen.length;
    const res = await checkCallmebot({ apiBase: base }, [[], [RECIPIENT]], true);
    assert.equal(res.status, 'ok');
    assert.match(res.detail, /1 destinataire\(s\) de niveau 2/);
    assert.equal(bot.seen.length, before + 1);
  });

  it("mise en service : rien n'est envoye sans --callmebot-test ; avec, un essai par destinataire de niveau 1", async () => {
    bot.reply(200, 'Message queued');
    assert.equal((await checkCallmebot({ apiBase: base }, [[], []], false)).status, 'skip');
    const before = bot.seen.length;
    assert.match((await checkCallmebot({ apiBase: base }, [[RECIPIENT], []], false)).detail, /\+225\.\.\.42 ; aucun message envoye/);
    assert.equal(bot.seen.length, before);
    assert.equal((await checkCallmebot({ apiBase: base }, [[RECIPIENT], ['+33612345678:autreCle1']], true)).status, 'ok');
    assert.equal(bot.seen.length, before + 1, 'niveau 1 seulement');
  });
});

// ---------------------------------------------------------------- destinataires, configuration, base

describe('WhatsApp : destinataires, configuration et base', () => {
  const service = (whatsapp: boolean) =>
    createRecipientsService({
      db: openDb(':memory:'),
      audit: () => {},
      env: { email: [[], []], telegram: [[], []], whatsapp: [[PHONE], []], callmebot: [['+2250500000001:cleX123'], []], webhook: [[], []] },
      available: { email: true, telegram: true, whatsapp, callmebot: false, webhook: true },
    });

  it("l'interface ajoute des numeros WhatsApp (canal configure), refuse un numero mal ecrit et toute entree CallMeBot", () => {
    const svc = service(true);
    const added = svc.add('admin', { channel: 'whatsapp', address: '+2250500000099', level: 2, label: 'Gardien' });
    assert.deepEqual([added.channel, added.display, added.level, added.source], ['whatsapp', '+225...99', 2, 'db']);
    assert.deepEqual(svc.effective('whatsapp', 1), [PHONE]);
    assert.deepEqual(svc.effective('whatsapp', 2), ['+2250500000099']);
    assert.throws(() => svc.add('admin', { channel: 'whatsapp', address: '07 00 00 00 99', level: 1 }), /format international/);
    assert.throws(() => svc.add('admin', { channel: 'callmebot', address: '+2250500000001:cle', level: 1 }), /dans le \.env/);
    assert.throws(() => service(false).add('admin', { channel: 'whatsapp', address: '+2250500000099', level: 1 }), /PSIM_WHATSAPP_TOKEN et PSIM_WHATSAPP_PHONE_ID/);
    assert.ok(!JSON.stringify(svc.list()).includes('cleX123'), 'cle CallMeBot jamais listee');
  });

  it("une base anterieure accepte ensuite les destinataires WhatsApp, sans perdre les autres (identifiants conserves)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-wa-db-'));
    const path = join(dir, 'psim.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE notification_recipient (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'webhook')),
      address TEXT NOT NULL, level INTEGER NOT NULL CHECK (level IN (1, 2)), label TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL, UNIQUE (channel, address, level));
      INSERT INTO notification_recipient (id, channel, address, level, label, active, created_at, created_by) VALUES (5, 'email', 'chef@exemple.fr', 2, 'Chef', 1, 1, 'admin');`);
    old.close();
    const db = openDb(path);
    assert.deepEqual({ ...(db.prepare('SELECT id, channel, address, label, zones FROM notification_recipient').get() as object) }, { id: 5, channel: 'email', address: 'chef@exemple.fr', label: 'Chef', zones: null }, 'colonne zones presente des la premiere ouverture');
    db.prepare("INSERT INTO notification_recipient (channel, address, level, label, active, created_at, created_by) VALUES ('whatsapp', ?, 1, '', 1, 2, 'admin')").run(PHONE);
    assert.equal((db.prepare("SELECT id FROM notification_recipient WHERE channel = 'whatsapp'").get() as { id: number }).id, 6, 'la numerotation continue');
    assert.throws(() => db.prepare("INSERT INTO notification_recipient (channel, address, level, label, active, created_at, created_by) VALUES ('fax', 'x', 1, '', 1, 2, 'a')").run(), /CHECK/);
    db.close();
    openDb(path).close(); // deja migree : rien a refaire
  });

  it(".env : un numero mal ecrit bloque le demarrage avec sa position ; une entree « numero:cle » renvoie vers CallMeBot ; jamais de cle affichee", () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/config.ts')"], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
        encoding: 'utf8',
      });
    assert.equal(run({ PSIM_NOTIFY_WHATSAPP_L1: `${PHONE},+33612345678`, PSIM_NOTIFY_CALLMEBOT_L1: `${PHONE}:cle123` }).status, 0);
    const keyInMeta = run({ PSIM_NOTIFY_WHATSAPP_L1: `${PHONE}:cleSecrete` });
    assert.notEqual(keyInMeta.status, 0);
    assert.match(keyInMeta.stderr, /PSIM_NOTIFY_WHATSAPP_L1 : l'entree n°1 est invalide.*PSIM_NOTIFY_CALLMEBOT_L1/);
    assert.ok(!keyInMeta.stderr.includes('cleSecrete'));
    const badBot = run({ PSIM_NOTIFY_CALLMEBOT_L1: `${PHONE}:ok123, 0612345678:cleSecrete` });
    assert.match(badBot.stderr, /PSIM_NOTIFY_CALLMEBOT_L1 : l'entree n°2 est invalide/);
    assert.ok(!badBot.stderr.includes('cleSecrete'));
  });
});

// ---------------------------------------------------------------- enregistrement, demarrage

describe('WhatsApp : enregistrement du numero, controle de demarrage, journal', () => {
  const meta = fakeService();
  let cfg: WhatsappConfig;
  before(async () => {
    cfg = { apiBase: `${await meta.start()}/v25.0`, token: TOKEN, phoneId: '1234567890', template: 'psim_alerte', language: 'fr' };
  });
  after(() => meta.stop());

  it("enregistrement : POST /register avec le PIN ; PIN invalide refuse sans appel ; refus de Meta explique, sans le jeton", async () => {
    meta.reply(200, { success: true });
    assert.deepEqual(await registerWhatsappNumber(cfg, '123456'), { ok: true, message: 'Numero enregistre sur la Cloud API : les alertes peuvent partir.' });
    const req = meta.seen.at(-1)!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v25.0/1234567890/register');
    assert.deepEqual(req.body, { messaging_product: 'whatsapp', pin: '123456' });
    const before = meta.seen.length;
    assert.equal((await registerWhatsappNumber(cfg, '12ab')).ok, false);
    assert.equal(meta.seen.length, before, 'aucun appel avec un PIN invalide');
    assert.equal((await registerWhatsappNumber({ ...cfg, token: '' }, '123456')).ok, false);
    meta.reply(400, { error: { code: 133005, message: `Two step verification PIN Mismatch ${TOKEN}` } });
    const refused = await registerWhatsappNumber(cfg, '654321');
    assert.equal(refused.ok, false);
    assert.match(refused.message, /code 133005\) : Two step verification PIN Mismatch \*\*\*/);
  });

  const base: PreflightInput = {
    production: true, host: '127.0.0.1', mqttHost: '127.0.0.1', tlsEnabled: true, mqttTlsEnabled: false, trustProxy: false, cookieSecure: true,
    simEnabled: false, demoLogin: false, adminPassword: 'Admin-tres-solide-123', operatorPassword: 'Operateur-tres-solide-456', mqttPassword: 'Mqtt-tres-solide-789',
    notificationChannels: 1, escalationConfigured: true, detectorTimeoutS: 180, backupEveryH: 24, requireTotp: 'all', heartbeatUrl: 'https://hc.exemple.fr/ping/x',
  };
  const errors = (extra: Partial<PreflightInput>) => preflight({ ...base, ...extra }).filter((f) => f.level === 'error').map((f) => f.message);

  it("demarrage : adresse de service en http:// (jeton en clair) ou illisible refusee en production ; boucle locale admise", () => {
    assert.deepEqual(errors({ serviceUrls: [{ name: 'PSIM_WHATSAPP_API', url: 'https://graph.facebook.com/v25.0' }] }), []);
    assert.match(errors({ serviceUrls: [{ name: 'PSIM_WHATSAPP_API', url: 'http://graph.facebook.com/v25.0' }] }).join(), /PSIM_WHATSAPP_API en http:\/\/ : le jeton/);
    assert.match(errors({ serviceUrls: [{ name: 'PSIM_CALLMEBOT_API', url: 'pas une adresse' }] }).join(), /PSIM_CALLMEBOT_API illisible/);
    assert.deepEqual(errors({ serviceUrls: [{ name: 'PSIM_TELEGRAM_API', url: 'http://127.0.0.1:9999' }] }), [], 'faux service local de la demonstration');
    assert.equal(preflight({ ...base, production: false, serviceUrls: [{ name: 'PSIM_WHATSAPP_API', url: 'http://x.fr' }] })[0].level, 'warn', 'hors production : avertissement');
  });

  it("demarrage : des destinataires d'un canal non configure (ils ne recevraient rien) sont refuses en production", () => {
    assert.match(errors({ orphanRecipients: ['WhatsApp'] }).join(), /Destinataires WhatsApp declares, mais canal non configure : ils ne recevraient AUCUNE alerte/);
  });

  it("une configuration invalide est ecrite dans data/logs/psim.log (une tache planifiee n'a pas de console), sans le contenu fautif", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'psim-boot-')), 'data');
    const run = spawnSync(process.execPath, ['server/index.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PSIM_DATA_DIR: dataDir, PSIM_NOTIFY_WHATSAPP_L1: '+2250700000000,07 00 cleSecrete' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    const log = readFileSync(join(dataDir, 'logs', 'psim.log'), 'utf8');
    assert.match(log, /ERROR \[psim\] Demarrage impossible : PSIM_NOTIFY_WHATSAPP_L1 : l'entree n°2 est invalide/);
    assert.ok(!log.includes('cleSecrete'));
    assert.match(run.stderr, /Demarrage impossible/);
  });
});
