/**
 * Ecran « Cles et passerelles » (web/keys.js, web/keysdata.js) : l'interface est testee comme le reste du web statique,
 * par lecture des fichiers servis (le code d'ecran touche au DOM, il n'est pas execute ici) et par execution des regles
 * pures (keysdata.js, sans DOM) comparees a celles du serveur.
 *
 * Garde-fous verifies : route reservee aux administrateurs, aucune cle dans les fichiers servis ni dans le stockage du
 * navigateur, cle ecrite seulement dans la fenetre d'affichage (non fermable d'un clic a cote) et effacee a sa fermeture,
 * memes regles d'identifiants que le serveur (« * » seul refuse), textes d'avertissement presents.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { PsimError } from '../server/errors.ts';
import { cleanPatterns } from '../server/devicekeys.ts';

const WEB = join(import.meta.dirname, '..', 'web');
// Fins de ligne normalisees : le depot est extrait en CRLF sous Windows (core.autocrlf), les motifs ci-dessous sont ecrits en LF.
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');
const SERVER_DEVICEIMAGES = readFileSync(join(import.meta.dirname, '..', 'server', 'deviceimages.ts'), 'utf8');

interface Data {
  PATTERN_ITEM: RegExp;
  MAX_PATTERNS: number;
  patternProblem: (token: string) => string | null;
  keyState: (k: { active: boolean; revokedAt: number | null }) => string;
  curlExample: (origin: string, deviceId: string, key: string) => string;
  exampleDevice: (devices: string[]) => string;
}
const data = (await import(pathToFileURL(join(WEB, 'keysdata.js')).href)) as Data;

describe('ecran « Cles et passerelles » : page et navigation', () => {
  const html = read('index.html');

  it("le menu d'administration porte l'entree, la page existe, sa feuille de style est chargee", () => {
    const admin = /<div id="nav-admin"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    assert.match(admin, /href="#\/cles" data-view="cles"[\s\S]*?Clés et passerelles/, 'entree dans le groupe Administration (masque aux operateurs)');
    assert.match(html, /<section class="view view-cles[^"]*" id="view-cles"[^>]*hidden>/);
    assert.match(html, /<link rel="stylesheet" href="keys\.css">/);
    for (const id of ['gw-list', 'gw-refresh', 'gw-updated', 'keys-list', 'keys-create', 'keys-title', 'keys-device-options']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.ok(!/<nav class="tabbar"[\s\S]*#\/cles/.test(html), "pas d'onglet rapide : reglage d'installation, pas geste du quotidien");
  });

  it('app.js : la route est reservee aux administrateurs et branchee a keys.js', () => {
    const app = read('app.js');
    assert.match(app, /cles: \{[^}]*admin: true[^}]*\}/, 'route admin : un operateur est ramene a Surveillance par le routeur');
    assert.match(app, /import \{ createKeysAdmin \} from '\.\/keys\.js';/);
    assert.match(app, /view === 'cles'\) \{\s*keysAdmin\.show\(\)/);
    assert.match(app, /view === 'cles'\) \{\s*keysAdmin\.hide\(\)/, "le releve periodique s'arrete quand on quitte l'ecran");
    assert.match(app, /'gw-list', 'keys-list'/, "rien du compte precedent ne reste apres une deconnexion");
  });

  it('textes pour l installateur presents', () => {
    const all = `${html}\n${read('keys.js')}\n${read('keysdata.js')}`;
    for (const text of [
      'Clés et passerelles',
      'Aucune passerelle déclarée',
      'Liaison coupée',
      'Dernier message reçu',
      'Capteurs non surveillés',
      'Aucune clé pour l’instant',
      'Copiez cette clé maintenant',
      'ne sera plus jamais affichée',
      'Copier la clé',
      'Copier la commande',
      'J’ai copié la clé, fermer',
      'Fermer sans avoir copié',
      'Remplacer',
      'Révoquer',
      'En rotation',
      'Révoquée',
      'L’ancienne clé reste valable',
      'Jamais utilisée',
      'seul est refusé',
    ]) {
      assert.ok(all.includes(text), `texte absent : ${text}`);
    }
  });
});

describe('ecran « Cles et passerelles » : la cle n est jamais conservee', () => {
  const code = `${read('keys.js')}\n${read('keysdata.js')}`;
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('aucune cle dans les fichiers servis (page, scripts, feuilles de style)', () => {
    for (const f of readdirSync(WEB).filter((n) => /\.(html|js|css|svg)$/.test(n))) assert.ok(!/psk_\d/.test(read(f)), `${f} contient une cle`);
  });

  it("le code n'ecrit la cle ni dans le stockage, ni dans l'adresse, ni dans l'historique, ni dans du HTML", () => {
    for (const forbidden of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /history\.(push|replace)State/, /location\.(hash|search|href)\s*=/, /innerHTML/, /insertAdjacentHTML/, /outerHTML/, /console\./, /\.setItem\(/]) {
      assert.ok(!forbidden.test(withoutComments), `interdit dans keys.js : ${forbidden}`);
    }
    // Jamais de style en ligne (la politique de securite l'interdit) : mise en forme par classes.
    assert.ok(!/\bstyle:/.test(withoutComments) && !/setAttribute\('style'/.test(withoutComments));
  });

  it("la cle n'est pas placee dans un champ de formulaire (le navigateur pourrait la retenir)", () => {
    // Les deux valeurs sensibles (cle, commande) sont des elements <code> ; aucun input/textarea ne recoit `key`.
    assert.match(code, /const keyEl = h\('code', \{ class: 'keys-secret', text: key \}\);/);
    assert.match(code, /const cmdEl = h\('code', \{ class: 'keys-cmd', text: curlExample\(/);
    assert.ok(!/h\('(input|textarea)'[^)]*\bkey\b/.test(withoutComments));
  });

  it("la fenetre d'affichage ne se ferme ni d'un clic a cote ni par Echap, et efface la cle a sa fermeture", () => {
    const body = /function showSecret\([\s\S]*?\n  \}\n/.exec(code)?.[0] ?? '';
    assert.ok(body.length > 200, 'showSecret introuvable');
    assert.match(body, /dismissible: false/);
    assert.match(body, /onClose: \(\) => \{\s*key = null;\s*keyEl\.textContent = '';\s*cmdEl\.textContent = '';/, 'la cle est effacee a la fermeture');
    assert.match(body, /!copied/, 'fermer sans avoir copie demande une seconde confirmation');
  });

  it('le champ du formulaire de creation et la fenetre de rotation ne gardent rien : le formulaire est vide apres la creation', () => {
    assert.match(code, /form\.reset\(\);\s*patterns\.length = 0;/);
    assert.match(code, /const \{ key, \.\.\.view \} = made;/, 'la cle est separee du reste avant tout rendu de liste');
  });
});

describe('ecran « Cles et passerelles » : memes regles que le serveur', () => {
  const samples = [
    'D-01', 'D-*', 'I_01', 'a', 'A'.repeat(32), `${'A'.repeat(31)}*`, 'D-01*', '*', '**', '*D', 'D*x', 'D-**', 'A'.repeat(33), '', 'é', 'D.01', 'D/01', '../x', 'D-01;', 'D\u0000', 'ZZ-9',
  ];

  it('un identifiant est refuse par la page si et seulement si le serveur le refuse (« * » seul compris)', () => {
    for (const s of samples) {
      let serverRefuses = false;
      try {
        cleanPatterns([s]);
      } catch (err) {
        assert.ok(err instanceof PsimError, String(err));
        serverRefuses = true;
      }
      assert.equal(data.patternProblem(s) !== null, serverRefuses, `identifiant « ${s} »`);
    }
    assert.match(data.patternProblem('*') ?? '', /seul est refusé/);
  });

  it("meme plafond d'identifiants par cle", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `D-${i}`);
    assert.doesNotThrow(() => cleanPatterns(many(data.MAX_PATTERNS)));
    assert.throws(() => cleanPatterns(many(data.MAX_PATTERNS + 1)), PsimError);
  });

  it("etat d'une cle : active, en rotation (fin de validite a venir), revoquee", () => {
    assert.equal(data.keyState({ active: true, revokedAt: null }), 'active');
    assert.equal(data.keyState({ active: true, revokedAt: Date.now() + 60_000 }), 'rotating');
    assert.equal(data.keyState({ active: false, revokedAt: Date.now() - 1 }), 'revoked');
  });

  it("exemple d'envoi : la route, les en-tetes et l'identifiant correspondent a l'entree reelle du serveur", () => {
    const key = 'psk_7_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const cmd = data.curlExample('https://psim.exemple:3033', 'I-01', key);
    assert.equal(cmd.split('\n').length, 1, 'une seule ligne, collable partout');
    assert.match(cmd, /^curl -X POST "https:\/\/psim\.exemple:3033\/api\/ingest\/I-01\/image" /);
    assert.ok(cmd.includes(`-H "Authorization: Bearer ${key}"`) && cmd.includes('-H "Content-Type: image/jpeg"') && cmd.includes('--data-binary "@photo.jpg"'));
    assert.ok(SERVER_DEVICEIMAGES.includes("app.post('/api/ingest/:id/image'"), "la route de l'exemple existe cote serveur");
    assert.equal(data.exampleDevice(['D-*', 'I-01']), 'I-01', "un identifiant exact est prefere");
    assert.equal(data.exampleDevice(['D-*']), 'D-01', 'sinon un exemple bati sur le prefixe');
    assert.ok(!data.exampleDevice(['D-*']).includes('*'));
  });

  it('delais de grace proposes : dans la plage acceptee par le serveur (0 a 1440 minutes)', () => {
    const minutes = [...read('keys.js').matchAll(/\{ minutes: (\d+), label:/g)].map((m) => Number(m[1]));
    assert.ok(minutes.length >= 3);
    for (const m of minutes) assert.ok(Number.isInteger(m) && m >= 0 && m <= 1440, `delai ${m}`);
    assert.ok(minutes.includes(0), "le remplacement immediat reste possible (cle compromise)");
  });
});
