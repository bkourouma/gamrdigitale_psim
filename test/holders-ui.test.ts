/**
 * Ecran « Titulaires » (web/holders.js, web/holdersfmt.js, web/holders.css) : teste comme le reste du web statique, par
 * lecture des fichiers servis (le code d'ecran touche au DOM, il n'est pas execute ici) et par execution de ses fonctions
 * PURES (holdersfmt.js n'importe rien : aucune page n'est necessaire).
 *
 * Garde-fous verifies : route ouverte a l'operateur comme a l'administrateur, menu et page presents, feuille de style
 * chargee, aucune mise en forme en ligne ni HTML construit a partir de donnees (CSP stricte), aucun nom ni badge dans une
 * adresse, formes des corps de requete conformes a docs/ACCES.md § 12, modele CSV accepte par l'import du serveur.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { parseHolderCsv } from '../server/accessimport.ts';

const WEB = join(import.meta.dirname, '..', 'web');
// Fins de ligne normalisees : le depot est extrait en CRLF sous Windows (core.autocrlf), les motifs ci-dessous sont ecrits en LF.
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');

interface Win {
  days: number[];
  from: string;
  to: string;
}
interface Fmt {
  [name: string]: any;
}
const F = (await import(pathToFileURL(join(WEB, 'holdersfmt.js')).href)) as Fmt;

/** Un instant local precis (les fonctions de date lisent l'heure locale du poste). */
const at = (y: number, mo: number, d: number, hh = 0, mm = 0) => new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();

describe('ecran « Titulaires » : page, route et navigation', () => {
  const html = read('index.html');
  const app = read('app.js');

  it('la route « titulaires » est ouverte a l\'operateur (pas admin: true) et porte un titre et un sous-titre', () => {
    const line = /^\s*titulaires: \{[^\n]*\},?$/m.exec(app)?.[0] ?? '';
    assert.match(line, /title: 'Titulaires'/);
    assert.match(line, /sub: '/);
    assert.ok(!/admin: true/.test(line), 'ni operateur seulement ni administrateur seulement : les deux roles');
  });

  it('app.js branche l\'ecran : import, creation, show a l\'entree, hide a la sortie', () => {
    assert.match(app, /import \{ createHoldersView \} from '\.\/holders\.js';/);
    assert.match(app, /const holdersView = createHoldersView\(\{[^}]*dialogs[^}]*getMe: \(\) => S\.me[^}]*\}\);/);
    assert.match(app, /view === 'titulaires'\) \{\n\s*holdersView\.hide\(\)/);
    assert.match(app, /view === 'titulaires'\) \{\n\s*holdersView\.show\(\)/);
  });

  it('le menu principal porte « Titulaires » apres « Journal » (hors groupe Administration), la page et sa feuille existent', () => {
    const nav = /<nav[^>]*id="rail"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? html;
    assert.match(nav, /href="#\/titulaires" data-view="titulaires"[\s\S]*?<span>Titulaires<\/span>/);
    const journal = nav.indexOf('data-view="journal"');
    const holders = nav.indexOf('data-view="titulaires"');
    const admin = nav.indexOf('id="nav-admin"');
    assert.ok(journal !== -1 && journal < holders && holders < admin, 'apres Journal, avant le groupe Administration');
    assert.match(html, /<section class="view view-titulaires[^"]*" id="view-titulaires"[^>]*hidden>/);
    assert.match(html, /id="holders-root"/);
    assert.match(html, /<link rel="stylesheet" href="holders\.css">/);
  });

  it('l\'icone « badge » existe dans le sprite et toutes les icones citees par l\'ecran y sont', () => {
    const sprite = read('icons.svg');
    assert.match(sprite, /<symbol id="badge"/);
    const names = new Set<string>();
    const js = read('holders.js') + read('holdersfmt.js');
    for (const m of js.matchAll(/\bic(?:on)?: '([a-z-]+)'|\bicon\('([a-z-]+)'\)|\bicon: '([a-z-]+)'/g)) names.add(m[1] ?? m[2] ?? m[3]);
    assert.ok(names.size > 10, 'des icones sont bien reperees');
    for (const name of names) assert.match(sprite, new RegExp(`<symbol id="${name}"`), `icone « ${name} »`);
  });
});

describe('ecran « Titulaires » : securite de l\'interface (CSP stricte, aucune donnee dans une adresse)', () => {
  for (const file of ['holders.js', 'holdersfmt.js']) {
    const src = read(file);
    it(`${file} : pas de style en ligne, d'HTML construit, d'eval, de document.write ni de stockage`, () => {
      for (const forbidden of [/\bstyle=/, /\.style\b/, /\bsetAttribute\(\s*['"]style/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\(/, /new Function/, /document\.write/, /localStorage/, /sessionStorage/, /document\.cookie/, /<script/i]) {
        assert.ok(!forbidden.test(src), `${file} ne doit pas contenir ${forbidden}`);
      }
    });
    it(`${file} : ne change jamais l'adresse de la page`, () => {
      for (const forbidden of [/history\.(push|replace)State/, /location\.(hash|search|href)\s*=/, /window\.open/, /location\.assign/]) {
        assert.ok(!forbidden.test(src), `${file} ne doit pas contenir ${forbidden}`);
      }
    });
  }

  it('toute adresse d\'API de holders.js n\'integre que des identifiants (jamais un nom, un matricule ni un numero de badge)', () => {
    const src = read('holders.js');
    const urls = [...src.matchAll(/`(\/api\/access\/[^`]*)`/g)].map((m) => m[1]);
    assert.ok(urls.length >= 15, 'les appels a l\'API sont reperes');
    // Expressions autorisees dans une adresse : identifiants numeriques, identifiant de controleur encode, parametres fixes.
    const allowed = new Set([
      'id',
      'd.id',
      'badge.id',
      'g.id',
      's.id',
      'existing.id',
      'v.holder.id',
      'ctlPath(c)',
      'ctlPath(entry.status)',
      'encodeURIComponent(c.controllerId)',
      'photoVersion.get(id) ?? 0',
      "dryRun ? '?dryRun=1' : ''",
      "st.showRecent ? 'recent' : 'current'",
      'F.holdersQuery({ q: st.q, status: st.status, cursor: append ? st.next : null })',
    ]);
    const seen = new Set<string>();
    for (const url of urls) {
      for (let i = url.indexOf('${'); i !== -1; i = url.indexOf('${', i + 2)) {
        let depth = 1;
        let j = i + 2;
        for (; j < url.length && depth > 0; j++) depth += url[j] === '{' ? 1 : url[j] === '}' ? -1 : 0;
        const expr = url.slice(i + 2, j - 1).trim();
        seen.add(expr);
        assert.ok(allowed.has(expr), `expression « ${expr} » dans ${url}`);
      }
    }
    assert.ok(seen.size >= 8, 'les expressions d\'adresse sont bien reperees');
    // La recherche passe par URLSearchParams, jamais par une concatenation de texte saisi.
    assert.match(read('holdersfmt.js'), /new URLSearchParams\(/);
    assert.ok(!/api\([^)]*\+\s*(?:search|q|name|number)/.test(src));
  });

  it('les photos ne sont demandees que si hasPhoto, avec des identifiants numeriques', () => {
    const src = read('holders.js');
    assert.match(src, /item\.hasPhoto \? h\('img', \{ src: photoUrl\(item\.id\)/);
    assert.match(src, /if \(d\.hasPhoto\) return h\('img'/);
    assert.match(src, /`\/api\/access\/holders\/\$\{id\}\/photo\?v=\$\{photoVersion\.get\(id\) \?\? 0\}`/);
  });

  it('un geste durable passe par une confirmation qui dit ce qui va se passer', () => {
    const src = read('holders.js');
    for (const [verb, route] of [
      ['DELETE', '/api/access/holders/${d.id}`'],
      ['DELETE', '/api/access/holders/${d.id}/photo`'],
      ['DELETE', '/api/access/groups/${g.id}`'],
      ['DELETE', '/api/access/schedules/${s.id}`'],
      ['DELETE', '/api/access/badges/${badge.id}`'],
    ]) {
      assert.ok(src.includes(`${route}, { method: '${verb}' }`), `${verb} ${route}`);
    }
    // Chaque DELETE et chaque fin de visite sont dans un onConfirm (la confirmation s'ouvre avant l'ecriture).
    for (const m of src.matchAll(/method: 'DELETE'/g)) {
      const before = src.slice(Math.max(0, m.index - 140), m.index);
      assert.match(before, /onConfirm: \(\) => api\(/, 'DELETE sans onConfirm');
    }
    assert.match(src, /onConfirm: \(\) => api\(`\/api\/access\/visitors\/\$\{v\.holder\.id\}\/end`, \{ method: 'POST' \}\)/);
    assert.match(src, /heading: 'Importer pour de bon'/);
    // Cle et suppressions en masse : mot de passe demande, envoye dans le champ `reauth`.
    assert.match(src, /dialogs\.ask\(\{[\s\S]*?\/key`, \{ method: 'POST', body: \{ reauth \} \}/);
    assert.match(src, /dialogs\.ask\(\{[\s\S]*?\/confirm-deletions`, \{ method: 'POST', body: \{ reauth \} \}/);
  });

  it('la cle de synchronisation n\'est jamais dans un champ de formulaire, ni stockee, et sa fenetre ne se ferme que par son bouton', () => {
    const src = read('holders.js');
    const block = /function showKey\(c, result, done\) \{[\s\S]*?\n    \}\n/.exec(src)?.[0] ?? '';
    assert.ok(block.length > 100);
    assert.match(block, /h\('code', \{ class: 'hd-key', text: result\.key \}\)/);
    assert.ok(!/h\('(?:input|textarea)'/.test(block), 'pas de champ');
    assert.match(block, /\{ dismissible: false(?:, onClose: done)? \}/);
    assert.match(block, /copyButton\(h, \{ label: 'Copier la cl/);
  });

  it('aucun replaceChildren n\'ecrit « null » : les elements absents sont filtres (fiche de l\'operateur, rapport d\'import)', () => {
    const src = read('holders.js');
    assert.match(src, /detailBody\.replaceChildren\(\.\.\.\[head, identity, badges, sync, passages, adminBar\]\.filter\(Boolean\)\)/);
    assert.match(src, /\]\.filter\(Boolean\), \/\/ replaceChildren/);
  });

  it('detail d\'un controleur : une lecture echouee affiche l\'erreur et « Reessayer » au lieu de « Lecture du detail… » indefiniment', () => {
    const src = read('holders.js');
    assert.match(src, /entry\.detailError = err\.message/);
    assert.match(src, /Le détail n’a pas pu être lu\./);
  });

  it('l\'operateur peut neutraliser un badge ; les autres gestes d\'administration restent gardes par isAdmin', () => {
    const src = read('holders.js');
    for (const label of ['Désactiver le badge', 'Réactiver le badge', 'Ajouter le badge', 'Modifier', 'Supprimer le titulaire', 'Nouveau titulaire', 'Activer la synchronisation', 'Renouveler la clé', 'Confirmer les suppressions', 'Nouveau groupe', 'Nouvelle plage horaire', 'Enregistrer les jours fériés']) {
      assert.ok(src.includes(label), `bouton « ${label} »`);
    }
    assert.match(src, /if \(b\.state === 'active'\) \{\n\s*actions\.push\(button\('Désactiver le badge'/);
    assert.match(src, /if \(admin\) actions\.push\(button\('Rendre le badge'/);
    assert.match(src, /else if \(admin && \(b\.state === 'disabled' \|\| b\.state === 'lost'\)\)/);
    assert.match(src, /const addForm = admin\n/);
    assert.match(src, /let adminBar = null;\n\s*if \(admin\) \{/);
    assert.match(src, /newBtn\.hidden = !isAdmin\(\)/);
    assert.match(src, /newGroup\.hidden = !admin/);
    assert.match(src, /newSchedule\.hidden = !admin/);
    assert.match(src, /holidayEdit\.hidden = !admin/);
    assert.match(src, /tabButtons\.import\.hidden = !isAdmin\(\)/);
    // La synchronisation : seules les actions d'administration sont gardees, le detail reste visible de tous.
    assert.match(src, /if \(admin\) \{\n\s*if \(!c\.enabled\) actions\.push\(button\('Activer la synchronisation'/);
  });

  it('les minuteurs s\'arretent a la sortie de l\'ecran, a la sortie de l\'onglet et quand la page est masquee', () => {
    const src = read('holders.js');
    assert.match(src, /SYNC_REFRESH_MS = 10_000/);
    assert.match(src, /hide\(\) \{\n\s*shown = false;\n\s*stopTimers\(\);/);
    assert.match(src, /if \(!shown \|\| document\.visibilityState === 'hidden'\) return;/);
    assert.match(src, /if \(activeTab === 'sync'\) timers\.sync = setInterval/);
    assert.match(src, /SEARCH_DELAY_MS = 300/);
  });

  it('la feuille de style ne contient que des classes hd-* et des jetons de base.css (aucune couleur en dur, aucun !important)', () => {
    const css = read('holders.css');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'aucune couleur en dur');
    assert.ok(!/!important/.test(css));
    assert.match(css, /@container/);
    for (const sel of css.matchAll(/^\.([a-z][a-z0-9-]*)/gm)) {
      assert.ok(/^(hd-|view-titulaires)/.test(sel[1]), `selecteur « .${sel[1]} » hors du prefixe hd-`);
    }
  });

  it('tous les jetons var(--...) de la feuille existent dans base.css', () => {
    const base = read('base.css');
    const used = new Set([...read('holders.css').matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    for (const token of used) assert.match(base, new RegExp(`${token}\\s*:`), token);
  });
});

describe('ecran « Titulaires » : dates, durees et visiteurs', () => {
  const NOW = at(2026, 10, 17, 14, 5);

  it('dates lisibles, validite en clair', () => {
    assert.equal(F.dateText(at(2026, 10, 12)), '12/10/2026');
    assert.equal(F.timeText(at(2026, 10, 12, 9, 7)), '09:07');
    assert.equal(F.validityText(at(2026, 10, 12), at(2027, 6, 30)), 'du 12/10/2026 au 30/06/2027');
    assert.equal(F.validityText(at(2026, 10, 12), null), 'à partir du 12/10/2026');
    assert.equal(F.validityText(null, at(2027, 6, 30)), "jusqu'au 30/06/2027");
    assert.equal(F.validityText(null, null), 'sans limite');
  });

  it('jour et heure : aujourd\'hui, hier, demain, ou la date', () => {
    assert.equal(F.dateTimeText(at(2026, 10, 17, 9, 12), NOW), "aujourd'hui à 09:12");
    assert.equal(F.dateTimeText(at(2026, 10, 16, 23, 50), NOW), 'hier à 23:50');
    assert.equal(F.dateTimeText(at(2026, 10, 18, 3, 10), NOW), 'demain à 03:10');
    assert.equal(F.dateTimeText(at(2026, 9, 1, 8, 0), NOW), '01/09/2026 à 08:00');
  });

  it('temps restant : minutes, heures, jours', () => {
    assert.equal(F.remainingText(0), 'terminée');
    assert.equal(F.remainingText(-5), 'terminée');
    assert.equal(F.remainingText(30_000), "moins d'une minute");
    assert.equal(F.remainingText(42 * 60_000), '42 min');
    assert.equal(F.remainingText(125 * 60_000), '2 h 05');
    assert.equal(F.remainingText(60 * 60_000), '1 h 00');
    assert.equal(F.remainingText((3 * 1440 + 4 * 60) * 60_000), '3 j 4 h');
  });

  it('champ date <-> ms : debut a 00:00, fin a 23:59, aller-retour, dates impossibles refusees', () => {
    const start = F.dateInputToStart('2026-10-12');
    const end = F.dateInputToEnd('2026-10-12');
    assert.equal(new Date(start).getHours(), 0);
    assert.equal(new Date(end).getHours(), 23);
    assert.equal(new Date(end).getMinutes(), 59);
    assert.equal(F.dateToInput(start), '2026-10-12');
    assert.equal(F.dateToInput(end), '2026-10-12');
    assert.equal(F.dateToInput(null), '');
    assert.equal(F.dateInputToStart('2026-02-30'), null);
    assert.equal(F.dateInputToStart(''), null);
    assert.equal(F.dateInputToEnd('12/10/2026'), null);
  });

  it('heure de fin d\'un visiteur : 1 h, 2 h, 4 h, fin de journee, personnalisee', () => {
    assert.deepEqual(F.visitorEnd({ now: NOW, choice: '1h' }), { ok: true, minutes: 60, endsAt: NOW + 3_600_000 });
    assert.equal(F.visitorEnd({ now: NOW, choice: '2h' }).minutes, 120);
    assert.equal(F.visitorEnd({ now: NOW, choice: '4h' }).minutes, 240);
    const day = F.visitorEnd({ now: NOW, choice: 'day' });
    assert.equal(day.ok, true);
    assert.equal(F.timeText(day.endsAt), '23:59');
    assert.equal(F.dateText(day.endsAt), '17/10/2026');
    assert.equal(day.minutes, Math.ceil((at(2026, 10, 17, 23, 59) - NOW) / 60_000));
    assert.deepEqual(F.visitorEnd({ now: NOW, choice: 'custom', customMinutes: '90' }), { ok: true, minutes: 90, endsAt: NOW + 90 * 60_000 });
  });

  it('heure de fin : trop tard dans la journee, durees personnalisees invalides (15 a 44 640 minutes)', () => {
    const late = at(2026, 10, 17, 23, 50);
    const r = F.visitorEnd({ now: late, choice: 'day' });
    assert.equal(r.ok, false);
    assert.match(r.problem, /moins de 15 minutes/);
    for (const bad of ['', '14', '44641', '1.5', '-30', 'abc', '1e2', '123456']) {
      assert.equal(F.visitorEnd({ now: NOW, choice: 'custom', customMinutes: bad }).ok, false, bad);
    }
    assert.equal(F.visitorEnd({ now: NOW, choice: 'custom', customMinutes: '15' }).ok, true);
    assert.equal(F.visitorEnd({ now: NOW, choice: 'custom', customMinutes: '44640' }).ok, true);
    assert.equal(F.visitorEnd({ now: NOW, choice: 'nimporte' }).ok, false);
  });

  it('la phrase de fin est ecrite en clair : « Le badge cessera de fonctionner a 17:30. »', () => {
    assert.equal(F.endSentence(at(2026, 10, 17, 17, 30), NOW), 'Le badge cessera de fonctionner à 17:30.');
    assert.equal(F.endSentence(at(2026, 10, 18, 3, 10), NOW), 'Le badge cessera de fonctionner demain à 03:10.');
    assert.equal(F.endSentence(at(2026, 10, 25, 8, 0), NOW), 'Le badge cessera de fonctionner le 25/10/2026 à 08:00.');
  });

  it('les cinq durees demandees sont proposees, dans cet ordre', () => {
    assert.deepEqual(
      F.VISITOR_DURATIONS.map((d: { label: string }) => d.label),
      ['1 heure', '2 heures', '4 heures', "Jusqu'à la fin de la journée", 'Personnalisée'],
    );
  });

  it('lignes de visite : temps restant, debut, fin ; badge et dernier passage', () => {
    const base = { holder: { badges: [{ number: '0099', state: 'active' }], visitor: { endedAt: null } }, endsAt: at(2026, 10, 17, 17, 30), startsAt: null };
    assert.deepEqual(F.visitTimeRow({ ...base, state: 'present' }, NOW), ['Temps restant', '3 h 25 (fin à 17:30)']);
    assert.deepEqual(F.visitTimeRow({ ...base, state: 'upcoming', startsAt: at(2026, 10, 18, 9, 0) }, NOW), ['Commence', 'demain à 09:00']);
    assert.equal(F.visitTimeRow({ ...base, holder: { ...base.holder, visitor: { endedAt: at(2026, 10, 17, 12, 10) } }, state: 'ended' }, NOW)[0], 'Terminée');
    assert.equal(F.visitorBadgeNumber({ badges: [{ number: 'A', state: 'returned' }, { number: 'B', state: 'active' }] }), 'B');
    assert.equal(F.visitorBadgeNumber({ badges: [{ number: 'A', state: 'returned' }] }), 'A');
    assert.equal(F.visitorBadgeNumber({ badges: [] }), '');
    assert.match(F.lastPassageText({ atDevice: at(2026, 10, 17, 9, 12), doorName: 'Entrée', resultLabel: 'Accepté' }, NOW), /^aujourd'hui à 09:12 · Entrée · Accepté$/);
    assert.equal(F.lastPassageText(null, NOW), 'Aucun passage pour l’instant');
  });

  it('corps de requete d\'un visiteur : champs verifies, duree en minutes', () => {
    const end = F.visitorEnd({ now: NOW, choice: '2h' });
    const ok = F.visitorBody({ lastName: ' DIABATE ', firstName: '', host: 'KONAN Yao', reason: 'Livraison', badge: 'V-014', groupId: '3' }, end);
    assert.deepEqual(ok.body, { lastName: 'DIABATE', firstName: '', host: 'KONAN Yao', reason: 'Livraison', badge: 'V-014', groupId: 3, durationMinutes: 120 });
    assert.equal(F.visitorBody({ lastName: '', host: 'x', badge: '1', groupId: '3' }, end).field, 'lastName');
    assert.equal(F.visitorBody({ lastName: 'A', host: '', badge: '1', groupId: '3' }, end).field, 'host');
    assert.equal(F.visitorBody({ lastName: 'A', host: 'x', badge: '', groupId: '3' }, end).field, 'badge');
    assert.equal(F.visitorBody({ lastName: 'A', host: 'x', badge: 'a b', groupId: '3' }, end).field, 'badge');
    assert.equal(F.visitorBody({ lastName: 'A', host: 'x', badge: '1', groupId: '' }, end).field, 'groupId');
    assert.equal(F.visitorBody({ lastName: 'A', host: 'x', badge: '1', groupId: '3' }, { ok: false, problem: 'non' }).field, 'duration');
  });
});

describe('ecran « Titulaires » : etats (toujours un mot et une icone), textes de confirmation', () => {
  it('etat de synchronisation d\'un titulaire : les cinq mots demandes, chacun avec son icone', () => {
    const words = { synced: 'Synchronisé', pending: 'En attente', failed: 'Échec', blocked: 'Suppression à confirmer', none: 'Aucune porte' };
    for (const [state, label] of Object.entries(words)) {
      const info = F.holderSyncInfo(state);
      assert.equal(info.label, label);
      assert.ok(info.icon && info.tone, state);
    }
    assert.equal(new Set(Object.keys(words).map((s) => F.holderSyncInfo(s).icon)).size, 5, 'cinq icones distinctes : jamais la couleur seule');
    assert.equal(F.holderSyncInfo('inconnu').label, 'État inconnu');
  });

  it('etat de synchronisation d\'un controleur : les cinq mots demandes', () => {
    const words = { ok: 'À jour', pending: 'En attente', failed: 'Échec', blocked: 'Suppressions à confirmer', disabled: 'Non activée' };
    for (const [state, label] of Object.entries(words)) assert.equal(F.controllerSyncInfo(state).label, label);
    assert.equal(new Set(Object.keys(words).map((s) => F.controllerSyncInfo(s).icon)).size, 5);
  });

  it('un etat en attente ou en echec dit quoi faire', () => {
    assert.match(F.holderSyncAdvice('pending'), /passerelle/);
    assert.match(F.holderSyncAdvice('failed'), /Synchronisation/);
    assert.match(F.holderSyncAdvice('blocked'), /administrateur/);
    assert.equal(F.holderSyncAdvice('none'), '');
  });

  it('statut d\'un titulaire : suspendu, expire, pas encore valide, actif', () => {
    assert.equal(F.holderStatusInfo({ status: 'suspended', phase: 'valid' }).label, 'Suspendu');
    assert.equal(F.holderStatusInfo({ status: 'active', phase: 'expired' }).label, 'Expiré');
    assert.equal(F.holderStatusInfo({ status: 'active', phase: 'upcoming' }).label, 'Pas encore valide');
    assert.equal(F.holderStatusInfo({ status: 'active', phase: 'valid' }).label, 'Actif');
    assert.deepEqual(['active', 'disabled', 'lost', 'returned'].map((s) => F.badgeInfo(s).label), ['Actif', 'Désactivé', 'Perdu', 'Rendu']);
  });

  it('compteurs d\'un controleur et elements non synchronises en une phrase', () => {
    assert.equal(F.syncCountsText({ synced: 12, pending: 0, failed: 0, blocked: 0 }), '12 à jour');
    assert.equal(F.syncCountsText({ synced: 12, pending: 2, failed: 1, blocked: 3 }), '12 à jour, 2 en attente, 1 en échec, 3 suppressions à confirmer');
    assert.equal(F.syncItemText({ kind: 'holder', ref: 'H12', op: 'delete', state: 'blocked', attempts: 0 }), 'Titulaire H12 : suppression à confirmer');
    assert.equal(F.syncItemText({ kind: 'schedule', ref: 'S3', op: 'upsert', state: 'failed', attempts: 6 }), 'Plage horaire S3 : envoi en échec (6 essais)');
    assert.equal(F.syncItemText({ kind: 'holidays', ref: 'holidays', op: 'upsert', state: 'pending', attempts: 1 }), 'Jours fériés : envoi en attente');
    assert.equal(F.lastAckText(null, Date.now()), 'Aucun accusé reçu pour l’instant');
  });

  it('« Désactiver le badge » dit ce qui va se passer, avec le nombre de controleurs de la fiche', () => {
    assert.equal(
      F.deactivateBadgeText({ number: '0012345', name: 'KONAN Yao', controllers: 2 }),
      'Le badge 0012345 de KONAN Yao sera retiré de 2 contrôleurs. Un passage avec ce badge sera refusé dans les secondes qui suivent.',
    );
    assert.match(F.deactivateBadgeText({ number: '1', name: 'A B', controllers: 1 }), /retiré de 1 contrôleur\. /);
    assert.match(F.deactivateBadgeText({ number: '1', name: 'A B', controllers: 0 }), /aucun contrôleur/);
    assert.equal(F.controllerCount([{ controllerId: 'A' }, { controllerId: 'B' }]), 2);
    assert.equal(F.controllerCount(undefined), 0);
    assert.deepEqual(F.BADGE_CHOICES.map((c: { value: string; label: string }) => [c.value, c.label]), [['disabled', 'Désactivé'], ['lost', 'Perdu']]);
    assert.match(F.BADGE_CHOICES[0].hint, /réactivé/);
    assert.match(F.BADGE_CHOICES[1].hint, /réservé/);
  });

  it('autres confirmations : rendre, reactiver, fin de visite, suppression, import', () => {
    assert.match(F.returnBadgeText({ number: '9', name: 'A B', controllers: 2 }), /retiré de 2 contrôleurs/);
    assert.match(F.reactivateBadgeText({ number: '9', name: 'A B', controllers: 1 }), /de nouveau envoyé à 1 contrôleur/);
    assert.match(F.endVisitText({ number: 'V1', name: 'DIABATE Awa' }), /se termine maintenant.*V1.*refusé/);
    assert.match(F.deleteHolderText({ name: 'KONAN Yao', controllers: 2 }), /KONAN Yao et ses badges seront supprimés.*2 contrôleurs.*annulée/);
    assert.match(F.removeBadgeText({ number: '5', name: 'A B', state: 'lost' }), /plus réservé/);
    assert.match(F.deleteGroupText({ name: 'Personnel', holders: 3 }), /3 titulaires/);
    assert.match(F.importConfirmText({ created: 2, updated: 1, errors: 3 }), /2 titulaires créés et 1 titulaire modifié.*3 lignes en erreur seront ignorées/);
  });
});

describe('ecran « Titulaires » : corps des requetes', () => {
  it('titulaire : nom obligatoire, matricule et badges verifies, dates vides = null (sans limite)', () => {
    const form = { lastName: ' KONAN ', firstName: 'Yao', externalRef: 'M0012', status: 'active', validFrom: '2026-10-12', validTo: '', groupIds: ['2', 3, 3], badges: '0012345, 0012346 0012345' };
    assert.equal(F.holderFormProblem(form, { creating: true }), null);
    const body = F.holderBody(form, { creating: true });
    assert.equal(body.lastName, 'KONAN');
    assert.equal(body.externalRef, 'M0012');
    assert.equal(body.validTo, null);
    assert.equal(F.dateToInput(body.validFrom), '2026-10-12');
    assert.deepEqual(body.groupIds, [2, 3]);
    assert.deepEqual(body.badges, ['0012345', '0012346']);
    assert.ok(!('badges' in F.holderBody(form, { creating: false })), 'les badges ne se changent pas par la modification');
    assert.equal(F.holderBody({ ...form, status: 'suspended' }).status, 'suspended');
    assert.equal(F.holderBody({ ...form, externalRef: ' ' }).externalRef, null);
    assert.match(F.holderFormProblem({ ...form, lastName: ' ' }), /nom de famille/);
    assert.match(F.holderFormProblem({ ...form, externalRef: 'M 12' }), /matricule/);
    assert.match(F.holderFormProblem({ ...form, validFrom: '2027-01-01', validTo: '2026-01-01' }), /avant la date de début/);
    assert.match(F.holderFormProblem({ ...form, badges: 'a b c d e' }, { creating: true }), /4 badges/);
    assert.match(F.holderFormProblem({ ...form, badges: 'bad!' }, { creating: true }), /n'est pas valable/);
  });

  it('numeros de badges : separateurs libres, sans doublon', () => {
    assert.deepEqual(F.parseBadgeNumbers('1, 2;3  4\n1'), ['1', '2', '3', '4']);
    assert.deepEqual(F.parseBadgeNumbers(''), []);
    assert.equal(F.badgeProblem('0012345'), null);
    assert.match(F.badgeProblem('a b'), /pas valable/);
  });

  it('plages horaires : texte, verification, corps (jours tries, 8 plages au plus)', () => {
    const w: Win = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
    assert.equal(F.windowText(w), 'Du lundi au vendredi, de 08:00 à 18:00');
    assert.equal(F.windowText({ days: [0, 1, 2, 3, 4, 5, 6], from: '12:00', to: '00:00' }), 'Tous les jours, de 12:00 à minuit');
    assert.equal(F.windowText({ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }), 'Du lundi au vendredi, de 19:00 à 07:00 le lendemain');
    assert.equal(F.windowText({ days: [6, 0], from: '09:00', to: '12:00' }), 'Samedi et dimanche, de 09:00 à 12:00');
    assert.equal(F.windowProblem({ days: [], from: '08:00', to: '18:00' }), 'Choisissez au moins un jour.');
    assert.match(F.windowProblem({ days: [1], from: '08:00', to: '08:00' }), /identiques/);
    assert.match(F.windowProblem({ days: [1], from: '', to: '08:00' }), /heure de début/);
    assert.equal(F.windowProblem(w), null);
    assert.match(F.scheduleProblem({ name: ' ', windows: [w] }), /nom/);
    assert.match(F.scheduleProblem({ name: 'A', windows: [] }), /au moins une plage/);
    assert.match(F.scheduleProblem({ name: 'A', windows: Array.from({ length: 9 }, () => w) }), /8 plages/);
    assert.match(F.scheduleProblem({ name: 'A', windows: [w, { days: [], from: '08:00', to: '09:00' }] }), /^Plage 2 : /);
    assert.equal(F.scheduleProblem({ name: 'A', windows: [w] }), null);
    assert.deepEqual(F.scheduleBody({ name: ' Bureau ', windows: [{ days: [5, 1, 1], from: '08:00', to: '18:00' }], closedOnHolidays: 1 }), { name: 'Bureau', windows: [{ days: [1, 5], from: '08:00', to: '18:00' }], closedOnHolidays: true });
    assert.equal(F.scheduleSummary({ builtin: true, windows: [] }), 'Tous les jours, à toute heure');
    assert.equal(F.scheduleSummary({ builtin: false, windows: [w, w] }), `${F.windowText(w)} ; ${F.windowText(w)}`);
    assert.equal(F.MAX_WINDOWS, 8);
  });

  it('groupes : corps { name, description, forVisitors, doors:[{doorId, scheduleId}] } et phrase des portes', () => {
    assert.deepEqual(F.groupBody({ name: ' Personnel ', description: '', forVisitors: false, doors: [{ doorId: 'P-ENTREE', scheduleId: '2' }] }), { name: 'Personnel', description: '', forVisitors: false, doors: [{ doorId: 'P-ENTREE', scheduleId: 2 }] });
    assert.match(F.groupProblem({ name: '', doors: [] }), /nom/);
    assert.match(F.groupProblem({ name: 'A', doors: [{ doorId: 'P', scheduleId: '' }] }), /plage horaire/);
    assert.equal(F.groupProblem({ name: 'A', doors: [] }), null);
    assert.equal(F.groupDoorsText({ doors: [] }), 'Aucune porte');
    assert.equal(F.groupDoorsText({ doors: [{ doorName: 'Entrée', scheduleName: 'Tout le temps' }, { doorName: null, scheduleName: 'Bureau' }] }), 'Entrée (Tout le temps), Porte retirée (Bureau)');
  });

  it('jours feries : verification (vide, impossible, doublon) et corps trie en un seul PUT', () => {
    assert.equal(F.holidaysProblem([{ date: '2026-12-25', label: 'Noël' }]), null);
    assert.match(F.holidaysProblem([{ date: '', label: '' }]), /vide ou impossible/);
    assert.match(F.holidaysProblem([{ date: '2026-02-30', label: '' }]), /vide ou impossible/);
    assert.match(F.holidaysProblem([{ date: '2026-12-25', label: '' }, { date: '2026-12-25', label: 'x' }]), /en double/);
    assert.deepEqual(F.holidaysBody([{ date: '2026-12-25', label: ' Noël ' }, { date: '2026-01-01', label: '' }]), { entries: [{ date: '2026-01-01', label: '' }, { date: '2026-12-25', label: 'Noël' }] });
    assert.equal(F.MAX_HOLIDAYS, 400);
  });
});

describe('ecran « Titulaires » : liste, photo et import', () => {
  it('requete de liste : personnel seulement, 50 par page, recherche et curseur encodes', () => {
    assert.equal(F.holdersQuery({ q: '', status: '', cursor: null }), 'kind=staff&limit=50');
    const p = new URLSearchParams(F.holdersQuery({ q: ' Konan Yao ', status: 'suspended', cursor: 'abc_1' }));
    assert.equal(p.get('q'), 'Konan Yao');
    assert.equal(p.get('status'), 'suspended');
    assert.equal(p.get('cursor'), 'abc_1');
    assert.equal(new URLSearchParams(F.holdersQuery({ q: '', status: 'nimporte' })).has('status'), false);
    assert.ok(!F.holdersQuery({ q: 'a&b=c#d' }).includes('&b='), 'le texte saisi est encode');
  });

  it('texte des badges actifs et comptage de la liste', () => {
    assert.equal(F.activeBadgesText({ badges: [{ number: '1', state: 'active' }, { number: '2', state: 'lost' }, { number: '3', state: 'active' }] }), '1, 3');
    assert.equal(F.activeBadgesText({ badges: [] }), 'Aucun badge actif');
    assert.equal(F.listCountText(0, 0), 'Aucun titulaire trouvé');
    assert.equal(F.listCountText(1, 1), '1 titulaire');
    assert.equal(F.listCountText(50, 120), '50 titulaires affichés sur 120');
  });

  it('photo : carre centre, 192 px, qualite 0,8 puis moins si le fichier est trop lourd', () => {
    assert.deepEqual(F.squareCrop(400, 300), { sx: 50, sy: 0, side: 300 });
    assert.deepEqual(F.squareCrop(300, 400), { sx: 0, sy: 50, side: 300 });
    assert.deepEqual(F.squareCrop(200, 200), { sx: 0, sy: 0, side: 200 });
    assert.equal(F.PHOTO_SIZE, 192);
    assert.equal(F.PHOTO_QUALITY, 0.8);
    assert.equal(F.PHOTO_QUALITIES[0], 0.8);
    assert.equal(F.PHOTO_MAX_BYTES, 64 * 1024);
  });

  it('le modele CSV est du texte local (BOM, « ; », CRLF) que l\'import du serveur accepte sans erreur', () => {
    const csv: string = F.templateCsv();
    assert.ok(csv.startsWith('﻿'), 'BOM pour Excel');
    assert.ok(csv.includes('\r\n') && !/[^\r]\n/.test(csv), 'fins de ligne Windows');
    const header = csv.slice(1).split('\r\n')[0];
    assert.equal(header, 'nom;prenom;matricule;badge1;badge2;badge3;badge4;groupe;debut;fin;statut');
    const parsed = parseHolderCsv(Buffer.from(csv, 'utf8'));
    assert.equal(parsed.fatal, null);
    assert.equal(parsed.encoding, 'utf-8');
    assert.equal(parsed.delimiter, ';');
    assert.equal(parsed.rows.length, 2);
    for (const row of parsed.rows) assert.deepEqual(row.errors, [], `ligne ${row.line}`);
    assert.equal(F.TEMPLATE_FILENAME, 'modele-import-titulaires.csv');
  });

  it('les colonnes expliquees sont celles que le serveur reconnait', () => {
    const names: string = F.IMPORT_COLUMNS.map((c: { name: string }) => c.name).join(' ');
    for (const col of ['nom', 'prenom', 'matricule', 'badge1', 'groupe', 'debut', 'statut']) assert.ok(names.includes(col), col);
    assert.equal(F.IMPORT_COLUMNS.filter((c: { required: boolean }) => c.required).length, 1, 'seul « nom » est obligatoire');
  });

  it('rapport d\'import : titre, encodage, separateur, lignes a regarder, meme fichier', () => {
    const dry = { dryRun: true, encoding: 'utf-8', delimiter: ';', lines: 12, created: 8, updated: 2, unchanged: 1, errors: 1, truncated: false, fatal: null, items: [{ line: 3, outcome: 'error', name: 'X', errors: ['Badge déjà pris'], warnings: [] }, { line: 4, outcome: 'created', name: 'Y', errors: [], warnings: [] }, { line: 5, outcome: 'created', name: 'Z', errors: [], warnings: ['Homonyme'] }] };
    assert.equal(F.importHeadline(dry), "Vérification terminée, rien n'a été modifié : 8 créés, 2 modifiés, 1 inchangé, 1 ligne en erreur.");
    assert.match(F.importHeadline({ ...dry, dryRun: false }), /^Import terminé : /);
    assert.equal(F.importHeadline({ ...dry, fatal: 'Le fichier est vide.' }), 'Le fichier ne peut pas être importé.');
    assert.deepEqual(F.reportRowsToShow(dry).map((r: { line: number }) => r.line), [3, 5]);
    assert.match(F.encodingText('windows-1252'), /Windows-1252.*accents/);
    assert.equal(F.encodingText('utf-8'), 'Fichier lu en UTF-8.');
    assert.equal(F.delimiterText('\t'), 'tabulation');
    assert.equal(F.delimiterText(';'), 'point-virgule');
    assert.equal(F.outcomeInfo('error').label, 'Ignorée');
    const a = { name: 'a.csv', size: 10, lastModified: 5 };
    assert.equal(F.fileKey(a), F.fileKey({ ...a }));
    assert.notEqual(F.fileKey(a), F.fileKey({ ...a, size: 11 }));
    assert.equal(F.fileKey(null), '');
  });

  it('cle de synchronisation : trois avertissements (une seule fois, a recopier, ancienne cle arretee)', () => {
    assert.equal(F.KEY_WARNINGS.length, 3);
    assert.match(F.KEY_WARNINGS[0], /plus jamais affichée/);
    assert.match(F.KEY_WARNINGS[1], /passerelle/);
    assert.match(F.KEY_WARNINGS[2], /ancienne clé cesse de fonctionner/);
  });

  it('phrases du serveur : majuscule et point final', () => {
    assert.equal(F.sentence('mot de passe incorrect'), 'Mot de passe incorrect.');
    assert.equal(F.sentence('Déjà fait !'), 'Déjà fait !');
    assert.equal(F.sentence(''), '');
  });
});
