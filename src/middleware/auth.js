/**
 * Auth middleware: verify Supabase JWT from Authorization: Bearer <token>.
 * Attaches req.user (id, email), req.role and req.profile from profiles table.
 * Rejects deactivated / locked accounts.
 * Hard-blocks expired passwords / force-change except /auth/me and /auth/change-password.
 * MFA: Administrators always have mfa_required; soft/hard gate via ENABLE_MFA_ENFORCEMENT.
 */
import { createClient } from '@supabase/supabase-js';
import { supabase as supabaseAdmin } from '../config/supabase.js';
import { isPasswordExpired } from '../utils/passwordPolicy.js';
import { getAalFromToken } from '../utils/jwtClaims.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

function isPasswordExemptPath(req) {
  const path = `${req.baseUrl || ''}${req.path || ''}`;
  return (
    path === '/api/auth/me' ||
    path === '/api/auth/change-password' ||
    path === '/api/auth/logout' ||
    path === '/api/auth/login-success' ||
    path === '/api/auth/mfa/status' ||
    path === '/api/auth/mfa/challenge' ||
    path.endsWith('/auth/me') ||
    path.endsWith('/auth/change-password') ||
    path.endsWith('/auth/logout') ||
    path.endsWith('/auth/login-success') ||
    path.endsWith('/auth/mfa/status') ||
    path.endsWith('/auth/mfa/challenge')
  );
}

function isMfaExemptPath(req) {
  return isPasswordExemptPath(req) || (() => {
    const path = `${req.baseUrl || ''}${req.path || ''}`;
    return path.endsWith('/auth/login-success');
  })();
}

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const client = createClient(supabaseUrl || '', supabaseAnonKey || '', {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  let user;
  let authError;
  try {
    const result = await client.auth.getUser(token);
    user = result?.data?.user;
    authError = result?.error;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const PROFILE_SELECT =
    'id, email, role, full_name, phone, department, is_active, password_changed_at, require_password_change, mfa_required, failed_login_count, locked_until, last_login_at, can_access_hiv, can_verify_lab, can_give_discounts, can_export_reports';

  let { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', user.id)
    .single();

  // Fallback if newer columns not migrated yet
  if (
    profileError &&
    /password_changed_at|can_access_hiv|require_password_change|mfa_required|locked_until|failed_login|department|last_login/i.test(
      String(profileError.message || '')
    )
  ) {
    const fallback = await supabaseAdmin
      .from('profiles')
      .select(
        'id, email, role, full_name, is_active, password_changed_at, can_access_hiv, can_verify_lab, can_give_discounts, can_export_reports'
      )
      .eq('id', user.id)
      .single();
    profile = fallback.data;
    if (fallback.error && String(fallback.error.message || '').includes('password_changed_at')) {
      const basic = await supabaseAdmin
        .from('profiles')
        .select('id, email, role, full_name, is_active')
        .eq('id', user.id)
        .single();
      profile = basic.data;
    }
  }

  if (profile && profile.is_active === false) {
    return res.status(403).json({
      error: 'Account deactivated. Contact an administrator.',
      code: 'ACCOUNT_DEACTIVATED',
    });
  }

  if (
    profile?.locked_until &&
    new Date(profile.locked_until).getTime() > Date.now() &&
    !isPasswordExemptPath(req)
  ) {
    return res.status(403).json({
      error: 'Account locked after failed logins. Contact an administrator or wait for lockout to expire.',
      code: 'ACCOUNT_LOCKED',
      locked_until: profile.locked_until,
    });
  }

  const forceChange = Boolean(profile?.require_password_change);
  const passwordExpired = forceChange || isPasswordExpired(profile?.password_changed_at);
  if (passwordExpired && !isPasswordExemptPath(req)) {
    return res.status(403).json({
      error: forceChange
        ? 'Password change required before continuing.'
        : 'Password expired. Change your password to continue.',
      code: forceChange ? 'PASSWORD_CHANGE_REQUIRED' : 'PASSWORD_EXPIRED',
    });
  }

  const aal = getAalFromToken(token);
  const isAdmin = profile?.role === 'Admin';
  const mfaRequired = isAdmin || Boolean(profile?.mfa_required);
  const mfaOk = !mfaRequired || aal === 'aal2';
  const enforceMfa = process.env.ENABLE_MFA_ENFORCEMENT === 'true';

  if (enforceMfa && mfaRequired && !mfaOk && !isMfaExemptPath(req)) {
    return res.status(403).json({
      error: '2-step verification required for this account.',
      code: 'MFA_REQUIRED',
      aal,
      // TODO: SMS/TOTP provider — use POST /api/auth/mfa/challenge when configured
    });
  }

  req.aal = aal;
  req.user = { id: user.id, email: user.email };
  req.role = profile?.role || null;
  req.flags = {
    can_access_hiv: Boolean(profile?.can_access_hiv),
    can_verify_lab: Boolean(profile?.can_verify_lab),
    can_give_discounts: Boolean(profile?.can_give_discounts),
    can_export_reports: Boolean(profile?.can_export_reports),
  };
  req.profile = profile
    ? {
        ...profile,
        ...req.flags,
        password_expired: passwordExpired,
        require_password_change: forceChange,
        mfa_required: mfaRequired,
        mfa_ok: mfaOk,
        mfa_enforced: enforceMfa,
        aal,
      }
    : null;
  next();
}
