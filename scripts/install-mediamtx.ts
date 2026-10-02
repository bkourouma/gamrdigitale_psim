/**
 * Installe MediaMTX (serveur RTSP open source, https://github.com/bluenviron/mediamtx) dans
 * tools/mediamtx/ : il sert de faux "serveur de cameras" pour l'environnement de demonstration.
 *
 *   npm run install:mediamtx
 *
 * La version est epinglee et l'archive est verifiee (SHA-256) contre le fichier checksums.sha256
 * de la meme publication avant extraction.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MEDIAMTX_VERSION = 'v1.21.1';
const BASE = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}`;

const ASSETS: Record<string, string> = {
  'win32-x64': `mediamtx_${MEDIAMTX_VERSION}_windows_amd64.zip`,
  'linux-x64': `mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz`,
  'darwin-arm64': `mediamtx_${MEDIAMTX_VERSION}_darwin_arm64.tar.gz`,
};

const root = resolve(import.meta.dirname, '..');
export const MEDIAMTX_DIR = join(root, 'tools', 'mediamtx');
export const MEDIAMTX_BIN = join(MEDIAMTX_DIR, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const VERSION_FILE = join(MEDIAMTX_DIR, '.version');

export function isInstalled(): boolean {
  return existsSync(MEDIAMTX_BIN) && existsSync(VERSION_FILE) && readFileSync(VERSION_FILE, 'utf8').trim() === MEDIAMTX_VERSION;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telechargement impossible (${res.status}) : ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function installMediamtx(log: (msg: string) => void = console.log): Promise<void> {
  if (isInstalled()) {
    log(`MediaMTX ${MEDIAMTX_VERSION} deja installe (${MEDIAMTX_BIN})`);
    return;
  }
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`Plateforme non prise en charge : ${process.platform}-${process.arch}`);

  log(`Telechargement de ${asset} depuis github.com/bluenviron/mediamtx ...`);
  const [archive, checksums] = await Promise.all([download(`${BASE}/${asset}`), download(`${BASE}/checksums.sha256`)]);

  const expected = checksums
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    // Format sha256sum : "<empreinte> *<fichier>" (l'etoile marque le mode binaire).
    .find(([, name]) => name?.replace(/^\*/, '') === asset)?.[0];
  if (!expected) throw new Error(`Empreinte de ${asset} introuvable dans checksums.sha256`);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Empreinte SHA-256 incorrecte : fichier refuse (attendu ${expected}, obtenu ${actual})`);
  }
  log(`Empreinte SHA-256 verifiee (${(archive.length / 1e6).toFixed(1)} Mo)`);

  rmSync(MEDIAMTX_DIR, { recursive: true, force: true });
  mkdirSync(MEDIAMTX_DIR, { recursive: true });
  const file = join(MEDIAMTX_DIR, asset);
  writeFileSync(file, archive);
  // Sous Windows 10+, System32\tar.exe (bsdtar) extrait les .zip ; le `tar` de Git Bash ne le sait pas.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, ['-xf', asset], { cwd: MEDIAMTX_DIR, stdio: 'pipe' });
  rmSync(file, { force: true });
  if (result.status !== 0 || !existsSync(MEDIAMTX_BIN)) {
    throw new Error(`Extraction impossible : ${result.stderr?.toString() || result.error?.message || 'binaire absent'}`);
  }
  writeFileSync(VERSION_FILE, MEDIAMTX_VERSION);
  log(`MediaMTX ${MEDIAMTX_VERSION} installe dans ${MEDIAMTX_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  installMediamtx().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
