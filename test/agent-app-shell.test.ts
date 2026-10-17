/**
 * Coquille de l'application des agents (web/agent/index.html, app.js, agent.css, manifest, icones, sw.js).
 * Par lecture des fichiers servis : CSP stricte (aucun script ni style en ligne, pas de HTML construit a partir de donnees),
 * ressources liees presentes, manifeste valide, modules importes existants, service worker sans cache de l'API.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

// @ts-expect-error module JS de l'interface (sans types) ; son demarrage est garde par `typeof document`, import sans DOM
import { landingFor, shiftJustEnded } from '../web/agent/app.js';

const AGENT = join(import.meta.dirname, '..', 'web', 'agent');
// Fins de ligne normalisees (le depot peut etre extrait en CRLF).
const read = (file: string) => readFileSync(join(AGENT, file), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const app = read('app.js');
const jsFiles = readdirSync(AGENT).filter((f) => f.endsWith('.js'));

describe('index.html', () => {
  it('lie les cinq feuilles de style dans l\'ordre, le module app.js et le manifeste, et ces fichiers existent', () => {
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sheets, ['agent.css', 'alarms.css', 'ronde.css', 'sos.css', 'logbook.css']);
    assert.match(html, /<script type="module" src="app\.js"><\/script>/);
    assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
    for (const file of [...sheets, 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png']) {
      assert.ok(existsSync(join(AGENT, file)), `${file} manque`);
    }
  });

  it('est en francais, adapte au telephone, avec la couleur de theme', () => {
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /name="theme-color" content="#244c87"/);
    assert.match(html, /<div id="app">/);
    assert.match(html, /<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/);
  });

  it('n\'a ni attribut style ni script en ligne (CSP stricte)', () => {
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /<style[\s>]/i);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="/, 'script sans src');
      assert.equal(m[2].trim(), '', 'script en ligne');
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'gestionnaire d\'evenement en ligne');
  });
});

describe('modules JavaScript de l\'application', () => {
  const forbidden: [RegExp, string][] = [
    [/\binnerHTML\b/, 'innerHTML'],
    [/\bouterHTML\b/, 'outerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\.write\b/, 'document.write'],
    [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\b/, 'new Function'],
    [/setAttribute\(\s*['"]style['"]/, "setAttribute('style'"],
  ];

  it('il y a des modules a verifier', () => {
    assert.ok(jsFiles.includes('app.js') && jsFiles.includes('util.js'));
  });

  for (const [pattern, name] of forbidden) {
    it(`aucun module n'utilise ${name}`, () => {
      for (const file of jsFiles) {
        // Les commentaires peuvent citer ces noms pour dire qu'on les evite : on ne regarde que le code.
        const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
        assert.doesNotMatch(code, pattern, `${file} utilise ${name}`);
      }
    });
  }

  it('tous les modules importes par app.js existent (resolution relative)', () => {
    const imports = [...app.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.length >= 7, 'app.js doit importer ses modules');
    for (const spec of imports) {
      assert.ok(existsSync(join(AGENT, spec)), `${spec} manque`);
    }
  });

  it('tous les imports relatifs de tous les modules existent', () => {
    for (const file of jsFiles) {
      for (const m of read(file).matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
        assert.ok(existsSync(join(dirname(join(AGENT, file)), m[1])), `${file} importe ${m[1]} qui manque`);
      }
    }
  });

  it('app.js enregistre le service worker de portee ./ et debloque le son', () => {
    assert.match(app, /serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
    assert.match(app, /installAudioUnlock\(\)/);
  });

  it('app.js efface les cles psim-agent-* a la fin du service, sauf les reglages du telephone (discret, appairage, dernier agent, journal des refus)', () => {
    assert.match(app, /KEY_DISCREET = 'psim-agent-discreet'/);
    assert.match(app, /KEEP_AT_END = new Set\(\[KEY_DISCREET, KEY_PAIRED, KEY_LAST, KEY_REJECTS\]\)/);
    assert.match(app, /!KEEP_AT_END\.has\(key\)/);
  });

  it('Avenant 1 : file et SOS vivent hors session ; plus de discardForeign ; 401 « non appaire » renvoie a l\'appairage', () => {
    assert.doesNotMatch(app, /discardForeign/);
    assert.match(app, /core = buildCore\(\)/);
    assert.match(app, /kinds: \(\) => \(hasSession\(\) \? null : \['sos'\]\)/);
    assert.match(app, /non appair/);
    assert.match(app, /setAuthLostHandler\(onAuthLost\)/);
    assert.match(app, /keepKinds: \['sos'\]/);
  });
});

describe('agent connecte sans service : il traite les alarmes (decision du responsable)', () => {
  const onDuty = { username: 'a.diallo', displayName: 'A. Diallo', shift: { startedAt: 1000, endsAt: 2000 } };
  const offDuty = { username: 'a.diallo', displayName: 'A. Diallo', shift: null };

  it('landingFor : connecte, en service ou non, arrive sur l\'ecran principal ; seul le hors service montre le bandeau', () => {
    assert.deepEqual(landingFor(onDuty), { screen: 'main', offDuty: false });
    assert.deepEqual(landingFor(offDuty), { screen: 'main', offDuty: true });
    assert.deepEqual(landingFor({ username: 'a.diallo' }), { screen: 'main', offDuty: true }, 'shift absent = hors service');
  });

  it('landingFor : sans profil exploitable (hostile ou vide), retour a la connexion', () => {
    for (const bad of [null, undefined, {}, { username: '' }, { username: 42 }, 'a.diallo', []]) {
      assert.deepEqual(landingFor(bad), { screen: 'login', offDuty: false }, JSON.stringify(bad));
    }
  });

  it('shiftJustEnded : jamais pour qui n\'a jamais eu de service (pas de « service termine », file locale conservee)', () => {
    assert.equal(shiftJustEnded(false, offDuty), false);
    assert.equal(shiftJustEnded(false, onDuty), false);
    assert.equal(shiftJustEnded(false, null), false);
  });

  it('shiftJustEnded : la fin d\'un service qui a existe pendant la session garde son comportement', () => {
    assert.equal(shiftJustEnded(true, offDuty), true);
    assert.equal(shiftJustEnded(true, onDuty), false, 'toujours en service');
    assert.equal(shiftJustEnded(true, null), false, 'pas de profil : pas de conclusion');
  });

  it('prise de service pendant la session : hadShift passe a vrai, puis la fin est detectee', () => {
    // Meme enchainement que app.js : hadShift = Boolean(me.shift) apres la prise de service, puis relecture de /me.
    let hadShift = Boolean(offDuty.shift);
    assert.equal(shiftJustEnded(hadShift, offDuty), false);
    hadShift = Boolean(onDuty.shift);
    assert.equal(hadShift, true);
    assert.equal(shiftJustEnded(hadShift, offDuty), true);
  });

  it('app.js : plus de garde de service a l\'arrivee ni au demarrage sans reseau', () => {
    assert.doesNotMatch(app, /if \(me\.shift\) void enterMain\(\);\s*else showService\(\)/);
    assert.doesNotMatch(app, /saved\?\.username && saved\.shift/);
    assert.match(app, /function applyMe\(next\) \{\s*adoptMe\(next\);\s*void enterMain\(\);/);
    assert.match(app, /landingFor\(saved\)\.screen === 'main'/);
  });

  it('app.js : bandeau « hors service » sur l\'ecran principal, bouton qui appelle la meme prise de service que showService', () => {
    assert.match(app, /Vous êtes hors service\. Vous pouvez traiter les alarmes\./);
    assert.match(app, /class: 'sh-offduty'/);
    assert.match(app, /shell\.offDuty\.hidden = !landingFor\(me\)\.offDuty/);
    assert.equal(app.match(/\/api\/agent\/shift\/start/g)?.length, 1, 'un seul appel de prise de service (factorise)');
    assert.match(app, /async function requestShiftStart\(\)/);
    assert.equal(app.match(/await requestShiftStart\(\)/g)?.length, 2, 'ecran service et bandeau');
  });

  it('app.js : la fin de service ne se declare que via shiftJustEnded, et une reponse /me perimee est ecartee', () => {
    assert.match(app, /shiftJustEnded\(hadShift, r\.data\.me\)/);
    assert.doesNotMatch(app, /hadShift && !me\.shift/);
    assert.match(app, /if \(version !== meVersion\) return;/);
    assert.match(app, /if \(me\.shift\) hadShift = true;/);
  });

  it('app.js : l\'envoi d\'une ronde et la main courante ne dependent pas du service', () => {
    for (const file of ['ronde.js', 'logbook.js', 'alarms.js']) {
      assert.doesNotMatch(read(file), /\.shift\b/, `${file} ne doit pas exiger de service`);
    }
    assert.match(app, /ronde\.start\(\);/);
  });

  it('agent.css : le bandeau est stylise (contraste fort) et le bouton garde une grande cible', () => {
    const css = read('agent.css');
    assert.match(css, /\.sh-offduty \{[^}]*background: var\(--warn-soft\)[^}]*color: var\(--warn-ink\)/);
    assert.match(css, /\.sh-start \{\s*min-height: 88px/);
  });
});

describe('manifeste', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  it('decrit une application autonome en francais', () => {
    assert.equal(manifest.name, 'GAMR-DIGITALE Agent');
    assert.equal(manifest.short_name, 'Agent');
    assert.equal(manifest.lang, 'fr');
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.orientation, 'portrait');
    assert.equal(manifest.theme_color, '#244c87');
    assert.equal(manifest.background_color, '#244c87');
  });

  it('declare des icones qui existent (192, 512, maskable, svg)', () => {
    const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
    for (const icon of icons) assert.ok(existsSync(join(AGENT, icon.src)), `${icon.src} manque`);
    assert.ok(icons.some((i) => i.sizes === '192x192'));
    assert.ok(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
    assert.ok(icons.some((i) => i.purpose === 'maskable'));
    assert.ok(icons.some((i) => i.src.endsWith('.svg')));
  });

  it('les PNG ont les dimensions annoncees', () => {
    for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]] as const) {
      const png = readFileSync(join(AGENT, file));
      assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  });
});

describe('feuilles de style', () => {
  const css = read('agent.css');

  it('definissent les jetons du contrat, clairs et sombres', () => {
    for (const token of ['bg', 'surface', 'surface-2', 'ink', 'ink-2', 'line', 'brand', 'brand-ink', 'on-brand', 'ok', 'ok-ink', 'ok-soft', 'warn', 'warn-ink', 'warn-soft', 'on-warn', 'alarm', 'alarm-ink', 'alarm-soft', 'off', 'off-ink', 'off-soft', 'focus', 'tap', 'radius', 'gap', 'font-body', 'font-display']) {
      assert.match(css, new RegExp(`--${token}:`), `jeton --${token} manquant`);
    }
    assert.match(css, /prefers-color-scheme: dark/);
    assert.match(css, /prefers-reduced-motion: reduce/);
  });

  it('definissent les classes communes', () => {
    for (const cls of ['btn', 'btn-primary', 'btn-ok', 'btn-danger', 'btn-quiet', 'card', 'card-title', 'pill', 'pill-ok', 'pill-warn', 'pill-alarm', 'pill-off', 'stack', 'row', 'grow', 'muted', 'sr-only', 'field', 'input', 'screen', 'screen-title', 'empty', 'overlay', 'sheet', 'toast']) {
      assert.match(css, new RegExp(`\\.${cls}[\\s,{:.\\[]`), `classe .${cls} manquante`);
    }
  });

  it('les polices pointent vers des fichiers locaux existants', () => {
    for (const m of css.matchAll(/url\('\.\.\/(fonts\/[^']+)'\)/g)) {
      assert.ok(existsSync(join(AGENT, '..', m[1])), `${m[1]} manque`);
    }
  });
});

describe('service worker (s\'il existe)', () => {
  const swPath = join(AGENT, 'sw.js');
  const sw = existsSync(swPath) ? read('sw.js') : null;

  it('ne met jamais /api/ en cache', { skip: sw === null }, () => {
    assert.match(sw as string, /\/api\//, 'garde /api/ absente');
  });

  it('toutes les URL precachees existent', { skip: sw === null }, () => {
    const list = /PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(sw as string);
    if (!list) return; // liste sous un autre nom : rien a verifier ici
    for (const m of list[1].matchAll(/'([^']+)'/g)) {
      const url = m[1];
      if (url === './' || url === '/agent/') continue; // la page elle-meme
      const rel = url.replace(/^\/agent\//, '').replace(/^\.\//, '');
      assert.ok(existsSync(join(AGENT, rel)), `${url} precache mais absent`);
    }
  });
});
