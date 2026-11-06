-- Phase 3 — Full MCH suite (ANC, Maternity, PNC, Immunization, Family planning)
-- Extends legacy JIMS MCH tables; wires encounters, appointments, pharmacy, billing hooks.

-- ---------------------------------------------------------------------------
-- Document sequences for ANC / FP client numbers
-- ---------------------------------------------------------------------------
INSERT INTO public.document_sequences (kind, prefix, last_value) VALUES
  ('anc', 'ANC-', 0),
  ('fp', 'FP-', 0)
ON CONFLICT (kind) DO NOTHING;

-- ---------------------------------------------------------------------------
-- ANC pregnancies + visits
-- ---------------------------------------------------------------------------
ALTER TABLE public.anc_pregnancies
  ADD COLUMN IF NOT EXISTS anc_no text,
  ADD COLUMN IF NOT EXISTS blood_group text,
  ADD COLUMN IF NOT EXISTS hiv_status text,
  ADD COLUMN IF NOT EXISTS syphilis_status text,
  ADD COLUMN IF NOT EXISTS hb_g_dl numeric(5,2),
  ADD COLUMN IF NOT EXISTS previous_complications text,
  ADD COLUMN IF NOT EXISTS husband_name text,
  ADD COLUMN IF NOT EXISTS next_of_kin text,
  ADD COLUMN IF NOT EXISTS high_risk boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS high_risk_reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS multiple_pregnancy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS previous_cs boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referred_to_maternity_at timestamptz,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS anc_pregnancies_anc_no_uidx
  ON public.anc_pregnancies (anc_no) WHERE anc_no IS NOT NULL;

ALTER TABLE public.anc_visits
  ADD COLUMN IF NOT EXISTS gestational_age_weeks numeric(5,1),
  ADD COLUMN IF NOT EXISTS presentation text,
  ADD COLUMN IF NOT EXISTS oedema text,
  ADD COLUMN IF NOT EXISTS iptp_given boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS iron_folate_given boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS td_given boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bed_net_given boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS danger_signs text,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Maternity: labour board / partograph / delivery extras
-- ---------------------------------------------------------------------------
ALTER TABLE public.maternity_admissions
  ADD COLUMN IF NOT EXISTS gestational_age_weeks numeric(5,1),
  ADD COLUMN IF NOT EXISTS membranes text,
  ADD COLUMN IF NOT EXISTS cervix_cm numeric(4,1),
  ADD COLUMN IF NOT EXISTS contractions_per_10min integer,
  ADD COLUMN IF NOT EXISTS fhr integer,
  ADD COLUMN IF NOT EXISTS next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS discharged_at timestamptz,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.partograph_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES public.maternity_admissions(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  cervix_cm numeric(4,1),
  fhr integer,
  contractions_per_10min integer,
  bp_systolic integer,
  bp_diastolic integer,
  pulse integer,
  alert text,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partograph_admission_idx ON public.partograph_entries (admission_id, recorded_at);

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS attendant text,
  ADD COLUMN IF NOT EXISTS blood_loss_ml integer,
  ADD COLUMN IF NOT EXISTS placenta_complete boolean,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invoice_line_id uuid;

ALTER TABLE public.newborns
  ADD COLUMN IF NOT EXISTS bcg_given boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opv0_given boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mother_patient_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- PNC schedule (auto-created at delivery) + visit detail fields
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pnc_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mother_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  newborn_id uuid REFERENCES public.newborns(id) ON DELETE SET NULL,
  baby_patient_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  delivery_id uuid REFERENCES public.deliveries(id) ON DELETE SET NULL,
  visit_code text NOT NULL CHECK (visit_code IN ('pnc1_48h','pnc2_day3','pnc3_day7_14','pnc4_week6')),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked','arrived','completed','missed','cancelled')),
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  completed_visit_id uuid REFERENCES public.pnc_visits(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, visit_code)
);
CREATE INDEX IF NOT EXISTS pnc_schedules_due_idx ON public.pnc_schedules (due_date, status);
CREATE INDEX IF NOT EXISTS pnc_schedules_mother_idx ON public.pnc_schedules (mother_id);

ALTER TABLE public.pnc_visits
  ADD COLUMN IF NOT EXISTS visit_code text,
  ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES public.pnc_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mother_bp_systolic integer,
  ADD COLUMN IF NOT EXISTS mother_bp_diastolic integer,
  ADD COLUMN IF NOT EXISTS mother_temp_c numeric(4,1),
  ADD COLUMN IF NOT EXISTS bleeding text,
  ADD COLUMN IF NOT EXISTS breastfeeding text,
  ADD COLUMN IF NOT EXISTS mood_screen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fp_counselled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS baby_weight_kg numeric(5,2),
  ADD COLUMN IF NOT EXISTS baby_temp_c numeric(4,1),
  ADD COLUMN IF NOT EXISTS cord_status text,
  ADD COLUMN IF NOT EXISTS jaundice text,
  ADD COLUMN IF NOT EXISTS danger_signs text,
  ADD COLUMN IF NOT EXISTS is_urgent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Immunization: admin-configurable national schedule + child dose card
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.immunization_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaccine_code text NOT NULL,
  vaccine_name text NOT NULL,
  dose_no integer NOT NULL DEFAULT 1,
  age_days integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  medicine_id uuid REFERENCES public.medicines(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vaccine_code, dose_no)
);

INSERT INTO public.immunization_schedule (vaccine_code, vaccine_name, dose_no, age_days, sort_order)
VALUES
  ('BCG', 'BCG', 1, 0, 10),
  ('OPV', 'OPV 0', 1, 0, 20),
  ('HEPB', 'HepB birth', 1, 0, 30),
  ('OPV', 'OPV 1', 2, 42, 40),
  ('PENTA', 'Penta 1', 1, 42, 50),
  ('PCV', 'PCV 1', 1, 42, 60),
  ('ROTA', 'Rota 1', 1, 42, 70),
  ('OPV', 'OPV 2', 3, 70, 80),
  ('PENTA', 'Penta 2', 2, 70, 90),
  ('PCV', 'PCV 2', 2, 70, 100),
  ('ROTA', 'Rota 2', 2, 70, 110),
  ('OPV', 'OPV 3', 4, 98, 120),
  ('PENTA', 'Penta 3', 3, 98, 130),
  ('PCV', 'PCV 3', 3, 98, 140),
  ('IPV', 'IPV', 1, 98, 150),
  ('VITA', 'Vitamin A', 1, 180, 160),
  ('MR', 'MR 1', 1, 274, 170),
  ('YF', 'Yellow fever', 1, 274, 180),
  ('MR', 'MR 2', 2, 548, 190)
ON CONFLICT (vaccine_code, dose_no) DO NOTHING;

-- Ensure vaccine catalogue covers schedule codes
INSERT INTO public.vaccines (code, name, doses_required)
VALUES
  ('BCG', 'BCG', 1),
  ('OPV', 'Oral Polio', 4),
  ('HEPB', 'Hepatitis B', 1),
  ('PENTA', 'Pentavalent', 3),
  ('PCV', 'Pneumococcal', 3),
  ('ROTA', 'Rotavirus', 2),
  ('IPV', 'Inactivated Polio', 1),
  ('VITA', 'Vitamin A', 1),
  ('MR', 'Measles-Rubella', 2),
  ('YF', 'Yellow fever', 1),
  ('TT', 'Tetanus Toxoid', 5),
  ('COVID', 'COVID-19', 2)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.immunization_card_doses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES public.immunization_schedule(id) ON DELETE SET NULL,
  vaccine_code text NOT NULL,
  dose_no integer NOT NULL DEFAULT 1,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming','due','overdue','given','skipped')),
  given_at date,
  batch_no text,
  site text,
  reaction_notes text,
  record_id uuid REFERENCES public.immunization_records(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  medicine_id uuid REFERENCES public.medicines(id) ON DELETE SET NULL,
  stock_movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, vaccine_code, dose_no)
);
CREATE INDEX IF NOT EXISTS imm_card_due_idx ON public.immunization_card_doses (due_date, status);
CREATE INDEX IF NOT EXISTS imm_card_patient_idx ON public.immunization_card_doses (patient_id);

ALTER TABLE public.immunization_records
  ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES public.immunization_schedule(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS card_dose_id uuid REFERENCES public.immunization_card_doses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS site text,
  ADD COLUMN IF NOT EXISTS medicine_id uuid REFERENCES public.medicines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_movement_id uuid;

ALTER TABLE public.vaccines
  ADD COLUMN IF NOT EXISTS medicine_id uuid REFERENCES public.medicines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS age_days_default integer;

-- ---------------------------------------------------------------------------
-- Family planning
-- ---------------------------------------------------------------------------
ALTER TABLE public.fp_methods
  ADD COLUMN IF NOT EXISTS default_resupply_days integer,
  ADD COLUMN IF NOT EXISTS medicine_id uuid REFERENCES public.medicines(id) ON DELETE SET NULL;

UPDATE public.fp_methods SET default_resupply_days = 28 WHERE code = 'PILL' AND default_resupply_days IS NULL;
UPDATE public.fp_methods SET default_resupply_days = 90 WHERE code = 'INJ' AND default_resupply_days IS NULL;
UPDATE public.fp_methods SET default_resupply_days = 1095 WHERE code = 'IMPLANT' AND default_resupply_days IS NULL;
UPDATE public.fp_methods SET default_resupply_days = 3650 WHERE code = 'IUD' AND default_resupply_days IS NULL;
UPDATE public.fp_methods SET default_resupply_days = 30 WHERE code = 'CONDOM' AND default_resupply_days IS NULL;
UPDATE public.fp_methods SET default_resupply_days = NULL WHERE code = 'NATURAL';

INSERT INTO public.fp_methods (code, name, default_resupply_days)
VALUES ('PERM', 'Permanent (tubal / vasectomy)', NULL)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.fp_encounters
  ADD COLUMN IF NOT EXISTS fp_no text,
  ADD COLUMN IF NOT EXISTS client_type text CHECK (client_type IS NULL OR client_type IN ('new','continuing','switched','stopped')),
  ADD COLUMN IF NOT EXISTS method_code text,
  ADD COLUMN IF NOT EXISTS bp_systolic integer,
  ADD COLUMN IF NOT EXISTS bp_diastolic integer,
  ADD COLUMN IF NOT EXISTS weight_kg numeric(6,2),
  ADD COLUMN IF NOT EXISTS side_effects text,
  ADD COLUMN IF NOT EXISTS medicine_id uuid REFERENCES public.medicines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_movement_id uuid,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'method_given'
    CHECK (status IN ('counselled','method_given','resupply_due','continuing','switched','stopped'));

CREATE INDEX IF NOT EXISTS fp_encounters_next_visit_idx ON public.fp_encounters (next_visit);

-- ---------------------------------------------------------------------------
-- Charge hooks already seeded in Phase 2 / JIMS — ensure present
-- ---------------------------------------------------------------------------
INSERT INTO public.charge_items (code, name, category, unit_price)
VALUES
  ('ANC-VISIT', 'Antenatal Visit', 'mch', 300),
  ('IMM-DOSE', 'Immunization Dose', 'imm', 200),
  ('FP-METHOD', 'Family Planning Service', 'fp', 250),
  ('MAT-DELIVERY', 'Delivery fee', 'maternity', 5000),
  ('MAT-BED-DAY', 'Maternity bed day', 'maternity', 800)
ON CONFLICT (code) DO NOTHING;

UPDATE public.charge_items SET module_hint = 'maternity' WHERE code IN ('MAT-DELIVERY','MAT-BED-DAY') AND (module_hint IS NULL OR module_hint = '');
UPDATE public.charge_items SET module_hint = 'mch' WHERE code = 'ANC-VISIT' AND (module_hint IS NULL OR module_hint = '');
UPDATE public.charge_items SET module_hint = 'imm' WHERE code = 'IMM-DOSE' AND (module_hint IS NULL OR module_hint = '');
UPDATE public.charge_items SET module_hint = 'fp' WHERE code = 'FP-METHOD' AND (module_hint IS NULL OR module_hint = '');

-- ---------------------------------------------------------------------------
-- Home / KPI view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_phase3_mch_counts AS
SELECT
  (SELECT count(*)::int FROM public.anc_pregnancies WHERE status = 'active') AS anc_active,
  (SELECT count(*)::int FROM public.anc_visits WHERE visit_date = (timezone('utc', now())::date)) AS anc_visits_today,
  (SELECT count(*)::int FROM public.anc_pregnancies WHERE status = 'active' AND high_risk = true) AS anc_high_risk,
  (SELECT count(*)::int FROM public.anc_pregnancies
     WHERE status = 'active'
       AND edd IS NOT NULL
       AND edd <= (timezone('utc', now())::date + 14)
       AND edd >= (timezone('utc', now())::date)) AS anc_due_2w,
  (SELECT count(*)::int FROM public.maternity_admissions WHERE status = 'in_labour') AS maternity_in_labour,
  (SELECT count(*)::int FROM public.deliveries
     WHERE delivered_at::date = (timezone('utc', now())::date)) AS deliveries_today,
  (SELECT count(*)::int FROM public.deliveries
     WHERE date_trunc('month', delivered_at) = date_trunc('month', timezone('utc', now()))) AS deliveries_mtd,
  (SELECT count(DISTINCT mother_id)::int FROM public.pnc_schedules
     WHERE status IN ('booked','arrived') ) AS pnc_mothers_active,
  (SELECT count(*)::int FROM public.pnc_schedules
     WHERE due_date = (timezone('utc', now())::date)
       AND status IN ('booked','arrived')) AS pnc_due_today,
  (SELECT count(*)::int FROM public.pnc_schedules
     WHERE due_date < (timezone('utc', now())::date)
       AND status IN ('booked','arrived','missed')) AS pnc_overdue,
  (SELECT count(DISTINCT patient_id)::int FROM public.immunization_card_doses) AS imm_children,
  (SELECT count(*)::int FROM public.immunization_card_doses
     WHERE due_date BETWEEN (timezone('utc', now())::date)
                        AND (timezone('utc', now())::date + 7)
       AND status IN ('upcoming','due')) AS imm_due_week,
  (SELECT count(*)::int FROM public.immunization_card_doses
     WHERE status = 'overdue'
        OR (due_date < (timezone('utc', now())::date) AND status IN ('upcoming','due'))) AS imm_overdue,
  (SELECT count(*)::int FROM public.immunization_records
     WHERE given_at = (timezone('utc', now())::date)) AS imm_given_today,
  (SELECT count(*)::int FROM public.fp_encounters
     WHERE provided_at = (timezone('utc', now())::date)) AS fp_clients_today,
  (SELECT count(*)::int FROM public.fp_encounters
     WHERE client_type = 'new'
       AND date_trunc('month', provided_at::timestamptz) = date_trunc('month', timezone('utc', now()))) AS fp_new_mtd,
  (SELECT count(*)::int FROM public.fp_encounters
     WHERE client_type = 'continuing'
       AND date_trunc('month', provided_at::timestamptz) = date_trunc('month', timezone('utc', now()))) AS fp_continuing_mtd,
  (SELECT count(*)::int FROM public.fp_encounters
     WHERE next_visit IS NOT NULL
       AND next_visit < (timezone('utc', now())::date)
       AND status IN ('method_given','continuing','resupply_due')) AS fp_resupply_overdue;

REVOKE ALL ON TABLE public.hms_phase3_mch_counts FROM anon, authenticated;
GRANT SELECT ON TABLE public.hms_phase3_mch_counts TO service_role;

-- RLS for new tables
ALTER TABLE public.partograph_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pnc_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.immunization_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.immunization_card_doses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.partograph_entries FROM anon, authenticated;
REVOKE ALL ON TABLE public.pnc_schedules FROM anon, authenticated;
REVOKE ALL ON TABLE public.immunization_schedule FROM anon, authenticated;
REVOKE ALL ON TABLE public.immunization_card_doses FROM anon, authenticated;

GRANT ALL ON TABLE public.partograph_entries TO service_role;
GRANT ALL ON TABLE public.pnc_schedules TO service_role;
GRANT ALL ON TABLE public.immunization_schedule TO service_role;
GRANT ALL ON TABLE public.immunization_card_doses TO service_role;
