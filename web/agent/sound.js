// Application des agents : sons (Web Audio, aucun fichier : rien a mettre en cache ni a autoriser dans la CSP)
// et vibrations. Le navigateur n'autorise le son qu'apres un geste de l'utilisateur : installAudioUnlock() le leve
// au premier toucher.

let ctx = null;

function ensureContext() {
  if (!ctx) {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** A appeler depuis un geste (toucher, touche) : cree et reveille le contexte audio. */
export function unlockAudio() {
  try {
    const c = ensureContext();
    if (c && c.state === 'suspended') void c.resume();
  } catch {
    // pas de son sur cet appareil
  }
}

/** Le son peut-il etre joue maintenant ? (faux tant que l'agent n'a rien touche) */
export function audioReady() {
  return ctx !== null && ctx.state === 'running';
}

/** Branche le deverrouillage sur les premiers gestes de l'utilisateur. */
export function installAudioUnlock() {
  const events = ['pointerdown', 'touchend', 'keydown'];
  const handler = () => {
    unlockAudio();
    if (audioReady()) for (const e of events) document.removeEventListener(e, handler, true);
  };
  for (const e of events) document.addEventListener(e, handler, true);
}

function tone(freq, startOffset, duration, type, volume) {
  const c = ctx;
  if (!c) return;
  const t0 = c.currentTime + startOffset;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/**
 * Joue un signal. kind : 'ok' (point valide, deux notes montantes), 'error' (grave, descendant),
 * 'alarm' (sirene a deux tons, forte), 'warning' (deux tons moyens), 'info' (note courte).
 * Ne leve jamais ; sans son disponible, ne fait rien.
 */
export function beep(kind) {
  try {
    if (!audioReady()) return;
    if (kind === 'ok') {
      tone(880, 0, 0.12, 'sine', 0.4);
      tone(1320, 0.13, 0.18, 'sine', 0.4);
    } else if (kind === 'error') {
      tone(330, 0, 0.2, 'square', 0.3);
      tone(220, 0.22, 0.3, 'square', 0.3);
    } else if (kind === 'alarm') {
      tone(960, 0, 0.3, 'square', 0.6);
      tone(640, 0.32, 0.3, 'square', 0.6);
    } else if (kind === 'warning') {
      tone(740, 0, 0.2, 'triangle', 0.5);
      tone(587, 0.24, 0.25, 'triangle', 0.5);
    } else {
      tone(1000, 0, 0.1, 'sine', 0.3);
    }
  } catch {
    // rien
  }
}

/** Vibration (ms ou motif). Ne leve jamais ; certains navigateurs l'ignorent. */
export function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // rien
  }
}
