# St Dominic HMS — Phase 7 QA + requirements matrix

HTML acceptance: screens 00–15 yellow boxes in `muneeb bhai/St-Dominic-HMS (1).html`.

## Deliverables

| Artifact | Path |
|----------|------|
| Traceability matrix | `REQUIREMENTS_TRACEABILITY.md` |
| Live API smoke | `backend/scripts/phase7-smoke.js` |
| Playwright API smoke | `frontend/e2e/phase7-hms-smoke.spec.js` |
| Last smoke JSON | `PHASE7_SMOKE_RESULTS.json` |

## Run

```bash
# Backend must be up on :5000
cd backend && npm run phase7:smoke

# Playwright (API paths; needs SUPABASE_* in backend/.env)
cd frontend && npm run test:phase7
```

## Score

See matrix header: **~72% Pass** of Purpose/Users/Workflow/Fields/Actions/Rules rows; **5/5 critical smokes Pass**.

## Fixes in this phase

- OPD height + BMI UI
- Honest admin backup tile on Home
- HIV name visibility for edit-level HIV access
- Richer `aligned-counts` + Home reconciliation note
- Env path fixes for e2e helpers

## Follow-up batch (implemented in code)

| Gap | Status |
|-----|--------|
| Admin full on clinical portals | Done (BE+FE matrix; HIV still needs `can_access_hiv`) |
| Auto Arrived on OPD check-in | Done (`opdService` finds today’s booked appt) |
| EOD mark-missed | Done (UI button + `npm run eod:mark-missed`) |
| Patient print / QR | Done (`utils/patientCard.js`) |
| Patient photo | Done (UI + migration SQL — **apply manually**) |
| Home ↔ Reports aligned tiles | Done (`getDashboardAlignedCounts` expanded) |
| Partograph action-line UI | Done (alerts + hours + BP/pulse columns) |
| Playwright Chromium | **Blocked on this host** (CDN timeout) — see `MANUAL_STEPS.md` |

**Manual steps:** see [`MANUAL_STEPS.md`](MANUAL_STEPS.md).

## Remaining employer gaps (not in this batch)

SMS, MFA/2SV, HTTPS/encryption/off-site backups, Clerk vs Nurse vs Doctor role split.
