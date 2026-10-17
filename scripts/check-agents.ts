/**
 * Controle prealable a l'essai des agents sur un vrai telephone :
 *
 *   npm run check-agents            HTTPS, certificat a installer, adresse publique, ecoute, plan, agents, telephones,
 *                                   circuits, points de controle
 *   npm run check-agents -- --live  + interroge le PSIM en marche (GET <adresse publique>/api/agent-cert)
 *
 * Lecture seule : base ouverte en lecture seule, aucune alerte envoyee. Code de sortie 1 s'il y a au moins un echec.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exitCodeFor, formatChecks, safely } from './commission/checks.ts';
import type { Check } from './commission/checks.ts';
import { checkCertificates, checkDatabase, checkHttps, checkListen, checkLive, checkPublicUrl, skipDatabaseChecks } from './check-agents/checks.ts';

const root = resolve(import.meta.dirname, '..');

async function run(args: string[]): Promise<number> {
  const { config } = await import('../server/config.ts');
  const dataDir = resolve(root, config.dataDir);
  const publicUrl = (process.env.PSIM_PUBLIC_URL ?? '').trim();
  const tls = { cert: config.tls.cert, key: config.tls.key, trustProxy: config.trustProxy };
  const checks: Check[] = [];
  console.log(`Essai des agents - controle de l'installation - donnees : ${dataDir}\n`);

  checks.push(await safely('tls', 'HTTPS actif', () => checkHttps(tls)));
  try {
    checks.push(...checkCertificates({ ...tls, publicUrl }));
  } catch (err) {
    checks.push({ id: 'cert-ca', title: 'Certificat a installer sur le telephone', status: 'fail', detail: `controle impossible : ${err instanceof Error ? err.message : String(err)}` });
  }
  checks.push(await safely('public-url', 'Adresse publique (PSIM_PUBLIC_URL)', () => checkPublicUrl(publicUrl)));
  checks.push(await safely('listen', 'Ecoute sur le reseau', () => checkListen(config.host, config.port)));

  const file = join(dataDir, 'psim.db');
  if (!existsSync(file)) {
    checks.push(...skipDatabaseChecks());
  } else {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      checks.push(...checkDatabase(db));
    } finally {
      db.close();
    }
  }

  if (args.includes('--live')) {
    checks.push(await safely('live', 'Le PSIM sert le bon certificat', () => checkLive({ publicUrl, certFile: config.tls.cert })));
  }

  console.log(formatChecks(checks));
  return exitCodeFor(checks);
}

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (err) => {
  console.error(`Controle impossible : ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
