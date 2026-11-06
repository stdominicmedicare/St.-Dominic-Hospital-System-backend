-- Phase 1 — Core patient flow spine (screens 13 Patients, 01 OPD, 02 Appointments)
-- Depends on Phase 0 foundations. Compatible with Phase 2 OPD handoffs.

-- ---------------------------------------------------------------------------
-- 1) Patient demographics (HTML screen 13 yellow box)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS middle_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS sex text
    CHECK (sex IS NULL OR sex IN ('female', 'male', 'other', 'unknown')),
  ADD COLUMN IF NOT EXISTS national_id text,
  ADD COLUMN IF NOT EXISTS insurance_scheme text
    CHECK (insurance_scheme IS NULL OR insurance_scheme IN ('none', 'nhis', 'private')),
  ADD COLUMN IF NOT EXISTS insurance_member_no text,
  ADD COLUMN IF NOT EXISTS address_village text,
  ADD COLUMN IF NOT EXISTS next_of_kin text,
  ADD COLUMN IF NOT EXISTS next_of_kin_phone text,
  ADD COLUMN IF NOT EXISTS blood_group text,
  ADD COLUMN IF NOT EXISTS allergies text,
  ADD COLUMN IF NOT EXISTS chronic_conditions text,
  ADD COLUMN IF NOT EXISTS sms_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS photo_url text;

COMMENT ON COLUMN public.profiles.sex IS 'HMS patient sex';
COMMENT ON COLUMN public.profiles.insurance_scheme IS 'none | nhis | private';
COMMENT ON COLUMN public.profiles.sms_consent IS 'Consent to SMS appointment reminders';

-- CREATE OR REPLACE cannot insert/reorder view columns (42P16). Drop + recreate.
DROP VIEW IF EXISTS public.patients;
CREATE VIEW public.patients AS
SELECT
  id,
  mrn AS patient_id,
  mrn,
  full_name,
  first_name,
  middle_name,
  last_name,
  sex,
  email,
  phone,
  date_of_birth,
  national_id,
  insurance_scheme,
  insurance_member_no,
  address_village,
  next_of_kin,
  next_of_kin_phone,
  blood_group,
  allergies,
  chronic_conditions,
  sms_consent,
  photo_url,
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
  'Phase 1: logical patient record. Physical storage remains profiles (MRN/Patient ID).';
GRANT SELECT ON public.patients TO service_role;

-- ---------------------------------------------------------------------------
-- 2) OPD workflow statuses (align with HTML + Phase 2 in_consultation)
-- ---------------------------------------------------------------------------
ALTER TABLE public.opd_visits
  ADD COLUMN IF NOT EXISTS visit_type text DEFAULT 'new'
    CHECK (visit_type IS NULL OR visit_type IN ('new', 'revisit')),
  ADD COLUMN IF NOT EXISTS history text,
  ADD COLUMN IF NOT EXISTS examination text,
  ADD COLUMN IF NOT EXISTS diagnosis text,
  ADD COLUMN IF NOT EXISTS diagnosis_icd10 text,
  ADD COLUMN IF NOT EXISTS plan text,
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_urgent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage text;

DO $$
DECLARE
  constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'opd_visits'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%status%';

  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.opd_visits DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.opd_visits
  ADD CONSTRAINT opd_visits_status_check CHECK (
    status IN (
      'check_in',
      'waiting',
      'triage',
      'triaged',
      'waiting_doctor',
      'in_consult',
      'in_consultation',
      'lab_pharmacy',
      'billing',
      'completed',
      'cancelled'
    )
  );

CREATE INDEX IF NOT EXISTS opd_visits_urgent_idx ON public.opd_visits (visit_date, is_urgent DESC, token_no);
CREATE INDEX IF NOT EXISTS opd_visits_checked_in_idx ON public.opd_visits (checked_in_at);

COMMENT ON COLUMN public.opd_visits.is_urgent IS
  'True when vitals breach BP≥160/110, temp≥38.5, or SpO2<92 — sort to top of queue';

-- ---------------------------------------------------------------------------
-- 3) Appointments — clinic booking + HMS workflow (screen 02)
--    Keep legacy appointment_status enum; drive UI from hms_status.
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS clinic text
    CHECK (clinic IS NULL OR clinic IN ('opd', 'anc', 'pnc', 'immunization', 'fp', 'hiv')),
  ADD COLUMN IF NOT EXISTS hms_status text NOT NULL DEFAULT 'booked'
    CHECK (hms_status IN ('booked', 'reminded', 'arrived', 'seen', 'missed')),
  ADD COLUMN IF NOT EXISTS slot_start timestamptz,
  ADD COLUMN IF NOT EXISTS slot_end timestamptz,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS reminder_phone text,
  ADD COLUMN IF NOT EXISTS reminder_sms boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS missed_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_module text,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- doctor_id was NOT NULL historically; allow nurse/midwife bookings without a doctor
DO $$
BEGIN
  ALTER TABLE public.appointments ALTER COLUMN doctor_id DROP NOT NULL;
EXCEPTION WHEN others THEN
  NULL;
END $$;

UPDATE public.appointments
SET clinic = COALESCE(clinic, 'opd'),
    slot_start = COALESCE(slot_start, scheduled_at),
    hms_status = CASE
      WHEN status::text = 'completed' THEN 'seen'
      WHEN status::text = 'cancelled' THEN 'missed'
      WHEN status::text = 'confirmed' THEN 'reminded'
      ELSE COALESCE(hms_status, 'booked')
    END
WHERE clinic IS NULL OR slot_start IS NULL;

CREATE INDEX IF NOT EXISTS appointments_clinic_date_idx
  ON public.appointments (clinic, scheduled_at);
CREATE INDEX IF NOT EXISTS appointments_hms_status_idx
  ON public.appointments (hms_status);
CREATE INDEX IF NOT EXISTS appointments_slot_provider_idx
  ON public.appointments (doctor_id, slot_start)
  WHERE doctor_id IS NOT NULL AND hms_status NOT IN ('missed', 'seen');

-- Prevent double-booking the same provider slot (active bookings only)
CREATE UNIQUE INDEX IF NOT EXISTS appointments_no_double_book_uidx
  ON public.appointments (doctor_id, slot_start)
  WHERE doctor_id IS NOT NULL
    AND slot_start IS NOT NULL
    AND hms_status IN ('booked', 'reminded', 'arrived');

-- ---------------------------------------------------------------------------
-- 4) Home KPI helper view (Phase 1 tiles + Phase 2 pending)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_phase1_counts AS
SELECT
  (SELECT COUNT(*) FROM public.opd_visits
    WHERE visit_date = (timezone('utc', now()))::date
      AND status <> 'cancelled') AS opd_visits_today,
  (SELECT COUNT(*) FROM public.opd_visits
    WHERE visit_date = (timezone('utc', now()))::date
      AND status IN ('waiting', 'check_in', 'triage', 'triaged')) AS opd_waiting_triage,
  (SELECT COUNT(*) FROM public.opd_visits
    WHERE visit_date = (timezone('utc', now()))::date
      AND status IN ('waiting_doctor', 'waiting')
      AND COALESCE(is_urgent, false) = false) AS opd_waiting_doctor,
  (SELECT COUNT(*) FROM public.appointments
    WHERE scheduled_at::date = (timezone('utc', now()))::date
      AND hms_status <> 'missed') AS appointments_today,
  (SELECT COUNT(*) FROM public.appointments
    WHERE scheduled_at::date = (timezone('utc', now()))::date
      AND hms_status = 'missed') AS appointments_missed_today,
  (SELECT COUNT(*) FROM public.appointments
    WHERE hms_status = 'missed'
      AND scheduled_at::date >= (timezone('utc', now()))::date - 30) AS defaulters_30d,
  (SELECT COUNT(*) FROM public.profiles
    WHERE role = 'Patient' AND merged_into_id IS NULL AND is_active = true) AS total_patients,
  (SELECT COUNT(*) FROM public.profiles
    WHERE role = 'Patient' AND merged_into_id IS NULL
      AND created_at::date = (timezone('utc', now()))::date) AS patients_registered_today;

COMMENT ON VIEW public.hms_phase1_counts IS
  'Phase 1 Home tiles: OPD / appointments / patients counts for today.';

GRANT SELECT ON public.hms_phase1_counts TO service_role;
GRANT SELECT ON public.patients TO service_role;
