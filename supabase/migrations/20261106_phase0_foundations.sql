-- Phase 0 foundations: permission flags, unified encounters, expanded audit actions.
-- Shared patient identity remains public.profiles (role = 'Patient') with MRN.

-- ---------------------------------------------------------------------------
-- 1) Extra permission flags on profiles (HTML screen 14)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_access_hiv boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_verify_lab boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_give_discounts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_export_reports boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.can_access_hiv IS 'HMS flag: HIV access';
COMMENT ON COLUMN public.profiles.can_verify_lab IS 'HMS flag: can verify lab results';
COMMENT ON COLUMN public.profiles.can_give_discounts IS 'HMS flag: can give discounts/waivers';
COMMENT ON COLUMN public.profiles.can_export_reports IS 'HMS flag: can export reports';

-- Admins can export by default once column exists
UPDATE public.profiles
SET can_export_reports = true
WHERE role = 'Admin' AND can_export_reports = false;

-- ---------------------------------------------------------------------------
-- 2) Shared patient view (ONE patient model = profiles with MRN)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.patients AS
SELECT
  id,
  mrn AS patient_id,
  mrn,
  full_name,
  email,
  phone,
  date_of_birth,
  role,
  is_active,
  merged_into_id,
  data_consent,
  data_consent_at,
  data_consent_method,
  created_at,
  updated_at
FROM public.profiles
WHERE role = 'Patient' OR mrn IS NOT NULL;

COMMENT ON VIEW public.patients IS
  'Phase 0: logical patient record. Physical storage remains profiles (MRN/Patient ID). Never create per-module patient tables.';

-- ---------------------------------------------------------------------------
-- 3) Unified encounters / visits (used by all portals + home KPIs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  module text NOT NULL,
  staff_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  date_time timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'in_progress', 'done', 'urgent', 'cancelled', 'no_show')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_table text,
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounters_module_check CHECK (
    module IN (
      'opd', 'appointments', 'lab', 'pharmacy', 'anc', 'maternity', 'pnc',
      'immunization', 'fp', 'hiv', 'billing', 'records', 'other'
    )
  )
);

CREATE INDEX IF NOT EXISTS encounters_patient_idx ON public.encounters (patient_id);
CREATE INDEX IF NOT EXISTS encounters_module_date_idx ON public.encounters (module, date_time DESC);
CREATE INDEX IF NOT EXISTS encounters_status_idx ON public.encounters (status);
CREATE INDEX IF NOT EXISTS encounters_staff_idx ON public.encounters (staff_id);
CREATE INDEX IF NOT EXISTS encounters_source_idx ON public.encounters (source_table, source_id);

ALTER TABLE public.encounters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encounters FROM anon, authenticated;
GRANT ALL ON TABLE public.encounters TO service_role;

COMMENT ON TABLE public.encounters IS
  'Unified visit/encounter row written by every portal: patient_id, module, staff_id, date_time, status.';

-- ---------------------------------------------------------------------------
-- 4) Expand audit_logs actions + module column (HTML screen 15)
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS module text;

DO $$
DECLARE
  constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'audit_logs'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%action%';

  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.audit_logs DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (
    action IN (
      'view',
      'create',
      'edit',
      'delete',
      'delete_void',
      'login',
      'logout',
      'failed_login',
      'print',
      'export',
      'permission_change'
    )
  );

CREATE INDEX IF NOT EXISTS audit_logs_module_idx ON public.audit_logs (module);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON public.audit_logs (action);

COMMENT ON TABLE public.audit_logs IS
  'Append-only audit: login/logout/failed_login, view, create/edit/delete_void, print/export, permission_change.';
