/**
 * Contrat d'evenements entre les modules (et les capteurs Tuya) et le PSIM : tout evenement qu'une table de traduction peut
 * produire DOIT exister dans EVENTS de server/sources.ts, sinon le PSIM l'ignorerait (alarme perdue sans bruit).
 *
 * Deux controles : les tables exportees (listes permises, profils, codes SIA / Contact ID) sont parcourues ; et le source de
 * chaque module est lu pour y relever tout litteral ecrit apres `event:` / `event =` (ce qu'aucune table ne liste, par
 * exemple les traductions Zigbee ou onduleur, codees en dur).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { EVENTS } from '../../server/sources.ts';
import { KNOWN_EVENTS as LORAWAN_EVENTS } from '../src/modules/lorawan/config.ts';
import { PROFILES } from '../src/modules/lorawan/profiles.ts';
import { KNOWN_EVENTS as MODBUS_EVENTS } from '../src/modules/modbus/config.ts';
import { CID_CODES, PSIM_EVENTS as SIA_EVENTS, SIA_CODES } from '../src/modules/sia/codes.ts';
import { KNOWN_EVENTS } from '../src/validate.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MODULES_DIR = join(ROOT, 'gateway', 'src', 'modules');

const psim = (e: string): boolean => Object.hasOwn(EVENTS, e);

/** Toutes les valeurs des cles `event` d'un objet quelconque (profils, tables de codes). */
function eventsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) eventsIn(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'event' && typeof v === 'string') out.add(v);
      else eventsIn(v, out);
    }
  }
  return out;
}

/** Litteraux d'evenements ecrits en dur dans un fichier source. */
function eventsInSource(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bevent\s*[:=]\s*([^,;}\n]+)/g)) {
    // Les comparaisons (`kind === 'contact' ? ...`) ne sont pas des evenements.
    const expr = m[1]!.replace(/[=!]==?\s*'[^']*'/g, '');
    for (const lit of expr.matchAll(/'([a-z][a-z0-9_]*)'/g)) out.add(lit[1]!);
  }
  for (const m of src.matchAll(/\bpulse\(\s*'([a-z][a-z0-9_]*)'/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\bfault\(\s*'[^']*'\s*,\s*'([a-z][a-z0-9_]*)'/g)) out.add(m[1]!);
  return out;
}

function sourcesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => join(d.parentPath, d.name));
}

describe("contrat d'evenements modules -> PSIM", () => {
  it('le socle connait exactement les evenements du PSIM', () => {
    assert.deepEqual([...KNOWN_EVENTS].sort(), Object.keys(EVENTS).sort());
  });

  it('listes permises dans la configuration (modbus, lorawan, sia) : toutes connues du PSIM', () => {
    for (const [name, list] of [['modbus', MODBUS_EVENTS], ['lorawan', LORAWAN_EVENTS], ['sia', Object.keys(SIA_EVENTS)]] as const) {
      const unknown = list.filter((e) => !psim(e));
      assert.deepEqual(unknown, [], `${name} : evenements inconnus du PSIM`);
    }
  });

  it('sia : un evenement transmis a le meme sens que dans le PSIM (sauf power_loss, traite comme un defaut de la centrale)', () => {
    // power_loss : le PSIM ouvre une alarme « Coupure secteur » ; le module le classe « defaut » pour ne pas l'emettre par
    // dessus une alarme en cours de la centrale (et pour le jumeler a power_restored). Toute autre divergence est une erreur.
    const diff = Object.entries(SIA_EVENTS).filter(([e, effect]) => EVENTS[e] !== effect && e !== 'power_loss');
    assert.deepEqual(diff, []);
  });

  it('tables de traduction (codes SIA et Contact ID, profils LoRaWAN) : tous les evenements sont connus du PSIM', () => {
    for (const [name, table] of [['SIA', SIA_CODES], ['Contact ID', CID_CODES], ['profils LoRaWAN', PROFILES]] as const) {
      const found = eventsIn(table);
      assert.ok(found.size > 0, `${name} : aucune table lue`);
      const unknown = [...found].filter((e) => !psim(e));
      assert.deepEqual(unknown, [], `${name} : evenements inconnus du PSIM`);
    }
  });

  it('litteraux des modules (et des capteurs Tuya du PSIM) : tous connus du PSIM', () => {
    const files = [...sourcesOf(MODULES_DIR), join(ROOT, 'server', 'tuyasensors.ts'), join(ROOT, 'server', 'tuya.ts')];
    const seen = new Map<string, string[]>();
    for (const f of files) {
      for (const e of eventsInSource(readFileSync(f, 'utf8'))) {
        if (!psim(e)) seen.set(e, [...(seen.get(e) ?? []), f.slice(ROOT.length + 1)]);
      }
    }
    assert.deepEqual(Object.fromEntries(seen), {}, 'evenements inconnus du PSIM');
  });

  it('le releve des litteraux trouve bien les traductions codees en dur (controle du controle)', () => {
    const zigbee = eventsInSource(readFileSync(join(MODULES_DIR, 'zigbee', 'translate.ts'), 'utf8'));
    for (const e of ['motion', 'door_opened', 'door_closed', 'leak', 'dry', 'gas', 'co', 'vibration', 'panic', 'tamper', 'door_forced', 'low_battery']) {
      assert.ok(zigbee.has(e), `zigbee : ${e}`);
    }
    assert.equal(zigbee.has('contact'), false, 'une comparaison n\'est pas un evenement');
    const ups = eventsInSource(readFileSync(join(MODULES_DIR, 'ups', 'tracker.ts'), 'utf8'));
    for (const e of ['power_loss', 'power_restored', 'low_battery', 'fault', 'heartbeat']) assert.ok(ups.has(e), `ups : ${e}`);
    const tuya = eventsInSource(readFileSync(join(ROOT, 'server', 'tuyasensors.ts'), 'utf8'));
    for (const e of ['intrusion', 'door_opened', 'motion', 'leak', 'gas', 'co', 'sos', 'alarm_reset', 'tamper', 'low_battery']) assert.ok(tuya.has(e), `tuya : ${e}`);
    // Un evenement invente serait releve.
    assert.deepEqual([...eventsInSource("x({ event: on ? 'explosion' : 'clear' })")], ['explosion', 'clear']);
  });
});
