# Apply these SQL migrations on the live Supabase project (SQL Editor), in order:
#
# 1. supabase/migrations/20260917_lock_down_rls.sql
#    — Enables RLS on ALL public tables, drops any open policies, revokes
#      anon/authenticated grants. Clients can no longer read/write via JWT.
#      Express keeps working via service_role (bypasses RLS).
#
# 2. supabase/migrations/20260917_audit_roles_password.sql
#    — Adds Nurse/Receptionist/RecordsOfficer roles, password_changed_at, audit_logs table.
#
# 3. supabase/migrations/20260917_patient_records_reports.sql
#    — MRN, DOB, merge support, enriched signup trigger.
#
# 4. supabase/migrations/20260917_consent_departments.sql
#    — Patient data-storage consent columns + departments catalog (extensible).
#
# Also enable MFA (TOTP) in Supabase Dashboard:
#   Authentication → Providers / Multi-Factor → Enable TOTP
#
# After deploy:
# - Admins: open /admin/security and enroll an authenticator app.
# - Admin API routes require MFA (AAL2). Password-expired accounts are blocked
#   on all APIs except /api/auth/me and /api/auth/change-password.
# - Assign a RecordsOfficer account to own ongoing audit review (St. Dominic Care).
# - Designate a site Super User (see Compliance-Training-Docs).
# - Apply migration 4 before relying on consent checkboxes / department list.
#
# RLS model (all tables):
# - ROW LEVEL SECURITY enabled
# - No permissive policies for anon/authenticated (deny by default)
# - Table grants revoked from anon/authenticated
# - All data access via Express + SUPABASE_SERVICE_ROLE_KEY
