-- Phase 6: fold existing modules (Doctors, ICU, Ambulance, Blood bank) into HMS shell.
-- Expand unified encounters.module allow-list + operational KPI view for Home/Reports.

-- ---------------------------------------------------------------------------
-- 1) Allow encounter modules for existing operational portals
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'encounters'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%module%';

  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.encounters DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.encounters
  ADD CONSTRAINT encounters_module_check CHECK (
    module IN (
      'opd', 'appointments', 'lab', 'pharmacy', 'anc', 'maternity', 'pnc',
      'immunization', 'fp', 'hiv', 'billing', 'records', 'other',
      'doctor', 'icu', 'ambulance', 'bloodbank'
    )
  );

COMMENT ON CONSTRAINT encounters_module_check ON public.encounters IS
  'Phase 6: includes doctor / icu / ambulance / bloodbank activity rows.';

-- ---------------------------------------------------------------------------
-- 2) Home dashboard KPIs for existing modules (shared patient FKs = profiles.id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_phase6_existing_counts AS
SELECT
  (SELECT count(*)::int FROM public.icu_beds WHERE status = 'occupied') AS icu_occupied_beds,
  (SELECT count(*)::int FROM public.icu_beds) AS icu_total_beds,
  (SELECT count(*)::int FROM public.icu_admission_requests WHERE request_status = 'pending') AS icu_pending_admissions,
  (SELECT count(*)::int
     FROM public.ambulance_requests
    WHERE status IN ('pending', 'assigned', 'en_route', 'arrived', 'patient_picked', 'arrived_at_hospital')
  ) AS ambulance_active_trips,
  (SELECT count(*)::int FROM public.ambulance_requests WHERE status = 'pending') AS ambulance_pending_trips,
  (SELECT count(*)::int
     FROM public.blood_requests
    WHERE request_status IN ('pending', 'approved')
  ) AS blood_pending_requests,
  (SELECT count(*)::int
     FROM public.blood_units
    WHERE status = 'available'
      AND expiry_date IS NOT NULL
      AND expiry_date <= (CURRENT_DATE + 14)
  ) AS blood_units_expiring_14d,
  (SELECT count(*)::int
     FROM public.encounters
    WHERE module = 'doctor'
      AND date_time::date = CURRENT_DATE
  ) AS doctor_encounters_today,
  (SELECT count(*)::int
     FROM public.encounters
    WHERE module = 'icu'
      AND date_time::date = CURRENT_DATE
  ) AS icu_encounters_today,
  (SELECT count(*)::int
     FROM public.encounters
    WHERE module = 'ambulance'
      AND date_time::date = CURRENT_DATE
  ) AS ambulance_encounters_today,
  (SELECT count(*)::int
     FROM public.encounters
    WHERE module = 'bloodbank'
      AND date_time::date = CURRENT_DATE
  ) AS bloodbank_encounters_today;

COMMENT ON VIEW public.hms_phase6_existing_counts IS
  'Phase 6 Home/Reports KPIs for Doctors, ICU, Ambulance, Blood bank.';

GRANT SELECT ON public.hms_phase6_existing_counts TO service_role;
