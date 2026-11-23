# St Dominic HMS — Phase 1 patient flow spine

Builds **Patient registration (13)**, **OPD (01)**, **Appointments (02)** on Phase 0 foundations, and feeds Phase 2 lab/pharmacy/billing handoffs.

HTML source: `muneeb bhai/St-Dominic-HMS (1).html`

## Apply migration

```bash
# Supabase SQL editor or supabase db push:
backend/supabase/migrations/20261106_phase1_patient_flow.sql
```

Then:

```bash
cd backend && node scripts/phase1-verify.js
```

## What was added

### Data

| Area | Change |
|------|--------|
| Patients | Demographics on `profiles`: names, sex, national ID, insurance, address, next of kin, blood group, allergies, chronic conditions, SMS consent |
| `patients` view | Recreated with new columns |
| OPD | Workflow statuses (check-in → … → completed), vitals urgency (`is_urgent`), diagnosis/ICD-10/plan, encounter link |
| Appointments | `clinic`, `hms_status` (booked→reminded→arrived→seen/missed), slots, SMS fields, unique anti-double-book index |
| Home | View `hms_phase1_counts` |

### API (`/api/hms/…`)

**Patients**

- `GET /patients`, `/patients/kpis`, `/patients/:id`, `/patients/:id/timeline`
- `POST /patients/check-duplicates`, `/patients/register`
- `PATCH /patients/:id`, `POST /patients/:id/deactivate` (full), `POST /patients/merge` (full)
- `GET /patients/export.xlsx` · `.pdf` (export flag)

**OPD**

- `GET /opd/queue`, `/opd/kpis`
- `POST /opd/check-in`, `PATCH /opd/:id`, `POST /opd/:id/follow-up`
- Existing Phase 2: `POST /opd/:visitId/order-lab|prescribe|complete`

**Appointments**

- `GET /appointments`, `/appointments/kpis`
- `POST /appointments`, `PATCH /appointments/:id` (status or `reschedule: true`)
- `POST /appointments/mark-missed` — **manual end-of-day** (no cron yet)

**Shared**

- `GET /providers`, `/icd10?q=`, `/home-counts` (also aliased as `/pending-counts`)

### UI

- `/hms/patients` → `PatientsPortal.jsx`
- `/hms/opd` → `OpdPortal.jsx`
- `/hms/appointments` → `AppointmentsPortal.jsx`
- Home tiles show OPD / appointments / patients counts

### Services

- `patientHmsService.js`, `opdService.js`, `appointmentService.js`, `vitalsService.js`
- Other modules should call `bookAppointment()` from `appointmentService.js` for next ANC/imm/FP/HIV visits

## Urgent vitals (HTML)

BP ≥ 160/110, temp ≥ 38.5°C, or SpO2 < 92 → `is_urgent`, triage critical, top of queue.

## Missed appointments (acceptance)

**No cron yet.** After clinic day ends:

1. Click **Mark missed (end of day)** on Appointments, or  
2. Per-row **Missed**, or  
3. `POST /api/hms/appointments/mark-missed` with `{ "date": "YYYY-MM-DD" }`

Missed rows appear under **Missed / defaulters**.

## RBAC notes

- Pharmacy / Lab / Accounts: **no** OPD portal → 403 on OPD edit routes  
- Admin: OPD **view only** (matrix) — cannot check-in / complete  
- Clinical staff: OPD full  
- Patient merge / deactivate: portal **full** (Administrator)  
- HIV appointments: names masked without `can_access_hiv`  
- Timeline: HIV encounters hidden without flag

## Acceptance mapping

| Test | How |
|------|-----|
| Register + duplicate warning | Register twice with same name+DOB+phone → 409 `DUPLICATE_PATIENT` |
| OPD path | Check-in → save vitals → waiting → consult → order lab / prescribe / follow-up → complete |
| Lab / Rx / follow-up linked | Phase 2 order-lab & prescribe; follow-up creates appointment + encounter |
| Missed → defaulters | Manual mark-missed (documented above) |
| Unauthorized OPD admin | Non–clinical / view-only roles get 403 on `minLevel: edit` |

## Stubs left for later phases

| Stub | Owner |
|------|--------|
| SMS reminder send (flag stored only) | Appointments / notifications |
| Cron for end-of-day missed | Ops / scheduler → call `mark-missed` |
| Full ICD-10 catalogue | Currently common-code search list |
| Patient card / barcode print | UI button label only |
| Photo upload | `photo_url` column reserved |
| ANC/PNC/Imm/FP/HIV portals creating appointments | Call shared `bookAppointment` when those screens are built |
| Maternity / HIV charge hooks | Already documented in PHASE2.md |

## Exit checklist

- [x] Patient register + timeline works  
- [x] OPD workflow usable end-to-end  
- [x] Appointments book / miss / defaulter works  
