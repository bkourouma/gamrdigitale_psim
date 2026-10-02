/**
 * Simulateur de detecteur en ligne de commande : publie un etat sur le broker MQTT,
 * exactement comme le ferait un detecteur reel.
 *
 *   npm run sim -- D-01 alarm
 *   npm run sim -- D-01 normal
 */
import mqtt from 'mqtt';

const [detectorId, state] = process.argv.slice(2);
const STATES = ['normal', 'prealarm', 'alarm', 'fault', 'offline'];

if (!detectorId || !state || !STATES.includes(state) || !/^[A-Za-z0-9_-]{1,32}$/.test(detectorId)) {
  console.error(`Usage : npm run sim -- <id-detecteur> <${STATES.join('|')}>`);
  process.exit(1);
}

const host = process.env.PSIM_HOST ?? '127.0.0.1';
const port = process.env.PSIM_MQTT_PORT ?? '1883';
const client = mqtt.connect(`mqtt://${host}:${port}`, {
  username: process.env.PSIM_MQTT_USER ?? 'psim',
  password: process.env.PSIM_MQTT_PASSWORD ?? 'psim-dev-only',
  connectTimeout: 5000,
  reconnectPeriod: 0,
});

client.on('error', (err) => {
  console.error(`Connexion MQTT impossible : ${err.message}`);
  process.exit(1);
});

client.on('connect', () => {
  const payload = JSON.stringify({ state, ts: Date.now() });
  client.publish(`psim/detectors/${detectorId}/state`, payload, { qos: 1 }, (err) => {
    if (err) console.error(`Echec de publication : ${err.message}`);
    else console.log(`${detectorId} -> ${state}`);
    client.end(false, () => process.exit(err ? 1 : 0));
  });
});
