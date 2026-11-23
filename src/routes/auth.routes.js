/**
 * Auth routes: profile, password change, login security hooks (Phase 5).
 * Public endpoints (no JWT): check-lock, failed-login.
 * Authenticated: me, change-password, login-success, logout, mfa stub.
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { supabase } from '../config/supabase.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import {
  checkLoginAllowed,
  recordFailedLogin,
  recordSuccessfulLogin,
  recordLogout,
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
} from '../services/loginSecurityService.js';

const router = Router();

/** GET /api/auth/security-policy — public summary of login rules (for login page). */
router.get('/security-policy', (_req, res) => {
  res.json({
    max_failed_logins: MAX_FAILED_LOGINS,
    lockout_minutes: LOCKOUT_MINUTES,
    idle_logout_minutes: 15,
    https_required_in_production: true,
  });
});

/**
 * POST /api/auth/check-lock — public pre-check before Supabase sign-in.
 * Body: { email }
 */
router.post('/check-lock', async (req, res) => {
  try {
    const email = req.body?.email;
    const result = await checkLoginAllowed(email);
    if (!result.ok) {
      return res.status(403).json({
        error: result.error,
        code: result.code,
        locked_until: result.locked_until || null,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/failed-login — public; increments counter + audit + lock after 5.
 * Body: { email, reason? }
 */
router.post('/failed-login', async (req, res) => {
  try {
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const pre = await checkLoginAllowed(email);
    if (!pre.ok && pre.code === 'ACCOUNT_LOCKED') {
      await recordFailedLogin({
        email,
        req,
        reason: 'Attempt while locked',
      });
      return res.status(403).json({
        error: pre.error,
        code: pre.code,
        locked_until: pre.locked_until,
      });
    }
    if (!pre.ok && pre.code === 'ACCOUNT_DEACTIVATED') {
      return res.status(403).json({ error: pre.error, code: pre.code });
    }
    const result = await recordFailedLogin({
      email,
      req,
      reason: req.body?.reason || 'Invalid login credentials',
    });
    if (result.locked) {
      return res.status(403).json({
        error: `Account locked after ${MAX_FAILED_LOGINS} failed logins for ${LOCKOUT_MINUTES} minutes.`,
        code: 'ACCOUNT_LOCKED',
        locked_until: result.locked_until,
        failed_count: result.failed_count,
      });
    }
    res.json({
      ok: true,
      failed_count: result.failed_count,
      remaining_attempts: result.remaining_attempts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Authenticated routes below ----
router.use(authMiddleware);

/** GET /api/auth/me – current user's profile. */
router.get('/me', (req, res) => {
  res.json(req.profile || {});
});

/**
 * POST /api/auth/change-password – authenticated user sets a new password.
 * Clears require_password_change and refreshes password_changed_at.
 */
router.post('/change-password', async (req, res) => {
  try {
    const { password } = req.body || {};
    const check = validatePassword(password);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password });
    if (error) return res.status(400).json({ error: error.message });

    const now = new Date().toISOString();
    await supabase
      .from('profiles')
      .update({
        password_changed_at: now,
        require_password_change: false,
        updated_at: now,
      })
      .eq('id', req.user.id);

    res.json({
      message: 'Password updated',
      password_changed_at: now,
      require_password_change: false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login-success — reset lockout counters + write login audit.
 */
router.post('/login-success', async (req, res) => {
  try {
    const result = await recordSuccessfulLogin({
      userId: req.user.id,
      email: req.user.email,
      role: req.role,
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/logout — audit logout (idle | manual).
 */
router.post('/logout', async (req, res) => {
  try {
    await recordLogout({
      userId: req.user.id,
      email: req.user.email,
      role: req.role,
      req,
      reason: req.body?.reason || 'manual',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/mfa/challenge — stub until SMS/TOTP provider is configured.
 * TODO: integrate Twilio / Supabase MFA enroll + challenge.
 */
router.post('/mfa/challenge', async (req, res) => {
  const required = Boolean(req.profile?.mfa_required);
  res.status(501).json({
    error: '2-step verification provider not configured',
    code: 'MFA_PROVIDER_TODO',
    mfa_required: required,
    aal: req.aal || 'aal1',
    todo: 'Wire Supabase Auth MFA (TOTP) or SMS provider. Administrator requires aal2 before full access when ENABLE_MFA_ENFORCEMENT=true.',
  });
});

router.get('/mfa/status', (req, res) => {
  res.json({
    mfa_required: Boolean(req.profile?.mfa_required),
    mfa_ok: Boolean(req.profile?.mfa_ok),
    aal: req.aal || 'aal1',
    provider_configured: Boolean(process.env.SMS_PROVIDER || process.env.ENABLE_SUPABASE_MFA),
    enforcement: process.env.ENABLE_MFA_ENFORCEMENT === 'true',
    note:
      'TODO: SMS/app provider. Flags and UI are wired; set ENABLE_MFA_ENFORCEMENT=true after provider is live.',
  });
});

export default router;
