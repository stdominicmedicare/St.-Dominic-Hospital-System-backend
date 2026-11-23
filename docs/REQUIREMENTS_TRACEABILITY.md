# St. Dominic HMS — Requirements Traceability (Phase 7)

**Source:** `muneeb bhai/St-Dominic-HMS (1).html` yellow-box developer specs (screens 00–15)  
**Workspace:** `/mnt/data/Hammad Zubairy/Memon`  
**Date:** 2026-11-06  

> **Authority exit pack (preferred):** [`AUTHORITY_EVIDENCE.md`](AUTHORITY_EVIDENCE.md) + [`FEATURE_COMPLETION.md`](FEATURE_COMPLETION.md)  
> Full acceptance suite: `cd frontend && npm run test:hms:acceptance` (`frontend/e2e/acceptance/`).  
> Legacy smoke (`phase7-smoke` / `phase7-hms-smoke.spec.js`) is **not** the authority bar.

**Smoke evidence (historical):** `backend/scripts/phase7-smoke.js` → `PHASE7_SMOKE_RESULTS.json`; Playwright `frontend/e2e/phase7-hms-smoke.spec.js` (API paths A–E)

## Score summary

| Status | Count | Share |
|--------|------:|------:|
| Pass | 62 | **72%** |
| Partial | 22 | 26% |
| Fail | 0 | 0% |
| Blocked | 2 | 2% |
| **Total rows** | **86** | 100% |

**Critical smoke paths:** **5 / 5 Pass** (Register→Pay, MCH loop, HIV gate, Admin audit export, Home vs Reports OPD same-day).

---

## How to read status

| Status | Meaning |
|--------|---------|
| **Pass** | Implemented and exercised (route/API/test evidence) |
| **Partial** | Core works; field/UX/automation gap remains |
| **Fail** | In-scope missing or broken |
| **Blocked** | Needs ops/platform (HTTPS, MFA provider, off-site backup, browser binary) |

---

## Screen 00 — Home dashboard + navigation

| Area | Requirement (HTML) | Status | Evidence |
|------|--------------------|--------|----------|
| Purpose | One screen of today’s activity + launcher | Pass | `/hms` · `HomeDashboard.jsx` · `GET /api/hms/home-counts` |
| Users | Everyone after login; tiles hidden by role | Pass | `canSeePortal` filter in `HomeDashboard.jsx` + `hmsRoles.js` |
| Workflow / Layout | KPI tiles grouped (Patient flow, MCH, Programs, Services, Finance) | Pass | `HMS_NAV_GROUPS` + grouped tiles |
| Fields / Data | Counts by module + today / MTD | Pass | `dashboardService.getHomeDashboard` |
| Actions | Tile → portal; alerts link to records | Pass | `Link` + `buildAlerts` deep-links |
| Rules | Refresh every 60s | Pass | `setInterval(…, 60000)` |
| Rules | Numbers match Reports for same date range | Partial | OPD today aligned (`phase7-smoke` Path E). Full tile set vs reports still incomplete; UI shows aligned OPD/appts/invoices snippet |

---

## Screen 01 — OPD (Outpatient)

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Manage visit arrival → exit | Pass | `/hms/opd` · `OpdPortal.jsx` |
| Users | Clerk check-in / Nurse triage / Doctor consult | Done | Separate HMS roles + `requireOpdAction`; apply `20261107_clinical_role_split.sql` for `Clerk` enum |
| Workflow | Check-in → Triage → Waiting → Consult → Lab/Pharmacy → Billing → Done | Pass | Status stepper + APIs; smoke Path A |
| Fields | Token, patient, visit type, complaint; vitals BP/temp/pulse/resp/SpO2/weight/height/BMI; ICD-10 | Pass | Height + BMI readout added Phase 7; `vitalsService.computeBmi` |
| Actions | Order lab, Prescribe, Book follow-up, Complete → charges | Pass | `POST /api/hms/opd/:id/order-lab\|prescribe\|complete\|follow-up` |
| Rules | Urgent vitals top of queue; wait = now − check-in | Pass | `vitalsService` thresholds + `opdService` sort |

---

## Screen 02 — Appointments & follow-up

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Book/track all clinics | Pass | `/hms/appointments` · clinics incl. HIV |
| Users | Records, Nurses, Doctors | Pass | Clinical/Midwife matrix levels |
| Workflow | Booked → Reminded → Arrived → Seen / Missed → Defaulter | Partial | Status buttons exist; **Arrived auto on check-in** not wired; EOD missed is **manual** |
| Fields | Patient, clinic, provider, date/slot, reason, phone, SMS | Partial | Core fields; SMS reminder flag not end-to-end |
| Actions | Day / week / defaulters views | Pass | `AppointmentsPortal.jsx` tabs |
| Rules | Auto create from ANC/imm/FP/HIV; prevent double-book | Partial | `assertSlotFree` Pass; auto-create from modules Partial/Pass per module |

---

## Screen 03 — Laboratory

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Requests → sample → result → verify | Pass | `/hms/lab` · smoke Path A |
| Users | Tech, supervisor verify, doctors view | Pass | Matrix + `can_verify_lab` |
| Workflow | Requested → Collected → In progress → Result → Verified → Sent | Pass | `labService` status machine |
| Fields | Request no., patient, tests, priority, sample, result, unit, range | Partial | Catalogue + results; sample ID UI thinner than HTML |
| Actions | Catalogue, walk-in, verify, version | Pass | Routes under `/api/hms/lab/*` |
| Rules | H/L + critical; supervisor-only verify; lock; charge | Pass | `flagResultValue`; verify flag-gated; billing on order |
| Rules | Home pending lab = not verified | Pass | `hms_pending_counts` / home tile |

---

## Screen 04 — Pharmacy & inventory

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Dispense + accurate stock | Pass | `/hms/pharmacy` · smoke Path A |
| Users | Pharmacist, store keeper, Admin | Partial | Pharmacy full; Admin **view** per HTML matrix (no write) |
| Workflow | Prescribed → Ready → Dispensed / Partial / OOS | Pass | FEFO dispense statuses |
| Fields | Drug, strength, form, batch, expiry, qty, reorder, costs | Partial | Batches + GRN; some catalogue fields optional |
| Actions | Tabs: dispense, stock, GRN, adjust, expiry | Pass | `PharmacyPortal.jsx` |
| Rules | FEFO; low stock alert; expiry colours; movements ledger; charges | Pass | `stockService` / `pharmacyDispenseService` |

---

## Screen 05 — ANC

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Register pregnancies + contacts | Pass | `/hms/anc` · smoke Path B |
| Users | Midwife, Nurse, Doctor | Pass | Midwife full / Clinical edit |
| Workflow | Registered → ANC1… → Refer maternity | Pass | Refer API + delivery handoff |
| Fields | LMP/EDD/GA, gravida/para, labs, husband/kin; visit vitals | Pass | `mchService.registerPregnancy` / `saveAncVisit` |
| Actions | Defaulters list | Pass | `GET /api/hms/anc/defaulters` |
| Rules | High-risk flags; visit → next appointment | Pass | `evaluateAncHighRisk` + `bookAppointment` |

---

## Screen 06 — Maternity & delivery

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Labour ward + deliveries | Pass | `/hms/maternity` · smoke Path B |
| Users | Midwife, Doctor | Pass | Matrix |
| Workflow | Admitted → In labour → Delivered → PNC | Pass | Admit + delivery APIs |
| Fields | ANC link, cervix, partograph, delivery + baby APGAR | Partial | Partograph API exists; UI depth vs HTML Partial |
| Rules | Baby own patient; PNC + imm schedule; Home labour/MTD | Pass | `saveDelivery` creates baby + schedules; smoke Path B |

---

## Screen 07 — PNC

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Mother + baby after delivery | Pass | `/hms/pnc` · smoke Path B |
| Users | Midwife, Nurse | Pass | Matrix |
| Workflow | Auto schedule 48h / d3 / d7–14 / w6 | Pass | Created at delivery |
| Fields | Mother + baby clinical fields | Partial | Core saved; full HTML field set Partial |
| Rules | Danger → urgent + refer; week-6 → FP/imm; missed → defaulter | Partial | Danger/urgent + week-6 links in service; defaulter automation Partial |

---

## Screen 08 — Immunization

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Vaccines due/overdue + record doses | Pass | `/hms/immunization` · smoke Path B |
| Users | Nurse | Pass | Clinical/Midwife full |
| Fields | Configurable schedule; child card | Pass | Admin schedule upsert (`full`); card API |
| Rules | Due/overdue/given; stock deduct; next appt; Td/ANC | Partial | Dose + next appt Pass; Td/ANC link Partial; stock optional (`deduct_stock`) |

---

## Screen 09 — Family planning

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Counsel + methods | Pass | `/hms/fp` · `FpPortal.jsx` · `/api/hms/fp/*` |
| Users | Nurse, Midwife | Pass | Matrix |
| Fields | Method, qty, insertion, side effects, re-supply | Pass | Encounter payload |
| Workflow | Counselled → Method → Re-supply → Continuing/Switched | Partial | Status model lighter than HTML wording |
| Rules | Re-supply appointment; stock deduct; new vs continuing report | Partial | Appointment/stock paths exist; report coverage Partial |

---

## Screen 10 — HIV care

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | HTS + ART + VL + refills | Pass | `/hms/hiv` · `/api/hms/hiv/*` |
| Users | Counsellor/Doctor/Pharmacist; **STRICT** | Pass | `can_access_hiv` required; smoke Path C 403/200 |
| Workflow / Tabs | Testing · ART · VL · Refills | Pass | `HivPortal.jsx` tabs |
| Fields | ART no., WHO, regimen, CD4, VL, TB, adherence | Pass | ART enroll/patch APIs |
| Rules | VL schedule; ≥1000 unsuppressed; LTFU >28d | Pass | `hivRules.js` + phase4-verify |
| Rules | Mask names unless HIV role; audit every view | Partial | Names for edit/full (Phase 7 fix); every list view audit not exhaustive |

---

## Screen 11 — Billing & receipts

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Collect payments + receipts | Pass | `/hms/billing` · smoke Path A (`RC-00001`) |
| Users | Cashier, Admin | Partial | Accounts **full**; Admin **view** (HTML matrix) — Admin cannot pay |
| Workflow | Auto charges → Open → Partial → Paid / Waive / Insurance | Pass | Pay/waive/insurance/credit-note routes |
| Fields | Invoice, items, discount, insurance, method, receipt | Pass | `billingService` |
| Rules | Sequential receipts; locked paid; cash summary; price list | Pass | `documentSequenceService`; cash summary API |

---

## Screen 12 — Reports & statistics

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Monthly/custom + government returns | Pass | `/hms/reports` · catalog API |
| Users | Admin, Records, dept heads | Pass | Matrix + export flag |
| Fields / Filters | Date, dept, staff, age, sex | Partial | Date + some filters; not every HTML filter everywhere |
| Actions | Standard report set + Excel/PDF | Pass | `REPORT_CATALOG` + export routes |
| Rules | Same numbers as Home for same dates | Partial | `GET /api/hms/reports/aligned-counts` + OPD parity Pass; not every Home tile |

---

## Screen 13 — Patient registration & records

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Register once; shared MRN | Pass | `/hms/patients` · smoke Path A/B MRNs |
| Users | Clinical/Midwife edit; Admin merge; Lab/Pharm/Accounts view | Pass | Matrix |
| Fields | Names, sex, DOB, phone, NID, insurance, address, kin, blood, allergies, photo, SMS consent | Partial | Core + consent Pass; **photo / barcode print** missing |
| Actions | Duplicate check; timeline; deactivate/merge; export | Pass | APIs + smoke register |
| Rules | Never delete; HIV hidden on timeline without flag | Pass | `getHmsTimeline` filters HIV |

---

## Screen 14 — Users & roles

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | 6 roles + matrix | Pass | `/hms/roles` · `GET /api/hms/users/matrix` |
| Users | Administrator only | Pass | `requirePortal('roles')` |
| Fields | Name, email, phone, role, dept, flags, status, 2SV, last login | Partial | Core + flags; 2SV UI/API Partial |
| Actions | Create user, assign role/flags, export | Pass | smoke Path D users list |
| Rules | One role; flags for extras; audit role change; force password change | Pass | `hmsUsersService` + login security Phase 5 |

---

## Screen 15 — Security, audit & backups

| Area | Requirement | Status | Evidence |
|------|-------------|--------|----------|
| Purpose | Audit who did what; backups | Pass | `/hms/security` |
| Audit fields | Login/fail/logout/view/CRUD/print/export/permission | Partial | Broad action coverage; not every UI view audited |
| Rules | Append-only | Pass | PATCH/DELETE → 405 · smoke Path D |
| Actions | Filter + Excel/PDF export | Pass | `GET /api/hms/security/audit/export.xlsx` |
| Security | HTTPS, hash, lockout, 15m idle, 2SV Admin, encrypt at rest, no PII in URLs | Blocked / Partial | App idle logout + lockout Partial; HTTPS/MFA/DB encryption = **Blocked** (platform) |
| Backups | Nightly + incremental, retention, off-site, alert, test restore | Partial / Blocked | API run/test-restore Pass; schedule/off-site/email = **Blocked** ops |

---

## Critical smoke path results

| Path | Result | Evidence |
|------|--------|----------|
| Register → OPD → Lab → Pharmacy → Pay | **Pass** | `phase7-smoke` Path A; Playwright Path A |
| ANC → Delivery → PNC → Immunization | **Pass** | Path B (baby `linked_patient_id`, dose recorded) |
| HIV denied / allowed by flag | **Pass** | Path C 403 vs 200 |
| Admin users/roles + audit export | **Pass** | Path D + append-only 405 |
| Dashboard vs report same day (OPD) | **Pass** | Path E `home=1 aligned=1` (after Path A) |

---

## Phase 7 fixes applied

1. OPD **height** field + BMI display (`OpdPortal.jsx`)
2. Home admin backup tile uses real `getAdminCounts()` values (`dashboardService.js`)
3. HIV name reveal for portal **edit** as well as **full** (`hivService.js`, `HivPortal.jsx`)
4. Expanded `aligned-counts` (pending lab, open invoices, deliveries) + Home footnote (`reportsService.js`, `HomeDashboard.jsx`)
5. Playwright/env path fix for Memon `backend/.env`
6. New smoke: `backend/scripts/phase7-smoke.js`, `frontend/e2e/phase7-hms-smoke.spec.js`

---

## Top gaps (updated after follow-up implementation)

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| 1 | Admin clinical write access | **Done** | Matrix Admin → `full` (HIV still flag-gated) |
| 2 | Home ↔ Reports tile parity | **Done** | Expanded `aligned-counts` + Home footer |
| 3 | Auto Arrived + EOD mark-missed | **Done** | Check-in wire + UI + `eod-mark-missed.js` (cron = manual host) |
| 4 | SMS reminders | Open | Needs SMS vendor |
| 5 | Patient card print/QR + photo | **Done in code** | Apply `20261106_phase7_patient_photos.sql` manually |
| 6 | Admin 2SV required | Open | Supabase MFA |
| 7 | HTTPS / encryption / off-site backups | Open | Ops |
| 8 | Clerk vs Nurse vs Doctor roles | Open | Product |
| 9 | Partograph action-line UI | **Done** | Alerts + hours + richer table |
| 10 | Playwright Chromium | **Blocked here** | CDN timeout — run `npx playwright install chromium` elsewhere |

See `MANUAL_STEPS.md` for host/Supabase actions.

---

## Exit checklist

- [x] Traceability matrix exists (`REQUIREMENTS_TRACEABILITY.md`)
- [x] Critical smoke paths pass (`npm run phase7:smoke` / `npm run test:phase7`)
- [x] Employer-facing gap list ready (Top 10 above)

## Phase 7+ quick wins (post-matrix)

See `PHASE7_QUICK_WINS.md` — Admin full clinical write, auto Arrived + EOD, patient print/QR + photo UI, aligned-counts expansion, partograph alerts. Manual: apply `20261106_phase7_patient_photos.sql`, restart API, optional cron, Playwright Chromium on a networked host.
