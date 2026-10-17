// Application des agents : petits outils communs (aucune dependance, aucun acces au DOM a l'import :
// ce fichier est aussi importe par les tests de node:test).

/**
 * Cree un element DOM. `props` : class, text, style (objet, pose via element.style : permis par la CSP),
 * dataset (objet), onXxx (ecouteur), n'importe quel autre nom = attribut (false/null/undefined = absent, true = vide).
 * Les enfants : chaines, noeuds, tableaux (aplatis), null/false ignores. Jamais de HTML construit a partir de donnees.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

/** Ajoute des enfants (chaines, noeuds, tableaux) a un element. */
export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Vide un element puis y met les enfants donnes. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** UUID v4 (crypto.randomUUID n'existe qu'en contexte securise ; repli sur getRandomValues). */
export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** « 14:05 » (heure locale du telephone). */
export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** « il y a 4 min », « à l'instant », « il y a 2 h 10 ». `now` est injectable (tests). */
export function fmtAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'à l’instant';
  const min = Math.round(s / 60);
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `il y a ${hours} h` : `il y a ${hours} h ${pad2(rest)}`;
}

/** « 12 min », « 1 h 05 » : une duree (ms) lisible. */
export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad2(min % 60)}`;
}

let authLostHandler = null;
/** Appelee (par l'application) a chaque reponse 401 : session terminee ou telephone non reconnu. */
export function setAuthLostHandler(fn) {
  authLostHandler = fn;
}

let networkHandler = null;
/** Appelee a chaque appel d'API : true si le serveur a repondu (meme par une erreur), false s'il est injoignable. */
export function setNetworkHandler(fn) {
  networkHandler = fn;
}
let lastNetworkOk = null;
function reportNetwork(ok) {
  if (ok === lastNetworkOk) return;
  lastNetworkOk = ok;
  if (networkHandler) networkHandler(ok);
}

/**
 * Appel de l'API du PSIM. Ne leve jamais : { ok, status, data, error, network }.
 * `network: true` = pas de reponse du tout (hors ligne, serveur injoignable, delai depasse) ; `status` vaut alors 0.
 * Le cookie de session (psim_session) et le cookie du telephone (psim_phone, HttpOnly) partent tout seuls.
 */
export async function api(path, { method = 'GET', body, signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // pas de corps JSON (image, 204...) : data reste null
    }
    const result = { ok: res.ok, status: res.status, data, error: res.ok ? null : String(data?.error ?? `Erreur ${res.status}`), network: false };
    reportNetwork(true);
    if (res.status === 401 && authLostHandler) authLostHandler(result);
    return result;
  } catch {
    if (!signal?.aborted) reportNetwork(false);
    return { ok: false, status: 0, data: null, error: 'Pas de réseau', network: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Lecture/ecriture prudentes de localStorage (peut lever : navigation privee, quota). */
export const local = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // plein ou interdit : on continue sans
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // rien
    }
  },
};
