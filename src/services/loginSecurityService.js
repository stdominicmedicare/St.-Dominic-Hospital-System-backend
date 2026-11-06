/**
 * Phase 5 — failed-login lockout (5 attempts → lock 30 min) + login audit helpers.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from './auditService.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 30;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function findProfileByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  let { data, error } = await supabase
    .from('profiles')
    .select(
      'id, email, role, full_name, is_active, failed_login_count, locked_until, require_password_change, mfa_required'
    )
    .ilike('email', normalized)
    .maybeSingle();
  if (error && /failed_login_count|locked_until|require_password_change|mfa_required/i.test(error.message || '')) {
    ({ data, error } = await supabase
      .from('profiles')
      .select('id, email, role, full_name, is_active')
      .ilike('email', normalized)
      .maybeSingle());
  }
  if (error) {
    console.error('[loginSecurity] findProfileByEmail:', error.message);
    return null;
  }
  return data;
}

export function isCurrentlyLocked(profile) {
  if (!profile?.locked_until) return false;
  const until = new Date(profile.locked_until).getTime();
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Public pre-check before Supabase password auth.
 */
export async function checkLoginAllowed(email) {
  const profile = await findProfileByEmail(email);
  if (!profile) {
    return { ok: true, profile: null };
  }
  if (profile.is_active === false) {
    return {
      ok: false,
      code: 'ACCOUNT_DEACTIVATED',
      error: 'Account suspended. Contact an administrator.',
      profile,
    };
  }
  if (isCurrentlyLocked(profile)) {
    return {
      ok: false,
      code: 'ACCOUNT_LOCKED',
      error: `Account locked after ${MAX_FAILED_LOGINS} failed logins. Try again after ${new Date(profile.locked_until).toLocaleString()} or contact an administrator.`,
      locked_until: profile.locked_until,
      profile,
    };
  }
  return { ok: true, profile };
}

/**
 * Record a failed password attempt. Locks after MAX_FAILED_LOGINS.
 */
export async function recordFailedLogin({ email, req = null, reason = 'Invalid login credentials' } = {}) {
  const profile = await findProfileByEmail(email);
  const actorEmail = normalizeEmail(email) || null;
  let locked = false;
  let failedCount = 0;
  let lockedUntil = null;

  if (profile) {
    if (isCurrentlyLocked(profile)) {
      locked = true;
      lockedUntil = profile.locked_until;
      failedCount = profile.failed_login_count || MAX_FAILED_LOGINS;
    } else {
      failedCount = Number(profile.failed_login_count || 0) + 1;
      const updates = {
        failed_login_count: failedCount,
        updated_at: new Date().toISOString(),
      };
      if (failedCount >= MAX_FAILED_LOGINS) {
        lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
        updates.locked_until = lockedUntil;
        locked = true;
      }
      const { error: upErr } = await supabase.from('profiles').update(updates).eq('id', profile.id);
      if (upErr) {
        console.warn(
          '[loginSecurity] lockout column update failed (apply Phase 5 migration):',
          upErr.message
        );
      }
    }
  }

  await writeAuditLog({
    actorId: profile?.id || null,
    actorEmail,
    actorRole: profile?.role || null,
    action: 'failed_login',
    resourceType: 'auth',
    resourceId: profile?.id || null,
    module: 'security',
    metadata: {
      reason,
      failed_count: failedCount || null,
      locked,
      locked_until: lockedUntil,
      lockout_minutes: locked ? LOCKOUT_MINUTES : null,
    },
    req,
  });

  return {
    locked,
    failed_count: failedCount,
    locked_until: lockedUntil,
    remaining_attempts: profile
      ? Math.max(0, MAX_FAILED_LOGINS - failedCount)
      : null,
  };
}

/**
 * Clear lockout counters and write successful login audit.
 */
export async function recordSuccessfulLogin({ userId, email, role, req = null } = {}) {
  const now = new Date().toISOString();
  if (userId) {
    await supabase
      .from('profiles')
      .update({
        failed_login_count: 0,
        locked_until: null,
        last_login_at: now,
        updated_at: now,
      })
      .eq('id', userId);
  }

  await writeAuditLog({
    actorId: userId || null,
    actorEmail: email || null,
    actorRole: role || null,
    action: 'login',
    resourceType: 'auth',
    resourceId: userId || null,
    module: 'security',
    metadata: { method: 'password' },
    req,
  });

  return { ok: true, last_login_at: now };
}

export async function recordLogout({ userId, email, role, req = null, reason = 'manual' } = {}) {
  await writeAuditLog({
    actorId: userId || null,
    actorEmail: email || null,
    actorRole: role || null,
    action: 'logout',
    resourceType: 'auth',
    resourceId: userId || null,
    module: 'security',
    metadata: { reason },
    req,
  });
  return { ok: true };
}

/**
 * Admin unlock / clear failed counters.
 */
export async function unlockAccount(userId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('profiles')
    .update({
      failed_login_count: 0,
      locked_until: null,
      updated_at: now,
    })
    .eq('id', userId)
    .select('id, email, locked_until, failed_login_count')
    .single();
  if (error) throw new Error(error.message);
  return data;
}
