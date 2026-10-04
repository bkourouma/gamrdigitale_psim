import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { PsimError } from '../server/engine.ts';
import { emailChannel } from '../server/notifications.ts';
import { createRecipientsService, maskAddress, validateAddress } from '../server/recipients.ts';

const status = (code: number) => (e: unknown) => e instanceof PsimError && e.status === code;

function setup(over: { email?: boolean; telegram?: boolean } = {}) {
  const db = openDb(':memory:');
  const audit: string[] = [];
  const svc = createRecipientsService({
    db,
    audit: (actor, action, ref) => void audit.push(`${actor}:${action}:${ref?.details ?? ''}`),
    env: { email: [['fixe@exemple.fr'], ['chef@exemple.fr']], telegram: [[], []], whatsapp: [[], []], webhook: [[], []] },
    available: { email: over.email ?? true, telegram: over.telegram ?? true, whatsapp: false, webhook: true },
  });
  return { db, svc, audit };
}

describe('validation des adresses', () => {
  it('e-mail', () => {
    assert.equal(validateAddress('email', '  agent@exemple.fr '), 'agent@exemple.fr');
    for (const bad of ['', 'sans-arobase', 'a@b', 'a b@c.fr', 'a@b.c', 'x@y.fr,z@w.fr', '<a@b.fr>', 'a@b.fr\nBcc: x@y.fr', 'a'.repeat(300) + '@b.fr', 42, null]) {
      assert.throws(() => validateAddress('email', bad), status(400), JSON.stringify(bad));
    }
  });

  it("l'injection d'en-tete par saut de ligne est refusee", () => {
    assert.throws(() => validateAddress('email', 'a@b.fr\r\nBcc: victime@x.fr'), status(400));
  });

  it('Telegram : numero de conversation ou @canal', () => {
    for (const ok of ['123456789', '-1001234567890', '@mon_canal']) assert.equal(validateAddress('telegram', ok), ok);
    for (const bad of ['12', 'abc', '@a', '@1abc', '12 34', '1e9', '@canal avec espace']) assert.throws(() => validateAddress('telegram', bad), status(400), bad);
  });

  it('webhook : http ou https seulement', () => {
    assert.equal(validateAddress('webhook', 'https://hooks.exemple.fr/x/y?z=1'), 'https://hooks.exemple.fr/x/y?z=1');
    for (const bad of ['ftp://x', 'javascript:alert(1)', 'file:///etc/passwd', 'pas une url', '//x.fr', '']) assert.throws(() => validateAddress('webhook', bad), status(400), bad);
  });

  it("l'affichage ne revele jamais un secret de webhook", () => {
    assert.equal(maskAddress('webhook', 'https://hooks.exemple.fr/services/JETON-SECRET'), 'hooks.exemple.fr');
    assert.equal(maskAddress('email', 'agent@exemple.fr'), 'a***@exemple.fr');
    assert.equal(maskAddress('telegram', '123456789'), '123456789');
  });
});

describe('destinataires : .env + base', () => {
  it('additionne les deux sources, sans doublon, par canal et par niveau', () => {
    const t = setup();
    t.svc.add('admin', { channel: 'email', address: 'nouveau@exemple.fr', level: 1 });
    t.svc.add('admin', { channel: 'email', address: 'astreinte@exemple.fr', level: 2, label: 'Astreinte' });
    assert.deepEqual(t.svc.effective('email', 1), ['fixe@exemple.fr', 'nouveau@exemple.fr']);
    assert.deepEqual(t.svc.effective('email', 2), ['chef@exemple.fr', 'astreinte@exemple.fr']);
    assert.deepEqual(t.svc.effective('telegram', 1), []);
  });

  it('la liste distingue le .env (lecture seule) des destinataires modifiables, et masque les adresses', () => {
    const t = setup();
    t.svc.add('admin', { channel: 'webhook', address: 'https://hooks.exemple.fr/JETON', level: 1 });
    const list = t.svc.list();
    const env = list.filter((r) => r.source === 'env');
    assert.deepEqual(env.map((r) => [r.display, r.level, r.id]), [['f***@exemple.fr', 1, null], ['c***@exemple.fr', 2, null]]);
    const hook = list.find((r) => r.channel === 'webhook')!;
    assert.equal(hook.display, 'hooks.exemple.fr');
    assert.equal(hook.source, 'db');
    assert.ok(!JSON.stringify(list).includes('JETON'), "l'adresse complete du webhook n'est jamais renvoyee");
  });

  it('un destinataire desactive ne recoit plus rien, un retire disparait', () => {
    const t = setup();
    const r = t.svc.add('admin', { channel: 'email', address: 'a@exemple.fr', level: 1 });
    t.svc.update('admin', r.id!, { active: false });
    assert.ok(!t.svc.effective('email', 1).includes('a@exemple.fr'));
    t.svc.update('admin', r.id!, { active: true, level: 2 });
    assert.ok(t.svc.effective('email', 2).includes('a@exemple.fr'));
    t.svc.remove('admin', r.id!);
    assert.ok(!t.svc.effective('email', 2).includes('a@exemple.fr'));
    assert.throws(() => t.svc.remove('admin', r.id!), status(404));
  });

  it('refuse les doublons, ceux du .env, un niveau ou un canal invalides, et un canal non configure', () => {
    const t = setup({ telegram: false });
    t.svc.add('admin', { channel: 'email', address: 'a@exemple.fr', level: 1 });
    assert.throws(() => t.svc.add('admin', { channel: 'email', address: 'a@exemple.fr', level: 1 }), status(409));
    assert.doesNotThrow(() => t.svc.add('admin', { channel: 'email', address: 'a@exemple.fr', level: 2 }), 'meme adresse, autre niveau : permis');
    assert.throws(() => t.svc.add('admin', { channel: 'email', address: 'fixe@exemple.fr', level: 1 }), (e) => e instanceof PsimError && /deja defini dans le \.env/.test(e.message));
    assert.throws(() => t.svc.add('admin', { channel: 'email', address: 'b@exemple.fr', level: 3 }), status(400));
    assert.throws(() => t.svc.add('admin', { channel: 'sms', address: '0102030405', level: 1 }), status(400));
    assert.throws(() => t.svc.add('admin', { channel: 'telegram', address: '123456789', level: 1 }), (e) => e instanceof PsimError && e.status === 409 && /Telegram non configure/.test(e.message));
    assert.throws(() => t.svc.add('admin', { channel: 'email', address: 'b@exemple.fr', level: 1, label: 'x'.repeat(100) }), status(400));
  });

  it("modifier vers un doublon est refuse, et rien n'est modifie", () => {
    const t = setup();
    t.svc.add('admin', { channel: 'email', address: 'a@exemple.fr', level: 1 });
    const second = t.svc.add('admin', { channel: 'email', address: 'a@exemple.fr', level: 2 });
    assert.throws(() => t.svc.update('admin', second.id!, { level: 1 }), status(409));
    assert.equal(t.svc.list().find((r) => r.id === second.id)!.level, 2);
    assert.throws(() => t.svc.update('admin', second.id!, { active: 'oui' }), status(400));
  });

  it('plafonne le nombre de destinataires', () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.svc.add('admin', { channel: 'email', address: `u${i}@exemple.fr`, level: 1 });
    assert.throws(() => t.svc.add('admin', { channel: 'email', address: 'de-trop@exemple.fr', level: 1 }), (e) => e instanceof PsimError && /Limite de 100/.test(e.message));
  });

  it('journalise chaque changement sans reveler une adresse complete', () => {
    const t = setup();
    const r = t.svc.add('admin', { channel: 'email', address: 'secret@exemple.fr', level: 1 });
    t.svc.update('admin', r.id!, { active: false });
    t.svc.remove('admin', r.id!);
    assert.equal(t.audit.length, 3);
    assert.ok(t.audit[0].startsWith('admin:recipient_added:email s***@exemple.fr niveau 1'));
    assert.ok(t.audit.every((a) => !a.includes('secret@exemple.fr')));
  });
});

describe('canaux : les destinataires sont relus a chaque envoi', () => {
  it("un destinataire ajoute est pris en compte tout de suite, sans redemarrage", () => {
    const t = setup();
    const channel = emailChannel({ host: 'smtp.exemple.fr', port: 25, secure: false, user: '', password: '', from: 'psim@exemple.fr' }, (level) => t.svc.effective('email', level))!;
    assert.deepEqual(channel.recipients(1), ['fixe@exemple.fr']);
    const added = t.svc.add('admin', { channel: 'email', address: 'tout-de-suite@exemple.fr', level: 1 });
    assert.deepEqual(channel.recipients(1), ['fixe@exemple.fr', 'tout-de-suite@exemple.fr']);
    t.svc.update('admin', added.id!, { active: false });
    assert.deepEqual(channel.recipients(1), ['fixe@exemple.fr']);
  });
});
