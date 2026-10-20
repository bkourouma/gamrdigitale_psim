/**
 * Appel par telephone Android du site (passerelle locale), contre un faux telephone local : aucun appel reel.
 * Format de la requete, secret jamais revele, appels reserves aux alarmes, erreurs en clair, choix du canal.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildChannels, phoneGatewayChannel } from '../server/notifications.ts';
import type { ChannelsConfig, Message } from '../server/notifications.ts';

const PHONE = '+2250700000042';
const TOKEN = 'secret-partage-1234';
const message: Message = { kind: 'opened', incidentId: 7, subject: '[PSIM] ALARME - Fumee sejour', text: 'ALARME', data: { zone: 'RDC - Sejour' } };

describe('Telephone-passerelle, faux telephone local', () => {
  const seen: string[] = [];
  let status = 200;
  let base = '';
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(status).end('ok');
  });
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/psim-appel`;
  });
  after(() => server.close());

  it('envoie le numero, le type et le texte, avec le secret', async () => {
    const channel = phoneGatewayChannel({ url: base, token: TOKEN }, [[PHONE], []])!;
    await channel.send(message, PHONE);
    const url = new URL(seen.at(-1)!, 'http://x');
    assert.equal(url.pathname, '/psim-appel');
    assert.equal(url.searchParams.get('number'), PHONE);
    assert.equal(url.searchParams.get('kind'), 'opened');
    assert.match(url.searchParams.get('text') ?? '', /fumee sejour/);
    assert.equal(url.searchParams.get('token'), TOKEN);
  });

  it('ne sonne que pour une alarme, jamais pour un redemarrage', () => {
    const channel = phoneGatewayChannel({ url: base, token: '' }, [[PHONE], []])!;
    assert.equal(channel.accepts!('opened'), true);
    assert.equal(channel.accepts!('unacked'), true);
    assert.equal(channel.accepts!('restart'), false);
    assert.equal(channel.accepts!('security'), false);
  });

  it('erreur en clair, sans reveler le secret ; telephone eteint = echec', async () => {
    const channel = phoneGatewayChannel({ url: base, token: TOKEN }, [[PHONE], []])!;
    status = 403;
    await assert.rejects(() => channel.send(message, PHONE), (e: Error) => /HTTP 403/.test(e.message) && !e.message.includes(TOKEN));
    status = 200;
    const dead = phoneGatewayChannel({ url: 'http://127.0.0.1:1/psim-appel', token: TOKEN }, [[PHONE], []])!;
    await assert.rejects(() => dead.send(message, PHONE), (e: Error) => /injoignable/.test(e.message) && !e.message.includes(TOKEN));
  });

  it('sans adresse : pas de canal ; avec adresse : remplace Vonage sous le meme identifiant', () => {
    assert.equal(phoneGatewayChannel({ url: '', token: '' }, [[], []]), null);
    const cfg = {
      smtp: { host: '', port: 25, secure: false, user: '', password: '', from: '' },
      telegram: { token: '', apiBase: '' },
      whatsapp: { apiBase: '', token: '', phoneId: '', template: '', language: '' },
      callmebot: { apiBase: '' },
      vonage: { apiBase: '', applicationId: '', privateKey: '', from: '', language: 'fr-FR' },
      phoneGateway: { url: base, token: '' },
      webhookSecret: '',
    } as ChannelsConfig;
    const channels = buildChannels(cfg, () => [PHONE]);
    assert.deepEqual(channels.map((c) => c.id), ['vonage', 'webhook']);
  });
});
