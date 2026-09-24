-- JIMs modules: roles + OPD + follow-ups + billing + MCH + lab + immunization + FP + HIV
-- Apply after 20260917_* security migrations. Deny-by-default RLS; Express uses service_role.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'Midwife';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'Laboratory';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'Accounts';

-- ---------- OPD ----------
CREATE TABLE IF NOT EXISTS public.opd_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  doctor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  visit_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  token_no integer,
  chief_complaint text,
  triage_level text CHECK (triage_level IS NULL OR triage_level IN ('low','medium','high','critical')),
  vitals jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','triaged','in_consult','completed','cancelled')),
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opd_visits_date_idx ON public.opd_visits (visit_date DESC);
CREATE INDEX IF NOT EXISTS opd_visits_patient_idx ON public.opd_visits (patient_id);
CREATE INDEX IF NOT EXISTS opd_visits_status_idx ON public.opd_visits (status);

-- ---------- Follow-ups ----------
CREATE TABLE IF NOT EXISTS public.follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  related_appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  related_opd_visit_id uuid REFERENCES public.opd_visits(id) ON DELETE SET NULL,
  reason text,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','completed','cancelled','overdue')),
  completed_appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON public.follow_ups (due_date);
CREATE INDEX IF NOT EXISTS follow_ups_patient_idx ON public.follow_ups (patient_id);

-- ---------- Billing ----------
CREATE TABLE IF NOT EXISTS public.charge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text DEFAULT 'general',
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no text NOT NULL UNIQUE,
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  opd_visit_id uuid REFERENCES public.opd_visits(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','partial','paid','void')),
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_patient_idx ON public.invoices (patient_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON public.invoices (status);

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  charge_item_id uuid REFERENCES public.charge_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  method text NOT NULL DEFAULT 'cash'
    CHECK (method IN ('cash','card','mobile','insurance','other')),
  receipt_no text NOT NULL UNIQUE,
  paid_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON public.payments (invoice_id);

INSERT INTO public.charge_items (code, name, category, unit_price)
VALUES
  ('OPD-CONSULT', 'OPD Consultation', 'opd', 500),
  ('ANC-VISIT', 'Antenatal Visit', 'mch', 300),
  ('LAB-BASIC', 'Basic Lab Panel', 'lab', 800),
  ('DELIVERY', 'Delivery Fee', 'mch', 5000),
  ('IMM-DOSE', 'Immunization Dose', 'imm', 200),
  ('FP-METHOD', 'Family Planning Service', 'fp', 250)
ON CONFLICT (code) DO NOTHING;

-- ---------- MCH: ANC / Maternity / PNC ----------
CREATE TABLE IF NOT EXISTS public.anc_pregnancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lmp date,
  edd date,
  gravida integer,
  para integer,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','delivered','lost','closed')),
  risk_notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anc_pregnancies_patient_idx ON public.anc_pregnancies (patient_id);

CREATE TABLE IF NOT EXISTS public.anc_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pregnancy_id uuid NOT NULL REFERENCES public.anc_pregnancies(id) ON DELETE CASCADE,
  visit_no integer,
  visit_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  weight_kg numeric(6,2),
  bp_systolic integer,
  bp_diastolic integer,
  fundal_height_cm numeric(6,2),
  fetal_heart_rate integer,
  next_visit_date date,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anc_visits_pregnancy_idx ON public.anc_visits (pregnancy_id);

CREATE TABLE IF NOT EXISTS public.maternity_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pregnancy_id uuid REFERENCES public.anc_pregnancies(id) ON DELETE SET NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  ward text,
  bed text,
  status text NOT NULL DEFAULT 'in_labour'
    CHECK (status IN ('in_labour','delivered','discharged','transferred')),
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES public.maternity_admissions(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  mode text CHECK (mode IS NULL OR mode IN ('svd','assisted','cs','other')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('live_birth','stillbirth','neonatal_death')),
  complications text,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.newborns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES public.deliveries(id) ON DELETE CASCADE,
  sex text CHECK (sex IS NULL OR sex IN ('male','female','unknown')),
  birth_weight_g integer,
  apgar_1 integer,
  apgar_5 integer,
  linked_patient_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pnc_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mother_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  newborn_id uuid REFERENCES public.newborns(id) ON DELETE SET NULL,
  delivery_id uuid REFERENCES public.deliveries(id) ON DELETE SET NULL,
  visit_no integer,
  visit_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  mother_status text,
  baby_status text,
  next_visit_date date,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pnc_visits_mother_idx ON public.pnc_visits (mother_id);

-- ---------- Laboratory ----------
CREATE TABLE IF NOT EXISTS public.lab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  specimen_type text DEFAULT 'blood',
  unit text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lab_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ordered_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('ordered','collected','in_progress','completed','cancelled')),
  priority text NOT NULL DEFAULT 'routine'
    CHECK (priority IN ('routine','urgent','stat')),
  notes text,
  ordered_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lab_orders_status_idx ON public.lab_orders (status);
CREATE INDEX IF NOT EXISTS lab_orders_patient_idx ON public.lab_orders (patient_id);

CREATE TABLE IF NOT EXISTS public.lab_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.lab_orders(id) ON DELETE CASCADE,
  test_id uuid NOT NULL REFERENCES public.lab_tests(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resulted','verified','cancelled'))
);

CREATE TABLE IF NOT EXISTS public.lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL UNIQUE REFERENCES public.lab_order_items(id) ON DELETE CASCADE,
  value text,
  unit text,
  flagged boolean NOT NULL DEFAULT false,
  result_notes text,
  entered_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

INSERT INTO public.lab_tests (code, name, specimen_type, unit)
VALUES
  ('CBC', 'Complete Blood Count', 'blood', ''),
  ('HGB', 'Hemoglobin', 'blood', 'g/dL'),
  ('GLU', 'Blood Glucose', 'blood', 'mg/dL'),
  ('MAL', 'Malaria RDT', 'blood', ''),
  ('HIV-RDT', 'HIV Rapid Test', 'blood', ''),
  ('URINE', 'Urinalysis', 'urine', ''),
  ('CD4', 'CD4 Count', 'blood', 'cells/µL'),
  ('VL', 'HIV Viral Load', 'blood', 'copies/mL')
ON CONFLICT (code) DO NOTHING;

-- ---------- Immunization ----------
CREATE TABLE IF NOT EXISTS public.vaccines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  doses_required integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.immunization_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  vaccine_id uuid NOT NULL REFERENCES public.vaccines(id) ON DELETE RESTRICT,
  dose_no integer NOT NULL DEFAULT 1,
  given_at date NOT NULL DEFAULT (timezone('utc', now())::date),
  batch_no text,
  next_due date,
  given_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS immunization_patient_idx ON public.immunization_records (patient_id);
CREATE INDEX IF NOT EXISTS immunization_next_due_idx ON public.immunization_records (next_due);

INSERT INTO public.vaccines (code, name, doses_required)
VALUES
  ('BCG', 'BCG', 1),
  ('OPV', 'Oral Polio', 4),
  ('PENTA', 'Pentavalent', 3),
  ('MEASLES', 'Measles', 2),
  ('TT', 'Tetanus Toxoid', 5),
  ('COVID', 'COVID-19', 2)
ON CONFLICT (code) DO NOTHING;

-- ---------- Family planning ----------
CREATE TABLE IF NOT EXISTS public.fp_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fp_encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  method_id uuid REFERENCES public.fp_methods(id) ON DELETE SET NULL,
  provided_at date NOT NULL DEFAULT (timezone('utc', now())::date),
  quantity numeric(10,2),
  counseling_notes text,
  next_visit date,
  provided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_encounters_patient_idx ON public.fp_encounters (patient_id);

INSERT INTO public.fp_methods (code, name)
VALUES
  ('PILL', 'Oral contraceptive pills'),
  ('INJ', 'Injectable'),
  ('IUD', 'IUD'),
  ('IMPLANT', 'Implant'),
  ('CONDOM', 'Condoms'),
  ('NATURAL', 'Natural / counseling only')
ON CONFLICT (code) DO NOTHING;

-- ---------- HIV care ----------
CREATE TABLE IF NOT EXISTS public.hiv_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  enrollment_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','transferred','lost','dead','closed')),
  art_started boolean NOT NULL DEFAULT false,
  art_start_date date,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hiv_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES public.hiv_enrollments(id) ON DELETE CASCADE,
  visit_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  who_stage integer CHECK (who_stage IS NULL OR who_stage BETWEEN 1 AND 4),
  weight_kg numeric(6,2),
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hiv_lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES public.hiv_enrollments(id) ON DELETE CASCADE,
  result_date date NOT NULL DEFAULT (timezone('utc', now())::date),
  cd4 integer,
  viral_load numeric(14,2),
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- RLS lock-down for all new tables ----------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'opd_visits','follow_ups','charge_items','invoices','invoice_lines','payments',
    'anc_pregnancies','anc_visits','maternity_admissions','deliveries','newborns','pnc_visits',
    'lab_tests','lab_orders','lab_order_items','lab_results',
    'vaccines','immunization_records','fp_methods','fp_encounters',
    'hiv_enrollments','hiv_visits','hiv_lab_results'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

-- Enrich signup trigger role allow-list for new roles
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta_role text;
  resolved_role public.app_role;
  meta_phone text;
  meta_dob date;
  meta_consent boolean := false;
  meta_consent_at timestamptz := NULL;
  meta_consent_method text := NULL;
BEGIN
  meta_role := COALESCE(NEW.raw_user_meta_data->>'role', '');
  IF meta_role = '' THEN
    resolved_role := 'Patient';
  ELSIF meta_role IN (
    'GeneralUser','Patient','Doctor','Admin','Ambulance','ICU',
    'Pharmacy','BloodBank','Blood Bank','Volunteer',
    'Nurse','Receptionist','RecordsOfficer',
    'Midwife','Laboratory','Accounts'
  ) THEN
    resolved_role := meta_role::public.app_role;
  ELSE
    resolved_role := 'Patient';
  END IF;

  meta_phone := NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'phone', '')), '');
  BEGIN
    IF COALESCE(NEW.raw_user_meta_data->>'date_of_birth', '') <> '' THEN
      meta_dob := (NEW.raw_user_meta_data->>'date_of_birth')::date;
    END IF;
  EXCEPTION WHEN others THEN
    meta_dob := NULL;
  END;

  IF lower(COALESCE(NEW.raw_user_meta_data->>'data_consent', '')) IN ('true', '1', 'yes') THEN
    meta_consent := true;
    meta_consent_at := now();
    meta_consent_method := COALESCE(
      NULLIF(trim(NEW.raw_user_meta_data->>'data_consent_method'), ''),
      'self_signup'
    );
  END IF;

  INSERT INTO public.profiles (
    id, email, full_name, phone, date_of_birth, role, is_active,
    data_consent, data_consent_at, data_consent_method
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    meta_phone,
    meta_dob,
    resolved_role,
    true,
    meta_consent,
    meta_consent_at,
    meta_consent_method
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
