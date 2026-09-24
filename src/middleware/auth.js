/**
 * Auth middleware: verify Supabase JWT from Authorization: Bearer <token>.
 * Attaches req.user (id, email), req.role and req.profile from profiles table.
 * Rejects deactivated accounts (is_active = false).
 * Hard-blocks expired passwords except /auth/me and /auth/change-password.
 */
import { createClient } from '@supabase/supabase-js';
import { supabase as supabaseAdmin } from '../config/supabase.js';
import { isPasswordExpired } from '../utils/passwordPolicy.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

function isPasswordExemptPath(req) {
  const path = `${req.baseUrl || ''}${req.path || ''}`;
  return (
    path === '/api/auth/me' ||
    path === '/api/auth/change-password' ||
    path.endsWith('/auth/me') ||
    path.endsWith('/auth/change-password')
  );
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

  let { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, email, role, full_name, is_active, password_changed_at')
    .eq('id', user.id)
    .single();

  // Fallback if password_changed_at column not migrated yet
  if (profileError && String(profileError.message || '').includes('password_changed_at')) {
    const fallback = await supabaseAdmin
      .from('profiles')
      .select('id, email, role, full_name, is_active')
      .eq('id', user.id)
      .single();
    profile = fallback.data;
  }

  if (profile && profile.is_active === false) {
    return res.status(403).json({
      error: 'Account deactivated. Contact an administrator.',
      code: 'ACCOUNT_DEACTIVATED',
    });
  }

  const passwordExpired = isPasswordExpired(profile?.password_changed_at);
  if (passwordExpired && !isPasswordExemptPath(req)) {
    return res.status(403).json({
      error: 'Password expired. Change your password to continue.',
      code: 'PASSWORD_EXPIRED',
    });
  }

  req.user = { id: user.id, email: user.email };
  req.role = profile?.role || null;
  req.profile = profile
    ? {
        ...profile,
        password_expired: passwordExpired,
      }
    : null;
  next();
}
