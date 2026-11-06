-- Phase 4 — Restricted HIV portal + home dashboard alerts + reports foundation
-- Extends legacy hiv_* tables; adds HTS, ART numbers, VL/refill tracking, KPI views.

-- ---------------------------------------------------------------------------
-- Document sequences
-- ---------------------------------------------------------------------------
INSERT INTO public.document_sequences (kind, prefix, last_value) VALUES
  ('art', 'ART-', 0),
  ('hts', 'HTS-', 0)
ON CONFLICT (kind) DO NOTHING;

-- ---------------------------------------------------------------------------
-- HIV enrollments — ART client fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.hiv_enrollments
  ADD COLUMN IF NOT EXISTS art_no text,
  ADD COLUMN IF NOT EXISTS who_stage integer CHECK (who_stage IS NULL OR who_stage BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS regimen text,
  ADD COLUMN IF NOT EXISTS cd4 integer,
  ADD COLUMN IF NOT EXISTS last_viral_load numeric(14,2),
  ADD COLUMN IF NOT EXISTS last_vl_date date,
  ADD COLUMN IF NOT EXISTS next_vl_due date,
  ADD COLUMN IF NOT EXISTS vl_unsuppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tb_screening text,
  ADD COLUMN IF NOT EXISTS adherence text,
  ADD COLUMN IF NOT EXISTS next_refill_date date,
  ADD COLUMN IF NOT EXISTS months_dispensed integer,
  ADD COLUMN IF NOT EXISTS last_refill_date date,
  ADD COLUMN IF NOT EXISTS ltfu_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS hiv_enrollments_art_no_uidx
  ON public.hiv_enrollments (art_no) WHERE art_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS hiv_enrollments_refill_idx
  ON public.hiv_enrollments (next_refill_date)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS hiv_enrollments_vl_due_idx
  ON public.hiv_enrollments (next_vl_due)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- HTS (HIV testing services)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hiv_hts_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hts_no text,
  patient_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  client_name text,
  sex text,
  age_years integer,
  test_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  test_type text NOT NULL DEFAULT 'rapid'
    CHECK (test_type IN ('rapid','confirmatory','retest','other')),
  result text NOT NULL DEFAULT 'pending'
    CHECK (result IN ('pending','negative','positive','inconclusive')),
  counsellor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  linked_to_art boolean NOT NULL DEFAULT false,
  enrollment_id uuid REFERENCES public.hiv_enrollments(id) ON DELETE SET NULL,
  encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hiv_hts_hts_no_uidx
  ON public.hiv_hts_tests (hts_no) WHERE hts_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS hiv_hts_date_idx ON public.hiv_hts_tests (test_date);
CREATE INDEX IF NOT EXISTS hiv_hts_result_idx ON public.hiv_hts_tests (result);

-- ---------------------------------------------------------------------------
-- HIV visits extras
-- ---------------------------------------------------------------------------
ALTER TABLE public.hiv_visits
  ADD COLUMN IF NOT EXISTS adherence text,
  ADD COLUMN IF NOT EXISTS tb_screening text,
  ADD COLUMN IF NOT EXISTS regimen text,
  ADD COLUMN IF NOT EXISTS months_dispensed integer,
  ADD COLUMN IF NOT EXISTS next_refill_date date,
  ADD COLUMN IF NOT EXISTS refill_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prescription_id uuid,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- HIV lab results extras (VL / CD4)
-- ---------------------------------------------------------------------------
ALTER TABLE public.hiv_lab_results
  ADD COLUMN IF NOT EXISTS test_type text NOT NULL DEFAULT 'viral_load'
    CHECK (test_type IN ('viral_load','cd4','other')),
  ADD COLUMN IF NOT EXISTS unsuppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lab_order_id uuid,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hiv_lab_results_vl_idx
  ON public.hiv_lab_results (enrollment_id, result_date DESC);

-- ---------------------------------------------------------------------------
-- Charge hooks
-- ---------------------------------------------------------------------------
INSERT INTO public.charge_items (code, name, category, unit_price)
VALUES
  ('HIV-HTS', 'HIV testing (HTS)', 'hiv', 150),
  ('HIV-VL', 'HIV viral load', 'hiv', 400),
  ('HIV-CD4', 'HIV CD4 count', 'hiv', 350),
  ('HIV-ART-VISIT', 'ART clinic visit', 'hiv', 200)
ON CONFLICT (code) DO NOTHING;

UPDATE public.charge_items
  SET module_hint = 'hiv'
  WHERE code IN ('HIV-HTS','HIV-VL','HIV-CD4','HIV-ART-VISIT')
    AND (module_hint IS NULL OR module_hint = '');

-- ---------------------------------------------------------------------------
-- Home / HIV KPI view (today / active cohort)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_phase4_hiv_counts AS
SELECT
  (SELECT count(*)::int FROM public.hiv_enrollments
     WHERE status = 'active' AND art_started = true) AS hiv_on_art,
  (SELECT count(*)::int FROM public.hiv_enrollments
     WHERE status = 'active'
       AND next_refill_date = (timezone('utc', now())::date)) AS hiv_refills_due_today,
  (SELECT count(*)::int FROM public.hiv_enrollments
     WHERE status = 'active'
       AND next_refill_date < (timezone('utc', now())::date)
       AND next_refill_date IS NOT NULL) AS hiv_refills_missed,
  (SELECT count(*)::int FROM public.hiv_enrollments
     WHERE status = 'lost' OR ltfu_flag = true) AS hiv_ltfu,
  (SELECT count(*)::int FROM public.hiv_enrollments
     WHERE status = 'active'
       AND next_vl_due IS NOT NULL
       AND next_vl_due <= (timezone('utc', now())::date)) AS hiv_vl_due,
  (SELECT count(*)::int FROM public.hiv_enrollments
     WHERE status = 'active' AND vl_unsuppressed = true) AS hiv_unsuppressed,
  (SELECT CASE
     WHEN count(*) FILTER (WHERE status = 'active' AND art_started AND last_viral_load IS NOT NULL) = 0 THEN NULL
     ELSE round(
       100.0 * count(*) FILTER (
         WHERE status = 'active' AND art_started
           AND last_viral_load IS NOT NULL
           AND last_viral_load < 1000
       ) / NULLIF(count(*) FILTER (
         WHERE status = 'active' AND art_started AND last_viral_load IS NOT NULL
       ), 0), 1)
   END::numeric FROM public.hiv_enrollments) AS hiv_vl_suppressed_pct,
  (SELECT count(*)::int FROM public.hiv_hts_tests
     WHERE test_date = (timezone('utc', now())::date)) AS hiv_hts_today,
  (SELECT count(*)::int FROM public.hiv_hts_tests
     WHERE test_date = (timezone('utc', now())::date)
       AND result = 'positive') AS hiv_hts_positive_today;

REVOKE ALL ON TABLE public.hms_phase4_hiv_counts FROM anon, authenticated;
GRANT SELECT ON TABLE public.hms_phase4_hiv_counts TO service_role;

-- ---------------------------------------------------------------------------
-- Dashboard alerts helper view (row-shaped alerts built in API; counts here)
-- critical_lab_7d needs lab_order_items.is_critical (Phase 2). If that column
-- is missing, fall back to 0 so this migration still applies.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  has_critical boolean;
  critical_expr text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lab_order_items'
      AND column_name = 'is_critical'
  ) INTO has_critical;

  IF has_critical THEN
    critical_expr := $c$
      (SELECT count(*)::int FROM public.lab_order_items loi
         JOIN public.lab_orders lo ON lo.id = loi.order_id
         WHERE loi.is_critical = true
           AND loi.status IN ('resulted','verified','result_entered')
           AND lo.created_at::date >= (timezone('utc', now())::date - 7))
    $c$;
  ELSE
    critical_expr := '0::int';
  END IF;

  EXECUTE format($v$
    CREATE OR REPLACE VIEW public.hms_phase4_alert_counts AS
    SELECT
      (SELECT count(*)::int FROM public.medicines m
         WHERE COALESCE(m.is_active, true) = true
           AND COALESCE(m.stock_quantity, 0) <= COALESCE(m.reorder_level, m.low_stock_threshold, 10)) AS low_stock,
      (SELECT count(*)::int FROM public.immunization_card_doses
         WHERE status = 'overdue'
            OR (due_date < (timezone('utc', now())::date) AND status IN ('upcoming','due'))) AS imm_overdue,
      (SELECT count(*)::int FROM public.appointments
         WHERE clinic = 'anc'
           AND hms_status = 'missed'
           AND scheduled_at::date >= (timezone('utc', now())::date - 30)) AS anc_missed_30d,
      (SELECT count(*)::int FROM public.appointments
         WHERE clinic = 'hiv'
           AND hms_status = 'missed'
           AND scheduled_at::date >= (timezone('utc', now())::date - 30)) AS hiv_missed_30d,
      %s AS critical_lab_7d
  $v$, critical_expr);
END $$;

REVOKE ALL ON TABLE public.hms_phase4_alert_counts FROM anon, authenticated;
GRANT SELECT ON TABLE public.hms_phase4_alert_counts TO service_role;

-- ---------------------------------------------------------------------------
-- Admin security tiles (Administrator home section)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_phase4_admin_counts AS
SELECT
  (SELECT count(*)::int FROM public.profiles
     WHERE role IS NOT NULL
       AND role <> 'Patient'
       AND COALESCE(is_active, true) = true
       AND merged_into_id IS NULL) AS active_users,
  (SELECT count(DISTINCT role)::int FROM public.profiles
     WHERE role IS NOT NULL AND role <> 'Patient') AS role_count,
  (SELECT count(*)::int FROM public.audit_logs
     WHERE action = 'failed_login'
       AND created_at >= (timezone('utc', now()) - interval '24 hours')) AS failed_logins_24h,
  (SELECT count(*)::int FROM public.audit_logs
     WHERE action = 'export'
       AND created_at >= date_trunc('week', timezone('utc', now()))) AS exports_this_week,
  (SELECT count(*)::int FROM public.audit_logs
     WHERE action = 'export'
       AND created_at >= date_trunc('week', timezone('utc', now()))
       AND (metadata->>'format') = 'xlsx') AS exports_xlsx_week,
  (SELECT count(*)::int FROM public.audit_logs
     WHERE action = 'export'
       AND created_at >= date_trunc('week', timezone('utc', now()))
       AND (metadata->>'format') = 'pdf') AS exports_pdf_week;

REVOKE ALL ON TABLE public.hms_phase4_admin_counts FROM anon, authenticated;
GRANT SELECT ON TABLE public.hms_phase4_admin_counts TO service_role;

-- ---------------------------------------------------------------------------
-- RLS lock-down for HTS
-- ---------------------------------------------------------------------------
ALTER TABLE public.hiv_hts_tests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hiv_hts_tests FROM anon, authenticated;
GRANT ALL ON TABLE public.hiv_hts_tests TO service_role;
