/**
 * Faux appareil ONVIF (Profile S) pour la demonstration et les tests.
 *
 * Il se comporte comme une camera reelle sur les points qui comptent pour le PSIM :
 *  - il exige une authentification WS-Security (condensé SHA-1 du mot de passe) sauf pour
 *    GetSystemDateAndTime, comme le veut la specification ;
 *  - il propose deux profils : un principal lourd (H.265 4K) que le PSIM doit eviter, et un
 *    secondaire leger (H.264) qui est le vrai flux ;
 *  - il annonce une adresse RTSP "interne" differente de celle par laquelle on l'a joint,
 *    defaut tres courant sur le terrain (camera derriere un NAT ou mal configuree).
 *
 * Il ne remplace pas un test sur une vraie camera : il valide le dialogue tel que NOUS le
 * comprenons, pas la conformite complete a ONVIF.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { networkInterfaces } from 'node:os';

export interface OnvifDeviceOptions {
  port: number;
  host?: string;
  username: string;
  password: string;
  manufacturer?: string;
  model?: string;
  /** Flux RTSP reel du profil secondaire. */
  rtsp: { host: string; port: number; path: string };
  /** Resolution du profil secondaire (le principal est annonce en 3840x2160 H.265). */
  width?: number;
  height?: number;
}

export interface OnvifDevice {
  port: number;
  /** Actions SOAP recues, dans l'ordre (utile pour les tests). */
  requests: string[];
  /** Nombre de requetes refusees faute d'identifiants valides. */
  authFailures: number;
  close(): Promise<void>;
}

const SOAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:ter="http://www.onvif.org/ver10/error"><s:Body>${body}</s:Body></s:Envelope>`;

const ACTIONS = /<(?:\w+:)?(GetSystemDateAndTime|GetServices|GetCapabilities|GetVideoSources|GetProfiles|GetStreamUri|GetDeviceInformation)\b/;

/** Verifie l'en-tete WS-Security UsernameToken / PasswordDigest. */
function authenticated(body: string, username: string, password: string): boolean {
  const pick = (tag: string) => new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([^<]*)<`).exec(body)?.[1];
  const user = pick('Username');
  const digest = pick('Password');
  const nonce = pick('Nonce');
  const created = pick('Created');
  if (user !== username || !digest || !nonce || !created) return false;
  const expected = createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created, 'ascii'), Buffer.from(password, 'ascii')]))
    .digest();
  const given = Buffer.from(digest, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startOnvifDevice(options: OnvifDeviceOptions): Promise<OnvifDevice> {
  const host = options.host ?? '127.0.0.1';
  const width = options.width ?? 480;
  const height = options.height ?? 270;
  const requests: string[] = [];
  const device: OnvifDevice = { port: options.port, requests, authFailures: 0, close: async () => {} };

  const profile = (token: string, encoding: string, w: number, h: number) =>
    `<trt:Profiles fixed="true" token="${token}"><tt:Name>${token}</tt:Name>` +
    `<tt:VideoSourceConfiguration token="vsc1"><tt:Name>vsc</tt:Name><tt:UseCount>2</tt:UseCount><tt:SourceToken>vs1</tt:SourceToken><tt:Bounds x="0" y="0" width="${w}" height="${h}"/></tt:VideoSourceConfiguration>` +
    `<tt:VideoEncoderConfiguration token="enc-${token}"><tt:Name>enc</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>${encoding}</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality></tt:VideoEncoderConfiguration></trt:Profiles>`;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      const action = ACTIONS.exec(body)?.[1];
      const send = (xml: string, status = 200) => void res.writeHead(status, { 'Content-Type': 'application/soap+xml; charset=utf-8' }).end(SOAP(xml));
      const base = `http://${host}:${options.port}`;
      requests.push(action ?? 'inconnue');

      if (action && action !== 'GetSystemDateAndTime' && !authenticated(body, options.username, options.password)) {
        device.authFailures++;
        return send(
          '<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason></s:Fault>',
          400,
        );
      }

      switch (action) {
        case 'GetSystemDateAndTime': {
          const now = new Date();
          return send(
            `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone><tt:UTCDateTime><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
          );
        }
        case 'GetServices':
          // Beaucoup de cameras anciennes ne l'implementent pas : le client doit se rabattre sur GetCapabilities.
          return send('<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text xml:lang="en">Optional action not implemented</s:Text></s:Reason></s:Fault>', 500);
        case 'GetCapabilities':
          return send(
            `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>${base}/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`,
          );
        case 'GetVideoSources':
          return send(
            '<trt:GetVideoSourcesResponse><trt:VideoSources token="vs1"><tt:Framerate>25</tt:Framerate><tt:Resolution><tt:Width>3840</tt:Width><tt:Height>2160</tt:Height></tt:Resolution></trt:VideoSources></trt:GetVideoSourcesResponse>',
          );
        case 'GetProfiles':
          return send(`<trt:GetProfilesResponse>${profile('main', 'H265', 3840, 2160)}${profile('sub', 'H264', width, height)}</trt:GetProfilesResponse>`);
        case 'GetDeviceInformation':
          return send(
            `<tds:GetDeviceInformationResponse><tds:Manufacturer>${options.manufacturer ?? 'DemoCam'}</tds:Manufacturer><tds:Model>${options.model ?? 'DC-100'}</tds:Model><tds:FirmwareVersion>1.0.0</tds:FirmwareVersion><tds:SerialNumber>DEMO-${options.port}</tds:SerialNumber><tds:HardwareId>demo</tds:HardwareId></tds:GetDeviceInformationResponse>`,
          );
        case 'GetStreamUri': {
          const token = /<ProfileToken>([^<]+)</.exec(body)?.[1] ?? 'main';
          // Le profil principal pointe vers un flux qui n'existe pas : choisir le mauvais profil se voit tout de suite.
          const path = token === 'sub' ? options.rtsp.path : `${options.rtsp.path}-main`;
          return send(
            `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://${options.rtsp.host}:${options.rtsp.port}${path}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`,
          );
        }
        default:
          return send('<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">Action not supported</s:Text></s:Reason></s:Fault>', 400);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, resolve);
  });
  device.close = () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  return device;
}

// ---- Decouverte reseau (WS-Discovery) ------------------------------------------------------

export interface DiscoverableDevice {
  host: string;
  port: number;
  name: string;
  hardware: string;
}

const MULTICAST = '239.255.255.250';

function stableUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Construit la reponse WS-Discovery (ProbeMatches) d'un appareil. */
export function probeMatches(device: DiscoverableDevice, relatesTo: string): string {
  const uuid = stableUuid(`${device.host}:${device.port}`);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<s:Header><a:MessageID>urn:uuid:${stableUuid(`msg-${Date.now()}-${device.port}`)}</a:MessageID><a:RelatesTo>${relatesTo}</a:RelatesTo><a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action></s:Header>` +
    `<s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:${uuid}</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types>` +
    `<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/${encodeURIComponent(device.name)} onvif://www.onvif.org/hardware/${encodeURIComponent(device.hardware)}</d:Scopes>` +
    `<d:XAddrs>http://${device.host}:${device.port}/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`
  );
}

/**
 * Repond aux recherches WS-Discovery (multidiffusion UDP 239.255.255.250:3702) : c'est ce qui
 * fait apparaitre les cameras dans « Rechercher sur le reseau ». Peut echouer si le port est
 * deja pris ou si le reseau bloque la multidiffusion : la demo continue alors sans.
 */
export async function startDiscoveryResponder(
  devices: DiscoverableDevice[],
  port = 3702,
): Promise<{ port: number; close(): Promise<void> }> {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, remote) => {
    const text = msg.toString('utf8');
    if (!/<(?:\w+:)?Probe[\s>]/.test(text)) return;
    const relatesTo = /MessageID[^>]*>([^<]+)</.exec(text)?.[1] ?? '';
    for (const device of devices) {
      const reply = Buffer.from(probeMatches(device, relatesTo));
      socket.send(reply, remote.port, remote.address);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, '0.0.0.0', resolve);
  });
  socket.on('error', () => {});
  // On rejoint le groupe sur chaque interface : le client choisit l'interface par defaut du poste.
  let joined = 0;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== 'IPv4') continue;
      try {
        socket.addMembership(MULTICAST, a.address);
        joined++;
      } catch {
        // interface sans multidiffusion : on passe
      }
    }
  }
  if (joined === 0) {
    try {
      socket.addMembership(MULTICAST);
    } catch {
      // pas de multidiffusion du tout : seules les requetes directes (tests) fonctionneront
    }
  }
  const bound = socket.address().port;
  return { port: bound, close: () => new Promise((resolve) => socket.close(() => resolve())) };
}
