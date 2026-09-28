-- Lock down Supabase RLS for St. Dominic Care (apply on existing projects).
--
-- Problem: bootstrap schema created FOR ALL TO authenticated USING (true)
-- WITH CHECK (true) on every table, so any logged-in user could read/write
-- PHI via PostgREST with their session JWT, bypassing Express RBAC.
--
-- Fix: enable RLS on every public table, drop any client-facing policies,
-- keep RLS enabled with no permissive policies (deny for anon/authenticated),
-- revoke table grants from client roles. Express keeps working because it
-- uses the service_role key, which bypasses RLS.
--
-- Run in Supabase SQL Editor (or psql) against the live project.

DO $$
DECLARE
  r record;
  pol record;
BEGIN
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'  -- ordinary tables only
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);

    -- Drop every policy so JWT roles have zero permissive access.
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = r.tablename
    LOOP
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        pol.policyname,
        r.tablename
      );
    END LOOP;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO service_role;
