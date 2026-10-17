/**
 * Controles « l'installation est prete pour l'essai des agents sur un vrai telephone » : HTTPS, certificat a installer
 * sur le telephone, adresse publique, ecoute reseau, puis contenu de la base (plan, agents, telephones, circuits,
 * points de controle). Fonctions pures : les valeurs ou la base sont passees en parametres. Aucune ne leve d'exception
 * vers l'appelant (voir `safely`), aucune n'ecrit dans la base, aucune n'envoie d'alerte, aucun secret n'est affiche.
 */
import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { isSelfSigned, parseCertificates, pickPhoneCa } from '../../server/cert-info.ts';
import type { Check, Status } from '../commission/checks.ts';

const DAY = 86_400_000;
const check = (id: string, title: string, status: Status, detail: string, fix?: string): Check => ({ id, title, status, detail, fix });
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
const frDate = (ms: number): string => new Date(ms).toLocaleDateString('fr-FR');
const daysLeft = (validTo: string, now: number): number => Math.floor((new Date(validTo).getTime() - now) / DAY);
const MAKE_CERT = 'npm run make-cert -- <adresse-IP> <nom> (voir docs/ESSAI-AGENTS-KOUROUMA.md)';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- HTTPS

export interface TlsOptions {
  cert: string;
  key: string;
  trustProxy: boolean;
}

const T_TLS = 'HTTPS actif';
const T_CA = 'Certificat a installer sur le telephone';
const T_NAMES = "Le certificat couvre l'adresse publique";

export function checkHttps(o: TlsOptions, now = Date.now()): Check {
  if (!o.cert || !o.key) {
    if (o.trustProxy) {
      return check('tls', T_TLS, 'warn', 'le PSIM est derriere un proxy HTTPS : le certificat vu par le telephone est celui du proxy, a controler a part');
    }
    return check('tls', T_TLS, 'fail', "HTTPS non configure : sans HTTPS le telephone n'aura ni installation de l'application, ni NFC, ni mode hors ligne", `Generer un certificat (${MAKE_CERT}), renseigner PSIM_TLS_CERT et PSIM_TLS_KEY dans .env, puis redemarrer le PSIM.`);
  }
  if (!existsSync(o.cert) || !existsSync(o.key)) return check('tls', T_TLS, 'fail', 'fichier de certificat ou de cle introuvable', 'Verifier les chemins PSIM_TLS_CERT et PSIM_TLS_KEY dans .env.');
  const server = parseCertificates(readFileSync(o.cert))[0];
  if (!server) return check('tls', T_TLS, 'fail', 'le fichier PSIM_TLS_CERT ne contient aucun certificat lisible', `Regenerer le certificat : ${MAKE_CERT}.`);
  let matches = false;
  try {
    matches = server.cert.checkPrivateKey(createPrivateKey(readFileSync(o.key)));
  } catch {
    matches = false;
  }
  if (!matches) return check('tls', T_TLS, 'fail', 'la cle privee ne correspond pas au certificat', `Utiliser la cle produite avec ce certificat, ou regenerer les deux (${MAKE_CERT}).`);
  const end = new Date(server.cert.validTo).getTime();
  const days = daysLeft(server.cert.validTo, now);
  if (days < 0) return check('tls', T_TLS, 'fail', `le certificat du serveur a expire le ${frDate(end)}`, `Regenerer le certificat (${MAKE_CERT}) et redemarrer le PSIM.`);
  if (days < 30) return check('tls', T_TLS, 'warn', `HTTPS actif, mais le certificat du serveur expire dans ${days} jour(s)`, `Prevoir le renouvellement (${MAKE_CERT}).`);
  return check('tls', T_TLS, 'ok', `HTTPS actif, certificat du serveur valable jusqu'au ${frDate(end)}`);
}

/** Certificat a installer sur le telephone (`cert-ca`) et couverture de l'adresse publique (`cert-names`). */
export function checkCertificates(o: TlsOptions & { publicUrl: string }, now = Date.now()): Check[] {
  if (!o.cert || !o.key) {
    const why = o.trustProxy ? 'certificat gere par le proxy HTTPS' : 'aucun certificat configure (voir le controle HTTPS)';
    return [check('cert-ca', T_CA, 'skip', why), check('cert-names', T_NAMES, 'skip', why)];
  }
  let pem: Buffer;
  try {
    pem = readFileSync(o.cert);
  } catch (err) {
    const detail = `fichier de certificat illisible : ${msg(err)}`;
    return [check('cert-ca', T_CA, 'fail', detail, 'Verifier PSIM_TLS_CERT.'), check('cert-names', T_NAMES, 'skip', detail)];
  }
  return [caCheck(pem, now), namesCheck(pem, o.publicUrl)];
}

function caCheck(pem: Buffer, now: number): Check {
  const ca = pickPhoneCa(pem);
  if (!ca) {
    return check('cert-ca', T_CA, 'fail', "le fichier ne contient aucune autorite de certification (CA:TRUE) : Android refusera de l'installer", `Generer un certificat avec son autorite : ${MAKE_CERT}.`);
  }
  const server = parseCertificates(pem)[0];
  const caEnd = new Date(ca.cert.validTo).getTime();
  const days = daysLeft(ca.cert.validTo, now);
  if (days < 0) return check('cert-ca', T_CA, 'fail', `l'autorite a expire le ${frDate(caEnd)}`, `Regenerer le certificat (${MAKE_CERT}) et le reinstaller sur chaque telephone.`);
  if (server && server.pem !== ca.pem) {
    let signed = false;
    try {
      signed = server.cert.checkIssued(ca.cert) && server.cert.verify(ca.cert.publicKey);
    } catch {
      signed = false;
    }
    if (!signed) return check('cert-ca', T_CA, 'fail', "le certificat du serveur n'est pas signe par l'autorite du fichier : le telephone refusera la connexion", 'Regenerer les deux ensemble : npm run make-cert -- --force <adresse-IP> <nom>.');
  } else if (server && isSelfSigned(server.cert)) {
    return check('cert-ca', T_CA, 'warn', `installable, mais a reinstaller sur chaque telephone au renouvellement (dans ${days} jours, le ${frDate(caEnd)})`, 'Preferer un certificat recent avec autorite : npm run make-cert -- --force <adresse-IP> <nom>.');
  }
  if (days < 90) return check('cert-ca', T_CA, 'warn', `autorite valable jusqu'au ${frDate(caEnd)} (dans ${days} jours) : a renouveler bientot`, `Prevoir ${MAKE_CERT} et la reinstallation sur chaque telephone.`);
  return check('cert-ca', T_CA, 'ok', `autorite installable sur le telephone, valable jusqu'au ${frDate(caEnd)}`);
}

/** Nom d'hote ou adresse IP d'une URL (sans les crochets des adresses IPv6), ou null si l'URL est illisible. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function namesCheck(pem: Buffer, publicUrl: string): Check {
  const host = publicUrl ? hostOf(publicUrl) : null;
  if (!host) return check('cert-names', T_NAMES, 'skip', "pas d'adresse publique exploitable (voir le controle de l'adresse publique)");
  const server = parseCertificates(pem)[0];
  if (!server) return check('cert-names', T_NAMES, 'fail', 'aucun certificat de serveur lisible dans le fichier', `Regenerer le certificat : ${MAKE_CERT}.`);
  let covered = false;
  try {
    covered = isIP(host) ? server.cert.checkIP(host) !== undefined : server.cert.checkHost(host) !== undefined;
  } catch {
    covered = false;
  }
  if (!covered) {
    return check('cert-names', T_NAMES, 'fail', `l'adresse ${host} n'est pas dans le certificat : le telephone refusera la connexion`, `Regenerer le certificat : npm run make-cert -- --force ${host} <nom>`);
  }
  return check('cert-names', T_NAMES, 'ok', `${host} figure dans le certificat`);
}

// ---------------------------------------------------------------- adresse et ecoute

export function checkPublicUrl(raw: string): Check {
  const title = 'Adresse publique (PSIM_PUBLIC_URL)';
  const url = raw.trim();
  if (!url) {
    return check('public-url', title, 'fail', "non renseignee : les QR des etiquettes et de l'appairage pointeraient vers l'adresse tapee dans le navigateur (souvent localhost)", 'Renseigner PSIM_PUBLIC_URL dans .env, par exemple https://192.168.1.10:3000 (adresse fixe du serveur), puis redemarrer.');
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return check('public-url', title, 'fail', `adresse illisible : « ${url.slice(0, 80)} »`, 'Ecrire une adresse complete, par exemple https://192.168.1.10:3000.');
  }
  if (u.protocol !== 'https:') return check('public-url', title, 'fail', "l'adresse n'est pas en https : le telephone ne pourra ni installer l'application, ni lire le NFC", 'Utiliser une adresse https:// dans PSIM_PUBLIC_URL.');
  const host = hostOf(url) ?? '';
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '::1') {
    return check('public-url', title, 'fail', `l'adresse ${host} designe le telephone lui-meme, pas le serveur`, "Mettre l'adresse IP fixe du serveur sur le reseau (par exemple https://192.168.1.10:3000).");
  }
  if (!isIP(host) && !host.includes('.')) {
    return check('public-url', title, 'warn', `le nom « ${host} » n'a pas de point : beaucoup de telephones Android ne savent pas le resoudre`, "Utiliser l'adresse IP fixe du serveur dans PSIM_PUBLIC_URL.");
  }
  return check('public-url', title, 'ok', url);
}

export function checkListen(host: string, port: number): Check {
  const title = 'Ecoute sur le reseau';
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    return check('listen', title, 'fail', `le PSIM n'ecoute que sur ce PC (${host}:${port}) : aucun telephone ne pourra s'y connecter`, "Mettre PSIM_HOST=0.0.0.0 (ou l'IP du serveur) dans .env et redemarrer le PSIM.");
  }
  return check('listen', title, 'ok', `${host}:${port}`);
}

// ---------------------------------------------------------------- base de donnees

/** Un controle de base : une table absente (base ancienne) devient un echec lisible, jamais une exception. */
function dbCheck(id: string, title: string, fn: () => Check): Check {
  try {
    return fn();
  } catch (err) {
    if (/no such (table|column)/i.test(msg(err))) return check(id, title, 'fail', `la base n'a pas encore ce module (${msg(err)})`, 'Demarrer le PSIM (version actuelle) une fois : il migre la base sans rien perdre.');
    return check(id, title, 'fail', `controle impossible : ${msg(err)}`);
  }
}

const count = (db: DatabaseSync, sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const T_PLAN = 'Un etage avec son plan';
const T_AGENTS = 'Agents actifs';
const T_PHONES = 'Telephones des agents';
const T_ROUTES = 'Circuits de ronde';
const T_POINTS = 'Points de controle places';

/** Controles 6 a 10 quand la base est absente. */
export function skipDatabaseChecks(): Check[] {
  return [['plan', T_PLAN], ['agents', T_AGENTS], ['phones', T_PHONES], ['routes', T_ROUTES], ['checkpoints', T_POINTS]]
    .map(([id, title]) => check(id, title, 'skip', 'base introuvable : lancer le PSIM une fois'));
}

export function checkDatabase(db: DatabaseSync): Check[] {
  const out: Check[] = [];

  out.push(dbCheck('plan', T_PLAN, () => {
    const n = count(db, "SELECT COUNT(*) AS n FROM floor WHERE plan_file IS NOT NULL AND plan_file <> ''");
    return n > 0
      ? check('plan', T_PLAN, 'ok', `${n} etage(s) avec un plan`)
      : check('plan', T_PLAN, 'fail', "aucun etage n'a de plan : les points de controle ne peuvent pas etre places", "Ajouter l'image du plan d'un etage dans l'administration du PSIM.");
  }));

  out.push(dbCheck('agents', T_AGENTS, () => {
    const n = count(db, "SELECT COUNT(*) AS n FROM agent_profile p JOIN app_user u ON u.username = p.username WHERE u.role = 'agent' AND u.active = 1");
    return n > 0
      ? check('agents', T_AGENTS, 'ok', `${n} agent(s) actif(s)`)
      : check('agents', T_AGENTS, 'fail', "aucun agent actif : personne ne pourra ouvrir l'application", 'Creer un agent dans Rondes > Agents.');
  }));

  out.push(dbCheck('phones', T_PHONES, () => {
    const open = count(db, 'SELECT COUNT(*) AS n FROM agent_phone WHERE revoked_at IS NULL');
    const paired = count(db, 'SELECT COUNT(*) AS n FROM agent_phone WHERE revoked_at IS NULL AND paired_at IS NOT NULL');
    if (open === 0) return check('phones', T_PHONES, 'fail', 'aucun telephone enregistre (ou tous sont revoques)', "Creer un telephone dans Rondes > Agents, puis scanner son QR d'appairage depuis le telephone.");
    if (paired === 0) return check('phones', T_PHONES, 'warn', `${open} telephone(s) cree(s) mais aucun appaire : le QR n'a pas encore ete scanne`, "Scanner le QR d'appairage avec le telephone (il expire au bout de quelques minutes : en recreer un si besoin).");
    return check('phones', T_PHONES, 'ok', `${paired} telephone(s) appaire(s)`);
  }));

  out.push(dbCheck('routes', T_ROUTES, () => {
    const n = count(db, 'SELECT COUNT(*) AS n FROM patrol_route WHERE archived_at IS NULL');
    return n > 0
      ? check('routes', T_ROUTES, 'ok', `${n} circuit(s) actif(s)`)
      : check('routes', T_ROUTES, 'fail', "aucun circuit actif : l'agent n'aura aucune ronde a faire", 'Creer un circuit dans Rondes > Circuits.');
  }));

  out.push(dbCheck('checkpoints', T_POINTS, () => {
    // Un point est « place » quand il est sur un etage qui a un plan, avec des coordonnees.
    const points = db.prepare("SELECT c.id, c.name, c.archived_at, (f.plan_file IS NOT NULL AND f.plan_file <> '' AND c.x IS NOT NULL AND c.y IS NOT NULL) AS placed FROM checkpoint c LEFT JOIN floor f ON f.id = c.floor_id").all() as Row[];
    const placed = new Set(points.filter((p) => p.placed).map((p) => Number(p.id)));
    const active = points.filter((p) => p.archived_at == null);
    const ok = active.filter((p) => p.placed);
    const loose = active.filter((p) => !p.placed).map((p) => p.name as string);
    if (ok.length === 0) return check('checkpoints', T_POINTS, 'fail', 'aucun point de controle actif place sur un plan : rien a scanner pendant la ronde', 'Creer un point dans Rondes > Points de controle et le placer sur le plan.');
    const warns: string[] = [];
    if (loose.length) warns.push(`${loose.length} point(s) actif(s) non place(s) sur un plan : ${loose.slice(0, 5).join(', ')}${loose.length > 5 ? '...' : ''}`);
    const routes = db.prepare('SELECT name, checkpoints FROM patrol_route WHERE archived_at IS NULL').all() as Row[];
    const bad = routes.filter((r) => {
      let ids: unknown = [];
      try {
        ids = JSON.parse(r.checkpoints as string);
      } catch {
        // liste illisible : traitee comme vide
      }
      return Array.isArray(ids) && ids.some((id) => !placed.has(Number(id)));
    });
    if (bad.length) warns.push(`circuit(s) passant par un point non place : ${bad.slice(0, 3).map((r) => r.name as string).join(', ')}`);
    return warns.length
      ? check('checkpoints', T_POINTS, 'warn', `${ok.length} point(s) place(s) ; ${warns.join(' ; ')}`, 'Placer les points sur le plan (Rondes > Points de controle) ou les retirer du circuit.')
      : check('checkpoints', T_POINTS, 'ok', `${ok.length} point(s) place(s) sur un plan`);
  }));
  return out;
}

// ---------------------------------------------------------------- --live

/** Telecharge `<url>/api/agent-cert` sans verifier le certificat (c'est justement lui qu'on compare). */
export function fetchAgentCert(baseUrl: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/agent-cert', baseUrl), { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`reponse HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 100_000) req.destroy(new Error('reponse trop grosse'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error(`pas de reponse en ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    req.end();
  });
}

/** Le PSIM en marche sert-il bien l'autorite du fichier ? `fetchCert` est injectable pour les tests. */
export async function checkLive(o: { publicUrl: string; certFile: string; fetchCert?: (baseUrl: string) => Promise<string> }): Promise<Check> {
  const title = 'Le PSIM sert le bon certificat';
  if (!o.publicUrl) return check('live', title, 'skip', "pas d'adresse publique a interroger");
  let body: string;
  try {
    body = await (o.fetchCert ?? fetchAgentCert)(o.publicUrl);
  } catch (err) {
    return check('live', title, 'skip', `PSIM injoignable a ${o.publicUrl} (${msg(err)}) : le demarrer, ou verifier l'adresse et le pare-feu`);
  }
  const served = pickPhoneCa(body);
  if (!served) return check('live', title, 'fail', "l'adresse repond, mais ce n'est pas une autorite de certification : ce n'est pas le PSIM, ou un PSIM sans certificat d'essai", `Verifier l'adresse et PSIM_TLS_CERT (${MAKE_CERT}), puis redemarrer le PSIM.`);
  let file: ReturnType<typeof pickPhoneCa> = null;
  try {
    file = pickPhoneCa(readFileSync(o.certFile));
  } catch {
    file = null;
  }
  if (!file) return check('live', title, 'skip', "le certificat du fichier n'est pas lisible : rien a comparer");
  if (served.cert.fingerprint256 !== file.cert.fingerprint256) {
    return check('live', title, 'fail', "le PSIM en marche sert une autre autorite que celle du fichier : le PSIM n'a pas ete redemarre apres le changement de certificat", 'Redemarrer le PSIM, puis relancer ce controle.');
  }
  return check('live', title, 'ok', `le PSIM sert bien l'autorite du fichier (empreinte ${served.cert.fingerprint256.slice(0, 11)}...)`);
}
