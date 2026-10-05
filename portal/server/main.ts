/**
 * Portail de suivi a distance : point d'entree. Recoit les resumes des PSIM de site et les montre aux clients.
 * Lancer : npm run portal (puis npm run portal:admin pour creer organisations, sites et comptes).
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { purgeSessions } from './accounts.ts';
import { createPortalApp } from './api.ts';
import { config } from './config.ts';
import { openPortalDb } from './db.ts';
import { loadMasterKey } from './keys.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '..', config.dataDir);
mkdirSync(dataDir, { recursive: true });

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    console.error(`[portail] ERREUR FATALE (${event}) :`, err);
    setTimeout(() => process.exit(1), 200);
  });
}

if (config.production && !config.cookieSecure) {
  console.warn('[portail] ATTENTION : en production, le portail doit etre servi en HTTPS (derriere un proxy : PORTAL_TRUST_PROXY=1). Sans cela, mots de passe et sessions circulent en clair.');
}
if (config.production && !/^[0-9a-fA-F]{64}$/.test(config.masterKey)) {
  console.warn('[portail] ATTENTION : cle maitresse dans un fichier du dossier de donnees. En production, preferer PORTAL_MASTER_KEY (hors sauvegardes de la base).');
}

const db = openPortalDb(join(dataDir, 'portal.db'));
const master = loadMasterKey(dataDir, config.masterKey);
const app = createPortalApp({ db, master, staleAfterMs: config.staleAfterS * 1000, cookieSecure: config.cookieSecure, trustProxy: config.trustProxy, webDir: join(root, 'web') });

const purgeTimer = setInterval(() => purgeSessions(db), 3_600_000);
const server = app.listen(config.port, config.host, () => {
  console.log(`[portail] http://${config.host}:${config.port}  (donnees : ${dataDir})`);
  console.log(`[portail] un site est « injoignable » apres ${config.staleAfterS} s sans envoi`);
});
server.once('error', (err: NodeJS.ErrnoException) => {
  console.error(`[portail] impossible de demarrer (${config.host}:${config.port}) : ${err.code === 'EADDRINUSE' ? 'port deja utilise' : err.message}`);
  process.exit(1);
});

function shutdown(): void {
  clearInterval(purgeTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
