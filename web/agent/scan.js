// Application des agents : lecture d'un point de controle (etiquette NFC, QR code, saisie du code).
// Aucun acces au DOM a l'import : ce fichier est aussi importe par les tests de node:test.

const CODE_RE = /^[a-z2-7]{10}$/;

/**
 * Extrait le code d'un point de controle d'un texte lu (URL complete, fragment, « cp=… » ou code brut).
 * Retourne le code en minuscules (10 caracteres [a-z2-7]) ou null. Majuscules, espaces et tirets tolérés.
 */
export function parseCheckpointCode(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (raw === '') return null;
  let candidate = null;
  const m = /(?:^|[#?&])cp=([^&#\s]*)/i.exec(raw);
  if (m) {
    candidate = m[1];
  } else if (/[#:/?=&]/.test(raw)) {
    // une URL ou un fragment qui n'est pas « cp= » (par exemple « #pair= ») : refuse
    return null;
  } else {
    candidate = raw;
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // on garde tel quel
  }
  candidate = candidate.replace(/[\s-]+/g, '').toLowerCase();
  return CODE_RE.test(candidate) ? candidate : null;
}

/** Le telephone sait-il lire une etiquette NFC (Web NFC) ? */
export function nfcSupported() {
  return 'NDEFReader' in globalThis;
}

/** Le telephone sait-il lire un QR code (BarcodeDetector) ? */
export function qrSupported() {
  return 'BarcodeDetector' in globalThis;
}

/** Texte d'un enregistrement NDEF (decode selon son encodage), ou null. */
function recordText(record) {
  const type = record?.recordType;
  if (type !== 'url' && type !== 'text' && type !== 'absolute-url') return null;
  const data = record.data;
  if (!data) return null;
  try {
    const encoding = type === 'text' && record.encoding ? record.encoding : 'utf-8';
    return new TextDecoder(encoding).decode(data);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(data);
    } catch {
      return null;
    }
  }
}

function nfcErrorMessage(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError') return 'Le NFC est refusé. Autorisez-le dans les réglages du navigateur, ou saisissez le code.';
  if (name === 'NotSupportedError') return 'Ce téléphone ne sait pas lire le NFC. Utilisez le QR code ou saisissez le code.';
  if (name === 'NotReadableError') return 'Le NFC est coupé. Activez-le dans les réglages du téléphone.';
  if (name === 'AbortError') return null;
  return 'Lecture NFC impossible. Utilisez le QR code ou saisissez le code.';
}

/**
 * Lit les etiquettes NFC jusqu'a l'annulation de `signal`. onCode(code) pour chaque etiquette valide,
 * onError(message) sinon. Ne rejette jamais.
 */
export async function startNfcScan({ onCode, onError, signal } = {}) {
  const fail = (msg) => {
    if (msg) {
      try {
        onError?.(msg);
      } catch {
        // l'appelant ne doit pas faire planter la lecture
      }
    }
  };
  if (!nfcSupported()) {
    fail('Ce téléphone ne sait pas lire le NFC. Utilisez le QR code ou saisissez le code.');
    return;
  }
  try {
    const reader = new globalThis.NDEFReader();
    reader.addEventListener('reading', (event) => {
      for (const record of event.message?.records ?? []) {
        const code = parseCheckpointCode(recordText(record) ?? '');
        if (code) {
          try {
            onCode?.(code);
          } catch {
            // idem
          }
          return;
        }
      }
      fail('Cette étiquette n’est pas un point de ronde.');
    });
    reader.addEventListener('readingerror', () => fail('Étiquette illisible, réessayez'));
    await reader.scan({ signal });
  } catch (err) {
    fail(nfcErrorMessage(err));
  }
}

function cameraErrorMessage(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Caméra refusée. Autorisez-la dans les réglages du navigateur, ou saisissez le code.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Aucune caméra trouvée. Saisissez le code.';
  if (name === 'NotReadableError') return 'La caméra est utilisée par une autre application. Fermez-la puis réessayez.';
  return 'Caméra indisponible. Saisissez le code.';
}

/** Intervalle minimal entre deux lectures (~8 par seconde) et delai avant de reprendre le meme code. */
const READ_INTERVAL_MS = 125;
const REPEAT_MS = 3000;

/**
 * Lit les QR codes avec la camera arriere jusqu'a l'annulation de `signal` (ou une erreur) ; la camera
 * est alors coupee. onCode(code) pour un QR valide, jamais deux fois le meme code en 3 s. Ne rejette jamais.
 */
export async function startQrScan({ video, onCode, onError, signal } = {}) {
  let stream = null;
  let stopped = false;
  let frame = 0;
  const stop = () => {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    if (video) video.srcObject = null;
  };
  const fail = (msg) => {
    stop();
    try {
      onError?.(msg);
    } catch {
      // idem
    }
  };
  try {
    if (!qrSupported()) {
      fail('Ce téléphone ne sait pas lire les QR codes. Saisissez le code.');
      return;
    }
    if (signal?.aborted) return;
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (stopped || signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener('abort', stop, { once: true });
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play();
    const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
    let last = 0;
    let lastCode = null;
    let lastCodeAt = 0;
    let busy = false;
    const tick = async (now) => {
      if (stopped) return;
      frame = requestAnimationFrame(tick);
      if (busy || now - last < READ_INTERVAL_MS || video.readyState < 2) return;
      last = now;
      busy = true;
      try {
        const found = await detector.detect(video);
        for (const item of found) {
          const code = parseCheckpointCode(item.rawValue);
          if (!code) continue;
          const t = Date.now();
          if (code === lastCode && t - lastCodeAt < REPEAT_MS) continue;
          lastCode = code;
          lastCodeAt = t;
          onCode?.(code);
          break;
        }
      } catch {
        // une image illisible n'arrete pas la lecture
      } finally {
        busy = false;
      }
    };
    frame = requestAnimationFrame(tick);
  } catch (err) {
    if (signal?.aborted) {
      stop();
      return;
    }
    fail(cameraErrorMessage(err));
  }
}
