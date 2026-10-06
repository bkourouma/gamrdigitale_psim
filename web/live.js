// Camera reelle : lit le flux multipart/JPEG du serveur (/api/cameras/<id>/stream) et le dessine
// sur un canvas. Lire le flux avec fetch (plutot qu'une balise <img>) permet de detecter une coupure
// ou un gel de l'image, et d'afficher la vraie cause renvoyee par le serveur.
//
// Onglet masque (autre onglet au premier plan, fenetre reduite) : le flux est FERME, puis rouvert au retour.
// Un navigateur n'ouvre que 6 connexions a la fois vers un meme site, et chaque camera affichee en garde une
// tant qu'elle est a l'ecran : deux onglets du PSIM ouverts suffisaient a laisser des cameras sur « Connexion… ».

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
 * @param {HTMLCanvasElement} canvas
 * @param {{ cameraId: string, onStatus: (message: string | null) => void }} opts
 * @returns {() => void} fonction d'arret
 */
export function startLiveCamera(canvas, { cameraId, onStatus }) {
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
      const res = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/stream`, { signal, credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Erreur ${res.status}`);
      }
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      let got = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Le flux de la caméra s\'est interrompu');
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(new Error('stall')), STALL_MS);
        buf = concat(buf, value);

        // On decoupe les images JPEG (SOI ff d8 ... EOI ff d9) et on ne decode que la plus recente.
        let latest = null;
        for (;;) {
          const start = indexOfPair(buf, 0xff, 0xd8, 0);
          if (start < 0) {
            buf = new Uint8Array(0);
            break;
          }
          const end = indexOfPair(buf, 0xff, 0xd9, start + 2);
          if (end < 0) {
            buf = buf.subarray(start);
            break;
          }
          latest = buf.subarray(start, end + 2);
          buf = buf.subarray(end + 2);
        }
        if (latest) {
          draw(await createImageBitmap(new Blob([latest], { type: 'image/jpeg' })));
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
      // La cause, puis ce qui va se passer : le mur réessaie seul (wall.js reconnaît l'échec au mot « tentative »).
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

  if (document.hidden) paused = true; // ouvert dans un onglet en arriere-plan : rien avant qu'il soit affiche
  else run();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(retryTimer);
    controller?.abort();
  };
}
