# Phase 7+ quick wins — what shipped + manual steps

Implemented in code (restart backend after pull):

| # | Item | Status |
|---|------|--------|
| 1 | Admin full write on clinical portals (OPD/Lab/Pharmacy/Billing/ANC/…; HIV still needs `can_access_hiv`) | Done — BE + FE matrix |
| 3 | OPD check-in → auto **Arrived** (explicit appt or today’s booked slot) + **Run EOD** button + `npm run eod:mark-missed` | Done |
| 5a | Patient card print + QR (MRN) | Done — Patients portal |
| 5b | Patient photo upload → `photo_url` | Done in UI — **needs bucket migration** |
| 2 | Home ↔ Reports `aligned-counts` expanded to main tiles | Done |
| 9 | Partograph action-line / FHR / BP alerts + richer labour UI | Done (rules + Maternity UI) |
| 10 | Playwright Chromium | **Blocked on this host** (CDN timeout) |

## Manual steps you still need

1. **Restart the API** so matrix + check-in + aligned-counts load:
   ```bash
   # stop old node on :5000, then:
   cd backend && npm start
   ```

2. **Apply photo storage migration** (Supabase SQL editor or CLI):
   - File: `backend/supabase/migrations/20261106_phase7_patient_photos.sql`
   - Creates public bucket `patient-photos` + RLS policies.
   - Without this, “Upload photo” fails.

3. **Optional host cron for EOD missed appointments** (instead of only the UI button):
   ```cron
   5 0 * * * cd /path/to/backend && node scripts/eod-mark-missed.js >> /var/log/hms-eod.log 2>&1
   ```
   Or run once: `cd backend && npm run eod:mark-missed`

4. **HIV for Admin**: matrix is now `full`, but Admin still needs the profile flag **`can_access_hiv = true`** (Users & roles screen) to open `/hms/hiv`.

5. **Playwright Chromium** (on a machine with working download to `cdn.playwright.dev`):
   ```bash
   cd frontend && npx playwright install chromium
   ```
   API smoke already works without the browser: `npm run test:phase7`

6. **Patient card QR** uses `api.qrserver.com` in the print window — needs network when printing; allow pop-ups for the card window.

7. **Confirm with employer** that Admin full clinical write is intentional (overrides original HTML matrix “view” cells).
