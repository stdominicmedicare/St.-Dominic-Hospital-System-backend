/**
 * Portal + flag guards for St Dominic HMS.
 * Use after authMiddleware. Documented in PHASE0.md.
 */
import {
  canSeePortal,
  canExportReports,
  getPortalAccess,
  normalizeFlags,
  toHmsRole,
  canOpdAction,
} from '../permissions/hmsRoles.js';

function flagsFromReq(req) {
  return normalizeFlags(req.profile || req.flags || {});
}

/**
 * Require non-none portal access (and HIV flag for hiv portal).
 * Responds 403 when unauthorized.
 */
export function requirePortal(portalKey, { minLevel = 'view' } = {}) {
  const rank = { none: 0, view: 1, edit: 2, full: 3 };
  return (req, res, next) => {
    const flags = flagsFromReq(req);
    req.flags = flags;
    req.hmsRole = toHmsRole(req.role);

    if (!canSeePortal(req.role, portalKey, flags)) {
      return res.status(403).json({
        error: 'Forbidden: no access to this portal',
        code: 'PORTAL_FORBIDDEN',
        portal: portalKey,
      });
    }

    const level = getPortalAccess(req.role, portalKey);
    if ((rank[level] || 0) < (rank[minLevel] || 0)) {
      return res.status(403).json({
        error: `Forbidden: requires ${minLevel} access to ${portalKey}`,
        code: 'PORTAL_LEVEL_FORBIDDEN',
        portal: portalKey,
        level,
      });
    }

    req.portalAccess = level;
    next();
  };
}

/** Require a named boolean flag on the profile. Administrator bypasses flags. */
export function requireFlag(flagKey) {
  return (req, res, next) => {
    const flags = flagsFromReq(req);
    req.flags = flags;
    if (toHmsRole(req.role) === 'Administrator') return next();
    if (!flags[flagKey]) {
      return res.status(403).json({
        error: `Forbidden: missing permission flag ${flagKey}`,
        code: 'FLAG_FORBIDDEN',
        flag: flagKey,
      });
    }
    next();
  };
}

/** Export reports / lists — Admin always; others need can_export_reports. */
export function requireExportPermission() {
  return (req, res, next) => {
    const flags = flagsFromReq(req);
    req.flags = flags;
    if (!canExportReports(req.role, flags)) {
      return res.status(403).json({
        error: 'Forbidden: export reports permission required',
        code: 'EXPORT_FORBIDDEN',
      });
    }
    next();
  };
}

/**
 * OPD workflow action gate (check_in | triage | consult).
 * Use after requirePortal('opd', …).
 */
export function requireOpdAction(action) {
  return (req, res, next) => {
    if (!canOpdAction(req.role, action)) {
      return res.status(403).json({
        error: `Forbidden: role cannot perform OPD action ${action}`,
        code: 'OPD_ACTION_FORBIDDEN',
        action,
        role: req.role,
      });
    }
    next();
  };
}

export { canSeePortal, getPortalAccess, normalizeFlags, toHmsRole, canOpdAction };
