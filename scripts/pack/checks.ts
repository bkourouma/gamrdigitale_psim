/**
 * Recette d'un pack : « le pack est-il complet ? », controle par controle, dans le format de la mise en service
 * (`npm run commission -- --pack <pack>`). Lecture seule de la base.
 *
 *  - chaque equipement du pack est present, du bon type ;
 *  - chaque source prevue est enregistree (camera reelle, enregistreur Dahua, Tuya, supervision reseau) ;
 *  - chaque camera liee a un detecteur du pack a une source reelle (une camera simulee ne montre rien) ;
 *  - aucun detecteur muet : hors ligne = echec ; jamais entendu = a faire (`commission -- watch --pack`) ;
 *  - au moins un destinataire de niveau 1 ; comptes de passerelle presents ; modeles a qualifier rappeles ;
 *  - le pack (cette version) a bien ete applique (journal).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Check } from '../commission/checks.ts';
import type { Pack } from './schema.ts';

type Row = Record<string, unknown>;

const list = (ids: string[], max = 12) => `${ids.slice(0, max).join(', ')}${ids.length > max ? '...' : ''}`;

export interface PackCheckContext {
  /** Comptes de passerelle du .env (sans mot de passe). */
  gatewayAccounts: { user: string; detectors: string[] }[];
  /** Destinataires de niveau 1 du .env (tous canaux confondus). */
  envLevel1: number;
  /** Equipements dont le modele n'est pas qualifie au registre de qualification (a qualifier, inconnu ou rejete). */
  unqualified: { deviceId: string; model: string }[];
}

export function checkPack(db: DatabaseSync, pack: Pack, ctx: PackCheckContext): Check[] {
  const out: Check[] = [];
  const title = `Pack ${pack.id} v${pack.version}`;
  const get = (id: string) => db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Row | undefined;

  const missing = pack.devices.filter((d) => get(d.id)?.kind !== d.kind).map((d) => d.id);
  out.push(missing.length
    ? { id: 'pack-devices', title, status: 'fail', detail: `equipement(s) absent(s) ou d'un autre type : ${list(missing)}`, fix: `npm run pack -- plan <pack> puis apply (ou corriger l'inventaire).` }
    : { id: 'pack-devices', title, status: 'ok', detail: `${pack.devices.length} equipement(s) du pack presents` });

  const noSource: string[] = [];
  for (const d of pack.devices) {
    if (!d.source || missing.includes(d.id)) continue;
    const table = d.kind === 'camera' ? 'camera_source' : { dahua: 'detector_source', tuya: 'tuya_source', network: 'network_target' }[d.source.type as 'dahua' | 'tuya' | 'network'];
    if (!db.prepare(`SELECT 1 AS x FROM ${table} WHERE device_id = ?`).get(d.id)) noSource.push(`${d.id} (${d.source.type})`);
  }
  out.push(noSource.length
    ? { id: 'pack-sources', title: 'Sources du pack', status: 'fail', detail: `source(s) prevue(s) non enregistree(s) : ${list(noSource)}`, fix: 'Reappliquer le pack, ou saisir la source dans la fiche de l\'equipement.' }
    : { id: 'pack-sources', title: 'Sources du pack', status: 'ok', detail: 'toutes les sources prevues sont enregistrees' });

  const detectors = pack.devices.filter((d) => d.kind === 'detector').map((d) => d.id);
  const linked = detectors.length
    ? (db.prepare(`SELECT DISTINCT camera_id FROM device_link WHERE detector_id IN (${detectors.map(() => '?').join(',')}) ORDER BY camera_id`).all(...detectors) as Row[]).map((r) => r.camera_id as string)
    : [];
  const simulated = linked.filter((c) => !db.prepare('SELECT 1 AS x FROM camera_source WHERE device_id = ?').get(c));
  const missingLinks = Object.entries(pack.links).filter(([det, cams]) => cams.some((c) => !db.prepare('SELECT 1 AS x FROM device_link WHERE detector_id = ? AND camera_id = ?').get(det, c))).map(([det]) => det);
  out.push(simulated.length
    ? { id: 'pack-cameras', title: 'Cameras liees', status: 'fail', detail: `camera(s) liee(s) sans source reelle (simulee) : ${list(simulated)}`, fix: 'Saisir la source video (RTSP ou ONVIF) de chaque camera liee.' }
    : missingLinks.length
      ? { id: 'pack-cameras', title: 'Cameras liees', status: 'warn', detail: `liens du pack absents pour : ${list(missingLinks)}`, fix: 'Reappliquer le pack (--update) ou relier les cameras dans la fiche du detecteur.' }
      : { id: 'pack-cameras', title: 'Cameras liees', status: 'ok', detail: `${linked.length} camera(s) liee(s), toutes avec une source reelle` });

  const rows = detectors.map((id) => get(id)).filter((r): r is Row => Boolean(r));
  const offline = rows.filter((r) => r.status === 'offline').map((r) => r.id as string);
  const never = rows.filter((r) => r.last_seen === null && r.status !== 'offline').map((r) => r.id as string);
  out.push(offline.length
    ? { id: 'pack-silent', title: 'Detecteurs muets', status: 'fail', detail: `hors ligne : ${list(offline)}${never.length ? ` ; jamais entendus : ${list(never)}` : ''}`, fix: 'Verifier alimentation, reseau, passerelle ou compte cloud ; puis `npm run commission -- watch --pack <pack>`.' }
    : never.length
      ? { id: 'pack-silent', title: 'Detecteurs muets', status: 'warn', detail: `jamais entendus : ${list(never)}`, fix: 'Declencher chaque detecteur pendant `npm run commission -- watch --pack <pack> --until-all`.' }
      : { id: 'pack-silent', title: 'Detecteurs muets', status: 'ok', detail: 'chaque detecteur du pack a deja emis' });

  const level1 = (db.prepare('SELECT COUNT(*) AS n FROM notification_recipient WHERE active = 1 AND level = 1').get() as { n: number }).n + ctx.envLevel1;
  const expected = pack.recipients.filter((r) => r.level === 1).length;
  out.push(level1 === 0
    ? { id: 'pack-recipients', title: 'Destinataires', status: 'fail', detail: `aucun destinataire de niveau 1 : personne ne serait prevenu (${expected} prevu(s) par le pack)`, fix: 'Notifications > destinataires, ou reappliquer le pack avec les adresses.' }
    : { id: 'pack-recipients', title: 'Destinataires', status: 'ok', detail: `${level1} destinataire(s) de niveau 1 (${expected} prevu(s) par le pack)` });

  if (pack.gateway.accounts.length) {
    const problems: string[] = [];
    for (const a of pack.gateway.accounts) {
      const acc = ctx.gatewayAccounts.find((g) => g.user === a.name);
      if (!acc) {
        problems.push(`compte « ${a.name} » absent de PSIM_MQTT_GATEWAYS`);
        continue;
      }
      const covered = (p: string) => acc.detectors.some((q) => q === p || (q.endsWith('*') && p.replace(/\*$/, '').startsWith(q.slice(0, -1))));
      const uncovered = a.devices.filter((p) => !covered(p));
      if (uncovered.length) problems.push(`compte « ${a.name} » : ${uncovered.join(', ')} non autorise(s)`);
    }
    out.push(problems.length
      ? { id: 'pack-gateway', title: 'Comptes de passerelle', status: 'fail', detail: problems.join(' ; '), fix: 'Completer PSIM_MQTT_GATEWAYS dans le .env (voir docs/PASSERELLE.md), puis redemarrer le PSIM.' }
      : { id: 'pack-gateway', title: 'Comptes de passerelle', status: 'ok', detail: `${pack.gateway.accounts.length} compte(s) present(s) et suffisant(s)` });
  }

  out.push(ctx.unqualified.length
    ? { id: 'pack-models', title: 'Modeles a qualifier', status: 'warn', detail: `${ctx.unqualified.length} equipement(s) : ${list([...new Set(ctx.unqualified.map((u) => u.model))])}`, fix: "Recette renforcee sur ces modeles (voir docs/PACKS.md, « Qualification »), resultat a noter au registre de qualification." }
    : { id: 'pack-models', title: 'Modeles a qualifier', status: 'ok', detail: 'tous les modeles du pack sont qualifies' });

  const applied = (db.prepare("SELECT ts, details FROM audit_log WHERE action = 'pack_applique' AND details LIKE ? ORDER BY id DESC LIMIT 1").get(`${pack.id}@${pack.version} %`) as Row | undefined);
  out.push(applied
    ? { id: 'pack-applied', title: 'Application du pack', status: 'ok', detail: `appliquee le ${new Date(applied.ts as number).toLocaleString('fr-FR')} (journal)` }
    : { id: 'pack-applied', title: 'Application du pack', status: 'warn', detail: 'aucune application de cette version au journal', fix: 'npm run pack -- apply <pack>' });
  return out;
}

/** Packs appliques d'apres le journal (le plus recent d'abord, un par pack) : cites sur la fiche de recette. */
export function appliedPacks(db: DatabaseSync): { id: string; version: string; at: number; by: string | null }[] {
  const out: { id: string; version: string; at: number; by: string | null }[] = [];
  for (const r of db.prepare("SELECT ts, details FROM audit_log WHERE action = 'pack_applique' ORDER BY id DESC LIMIT 200").all() as Row[]) {
    const m = /^([a-z0-9-]+)@(\d+\.\d+\.\d+) /.exec(String(r.details ?? ''));
    if (!m || out.some((p) => p.id === m[1])) continue;
    const by = /; par (.+)$/.exec(String(r.details))?.[1] ?? null;
    out.push({ id: m[1], version: m[2], at: r.ts as number, by });
  }
  return out;
}
