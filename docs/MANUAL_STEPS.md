# Manual steps required (Phase 7 follow-up features)

Code for the requested gaps is in the repo. Complete these host/Supabase steps so they work in your environment.

---

## 1. Apply patient-photos storage migration (photo upload)

**File:** `backend/supabase/migrations/20261106_phase7_patient_photos.sql`

1. Open [Supabase SQL Editor](https://supabase.com/dashboard) for project `vijdigprkjoytmfnaahp`.
2. Paste and run the migration SQL (creates public bucket `patient-photos` + RLS policies).
3. Confirm under **Storage** that bucket `patient-photos` exists and is **Public**.

Without this, **Upload photo** on `/hms/patients` will fail with a storage/policy error.

---

## 2. Restart API + frontend (pick up Admin matrix + OPD arrive + partograph)

```bash
# Backend (stop old process on :5000 first if needed)
cd backend && npm start

# Frontend
cd frontend && npm run dev -- --host 127.0.0.1 --port 5173
```

Re-login as Admin so `/api/hms/me` refreshes portal levels (`full` on clinical portals).

---

## 3. Schedule end-of-day “mark missed” (optional cron)

UI button already works: Appointments → **Mark missed / Run EOD**.

For automatic nightly runs on the server:

```bash
cd /path/to/Memon/backend
npm run eod:mark-missed
# or: node scripts/eod-mark-missed.js
# optional date: node scripts/eod-mark-missed.js 2026-11-06
```

**Crontab example** (00:05 every day):

```cron
5 0 * * * cd /path/to/Memon/backend && /usr/bin/node scripts/eod-mark-missed.js >> /var/log/hms-eod.log 2>&1
```

Ensure the host has `backend/.env` with Supabase service credentials.

---

## 4. Playwright Chromium (UI e2e) — network blocked on this machine

Download timed out from `cdn.playwright.dev` here. On a machine with better network:

```bash
cd frontend
npx playwright install chromium
# optional system deps on Linux:
# npx playwright install-deps chromium
npm run test:phase7
```

API smoke does **not** need the browser (`npm run test:phase7` still runs request tests if browsers missing for UI-only cases).

---

## 5. Quick verification checklist (after 1–2)

| Feature | How to verify |
|---------|----------------|
| Admin clinical write | Login Admin → `/hms/opd` → Check in works (no 403) |
| Auto Arrived | Book OPD appt for today → Check in same patient → appt status **arrived** |
| EOD missed | Appointments → Run EOD → booked rows become missed |
| Print / QR | Patients → open record → **Print card / QR** (allow pop-ups) |
| Photo | After migration → Upload photo on patient record |
| Home ↔ Reports | `/hms` footer shows aligned OPD/lab/invoices/labour counts |
| Partograph alerts | Maternity → add entry with FHR 90 or slow cervix progress → red alert |

---

## Not required for these features

- No new env vars beyond existing `SUPABASE_*` / `VITE_*`.
- SMS, MFA, HTTPS-only, off-site backups remain separate ops work (not in this batch).
