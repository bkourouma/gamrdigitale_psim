import type { AuditEntry, Role, Snapshot } from './types.ts';

/**
 * Ce qu'un OPERATEUR n'a pas besoin de lire dans le journal : adresses de cameras, chemins du systeme de fichiers, messages
 * d'erreur internes, gestion des comptes, reglages de securite. Il garde ce qui sert a son travail (incidents, acquittements,
 * etats des detecteurs, armements). L'administrateur voit tout.
 */
export const ADMIN_ONLY_DETAILS = new Set([
  'camera_source_updated',
  'backup_failed',
  'notification_failed',
  'user_created',
  'user_updated',
  'user_deleted',
  'password_changed',
  'password_reset',
  'totp_enabled',
  'totp_disabled',
  'totp_reset',
  'recovery_regenerated',
  'recovery_code_used',
  'recipient_added',
  'recipient_updated',
  'recipient_removed',
  'login_failed',
  'login_locked',
  'login_2fa_failed',
  // Cles et images d'equipement : adresses, numeros de cles (jamais la cle elle-meme).
  'device_key_created',
  'device_key_revoked',
  'device_key_rotated',
  'image_refusee',
  'heartbeat_failing',
  'heartbeat_recovered',
  'journal_integrity_failed',
  'journal_integrity_recovered',
  'journal_verified',
  'report_schedule_updated',
  'report_email_sent',
  'report_email_failed',
  'report_exported',
  'device_flapping',
  // Application des agents : telephones appaires, connexions et verrous, lecture de l'historique des positions.
  'agent_phone_created',
  'agent_phone_paired',
  'agent_phone_revoked',
  'agent_login_failed',
  'agent_locked',
  'agent_unlocked',
  'patrol_history_read',
]);

export function maskAudit(entry: AuditEntry, role: Role): AuditEntry {
  if (role === 'admin' || !ADMIN_ONLY_DETAILS.has(entry.action)) return entry;
  return { ...entry, details: null };
}

export function maskSnapshot(snapshot: Snapshot, role: Role): Snapshot {
  return role === 'admin' ? snapshot : { ...snapshot, audit: snapshot.audit.map((e) => maskAudit(e, role)) };
}
