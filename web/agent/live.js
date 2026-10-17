// Application des agents : video en direct d'une alarme (F8). Meme technique que web/live.js (poste de garde) :
// le flux multipart/JPEG du serveur est lu avec fetch + ReadableStream, decoupe en images JPEG, et la derniere est
// dessinee sur un canvas. Compatible avec la CSP de l'application : fetch releve de connect-src 'self',
// createImageBitmap + canvas ne chargent rien de l'exterieur, et aucun element <video> ou <img> ne pointe sur le flux
// (media-src n'est donc pas concerne).
//
// Onglet masque : le flux est FERME (un navigateur n'ouvre que 6 connexions a la fois vers un meme site), puis
// rouvert au retour. Ce fichier ne touche pas au DOM a l'import (il est aussi importe par les tests).

const W = 640;
const H = 360;
const STALL_MS = 10000;
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 15000;

function indexOfPair(buf, a, b, from) {
  for (let i = from; i < buf.length - 1; i++) if (buf[i] === a && buf[i + 1] === b) return i;
  return -1;
}

function concat(a, b) {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Decoupe les images JPEG (debut ff d8, fin ff d9) d'un tampon et rend la PLUS RECENTE image complete.
 * `rest` = ce qu'il faut garder pour la suite : une image commencee mais pas finie, ou rien (le bruit entre les
 * images est jete ; un ff final est garde car il peut etre le debut d'un ff d8).
 * @param {Uint8Array} buf
 * @returns {{ frame: Uint8Array | null, rest: Uint8Array }}
 */
export function extractLatestJpeg(buf) {
  let frame = null;
  let rest = buf;
  for (;;) {
    const start = indexOfPair(rest, 0xff, 0xd8, 0);
    if (start < 0) {
      rest = rest.length > 0 && rest[rest.length - 1] === 0xff ? rest.subarray(rest.length - 1) : new Uint8Array(0);
      break;
    }
    const end = indexOfPair(rest, 0xff, 0xd9, start + 2);
    if (end < 0) {
      rest = rest.subarray(start);
      break;
    }
    frame = rest.subarray(start, end + 2);
    rest = rest.subarray(end + 2);
  }
  return { frame, rest };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ url: string, onStatus: (message: string | null) => void }} opts
 * @returns {() => void} fonction d'arret
 */
export function startLiveStream(canvas, { url, onStatus }) {
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  let stopped = false;
  let paused = false;
  let controller = null;
  let retryTimer = null;
  let delay = RETRY_MIN_MS;
  // Chaque lecture a son numero : une lecture interrompue (onglet masque) ne relance jamais rien apres coup.
  let generation = 0;

  function draw(bitmap) {
    const scale = Math.min(W / bitmap.width, H / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
    bitmap.close?.();
  }

  async function run() {
    const gen = ++generation;
    controller = new AbortController();
    const { signal } = controller;
    let watchdog = setTimeout(() => controller.abort(new Error('stall')), STALL_MS + 15000);
    onStatus('Connexion à la caméra…');
    try {
      const res = await fetch(url, { signal, credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Erreur ${res.status}`);
      }
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      let got = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Le flux de la caméra s’est interrompu');
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(new Error('stall')), STALL_MS);
        const { frame, rest } = extractLatestJpeg(concat(buf, value));
        buf = rest;
        if (frame) {
          draw(await createImageBitmap(new Blob([frame], { type: 'image/jpeg' })));
          if (!got) {
            got = true;
            delay = RETRY_MIN_MS;
            onStatus(null);
          }
        }
      }
    } catch (err) {
      if (stopped || paused || gen !== generation) return;
      const stalled = err?.message === 'stall' || signal.reason?.message === 'stall';
      const cause = stalled ? 'Plus d’image reçue de la caméra' : String(err?.message ?? 'Caméra injoignable').replace(/[.\s]+$/, '');
      onStatus(`${cause}. Nouvelle tentative dans quelques secondes…`);
    } finally {
      clearTimeout(watchdog);
    }
    if (stopped || paused || gen !== generation) return;
    retryTimer = setTimeout(run, delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }

  function onVisibility() {
    if (stopped) return;
    if (document.hidden) {
      if (paused) return;
      paused = true;
      clearTimeout(retryTimer);
      generation++;
      controller?.abort(); // libere la connexion ; la derniere image reste affichee
    } else if (paused) {
      paused = false;
      delay = RETRY_MIN_MS;
      run();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  if (document.hidden) paused = true;
  else run();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(retryTimer);
    controller?.abort();
  };
}
