import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createArming } from '../server/arming.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createNotifier } from '../server/notifications.ts';
import type { Channel, Message } from '../server/notifications.ts';
import { seedDemo } from '../server/seed.ts';
import { ALWAYS_ACTIVE_EVENTS, CATEGORIES, CATEGORY_LABEL, CATEGORY_LABEL_PLAIN, EVENTS, EVENT_LABEL, eventLabel, eventLabelPlain, interpret } from '../server/sources.ts';
import type { SensorSettings } from '../server/sources.ts';
import { siteKey } from '../portal/server/keys.ts';
import { createPortalSender } from '../server/portal.ts';
import { MASTER, NOW, makeSummary, provision, startPortal } from './portal/helpers.ts';

const T0 = 1_000_000_000_000;
const S = 1000;
const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Evenements ajoutes avec les categories energie et personnes, et ce qu'ils doivent donner. */
const NEW_ALARMS = ['gas', 'co', 'power_loss', 'vibration', 'camera_masked', 'line_crossing', 'loitering', 'sos', 'fall'];

const settings = (category: SensorSettings['category']): SensorSettings => ({ category, warnAt: null, alarmAt: null, direction: 'above' });

function setup() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0;
  const engine = createEngine(db, () => {}, () => clock, { isArmed: (zone) => arming.isArmed(zone) });
  const arming = createArming(db, () => {}, () => clock, () => {});
  const sent: Message[] = [];
  const channel: Channel = {
    id: 'chat',
    label: 'chat',
    recipients: (level) => (level === 1 ? ['a'] : []),
    mask: (r) => r,
    async send(message) {
      sent.push(message);
    },
  };
  const notifier = createNotifier({ db, engine, channels: [channel], now: () => clock, escalateAfterMs: 180 * S, reminderMs: 300 * S, maxReminders: 2, retryDelaysMs: [0] });
  return { db, engine, arming, notifier, sent, advance: (s: number) => void (clock += s * S) };
}

const add = (t: ReturnType<typeof setup>, id: string, category: SensorSettings['category'], zone: string) =>
  t.engine.createDevice('admin', { id, kind: 'detector', category, name: `Capteur ${id}`, zone });

describe('categories energie et personnes : liste fermee des evenements', () => {
  it('chaque nouvel evenement est reconnu, avec le bon effet', () => {
    for (const event of NEW_ALARMS) {
      assert.equal(EVENTS[event], 'alarm', `${event} doit etre une alarme`);
      const r = interpret(settings('environment'), { event });
      assert.deepEqual(r, { ok: true, state: 'alarm', event, alive: false, value: null });
    }
    assert.equal(EVENTS.power_restored, 'normal');
    assert.deepEqual(interpret(settings('energy'), { event: 'power_restored' }), { ok: true, state: 'normal', event: 'power_restored', alive: false, value: null });
  });

  it('les categories energie et personnes existent, avec leurs libelles accentues et sans accent', () => {
    assert.ok(CATEGORIES.includes('energy') && CATEGORIES.includes('people'));
    assert.equal(CATEGORY_LABEL.energy, 'Énergie');
    assert.equal(CATEGORY_LABEL.people, 'Personnes');
    assert.equal(CATEGORY_LABEL_PLAIN.energy, 'Energie');
    assert.equal(CATEGORY_LABEL_PLAIN.people, 'Personnes');
    for (const c of CATEGORIES) {
      assert.ok(CATEGORY_LABEL[c] && CATEGORY_LABEL_PLAIN[c], `libelles de ${c}`);
      assert.doesNotMatch(CATEGORY_LABEL_PLAIN[c], /[̀-ͯ]|[^\x00-\x7f]/u, `${c} : version sans accent`);
    }
  });

  it("sos et fall comme tamper et panic : jamais masques par un desarmement", () => {
    for (const e of ['tamper', 'panic', 'sos', 'fall']) assert.ok(ALWAYS_ACTIVE_EVENTS.has(e), e);
    assert.ok(!ALWAYS_ACTIVE_EVENTS.has('motion') && !ALWAYS_ACTIVE_EVENTS.has('vibration'));
  });

  it('chaque evenement reconnu a un motif en clair ; accentue puis sans accent', () => {
    for (const event of Object.keys(EVENTS)) assert.ok(EVENT_LABEL[event], `motif manquant pour ${event}`);
    for (const event of Object.keys(EVENT_LABEL)) assert.ok(event in EVENTS, `${event} a un motif mais n'est pas un evenement`);
    assert.equal(eventLabel('gas'), 'Gaz détecté');
    assert.equal(eventLabelPlain('gas'), 'Gaz detecte');
    assert.equal(eventLabelPlain('power_loss'), 'Coupure secteur');
    assert.equal(eventLabel(null), null);
    assert.equal(eventLabel('inconnu'), 'inconnu', 'ancienne donnee : le code, jamais une erreur');
    for (const event of Object.keys(EVENT_LABEL)) assert.doesNotMatch(eventLabelPlain(event)!, /[^\x00-\x7f]/, event);
  });
});

describe('moteur : incidents des categories energie et personnes', () => {
  it('chaque nouvel evenement ouvre un incident critique qui garde son motif', () => {
    const t = setup();
    let n = 0;
    for (const event of NEW_ALARMS) {
      const category = event === 'power_loss' ? 'energy' : event === 'sos' || event === 'fall' ? 'people' : event === 'gas' || event === 'co' ? 'environment' : 'intrusion';
      const id = `X-${++n}`;
      add(t, id, category, `Zone ${n}`);
      assert.deepEqual(t.engine.ingest(id, { event }), { ok: true });
      const incident = t.engine.getSnapshot().incidents.find((i) => i.detectorId === id)!;
      assert.ok(incident, `incident pour ${event}`);
      assert.equal(incident.severity, 'critical');
      assert.equal(incident.event, event);
      assert.equal(incident.category, category);
    }
  });

  it('power_restored remet le capteur a la normale ; l\'incident reste ouvert pour l\'operateur', () => {
    const t = setup();
    add(t, 'P-01', 'energy', 'Local technique');
    t.engine.ingest('P-01', { event: 'power_loss' });
    assert.equal(t.engine.getDevice('P-01')?.status, 'alarm');
    t.engine.ingest('P-01', { event: 'power_restored' });
    assert.equal(t.engine.getDevice('P-01')?.status, 'normal');
    const incident = t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'P-01')!;
    assert.notEqual(incident.status, 'closed');
    assert.equal(incident.event, 'power_loss');
  });

  it("un etat ou une mesure n'a pas de motif : l'incident dit seulement « Alarme »", () => {
    const t = setup();
    t.engine.ingest('D-01', { state: 'alarm' });
    assert.equal(t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-01')!.event, null);
  });

  it("une prealarme aggravee en alarme par un evenement prend le motif de l'alarme", () => {
    const t = setup();
    t.engine.ingest('A-01', { event: 'door_held_open' });
    const before = t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-01')!;
    assert.equal(before.severity, 'warning');
    assert.equal(before.event, 'door_held_open');
    t.engine.ingest('A-01', { event: 'door_forced' });
    const after = t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-01')!;
    assert.equal(after.severity, 'critical');
    assert.equal(after.event, 'door_forced');
  });

  it("desarmement : sos et fall alarment toujours, meme sur un detecteur d'intrusion ; vibration est masquee", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    t.engine.ingest('I-01', { event: 'vibration' });
    assert.equal(t.engine.getSnapshot().incidents.length, 0, 'une vibration en zone desarmee est ignoree');
    for (const event of ['sos', 'fall']) {
      const fresh = setup();
      fresh.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
      fresh.engine.ingest('I-01', { event });
      assert.equal(fresh.engine.getSnapshot().incidents.length, 1, `${event} n'est jamais masque`);
      assert.equal(fresh.engine.getDevice('I-01')?.status, 'alarm');
    }
  });

  it("energie et personnes ne dependent d'aucun armement, meme dans une zone desarmee", () => {
    const t = setup();
    add(t, 'P-01', 'energy', 'Accueil');
    add(t, 'S-01', 'people', 'Accueil');
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 24);
    t.engine.ingest('P-01', { event: 'power_loss' });
    t.engine.ingest('S-01', { event: 'sos' });
    assert.deepEqual(t.engine.getSnapshot().incidents.map((i) => i.detectorId).sort(), ['P-01', 'S-01']);
  });

  it('la categorie se change en energie ou personnes depuis les reglages, et un nom inconnu reste refuse', () => {
    const t = setup();
    assert.equal(t.engine.updateDevice('admin', 'E-02', { category: 'energy' }).category, 'energy');
    assert.equal(t.engine.updateDevice('admin', 'E-02', { category: 'people' }).category, 'people');
    assert.throws(() => t.engine.updateDevice('admin', 'E-02', { category: 'gaz' }), /categorie/);
  });
});

describe('notifications : le vrai motif plutot que « Alarme »', () => {
  const cases: [string, 'environment' | 'energy' | 'people' | 'intrusion', string, RegExp][] = [
    ['gas', 'environment', 'Gaz detecte', /ALARME ENVIRONNEMENT : Gaz detecte - a confirmer - Capteur X-1/],
    ['power_loss', 'energy', 'Coupure secteur', /ALARME ENERGIE : Coupure secteur - a confirmer - Capteur X-1/],
    ['sos', 'people', 'Appel de detresse (SOS)', /ALARME PERSONNES : Appel de detresse \(SOS\) - a confirmer - Capteur X-1/],
    ['fall', 'people', 'Chute detectee', /ALARME PERSONNES : Chute detectee - a confirmer/],
    ['co', 'environment', 'Monoxyde de carbone detecte', /ALARME ENVIRONNEMENT : Monoxyde de carbone detecte/],
    ['camera_masked', 'intrusion', 'Camera masquee', /ALARME INTRUSION : Camera masquee/],
  ];
  for (const [event, category, motive, subject] of cases) {
    it(`${event} : le sujet et les donnees disent « ${motive} »`, async () => {
      const t = setup();
      add(t, 'X-1', category, 'Zone');
      t.engine.ingest('X-1', { event });
      await t.notifier.notifyIncident(t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'X-1')!, 'opened');
      assert.equal(t.sent.length, 1);
      assert.match(t.sent[0].subject, subject);
      assert.equal(t.sent[0].data?.event, event);
      assert.match(t.sent[0].text, new RegExp(motive.replace(/[()]/g, '\\$&')));
    });
  }

  it("sans evenement, le titre reste inchange ; une confirmation garde le motif", async () => {
    const t = setup();
    t.engine.ingest('D-06', { state: 'alarm' });
    await t.notifier.notifyIncident(t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-06')!, 'opened');
    assert.match(t.sent[0].subject, /^\[PSIM\] ALARME - a confirmer - /);
    add(t, 'X-1', 'energy', 'Zone');
    t.engine.ingest('X-1', { event: 'power_loss' });
    await t.notifier.notifyIncident(t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'X-1')!, 'confirmed');
    assert.match(t.sent[1].subject, /ALARME CONFIRMEE : Coupure secteur - Capteur X-1/);
  });
});

describe('base existante : migration sans rien casser', () => {
  it("une base anterieure (sans motif d'incident) est rouverte : colonne ajoutee, donnees intactes, nouvelles categories acceptees", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-'));
    const file = join(dir, 'psim.db');
    // Base « d'avant » : un detecteur, un incident, et pas de colonne event.
    const old = openDb(file);
    old.exec("INSERT INTO device (id, kind, name, zone, category) VALUES ('X-1', 'detector', 'Ancien detecteur', 'Zone', 'environment')");
    old.exec("INSERT INTO incident (detector_id, severity, opened_at) VALUES ('X-1', 'critical', 1000)");
    old.exec('ALTER TABLE incident DROP COLUMN event');
    assert.ok(!(old.prepare('PRAGMA table_info(incident)').all() as { name: string }[]).some((c) => c.name === 'event'));
    old.close();

    const db = openDb(file);
    assert.ok((db.prepare('PRAGMA table_info(incident)').all() as { name: string }[]).some((c) => c.name === 'event'), 'colonne event ajoutee');
    const row = db.prepare("SELECT detector_id, severity, opened_at, event FROM incident WHERE detector_id = 'X-1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { detector_id: 'X-1', severity: 'critical', opened_at: 1000, event: null });
    // Rouvrir une seconde fois ne change rien (migration idempotente).
    db.close();
    const again = openDb(file);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM incident').get() as { n: number }).n, 1);
    // L'incident ancien se lit sans motif, et les nouvelles categories sont acceptees par la base.
    const engine = createEngine(again, () => {}, () => T0);
    assert.equal(engine.getSnapshot().incidents[0].event, null);
    assert.equal(engine.getSnapshot().incidents[0].category, 'environment');
    engine.createDevice('admin', { id: 'P-01', kind: 'detector', category: 'energy', name: 'Onduleur', zone: 'Local' });
    engine.createDevice('admin', { id: 'S-01', kind: 'detector', category: 'people', name: 'Bouton SOS', zone: 'Accueil' });
    assert.deepEqual(
      (again.prepare("SELECT id, category FROM device WHERE id IN ('P-01', 'S-01') ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({ ...r })),
      [{ id: 'P-01', category: 'energy' }, { id: 'S-01', category: 'people' }],
    );
    again.close();
  });

  it("aucune contrainte CHECK sur la categorie : une base existante n'a donc pas besoin d'etre recreee", () => {
    const db = openDb(':memory:');
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'device'").get() as { sql: string }).sql;
    assert.doesNotMatch(sql, /category[^,]*CHECK/i);
    db.exec("INSERT INTO device (id, kind, name, category) VALUES ('P-1', 'detector', 'Onduleur', 'energy')");
    db.exec("INSERT INTO device (id, kind, name, category) VALUES ('S-1', 'detector', 'SOS', 'people')");
  });
});

describe('interface et portail : toutes les categories et tous les motifs partout', () => {
  // Evalue un objet litteral `export const NOM = { ... };` d'un fichier de l'interface (sans importer le module : il touche au DOM).
  const literal = (path: string, name: string): Record<string, string> => {
    const m = new RegExp(`export const ${name} = (\\{[\\s\\S]*?\\n\\});`).exec(read(path));
    assert.ok(m, `${name} introuvable dans ${path}`);
    return new Function(`return (${m[1]})`)() as Record<string, string>;
  };
  const straight = (s: string) => s.replace(/’/g, "'");

  it('web/sources.js : memes categories, memes libelles, memes motifs que le serveur', () => {
    const cats = /export const CATEGORIES = (\[[^\]]*\]);/.exec(read('web/sources.js'));
    assert.deepEqual(new Function(`return ${cats![1]}`)(), [...CATEGORIES]);
    const labels = literal('web/sources.js', 'CATEGORY_LABEL');
    for (const c of CATEGORIES) assert.equal(straight(labels[c]), CATEGORY_LABEL[c], c);
    assert.deepEqual(Object.keys(labels).sort(), [...CATEGORIES].sort());
    assert.deepEqual(literal('web/sources.js', 'EVENT_LABEL'), { ...EVENT_LABEL });
  });

  it("le simulateur, les formes du plan, les icones et le portail connaissent chaque categorie", () => {
    for (const c of CATEGORIES) {
      assert.match(read('web/plan.js'), new RegExp(`\\b${c}: '`), `icone de ${c} sur le plan`);
      assert.match(read('web/equipment.js'), new RegExp(`\\b${c}: '[A-Z]'`), `prefixe d'identifiant de ${c}`);
      assert.match(read('web/sources.js'), new RegExp(`\\b${c}: '`), `aide de ${c}`);
      assert.match(read('portal/web/ui.js'), new RegExp(`\\b${c}: \\{ label:`), `libelle du portail pour ${c}`);
      assert.match(read('portal/server/views.ts'), new RegExp(`\\b${c}: '`), `mot d'incident du portail pour ${c}`);
      if (c !== 'fire') assert.match(read('web/sources.js'), new RegExp(`\\n  ${c}: \\[`), `boutons du simulateur pour ${c}`);
    }
    for (const icon of ['bolt', 'user']) {
      assert.match(read('web/icons.svg'), new RegExp(`<symbol id="${icon}"`));
      assert.match(read('portal/web/icons.svg'), new RegExp(`<symbol id="${icon}"`));
    }
    assert.match(read('web/surveillance.css'), /\.cat-energy/);
    assert.match(read('web/surveillance.css'), /\.cat-people/);
  });
});

describe('portail : accepte les nouvelles categories', () => {
  it("un resume avec un detecteur « energie » et un incident « personnes » est enregistre (incidents lisibles dans la base du portail)", async () => {
    const portal = await startPortal();
    try {
      provision(portal.db, 'Client', 'site-n', 'Site');
      const summary = makeSummary('site-n', {
        mutate: (engine, goTo) => {
          goTo(NOW - 5 * 3_600_000);
          engine.createDevice('admin', { id: 'P-01', kind: 'detector', category: 'energy', name: 'Onduleur', zone: 'Local' });
          engine.createDevice('admin', { id: 'S-01', kind: 'detector', category: 'people', name: 'Bouton SOS', zone: 'Accueil' });
          engine.ingest('P-01', { event: 'power_loss' });
          engine.ingest('S-01', { event: 'sos' });
        },
      });
      const sender = createPortalSender({ url: `${portal.base}/api/ingest`, siteId: 'site-n', key: siteKey(MASTER, 'site-n', 1), everyMs: 60_000, build: () => summary, now: portal.now });
      assert.equal(await sender.push(), true, sender.status().lastError ?? '');
      const categories = (portal.db.prepare('SELECT DISTINCT category FROM incident WHERE site_id = ?').all('site-n') as { category: string }[]).map((r) => r.category).sort();
      assert.deepEqual(categories, ['energy', 'people']);
    } finally {
      await portal.close();
    }
  });
});
