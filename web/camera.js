// Camera simulee : dessine une piece vue par une camera de surveillance.
// C'est le point d'extension video : une vraie camera (flux WebRTC/HLS via une passerelle
// RTSP) remplacera ce module, sans toucher au reste de l'interface.

const W = 320;
const H = 180;

function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

function makeScanlines() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  return c;
}

let scanlines = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ label: string, zone: string, getFire: () => 0|1|2 }} opts  fire : 0 rien, 1 fumee, 2 flammes
 * @returns {() => void} fonction d'arret
 */
export function startSimCamera(canvas, { label, zone, getFire }) {
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  scanlines ??= makeScanlines();

  const seed = hash(label);
  const doorX = 40 + seed * 200;
  const deskX = 30 + (1 - seed) * 180;
  const smoke = Array.from({ length: 9 }, (_, i) => ({ x: 60 + i * 25, phase: i * 1.7 + seed * 5 }));
  let raf = 0;
  let last = 0;
  let fireLevel = 0; // 0..2, lisse pour eviter les sauts

  function room() {
    const wall = g.createLinearGradient(0, 0, 0, 110);
    wall.addColorStop(0, '#2c3a34');
    wall.addColorStop(1, '#22302a');
    g.fillStyle = wall;
    g.fillRect(0, 0, W, 110);
    g.fillStyle = '#18201c';
    g.beginPath();
    g.moveTo(0, H);
    g.lineTo(W, H);
    g.lineTo(W - 40, 110);
    g.lineTo(40, 110);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(160,190,175,0.18)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(40, 110);
    g.moveTo(W, 0); g.lineTo(W - 40, 110);
    g.moveTo(40, 110); g.lineTo(W - 40, 110);
    g.stroke();
    g.fillStyle = '#141b18';
    g.fillRect(doorX, 48, 34, 62);
    g.fillStyle = '#1d2723';
    g.fillRect(deskX, 118, 70, 22);
    g.fillRect(deskX + 6, 140, 6, 14);
    g.fillRect(deskX + 58, 140, 6, 14);
  }

  function person(t) {
    if (fireLevel > 1.2) return; // personne dans la scene quand ca brule
    const x = ((t / 60) % (W + 60)) - 30;
    g.fillStyle = 'rgba(10,14,12,0.85)';
    g.beginPath();
    g.ellipse(x, 100, 5, 6, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(x - 6, 106, 12, 28);
  }

  function fire(t) {
    if (fireLevel <= 0.02) return;
    const smokeAlpha = Math.min(fireLevel, 1) * 0.5;
    for (const s of smoke) {
      const drift = Math.sin(t / 900 + s.phase) * 14;
      const rise = ((t / 40 + s.phase * 30) % 120);
      const y = 170 - rise - fireLevel * 20;
      const grad = g.createRadialGradient(s.x + drift, y, 2, s.x + drift, y, 46);
      grad.addColorStop(0, `rgba(190,190,190,${smokeAlpha})`);
      grad.addColorStop(1, 'rgba(190,190,190,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }
    if (fireLevel > 1) {
      const k = fireLevel - 1;
      const flicker = 0.75 + Math.random() * 0.25;
      const glow = g.createRadialGradient(W / 2, H, 10, W / 2, H, 150 * flicker);
      glow.addColorStop(0, `rgba(255,190,60,${0.95 * k})`);
      glow.addColorStop(0.4, `rgba(240,90,20,${0.6 * k})`);
      glow.addColorStop(1, 'rgba(120,20,0,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
      g.fillStyle = `rgba(200,40,0,${0.12 * k})`;
      g.fillRect(0, 0, W, H);
    }
  }

  // Incrustations en haut de l'image seulement : le bas de la vignette porte la légende du mur (nom, zone, étage),
  // qui cacherait la mention « IMAGE SIMULÉE ».
  function overlay(now) {
    g.drawImage(scanlines, 0, 0);
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 0, W, 28);
    g.font = '10px monospace';
    g.textBaseline = 'middle';
    g.fillStyle = '#e8f0ec';
    g.fillText((zone ? `${label} - ${zone}` : label).slice(0, 34), 6, 8);
    g.textAlign = 'right';
    if (Math.floor(now / 600) % 2 === 0) {
      g.fillStyle = '#ff4d4d';
      g.beginPath();
      g.arc(W - 31, 8, 3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#e8f0ec';
    g.fillText('REC', W - 6, 8);
    g.fillStyle = 'rgba(232,240,236,0.75)';
    g.fillText(new Date(now).toLocaleString('fr-FR'), W - 6, 20);
    g.textAlign = 'left';
    g.fillStyle = '#f4c95a';
    g.fillText('IMAGE SIMULÉE', 6, 20);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 66) return; // ~15 images/s
    last = now;
    const target = getFire();
    fireLevel += (target - fireLevel) * 0.06;
    room();
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(200,220,210,${Math.random() * 0.08})`;
      g.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
    }
    person(now);
    fire(now);
    overlay(Date.now());
  }

  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
