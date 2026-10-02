import onvif from 'onvif/promises/index.js';
import { PsimError } from './engine.ts';

export interface OnvifTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface OnvifProbe {
  uri: string;
  manufacturer: string | null;
  model: string | null;
  profile: { name: string; width: number | null; height: number | null; encoding: string | null };
}

export interface DiscoveredCamera {
  host: string;
  port: number;
  name: string | null;
  hardware: string | null;
}

const CONNECT_TIMEOUT_MS = 8000;

interface ProfileInfo {
  token: string;
  name: string;
  width: number | null;
  height: number | null;
  encoding: string | null;
}

function describeProfiles(profiles: unknown): ProfileInfo[] {
  if (!Array.isArray(profiles)) return [];
  const out: ProfileInfo[] = [];
  for (const p of profiles) {
    // La librairie expose les attributs XML sous la cle `$` (profil Media1) ou directement (Media2).
    const token = p?.token ?? p?.$?.token;
    if (typeof token !== 'string') continue;
    const enc = p.videoEncoderConfiguration ?? {};
    const width = Number(enc.resolution?.width);
    const height = Number(enc.resolution?.height);
    out.push({
      token,
      name: String(p.name ?? token),
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      encoding: typeof enc.encoding === 'string' ? enc.encoding : null,
    });
  }
  return out;
}

/**
 * Le mur video affiche des vignettes : on prefere le profil le moins lourd (H.264 ou JPEG,
 * plus petite resolution) plutot que le flux principal 4K/H.265 qui saturerait le poste.
 */
export function pickProfile(profiles: ProfileInfo[]): ProfileInfo | null {
  const easy = profiles.filter((p) => !p.encoding || /h264|jpeg/i.test(p.encoding));
  const pool = easy.length > 0 ? easy : profiles;
  return [...pool].sort((a, b) => (a.width ?? Infinity) * (a.height ?? 1) - (b.width ?? Infinity) * (b.height ?? 1))[0] ?? null;
}

/** Traduit les erreurs techniques de la librairie en messages exploitables par un operateur. */
export function explainOnvifError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ECONNREFUSED') return 'Connexion refusee : verifier l\'adresse et le port ONVIF de la camera';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || /timeout|timed out/i.test(text)) {
    return 'La camera ne repond pas : verifier l\'adresse, le reseau et le pare-feu';
  }
  if (code === 'ENOTFOUND') return 'Adresse introuvable';
  if (/not authorized|unauthorized|sender not authorized|401/i.test(text)) {
    return 'Identifiants refuses par la camera (verifier aussi que l\'heure de la camera est correcte)';
  }
  return `Echec ONVIF : ${text.slice(0, 160)}`;
}

/**
 * Interroge la camera (ONVIF Profile S/T) et renvoie l'adresse RTSP du flux le plus leger.
 * L'hote de l'adresse renvoyee est force a l'hote configure : une camera derriere un NAT ou mal
 * configuree annonce souvent son adresse interne, et on ne suit jamais une redirection arbitraire.
 */
export async function probeOnvif(target: OnvifTarget): Promise<OnvifProbe> {
  const cam = new onvif.Cam({
    hostname: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    timeout: CONNECT_TIMEOUT_MS,
    autoconnect: false,
  });
  try {
    await cam.connect();
    const profiles = describeProfiles((cam as unknown as { profiles?: unknown }).profiles);
    const chosen = pickProfile(profiles);
    const info = await cam.getDeviceInformation().catch(() => null);
    // Les types de la librairie declarent a tort getStreamUri() sans argument une fois promisifiee.
    const getStreamUri = cam.getStreamUri as unknown as (options: object) => Promise<{ uri?: string }>;
    const stream = await getStreamUri(chosen ? { protocol: 'RTSP', profileToken: chosen.token } : { protocol: 'RTSP' });
    const raw = typeof stream?.uri === 'string' ? stream.uri : null;
    if (!raw) throw new Error('La camera n\'a pas fourni d\'adresse de flux');
    const url = new URL(raw);
    if (url.protocol !== 'rtsp:') throw new Error(`Protocole de flux inattendu : ${url.protocol}`);
    url.hostname = target.host;
    url.username = '';
    url.password = '';
    return {
      uri: url.toString(),
      manufacturer: info?.manufacturer ?? null,
      model: info?.model ?? null,
      profile: {
        name: chosen?.name ?? 'defaut',
        width: chosen?.width ?? null,
        height: chosen?.height ?? null,
        encoding: chosen?.encoding ?? null,
      },
    };
  } catch (err) {
    throw new PsimError(502, explainOnvifError(err));
  }
}

function clean(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : null;
}

/** Recherche WS-Discovery (multicast UDP) des cameras ONVIF du reseau local. */
export async function discoverOnvif(timeoutMs = 4000): Promise<DiscoveredCamera[]> {
  let found: unknown[];
  try {
    found = (await onvif.Discovery.probe({ timeout: timeoutMs, resolve: false })) as unknown[];
  } catch (err) {
    // La librairie rejette avec une liste d'erreurs quand aucun equipement ne repond.
    if (Array.isArray(err) || (err instanceof Error && /no\s+(device|response)/i.test(err.message))) return [];
    throw new PsimError(502, `Recherche impossible : ${err instanceof Error ? err.message : String(err)}`);
  }
  const byAddress = new Map<string, DiscoveredCamera>();
  for (const item of found) {
    const match = (item as { probeMatches?: { probeMatch?: Record<string, unknown> } })?.probeMatches?.probeMatch;
    if (!match) continue;
    const xaddrs = typeof match.XAddrs === 'string' ? match.XAddrs.split(/\s+/) : [];
    let url: URL | null = null;
    for (const candidate of xaddrs) {
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'http:' && /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
          url = parsed;
          break;
        }
      } catch {
        // adresse annoncee illisible : on passe a la suivante
      }
    }
    if (!url) continue;
    const scopes = typeof match.scopes === 'string' ? match.scopes.split(/\s+/) : [];
    const scope = (key: string) => {
      const entry = scopes.find((s) => s.includes(`/${key}/`));
      const raw = entry?.split(`/${key}/`)[1] ?? '';
      try {
        return clean(decodeURIComponent(raw));
      } catch {
        return clean(raw); // valeur annoncee mal encodee : on l'affiche telle quelle
      }
    };
    byAddress.set(`${url.hostname}:${url.port || 80}`, {
      host: url.hostname,
      port: Number(url.port) || 80,
      name: scope('name'),
      hardware: scope('hardware'),
    });
  }
  return [...byAddress.values()];
}
