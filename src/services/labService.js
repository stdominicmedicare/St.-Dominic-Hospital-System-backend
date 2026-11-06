/**
 * Phase 2 laboratory workflow + catalogue + billing charges.
 * Workflow: requested → sample_collected → in_progress → result_entered → verified → sent
 */
import { supabase } from '../config/supabase.js';
import { nextDocumentNo } from './documentSequenceService.js';
import { createEncounter, updateEncounterStatus } from './encounterService.js';
import { addChargeLine } from './billingService.js';
import { writeAuditLog } from './auditService.js';

const ORDER_FLOW = [
  'requested',
  'sample_collected',
  'in_progress',
  'result_entered',
  'verified',
  'sent',
];

function normalizeOrderStatus(status) {
  const map = {
    ordered: 'requested',
    collected: 'sample_collected',
    completed: 'verified',
    resulted: 'result_entered',
  };
  return map[status] || status;
}

export function flagResultValue(value, test) {
  const num = Number(value);
  if (value == null || value === '' || Number.isNaN(num)) {
    return { flag: null, is_critical: false, flagged: false };
  }
  const { ref_low: lo, ref_high: hi, critical_low: clo, critical_high: chi } = test || {};
  let flag = null;
  let is_critical = false;
  if (clo != null && num <= Number(clo)) {
    flag = 'L';
    is_critical = true;
  } else if (chi != null && num >= Number(chi)) {
    flag = 'H';
    is_critical = true;
  } else if (lo != null && num < Number(lo)) {
    flag = 'L';
  } else if (hi != null && num > Number(hi)) {
    flag = 'H';
  }
  return { flag, is_critical, flagged: Boolean(flag) };
}

async function loadTests(testIds) {
  const { data, error } = await supabase.from('lab_tests').select('*').in('id', testIds);
  if (error) throw error;
  return data || [];
}

/**
 * Create lab request (from OPD Order lab or walk-in). Charges Billing per test.
 */
export async function createLabRequest({
  patientId,
  testIds,
  priority = 'routine',
  source = 'OPD',
  opdVisitId = null,
  notes = null,
  sampleType = null,
  actor = {},
  req = null,
}) {
  if (!patientId || !Array.isArray(testIds) || !testIds.length) {
    throw new Error('patientId and testIds[] required');
  }

  const tests = await loadTests(testIds);
  if (tests.length !== testIds.length) throw new Error('One or more tests not found');

  const request_no = await nextDocumentNo('lab_request');
  const encounter = await createEncounter({
    patientId,
    module: 'lab',
    staffId: actor.id || null,
    status: priority === 'urgent' || priority === 'stat' ? 'urgent' : 'waiting',
    metadata: { request_no, source, opd_visit_id: opdVisitId },
    sourceTable: 'lab_orders',
  });

  const { data: order, error } = await supabase
    .from('lab_orders')
    .insert({
      request_no,
      patient_id: patientId,
      ordered_by: actor.id || null,
      status: 'requested',
      priority: priority || 'routine',
      notes: notes || null,
      source: source || 'OPD',
      opd_visit_id: opdVisitId || null,
      encounter_id: encounter.id,
      sample_type: sampleType || tests[0]?.specimen_type || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  await supabase
    .from('encounters')
    .update({ source_id: order.id })
    .eq('id', encounter.id);

  const items = testIds.map((test_id) => ({
    order_id: order.id,
    test_id,
    status: 'pending',
  }));
  const { data: insertedItems, error: iErr } = await supabase
    .from('lab_order_items')
    .insert(items)
    .select('*');
  if (iErr) throw iErr;

  const lineIds = [];
  for (const test of tests) {
    const { line } = await addChargeLine({
      patientId,
      opdVisitId,
      chargeItemId: test.charge_item_id || null,
      description: `Lab: ${test.name}`,
      quantity: 1,
      unitPrice: test.price != null ? test.price : 0,
      sourceModule: 'lab',
      sourceTable: 'lab_orders',
      sourceId: order.id,
      createdBy: actor.id || null,
      actor,
      req,
    });
    lineIds.push(line.id);
  }

  if (lineIds.length) {
    await supabase
      .from('lab_orders')
      .update({ invoice_line_ids: lineIds, updated_at: new Date().toISOString() })
      .eq('id', order.id);
  }

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'create',
    resourceType: 'lab_order',
    resourceId: order.id,
    patientId,
    module: 'lab',
    after: { ...order, items: insertedItems, invoice_line_ids: lineIds },
    req,
  });

  return { ...order, items: insertedItems, encounter_id: encounter.id };
}

export async function advanceLabOrder({
  orderId,
  toStatus,
  sampleId = null,
  sampleType = null,
  actor = {},
  req = null,
}) {
  const target = normalizeOrderStatus(toStatus);
  const { data: order } = await supabase.from('lab_orders').select('*').eq('id', orderId).single();
  if (!order) throw new Error('Lab order not found');
  if (['verified', 'sent'].includes(normalizeOrderStatus(order.status)) && target !== 'sent') {
    throw new Error('Verified/sent orders cannot move backwards');
  }

  const patch = {
    status: target,
    updated_at: new Date().toISOString(),
  };
  if (target === 'sample_collected') {
    patch.collected_at = new Date().toISOString();
    patch.collected_by = actor.id || null;
    if (sampleId) patch.sample_id = sampleId;
    if (sampleType) patch.sample_type = sampleType;
  }
  if (target === 'sent') {
    patch.sent_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('lab_orders')
    .update(patch)
    .eq('id', orderId)
    .select('*')
    .single();
  if (error) throw error;

  if (order.encounter_id) {
    const encStatus =
      target === 'sent' || target === 'verified'
        ? 'done'
        : target === 'requested'
          ? 'waiting'
          : 'in_progress';
    try {
      await updateEncounterStatus(order.encounter_id, encStatus, { lab_status: target });
    } catch {
      /* encounter optional */
    }
  }

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'lab_order',
    resourceId: orderId,
    patientId: order.patient_id,
    module: 'lab',
    before: { status: order.status },
    after: { status: target },
    req,
  });

  return data;
}

export async function enterResult({
  itemId,
  value,
  unit = null,
  resultNotes = null,
  actor = {},
  req = null,
}) {
  const { data: item } = await supabase
    .from('lab_order_items')
    .select('*, order:lab_orders(*), test:lab_tests(*)')
    .eq('id', itemId)
    .single();
  if (!item) throw new Error('Lab item not found');

  const { data: existing } = await supabase
    .from('lab_results')
    .select('*')
    .eq('item_id', itemId)
    .maybeSingle();

  if (existing?.locked) {
    throw new Error('Result is verified/locked — use createResultVersion to correct');
  }

  const flags = flagResultValue(value, item.test);
  const row = {
    item_id: itemId,
    value: value != null ? String(value) : null,
    unit: unit || item.test?.unit || null,
    flagged: flags.flagged,
    flag: flags.flag,
    is_critical: flags.is_critical,
    result_notes: resultNotes || null,
    entered_by: actor.id || null,
    entered_at: new Date().toISOString(),
    ref_low: item.test?.ref_low ?? null,
    ref_high: item.test?.ref_high ?? null,
    locked: false,
  };

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('lab_results')
      .update(row)
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw error;
    result = data;
  } else {
    const { data, error } = await supabase.from('lab_results').insert(row).select('*').single();
    if (error) throw error;
    result = data;
  }

  await supabase.from('lab_order_items').update({ status: 'result_entered' }).eq('id', itemId);
  await refreshOrderAggregateStatus(item.order_id);

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: existing ? 'edit' : 'create',
    resourceType: 'lab_result',
    resourceId: result.id,
    patientId: item.order?.patient_id,
    module: 'lab',
    after: result,
    req,
  });

  return result;
}

/**
 * Verify requires can_verify_lab (enforced by route middleware).
 * Locks result; order moves to verified when all items verified.
 */
export async function verifyResult({ itemId, actor = {}, req = null }) {
  const { data: item } = await supabase
    .from('lab_order_items')
    .select('*, order:lab_orders(*), result:lab_results(*)')
    .eq('id', itemId)
    .single();
  if (!item) throw new Error('Lab item not found');

  const resultRow = Array.isArray(item.result) ? item.result[0] : item.result;
  if (!resultRow) throw new Error('Enter result before verify');
  if (resultRow.locked) throw new Error('Already verified');

  const { data: result, error } = await supabase
    .from('lab_results')
    .update({
      locked: true,
      verified_by: actor.id || null,
      verified_at: new Date().toISOString(),
    })
    .eq('id', resultRow.id)
    .select('*')
    .single();
  if (error) throw error;

  await supabase.from('lab_order_items').update({ status: 'verified' }).eq('id', itemId);
  await refreshOrderAggregateStatus(item.order_id, { verifiedBy: actor.id });

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'lab_result',
    resourceId: result.id,
    patientId: item.order?.patient_id,
    module: 'lab',
    after: { ...result, verified: true },
    metadata: { action: 'verify_lock' },
    req,
  });

  return result;
}

/**
 * Correct a locked verified result → new version + audit (does not unlock without new verify).
 */
export async function createResultVersion({
  itemId,
  value,
  unit = null,
  resultNotes = null,
  changeReason,
  actor = {},
  req = null,
}) {
  if (!changeReason) throw new Error('changeReason required for versioned edit');

  const { data: item } = await supabase
    .from('lab_order_items')
    .select('*, order:lab_orders(*), test:lab_tests(*), result:lab_results(*)')
    .eq('id', itemId)
    .single();
  if (!item) throw new Error('Lab item not found');
  const current = Array.isArray(item.result) ? item.result[0] : item.result;
  if (!current?.locked) throw new Error('Use enterResult for unlocked results');

  const version = (current.version || 1) + 1;
  await supabase.from('lab_result_versions').insert({
    result_id: current.id,
    version: current.version || 1,
    value: current.value,
    unit: current.unit,
    flag: current.flag,
    is_critical: current.is_critical,
    result_notes: current.result_notes,
    entered_by: current.entered_by,
    entered_at: current.entered_at || new Date().toISOString(),
    change_reason: changeReason,
  });

  const flags = flagResultValue(value, item.test);
  const { data: updated, error } = await supabase
    .from('lab_results')
    .update({
      version,
      value: value != null ? String(value) : null,
      unit: unit || current.unit,
      flag: flags.flag,
      is_critical: flags.is_critical,
      flagged: flags.flagged,
      result_notes: resultNotes || null,
      entered_by: actor.id || null,
      entered_at: new Date().toISOString(),
      locked: true,
      verified_by: actor.id || null,
      verified_at: new Date().toISOString(),
    })
    .eq('id', current.id)
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'lab_result',
    resourceId: updated.id,
    patientId: item.order?.patient_id,
    module: 'lab',
    before: current,
    after: updated,
    metadata: { changeReason, version },
    req,
  });

  return updated;
}

async function refreshOrderAggregateStatus(orderId, { verifiedBy = null } = {}) {
  const { data: items } = await supabase
    .from('lab_order_items')
    .select('status')
    .eq('order_id', orderId);
  const list = items || [];
  const active = list.filter((i) => i.status !== 'cancelled');
  let status = 'in_progress';
  if (active.length && active.every((i) => i.status === 'verified' || i.status === 'sent')) {
    status = 'verified';
  } else if (active.some((i) => ['result_entered', 'resulted', 'verified'].includes(i.status))) {
    status = 'result_entered';
  } else if (active.some((i) => i.status === 'in_progress')) {
    status = 'in_progress';
  }

  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'verified') {
    patch.verified_at = new Date().toISOString();
    if (verifiedBy) patch.verified_by = verifiedBy;
  }
  await supabase.from('lab_orders').update(patch).eq('id', orderId);
}

export async function listWorklist({ status = null, pendingOnly = true } = {}) {
  let q = supabase
    .from('lab_orders')
    .select(
      '*, patient:profiles!lab_orders_patient_id_fkey(id, full_name, mrn), items:lab_order_items(*, test:lab_tests(*), result:lab_results(*))'
    )
    .order('ordered_at', { ascending: true })
    .limit(150);

  if (status) {
    q = q.eq('status', status);
  } else if (pendingOnly) {
    q = q.not('status', 'in', '(verified,sent,completed,cancelled)');
  }

  const { data, error } = await q;
  if (error) {
    // Fallback without embeds
    let q2 = supabase.from('lab_orders').select('*').order('ordered_at', { ascending: true }).limit(150);
    if (pendingOnly) q2 = q2.not('status', 'in', '(verified,sent,completed,cancelled)');
    if (status) q2 = q2.eq('status', status);
    const fallback = await q2;
    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }
  return (data || []).map((o) => ({ ...o, status: normalizeOrderStatus(o.status) }));
}

export async function listCatalogue() {
  const { data, error } = await supabase
    .from('lab_tests')
    .select('*')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function upsertCatalogueTest(payload, actor = {}, req = null) {
  const row = {
    code: String(payload.code || '').trim(),
    name: String(payload.name || '').trim(),
    specimen_type: payload.specimen_type || 'blood',
    unit: payload.unit || null,
    ref_low: payload.ref_low != null ? Number(payload.ref_low) : null,
    ref_high: payload.ref_high != null ? Number(payload.ref_high) : null,
    critical_low: payload.critical_low != null ? Number(payload.critical_low) : null,
    critical_high: payload.critical_high != null ? Number(payload.critical_high) : null,
    price: Number(payload.price) || 0,
    is_active: payload.is_active !== false,
    updated_at: new Date().toISOString(),
  };
  if (!row.code || !row.name) throw new Error('code and name required');

  const { data, error } = await supabase
    .from('lab_tests')
    .upsert(row, { onConflict: 'code' })
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'lab_test',
    resourceId: data.id,
    module: 'lab',
    after: data,
    req,
  });
  return data;
}

export { ORDER_FLOW, normalizeOrderStatus };
