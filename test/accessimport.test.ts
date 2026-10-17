/**
 * Import CSV des titulaires (docs/ACCES.md § 12.5) : analyse pure du fichier, puis application par un FAUX service en memoire
 * (qui applique les memes refus que le vrai : badge pris, matricule pris, groupe inconnu).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { PsimError } from '../server/errors.ts';
import { IMPORT_MAX_ITEMS, parseHolderCsv, runImport } from '../server/accessimport.ts';
import type { HolderInput, HoldersService, HolderView } from '../server/accessholderstypes.ts';

// ---- Faux service ------------------------------------------------------------------------------------------------------------

interface Rec {
  id: number;
  lastName: string;
  firstName: string;
  externalRef: string | null;
  kind: 'staff' | 'visitor';
  status: 'active' | 'suspended';
  validFrom: number | null;
  validTo: number | null;
  badges: { number: string; state: string }[];
  groupIds: number[];
}
interface State {
  next: number;
  holders: Rec[];
}

const GROUPS = [
  { id: 1, name: 'Atelier' },
  { id: 2, name: 'Bureaux' },
];
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

function fakeService() {
  let st: State = { next: 1, holders: [] };
  const calls: string[] = [];
  const view = (r: Rec): HolderView =>
    ({
      id: r.id,
      lastName: r.lastName,
      firstName: r.firstName,
      displayName: `${r.lastName} ${r.firstName}`.trim(),
      externalRef: r.externalRef,
      kind: r.kind,
      status: r.status,
      validFrom: r.validFrom,
      validTo: r.validTo,
      badges: r.badges.map((b) => ({ ...b })),
      groups: r.groupIds.map((g) => ({ id: g, name: GROUPS.find((x) => x.id === g)?.name ?? '?' })),
    }) as unknown as HolderView;
  const takenBadge = (n: string) => st.holders.find((h) => h.badges.some((b) => b.state !== 'returned' && b.number.toLowerCase() === n.toLowerCase()));
  const boom = (name: string): void => {
    if (name === 'BOOM') throw new Error('secret interne /etc/passwd');
    if (name === 'REFUS') throw new PsimError(422, 'Refus du service.');
  };
  const svc = {
    findByExternalRef: (ref: string) => {
      const r = st.holders.find((h) => h.externalRef?.toLowerCase() === ref.toLowerCase());
      return r ? view(r) : null;
    },
    findByBadge: (n: string) => {
      const r = takenBadge(n);
      return r ? view(r) : null;
    },
    findByName: (l: string, f: string) => st.holders.filter((h) => fold(h.lastName) === fold(l) && fold(h.firstName) === fold(f)).map(view),
    groupByName: (name: string) => GROUPS.find((g) => fold(g.name) === fold(name)) ?? null,
    get: (id: number) => view(st.holders.find((h) => h.id === id) as Rec),
    create: (_a: string, input: HolderInput, opts?: { quiet?: boolean }) => {
      assert.equal(opts?.quiet, true);
      calls.push('create');
      boom(String(input.lastName));
      if (input.externalRef && st.holders.some((h) => h.externalRef?.toLowerCase() === String(input.externalRef).toLowerCase())) {
        throw new PsimError(409, 'Matricule déjà utilisé.');
      }
      const badges = (input.badges as string[] | undefined) ?? [];
      for (const b of badges) if (takenBadge(b)) throw new PsimError(409, 'Badge déjà utilisé.');
      const r: Rec = {
        id: st.next++,
        lastName: String(input.lastName),
        firstName: String(input.firstName ?? ''),
        externalRef: (input.externalRef as string | undefined) ?? null,
        kind: 'staff',
        status: (input.status as 'active' | 'suspended') ?? 'active',
        validFrom: (input.validFrom as number | undefined) ?? null,
        validTo: (input.validTo as number | undefined) ?? null,
        badges: badges.map((number) => ({ number, state: 'active' })),
        groupIds: (input.groupIds as number[] | undefined) ?? [],
      };
      st.holders.push(r);
      return view(r);
    },
    update: (_a: string, id: number, input: HolderInput, opts?: { quiet?: boolean }) => {
      assert.equal(opts?.quiet, true);
      calls.push('update');
      const r = st.holders.find((h) => h.id === id) as Rec;
      boom(String(input.lastName ?? r.lastName));
      if (input.lastName !== undefined) r.lastName = String(input.lastName);
      if (input.firstName !== undefined) r.firstName = String(input.firstName);
      if (input.status !== undefined) r.status = input.status as Rec['status'];
      if (input.validFrom !== undefined) r.validFrom = input.validFrom as number;
      if (input.validTo !== undefined) r.validTo = input.validTo as number;
      if (input.groupIds !== undefined) r.groupIds = input.groupIds as number[];
      return view(r);
    },
    addBadge: (_a: string, id: number, number: unknown, opts?: { quiet?: boolean }) => {
      assert.equal(opts?.quiet, true);
      calls.push('addBadge');
      if (takenBadge(String(number))) throw new PsimError(409, 'Badge déjà utilisé.');
      (st.holders.find((h) => h.id === id) as Rec).badges.push({ number: String(number), state: 'active' });
      return {} as never;
    },
    batch: <T>(fn: () => T): T => fn(),
    simulate: <T>(fn: () => T): T => {
      const saved = structuredClone(st);
      try {
        return fn();
      } finally {
        st = saved;
      }
    },
  };
  return {
    svc: svc as unknown as HoldersService,
    calls,
    all: () => st.holders,
    seed: (r: Partial<Rec> & { lastName: string }) => {
      st.holders.push({ id: st.next++, firstName: '', externalRef: null, kind: 'staff', status: 'active', validFrom: null, validTo: null, badges: [], groupIds: [], ...r });
    },
  };
}

const csv = (s: string): Buffer => Buffer.from(s, 'utf8');
let fake: ReturnType<typeof fakeService>;
let audits: { actor: string; action: string; details?: string }[];
const run = (s: string | Buffer, dryRun = false) =>
  runImport(typeof s === 'string' ? csv(s) : s, {
    holders: fake.svc,
    actor: 'admin',
    dryRun,
    audit: (actor, action, ref) => audits.push({ actor, action, details: ref?.details }),
  });

beforeEach(() => {
  fake = fakeService();
  audits = [];
});

// ---- Analyse du fichier ------------------------------------------------------------------------------------------------------

describe('parseHolderCsv : format', () => {
  it('detecte ; , et tabulation', () => {
    for (const [d, sep] of [
      [';', ';'],
      [',', ','],
      ['\t', '\t'],
    ] as const) {
      const p = parseHolderCsv(csv(['nom', 'prenom', 'matricule'].join(sep) + '\nKONAN' + sep + 'Yao' + sep + 'M1\n'));
      assert.equal(p.fatal, null);
      assert.equal(p.delimiter, d);
      assert.equal(p.rows[0]?.fields?.externalRef, 'M1');
      assert.equal(p.rows[0]?.fields?.firstName, 'Yao');
    }
  });

  it('retire le BOM UTF-8 et dit utf-8', () => {
    const p = parseHolderCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv('nom;prenom\nKONAN;Yao\n')]));
    assert.equal(p.fatal, null);
    assert.equal(p.encoding, 'utf-8');
    assert.equal(p.rows.length, 1);
  });

  it('lit du Windows-1252 quand ce nest pas de l UTF-8 valide', () => {
    const bytes = Buffer.concat([csv('nom;prenom\nTRAOR'), Buffer.from([0xc9]), csv(';Zo'), Buffer.from([0xe9]), csv('\n')]);
    const p = parseHolderCsv(bytes);
    assert.equal(p.encoding, 'windows-1252');
    assert.equal(p.rows[0]?.fields?.lastName, 'TRAORÉ');
    assert.equal(p.rows[0]?.fields?.firstName, 'Zoé');
  });

  it('gere guillemets, guillemets doubles et retours a la ligne dans un champ, CRLF ou LF', () => {
    const p = parseHolderCsv(csv('nom;prenom;fonction\r\n"DIA;LLO";"Jean ""JJ""";"ligne1\nligne2"\r\nKONAN;Yao;x\r\n'));
    assert.equal(p.fatal, null);
    assert.equal(p.rows.length, 2);
    assert.equal(p.rows[0]?.fields?.lastName, 'DIA;LLO');
    assert.equal(p.rows[0]?.fields?.firstName, 'Jean "JJ"');
    // La colonne inconnue « fonction » n'est pas controlee ; la ligne suivante garde son vrai numero (3 lignes physiques + en-tete).
    assert.equal(p.rows[1]?.line, 4);
    assert.match(p.warnings.join(' '), /fonction/);
  });

  it('reconnait les en-tetes avec accents, majuscules et alias badge', () => {
    const p = parseHolderCsv(csv('NOM;Prénom;Matricule;Badge;GROUPE;Début;Fin;Statut\nA;B;M1;123;Atelier;2026-01-01;2026-12-31;Actif\n'));
    assert.equal(p.fatal, null);
    const f = p.rows[0]?.fields;
    assert.deepEqual(f?.badges, ['123']);
    assert.deepEqual(f?.groups, ['Atelier']);
    assert.equal(f?.status, 'active');
    assert.equal(new Date(f?.validFrom as number).getHours(), 0);
    const to = new Date(f?.validTo as number);
    assert.deepEqual([to.getHours(), to.getMinutes(), to.getSeconds()], [23, 59, 59]);
  });

  it('refuse sans colonne nom, avec colonne en double, vide, binaire, trop grand', () => {
    assert.match(parseHolderCsv(csv('prenom;badge\nA;1\n')).fatal ?? '', /nom/);
    assert.match(parseHolderCsv(csv('nom;Nom\nA;B\n')).fatal ?? '', /double/);
    assert.match(parseHolderCsv(csv('nom;badge;badge1\nA;1;2\n')).fatal ?? '', /double/);
    assert.ok(parseHolderCsv(Buffer.alloc(0)).fatal);
    assert.ok(parseHolderCsv(Buffer.from([0x6e, 0x6f, 0x00, 0x6d])).fatal);
    assert.ok(parseHolderCsv(Buffer.alloc(1024 * 1024 + 1, 97)).fatal);
    assert.match(parseHolderCsv(csv('nom;"abc\nA')).fatal ?? '', /uillemet/);
  });

  it('ignore les lignes vides et reste sans donnee si seul l en-tete est present', () => {
    const p = parseHolderCsv(csv('nom;prenom\n\n;\nA;B\n\n'));
    assert.equal(p.rows.length, 1);
    assert.equal(parseHolderCsv(csv('nom;prenom\n')).rows.length, 0);
  });
});

describe('parseHolderCsv : controles des cellules', () => {
  const first = (body: string) => parseHolderCsv(csv('nom;prenom;matricule;badge1;badge2;debut;fin;statut\n' + body + '\n')).rows[0];

  it('refuse les injections de formule', () => {
    for (const bad of ['=1+1', '+33123', '-x', '@a', '\tx', '"\rx"']) {
      const r = first(`${bad.startsWith('"') ? bad : bad};P;;;;;;`);
      assert.ok(r?.errors.some((e) => /formule/.test(e)), bad);
      assert.equal(r?.fields, null);
    }
  });

  it('refuse < > et caracteres de controle', () => {
    assert.ok(first('<script>alert(1)</script>;P;;;;;;')?.errors.some((e) => /« < »/.test(e)));
    assert.ok(first('"A\nB";P;;;;;;')?.errors.some((e) => /contrôle/.test(e)));
    assert.equal(first('<script>;P;;;;;;')?.name, null);
  });

  it('valide les dates', () => {
    assert.ok(first('A;P;;;;2026-02-30;;')?.errors.some((e) => /date invalide/.test(e)));
    assert.ok(first('A;P;;;;31/04/2026;;')?.errors.some((e) => /date invalide/.test(e)));
    assert.ok(first('A;P;;;;26-01-01;;')?.errors.some((e) => /date invalide/.test(e)));
    assert.ok(first('A;P;;;;2026-03-10;2026-03-09;')?.errors.some((e) => /précède/.test(e)));
    assert.equal(first('A;P;;;;2026-03-10;10/03/2026;')?.errors.length, 0);
    assert.equal(first('A;P;;;;29/02/2028;;')?.errors.length, 0);
  });

  it('valide statut, badges, matricule, longueurs', () => {
    assert.ok(first('A;P;;;;;;bloque')?.errors.some((e) => /statut/.test(e)));
    assert.equal(first('A;P;;;;;;SUSPENDU')?.fields?.status, 'suspended');
    assert.ok(first('A;P;;12 34;;;;')?.errors.some((e) => /badge/.test(e)));
    assert.ok(first('A;P;;1;1;;;')?.errors.some((e) => /répété/.test(e)));
    assert.ok(first('A;P;M 1;;;;;')?.errors.some((e) => /matricule/.test(e)));
    assert.ok(first(`${'x'.repeat(41)};P;;;;;;`)?.errors.some((e) => /40/.test(e)));
    assert.ok(first(`${'x'.repeat(501)};P;;;;;;`)?.errors.some((e) => /500/.test(e)));
    assert.ok(first(';P;;;;;;')?.errors.some((e) => /obligatoire/.test(e)));
  });

  it('refuse les doublons de matricule et de badge entre lignes, avec le numero de la premiere', () => {
    const p = parseHolderCsv(csv('nom;matricule;badge1\nA;M1;100\nB;m1;200\nC;M3;100\nD;M4;300\n'));
    assert.ok(p.rows[1]?.errors.some((e) => /ligne 2/.test(e)));
    assert.ok(p.rows[2]?.errors.some((e) => /Badge 100.*ligne 2/.test(e)));
    assert.equal(p.rows[3]?.errors.length, 0);
  });

  it('plafonds : 5000 lignes, 20 colonnes', () => {
    const ok = 'nom\n' + Array.from({ length: 5000 }, (_, i) => `N${i}`).join('\n');
    assert.equal(parseHolderCsv(csv(ok)).fatal, null);
    assert.equal(parseHolderCsv(csv(ok + '\nPlus')).rows.length, 0);
    assert.match(parseHolderCsv(csv(ok + '\nPlus')).fatal ?? '', /5000/);
    const cols = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(';');
    assert.match(parseHolderCsv(csv('nom;' + cols(20) + '\nA\n')).fatal ?? '', /colonnes/);
    const wide = parseHolderCsv(csv('nom\nA;' + Array(25).fill('x').join(';') + '\n'));
    assert.ok(wide.rows[0]?.errors.length);
  });
});

// ---- Application --------------------------------------------------------------------------------------------------------------

describe('runImport', () => {
  it('cree, met a jour par matricule, signale linchange', () => {
    let r = run('nom;prenom;matricule;badge1;groupe;statut\nKONAN;Yao;M1;100;Atelier|Bureaux;actif\n');
    assert.deepEqual([r.created, r.updated, r.unchanged, r.errors, r.lines], [1, 0, 0, 0, 1]);
    assert.deepEqual(fake.all()[0]?.groupIds, [1, 2]);
    r = run('nom;prenom;matricule;badge1;groupe;statut\nKONAN;Yao;M1;100;Atelier|Bureaux;actif\n');
    assert.deepEqual([r.created, r.updated, r.unchanged], [0, 0, 1]);
    r = run('nom;prenom;matricule;badge1;badge2;statut\nKONAN;;M1;100;200;suspendu\n');
    assert.deepEqual([r.updated, r.unchanged], [1, 0]);
    const h = fake.all()[0];
    assert.equal(h?.status, 'suspended');
    assert.equal(h?.firstName, 'Yao'); // prenom vide : inchange
    assert.deepEqual(h?.badges.map((b) => b.number), ['100', '200']);
    assert.deepEqual(h?.groupIds, [1, 2]); // pas de colonne groupe utile : inchange
  });

  it('les groupes listes remplacent ceux du titulaire, colonne vide : inchange', () => {
    fake.seed({ lastName: 'KONAN', firstName: 'Yao', externalRef: 'M1', groupIds: [1, 2] });
    run('nom;prenom;matricule;groupe\nKONAN;Yao;M1;Bureaux\n');
    assert.deepEqual(fake.all()[0]?.groupIds, [2]);
    run('nom;prenom;matricule;groupe\nKONAN;Yao;M1;\n');
    assert.deepEqual(fake.all()[0]?.groupIds, [2]);
  });

  it('sans matricule : retrouve par badge (meme nom), cree sinon, homonyme signale', () => {
    fake.seed({ lastName: 'KONAN', firstName: 'Yao', badges: [{ number: '100', state: 'active' }] });
    let r = run('nom;prenom;badge1;badge2\nkonan;YAO;100;101\n');
    assert.deepEqual([r.updated, r.created], [1, 0]);
    assert.equal(fake.all().length, 1);
    assert.deepEqual(fake.all()[0]?.badges.map((b) => b.number), ['100', '101']);
    r = run('nom;prenom;badge1\nKONAN;Yao;900\n');
    assert.equal(r.created, 1);
    assert.match(r.items[0]?.warnings.join(' ') ?? '', /Homonyme/);
    assert.equal(fake.all().length, 2);
    r = run('nom;prenom\nNEUF;Marie\n');
    assert.deepEqual(r.items[0]?.warnings, []);
  });

  it('refuse un badge porte par quelquun d autre, un groupe inconnu, un visiteur', () => {
    fake.seed({ lastName: 'DIALLO', firstName: 'Awa', externalRef: 'M9', badges: [{ number: '100', state: 'active' }] });
    fake.seed({ lastName: 'VISIT', kind: 'visitor', externalRef: 'V1', badges: [{ number: '777', state: 'active' }] });
    const r = run(
      'nom;prenom;matricule;badge1;groupe\nKONAN;Yao;M1;100;\nKONAN;Yao;M2;;Atelier|Nord|Sud\nVISIT;;V1;;\nVISIT;;;777;\nOK;Ok;M3;;\n',
    );
    assert.deepEqual([r.created, r.errors], [1, 4]);
    const byLine = new Map(r.items.map((i) => [i.line, i]));
    assert.match(byLine.get(2)?.errors.join(' ') ?? '', /déjà porté.*DIALLO/);
    assert.match(byLine.get(3)?.errors.join(' ') ?? '', /Nord, Sud/);
    assert.match(byLine.get(4)?.errors.join(' ') ?? '', /visiteurs/);
    assert.match(byLine.get(5)?.errors.join(' ') ?? '', /visiteurs/);
    assert.equal(fake.all().length, 3);
  });

  it('dryRun ne modifie rien, ne journalise pas, mais rapporte comme pour de vrai', () => {
    fake.seed({ lastName: 'KONAN', firstName: 'Yao', externalRef: 'M1' });
    const r = run('nom;prenom;matricule;badge1\nKONAN;Yao;M1;100\nNEUF;Marie;M2;200\n', true);
    assert.equal(r.dryRun, true);
    assert.deepEqual([r.created, r.updated], [1, 1]);
    assert.equal(fake.all().length, 1);
    assert.deepEqual(fake.all()[0]?.badges, []);
    assert.equal(audits.length, 0);
  });

  it('une erreur de service reste isolee ; message brut jamais expose', () => {
    const r = run('nom;prenom\nA;1\nBOOM;x\nREFUS;x\nB;2\n');
    assert.deepEqual([r.created, r.errors, r.lines], [2, 2, 4]);
    const boom = r.items.find((i) => i.line === 3);
    assert.ok(boom?.errors[0]?.includes('Erreur interne'));
    assert.ok(!JSON.stringify(r).includes('passwd'));
    assert.equal(r.items.find((i) => i.line === 4)?.errors[0], 'Refus du service.');
  });

  it('badge deja pris cote service devient une erreur de ligne (course)', () => {
    fake.seed({ lastName: 'KONAN', firstName: 'Yao', externalRef: 'M1' });
    // Deux lignes valides du point de vue du fichier ; la seconde conflit avec un ancien titulaire sans matricule.
    fake.seed({ lastName: 'AUTRE', badges: [{ number: '55', state: 'active' }] });
    const r = run('nom;prenom;matricule;badge1\nKONAN;Yao;M1;55\n');
    assert.equal(r.errors, 1);
  });

  it('une seule entree de journal, sans donnee nominative', () => {
    const r = run('nom;prenom;matricule;badge1\nKONAN;Yao;M1;100\nKONAN;Yao;M1;100\nBAD;<x>;;\nB;C;M2;200\n');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'access_import');
    assert.equal(audits[0]?.details, `${r.created} créé(s), ${r.updated} modifié(s), ${r.unchanged} inchangé(s), ${r.errors} en erreur`);
    assert.ok(!/KONAN|Yao|100/.test(audits[0]?.details ?? ''));
  });

  it('rapport coherent : ordre erreurs > remarques > autres, warnings de colonne sur la premiere ligne', () => {
    fake.seed({ lastName: 'DUPONT', firstName: 'Jean' });
    const r = run('nom;prenom;inconnue\nA;a;x\nDUPONT;Jean;x\n=bad;b;x\n');
    assert.equal(r.created + r.updated + r.unchanged + r.errors, r.lines);
    assert.deepEqual(r.items.map((i) => i.line), [4, 2, 3]);
    assert.ok(r.items.find((i) => i.line === 2)?.warnings.some((w) => /inconnue/.test(w)));
  });

  it('fichier inutilisable : fatal, rien d applique, pas de journal', () => {
    const r = run('prenom\nA\n');
    assert.ok(r.fatal);
    assert.deepEqual([r.lines, r.created, r.items.length], [0, 0, 0]);
    assert.equal(audits.length, 0);
  });

  it('echec de la transaction : fatal sans details internes', () => {
    const svc = { ...fake.svc, batch: () => { throw new Error('disque plein /var/db'); } } as unknown as HoldersService;
    const r = runImport(csv('nom\nA\n'), { holders: svc, actor: 'a', dryRun: false, audit: () => assert.fail('pas de journal') });
    assert.ok(r.fatal && !r.fatal.includes('/var/db'));
  });

  it('un journal qui leve ne casse pas le rapport', () => {
    const r = runImport(csv('nom\nA\n'), { holders: fake.svc, actor: 'a', dryRun: false, audit: () => { throw new Error('x'); } });
    assert.equal(r.created, 1);
  });
});

describe('runImport : entrees hostiles et volumes', () => {
  it('5 000 lignes sans blocage, rapport tronque a 2 000 entrees mais comptes complets', () => {
    const lines = ['nom;prenom;matricule'];
    for (let i = 0; i < 5000; i++) lines.push(`N${i};P${i};M${i}`);
    const t = Date.now();
    const r = run(lines.join('\n'));
    assert.ok(Date.now() - t < 10_000, "trop lent"); // le faux service fait des recherches lineaires : la borne ne mesure que l absence de blocage
    assert.equal(r.created, 5000);
    assert.equal(r.lines, 5000);
    assert.equal(r.items.length, IMPORT_MAX_ITEMS);
    assert.equal(r.truncated, true);
  });

  it('les erreurs passent en tete meme quand le rapport est tronque', () => {
    const lines = ['nom;matricule'];
    for (let i = 0; i < 2500; i++) lines.push(`N${i};M${i}`);
    lines.push('=boum;M-x');
    const r = run(lines.join('\n'));
    assert.equal(r.items[0]?.outcome, 'error');
    assert.equal(r.items[0]?.line, 2502);
    assert.equal(r.errors, 1);
  });

  it('1 Mo de guillemets non fermes, de separateurs, de lignes vides, de cellule enorme : rapide, sans exception', () => {
    const MB = 1024 * 1024;
    const cases: Buffer[] = [
      Buffer.alloc(MB, 0x22),
      Buffer.from('nom;' + ';'.repeat(MB - 10) + '\n'),
      Buffer.from('nom\n' + '\n'.repeat(MB - 10)),
      Buffer.from('nom\n' + 'a'.repeat(MB - 10)),
      Buffer.from('nom\n"' + '""'.repeat(MB / 2 - 10)),
      Buffer.from('nom\r\n' + 'a;'.repeat(MB / 2 - 10)),
      Buffer.alloc(MB, 0xff),
      Buffer.from([0x00, 0x01, 0x02]),
    ];
    for (const b of cases) {
      const t = Date.now();
      const r = run(b);
      assert.ok(Date.now() - t < 2000, 'trop lent');
      assert.ok(r && typeof r.lines === 'number');
    }
    const huge = run('nom\n' + 'a'.repeat(900_000) + '\nOK\n');
    assert.deepEqual([huge.errors, huge.created], [1, 1]);
    assert.match(huge.items[0]?.errors.join(' ') ?? '', /500/);
  });

  it('UTF-8 invalide : repli Windows-1252 avec avertissement dans le champ encoding', () => {
    const r = run(Buffer.concat([csv('nom\nCAF'), Buffer.from([0xc9, 0xff]), csv('\n')]));
    assert.equal(r.encoding, 'windows-1252');
  });
});
