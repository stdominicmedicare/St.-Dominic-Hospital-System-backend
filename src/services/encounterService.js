/**
 * Unified encounter / visit writes for all portals.
 */
import { supabase } from '../config/supabase.js';

const ALLOWED_STATUS = new Set([
  'waiting',
  'in_progress',
  'done',
  'urgent',
  'cancelled',
  'no_show',
]);

/**
 * @param {object} input
 * @param {string} input.patientId
 * @param {string} input.module
 * @param {string|null} [input.staffId]
 * @param {string|Date} [input.dateTime]
 * @param {string} [input.status]
 * @param {object} [input.metadata]
 * @param {string|null} [input.sourceTable]
 * @param {string|null} [input.sourceId]
 */
export async function createEncounter({
  patientId,
  module,
  staffId = null,
  dateTime = new Date().toISOString(),
  status = 'waiting',
  metadata = {},
  sourceTable = null,
  sourceId = null,
}) {
  if (!patientId) throw new Error('patientId is required');
  if (!module) throw new Error('module is required');
  if (!ALLOWED_STATUS.has(status)) {
    throw new Error(`Invalid encounter status: ${status}`);
  }

  const row = {
    patient_id: patientId,
    module,
    staff_id: staffId,
    date_time: dateTime,
    status,
    metadata: metadata || {},
    source_table: sourceTable,
    source_id: sourceId,
  };

  const { data, error } = await supabase.from('encounters').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

export async function updateEncounterStatus(id, status, metadataPatch = null) {
  if (!ALLOWED_STATUS.has(status)) {
    throw new Error(`Invalid encounter status: ${status}`);
  }
  const patch = { status, updated_at: new Date().toISOString() };
  if (metadataPatch && typeof metadataPatch === 'object') {
    const { data: existing } = await supabase
      .from('encounters')
      .select('metadata')
      .eq('id', id)
      .single();
    patch.metadata = { ...(existing?.metadata || {}), ...metadataPatch };
  }
  const { data, error } = await supabase
    .from('encounters')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function countEncountersToday({ module, status } = {}) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let q = supabase
    .from('encounters')
    .select('id', { count: 'exact', head: true })
    .gte('date_time', start.toISOString());
  if (module) q = q.eq('module', module);
  if (status) q = q.eq('status', status);
  return q;
}

export async function listEncounters({
  patientId,
  module,
  from,
  to,
  status,
  limit = 50,
  offset = 0,
} = {}) {
  let q = supabase
    .from('encounters')
    .select('*', { count: 'exact' })
    .order('date_time', { ascending: false })
    .range(offset, offset + Math.min(limit, 200) - 1);
  if (patientId) q = q.eq('patient_id', patientId);
  if (module) q = q.eq('module', module);
  if (status) q = q.eq('status', status);
  if (from) q = q.gte('date_time', from);
  if (to) q = q.lte('date_time', to);
  return q;
}
