import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { createEngine } from '../../server/engine.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { ago, availabilityOfDays, siteCards, incidentStats, riskOf, siteStatus } from '../../portal/server/views.ts';
import { HOUR, NOW, makeSummary, provision, startPortal } from './helpers.ts';

const STALE = 15 * 60_000;

describe('etat d un site, en une phrase', () => {
  it('rien recu : « en attente », jamais « tout fonctionne »', () => {
    assert.equal(siteStatus(null, null, NOW, STALE).level, 'unknown');
  });

  it('tout va bien : « tout fonctionne »', () => {
    const s = makeSummary('s');
    assert.equal(siteStatus(s, NOW, NOW, STALE).level, 'ok');
  });

  it("des cameras non mesurees seules : jamais « tout fonctionne » (rien n'est mesure)", () => {
    const s = makeSummary('s');
    const camerasOnly: SiteSummary = { ...s, devices: s.devices.filter((d) => d.kind === 'camera') };
    const st = siteStatus(camerasOnly, NOW, NOW, STALE);
    assert.equal(st.level, 'unknown');
    assert.match(st.label, /Aucun équipement suivi/);
    assert.equal(siteStatus(camerasOnly, NOW - 2 * HOUR, NOW, STALE).level, 'unreachable', 'et un site muet reste injoignable');
  });

  it('un equipement hors service : degrade, et dit lequel (la zone n est pas protegee)', () => {
    const s = makeSummary('s', { mutate: (e, goTo) => (goTo(NOW - HOUR), e.handleDetectorMessage('D-01', { state: 'fault' })) });
    const st = siteStatus(s, NOW, NOW, STALE);
    assert.equal(st.level, 'degraded');
    assert.match(st.label, /1 équipement hors service/);
    assert.match(st.detail, /n'est pas protégée/);
    assert.match(st.detail, new RegExp(s.devices.find((d) => d.id === 'D-01')!.name));
  });

  it('un incident ouvert : alarme (critique) ou alerte (avertissement), et prime sur un equipement hors service', () => {
    const critical = makeSummary('s', {
      mutate: (e, goTo) => {
        goTo(NOW - HOUR);
        e.handleDetectorMessage('D-02', { state: 'fault' });
        e.handleDetectorMessage('D-01', { state: 'alarm' });
      },
    });
    assert.equal(siteStatus(critical, NOW, NOW, STALE).level, 'alarm');
    assert.equal(siteStatus(critical, NOW, NOW, STALE).label, 'Alarme en cours');
    const warning = makeSummary('s', { mutate: (e, goTo) => (goTo(NOW - HOUR), e.handleDetectorMessage('D-01', { state: 'prealarm' })) });
    assert.equal(siteStatus(warning, NOW, NOW, STALE).label, 'Alerte en cours');
  });

  /** Intrusion sur I-01 il y a `hoursAgo` heures, prise en charge apres 40 s, close 3 min apres, qualifiee `q`. */
  const handled = (hoursAgo: number, q: 'fire' | 'false_alarm' = 'fire', extra?: (e: ReturnType<typeof createEngine>, goTo: (t: number) => void) => void) =>
    makeSummary('s', {
      mutate: (e, goTo) => {
        const t = NOW - hoursAgo * HOUR;
        goTo(t);
        e.handleDetectorMessage('I-01', { event: 'motion' });
        const id = e.getSnapshot().incidents[0].id;
        goTo(t + 40_000);
        e.acknowledge(id, 'gardien');
        e.handleDetectorMessage('I-01', { event: 'clear' });
        goTo(t + 3 * 60_000);
        e.close(id, 'gardien', q, null);
        extra?.(e, goTo);
      },
    });

  it("une intrusion traitee il y a 2 h : jamais « tout fonctionne », le titre dit quoi et quand", () => {
    const st = siteStatus(handled(2), NOW, NOW, STALE);
    assert.equal(st.level, 'recent');
    assert.match(st.label, /^Intrusion aujourd’hui à \d\d:\d\d$/);
    assert.match(st.detail, /Mouvement accueil/);
    assert.match(st.detail, /prise en charge en 1 min/);
    assert.match(st.detail, /clôturée à \d\d:\d\d/);
    assert.match(st.detail, /Les équipements fonctionnent/);
  });

  it('une fausse alarme ne change pas le message ; un incident de plus de 24 h non plus', () => {
    assert.equal(siteStatus(handled(2, 'false_alarm'), NOW, NOW, STALE).level, 'ok');
    assert.equal(siteStatus(handled(30), NOW, NOW, STALE).level, 'ok');
  });

  it('un equipement hors service reste le plus urgent, et cite quand meme le dernier incident', () => {
    const s = handled(2, 'fire', (e, goTo) => (goTo(NOW - HOUR), e.handleDetectorMessage('D-01', { state: 'fault' })));
    const st = siteStatus(s, NOW, NOW, STALE);
    assert.equal(st.level, 'degraded');
    assert.match(st.detail, /Dernier incident : intrusion aujourd’hui à/);
  });

  it('un incident clos n est plus une alarme', () => {
    const s: SiteSummary = makeSummary('s', {
      mutate: (e, goTo) => {
        goTo(NOW - 2 * HOUR);
        e.handleDetectorMessage('D-01', { state: 'alarm' });
        const id = e.getSnapshot().incidents[0].id;
        e.acknowledge(id, 'x');
        e.handleDetectorMessage('D-01', { state: 'normal' });
        e.close(id, 'x', 'false_alarm', null);
      },
    });
    assert.equal(siteStatus(s, NOW, NOW, STALE).level, 'ok');
  });

  it('plus de nouvelles : « injoignable » prime sur tout, et rappelle la derniere alarme connue', () => {
    const s = makeSummary('s', { mutate: (e, goTo) => (goTo(NOW - HOUR), e.handleDetectorMessage('D-01', { state: 'alarm' })) });
    const st = siteStatus(s, NOW - 2 * HOUR, NOW, STALE);
    assert.equal(st.level, 'unreachable');
    assert.match(st.detail, /Aucun signal depuis 2 h/);
    assert.match(st.detail, /Dernier état connu : 1 incident en cours/);
  });

  it('la limite est nette : pile au seuil le site est encore joignable, juste apres il ne l est plus', () => {
    const s = makeSummary('s');
    assert.equal(siteStatus(s, NOW - STALE, NOW, STALE).level, 'ok');
    assert.equal(siteStatus(s, NOW - STALE - 1, NOW, STALE).level, 'unreachable');
  });
});

describe('durees lisibles', () => {
  it('arrondit sans jargon', () => {
    assert.equal(ago(10_000), "moins d'une minute");
    assert.equal(ago(5 * 60_000), '5 min');
    assert.equal(ago(3 * HOUR), '3 h');
    assert.equal(ago(47 * HOUR), '47 h');
    assert.equal(ago(72 * HOUR), '3 jours');
  });
});

describe('disponibilite sur plusieurs jours', () => {
  const day = (up: number, down: number, unmonitored = 0) => ({ day: 'x', pct: null, up_s: up, down_s: down, unmonitored_s: unmonitored });

  it('est ponderee par le temps observe : une journee courte pese moins qu une journee entiere', () => {
    // Jour 1 : 24 h observees, 100 %. Jour 2 : 1 h observee dont 30 min d arret, 50 %. Moyenne simple = 75 %, vraie = 24,5/25 = 98 %.
    const r = availabilityOfDays([day(86_400, 0), day(1800, 1800)]);
    assert.equal(r.pct, 98);
    assert.equal(r.downS, 1800);
  });

  it('le temps non surveille ne compte ni pour ni contre, mais est rapporte', () => {
    const r = availabilityOfDays([day(3600, 0, 7200)]);
    assert.equal(r.pct, 100);
    assert.equal(r.unmonitoredS, 7200);
  });

  it('rien observe : pas de pourcentage, jamais un 100 % invente', () => {
    assert.equal(availabilityOfDays([]).pct, null);
    assert.equal(availabilityOfDays([day(0, 0, 3600)]).pct, null);
  });
});

describe('statistiques d incidents', () => {
  const row = (o: Partial<{ status: string; qualification: string | null; opened_at: number; acked_at: number | null; closed_at: number | null }>) => ({ status: 'closed', qualification: null, opened_at: 0, acked_at: null, closed_at: null, ...o });

  it('compte les vrais evenements, les fausses alarmes et les incidents encore ouverts', () => {
    const s = incidentStats([row({ qualification: 'fire' }), row({ qualification: 'false_alarm' }), row({ qualification: 'false_alarm' }), row({ status: 'open' })]);
    assert.deepEqual({ total: s.total, open: s.open, real: s.real, falseAlarms: s.falseAlarms }, { total: 4, open: 1, real: 1, falseAlarms: 2 });
  });

  it('delais : la mediane (pas la moyenne, que quelques cas extremes fausseraient), et rien si rien a mesurer', () => {
    const s = incidentStats([row({ acked_at: 60_000 }), row({ acked_at: 120_000 }), row({ acked_at: 3_600_000 })]);
    assert.equal(s.ackMedianS, 120);
    assert.equal(incidentStats([row({ status: 'open' })]).ackMedianS, null);
    assert.equal(incidentStats([]).closeMedianS, null);
  });
});

describe('indice de securite GAMR', () => {
  const withIndex = (index: number | null): SiteSummary => ({ ...makeSummary('s'), risk: { index, worstZone: index === null ? null : 'Atelier', assessedZones: index === null ? 0 : 1, totalZones: 1, zones: [], history: [] } });

  it('nomme le niveau par les seuils du PSIM : faible <= 8, modere <= 20, eleve <= 36, critique au-dela', () => {
    const label = (n: number) => riskOf(withIndex(n))!.levelLabel;
    assert.deepEqual([1, 8, 9, 20, 21, 36, 37, 60].map(label), ['Faible', 'Faible', 'Modéré', 'Modéré', 'Élevé', 'Élevé', 'Critique', 'Critique']);
    assert.equal(riskOf(withIndex(30))!.level, 'eleve');
  });

  it("aucune zone evaluee : pas de niveau ; aucun indice transmis : rien du tout (jamais un chiffre invente)", () => {
    const none = riskOf(withIndex(null))!;
    assert.equal(none.index, null);
    assert.equal(none.level, null);
    assert.equal(riskOf(makeSummary('s')), null);
    assert.equal(riskOf(null), null);
  });

  it("date l'indice de son resume : un site injoignable montre son dernier indice connu, date", () => {
    const s = withIndex(24);
    assert.equal(riskOf(s)!.at, s.generatedAt);
  });
});

describe('cartes de sites : disponibilite du mois', () => {
  it('expose le temps d arret du mois, pour ne jamais afficher 100 % apres une panne', async () => {
    const portal = await startPortal();
    try {
      provision(portal.db, 'Org', 'site-a', 'Site A');
      portal.db.prepare('INSERT INTO site_day (site_id, day, pct, up_s, down_s, unmonitored_s) VALUES (?, ?, ?, ?, ?, ?)').run('site-a', '2026-06-14', 100, 86_399_000 - 1000, 1, 0);
      const sites = [{ id: 'site-a', org_id: 1, name: 'Site A', key_version: 1, active: 1, last_received_at: null, org_name: 'Org' }] as any;
      const [card] = siteCards(portal.db, sites, NOW, STALE);
      assert.equal(card.availability30, 100);
      assert.equal(card.availability30DownS, 1);
    } finally {
      await portal.close();
    }
  });
});
