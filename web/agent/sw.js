// Service worker de l'application des agents (portee /agent/, enregistre par la coquille avec
// register('sw.js', { scope: './' })).
//
// Son seul role : que la COQUILLE (page, scripts, styles, icones, polices) s'ouvre sans reseau. Les donnees
// (alarmes, rondes, scans, SOS...) ne passent JAMAIS par ici : tout ce qui est sous /api/ ou /ws, toute requete
// qui n'est pas un GET et toute autre origine sont laisses au navigateur, sans respondWith ni mise en cache.
//
// Script classique (pas de module, pas d'export) : les fonctions pures du haut sont testees en Node avec node:vm.

const CACHE_PREFIX = 'psim-agent-shell-';
const CACHE_VERSION = 'v1';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

/** Delai laisse au reseau avant de servir la copie locale de la coquille (ms). */
const NETWORK_TIMEOUT_MS = 3000;

/** Coquille a pre-charger, relative a la portee (/agent/). Un fichier absent n'empeche pas l'installation. */
const PRECACHE = [
  './',
  'index.html',
  'app.js',
  'util.js',
  'sound.js',
  'queue.js',
  'scan.js',
  'photo.js',
  'sos.js',
  'alarms.js',
  'live.js',
  'ronde.js',
  'logbook.js',
  'agent.css',
  'alarms.css',
  'ronde.css',
  'sos.css',
  'logbook.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  '../fonts/baloo-2-latin-wght-normal.woff2',
  '../fonts/baloo-2-latin-ext-wght-normal.woff2',
  '../fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2',
  '../fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2',
];

/** Dossier des polices partagees avec le reste du PSIM. */
const FONTS_PATH = '/fonts/';

// ---------------------------------------------------------------------------------------------------------------
// Logique de decision (pure)

/** Chemin d'un chemin /api ou /ws (ou sous-chemin) : jamais intercepte. */
function isForbiddenPath(pathname) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/ws' ||
    pathname.startsWith('/ws/')
  );
}

/**
 * Cette requete doit-elle etre geree par le service worker ?
 * Oui seulement : GET, meme origine (si `origin` est donnee), jamais /api ni /ws, et dans la portee ou les polices.
 * @param {URL|string} url
 * @param {string} method
 * @param {string} scopePath  chemin de la portee, ex. '/agent/'
 * @param {string} [origin]   origine du service worker, ex. 'https://psim.local'
 */
function shouldHandle(url, method, scopePath, origin) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url), origin || 'http://localhost');
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (origin && parsed.origin !== origin) return false;
  const path = parsed.pathname;
  if (isForbiddenPath(path)) return false;
  return classify(parsed, scopePath) !== null;
}

/** 'font' (polices partagees), 'shell' (dans la portee) ou null (hors perimetre). */
function classify(url, scopePath) {
  const path = url.pathname;
  if (path.startsWith(FONTS_PATH) && path.endsWith('.woff2')) return 'font';
  const base = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  if (path === base.slice(0, -1) || path.startsWith(base)) return 'shell';
  return null;
}

/** Cle de cache d'une requete : l'adresse sans la chaine de requete ni l'ancre (?x=1 ne cree pas de doublon). */
function cacheKey(url) {
  return url.origin + url.pathname;
}

/** Adresse de la page d'accueil de l'application (repli de toute navigation hors ligne). */
function indexKey(scopePath, origin) {
  const base = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  return origin + base + 'index.html';
}

/** Une reponse qui vaut la peine d'etre gardee : succes complet, meme origine. */
function isCacheable(response) {
  return Boolean(response) && response.ok === true && response.status === 200 && response.type !== 'opaque' && response.redirected !== true;
}

/** Adresses absolues de la coquille a pre-charger. */
function precacheUrls(scope) {
  return PRECACHE.map((path) => new URL(path, scope).href);
}

// ---------------------------------------------------------------------------------------------------------------
// Service worker

function scopeUrl() {
  try {
    return new URL(self.registration.scope);
  } catch {
    return new URL('/agent/', self.location.origin);
  }
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const scope = scopeUrl();
  // tolerant : un fichier manquant (404, reseau) ne doit pas faire echouer l'installation
  await Promise.allSettled(
    precacheUrls(scope.href).map((url) => cache.add(new Request(url, { cache: 'reload' }))),
  );
}

async function cleanOldCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)));
}

/** Garde la reponse en cache si elle le merite ; ne leve jamais (quota plein...). */
async function keep(cache, key, response) {
  if (!isCacheable(response)) return;
  try {
    await cache.put(key, response.clone());
  } catch {
    // pas de place : tant pis, la reponse est quand meme servie
  }
}

/** Polices : cache d'abord (elles ne changent pas), reseau en repli puis gardees. */
async function fontStrategy(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey(url));
  if (cached) return cached;
  const response = await fetch(request);
  await keep(cache, cacheKey(url), response);
  return response;
}

/**
 * Coquille : reseau d'abord (pour recevoir les mises a jour), mais apres NETWORK_TIMEOUT_MS on sert la copie locale
 * (demarrage hors ligne ou sur un reseau mourant). La requete reseau continue en arriere-plan et rafraichit la copie.
 */
async function shellStrategy(event, url, scopePath) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(url);
  const isNavigation = request.mode === 'navigate';

  const fromCache = async () => {
    const hit = await cache.match(key);
    if (hit) return hit;
    return isNavigation ? cache.match(indexKey(scopePath, url.origin)) : undefined;
  };

  const network = fetch(request).then(async (response) => {
    await keep(cache, key, response);
    return response;
  });
  // si on repond depuis la copie, l'echec ulterieur du reseau n'est plus une erreur a signaler
  network.catch(() => {});
  try {
    event.waitUntil?.(network.catch(() => {}));
  } catch {
    // la fin de vie de l'evenement n'est pas prolongeable : la copie ne sera rafraichie qu'a la prochaine ouverture
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([network.catch(() => undefined), timeout]);
    if (first && first.status < 500) return first; // reponse reseau normale (y compris 404 : on ne la masque pas)
    // lent, injoignable, ou serveur en erreur : la copie locale si on en a une
    const cached = await fromCache();
    if (cached) return cached;
    if (first) return first;
    // pas de copie : on attend le vrai resultat du reseau (qui peut echouer : erreur reseau normale du navigateur)
    return await network;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const scope = scopeUrl();
  const url = new URL(request.url);
  // Garde explicite, en tete : /api, /ws, non-GET, autre origine, hors portee -> on ne touche a rien.
  if (!shouldHandle(url, request.method, scope.pathname, self.location.origin)) return;
  // les lectures partielles (Range) sont laissees au navigateur
  if (request.headers && typeof request.headers.get === 'function' && request.headers.get('range')) return;
  const kind = classify(url, scope.pathname);
  if (kind === 'font') {
    event.respondWith(fontStrategy(request, url));
  } else if (kind === 'shell') {
    event.respondWith(shellStrategy(event, url, scope.pathname));
  }
});
