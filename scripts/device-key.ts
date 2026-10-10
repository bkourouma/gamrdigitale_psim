/**
 * Cles d'entree par equipement (images et messages d'etat des equipements), depuis la console de la machine du PSIM.
 * Meme effet que l'API d'administration (/api/device-keys) ; utile pour preparer un equipement sans navigateur.
 *
 *   npm run device-key -- list
 *   npm run device-key -- create --label "Camera 4G portail" --devices I-01,D-*
 *   npm run device-key -- rotate 3 [--grace 60]     (nouvelle cle ; l'ancienne reste valable 60 min)
 *   npm run device-key -- revoke 3
 *
 * La cle n'est affichee qu'UNE fois (creation, rotation) : la copier aussitot dans l'equipement. Seule son empreinte est
 * gardee. Chaque action est inscrite au journal (auteur « console »).
 */
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appendSealed } from '../server/auditchain.ts';
import { config } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createDeviceKeys } from '../server/devicekeys.ts';

const USAGE = 'Usage : npm run device-key -- list | create --label "<nom>" --devices <id,prefixe*> | rotate <n> [--grace <minutes>] | revoke <n>';

export function run(db: DatabaseSync, args: string[], print: (line: string) => void = console.log): number {
  const keys = createDeviceKeys({
    db,
    audit: (actor, action, ref) => void appendSealed(db, { ts: Date.now(), actor, action, incident_id: null, device_id: ref?.deviceId ?? null, details: ref?.details ?? null }),
  });
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [command, target] = args;
  try {
    if (command === 'list') {
      const list = keys.list();
      if (list.length === 0) print('Aucune cle.');
      for (const k of list) {
        const state = k.active ? (k.revokedAt ? `active jusqu'au ${new Date(k.revokedAt).toLocaleString('fr-FR')}` : 'active') : 'revoquee';
        print(`n°${k.id}  ${k.label}  [${k.devices.join(', ')}]  ${state}${k.lastUsedAt ? `, derniere utilisation ${new Date(k.lastUsedAt).toLocaleString('fr-FR')}` : ''}`);
      }
      return 0;
    }
    if (command === 'create') {
      const created = keys.create('console', { label: value('--label'), devices: (value('--devices') ?? '').split(',').filter(Boolean) });
      print(`Cle n°${created.id} creee pour ${created.devices.join(', ')}. A copier MAINTENANT dans l'equipement (elle ne sera plus jamais affichee) :`);
      print(created.key);
      return 0;
    }
    if (command === 'rotate' && target) {
      const grace = value('--grace');
      const created = keys.rotate('console', target, { graceMinutes: grace === undefined ? 0 : Number(grace) });
      print(`Cle n°${target} remplacee par la cle n°${created.id}${grace ? ` (l'ancienne reste valable ${grace} min)` : ' (l\'ancienne est revoquee)'}. Nouvelle cle, affichee une seule fois :`);
      print(created.key);
      return 0;
    }
    if (command === 'revoke' && target) {
      keys.revoke('console', target);
      print(`Cle n°${target} revoquee.`);
      return 0;
    }
  } catch (err) {
    print(`Erreur : ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  print(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const db = openDb(join(resolve(import.meta.dirname, '..', config.dataDir), 'psim.db'));
  try {
    process.exitCode = run(db, process.argv.slice(2));
  } finally {
    db.close();
  }
}
