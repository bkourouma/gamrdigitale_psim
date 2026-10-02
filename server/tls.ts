import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

export interface TlsFiles {
  cert: string;
  key: string;
}

export function loadTls(files: TlsFiles): { cert: Buffer; key: Buffer } {
  try {
    return { cert: readFileSync(files.cert), key: readFileSync(files.key) };
  } catch (err) {
    throw new Error(`Certificat TLS illisible (${files.cert} / ${files.key}) : ${(err as NodeJS.ErrnoException).code ?? 'erreur'}`);
  }
}

/** Serveur web : HTTPS si un certificat est fourni, HTTP sinon. */
export function createWebServer(listener: RequestListener, tls: TlsFiles | null): Server {
  if (!tls) return createHttpServer(listener);
  return createHttpsServer({ ...loadTls(tls), minVersion: 'TLSv1.2' }, listener);
}

const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

/**
 * Serveur HTTP qui redirige tout vers HTTPS (utile si les utilisateurs saisissent « http:// »).
 * L'hote vient de l'en-tete Host mais n'est repris que s'il ressemble a un nom de machine : jamais de
 * redirection ouverte vers une adresse arbitraire.
 */
export function createHttpRedirect(httpsPort: number, fallbackHost: string): Server {
  return createHttpServer((req, res) => {
    const raw = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const host = HOST_PATTERN.test(raw) ? raw : fallbackHost;
    const port = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(308, { Location: `https://${host}${port}${req.url?.startsWith('/') ? req.url : '/'}` }).end();
  });
}
