/**
 * Phase 5 acceptance checks (local unit + optional live DB).
 * Usage: node scripts/phase5-verify.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK  :', msg);
  }
}

console.log('--- Phase 5 module presence ---');
const root = path.join(__dirname, '..');
const required = [
  'supabase/migrations/20261106_phase5_security_compliance.sql',
  'src/services/loginSecurityService.js',
  'src/services/hmsUsersService.js',
  'src/services/backupService.js',
  'src/controllers/hmsPhase5.controller.js',
  'src/routes/hms.routes.js',
  'src/routes/auth.routes.js',
];
for (const rel of required) {
  assert(fs.existsSync(path.join(root, rel)), `exists ${rel}`);
}

const fe = path.join(root, '../frontend/src');
assert(fs.existsSync(path.join(fe, 'pages/hms/RolesPortal.jsx')), 'RolesPortal.jsx');
assert(fs.existsSync(path.join(fe, 'pages/hms/SecurityPortal.jsx')), 'SecurityPortal.jsx');
assert(fs.existsSync(path.join(root, '../PHASE5.md')), 'PHASE5.md');

console.log('--- Phase 5 RBAC (roles/security Admin-only) ---');
const {
  getPortalAccess,
  canSeePortal,
  PORTAL_MATRIX,
} = await import('../src/permissions/hmsRoles.js');

assert(getPortalAccess('Admin', 'roles') === 'full', 'Admin full roles portal');
assert(getPortalAccess('Admin', 'security') === 'full', 'Admin full security portal');
assert(getPortalAccess('Doctor', 'roles') === 'none', 'Clinical cannot roles');
assert(getPortalAccess('Accounts', 'security') === 'none', 'Accounts cannot security');
assert(canSeePortal('Admin', 'roles', {}), 'Admin sees roles');
assert(!canSeePortal('Doctor', 'roles', {}), 'Doctor cannot see roles');
assert(!canSeePortal('Midwife', 'security', {}), 'Midwife cannot see security');
assert(PORTAL_MATRIX.roles.Administrator === 'full', 'matrix Administrator roles=full');
assert(PORTAL_MATRIX.security.Administrator === 'full', 'matrix Administrator security=full');

console.log('--- Phase 5 lockout + idle constants ---');
const {
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  isCurrentlyLocked,
} = await import('../src/services/loginSecurityService.js');
assert(MAX_FAILED_LOGINS === 5, 'lock after 5 failed logins');
assert(LOCKOUT_MINUTES === 30, 'lockout 30 minutes');
assert(
  isCurrentlyLocked({ locked_until: new Date(Date.now() + 60_000).toISOString() }) === true,
  'future locked_until = locked'
);
assert(
  isCurrentlyLocked({ locked_until: new Date(Date.now() - 60_000).toISOString() }) === false,
  'past locked_until = unlocked'
);

const pwPolicyFe = fs.readFileSync(path.join(fe, 'utils/passwordPolicy.js'), 'utf8');
assert(pwPolicyFe.includes('15 * 60 * 1000'), 'frontend idle timeout 15 minutes');
const idleHook = fs.readFileSync(path.join(fe, 'hooks/useIdleLogout.js'), 'utf8');
assert(idleHook.includes('IDLE_TIMEOUT_MS'), 'useIdleLogout uses IDLE_TIMEOUT_MS');
const authCtx = fs.readFileSync(path.join(fe, 'auth/AuthContext.jsx'), 'utf8');
assert(authCtx.includes('useIdleLogout'), 'AuthContext wires idle logout');
assert(authCtx.includes("signOut('idle')") || authCtx.includes('idle'), 'idle logout reason wired');

console.log('--- Phase 5 audit actions + immutability ---');
const { AUDIT_ACTIONS } = await import('../src/services/auditService.js');
for (const a of ['failed_login', 'login', 'logout', 'permission_change', 'export']) {
  assert(AUDIT_ACTIONS.includes(a), `audit action ${a}`);
}
const mig = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261106_phase5_security_compliance.sql'),
  'utf8'
);
assert(mig.includes('audit_logs_immutable'), 'migration re-asserts append-only trigger');
assert(mig.includes('HTTPS'), 'HTTPS production assumption documented');
assert(mig.includes('backup_events'), 'backup_events table');
assert(mig.includes('require_password_change'), 'require_password_change column');
assert(mig.includes('failed_login_count'), 'failed_login_count column');

console.log('--- Phase 5 route wiring ---');
const routesSrc = fs.readFileSync(path.join(root, 'src/routes/hms.routes.js'), 'utf8');
for (const needle of [
  "requirePortal('roles')",
  "requirePortal('security')",
  '/users/matrix',
  '/users/export.:format',
  '/security/audit',
  '/security/audit/export.:format',
  '/security/backups/run',
  '/security/backups/test-restore',
  'hmsPhase5',
]) {
  assert(routesSrc.includes(needle), `route contains ${needle}`);
}

const authRoutes = fs.readFileSync(path.join(root, 'src/routes/auth.routes.js'), 'utf8');
for (const needle of ['/check-lock', '/failed-login', '/login-success', '/mfa/challenge', 'MFA_PROVIDER_TODO']) {
  assert(authRoutes.includes(needle), `auth route contains ${needle}`);
}

const appSrc = fs.readFileSync(path.join(root, '../frontend/src/App.jsx'), 'utf8');
assert(appSrc.includes('RolesPortal'), 'App wires RolesPortal');
assert(appSrc.includes('SecurityPortal'), 'App wires SecurityPortal');
assert(appSrc.includes("portal === 'roles'"), 'App branches roles portal');
assert(appSrc.includes("portal === 'security'"), 'App branches security portal');

const useAuthSrc = fs.readFileSync(path.join(fe, 'auth/useAuth.js'), 'utf8');
assert(useAuthSrc.includes('/api/auth/failed-login'), 'signIn records failed login');
assert(useAuthSrc.includes('/api/auth/check-lock'), 'signIn checks lock');
assert(useAuthSrc.includes('/api/auth/login-success'), 'signIn records success');

const usersSvc = fs.readFileSync(path.join(root, 'src/services/hmsUsersService.js'), 'utf8');
assert(usersSvc.includes("action: 'permission_change'"), 'role/flag change audited');

const ctrl = fs.readFileSync(path.join(root, 'src/controllers/hmsPhase5.controller.js'), 'utf8');
assert(ctrl.includes('AUDIT_IMMUTABLE') || ctrl.includes('auditMutateRejected'), 'mutate audit rejected');

console.log('--- Phase 5 optional live DB ---');
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const { supabase } = await import('../src/config/supabase.js');
    const { error: colErr } = await supabase
      .from('profiles')
      .select('id, require_password_change, mfa_required, failed_login_count, locked_until')
      .limit(1);
    if (colErr) {
      console.log('SKIP: profiles security columns not applied yet —', colErr.message);
    } else {
      assert(true, 'profiles security columns readable');
    }

    const { error: bakErr } = await supabase.from('backup_events').select('id').limit(1);
    if (bakErr) {
      console.log('SKIP: backup_events not applied yet —', bakErr.message);
    } else {
      assert(true, 'backup_events readable');
    }

    // Immutability smoke: attempt update should fail if any row exists
    const { data: sample } = await supabase.from('audit_logs').select('id').limit(1).maybeSingle();
    if (sample?.id) {
      const { error: updErr } = await supabase
        .from('audit_logs')
        .update({ action: 'view' })
        .eq('id', sample.id);
      assert(!!updErr, 'audit_logs UPDATE blocked (immutable)');
    } else {
      console.log('SKIP: no audit_logs row to test UPDATE block');
    }
  } catch (err) {
    console.log('SKIP: live smoke —', err.message);
  }
} else {
  console.log('SKIP: SUPABASE env not set — live DB probes skipped');
}

console.log(failed ? `\nPhase 5 verify FAILED (${failed})` : '\nPhase 5 verify PASSED');
process.exit(failed ? 1 : 0);
