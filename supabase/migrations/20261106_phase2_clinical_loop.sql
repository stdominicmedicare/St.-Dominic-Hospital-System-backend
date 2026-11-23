-- Phase 2: Laboratory → Pharmacy (FEFO) → Billing clinical loop.
-- Aligns existing JIMS lab/pharmacy/billing tables with St Dominic HMS HTML screens 03, 04, 11.

-- ---------------------------------------------------------------------------
-- 0) Document sequences (invoice / receipt / lab request / credit note)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_sequences (
  kind text PRIMARY KEY,
  prefix text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.document_sequences (kind, prefix, last_value) VALUES
  ('invoice', 'INV-', 0),
  ('receipt', 'RC-', 0),
  ('lab_request', 'LR-', 0),
  ('credit_note', 'CN-', 0),
  ('grn', 'GRN-', 0)
ON CONFLICT (kind) DO NOTHING;

ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.document_sequences FROM anon, authenticated;
GRANT ALL ON TABLE public.document_sequences TO service_role;

CREATE OR REPLACE FUNCTION public.hms_next_document_no(p_kind text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefix text;
  v_next bigint;
BEGIN
  UPDATE public.document_sequences
  SET last_value = last_value + 1,
      updated_at = now()
  WHERE kind = p_kind
  RETURNING prefix, last_value INTO v_prefix, v_next;

  IF NOT FOUND THEN
    INSERT INTO public.document_sequences (kind, prefix, last_value)
    VALUES (p_kind, upper(p_kind) || '-', 1)
    RETURNING prefix, last_value INTO v_prefix, v_next;
  END IF;

  RETURN v_prefix || lpad(v_next::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.hms_next_document_no(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hms_next_document_no(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 1) Billing: price list already = charge_items; extend invoices + credit notes
-- ---------------------------------------------------------------------------
ALTER TABLE public.charge_items
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS module_hint text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS discount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_scheme text,
  ADD COLUMN IF NOT EXISTS insurance_member_no text,
  ADD COLUMN IF NOT EXISTS source_modules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS waived_reason text,
  ADD COLUMN IF NOT EXISTS waived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS waived_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

DO $$
DECLARE constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public' AND rel.relname = 'invoices'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%status%';
  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.invoices DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check CHECK (
    status IN ('draft', 'open', 'issued', 'partial', 'paid', 'waived', 'insurance_claim', 'void')
  );

-- Normalize legacy statuses toward HTML wording (issued ≈ open)
UPDATE public.invoices SET status = 'open' WHERE status = 'issued';
UPDATE public.invoices SET status = 'open' WHERE status = 'draft';

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS source_module text,
  ADD COLUMN IF NOT EXISTS source_table text,
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_no text NOT NULL UNIQUE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_notes FROM anon, authenticated;
GRANT ALL ON TABLE public.credit_notes TO service_role;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS cashier_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

DO $$
DECLARE constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public' AND rel.relname = 'payments'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%method%';
  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.payments DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_check CHECK (
    method IN ('cash', 'mobile_money', 'mobile', 'card', 'insurance', 'other')
  );

INSERT INTO public.charge_items (code, name, category, unit_price, module_hint)
VALUES
  ('OPD-CONSULT', 'OPD Consultation', 'opd', 500, 'opd'),
  ('LAB-DEFAULT', 'Laboratory test (default)', 'lab', 800, 'lab'),
  ('RX-DEFAULT', 'Pharmacy item (default)', 'pharmacy', 100, 'pharmacy'),
  ('MAT-DELIVERY', 'Delivery fee (hook)', 'maternity', 5000, 'maternity'),
  ('MAT-BED-DAY', 'Maternity bed day (hook)', 'maternity', 800, 'maternity'),
  ('HIV-VL', 'HIV viral load (hook)', 'hiv', 1500, 'hiv'),
  ('HIV-CD4', 'HIV CD4 count (hook)', 'hiv', 1200, 'hiv')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  unit_price = EXCLUDED.unit_price,
  module_hint = EXCLUDED.module_hint,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2) Laboratory catalogue + workflow (screen 03)
-- ---------------------------------------------------------------------------
ALTER TABLE public.lab_tests
  ADD COLUMN IF NOT EXISTS ref_low numeric,
  ADD COLUMN IF NOT EXISTS ref_high numeric,
  ADD COLUMN IF NOT EXISTS critical_low numeric,
  ADD COLUMN IF NOT EXISTS critical_high numeric,
  ADD COLUMN IF NOT EXISTS price numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_item_id uuid REFERENCES public.charge_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.lab_tests t
SET price = COALESCE(NULLIF(t.price, 0), ci.unit_price, 800),
    charge_item_id = COALESCE(t.charge_item_id, ci.id)
FROM public.charge_items ci
WHERE ci.code = 'LAB-DEFAULT' AND (t.price = 0 OR t.charge_item_id IS NULL);

UPDATE public.lab_tests SET ref_low = 12, ref_high = 16, critical_low = 7, critical_high = 20, price = 400
WHERE code = 'HGB' AND (ref_low IS NULL OR price = 0 OR price = 800);
UPDATE public.lab_tests SET ref_low = 70, ref_high = 110, critical_low = 40, critical_high = 400, price = 350
WHERE code = 'GLU' AND ref_low IS NULL;
UPDATE public.lab_tests SET price = 500 WHERE code = 'MAL' AND price IN (0, 800);
UPDATE public.lab_tests SET price = 300 WHERE code = 'URINE' AND price IN (0, 800);
UPDATE public.lab_tests SET price = 900 WHERE code = 'CBC' AND price IN (0, 800);

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS request_no text,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'OPD',
  ADD COLUMN IF NOT EXISTS opd_visit_id uuid REFERENCES public.opd_visits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sample_type text,
  ADD COLUMN IF NOT EXISTS sample_id text,
  ADD COLUMN IF NOT EXISTS collected_at timestamptz,
  ADD COLUMN IF NOT EXISTS collected_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_line_ids uuid[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_request_no_uidx
  ON public.lab_orders (request_no) WHERE request_no IS NOT NULL;

DO $$
DECLARE constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public' AND rel.relname = 'lab_orders'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%status%';
  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lab_orders DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.lab_orders
  ADD CONSTRAINT lab_orders_status_check CHECK (
    status IN (
      'requested', 'ordered',
      'sample_collected', 'collected',
      'in_progress',
      'result_entered',
      'verified',
      'sent',
      'completed',
      'cancelled'
    )
  );

UPDATE public.lab_orders SET status = 'requested' WHERE status = 'ordered';
UPDATE public.lab_orders SET status = 'sample_collected' WHERE status = 'collected';
UPDATE public.lab_orders SET status = 'verified' WHERE status = 'completed';

DO $$
DECLARE constr_name text;
BEGIN
  SELECT con.conname INTO constr_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public' AND rel.relname = 'lab_order_items'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%status%';
  IF constr_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lab_order_items DROP CONSTRAINT %I', constr_name);
  END IF;
END $$;

ALTER TABLE public.lab_order_items
  ADD CONSTRAINT lab_order_items_status_check CHECK (
    status IN ('pending', 'sample_collected', 'in_progress', 'resulted', 'result_entered', 'verified', 'sent', 'cancelled')
  );

ALTER TABLE public.lab_results
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS flag text,
  ADD COLUMN IF NOT EXISTS is_critical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ref_low numeric,
  ADD COLUMN IF NOT EXISTS ref_high numeric;

-- Version history when verified results are corrected
CREATE TABLE IF NOT EXISTS public.lab_result_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES public.lab_results(id) ON DELETE CASCADE,
  version integer NOT NULL,
  value text,
  unit text,
  flag text,
  is_critical boolean NOT NULL DEFAULT false,
  result_notes text,
  entered_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  change_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS lab_result_versions_uidx
  ON public.lab_result_versions (result_id, version);

ALTER TABLE public.lab_result_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lab_result_versions FROM anon, authenticated;
GRANT ALL ON TABLE public.lab_result_versions TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Pharmacy batches + stock_movements (screen 04) — never edit qty directly
-- ---------------------------------------------------------------------------
ALTER TABLE public.medicines
  ADD COLUMN IF NOT EXISTS strength text,
  ADD COLUMN IF NOT EXISTS form text,
  ADD COLUMN IF NOT EXISTS reorder_level integer,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selling_price numeric(12,2),
  ADD COLUMN IF NOT EXISTS supplier text,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE public.medicines
SET reorder_level = COALESCE(reorder_level, low_stock_threshold, 10),
    selling_price = COALESCE(selling_price, price_per_unit, 0)
WHERE reorder_level IS NULL OR selling_price IS NULL;

CREATE TABLE IF NOT EXISTS public.medicine_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id uuid NOT NULL REFERENCES public.medicines(id) ON DELETE RESTRICT,
  batch_no text NOT NULL,
  expiry_date date NOT NULL,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_cost numeric(12,2) NOT NULL DEFAULT 0,
  selling_price numeric(12,2),
  supplier text,
  received_at timestamptz NOT NULL DEFAULT now(),
  grn_no text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medicine_id, batch_no)
);

CREATE INDEX IF NOT EXISTS medicine_batches_fefo_idx
  ON public.medicine_batches (medicine_id, expiry_date ASC)
  WHERE is_active = true AND quantity > 0;

ALTER TABLE public.medicine_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.medicine_batches FROM anon, authenticated;
GRANT ALL ON TABLE public.medicine_batches TO service_role;

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id uuid NOT NULL REFERENCES public.medicines(id) ON DELETE RESTRICT,
  batch_id uuid REFERENCES public.medicine_batches(id) ON DELETE SET NULL,
  movement_type text NOT NULL
    CHECK (movement_type IN ('receive', 'dispense', 'adjust', 'expire')),
  quantity_delta integer NOT NULL,
  quantity_before integer NOT NULL,
  quantity_after integer NOT NULL,
  reason text,
  reference_type text,
  reference_id uuid,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_movements_medicine_idx ON public.stock_movements (medicine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_batch_idx ON public.stock_movements (batch_id);
CREATE INDEX IF NOT EXISTS stock_movements_ref_idx ON public.stock_movements (reference_type, reference_id);

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stock_movements FROM anon, authenticated;
GRANT ALL ON TABLE public.stock_movements TO service_role;

-- Seed batches from existing medicine rows that have stock but no batch yet
INSERT INTO public.medicine_batches (medicine_id, batch_no, expiry_date, quantity, unit_cost, selling_price, supplier)
SELECT
  m.id,
  'LEGACY-' || substr(replace(m.id::text, '-', ''), 1, 8),
  COALESCE(m.expiry_date, (CURRENT_DATE + INTERVAL '365 days')::date),
  GREATEST(m.stock_quantity, 0),
  COALESCE(m.unit_cost, 0),
  COALESCE(m.selling_price, m.price_per_unit, 0),
  m.supplier
FROM public.medicines m
WHERE COALESCE(m.stock_quantity, 0) > 0
  AND NOT EXISTS (SELECT 1 FROM public.medicine_batches b WHERE b.medicine_id = m.id)
ON CONFLICT DO NOTHING;

-- NOTE: Do NOT ADD VALUE 'partial' to prescription_status in this same migration.
-- Postgres forbids using a newly added enum label until the txn commits (55P04).
-- Partially dispensed Rx uses existing enum value 'active' instead.

ALTER TABLE public.prescriptions
  ADD COLUMN IF NOT EXISTS opd_visit_id uuid REFERENCES public.opd_visits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES public.encounters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'OPD';

ALTER TABLE public.prescription_items
  ADD COLUMN IF NOT EXISTS qty_dispensed integer NOT NULL DEFAULT 0;

-- status column may already exist from a partial prior run; add safely then constrain
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prescription_items' AND column_name = 'status'
  ) THEN
    ALTER TABLE public.prescription_items
      ADD COLUMN status text NOT NULL DEFAULT 'prescribed';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prescription_items_status_check'
  ) THEN
    ALTER TABLE public.prescription_items
      ADD CONSTRAINT prescription_items_status_check
      CHECK (status IN ('prescribed', 'ready', 'dispensed', 'partial', 'out_of_stock', 'cancelled'));
  END IF;
END $$;

ALTER TABLE public.dispense_records
  ADD COLUMN IF NOT EXISTS batch_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4) Pending-count helpers (views for Home tiles)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.hms_pending_counts AS
SELECT
  (SELECT count(*) FROM public.lab_orders
    WHERE status NOT IN ('verified', 'sent', 'completed', 'cancelled')) AS pending_lab,
  (SELECT count(*) FROM public.lab_orders
    WHERE status NOT IN ('verified', 'sent', 'completed', 'cancelled')
      AND priority IN ('urgent', 'stat')) AS pending_lab_urgent,
  (SELECT count(*) FROM public.prescriptions
    WHERE status IN ('pending', 'active')) AS to_dispense,
  (SELECT count(*) FROM public.invoices
    WHERE status IN ('open', 'issued', 'partial', 'draft')) AS open_invoices,
  (SELECT count(*) FROM public.medicines m
    WHERE m.is_active IS DISTINCT FROM false
      AND COALESCE(m.stock_quantity, 0) <= COALESCE(m.reorder_level, m.low_stock_threshold, 10)
  ) AS low_stock_items,
  (SELECT count(*) FROM public.medicine_batches b
    WHERE b.is_active AND b.quantity > 0
      AND b.expiry_date <= (CURRENT_DATE + INTERVAL '90 days')
  ) AS expiring_batches_90d;

COMMENT ON VIEW public.hms_pending_counts IS
  'Phase 2 Home tiles: pending lab, to-dispense, open invoices, low stock, expiring.';

COMMENT ON TABLE public.stock_movements IS
  'Append-only stock ledger. Application MUST NOT update medicines.stock_quantity except via this table.';
COMMENT ON TABLE public.medicine_batches IS
  'Batch-level inventory; FEFO pick uses earliest expiry_date with quantity > 0 and not expired.';
COMMENT ON COLUMN public.lab_results.locked IS
  'True after verify; edits create a new lab_result_versions row instead of mutating silently.';
