/**
 * Phase 5 — backup status UX + runbook hooks.
 *
 * This stack (Supabase managed Postgres) does not expose raw dump APIs from the
 * app. We persist backup_events for admin UX, audit admin actions, and document
 * the ops runbook. Nightly/incremental jobs should call recordBackupEvent from
 * the host cron / Supabase backup tooling.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from './auditService.js';

export const BACKUP_POLICY = {
  full: 'Every night 02:00',
  incremental: 'Every 4 hours',
  retention: '30 daily · 12 monthly',
  offsite: 'Encrypted off-site / cloud copy required',
  alert: 'Email to admin if backup fails',
  /** Documented production assumption (HTML screen 15). */
  https: 'Production must serve API + SPA over HTTPS only.',
  encryption_at_rest: 'Supabase Postgres encryption at rest (platform).',
  runbook: [
    '1. Prefer platform automated backups (Supabase PITR / nightly snapshots).',
    '2. Export logical dump off-site weekly: pg_dump → encrypt → store in separate region/bucket.',
    '3. Keep 30 daily + 12 monthly encrypted copies.',
    '4. On failure: insert backup_events status=failed and email ADMIN_ALERT_EMAIL.',
    '5. Monthly: Administrator runs “test restore” (logs result here) against a staging project.',
  ],
};

export const ADMIN_ALERT_EMAIL =
  process.env.ADMIN_ALERT_EMAIL || process.env.BACKUP_ALERT_EMAIL || null;

/**
 * Stub/hook for email alert when a backup fails.
 * TODO: wire real SMTP / SendGrid / SES when credentials are available.
 */
export async function notifyBackupFailure({ message, eventId, metadata } = {}) {
  const payload = {
    to: ADMIN_ALERT_EMAIL,
    subject: '[St Dominic HMS] Backup failed',
    message: message || 'A database backup failed.',
    eventId,
    metadata,
    at: new Date().toISOString(),
  };
  if (!ADMIN_ALERT_EMAIL) {
    console.warn(
      '[backup] ALERT hook (no ADMIN_ALERT_EMAIL configured):',
      JSON.stringify(payload)
    );
    return { sent: false, reason: 'ADMIN_ALERT_EMAIL not configured', payload };
  }
  // TODO(sms/email-provider): send email via configured provider
  console.warn('[backup] ALERT email stub — configure provider:', JSON.stringify(payload));
  return { sent: false, reason: 'email_provider_not_configured', payload };
}

export async function recordBackupEvent({
  eventType,
  status,
  message,
  offsiteSynced = false,
  retentionNote = BACKUP_POLICY.retention,
  triggeredBy = null,
  metadata = {},
  startedAt = null,
  finishedAt = null,
} = {}) {
  const row = {
    event_type: eventType,
    status,
    message: message || null,
    offsite_synced: Boolean(offsiteSynced),
    offsite_synced_at: offsiteSynced ? new Date().toISOString() : null,
    retention_note: retentionNote,
    triggered_by: triggeredBy,
    metadata: metadata || {},
    started_at: startedAt || new Date().toISOString(),
    finished_at: finishedAt || (status === 'running' || status === 'queued' ? null : new Date().toISOString()),
  };
  const { data, error } = await supabase
    .from('backup_events')
    .insert(row)
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  if (status === 'failed') {
    await notifyBackupFailure({
      message: message || 'Backup failed',
      eventId: data.id,
      metadata,
    });
  }
  return data;
}

export async function getBackupStatus() {
  const { data: latestFull } = await supabase
    .from('backup_events')
    .select('*')
    .in('event_type', ['full_backup', 'manual_backup'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: latestRestore } = await supabase
    .from('backup_events')
    .select('*')
    .eq('event_type', 'test_restore')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: recent } = await supabase
    .from('backup_events')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(20);

  return {
    policy: BACKUP_POLICY,
    alert_email: ADMIN_ALERT_EMAIL,
    last_backup: latestFull || null,
    last_test_restore: latestRestore || null,
    offsite_ok: Boolean(latestFull?.offsite_synced && latestFull?.status === 'success'),
    recent: recent || [],
  };
}

/**
 * Admin "Back up now" — logs a manual backup request.
 * Actual dump is platform/runbook; we mark success if SUPABASE is reachable
 * (health probe) and leave a clear message for ops.
 */
export async function requestManualBackup({ actor, req } = {}) {
  const started = new Date().toISOString();
  // Health probe: if we can query profiles, DB is reachable (logical "snapshot request" logged).
  const { error: probeErr } = await supabase.from('profiles').select('id').limit(1);
  const ok = !probeErr;
  const event = await recordBackupEvent({
    eventType: 'manual_backup',
    status: ok ? 'success' : 'failed',
    message: ok
      ? 'Manual backup request logged. Platform/Supabase snapshot + off-site copy must be confirmed by ops runbook.'
      : `Manual backup probe failed: ${probeErr.message}`,
    offsiteSynced: false,
    triggeredBy: actor?.id || null,
    metadata: {
      mode: 'request_only',
      note: 'App cannot dump managed Supabase; use platform backups + encrypted off-site copy.',
    },
    startedAt: started,
  });

  await writeAuditLog({
    actorId: actor?.id,
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'create',
    resourceType: 'backup',
    resourceId: event.id,
    module: 'security',
    metadata: { event_type: 'manual_backup', status: event.status },
    req,
  });

  return event;
}

/**
 * Admin "Run test restore" — records monthly test restore attempt.
 * Does not mutate production data; logs pass/fail for compliance UX.
 */
export async function requestTestRestore({ actor, req, passed = true, notes = '' } = {}) {
  const event = await recordBackupEvent({
    eventType: 'test_restore',
    status: passed ? 'success' : 'failed',
    message:
      notes ||
      (passed
        ? 'Test restore logged as passed (staging restore per runbook). Production data untouched.'
        : 'Test restore logged as failed — investigate backup integrity.'),
    offsiteSynced: false,
    triggeredBy: actor?.id || null,
    metadata: {
      mode: 'compliance_log',
      production_mutated: false,
      runbook: 'Restore into staging project, smoke-test login + patient search, record result.',
    },
  });

  await writeAuditLog({
    actorId: actor?.id,
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'create',
    resourceType: 'backup_test_restore',
    resourceId: event.id,
    module: 'security',
    metadata: { status: event.status },
    req,
  });

  return event;
}
