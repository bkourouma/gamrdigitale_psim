/**
 * Application des agents, onglet Alarmes : calculs purs (resume, age corrige de l'horloge, dispatch, son, cadence
 * d'interrogation) et decoupe des images JPEG du flux video en direct.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { alarmAgeMs, describeDispatch, pollInterval, shouldSound, summarize } from '../web/agent/alarms.js';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { extractLatestJpeg } from '../web/agent/live.js';

function alarm(over: Record<string, unknown> = {}) {
  return { id: 1, severity: 'warning', title: 'Porte forcée', acknowledged: false, acknowledgedBy: null, openedAt: 1000, dispatch: [], ...over };
}

test('summarize : liste vide', () => {
  assert.deepEqual(summarize([]), { total: 0, unacked: 0, worst: null, firstUnackedId: null });
  assert.deepEqual(summarize(undefined), { total: 0, unacked: 0, worst: null, firstUnackedId: null });
});

test('summarize : gravité maximale, non acquittées, première non acquittée dans l’ordre du serveur', () => {
  const list = [
    alarm({ id: 7, severity: 'critical', acknowledged: true, acknowledgedBy: 'Awa' }),
    alarm({ id: 8, severity: 'warning' }),
    alarm({ id: 9, severity: 'warning' }),
  ];
  assert.deepEqual(summarize(list), { total: 3, unacked: 2, worst: 'critical', firstUnackedId: 8 });
  assert.equal(summarize([alarm({ id: 2 })]).worst, 'warning');
  assert.equal(summarize([alarm({ id: 2, acknowledged: true })]).firstUnackedId, null);
});

test('alarmAgeMs : écart d’horloge corrigé puis temps écoulé en local', () => {
  // le serveur dit : alarme ouverte il y a 3 min (serverAt - openedAt), peu importe l’heure du téléphone
  const a = alarm({ openedAt: 1_000_000 });
  const serverAt = 1_180_000;
  const receivedAt = 5_000_000_000; // téléphone très en avance
  assert.equal(alarmAgeMs(a, serverAt, receivedAt, receivedAt), 180_000);
  assert.equal(alarmAgeMs(a, serverAt, receivedAt, receivedAt + 60_000), 240_000);
  // jamais négatif (alarme « du futur », horloge du téléphone reculée)
  assert.equal(alarmAgeMs(alarm({ openedAt: 2_000_000 }), serverAt, receivedAt, receivedAt - 5000), 0);
});

test('describeDispatch : un état par agent, le plus récent', () => {
  const a = alarm({
    dispatch: [
      { username: 'kouassi', displayName: 'Kouassi', status: 'en_route', at: 10 },
      { username: 'awa', displayName: 'Awa', status: 'en_route', at: 20 },
      { username: 'kouassi', displayName: 'Kouassi', status: 'on_site', at: 30 },
    ],
  });
  const d = describeDispatch(a);
  assert.deepEqual(
    d.map((x: { text: string }) => x.text),
    ['Awa y va', 'Kouassi est sur place'],
  );
  assert.deepEqual(describeDispatch(alarm()), []);
  assert.equal(describeDispatch(alarm({ dispatch: [{ username: 'u1', displayName: '', status: 'en_route', at: 1 }] }))[0].text, 'u1 y va');
});

test('shouldSound : tant qu’une alarme n’est acquittée par personne', () => {
  assert.equal(shouldSound([]), false);
  assert.equal(shouldSound([alarm({ acknowledged: true })]), false);
  assert.equal(shouldSound([alarm({ acknowledged: true }), alarm({ id: 2 })]), true);
  assert.equal(shouldSound(undefined), false);
});

test('pollInterval : 4 s au premier plan, 30 s masqué', () => {
  assert.equal(pollInterval(true), 4000);
  assert.equal(pollInterval(false), 30000);
});

// ---- Découpe du flux JPEG
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const jpeg = (...body: number[]) => Uint8Array.from([...SOI, ...body, ...EOI]);
const bytes = (a: Uint8Array | null) => (a ? [...a] : null);

test('extractLatestJpeg : une image complète', () => {
  const { frame, rest } = extractLatestJpeg(jpeg(1, 2, 3));
  assert.deepEqual(bytes(frame), [...SOI, 1, 2, 3, ...EOI]);
  assert.equal(rest.length, 0);
});

test('extractLatestJpeg : image partielle gardée, puis complétée au tour suivant', () => {
  const full = jpeg(1, 2, 3, 4);
  const first = extractLatestJpeg(full.subarray(0, 5));
  assert.equal(first.frame, null);
  assert.deepEqual(bytes(first.rest), [...full.subarray(0, 5)]);
  const joined = new Uint8Array(first.rest.length + (full.length - 5));
  joined.set(first.rest, 0);
  joined.set(full.subarray(5), first.rest.length);
  const second = extractLatestJpeg(joined);
  assert.deepEqual(bytes(second.frame), [...full]);
  assert.equal(second.rest.length, 0);
});

test('extractLatestJpeg : bruit multipart ignoré, rien à garder', () => {
  const noise = Uint8Array.from([0x2d, 0x2d, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x0d, 0x0a]);
  const r = extractLatestJpeg(noise);
  assert.equal(r.frame, null);
  assert.equal(r.rest.length, 0);
  assert.equal(extractLatestJpeg(new Uint8Array(0)).frame, null);
});

test('extractLatestJpeg : plusieurs images, la dernière complète gagne, la suivante entamée est gardée', () => {
  const a = jpeg(1, 1);
  const b = jpeg(2, 2, 2);
  const partial = [...SOI, 9, 9];
  const buf = Uint8Array.from([0x0d, 0x0a, ...a, 0x0d, 0x0a, ...b, 0x0d, 0x0a, ...partial]);
  const { frame, rest } = extractLatestJpeg(buf);
  assert.deepEqual(bytes(frame), [...b]);
  assert.deepEqual(bytes(rest), partial);
});

test('extractLatestJpeg : un 0xff final est gardé (début possible d’un marqueur)', () => {
  const { frame, rest } = extractLatestJpeg(Uint8Array.from([0x00, 0xff]));
  assert.equal(frame, null);
  assert.deepEqual(bytes(rest), [0xff]);
});
