/**
 * Role guard: require one of the given roles. Use after authMiddleware.
 * Prefer requirePortal / requireFlag from ./permissions.js for HMS portals.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.role) {
      return res.status(403).json({ error: 'Forbidden: role not found' });
    }
    if (!allowedRoles.includes(req.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

export {
  requirePortal,
  requireFlag,
  requireExportPermission,
} from './permissions.js';
