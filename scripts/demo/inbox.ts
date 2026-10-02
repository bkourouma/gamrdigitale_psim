/**
 * « Boite de reception » de la demonstration : un faux serveur SMTP et un faux serveur Telegram,
 * locaux, qui affichent ce que le PSIM enverrait. Aucun message ne quitte la machine.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface Inbox {
  smtpPort: number;
  telegramBase: string;
  received: { channel: string; to: string; subject: string; images: number }[];
  close(): Promise<void>;
}

function decodeSubject(raw: string): string {
  // Un en-tete long est « replie » sur plusieurs lignes (continuation = ligne qui commence par un espace).
  const header = /^Subject:[ \t]*((?:.*)(?:\r?\n[ \t].*)*)/im.exec(raw)?.[1];
  if (!header) return '(sans objet)';
  const unfolded = header.replace(/\r?\n[ \t]+/g, ' ');
  // nodemailer encode les objets accentues en mots « =?UTF-8?Q?...?= » ; les mots adjacents se recollent.
  return unfolded
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_m, enc: string, text: string) =>
      enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
    );
}

/** Demarre les deux faux serveurs. `smtpPort` / `telegramPort` a 0 = port libre au choix. */
export async function startInbox(log: (line: string) => void, smtpPort = 0, telegramPort = 0): Promise<Inbox> {
  const received: Inbox['received'] = [];

  const smtp = createTcpServer((socket) => {
    let to: string[] = [];
    let inData = false;
    let buffer = '';
    socket.write('220 inbox-demo ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const subject = decodeSubject(data);
          const images = (data.match(/Content-Type: image\/jpeg/gi) ?? []).length;
          for (const recipient of to) {
            received.push({ channel: 'e-mail', to: recipient, subject, images });
            log(`[courrier]  -> ${recipient} : ${subject}${images ? `  (+${images} image${images > 1 ? 's' : ''} jointe${images > 1 ? 's' : ''})` : ''}`);
          }
          to = [];
          socket.write('250 OK\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (/^(EHLO|HELO)/i.test(line)) socket.write('250-inbox-demo\r\n250 8BITMIME\r\n');
        else if (/^RCPT TO/i.test(line)) {
          to.push(/<([^>]+)>/.exec(line)?.[1] ?? '?');
          socket.write('250 OK\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});
  });

  const telegram = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const method = /\/bot[^/]+\/(\w+)/.exec(req.url ?? '')?.[1];
      if (method === 'sendMessage') {
        const msg = JSON.parse(body.toString() || '{}') as { chat_id?: string; text?: string };
        const subject = (msg.text ?? '').split('\n')[0];
        received.push({ channel: 'telegram', to: String(msg.chat_id), subject, images: 0 });
        log(`[telegram]  -> chat ${msg.chat_id} : ${subject}`);
      } else if (method === 'sendPhoto') {
        const chat = /name="chat_id"\r\n\r\n([^\r]+)/.exec(body.toString('latin1'))?.[1] ?? '?';
        const caption = /name="caption"\r\n\r\n([^\r]+)/.exec(body.toString('latin1'))?.[1] ?? '';
        received.push({ channel: 'telegram', to: chat, subject: `photo : ${caption}`, images: 1 });
        log(`[telegram]  -> chat ${chat} : (photo) ${caption}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => (smtp.once('error', reject), smtp.listen(smtpPort, '127.0.0.1', resolve))),
    new Promise<void>((resolve, reject) => (telegram.once('error', reject), telegram.listen(telegramPort, '127.0.0.1', resolve))),
  ]);
  return {
    smtpPort: (smtp.address() as AddressInfo).port,
    telegramBase: `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`,
    received,
    close: () => new Promise((resolve) => (smtp.close(), telegram.close(), telegram.closeAllConnections(), resolve())),
  };
}
