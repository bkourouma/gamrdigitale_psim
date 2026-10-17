/**
 * Detail d'incident : « Agents en deplacement » et motif detaille (web/incidents.js). Le module touche au DOM : on execute
 * seulement ses fonctions pures (bloc delimite par des marqueurs) et on controle le code par lecture du fichier.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = readFileSync(join(import.meta.dirname, '..', 'web', 'incidents.js'), 'utf8').replace(/\r\n/g, '\n');
const block = SRC.slice(SRC.indexOf('// DEBUT-HELPERS-DEPLACEMENT'), SRC.indexOf('// FIN-HELPERS-DEPLACEMENT'));
const lib = new Function(`${block.replace(/export /g, '')}; return { agoText, latestDispatch, dispatchLine };`)() as {
  agoText: (ts: number, now?: number) => string;
  latestDispatch: (l: unknown) => Array<{ username: string; status: string; at: number }>;
  dispatchLine: (e: unknown, now?: number) => string;
};

describe('agents en deplacement (web/incidents.js)', () => {
  it('agoText : texte court en francais', () => {
    const now = 1_000_000_000;
    const ago = (ms: number) => lib.agoText(now - ms, now);
    assert.equal(ago(1), 'à l’instant');
    assert.equal(ago(30_000), 'il y a 30 s');
    assert.equal(ago(120_000), 'il y a 2 min');
    assert.equal(ago(3_900_000), 'il y a 1 h 05');
    assert.equal(lib.agoText(now + 5000, now), 'à l’instant'); // horloge en avance : jamais negatif
  });

  it('latestDispatch : dernier statut par agent, trie par heure, entrees invalides ignorees', () => {
    const out = lib.latestDispatch([
      { username: 'a', status: 'en_route', at: 100 },
      { username: 'b', status: 'en_route', at: 150 },
      { username: 'a', status: 'on_site', at: 200 },
      { username: 'c', status: 'inconnu', at: 10 },
      null,
      { username: 'd', status: 'on_site', at: 'x' },
    ]);
    assert.deepEqual(out.map((e) => [e.username, e.status]), [['b', 'en_route'], ['a', 'on_site']]);
    assert.deepEqual(lib.latestDispatch(null), []);
  });

  it('dispatchLine : nom affiche, repli sur l’identifiant', () => {
    const now = 1_000_000;
    assert.equal(lib.dispatchLine({ username: 'k', displayName: 'Kouassi', status: 'en_route', at: now - 120_000 }, now), 'Kouassi — en route (il y a 2 min)');
    assert.equal(lib.dispatchLine({ username: 'traore', displayName: '', status: 'on_site', at: now - 30_000 }, now), 'traore — sur place (il y a 30 s)');
  });

  it('garde-fous : route, silence sur erreur, pas d’innerHTML, detail affiche', () => {
    assert.match(SRC, /\/api\/incidents\/\$\{id\}\/dispatch/);
    assert.match(SRC, /\.catch\(\(\) => \{\}\)/);
    assert.doesNotMatch(SRC, /innerHTML/);
    assert.match(SRC, /incident\.detail/);
    assert.doesNotMatch(SRC, /setInterval/); // pas de minuteur propre : rythme du tick d'une seconde existant
  });
});
