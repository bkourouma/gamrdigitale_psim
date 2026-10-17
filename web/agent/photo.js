// Application des agents : reduction d'une photo avant envoi (main courante).
// Le serveur accepte 400 Ko de JPEG en base64 (route limitee a 600 Ko de JSON) : on reduit dans un <canvas>.
// Aucun acces au DOM a l'import : ce fichier est aussi importe par les tests de node:test.

/** Taille maximale du texte base64 (400 Ko). */
export const MAX_BASE64 = 400 * 1024;
const MIN_QUALITY = 0.4;
const MIN_SIDE = 240;

/** Dimensions ramenees a `max` pixels sur le grand cote, jamais agrandies, arrondies a l'entier. */
export function fitSize(width, height, max = 1280) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const big = Math.max(w, h);
  if (big <= max) return { width: w, height: h };
  const k = max / big;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Longueur du texte base64 (avec bourrage) d'un contenu de `byteLength` octets. */
export function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * Decision pure « que tenter ensuite quand la photo est encore trop grosse ? ».
 * etat : { max, quality, startQuality } ; baisse la qualite par pas de 0,1 jusqu'a 0,4, puis reduit la taille
 * de 15 % et repart de la qualite de depart. Retourne le nouvel etat, ou null quand il n'y a plus rien a tenter.
 */
export function nextAttempt(state) {
  const { max, quality, startQuality = quality } = state;
  if (quality - 0.1 >= MIN_QUALITY - 1e-9) {
    return { max, quality: Math.round((quality - 0.1) * 10) / 10, startQuality };
  }
  const smaller = Math.floor(max * 0.85);
  if (smaller < MIN_SIDE) return null;
  return { max: smaller, quality: startQuality, startQuality };
}

/** Decode le fichier en image dessinable : { source, width, height, close() }. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
    } catch {
      // repli sur <img> ci-dessous
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Dessine l'image a la taille voulue et l'exporte en JPEG (Blob). */
async function encode(image, width, height, quality) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(image.source, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image.source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('export JPEG impossible'))), 'image/jpeg', quality);
  });
}

/** Texte base64 (sans prefixe « data: ») d'un Blob, lu par FileReader : pas de gros tableau en memoire. */
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'));
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Reduit une photo : JPEG de 1280 px max, qualite 0,7, base64 <= maxBase64 caracteres.
 * Retourne { base64, bytes, width, height, previewUrl } ; l'appelant revoque previewUrl (URL.revokeObjectURL).
 * Leve une Error en francais si la photo est illisible ou ne peut pas etre reduite assez.
 */
export async function reducePhoto(file, { max = 1280, quality = 0.7, maxBase64 = MAX_BASE64 } = {}) {
  let image;
  try {
    image = await decode(file);
  } catch {
    throw new Error('Photo illisible : reprenez-la ou choisissez une autre image.');
  }
  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error('Photo illisible : reprenez-la ou choisissez une autre image.');
    let state = { max, quality, startQuality: quality };
    // borne dure : 4 qualites par taille, taille reduite de 15 % jusqu'a 240 px au minimum
    for (let guard = 0; guard < 60 && state; guard++) {
      const { width, height } = fitSize(image.width, image.height, state.max);
      let blob;
      try {
        blob = await encode(image, width, height, state.quality);
      } catch {
        throw new Error('Impossible de préparer la photo : reprenez-la.');
      }
      if (base64Length(blob.size) <= maxBase64) {
        const base64 = await toBase64(blob);
        return { base64, bytes: blob.size, width, height, previewUrl: URL.createObjectURL(blob) };
      }
      state = nextAttempt(state);
    }
    throw new Error('Photo trop lourde : reprenez-la de plus près ou sans détail inutile.');
  } finally {
    image.close();
  }
}
