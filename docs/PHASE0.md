# St Dominic HMS — Phase 0 foundations

What was added so later clinical phases can build on a shared shell, permission model, patient/encounter identity, audit, and export primitives without rewriting auth.

## Added

### Shared app shell (frontend)

- Department-grouped **left sidebar** (`frontend/src/components/layout/Sidebar.jsx`) using `frontend/src/navigation/hmsNav.js`
  - Overview / Patient flow / Maternal & child / Programs / Services / Finance & reports / Administration / Existing modules
- Header simplified: brand + current portal title + user/sign-out (nav moved out of overflowing top bar)
- Reusable UI:
  - `KpiTile`, `StatusChip`, `WorkflowStepper`, `PageHeader`
  - `ExportExcel`, `ExportPDF` (+ `utils/exportExcel.js`, `utils/exportPdf.js`)
- Placeholder routes for HTML screens **00–15** under `/hms/*` (see `App.jsx`)
- Status chips: waiting=orange, in-progress=blue, done=green, urgent=red (text + color)

### Role + flag model

- Existing `profiles.role` values kept (login/auth unchanged).
- Mapped to HTML’s 6 HMS roles in:
  - `backend/src/permissions/hmsRoles.js`
  - `frontend/src/permissions/hmsPermissions.js`
- Mapping:
  - Admin → Administrator
  - Doctor / Nurse / Receptionist / RecordsOfficer → Clinical staff
  - Midwife / Laboratory / Pharmacy / Accounts → same-named HMS roles
- Extra flags on `profiles` (migration):
  - `can_access_hiv`
  - `can_verify_lab`
  - `can_give_discounts`
  - `can_export_reports`
- Enforcement:
  - **Menu:** `canSeePortal(role, portal, profile)` filters sidebar items
  - **API:** `requirePortal(portalKey)`, `requireFlag(flag)`, `requireExportPermission()` in `backend/src/middleware/permissions.js`
  - Probe: `GET /api/hms/portals/:portalKey` → **403** when unauthorized

### Data foundations (Supabase)

Migration: `backend/supabase/migrations/20261106_phase0_foundations.sql`

1. **Patients** — one shared model remains `profiles` (MRN / Patient ID). View `public.patients` documents that contract.
2. **Encounters** — table `public.encounters` with `patient_id`, `module`, `staff_id`, `date_time`, `status`, `metadata`, optional `source_table`/`source_id`.
   - Service: `backend/src/services/encounterService.js`
   - API: `POST/GET /api/hms/encounters`
3. **Audit** — `audit_logs` actions expanded:  
   `login`, `logout`, `failed_login`, `view`, `create`, `edit`, `delete`, `delete_void`, `print`, `export`, `permission_change`  
   + optional `module` column. Still append-only.
   - Service: `backend/src/services/auditService.js`
   - Sample write: `POST /api/hms/audit/sample` (security portal)

### Export primitives

- Backend (existing + sample routes): `exportService.js` → `GET /api/hms/export/sample.xlsx` / `.pdf` (export flag / Admin)
- Frontend: shared `ExportExcel` / `ExportPDF` components for lists/reports

## How next phases should use this

1. **Do not** create per-module patient tables — always resolve MRN via `profiles` / `patients` view.
2. On every clinical save, also `createEncounter({ patientId, module, staffId, status, … })` (and keep module-specific tables for rich fields).
3. Gate new portal routes with `PortalGuard` + `requirePortal('…')` using the same portal key.
4. HIV UI and HIV PHI: require `can_access_hiv`; lab verify endpoints: `can_verify_lab`; waivers: `can_give_discounts`; downloads: `requireExportPermission` / `ExportExcel|PDF`.
5. Write audit rows for login events, PHI view/edit, print/export, and role/flag changes.
6. Home KPI tiles = `COUNT(*)` from `encounters` filtered by `module` + today (or MTD).

## Apply migration

```bash
# From backend, using your usual Supabase workflow, e.g.:
supabase db push
# or run 20261106_phase0_foundations.sql in the SQL editor
```

Until the migration is applied, auth still works (flags fall back to false / columns ignored via select fallback). Encounter/audit action inserts that need new schema will fail until applied.

## Acceptance checks (Phase 0)

- App boots; login still works; clinical staff land on `/hms`
- Sidebar shows only portals allowed for the role/flags
- `GET /api/hms/portals/billing` as Pharmacy → 403
- `POST /api/hms/audit/sample` as Admin → 201 (after migration)
- Export helpers produce sample `.xlsx` / `.pdf`

Verify script: `node backend/scripts/phase0-verify.js`
