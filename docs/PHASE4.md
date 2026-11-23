# St Dominic HMS — Phase 4 HIV + dashboard + reports

Restricted **HIV care (10)**, live **Home dashboard (00)** KPIs/alerts, and **Reports & statistics (12)** with gated export.

HTML source: `muneeb bhai/St-Dominic-HMS (1).html` screens **00, 10, 12**.

## Apply migration

```bash
# Run in Supabase SQL editor (or supabase db push):
backend/supabase/migrations/20261106_phase4_hiv_dashboard_reports.sql
```

Then:

```bash
cd backend && node scripts/phase4-verify.js
```

## What was added

### Data

| Area | Changes |
|------|---------|
| Sequences | `ART-#####`, `HTS-#####` via `document_sequences` |
| HTS | `hiv_hts_tests` (result, counsellor, link to ART) |
| ART | Extended `hiv_enrollments` (art_no, WHO stage, regimen, VL, refill, LTFU) |
| Visits / labs | Refill → prescription + appointment; VL unsuppressed flag |
| Views | `hms_phase4_hiv_counts`, `hms_phase4_alert_counts`, `hms_phase4_admin_counts` |

### Rules (`hivRules.js`)

- Viral load due **6 months** after ART start, then **yearly**
- VL ≥ **1000** copies/ml → unsuppressed
- Missed refill **> 28 days** → LTFU (`status = lost`)
- List views mask names (ART no.) unless portal access is **full**

### API (`/api/hms/…`)

**Home**

- `GET /home-counts` — Phase 1–4 KPIs + alerts + admin tiles (60s refresh on UI)
- `GET /home/alerts`

**HIV** (all `requirePortal('hiv')` → matrix + `can_access_hiv`)

- `GET /hiv/kpis`
- `GET|POST /hiv/hts`
- `GET|POST /hiv/art` · `GET|PATCH /hiv/art/:id` (view audited)
- `GET|POST /hiv/viral-load`
- `GET|POST /hiv/refills` — creates Pharmacy prescription + next refill appointment
- `POST /hiv/sync-ltfu`

**Reports**

- `GET /reports/catalog`
- `GET /reports/:type` — filters: `from`, `to`, `department`, `sex`, `age_group`
- `GET /reports/:type/export.xlsx|pdf` — `requireExportPermission()` + audit `export`
- `GET /reports/aligned-counts` — same-day counts for dashboard parity

### UI

| Route | Portal |
|-------|--------|
| `/hms` | `HomeDashboard.jsx` — grouped tiles, alerts, admin security |
| `/hms/hiv` | `HivPortal.jsx` — HTS / ART / VL / Refills tabs |
| `/hms/reports` | `ReportsPortal.jsx` — catalog, table + bar chart, export |

### RBAC

| Portal | Access |
|--------|--------|
| HIV | Clinical/Midwife **full**, Lab/Pharmacy **edit**, only if `can_access_hiv`. Admin/Accounts **none** (portal hidden + API 403) |
| Reports view | All HMS roles with matrix view/full |
| Export | Admin **or** `can_export_reports` |

Non-HIV users: nav hidden (`canSeePortal`) + `403 PORTAL_FORBIDDEN` on `/api/hms/hiv/*`.

## Acceptance mapping

| Test | How |
|------|-----|
| Non-HIV user cannot open HIV routes | UI: no nav / PortalGuard; API: `requirePortal('hiv')` without flag → 403 |
| Viewing HIV record creates audit row | `listArtClients` / `getArtClient` write `action: view` |
| Dashboard tile counts = report queries for today | Shared date filters; `aligned-counts` + home OPD/appt KPIs |
| Export blocked without flag | `requireExportPermission` → `EXPORT_FORBIDDEN`; with flag/Admin audited |

## Exit checklist

- [x] HIV restricted + audited  
- [x] Dashboard KPIs/alerts live  
- [x] Core reports + export work  

## Notes

- Legacy `/api/programs` HIV endpoints remain; HMS UI uses `/api/hms/hiv/*` with flag gating.
- Admin sees home **counts** for HIV when present in payload, but cannot open the HIV portal (matrix `none`).
- Apply Phase 0–3 migrations before Phase 4.
