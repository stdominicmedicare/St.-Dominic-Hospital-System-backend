# St Dominic HMS — Phase 3 MCH suite

Wires **ANC → Maternity → PNC → Immunization → Family planning** to shared patients, appointments, pharmacy stock, and billing.

HTML source: `muneeb bhai/St-Dominic-HMS (1).html` screens **05–09**.

## Apply migration

```bash
# Run in Supabase SQL editor (or supabase db push):
backend/supabase/migrations/20261106_phase3_mch.sql
```

Then:

```bash
cd backend && node scripts/phase3-verify.js
```

## What was added

### Data

| Area | Changes |
|------|---------|
| Sequences | `ANC-#####`, `FP-#####` via `document_sequences` |
| ANC | Extended pregnancies (anc_no, high_risk, LMP→EDD fields) + visit extras |
| Maternity | Labour fields, `partograph_entries`, delivery attendant/blood loss, baby `linked_patient_id` |
| PNC | `pnc_schedules` (48h / day3 / day7–14 / week6) + mother/baby visit fields |
| Immunization | Admin `immunization_schedule`, per-child `immunization_card_doses` |
| FP | client_type, method_code, re-supply, stock linkage |
| Home | View `hms_phase3_mch_counts` |

### API (`/api/hms/…`)

**ANC**

- `GET /anc/kpis` · `GET /anc/pregnancies` · `POST /anc/pregnancies`
- `POST /anc/visits` — high-risk eval + auto next Appointment (`clinic: anc`) + `ANC-VISIT` charge
- `GET /anc/defaulters` · `POST /anc/pregnancies/:id/refer-maternity`

**Maternity**

- Labour board, admit (auto-loads active ANC), partograph alerts
- `POST /maternity/deliveries` — baby **own MRN**, PNC schedule + Imm card, `MAT-DELIVERY` + `MAT-BED-DAY` charges
- Write routes require `requirePortal('maternity', { minLevel: 'edit' })` (Accounts/Lab/Pharmacy blocked)

**PNC**

- Due/missed list from schedules created at delivery
- Save visit; week-6 returns FP + immunization links; danger signs → URGENT chip

**Immunization**

- Schedule CRUD (full access), register child → card from DOB
- Record dose → FEFO `dispenseFefo` when medicine linked → book next dose Appointment

**FP**

- Methods + clients (new vs continuing KPIs)
- Save → deduct commodities stock + book re-supply Appointment + `FP-METHOD` charge

### UI

| Route | Portal |
|-------|--------|
| `/hms/anc` | `AncPortal.jsx` |
| `/hms/maternity` | `MaternityPortal.jsx` |
| `/hms/pnc` | `PncPortal.jsx` |
| `/hms/immunization` | `ImmunizationPortal.jsx` |
| `/hms/fp` | `FpPortal.jsx` |

Home tiles show ANC visits today / in labour + deliveries MTD / PNC due / imm due / FP clients today.

### RBAC

| Portal | Midwife | Clinical staff | Others |
|--------|---------|----------------|--------|
| ANC / Maternity / PNC | **full** | edit | Admin view; Lab/Pharmacy/Accounts **none** |
| Immunization / FP | full | full | Admin view; others none |

Unauthorized roles receive `403 PORTAL_FORBIDDEN` / `PORTAL_LEVEL_FORBIDDEN` on maternity write APIs.

## Cross-links

| Trigger | Appointments | Pharmacy | Billing |
|---------|--------------|----------|---------|
| ANC save visit | Next ANC slot | — | `ANC-VISIT` |
| Delivery save | PNC 48h/3/7–14/w6 | Birth vaccines on card | `MAT-DELIVERY`, `MAT-BED-DAY` |
| Imm dose | Next due dose | `dispenseFefo` / stock_movements | `IMM-DOSE` |
| FP save | Re-supply by method | Commodity FEFO | `FP-METHOD` |
| PNC week-6 | — | — | Soft-links to FP + Imm portals |

## Acceptance mapping

| Test | How |
|------|-----|
| Register pregnancy → ANC visit → high-risk | `POST /anc/pregnancies` then `POST /anc/visits` with BP≥140 or age rules |
| Delivery creates baby MRN + PNC + vaccine card | `POST /maternity/deliveries` returns `baby_patient`, `pnc_schedule`, `vaccine_card` |
| Overdue immunization list | `GET /immunization/cards?overdue=1` |
| FP re-supply → appointment + stock | `POST /fp/encounters` with `medicine_id` + quantity |
| Unauthorized maternity write | Pharmacy/Accounts → `403` on `POST /maternity/admit` |

## Exit checklist

- [x] ANC→Maternity→PNC chain works  
- [x] Baby record + vaccines created on delivery  
- [x] FP + immunization stock/appointments work  
- [x] Midwife full on MCH; unauthorized blocked from maternity writes  

## Notes

- Legacy `/api/mch` and `/midwife` remain; HMS UI uses `/api/hms/*`.
- Link vaccine / FP method rows to `medicines.id` for FEFO deductions; without `medicine_id`, dose/visit still records but skips stock.
- Apply Phase 0–2 migrations before Phase 3.
