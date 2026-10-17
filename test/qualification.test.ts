import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { writeFileAtomic } from '../qualification/atomic.ts';
import { runBench } from '../qualification/bench.ts';
import { runCli } from '../qualification/cli.ts';
import { QUALIF_DIR, loadFiches, renderFicheDoc, renderHtml, renderMarkdown, stepsFor, validateFichesData, getFiche } from '../qualification/fiches.ts';
import type { Fiche } from '../qualification/fiches.ts';
import {
  FAMILIES, LEGACY_QUALIFIED, RegistryError, checkPackModels, isQualified, loadRegistry, qualificationStatus, registryPath, resolveModel, saveRegistry, validateRegistry,
} from '../qualification/registry.ts';
import type { Registry } from '../qualification/registry.ts';
import { PromotionRefused, auditRegistry, contextFor, evaluatePromotion, promote, recordResult, setStatus } from '../qualification/results.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = new Date('2026-10-11T10:00:00Z');
const cleanup: string[] = [];
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Copie de travail de qualification/ (registre + fiches) : les essais ne touchent jamais au vrai registre. */
function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), 'psim-qualif-'));
  cleanup.push(root);
  const dir = join(root, 'qualification');
  mkdirSync(join(dir, 'results'), { recursive: true });
  cpSync(join(QUALIF_DIR, 'registry.json'), join(dir, 'registry.json'));
  cpSync(join(QUALIF_DIR, 'fiches.json'), join(dir, 'fiches.json'));
  return dir;
}
const readReg = (dir: string): Registry => JSON.parse(readFileSync(registryPath(dir), 'utf8')) as Registry;
const rawReg = (dir: string): string => readFileSync(registryPath(dir), 'utf8');

/** Saisie complete d'un essai reussi : toutes les etapes a pass, mesures pile dans leurs limites. */
function passingInput(id: string, dir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const { entry, steps } = contextFor(loadRegistry(dir), id, dir);
  const stepsObj: Record<string, unknown> = {};
  const measures: Record<string, number> = {};
  for (const s of steps) {
    stepsObj[s.id] = { result: 'pass', note: '' };
    for (const m of s.mesures) measures[m.cle] = m.min !== undefined ? m.min : (m.max as number) / 2;
  }
  return {
    date: '2026-10-11',
    tester: 'Awa Traore',
    serial_numbers: ['SN-0001'],
    firmware: '1.2.3',
    tested_version: { psim: '0.1.0', gateway: entry.connection.type === 'gateway' ? '0.1.0' : null },
    conditions: { real_hardware: true, description: 'Atelier, banc complet, equipement reel', temperature_c: 31, humidity_pct: 70 },
    steps: stepsObj,
    measures,
    notes: '',
    ...over,
  };
}
const withStep = (input: Record<string, unknown>, step: string, value: unknown) => ({ ...input, steps: { ...(input.steps as object), [step]: value } });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) } };
}

const SMOKE = 'heiman-hs1sa-e'; // detecteur de fumee Zigbee : passerelle, profil fumee
const CAMERA = 'generic-onvif-camera-fixe'; // raccordement existant, sans passerelle

describe('registre : structure et regles de validation', () => {
  it('le registre fourni est valide et couvre toutes les familles du catalogue', () => {
    const reg = loadRegistry();
    for (const f of FAMILIES) assert.ok(reg.entries.some((e) => e.family === f), `famille sans entree : ${f}`);
    assert.ok(reg.entries.length >= 60);
    assert.deepEqual(validateRegistry(reg), []);
  });

  it('contient les modeles cites dans les packs et les profils de capteurs LoRa, Zigbee et Tuya', () => {
    const ids = new Set(loadRegistry().entries.map((e) => e.id));
    for (const id of [
      'dahua-hac-hfw1500th-i8', 'dahua-xvr5104hs-i3', 'heiman-hs1sa-e', 'tuya-smoke-wifi', 'dahua-xvr5108hs-i3t-voie',
      'dragino-lht65', 'milesight-th', 'milesight-ws301', 'dragino-lds03a', 'dragino-lwl03a', 'dragino-ldds75', 'milesight-ws202', 'milesight-ws101', 'generic-lora-bouton-sos',
      'aqara-mccgq11lm', 'sonoff-snzb-04', 'tuya-zigbee-ts0203', 'heiman-hs1ds', 'tuya-contact-wifi', 'tuya-pir-wifi', 'tuya-gaz-wifi', 'tuya-sos-wifi',
      'generic-onvif-camera-fixe', 'generic-onvif-camera-ptz', 'generic-onvif-camera-panoramique', 'generic-camera-solaire-4g', 'generic-camera-thermique',
      'generic-mini-pc-psim', 'generic-routeur-4g', 'generic-switch-poe', 'generic-parafoudre', 'generic-sirene', 'generic-ronde-nfc', 'generic-suivi-vehicule',
    ]) assert.ok(ids.has(id), `entree manquante : ${id}`);
    // Chaque famille du catalogue de l'entreprise a une entree generique (socle, video, intrusion, incendie/gaz, acces...).
    for (const f of FAMILIES) assert.ok(loadRegistry().entries.some((e) => e.family === f && (e.kind === 'generic' || e.id.startsWith('generic-'))), `pas d'entree generique pour ${f}`);
  });

  const base = (): Registry => JSON.parse(JSON.stringify(loadRegistry())) as Registry;
  const mutate = (fn: (r: Registry) => void): string[] => {
    const r = base();
    fn(r);
    return validateRegistry(r);
  };

  it('refuse doublons, statuts inconnus, champs inconnus ou manquants', () => {
    assert.match(mutate((r) => void (r.entries[1].id = r.entries[0].id)).join('\n'), /doublon/);
    assert.match(mutate((r) => void ((r.entries[0] as unknown as Record<string, unknown>).status = 'ok')).join('\n'), /status.*valeur attendue/);
    assert.match(mutate((r) => void ((r.entries[0] as unknown as Record<string, unknown>).couleur = 'rouge')).join('\n'), /champ inconnu/);
    assert.match(mutate((r) => void delete (r.entries[0] as unknown as Record<string, unknown>).scope).join('\n'), /scope/);
    assert.match(mutate((r) => void (r.entries[0].family = 'cuisine' as never)).join('\n'), /family/);
    assert.match(mutate((r) => void (r.entries[0].id = 'Pas Valide!')).join('\n'), /identifiant invalide/);
    assert.match(mutate((r) => void (r.entries[0].fiche = 'inexistante')).join('\n'), /fiche de recette inconnue/);
    assert.match(mutate((r) => void (r.entries[0].profile = 'nimporte')).join('\n'), /profil/);
    assert.match(mutate((r) => void (r.entries.find((e) => e.id === SMOKE)!.connection.module = null)).join('\n'), /module/);
    assert.match(mutate((r) => void (r.entries.find((e) => e.id === CAMERA)!.connection.module = 'zigbee')).join('\n'), /module/);
  });

  it('refuse deux modeles qui se resolvent par le meme nom (alias en collision)', () => {
    assert.match(mutate((r) => r.entries[2].aliases.push(r.entries[3].id)).join('\n'), /designe deja/);
  });

  it('un modele « qualified » exige un essai sur materiel reel, un fichier de resultat et ne peut pas etre simule', () => {
    const qualify = (r: Registry, id: string) => {
      const e = r.entries.find((x) => x.id === id)!;
      e.status = 'qualified';
      e.history = [{ at: '2026-10-11T10:00:00Z', by: 'x', from: null, to: 'qualified', reason: 'x', result_file: null }];
      return e;
    };
    // sans aucun essai
    assert.match(mutate((r) => void qualify(r, SMOKE)).join('\n'), /exige un dernier essai/);
    // essai SIMULE : jamais qualifiable
    assert.match(
      mutate((r) => {
        qualify(r, SMOKE).last_trial = { date: '2026-10-11', reference: 'banc', psim_version: '0.1.0', gateway_version: '0.1.0', real_hardware: false, conditions: 'simule', serial_numbers: ['x'], firmware: '1', result_file: 'qualification/results/x.json', result_sha256: 'a'.repeat(64), legacy: false };
      }).join('\n'),
      /materiel reel/,
    );
    // materiel reel mais sans fichier de resultat et hors constats historiques
    assert.match(
      mutate((r) => {
        qualify(r, SMOKE).last_trial = { date: '2026-10-11', reference: 'oral', psim_version: '0.1.0', gateway_version: '0.1.0', real_hardware: true, conditions: 'dit', serial_numbers: ['x'], firmware: '1', result_file: null, result_sha256: null, legacy: false };
      }).join('\n'),
      /fichier de resultat/,
    );
    // constat historique : reserve aux deux identifiants figes dans le code
    assert.match(
      mutate((r) => {
        qualify(r, SMOKE).last_trial = { date: '2026-10-11', reference: 'avant', psim_version: '0.1.0', gateway_version: null, real_hardware: true, conditions: 'dit', serial_numbers: [], firmware: null, result_file: null, result_sha256: null, legacy: true };
      }).join('\n'),
      /constat historique non autorise/,
    );
  });

  it("l'historique doit enchainer les statuts et justifier le statut courant", () => {
    assert.match(mutate((r) => void (r.entries[0].status = 'rejected')).join('\n'), /historique/);
    assert.match(
      mutate((r) => {
        const e = r.entries.find((x) => x.id === SMOKE)!;
        e.status = 'rejected';
        e.notes = 'trop de fausses alarmes';
        e.history = [{ at: '2026-10-11T10:00:00Z', by: 'x', from: 'qualified', to: 'rejected', reason: 'x', result_file: null }];
      }).join('\n'),
      /doit etre « null »/,
    );
  });
});

describe('etat initial HONNETE du registre', () => {
  it('seuls la voie Dahua et le detecteur de fumee Tuya sont qualified, sur constat historique materiel', () => {
    const qualified = loadRegistry().entries.filter((e) => e.status === 'qualified').map((e) => e.id).sort();
    assert.deepEqual(qualified, ['dahua-xvr5108hs-i3t-voie', 'tuya-smoke-wifi']);
    assert.deepEqual([...LEGACY_QUALIFIED].sort(), qualified);
    for (const e of loadRegistry().entries.filter((x) => x.status === 'qualified')) {
      assert.equal(e.last_trial?.real_hardware, true, `${e.id} : essai materiel`);
      assert.equal(e.last_trial?.legacy, true);
    }
  });

  it("tout le reste est « to_qualify » sans essai materiel : aucune qualification sans resultat materiel", () => {
    for (const e of loadRegistry().entries.filter((x) => !LEGACY_QUALIFIED.includes(x.id))) {
      assert.equal(e.status, 'to_qualify', `${e.id} ne peut etre qualifie sans resultat materiel`);
      assert.equal(e.last_trial, null, `${e.id} : aucun essai materiel ne figure au registre`);
    }
  });

  it('les modeles des packs ne sont pas qualifies : le XVR5104 et la HAC-HFW1500TH-I8 restent a essayer', () => {
    assert.equal(isQualified('dahua-xvr5104hs-i3'), false);
    assert.equal(isQualified('dahua-hac-hfw1500th-i8'), false);
    assert.equal(isQualified('heiman-hs1sa-e'), false);
    assert.equal(isQualified('tuya-smoke-wifi'), true);
    assert.equal(isQualified('dahua-xvr5108hs-i3t-voie'), true);
  });

  it('la portee des deux qualifications est precise et dit ce qui n\'est pas couvert', () => {
    const dahua = loadRegistry().entries.find((e) => e.id === 'dahua-xvr5108hs-i3t-voie')!;
    assert.match(dahua.scope, /UNE voie/);
    assert.ok(dahua.not_covered.length > 20);
    const tuya = loadRegistry().entries.find((e) => e.id === 'tuya-smoke-wifi')!;
    assert.match(tuya.not_covered, /bouton TEST/);
  });

  it("l'audit du registre sur disque est propre (fichiers de resultat, tests simules cites)", () => {
    assert.deepEqual(auditRegistry(QUALIF_DIR, ROOT), []);
  });
});

describe('API isQualified / resolveModel / checkPackModels', () => {
  it('retrouve un modele par identifiant, alias, ou fabricant + alias', () => {
    assert.equal(resolveModel('Dahua HAC-HFW1500TH-I8')?.id, 'dahua-hac-hfw1500th-i8');
    assert.equal(resolveModel('hac hfw1500th i8')?.id, 'dahua-hac-hfw1500th-i8');
    assert.equal(resolveModel('DH-XVR5104HS-I3')?.id, 'dahua-xvr5104hs-i3');
    assert.equal(resolveModel('Heiman HS1SA-E')?.id, 'heiman-hs1sa-e');
    assert.equal(resolveModel('Marque inconnue X1'), null);
    assert.equal(qualificationStatus('nimporte-quoi'), 'unknown');
    assert.equal(isQualified('nimporte-quoi'), false);
  });

  it('echoue ferme si le registre est illisible ou invalide (jamais « qualifie » par defaut)', () => {
    const dir = workdir();
    writeFileSync(registryPath(dir), '{ pas du json');
    assert.throws(() => isQualified('tuya-smoke-wifi', dir), RegistryError);
    writeFileSync(registryPath(dir), JSON.stringify({ schema: 1, entries: [{ id: 'tuya-smoke-wifi', status: 'qualified' }] }));
    assert.throws(() => isQualified('tuya-smoke-wifi', dir), RegistryError);
    rmSync(registryPath(dir));
    assert.throws(() => isQualified('tuya-smoke-wifi', dir), RegistryError);
  });

  it('regroupe les modeles identiques et signale les modeles absents', () => {
    const v = checkPackModels(['XVR5104HS-I3', 'Dahua DH-XVR5104HS-I3', 'tuya-smoke-wifi', 'Inconnu']);
    assert.equal(v.length, 3);
    assert.equal(v.find((x) => x.entry?.id === 'dahua-xvr5104hs-i3')?.count, 2);
    assert.equal(v.find((x) => x.entry?.id === 'tuya-smoke-wifi')?.ok, true);
    assert.equal(v.find((x) => x.name === 'Inconnu')?.status, 'unknown');
  });
});

describe('record : enregistrer un resultat sans toucher au statut', () => {
  it('ecrit qualification/results/<id>-<date>.json et laisse le registre intact', () => {
    const dir = workdir();
    const before = rawReg(dir);
    const { file, result } = recordResult(SMOKE, passingInput(SMOKE, dir), { dir, now: NOW });
    assert.equal(file, join(dir, 'results', `${SMOKE}-2026-10-11.json`));
    assert.equal(result.model_id, SMOKE);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).tester, 'Awa Traore');
    assert.equal(rawReg(dir), before, 'record ne modifie pas le registre');
    assert.equal(isQualified(SMOKE, dir), false);
  });

  it("n'ecrase jamais un resultat : un second essai le meme jour prend un suffixe", () => {
    const dir = workdir();
    const a = recordResult(SMOKE, passingInput(SMOKE, dir), { dir, now: NOW });
    const b = recordResult(SMOKE, passingInput(SMOKE, dir, { tester: 'Autre Testeur' }), { dir, now: NOW });
    assert.notEqual(a.file, b.file);
    assert.match(b.file, /-2026-10-11-2\.json$/);
    assert.equal(JSON.parse(readFileSync(a.file, 'utf8')).tester, 'Awa Traore');
  });

  it('refuse les champs manquants ou incoherents et n\'ecrit alors rien', () => {
    const dir = workdir();
    const ok = passingInput(SMOKE, dir);
    const refuse = (input: unknown, pattern: RegExp) => {
      assert.throws(() => recordResult(SMOKE, input, { dir, now: NOW }), pattern);
      assert.deepEqual(readdirSync(join(dir, 'results')), [], 'aucun fichier ecrit');
    };
    const { tester: _t, ...sansTesteur } = ok;
    refuse(sansTesteur, /tester/);
    refuse({ ...ok, serial_numbers: [] }, /serial_numbers/);
    refuse({ ...ok, firmware: ' ' }, /firmware/);
    refuse({ ...ok, date: '2026-13-01' }, /date/);
    refuse({ ...ok, date: '2027-01-01' }, /futur/);
    refuse({ ...ok, conditions: { real_hardware: null, description: 'x', temperature_c: null, humidity_pct: null } }, /real_hardware/);
    refuse({ ...ok, tested_version: { psim: '0.1.0', gateway: null } }, /passerelle/);
    refuse({ ...ok, couleur: 'rouge' }, /champ\(s\) inconnu/);
    // etape manquante, inconnue, resultat invalide
    const { trigger: _trigger, ...sansTrigger } = ok.steps as Record<string, unknown>;
    refuse({ ...ok, steps: sansTrigger }, /steps\.trigger.*manquante/);
    refuse(withStep(ok, 'etape-fantome', { result: 'pass', note: '' }), /etape inconnue/);
    refuse(withStep(ok, 'trigger', { result: 'peut-etre', note: '' }), /trigger\.result/);
    // fail / na sans remarque
    refuse(withStep(ok, 'trigger', { result: 'fail', note: '' }), /justifiee/);
    refuse(withStep(ok, 'tamper', { result: 'na', note: ' ' }), /justifiee/);
    // mesures : manquante pour une etape pass, hors limite pour une etape pass
    const m = { ...(ok.measures as Record<string, number>) };
    delete m.latence_max_s;
    refuse({ ...ok, measures: m }, /latence_max_s.*obligatoire/);
    refuse({ ...ok, measures: { ...(ok.measures as object), latence_max_s: 99 } }, /hors limite/);
    refuse({ ...ok, measures: { ...(ok.measures as object), inconnue: 1 } }, /mesure inconnue/);
  });

  it("refuse un modele inconnu et enregistre un essai simule sans le rendre qualifiable", () => {
    const dir = workdir();
    assert.throws(() => recordResult('nimporte-quoi', passingInput(SMOKE, dir), { dir, now: NOW }), /inconnu/);
    const sim = passingInput(SMOKE, dir, { conditions: { real_hardware: false, description: 'banc simule', temperature_c: null, humidity_pct: null } });
    const { file } = recordResult(SMOKE, sim, { dir, now: NOW });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).conditions.real_hardware, false);
  });
});

describe('promote : seule une preuve materiel complete qualifie', () => {
  function recorded(id: string, dir: string, input: Record<string, unknown> = passingInput(id, dir)): string {
    return recordResult(id, input, { dir, now: NOW }).file;
  }
  const args = (id: string, resultFile: string) => ({ id, resultFile, by: 'Moussa Kone, responsable atelier', scope: 'Une unite, 31 C, fumee et batterie faible' });

  it('qualifie sur un resultat materiel complet, journalise qui / quand, et le registre reste valide', () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir);
    const updated = promote(args(SMOKE, file), { dir, now: NOW });
    assert.equal(updated.status, 'qualified');
    assert.equal(isQualified(SMOKE, dir), true);
    const reg = readReg(dir);
    const e = reg.entries.find((x) => x.id === SMOKE)!;
    assert.equal(e.history.at(-1)?.by, 'Moussa Kone, responsable atelier');
    assert.equal(e.history.at(-1)?.at, NOW.toISOString());
    assert.equal(e.history.at(-1)?.from, 'to_qualify');
    assert.equal(e.last_trial?.real_hardware, true);
    assert.equal(e.last_trial?.legacy, false);
    assert.match(e.last_trial?.result_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(e.scope, 'Une unite, 31 C, fumee et batterie faible');
    assert.deepEqual(validateRegistry(reg, dir), []);
    assert.deepEqual(auditRegistry(dir, resolve(dir, '..')).filter((p) => !/test simule introuvable/.test(p)), []);
  });

  it("REFUSE un essai simule (real_hardware: false) meme si toutes les etapes sont a pass", () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir, passingInput(SMOKE, dir, { conditions: { real_hardware: false, description: 'banc simule', temperature_c: null, humidity_pct: null } }));
    const before = rawReg(dir);
    assert.throws(() => promote(args(SMOKE, file), { dir, now: NOW }), (err: unknown) => err instanceof PromotionRefused && /materiel reel/.test(err.message));
    assert.equal(rawReg(dir), before, 'le registre n\'a pas bouge');
    assert.equal(isQualified(SMOKE, dir), false);
  });

  it('REFUSE si une etape obligatoire est en echec, absente ou « na », et explique laquelle', () => {
    const dir = workdir();
    const { steps } = contextFor(loadRegistry(dir), SMOKE, dir);
    const mandatory = steps.filter((s) => s.obligatoire && !s.mesures.length).map((s) => s.id);
    assert.ok(mandatory.length >= 5);
    for (const [result, note] of [['fail', 'a echoue'], ['na', 'impossible a tester']] as const) {
      const target = mandatory[3];
      const file = recorded(SMOKE, dir, withStep(passingInput(SMOKE, dir), target, { result, note }));
      assert.throws(() => promote(args(SMOKE, file), { dir, now: NOW }), (err: unknown) => err instanceof PromotionRefused && err.message.includes(`« ${target} »`));
    }
    assert.equal(isQualified(SMOKE, dir), false);
  });

  it('REFUSE aussi une etape facultative en echec (un echec n\'est jamais ignore)', () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir, withStep(passingInput(SMOKE, dir), 'tamper', { result: 'fail', note: 'pas d\'autoprotection detectee' }));
    assert.throws(() => promote(args(SMOKE, file), { dir, now: NOW }), /tamper.*echec/);
  });

  it('accepte une etape facultative « na » justifiee', () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir, withStep(passingInput(SMOKE, dir), 'tropical', { result: 'na', note: 'pas d\'enceinte climatique disponible' }));
    assert.equal(promote(args(SMOKE, file), { dir, now: NOW }).status, 'qualified');
  });

  it('REFUSE un fichier de resultat modifie a la main (mesure hors limite sur une etape pass)', () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.measures.latence_max_s = 42;
    writeFileSync(file, JSON.stringify(data));
    assert.throws(() => promote(args(SMOKE, file), { dir, now: NOW }), /hors limite/);
  });

  it("REFUSE le resultat d'un autre modele, d'une fiche modifiee, ou range hors de results/", () => {
    const dir = workdir();
    const other = recorded(CAMERA, dir);
    assert.throws(() => promote(args(SMOKE, other), { dir, now: NOW }), /model_id/);
    const file = recorded(SMOKE, dir);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.fiche_hash = '0'.repeat(16);
    writeFileSync(file, JSON.stringify(data));
    assert.throws(() => promote(args(SMOKE, file), { dir, now: NOW }), /fiche.*change/);
    const elsewhere = join(dirname2(dir), 'ailleurs.json');
    writeFileSync(elsewhere, readFileSync(other, 'utf8'));
    assert.throws(() => promote(args(SMOKE, elsewhere), { dir, now: NOW }), /range directement dans/);
    assert.throws(() => promote(args(SMOKE, join(dir, 'results', 'absent.json')), { dir, now: NOW }), /illisible/);
  });

  it('exige le nom du responsable et la portee precise', () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir);
    assert.throws(() => promote({ ...args(SMOKE, file), by: ' ' }, { dir, now: NOW }), /--by/);
    assert.throws(() => promote({ ...args(SMOKE, file), scope: '' }, { dir, now: NOW }), /--scope/);
    assert.equal(isQualified(SMOKE, dir), false);
  });

  it('un modele rejete doit d\'abord etre remis a « to_qualify », avec sa raison', () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir);
    setStatus(SMOKE, 'rejected', 'Moussa Kone', 'se bloque apres 2 h', { dir, now: NOW });
    assert.equal(qualificationStatus(SMOKE, dir), 'rejected');
    assert.throws(() => promote(args(SMOKE, file), { dir, now: NOW }), /rejete/);
    setStatus(SMOKE, 'to_qualify', 'Moussa Kone', 'firmware corrige', { dir, now: NOW });
    assert.equal(promote(args(SMOKE, file), { dir, now: NOW }).status, 'qualified');
    assert.throws(() => setStatus(SMOKE, 'qualified' as never, 'x', 'y', { dir }), /promote/);
  });

  it("un resultat modifie apres la promotion est detecte par l'audit (empreinte)", () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir);
    promote(args(SMOKE, file), { dir, now: NOW });
    writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    assert.match(auditRegistry(dir, resolve(dir, '..')).join('\n'), /empreinte differente/);
  });

  it("un transfert git qui convertit LF en CRLF ne casse pas l'empreinte d'un resultat", () => {
    const dir = workdir();
    const file = recorded(SMOKE, dir);
    promote(args(SMOKE, file), { dir, now: NOW });
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    assert.deepEqual(auditRegistry(dir, resolve(dir, '..')).filter((p) => !/test simule introuvable/.test(p)), []);
  });

  it('evaluatePromotion explique tout ce qui manque d\'un seul coup', () => {
    const dir = workdir();
    const { entry, fiche, steps } = contextFor(loadRegistry(dir), SMOKE, dir);
    const input = passingInput(SMOKE, dir, { conditions: { real_hardware: false, description: 'x', temperature_c: null, humidity_pct: null } });
    const raw = { schema: 1, model_id: entry.id, fiche: fiche.id, profile: entry.profile, fiche_version: fiche.version, fiche_hash: 'x', ...withStep(withStep(input, 'trigger', { result: 'fail', note: 'x' }), 'restore', { result: 'na', note: 'x' }) };
    const verdict = evaluatePromotion(raw, entry, fiche, steps, NOW);
    assert.equal(verdict.ok, false);
    const text = verdict.reasons.join('\n');
    assert.match(text, /materiel reel/);
    assert.match(text, /trigger/);
    assert.match(text, /restore/);
  });
});

const dirname2 = (p: string): string => resolve(p, '..');

describe('check-pack et ecritures atomiques', () => {
  function packFile(devices: unknown): string {
    const root = mkdtempSync(join(tmpdir(), 'psim-pack-'));
    cleanup.push(root);
    const f = join(root, 'pack.json');
    writeFileSync(f, JSON.stringify({ name: 'Pack standard', devices }));
    return f;
  }

  it('signale tout modele non qualifie (code 1) et accepte un pack entierement qualifie (code 0)', async () => {
    const bad = capture();
    const code = await runCli(['check-pack', packFile([{ model: 'DH-XVR5104HS-I3' }, { model: 'HAC-HFW1500TH-I8' }, { model: 'HAC-HFW1500TH-I8' }, { model: 'tuya-smoke-wifi' }, { model: 'Marque X' }])], bad.io);
    assert.equal(code, 1);
    const text = bad.out.join('\n');
    assert.match(text, /NON .*A QUALIFIER.*DH-XVR5104HS-I3/);
    assert.match(text, /OK .*QUALIFIE.*tuya-smoke-wifi/);
    assert.match(text, /Marque X : modele absent du registre/);
    assert.match(bad.err.join('\n'), /REFUSE : 3 modele/);

    const good = capture();
    assert.equal(await runCli(['check-pack', packFile([{ model: 'tuya-smoke-wifi' }, { model: 'DH-XVR5108HS-I3/T' }])], good.io), 0);
    assert.match(good.out.join('\n'), /Tous les modeles du pack sont qualifies/);
  });

  it("tolere l'absence de devices ou de modele, et --strict refuse un appareil sans modele", async () => {
    const empty = capture();
    assert.equal(await runCli(['check-pack', packFile(undefined)], empty.io), 0);
    assert.match(empty.out.join('\n'), /aucun appareil/);
    const partial = capture();
    const f = packFile([{ model: 'tuya-smoke-wifi' }, { name: 'camera sans modele' }]);
    assert.equal(await runCli(['check-pack', f], partial.io), 0);
    assert.match(partial.out.join('\n'), /1 appareil\(s\) sans modele/);
    assert.equal(await runCli(['check-pack', f, '--strict'], capture().io), 1);
    assert.equal(await runCli(['check-pack', join(tmpdir(), 'absent-pack.json')], capture().io), 2);
  });

  it("l'ecriture atomique remplace le fichier d'un bloc et ne laisse aucun temporaire", () => {
    const dir = workdir();
    const file = join(dir, 'essai.json');
    writeFileAtomic(file, '{"a":1}');
    writeFileAtomic(file, '{"a":2}');
    assert.equal(readFileSync(file, 'utf8'), '{"a":2}');
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });

  it("un echec d'ecriture laisse l'ancien contenu intact et nettoie le temporaire", () => {
    const dir = workdir();
    const target = join(dir, 'cible');
    mkdirSync(target); // renommer un fichier par-dessus un dossier echoue
    assert.throws(() => writeFileAtomic(target, 'nouveau'));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    assert.ok(existsSync(target));
  });

  it("saveRegistry refuse un registre invalide sans toucher au fichier", () => {
    const dir = workdir();
    const before = rawReg(dir);
    const reg = readReg(dir);
    reg.entries.find((e) => e.id === SMOKE)!.status = 'qualified';
    assert.throws(() => saveRegistry(reg, dir), RegistryError);
    assert.equal(rawReg(dir), before);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });

  it('un promote refuse laisse le registre octet pour octet identique', () => {
    const dir = workdir();
    const before = rawReg(dir);
    const file = recordResult(SMOKE, withStep(passingInput(SMOKE, dir), 'trigger', { result: 'fail', note: 'raté' }), { dir, now: NOW }).file;
    assert.throws(() => promote({ id: SMOKE, resultFile: file, by: 'x', scope: 'y' }, { dir, now: NOW }), PromotionRefused);
    assert.equal(rawReg(dir), before);
  });
});

describe('fiches de recette : sections, gabarits et coherence avec le registre', () => {
  const fiches = loadFiches().fiches;
  const combos = fiches.flatMap((f) => (Object.keys(f.profils).length ? Object.keys(f.profils) : [null]).map((p) => ({ f, p })));

  it('fiches.json est valide et chaque combinaison fiche / profil se developpe', () => {
    assert.deepEqual(validateFichesData(JSON.parse(readFileSync(join(QUALIF_DIR, 'fiches.json'), 'utf8'))), []);
    assert.ok(combos.length >= 40);
    assert.deepEqual(
      fiches.map((f) => f.id).sort(),
      ['camera-onvif', 'enregistreur-dahua', 'lorawan', 'modbus', 'mqtt-ingest', 'notifications', 'onduleur', 'sia', 'socle', 'tuya', 'zigbee'],
    );
  });

  it('chaque fiche imprimable (Markdown et HTML) contient toutes les sections et toutes ses etapes', () => {
    for (const { f, p } of combos) {
      const md = renderMarkdown(f, p);
      const html = renderHtml(f, p);
      for (const section of ['## Champs à remplir', '## Matériel nécessaire', "## Montage du banc d'essai", '## Étapes', '## Critères de réussite', "## Critères d'échec", '## Synthèse et signatures']) {
        assert.ok(md.includes(section), `${f.id}[${p}] : section absente du Markdown : ${section}`);
      }
      for (const label of ['Champs à remplir', 'Matériel nécessaire', "Montage du banc d'essai", 'Critères de réussite', "Critères d'échec", 'Synthèse et signatures', 'Numéro(s) de série', 'Version du micrologiciel']) {
        assert.ok(html.includes(label), `${f.id}[${p}] : « ${label} » absent du HTML`);
      }
      assert.ok(html.startsWith('<!doctype html>'));
      for (const s of stepsFor(f, p)) {
        assert.ok(md.includes(`\`${s.id}\``) && html.includes(`<code>${s.id}</code>`), `${f.id}[${p}] : etape ${s.id} absente`);
        assert.ok(!/\{\{|\}\}/.test(s.action + s.attendu + s.titre), `${f.id}[${p}].${s.id} : parametre non resolu`);
      }
      assert.ok(!/\{\{|\}\}/.test(md), 'aucun parametre non resolu dans la fiche');
    }
  });

  it('les fiches de capteurs deroulent toute la sequence exigee : declenchement, retour, latence, liaison, silence, redemarrage, renvoi daté', () => {
    const sensors = combos.filter(({ f, p }) => ['zigbee', 'modbus', 'onduleur', 'sia', 'tuya', 'enregistreur-dahua'].includes(f.id) || (f.id === 'lorawan' && p !== 'passerelle-radio') || (f.id === 'mqtt-ingest' && p === 'capteur'));
    assert.ok(sensors.length >= 30);
    for (const { f, p } of sensors) {
      const ids = new Set(stepsFor(f, p).map((s) => s.id));
      for (const id of ['prep-identif', 'prep-banc', 'trigger', 'restore', 'repeat', 'latency', 'linkloss', 'linkback', 'silence', 'psimrestart', 'netcut', 'tropical', 'closeout']) {
        assert.ok(ids.has(id), `${f.id}[${p}] : etape ${id} absente`);
      }
    }
    for (const { f, p } of sensors.filter(({ f: x }) => !['modbus', 'enregistreur-dahua'].includes(x.id))) {
      assert.ok(stepsFor(f, p).some((s) => s.id === 'lowbat'), `${f.id}[${p}] : batterie faible absente`);
    }
    for (const { f, p } of sensors.filter(({ f: x, p: q }) => ['zigbee', 'sia', 'tuya'].includes(x.id) && q !== 'fumee' && q !== 'contact' || (x.id === 'zigbee' && q === 'contact'))) {
      assert.ok(stepsFor(f, p).some((s) => s.id.startsWith('tamper')), `${f.id}[${p}] : sabotage absent`);
    }
  });

  it('les criteres sont chiffres : latence, silence « muet » jamais « normal », conditions tropicales 35 C / 90 %', () => {
    for (const { f, p } of combos.filter(({ f: x }) => x.id === 'zigbee')) {
      const steps = stepsFor(f, p);
      const latency = steps.find((s) => s.id === 'latency')!;
      assert.equal(latency.mesures[0].max, 5);
      assert.ok(latency.obligatoire);
      const silence = steps.find((s) => s.id === 'silence')!;
      assert.match(silence.attendu, /Hors ligne/);
      assert.match(silence.attendu, /JAMAIS affiché « Normal »/);
      assert.ok(silence.mesures[0].max! > 0);
      const tropical = steps.find((s) => s.id === 'tropical')!;
      assert.equal(tropical.mesures.find((m) => m.cle === 'tropical_temperature_c')?.min, 35);
      assert.equal(tropical.mesures.find((m) => m.cle === 'tropical_humidite_pct')?.min, 90);
      assert.match(tropical.action, /35 °C et 90 %/);
      assert.match(steps.find((s) => s.id === 'netcut')!.attendu, /heure réelle/);
      assert.match(steps.find((s) => s.id === 'repeat')!.attendu, /10 cycles sur 10/);
    }
  });

  it('chaque entree du registre a sa fiche et son profil, et chaque fiche et profil sert a au moins un modele', () => {
    const reg = loadRegistry();
    const used = new Set<string>();
    for (const e of reg.entries) {
      const f = getFiche(e.fiche);
      assert.ok(f, `${e.id} : fiche ${e.fiche}`);
      assert.ok(existsSync(join(ROOT, 'docs', 'qualification', `${e.fiche}.md`)), `${e.id} : docs/qualification/${e.fiche}.md absent`);
      assert.ok(stepsFor(f, e.profile).length > 0);
      used.add(`${e.fiche}/${e.profile ?? ''}`);
    }
    for (const { f, p } of combos) assert.ok(used.has(`${f.id}/${p ?? ''}`), `fiche ${f.id} profil ${p} sans aucun modele du registre`);
  });

  it('les fiches de docs/qualification/ sont a jour avec le gabarit (rien n\'a diverge)', async () => {
    for (const f of fiches) {
      assert.equal(readFileSync(join(ROOT, 'docs', 'qualification', `${f.id}.md`), 'utf8').replace(/\r\n/g, '\n'), renderFicheDoc(f), `docs/qualification/${f.id}.md obsolete : npm run qualify -- docs`);
    }
    const c = capture();
    assert.equal(await runCli(['docs', '--check'], c.io), 0, c.err.join('\n'));
  });

  it('une fiche invalide est refusee : gabarit inconnu, parametre inconnu, doublon, banc incomplet', () => {
    const raw = () => JSON.parse(readFileSync(join(QUALIF_DIR, 'fiches.json'), 'utf8'));
    const bad = (fn: (d: any) => void) => {
      const d = raw();
      fn(d);
      return validateFichesData(d).join('\n');
    };
    assert.match(bad((d) => void (d.fiches[0].etapes[0] = { ref: 'inconnu' })), /gabarit inconnu/);
    assert.match(bad((d) => void (d.templates.trigger.action = 'Faire {{truc}}')), /parametre inconnu/);
    assert.match(bad((d) => void d.fiches[0].etapes.push({ ref: 'closeout' })), /en double/);
    assert.match(bad((d) => void delete d.fiches[0].profils.mouvement.bench.normal), /exige « normal »/);
    assert.match(bad((d) => void (d.templates.latency.mesures = [{ cle: 'latence_max_s', libelle: 'x', unite: 's' }])), /limite/);
    assert.match(bad((d) => void (d.fiches[0].etapes = d.fiches[0].etapes.filter((e: any) => e.ref !== 'closeout'))), /closeout/);
  });
});

describe('banc simule : la fiche se deroule contre un vrai PSIM', () => {
  const fiches = loadFiches().fiches;

  it('toutes les etapes rejouables de toutes les fiches et de tous les profils reussissent', async () => {
    for (const f of fiches) {
      for (const p of Object.keys(f.profils).length ? Object.keys(f.profils) : [null]) {
        const report = await runBench(f, p);
        assert.equal(report.real_hardware, false, 'un banc simule n\'est jamais un essai materiel');
        const failed = report.steps.filter((s) => s.outcome === 'echec').map((s) => `${s.id} : ${s.detail}`);
        assert.deepEqual(failed, [], `${f.id}[${p}]`);
        assert.equal(report.replayed + report.physical, report.steps.length);
      }
    }
  });

  it('rejoue vraiment la sequence : declenchement, muet, redemarrage et renvoi date sur la fiche Zigbee', async () => {
    const report = await runBench(getFiche('zigbee')!, 'mouvement');
    const detail = (id: string) => report.steps.find((s) => s.id === id)!;
    assert.equal(detail('trigger').outcome, 'rejoue');
    assert.match(detail('trigger').detail, /incident n°1 ouvert/);
    assert.match(detail('silence').detail, /muet apres 180 s.*jamais Normal/);
    assert.match(detail('psimrestart').detail, /arret brutal/);
    assert.match(detail('netcut').detail, /aucun doublon/);
    assert.equal(detail('prep-identif').outcome, 'physique');
    assert.equal(detail('tropical').outcome, 'physique');
    assert.ok(report.replayed >= 10);
  });

  it('detecte une fiche defectueuse : un message d\'alarme qui n\'ouvre pas d\'incident fait echouer le declenchement', async () => {
    const f = JSON.parse(JSON.stringify(getFiche('zigbee'))) as Fiche;
    f.profils.mouvement.bench!.alarme = { event: 'heartbeat' }; // simple signe de vie : jamais une alarme
    const report = await runBench(f, 'mouvement');
    assert.equal(report.ok, false);
    assert.ok(report.steps.some((s) => s.id === 'trigger' && s.outcome === 'echec'));
  });

  it('un silence reglé trop court pour le banc, ou un retour qui ferme l\'incident, serait detecte', async () => {
    const f = JSON.parse(JSON.stringify(getFiche('tuya'))) as Fiche;
    f.profils.fumee.bench!.normal = { event: 'heartbeat' }; // le « retour a la normale » ne ramene rien a Normal
    const report = await runBench(f, 'fumee');
    assert.equal(report.steps.find((s) => s.id === 'restore')?.outcome, 'echec');
  });
});

describe('commandes en ligne', () => {
  it('list filtre par famille et statut ; show detaille la portee ; usage inconnu = code 2', async () => {
    const dir = workdir();
    const list = capture();
    assert.equal(await runCli(['list', '--status', 'qualified', '--dir', dir], list.io), 0);
    assert.match(list.out.join('\n'), /2 modele\(s\) : 2 qualifie\(s\), 0 a qualifier/);
    const fam = capture();
    assert.equal(await runCli(['list', '--family', 'incendie_gaz', '--status', 'to_qualify', '--json', '--dir', dir], fam.io), 0);
    const rows = JSON.parse(fam.out.join('\n')) as { id: string; status: string }[];
    assert.ok(rows.some((r) => r.id === 'heiman-hs1sa-e') && rows.every((r) => r.status === 'to_qualify'));
    const show = capture();
    assert.equal(await runCli(['show', 'dahua-xvr5108hs-i3t-voie', '--dir', dir], show.io), 0);
    assert.match(show.out.join('\n'), /UNE voie/);
    assert.match(show.out.join('\n'), /MATERIEL REEL/);
    assert.equal(await runCli(['list', '--status', 'bof', '--dir', dir], capture().io), 2);
    assert.equal(await runCli(['nimporte', '--dir', dir], capture().io), 2);
    assert.equal(await runCli(['show', 'inconnu-x', '--dir', dir], capture().io), 1);
  });

  it('sheet ecrit la fiche vierge en HTML et en Markdown avec le resume du modele', async () => {
    const dir = workdir();
    const out = join(dirname2(dir), 'fiches');
    const c = capture();
    assert.equal(await runCli(['sheet', 'dahua-xvr5104hs-i3', '--out', out, '--dir', dir], c.io), 0);
    const md = readFileSync(join(out, 'fiche-dahua-xvr5104hs-i3.md'), 'utf8');
    const html = readFileSync(join(out, 'fiche-dahua-xvr5104hs-i3.html'), 'utf8');
    assert.match(md, /Modèle : Dahua DH-XVR5104HS-I3/);
    assert.match(md, /statut au registre : \*\*A QUALIFIER\*\*/);
    assert.match(html, /statut au registre : <b>A QUALIFIER<\/b>/);
    assert.match(html, /Portée actuellement validée/);
    assert.ok(!html.includes('<script'));
  });

  it('record --template puis record --file puis promote : le circuit complet depuis la ligne de commande', async () => {
    const dir = workdir();
    const tpl = capture();
    assert.equal(await runCli(['record', SMOKE, '--template', '--dir', dir], tpl.io), 0);
    const template = JSON.parse(tpl.out.join('\n'));
    const { steps } = contextFor(loadRegistry(dir), SMOKE, dir);
    assert.deepEqual(Object.keys(template.steps), steps.map((s) => s.id));
    // Le modele vide est refuse tel quel : tous les champs manquants sont a remplir.
    const empty = join(dirname2(dir), 'vide.json');
    writeFileSync(empty, JSON.stringify(template));
    const refused = capture();
    assert.equal(await runCli(['record', SMOKE, '--file', empty, '--dir', dir], refused.io), 1);
    assert.match(refused.err.join('\n'), /resultat refuse/);
    // Saisie complete.
    const full = join(dirname2(dir), 'saisie.json');
    writeFileSync(full, JSON.stringify(passingInput(SMOKE, dir, { date: new Date().toISOString().slice(0, 10) })));
    const rec = capture();
    assert.equal(await runCli(['record', SMOKE, '--file', full, '--dir', dir], rec.io), 0, rec.err.join('\n'));
    const resultFile = readdirSync(join(dir, 'results'))[0];
    assert.equal(isQualified(SMOKE, dir), false);
    // promote sans --by : refuse (code 1) ; avec : qualifie.
    const no = capture();
    assert.equal(await runCli(['promote', SMOKE, '--result', join(dir, 'results', resultFile), '--scope', 'x', '--dir', dir], no.io), 1);
    const yes = capture();
    assert.equal(await runCli(['promote', SMOKE, '--result', join(dir, 'results', resultFile), '--by', 'Moussa Kone', '--scope', 'Une unite en atelier', '--dir', dir], yes.io), 0, yes.err.join('\n'));
    assert.equal(isQualified(SMOKE, dir), true);
    const reject = capture();
    assert.equal(await runCli(['set-status', SMOKE, 'qualified', '--by', 'x', '--reason', 'y', '--dir', dir], reject.io), 2);
  });
});
