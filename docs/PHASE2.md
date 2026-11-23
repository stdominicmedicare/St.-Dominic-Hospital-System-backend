# St Dominic HMS — Phase 2 clinical loop

Closes **Order lab → Verify → Charge**, **Prescribe → FEFO dispense → Charge**, and **Invoice → Payment → Receipt**, consuming OPD handoffs.

HTML source: `muneeb bhai/St-Dominic-HMS (1).html` screens **03 Laboratory**, **04 Pharmacy**, **11 Billing**.

## Apply migration

```bash
# Run in Supabase SQL editor (or supabase db push):
backend/supabase/migrations/20261106_phase2_clinical_loop.sql
```

**Enum note:** partially dispensed prescriptions use existing `prescription_status = 'active'` (not a new `'partial'` label). Postgres rejects using a newly added enum value in the same transaction that adds it (`55P04`).

Then:

```bash
cd backend && node scripts/phase2-verify.js
```

## What was added

### Data

| Area | Tables / views |
|------|----------------|
| Sequences | `document_sequences` + `hms_next_document_no()` for INV / RC / LR / CN / GRN |
| Lab | Extended `lab_tests` (range, critical, price), `lab_orders` workflow statuses + `request_no`, `lab_result_versions`, lock on verify |
| Pharmacy | `medicine_batches` (FEFO), `stock_movements` (receive/dispense/adjust/expire) |
| Billing | Invoice statuses open/partial/paid/waived/insurance_claim, discount, `credit_notes`, cashier on payments |
| Home | View `hms_pending_counts` |

### API (`/api/hms/…`)

**OPD handoffs**

- `POST /opd/:visitId/order-lab` `{ test_ids, priority?, notes? }` → lab request + billing lines
- `POST /opd/:visitId/prescribe` `{ items: [{ medicine_id?, medication_text, quantity, … }] }`
- `POST /opd/:visitId/complete` → OPD consultation charge on open invoice  
  Use `visitId=walk-in` with `patient_id` for non-visit orders.

**Lab**

- Worklist / catalogue / walk-in order / advance status / enter result  
- `POST /lab/items/:itemId/verify` — requires `can_verify_lab` (Admin bypass)  
- Verified results locked; corrections via `/lab/items/:itemId/version` + audit

**Pharmacy**

- To-dispense, FEFO dispense, stock list, GRN receive, adjustments, expiring, movements  
- Dispense never edits qty directly — always `stock_movements` + batch FEFO

**Billing**

- Invoices, pay (sequential `RC-#####`), waive (`can_give_discounts`), insurance claim, credit note  
- Price list, daily cash summary by cashier/method, receipt PDF  
- Paid invoices immutable

**Home**

- `GET /pending-counts` → pending_lab, to_dispense, open_invoices, low_stock, expiring

### UI

- `/hms/lab` → `LabPortal.jsx`
- `/hms/pharmacy` → `PharmacyPortal.jsx`
- `/hms/billing` → `BillingPortal.jsx`
- Home tiles poll pending counts every 60s

### Services

- `billingService.js`, `stockService.js`, `labService.js`, `pharmacyDispenseService.js`, `documentSequenceService.js`

## Acceptance mapping

| Test | How |
|------|-----|
| OPD order lab → Lab worklist | `POST /api/hms/opd/:visitId/order-lab` then `GET /api/hms/lab/worklist` |
| Verify locks; unauthorized cannot verify | Verify needs flag; without flag → 403 `FLAG_FORBIDDEN` |
| Prescription → Pharmacy; FEFO | `POST …/prescribe` then dispense; earliest non-expired batch first |
| Invoice totals; receipt number | Pay returns `payment.receipt_no`; PDF at `/billing/payments/:id/receipt.pdf` |
| Home pending counts | `GET /api/hms/pending-counts` |
| Money/stock audited | `audit_logs` for invoice_line, payment, stock_movement, lab verify |

## Deferred charge hooks (later phases)

These price-list codes exist as **hooks only** — no Maternity/HIV portal writers yet:

| Code | Intended use |
|------|----------------|
| `MAT-DELIVERY` | Maternity delivery fee when delivery is saved |
| `MAT-BED-DAY` | Per bed-day on maternity admission/discharge |
| `HIV-VL` | Viral load test charge (HIV portal + lab catalogue link) |
| `HIV-CD4` | CD4 charge (HIV portal) |

Immunization dose / FP commodity deductions still use Pharmacy stock in later phases (screens 08–09); they should call the same `dispenseFefo` / `stock_movements` helpers.

## Exit checklist

- [x] Lab request → verify → charge works  
- [x] Pharmacy FEFO + movements work  
- [x] Billing payment + receipt works  
- [x] Maternity/HIV charge hooks documented (not wired)

## Notes

- Legacy `/api/lab`, `/api/pharmacy`, `/api/billing` remain for older dashboards; HMS Phase 2 UI uses `/api/hms/*`.
- `medicines.stock_quantity` is a **cache** refreshed from batches — do not PATCH it from clients.
- If Phase 1 OPD UI is still the legacy `OpdDesk`, call the handoff endpoints above (or wire buttons in a later OPD polish pass).
