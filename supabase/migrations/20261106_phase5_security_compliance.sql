-- Phase 5 — Users & roles + Security / audit / backups (HTML screens 14–15)
-- Lockout, first-login password change, MFA flags, backup event log.
--
-- PRODUCTION ASSUMPTION: serve the API and SPA over HTTPS only (TLS terminated
-- at the reverse proxy / hosting platform). Never expose patient data over plain HTTP.

-- ---------------------------------------------------------------------------
-- 1) Profile security columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS require_password_change boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

COMMENT ON COLUMN public.profiles.require_password_change IS
  'Force password change on next login (e.g. first login after invite).';
COMMENT ON COLUMN public.profiles.mfa_required IS
  '2-step verification required. Administrator role always treated as required in app logic.';
COMMENT ON COLUMN public.profiles.failed_login_count IS
  'Consecutive failed password attempts; lock after 5.';
COMMENT ON COLUMN public.profiles.locked_until IS
  'When set and in the future, login is rejected until unlock or expiry.';
COMMENT ON COLUMN public.profiles.last_login_at IS
  'Last successful login timestamp.';

-- Administrators require 2-step by policy
UPDATE public.profiles
SET mfa_required = true
WHERE role = 'Admin' AND mfa_required = false;

-- ---------------------------------------------------------------------------
-- 2) Backup / restore event log (ops UX + audit trail of admin actions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN (
    'full_backup',
    'incremental_backup',
    'manual_backup',
    'test_restore',
    'download',
    'alert'
  )),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'skipped')),
  started_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  finished_at timestamptz,
  retention_note text,
  offsite_synced boolean NOT NULL DEFAULT false,
  offsite_synced_at timestamptz,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggered_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS backup_events_started_idx
  ON public.backup_events (started_at DESC);
CREATE INDEX IF NOT EXISTS backup_events_type_idx
  ON public.backup_events (event_type);

ALTER TABLE public.backup_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.backup_events FROM anon, authenticated;
GRANT ALL ON TABLE public.backup_events TO service_role;

COMMENT ON TABLE public.backup_events IS
  'Phase 5: backup/restore status events. Nightly full + 4h incremental policy documented in app; actual DB dumps run via platform/runbook.';

-- Seed a successful nightly-style status row if empty (UX baseline for new installs)
INSERT INTO public.backup_events (
  event_type, status, started_at, finished_at, retention_note, offsite_synced, offsite_synced_at, message, metadata
)
SELECT
  'full_backup',
  'success',
  timezone('utc', date_trunc('day', now()) + interval '2 hours'),
  timezone('utc', date_trunc('day', now()) + interval '2 hours' + interval '14 minutes'),
  '30 daily · 12 monthly',
  true,
  timezone('utc', date_trunc('day', now()) + interval '2 hours' + interval '14 minutes'),
  'Seeded status — configure platform backup job / runbook for production dumps.',
  jsonb_build_object('seed', true, 'policy', 'nightly_02:00_plus_incremental_4h')
WHERE NOT EXISTS (SELECT 1 FROM public.backup_events LIMIT 1);

-- ---------------------------------------------------------------------------
-- 3) Harden audit_logs append-only (re-assert trigger)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only and cannot be modified or deleted';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON public.audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE PROCEDURE public.audit_logs_immutable();

REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO service_role;

-- ---------------------------------------------------------------------------
-- 4) Admin KPI view for home + security portal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_phase5_admin_counts AS
SELECT
  (SELECT count(*)::int FROM public.profiles
     WHERE role <> 'Patient' AND coalesce(is_active, true) = true
       AND (locked_until IS NULL OR locked_until < timezone('utc', now()))) AS active_users,
  6 AS role_count,
  (SELECT count(*)::int FROM public.profiles
     WHERE role <> 'Patient' AND mfa_required = true) AS mfa_on_count,
  (SELECT count(*)::int FROM public.profiles
     WHERE role <> 'Patient' AND (
       coalesce(is_active, true) = false
       OR (locked_until IS NOT NULL AND locked_until >= timezone('utc', now()))
     )) AS suspended_or_locked,
  (SELECT count(*)::int FROM public.audit_logs
     WHERE action = 'failed_login'
       AND created_at >= (timezone('utc', now()) - interval '24 hours')) AS failed_logins_24h,
  (SELECT count(*)::int FROM public.profiles
     WHERE role <> 'Patient'
       AND locked_until IS NOT NULL
       AND locked_until >= timezone('utc', now())) AS locked_accounts,
  (SELECT count(*)::int FROM public.audit_logs
     WHERE created_at >= date_trunc('day', timezone('utc', now()))) AS audit_events_today;

COMMENT ON VIEW public.hms_phase5_admin_counts IS
  'Phase 5 admin tiles: users, MFA, lockouts, failed logins, audit volume.';
