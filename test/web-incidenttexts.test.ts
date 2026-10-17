/**
 * Textes du détail d'incident par catégorie (web/sources.js) : aucun texte d'incendie hors de la catégorie « fire ».
 * Le module touche au DOM : on exécute seulement le bloc délimité par des marqueurs (table et fonctions pures).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = readFileSync(join(import.meta.dirname, '..', 'web', 'sources.js'), 'utf8').replace(/\r\n/g, '\n');
const block = SRC.slice(SRC.indexOf('// DEBUT-TEXTES-INCIDENT'), SRC.indexOf('// FIN-TEXTES-INCIDENT'));
const lib = new Function(
  `${block.replace(/export /g, '')}; return { INCIDENT_TEXTS, unconfirmedText, chipText, commentPlaceholder, blockedText, realEventLabel, qualificationLabel };`,
)() as {
  INCIDENT_TEXTS: Record<string, unknown>;
  unconfirmedText: (c: string, e?: string) => string;
  chipText: (c: string, confirmed: boolean) => string;
  commentPlaceholder: (c: string) => string;
  blockedText: (c: string, e?: string) => string;
  realEventLabel: (c: string, e?: string) => string;
  qualificationLabel: (c: string, q: string, e?: string) => string;
};

const FIRE_WORDS = /feu|incendie|fum[ée]e/i;
const OTHERS = ['intrusion', 'access', 'environment', 'energy', 'people'];
const PEOPLE_EVENTS = ['sos', 'patrol_incomplete', 'patrol_missed', 'logbook_report'];

/** Tous les textes visibles possibles d'une catégorie (et d'un événement). */
function allTexts(category: string, event?: string): string[] {
  return [
    lib.unconfirmedText(category, event),
    lib.chipText(category, true),
    lib.chipText(category, false),
    lib.commentPlaceholder(category),
    lib.blockedText(category, event),
    lib.realEventLabel(category, event),
    lib.qualificationLabel(category, 'fire', event),
    lib.qualificationLabel(category, 'false_alarm', event),
  ];
}

describe('textes d’incident par catégorie (web/sources.js)', () => {
  it('aucun texte d’incendie hors de la catégorie fire', () => {
    for (const category of OTHERS) {
      for (const event of [undefined, ...PEOPLE_EVENTS, 'motion']) {
        for (const text of allTexts(category, event)) assert.doesNotMatch(text, FIRE_WORDS, `${category}/${event} : ${text}`);
      }
    }
  });

  it('textes imposés de la catégorie people', () => {
    assert.equal(lib.unconfirmedText('people', 'sos'), "Agent en détresse : envoyez de l'aide et appelez-le");
    assert.equal(lib.unconfirmedText('people', 'patrol_incomplete'), 'Ronde non faite : joignez l’agent');
    assert.equal(lib.unconfirmedText('people', 'patrol_missed'), 'Ronde non faite : joignez l’agent');
    assert.equal(lib.unconfirmedText('people', 'logbook_report'), 'Signalement d’un agent : lisez la main courante');
  });

  it('people : puce neutre, libellés d’événement réel adaptés', () => {
    assert.equal(lib.chipText('people', false), 'Non traité');
    assert.equal(lib.qualificationLabel('people', 'fire', 'sos'), 'Détresse avérée');
    assert.equal(lib.qualificationLabel('people', 'fire', 'patrol_missed'), 'Ronde non faite avérée');
    assert.equal(lib.qualificationLabel('people', 'fire', 'logbook_report'), 'Signalement avéré');
    assert.equal(lib.qualificationLabel('people', 'fire'), 'Détresse avérée');
    assert.equal(lib.qualificationLabel('people', 'false_alarm', 'sos'), 'Fausse alarme');
    assert.equal(lib.qualificationLabel('people', 'autre'), '');
  });

  it('autres catégories : textes propres', () => {
    assert.equal(lib.unconfirmedText('intrusion'), 'Rien ne confirme encore l’intrusion. Traitez-la comme une vraie alarme.');
    for (const c of OTHERS) assert.ok(lib.unconfirmedText(c, 'motion').length > 0);
    assert.equal(lib.realEventLabel('intrusion', 'motion'), 'Intrusion avérée');
    assert.equal(lib.realEventLabel('energy'), 'Panne avérée');
  });

  it('fire : textes inchangés', () => {
    assert.equal(lib.unconfirmedText('fire'), 'Rien ne confirme encore le feu. Traitez-la comme une vraie alarme.');
    assert.equal(lib.unconfirmedText('fire', 'sos'), 'Rien ne confirme encore le feu. Traitez-la comme une vraie alarme.');
    assert.equal(lib.chipText('fire', false), 'À confirmer');
    assert.equal(lib.chipText('fire', true), 'Confirmée');
    assert.equal(lib.commentPlaceholder('fire'), 'Ex. fumée de cuisson, porte mal fermée, ronde faite…');
    assert.equal(lib.blockedText('fire'), 'Le détecteur sonne encore : « Fausse alarme » et « Feu confirmé » seront disponibles quand il sera revenu à la normale.');
    assert.equal(lib.realEventLabel('fire'), 'Feu confirmé');
    assert.equal(lib.qualificationLabel('fire', 'fire'), 'Feu confirmé');
    // Catégorie inconnue : repli sur l'incendie, comme avant.
    assert.equal(lib.realEventLabel('inconnue'), 'Feu confirmé');
  });

  it('web/incidents.js n’a plus de texte d’incendie en dur', () => {
    const inc = readFileSync(join(import.meta.dirname, '..', 'web', 'incidents.js'), 'utf8');
    assert.doesNotMatch(inc, /Rien ne confirme|Feu confirmé|fumée de cuisson/);
  });
});
