/**
 * Append-only audit logging for PHI + security events.
 * Writes via service_role; table has no UPDATE/DELETE grants for app roles.
 */
import { supabase } from '../config/supabase.js';

export const AUDIT_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'delete_void',
  'login',
  'logout',
  'failed_login',
  'print',
  'export',
  'permission_change',
];

/**
 * @param {object} entry
 * @param {string|null} entry.actorId
 * @param {string|null} [entry.actorEmail]
 * @param {string|null} [entry.actorRole]
 * @param {string} entry.action
 * @param {string} [entry.resourceType]
 * @param {string|null} [entry.resourceId]
 * @param {string|null} [entry.patientId]
 * @param {string|null} [entry.module]
 * @param {object|null} [entry.before]
 * @param {object|null} [entry.after]
 * @param {object|null} [entry.metadata]
 * @param {import('express').Request} [entry.req]
 */
export async function writeAuditLog({
  actorId = null,
  actorEmail = null,
  actorRole = null,
  action,
  resourceType = 'medical_record',
  resourceId = null,
  patientId = null,
  module = null,
  before = null,
  after = null,
  metadata = null,
  req = null,
}) {
  try {
    if (!AUDIT_ACTIONS.includes(action)) {
      console.error('[audit] invalid action:', action);
      return;
    }
    const row = {
      actor_id: actorId,
      actor_email: actorEmail,
      actor_role: actorRole,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      patient_id: patientId,
      before_data: before,
      after_data: after,
      metadata: {
        ...(metadata || {}),
        ...(module ? { module } : {}),
      },
      ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      user_agent: req?.headers?.['user-agent'] || null,
    };
    if (module) row.module = module;

    let { error } = await supabase.from('audit_logs').insert(row);
    // Pre-migration DBs may lack `module` or expanded action CHECK — retry safely.
    if (error && /module|action|check/i.test(error.message || '')) {
      const fallbackAction = ['view', 'create', 'edit', 'delete'].includes(action)
        ? action
        : 'view';
      const { module: _m, ...legacy } = row;
      legacy.action = fallbackAction;
      legacy.metadata = {
        ...(legacy.metadata || {}),
        intended_action: action,
        module: module || undefined,
      };
      ({ error } = await supabase.from('audit_logs').insert(legacy));
    }
    if (error) {
      console.error('[audit] write failed:', error.message);
    }
  } catch (err) {
    console.error('[audit] write exception:', err?.message || err);
  }
}

/**
 * @param {object} filters
 */
export async function listAuditLogs({
  patientId,
  actorId,
  from,
  to,
  action,
  module,
  limit = 100,
  offset = 0,
} = {}) {
  let q = supabase
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + Math.min(limit, 200) - 1);

  if (patientId) q = q.eq('patient_id', patientId);
  if (actorId) q = q.eq('actor_id', actorId);
  if (action) q = q.eq('action', action);
  if (module) q = q.eq('module', module);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);

  return q;
}
