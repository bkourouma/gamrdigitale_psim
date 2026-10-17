/**
 * Donnees de demonstration du controle d'acces (ecran « Acces » du PSIM), injectees PAR L'API uniquement :
 * connexion par cookie de session comme n'importe quel navigateur, creation par /api/devices et /api/access/*, passages et etats
 * de portes par POST /api/ingest/<id> (jeton partage). Rien n'est jamais ecrit directement en base.
 *
 * Usage (le PSIM doit tourner, en demonstration ou en essai : jamais sur un site reel) :
 *
 *   node scripts/demo-acces.ts http://127.0.0.1:5400
 *
 * PSIM d'essai a jeter (donnees dans un dossier temporaire, site de demonstration avec cameras simulees, comptes de
 * developpement admin / admin-dev-only et operateur / operator-dev-only) puis ce script :
 *
 *   PSIM_PORT=5400 PSIM_MQTT_PORT=5401 PSIM_DATA_DIR=<dossier-temporaire> PSIM_BACKUP_DIR=<dossier-temporaire> \
 *   PSIM_DEMO_LOGIN=1 PSIM_REQUIRE_2FA=none PSIM_INGEST_TOKEN=<24 caracteres au moins> node server/index.ts
 *   PSIM_INGEST_TOKEN=<le meme jeton> node scripts/demo-acces.ts http://127.0.0.1:5400
 *
 * (Cote navigateur, deux comptes sur le meme poste : les cookies ne tiennent pas compte du port, utiliser deux noms
 * d'hote differents, par exemple http://a.localhost:5400 et http://b.localhost:5400.)
 *
 * Reglages (arguments ou variables d'environnement ; les arguments l'emportent) :
 *   1er argument         adresse du PSIM                       (PSIM_URL, defaut http://127.0.0.1:3034)
 *   --user=<nom>         compte administrateur                 (PSIM_ADMIN_USER, defaut « admin »)
 *   --password=<mdp>     son mot de passe                      (PSIM_ADMIN_PASSWORD, defaut « admin-dev-only » : mot de passe de developpement)
 *   --token=<jeton>      jeton d'ingestion du PSIM             (PSIM_INGEST_TOKEN, 24 caracteres au moins ; le MEME que celui du serveur)
 *   --keep-offline=0     ne pas laisser la porte « serveurs » muette (par defaut elle ne recoit aucun message)
 *
 * Ce que le script fabrique :
 *   - 2 controleurs (Dahua, ZKTeco) ;
 *   - 5 detecteurs de categorie « acces » places sur le plan (et lies aux cameras C-01 a C-05 de la demo si elles existent) ;
 *   - 5 portes (dont une issue de secours et une barriere) ;
 *   - une quarantaine de passages sur 3 jours : badges acceptes, refus (badge inconnu, expire, hors horaires, code errone),
 *     passages differes, noms ivoiriens avec accents, un nom tres long, un nom hostile (verifie l'echappement) ;
 *   - les etats des portes : une forcee, une maintenue ouverte, une ouverte, une fermee, une qui se tait apres le script (hors ligne apres le delai de
 *     supervision, 30 s) ;
 *   - les 8 passages les plus recents arrivent « en direct » ; les autres, injectes apres coup, sont par nature « recus en
 *     differe » (le serveur compare l'heure du controleur a l'heure de reception).
 *
 * Relancable sans erreur : un controleur, un detecteur ou une porte deja la est laisse tel quel (409 ignores), un passage deja
 * connu (meme controleur, meme numero d'evenement) est ignore par le serveur. Les etats des portes sont renvoyes a chaque lancement.
 */
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------------------------------------------- reglages

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = (argv.find((a) => !a.startsWith('--')) ?? process.env.PSIM_URL ?? 'http://127.0.0.1:3034').replace(/\/+$/, '');
const user = flag('user') ?? process.env.PSIM_ADMIN_USER ?? 'admin';
const password = flag('password') ?? process.env.PSIM_ADMIN_PASSWORD ?? 'admin-dev-only';
const token = flag('token') ?? process.env.PSIM_INGEST_TOKEN ?? '';
const keepOffline = flag('keep-offline') !== '0';

if (token.length < 24) {
  console.error("ERREUR : jeton d'ingestion absent ou trop court (--token=... ou PSIM_INGEST_TOKEN, 24 caracteres au moins, le meme que le serveur).");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------- appels

let cookie = '';

interface Reply {
  status: number;
  body: any;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (path === '/api/login' && res.ok) cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0];
  return { status: res.status, body: parsed };
}

/** Appel dont 409 (deja la) est un succes ; toute autre erreur arrete le script avec la reponse du serveur. */
async function ensure(label: string, method: string, path: string, body: unknown): Promise<void> {
  const r = await call(method, path, body);
  if (r.status === 409) return void console.log(`  deja present  ${label}`);
  if (r.status >= 300) fail(`${label} : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`  cree          ${label}`);
}

function fail(message: string): never {
  console.error(`ERREUR : ${message}`);
  process.exit(1);
}

/** Message d'un equipement, tel que l'enverrait la passerelle (jeton partage). */
async function ingest(id: string, body: unknown): Promise<number> {
  const r = await call('POST', `/api/ingest/${id}`, body, { Authorization: `Bearer ${token}` });
  if (r.status >= 300) fail(`ingestion ${id} : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.status;
}

// ---------------------------------------------------------------------------------------------------------------- donnees

const CONTROLLERS = [
  { id: 'CTL-DAHUA', name: 'Controleur Dahua - batiment principal', brand: 'dahua', model: 'ASC1204B', host: '192.0.2.50' },
  { id: 'CTL-ZKTECO', name: 'Controleur ZKTeco - parking et technique', brand: 'zkteco', model: 'InBio 260', host: '192.0.2.51' },
];

/** `x` et `y` : pourcentages du plan de demonstration (zones Accueil, Entrepot, Salle serveurs, Atelier, Stockage). */
const DOORS = [
  { id: 'P-ENTREE', name: 'Entree principale', zone: 'Accueil', x: 3.5, y: 40, ctl: 'CTL-DAHUA', no: 1, kind: 'door', cams: ['C-01', 'C-02'] },
  { id: 'P-LIVRAISON', name: 'Quai de livraison', zone: 'Entrepot', x: 3.5, y: 70, ctl: 'CTL-DAHUA', no: 2, kind: 'door', cams: ['C-04'] },
  { id: 'P-ISSUE', name: 'Issue de secours atelier', zone: 'Atelier', x: 60, y: 92, ctl: 'CTL-DAHUA', no: 3, kind: 'door', emergency: true, cams: ['C-05'] },
  { id: 'P-BARRIERE', name: 'Barriere parking', zone: 'Stockage', x: 93, y: 62, ctl: 'CTL-ZKTECO', no: 1, kind: 'barrier', held: 900, cams: ['C-05', 'C-04'] },
  { id: 'P-SERVEURS', name: 'Salle serveurs', zone: 'Salle serveurs', x: 73, y: 46, ctl: 'CTL-ZKTECO', no: 2, kind: 'door', heartbeat: 30, cams: ['C-03'] },
] as const;

interface Person {
  name: string;
  ref: string;
  badge: string;
}

const PEOPLE: Person[] = [
  { name: 'KONAN Yao', ref: '101', badge: '0012345' },
  { name: 'ZÉBIÉ Noël', ref: '102', badge: '0012346' },
  { name: 'TRAORÉ Awa', ref: '103', badge: '0012347' },
  { name: "N'GUESSAN Koffi Jean-Baptiste", ref: '104', badge: '0012348' },
  { name: 'OUATTARA Fatoumata', ref: '105', badge: '0012349' },
  { name: 'KOUAKOU Aya Marie-Chantal', ref: '106', badge: '0012350' },
  { name: 'DIABATÉ Souleymane', ref: '107', badge: '0012351' },
  { name: 'BAMBA Mariam', ref: '108', badge: '0012352' },
  { name: 'YAPI Désiré', ref: '109', badge: '0012353' },
  { name: 'COULIBALY Adama', ref: '110', badge: '0012354' },
  // Nom de 64 caracteres (limite du contrat) : doit se replier ou se tronquer proprement.
  { name: 'KOUAKOU-N’GUESSAN-BAMBA-DIABATE-COULIBALY-OUATTARA-ZEBIE-TRAORE', ref: '111', badge: '0012355' },
  // Nom hostile : doit s'afficher comme du TEXTE, jamais etre interprete.
  { name: '<img src=x onerror=alert(1)>', ref: '<b>112</b>', badge: '0012356' },
  { name: 'Marie "la Cheffe" & Fils <script>', ref: '113', badge: '0012357' },
  { name: '=cmd|calc', ref: '@ref', badge: '+330102' },
];
const person = (i: number): Person => PEOPLE[i % PEOPLE.length];

type Denial = 'unknown_credential' | 'expired' | 'out_of_schedule' | 'wrong_pin' | 'disabled';

interface Passage {
  /** Il y a combien de minutes (heure du controleur). */
  agoMin: number;
  door: (typeof DOORS)[number]['id'];
  who: number;
  method?: 'badge' | 'code' | 'fingerprint' | 'face' | 'exit_button';
  direction?: 'in' | 'out';
  denied?: Denial;
  deferred?: boolean;
}

const H = 60;
const D = 24 * H;
/** Un historique plausible : pics du matin et du soir, refus isoles, un passage recupere apres une coupure. */
const HISTORY: Passage[] = [
  // Il y a 3 jours
  { agoMin: 3 * D - 8 * H, door: 'P-ENTREE', who: 0 },
  { agoMin: 3 * D - 8 * H - 4, door: 'P-ENTREE', who: 1 },
  { agoMin: 3 * D - 8 * H - 9, door: 'P-ENTREE', who: 2, method: 'face' },
  { agoMin: 3 * D - 9 * H, door: 'P-LIVRAISON', who: 6 },
  { agoMin: 3 * D - 11 * H, door: 'P-SERVEURS', who: 3 },
  { agoMin: 3 * D - 12 * H, door: 'P-ENTREE', who: 4, direction: 'out' },
  { agoMin: 3 * D - 14 * H, door: 'P-BARRIERE', who: 5 },
  { agoMin: 3 * D - 17 * H, door: 'P-ENTREE', who: 0, direction: 'out' },
  { agoMin: 3 * D - 19 * H - 20, door: 'P-ENTREE', who: 7, denied: 'out_of_schedule' },
  // Il y a 2 jours
  { agoMin: 2 * D - 7 * H - 50, door: 'P-ENTREE', who: 1 },
  { agoMin: 2 * D - 8 * H, door: 'P-ENTREE', who: 8 },
  { agoMin: 2 * D - 8 * H - 6, door: 'P-ENTREE', who: 9, method: 'face' },
  { agoMin: 2 * D - 8 * H - 15, door: 'P-BARRIERE', who: 10 },
  { agoMin: 2 * D - 10 * H, door: 'P-LIVRAISON', who: 6, direction: 'out' },
  { agoMin: 2 * D - 10 * H - 30, door: 'P-ENTREE', who: 11 },
  { agoMin: 2 * D - 12 * H - 10, door: 'P-SERVEURS', who: 3, denied: 'wrong_pin', method: 'code' },
  { agoMin: 2 * D - 13 * H, door: 'P-ENTREE', who: 12, denied: 'unknown_credential' },
  { agoMin: 2 * D - 15 * H, door: 'P-BARRIERE', who: 4, direction: 'out' },
  { agoMin: 2 * D - 17 * H - 5, door: 'P-ENTREE', who: 8, direction: 'out' },
  { agoMin: 2 * D - 18 * H, door: 'P-ISSUE', who: 13, method: 'exit_button' },
  { agoMin: 2 * D - 22 * H, door: 'P-ENTREE', who: 13, denied: 'out_of_schedule' },
  // Hier, dont un passage recupere dans la memoire du controleur apres une coupure de liaison
  { agoMin: D - 7 * H - 40, door: 'P-ENTREE', who: 0 },
  { agoMin: D - 8 * H, door: 'P-ENTREE', who: 2 },
  { agoMin: D - 8 * H - 12, door: 'P-ENTREE', who: 5, denied: 'expired' },
  { agoMin: D - 9 * H, door: 'P-LIVRAISON', who: 9 },
  { agoMin: D - 11 * H - 30, door: 'P-ENTREE', who: 7, denied: 'disabled' },
  { agoMin: D - 13 * H, door: 'P-BARRIERE', who: 10, deferred: true },
  { agoMin: D - 13 * H - 10, door: 'P-BARRIERE', who: 1, deferred: true },
  { agoMin: D - 16 * H, door: 'P-ENTREE', who: 6, direction: 'out' },
  { agoMin: D - 17 * H - 25, door: 'P-ENTREE', who: 4, direction: 'out', method: 'fingerprint' },
  { agoMin: D - 20 * H, door: 'P-ENTREE', who: 12, denied: 'unknown_credential' },
  // Aujourd'hui (les 8 derniers : « en direct », a moins d'une minute)
  { agoMin: 3 * H + 10, door: 'P-ENTREE', who: 0 },
  { agoMin: 2 * H + 5, door: 'P-LIVRAISON', who: 6 },
  { agoMin: H, door: 'P-ENTREE', who: 1, method: 'face' },
  { agoMin: 0.9, door: 'P-ENTREE', who: 2 },
  { agoMin: 0.75, door: 'P-ENTREE', who: 3, method: 'face' },
  { agoMin: 0.6, door: 'P-BARRIERE', who: 11 },
  { agoMin: 0.5, door: 'P-ENTREE', who: 12, denied: 'unknown_credential' },
  { agoMin: 0.4, door: 'P-ISSUE', who: 8, method: 'exit_button' },
  { agoMin: 0.3, door: 'P-ENTREE', who: 5, denied: 'expired' },
  { agoMin: 0.2, door: 'P-ENTREE', who: 4 },
  { agoMin: 0.1, door: 'P-LIVRAISON', who: 9, direction: 'out' },
];

// ---------------------------------------------------------------------------------------------------------------- deroulement

console.log(`Donnees de demonstration du controle d'acces -> ${base}`);

const login = await call('POST', '/api/login', { username: user, password });
if (login.status !== 200 || !cookie) fail(`connexion refusee (HTTP ${login.status}) : verifier l'adresse, le compte et le mot de passe.`);
console.log(`  connecte      ${user}`);

console.log('\nControleurs');
for (const c of CONTROLLERS) await ensure(`${c.id} (${c.brand})`, 'POST', '/api/access/controllers', { ...c, gatewayId: 'gw-site' });

const known = await call('GET', '/api/state');
const cameras = new Set<string>(((known.body?.devices ?? []) as { id: string; kind: string }[]).filter((d) => d.kind === 'camera').map((d) => d.id));

console.log('\nDetecteurs de categorie acces et portes');
for (const d of DOORS) {
  await ensure(`detecteur ${d.id} - ${d.name}`, 'POST', '/api/devices', {
    id: d.id, kind: 'detector', name: d.name, zone: d.zone, category: 'access', x: d.x, y: d.y,
    // Une seule porte est supervisee de pres : elle devient « hors ligne » si elle se tait.
    ...('heartbeat' in d && keepOffline ? { heartbeatS: d.heartbeat } : {}),
  });
  const links = d.cams.filter((c) => cameras.has(c));
  if (links.length) {
    const r = await call('PUT', `/api/devices/${d.id}/links`, { cameraIds: links });
    if (r.status >= 300) fail(`cameras de ${d.id} : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  await ensure(`porte ${d.id} (${d.kind}${'emergency' in d ? ', issue de secours' : ''})`, 'POST', '/api/access/doors', {
    detectorId: d.id, controllerId: d.ctl, doorNo: d.no, kind: d.kind, emergencyExit: 'emergency' in d,
    ...('held' in d ? { heldAlarmAfterS: d.held } : {}),
  });
}
if (!cameras.size) console.log('  (aucune camera dans ce PSIM : portes sans camera liee)');

console.log('\nPassages');
const now = Date.now();
let sent = 0;
let duplicates = 0;
// Du plus ancien au plus recent : le serveur ne laisse pas un message ancien ecraser un etat plus recent.
const ordered = [...HISTORY].sort((a, b) => b.agoMin - a.agoMin);
for (const [i, p] of ordered.entries()) {
  const who = person(p.who);
  const door = DOORS.find((d) => d.id === p.door)!;
  const eventId = String(5000 + i);
  const denied = p.denied !== undefined;
  const body = {
    event: denied ? 'badge_denied' : 'badge_granted',
    ts: now - Math.round(p.agoMin * 60_000),
    msgId: `acc:${door.ctl}:${eventId}`,
    access: {
      v: 1,
      controllerId: door.ctl,
      eventId,
      direction: p.direction ?? (p.method === 'exit_button' ? 'out' : 'in'),
      credential: p.method === 'exit_button' ? null : p.denied === 'unknown_credential' ? '0099' + String(i).padStart(3, '0') : who.badge,
      holderName: p.denied === 'unknown_credential' || p.method === 'exit_button' ? null : who.name,
      holderRef: p.denied === 'unknown_credential' || p.method === 'exit_button' ? null : who.ref,
      method: p.method ?? 'badge',
      result: denied ? 'denied' : 'granted',
      reason: p.denied ?? null,
      deferred: p.deferred === true,
    },
  };
  const status = await ingest(p.door, body);
  if (status === 200) duplicates += 1;
  else sent += 1;
}
console.log(`  ${sent} passage(s) enregistre(s), ${duplicates} deja connu(s)`);

console.log('\nEtats des portes');
const step = async (id: string, event: string, label: string): Promise<void> => {
  await ingest(id, { event });
  console.log(`  ${id.padEnd(12)} ${label}`);
  await sleep(30); // l'ordre des messages compte : un message ne rajeunit jamais un etat plus recent
};
await step('P-ENTREE', 'door_closed', 'fermee');
await step('P-ISSUE', 'door_opened', 'ouverte');
await step('P-BARRIERE', 'door_opened', 'ouverte...');
await step('P-BARRIERE', 'door_held_open', '... maintenue ouverte (pre-alarme ; alarme apres 15 min)');
await step('P-LIVRAISON', 'door_opened', 'ouverte...');
await step('P-LIVRAISON', 'door_forced', '... forcee (alarme)');
console.log(
  keepOffline
    ? '  P-SERVEURS   plus aucun message : hors ligne apres 30 s de silence (supervision de la porte)'
    : '  P-SERVEURS   (option --keep-offline=0 : pas de supervision)',
);

console.log('\nTermine. Ouvrir le menu « Acces » dans le PSIM (onglets Journal, Portes ; Declaration pour un administrateur).');
