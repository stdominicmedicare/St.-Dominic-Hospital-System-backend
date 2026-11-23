# St Dominic HMS — Phase 6 Existing-module integration

Fold **Doctors · ICU · Ambulance · Blood bank** (plus Volunteer admin/ops) into the HMS shell without losing core features.

HTML source: `muneeb bhai/St-Dominic-HMS (1).html` — sidebar line *Existing: Doctors · ICU · Ambulance · Blood bank*.

## Apply migration

```bash
# Supabase SQL editor (or supabase db push):
backend/supabase/migrations/20261106_phase6_existing_modules.sql
```

Then:

```bash
cd backend && node scripts/phase6-verify.js
```

## What was added

### Navigation / shell

| Change | Detail |
|--------|--------|
| Sidebar section | Label matches HTML: **Existing: Doctors · ICU · Ambulance · Blood bank** |
| Destinations | Operator roles → `/doctor`, `/icu`, `/ambulance`, `/bloodbank`; Admin → `/admin/doctors`, `/admin/icu`, `/admin/ambulances`, `/bloodbank` |
| Legacy competitors removed | Legacy OPD / lab / pharmacy / programs / accounts / admin home links no longer clutter the sidebar |
| Volunteer | Kept for Admin + Volunteer (Admin → volunteer management) |
| Patient portal | Still `/patient` (dedicated role home; not duplicated in staff sidebar) |
| Mobile | Doctor bottom nav includes Doctors workspace; Ambulance / Blood bank have dedicated items |

### Shared patient / MRN

- Doctor / ICU / Ambulance / Blood bank APIs project `mrn` with patient profiles (`PATIENT_MIN_FIELDS`)
- Doctor UI shows **MRN · name** in lists and pickers
- FKs remain `profiles.id`; MRN is display / shared Patient ID

### Encounters

`encounters.module` allow-list extended with `doctor`, `icu`, `ambulance`, `bloodbank`.

Writes (best-effort via `safeCreateEncounter`):

| Event | Module |
|-------|--------|
| Medical record / prescription | `doctor` |
| Doctor ICU admission request | `icu` |
| Doctor ambulance / blood request | `ambulance` / `bloodbank` |
| ICU admit / discharge | `icu` |
| Ambulance trip complete | `ambulance` |
| Blood allocate / transfusion | `bloodbank` |

### Home + Reports

- View `hms_phase6_existing_counts` + fallback counts
- Home tiles + alerts deep-link into existing modules
- Reports catalog: **Doctors · ICU · Ambulance · Blood bank activity** (`existing_modules`)

### RBAC

- Route `RoleGuard` unchanged for operators (Doctor / ICU / Ambulance / BloodBank)
- Unauthorized roles still blocked
- Admin uses management screens (or Blood bank ops API which already allows Admin)
- Portal matrix entries for `doctors` / `icu` / `ambulance` / `bloodbank` kept in sync FE/BE

## Acceptance mapping

| Test | How |
|------|-----|
| Each module opens from new sidebar | Sidebar `EXISTING_MODULE_LINKS` + role-aware `toForRole` |
| Core actions still work | Same dashboards/APIs; encounters additive only |
| Unauthorized roles blocked | `RoleGuard` + API `requireRole` |
| No competing top-nav | Header is brand/user only; primary nav = department sidebar; legacy duplicate links removed |

## Exit checklist

- [x] Existing modules reachable in new nav  
- [x] Shared MRN on patient projections where applicable  
- [x] Encounter rows for Home/Reports  
- [x] RBAC consistent  
- [x] Dashboard deep links / alerts  
- [x] No major regressions (legacy competing nav removed; operator workspaces intact)

## Notes

- Apply Phase 0–5 migrations before Phase 6.
- Doctor-initiated ICU/ambulance/blood still lives in the Doctors workspace; ICU/Ambulance/Blood bank staff work queues remain on their portals.
