-- Split Clinical staff into Clerk / Nurse / Doctor.
-- Apply in Supabase SQL Editor.
--
-- IMPORTANT (Postgres enum rule): run Statement 1 alone first and commit,
-- then run Statement 2. If you paste both at once and UPDATE fails with
-- "unsafe use of new value", re-run only Statement 2.

-- ===== Statement 1 =====
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'Clerk';

-- ===== Statement 2 (run after Statement 1 has committed) =====
UPDATE public.profiles
SET role = 'Clerk'
WHERE role::text IN ('Receptionist', 'RecordsOfficer');
