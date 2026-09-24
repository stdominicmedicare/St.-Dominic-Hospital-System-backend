# Apply these SQL migrations on the live Supabase project (SQL Editor), in order:
#
# 1. supabase/migrations/20260917_lock_down_rls.sql
# 2. supabase/migrations/20260917_audit_roles_password.sql
# 3. supabase/migrations/20260917_patient_records_reports.sql
# 4. supabase/migrations/20260917_consent_departments.sql
# 5. supabase/migrations/20260924_jims_modules.sql
#    — Midwife/Laboratory/Accounts roles + OPD, billing, MCH, lab, immunization, FP, HIV tables.
#
# After deploy:
# - Create staff users with Midwife, Laboratory, Accounts roles as needed.
# - Assign a RecordsOfficer account to own ongoing audit review.
#
# RLS model (all tables):
# - ROW LEVEL SECURITY enabled
# - No permissive policies for anon/authenticated (deny by default)
# - Table grants revoked from anon/authenticated
# - All data access via Express + SUPABASE_SERVICE_ROLE_KEY
