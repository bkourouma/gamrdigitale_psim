/**
 * Rendu d'une "camera de surveillance" simulee, image par image (RGB24).
 * Les images sont envoyees a ffmpeg, qui les publie en RTSP : le PSIM les lit comme une vraie camera.
 * Fumee et flammes sont pilotees en direct par les scenarios (voir scenarios.ts).
 */

export const WIDTH = 480;
export const HEIGHT = 270;

// Police 5x7 (une ligne = 5 bits). Suffisante pour : nom de camera, zone, date, "REC".
const GLYPHS: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  ':': [0, 4, 0, 0, 0, 4, 0],
  '/': [1, 1, 2, 4, 8, 16, 16],
  '.': [0, 0, 0, 0, 0, 12, 12],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};

type Color = readonly [number, number, number];

function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

function blend(f: Buffer, i: number, c: Color, a: number): void {
  f[i] += (c[0] - f[i]) * a;
  f[i + 1] += (c[1] - f[i + 1]) * a;
  f[i + 2] += (c[2] - f[i + 2]) * a;
}

function fillRect(f: Buffer, x: number, y: number, w: number, h: number, c: Color, a = 1): void {
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(WIDTH, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y));
  const y1 = Math.min(HEIGHT, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) blend(f, (py * WIDTH + px) * 3, c, a);
}

function fillEllipse(f: Buffer, cx: number, cy: number, rx: number, ry: number, c: Color, a = 1): void {
  for (let py = Math.max(0, Math.floor(cy - ry)); py < Math.min(HEIGHT, Math.ceil(cy + ry)); py++) {
    for (let px = Math.max(0, Math.floor(cx - rx)); px < Math.min(WIDTH, Math.ceil(cx + rx)); px++) {
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      if (dx * dx + dy * dy <= 1) blend(f, (py * WIDTH + px) * 3, c, a);
    }
  }
}

/** Tache floue : opacite maximale au centre, nulle au bord. */
function radial(f: Buffer, cx: number, cy: number, radius: number, c: Color, alpha: number): void {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(WIDTH, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(HEIGHT, Math.ceil(cy + radius));
  const r2 = radius * radius;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const d2 = ((px - cx) ** 2 + (py - cy) ** 2) / r2;
      if (d2 < 1) blend(f, (py * WIDTH + px) * 3, c, alpha * (1 - d2));
    }
  }
}

function line(f: Buffer, x0: number, y0: number, x1: number, y1: number, c: Color, a: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) blend(f, (y * WIDTH + x) * 3, c, a);
  }
}

function drawText(f: Buffer, x: number, y: number, text: string, scale: number, c: Color): void {
  const clean = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  let cx = x;
  for (const ch of clean) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row] & (1 << (4 - col))) fillRect(f, cx + col * scale, y + row * scale, scale, scale, c);
      }
    }
    cx += 6 * scale;
  }
}

function buildBackground(seed: number): Buffer {
  const bg = Buffer.alloc(WIDTH * HEIGHT * 3);
  const horizon = Math.round(HEIGHT * 0.6);
  for (let y = 0; y < HEIGHT; y++) {
    const wall = y < horizon;
    const t = wall ? y / horizon : (y - horizon) / (HEIGHT - horizon);
    const c: Color = wall ? [44 - 10 * t, 58 - 10 * t, 52 - 10 * t] : [26 - 8 * t, 34 - 10 * t, 30 - 9 * t];
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      bg[i] = c[0];
      bg[i + 1] = c[1];
      bg[i + 2] = c[2];
    }
  }
  const edge: Color = [160, 190, 175];
  line(bg, 0, 0, 60, horizon, edge, 0.18);
  line(bg, WIDTH, 0, WIDTH - 60, horizon, edge, 0.18);
  line(bg, 60, horizon, WIDTH - 60, horizon, edge, 0.18);
  fillRect(bg, 60 + seed * 300, horizon - 95, 50, 95, [20, 27, 24]);
  const deskX = 45 + (1 - seed) * 270;
  fillRect(bg, deskX, horizon + 12, 105, 33, [29, 39, 35]);
  fillRect(bg, deskX + 9, horizon + 45, 9, 21, [29, 39, 35]);
  fillRect(bg, deskX + 87, horizon + 45, 9, 21, [29, 39, 35]);
  return bg;
}

export class Scene {
  readonly label: string;
  readonly zone: string;
  private readonly getFire: () => number;
  private readonly bg: Buffer;
  private readonly smoke: { x: number; phase: number }[];
  private level = 0;

  constructor(label: string, zone: string, getFire: () => number) {
    this.label = label;
    this.zone = zone;
    this.getFire = getFire;
    const seed = hash(label);
    this.bg = buildBackground(seed);
    this.smoke = Array.from({ length: 9 }, (_, i) => ({ x: 90 + i * 37, phase: i * 1.7 + seed * 5 }));
  }

  /** Niveau de feu actuellement affiche (0 rien, 1 fumee, 2 flammes), lisse dans le temps. */
  get displayedFire(): number {
    return this.level;
  }

  /** Produit l'image suivante (RGB24, WIDTH x HEIGHT). */
  render(now: number): Buffer {
    this.level += (this.getFire() - this.level) * 0.08;
    const f = Buffer.from(this.bg);

    for (let n = 0; n < 150; n++) {
      const i = (Math.floor(Math.random() * HEIGHT) * WIDTH + Math.floor(Math.random() * WIDTH)) * 3;
      blend(f, i, [210, 225, 215], Math.random() * 0.1);
    }

    if (this.level < 1.2) {
      const px = ((now / 40) % (WIDTH + 90)) - 45;
      fillEllipse(f, px, HEIGHT * 0.37, 8, 9, [10, 14, 12], 0.85);
      fillRect(f, px - 9, HEIGHT * 0.37 + 9, 18, 42, [10, 14, 12], 0.85);
    }

    if (this.level > 0.02) {
      const smokeAlpha = Math.min(this.level, 1) * 0.5;
      for (const s of this.smoke) {
        const drift = Math.sin(now / 900 + s.phase) * 21;
        const rise = (now / 28 + s.phase * 40) % 180;
        radial(f, s.x + drift, HEIGHT * 0.94 - rise - this.level * 30, 70, [190, 190, 190], smokeAlpha);
      }
    }
    if (this.level > 1) {
      const k = this.level - 1;
      const flicker = 0.75 + Math.random() * 0.25;
      radial(f, WIDTH / 2, HEIGHT, 225 * flicker, [240, 90, 20], 0.6 * k);
      radial(f, WIDTH / 2, HEIGHT, 110 * flicker, [255, 190, 60], 0.95 * k);
      fillRect(f, 0, 0, WIDTH, HEIGHT, [200, 40, 0], 0.12 * k);
    }

    for (let y = 0; y < HEIGHT; y += 3) fillRect(f, 0, y, WIDTH, 1, [0, 0, 0], 0.16);

    fillRect(f, 0, 0, WIDTH, 24, [0, 0, 0], 0.5);
    fillRect(f, 0, HEIGHT - 21, WIDTH, 21, [0, 0, 0], 0.5);
    drawText(f, 9, 5, `${this.label} - ${this.zone}`, 2, [232, 240, 236]);
    drawText(f, WIDTH - 47, 5, 'REC', 2, [232, 240, 236]);
    if (Math.floor(now / 600) % 2 === 0) fillEllipse(f, WIDTH - 60, 12, 4, 4, [255, 77, 77]);
    drawText(f, 9, HEIGHT - 17, 'IMAGE SIMULEE', 2, [150, 160, 155]);
    const stamp = new Date(now).toLocaleString('fr-FR').replace(/[^\d/: ]/g, ' ');
    drawText(f, WIDTH - 9 - stamp.length * 12, HEIGHT - 17, stamp, 2, [232, 240, 236]);
    return f;
  }
}
