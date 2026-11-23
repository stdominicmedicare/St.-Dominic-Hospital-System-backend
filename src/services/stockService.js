/**
 * Pharmacy stock: FEFO batch pick + append-only stock_movements.
 * Never update medicines.stock_quantity except through these helpers.
 */
import { supabase } from '../config/supabase.js';
import { nextDocumentNo } from './documentSequenceService.js';
import { writeAuditLog } from './auditService.js';

const EXPIRY_WARN_DAYS = 90;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function batchStatus(batch, reorderLevel = 0) {
  const today = startOfToday();
  const expiry = batch.expiry_date ? new Date(batch.expiry_date) : null;
  if (expiry && expiry < today) return 'expired';
  const warn = new Date(today);
  warn.setDate(warn.getDate() + EXPIRY_WARN_DAYS);
  if (expiry && expiry <= warn) return 'expiring';
  if ((batch.quantity ?? 0) <= reorderLevel) return 'low_stock';
  return 'ok';
}

async function refreshMedicineStock(medicineId) {
  const { data: batches } = await supabase
    .from('medicine_batches')
    .select('quantity')
    .eq('medicine_id', medicineId)
    .eq('is_active', true);
  const total = (batches || []).reduce((s, b) => s + (b.quantity || 0), 0);
  await supabase
    .from('medicines')
    .update({ stock_quantity: total, updated_at: new Date().toISOString() })
    .eq('id', medicineId);
  return total;
}

async function writeMovement({
  medicineId,
  batchId,
  movementType,
  quantityDelta,
  quantityBefore,
  quantityAfter,
  reason,
  referenceType,
  referenceId,
  createdBy,
  actor = {},
  req = null,
}) {
  const { data, error } = await supabase
    .from('stock_movements')
    .insert({
      medicine_id: medicineId,
      batch_id: batchId || null,
      movement_type: movementType,
      quantity_delta: quantityDelta,
      quantity_before: quantityBefore,
      quantity_after: quantityAfter,
      reason: reason || null,
      reference_type: referenceType || null,
      reference_id: referenceId || null,
      created_by: createdBy || actor.id || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || createdBy || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'create',
    resourceType: 'stock_movement',
    resourceId: data.id,
    module: 'pharmacy',
    after: data,
    req,
  });
  return data;
}

/** FEFO: earliest expiry first; skip expired; never dispense expired. */
export async function pickFefoBatches(medicineId, qtyNeeded) {
  const need = Number(qtyNeeded) || 0;
  if (need <= 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const { data: batches, error } = await supabase
    .from('medicine_batches')
    .select('*')
    .eq('medicine_id', medicineId)
    .eq('is_active', true)
    .gt('quantity', 0)
    .gt('expiry_date', today)
    .order('expiry_date', { ascending: true });
  if (error) throw error;

  const picks = [];
  let remaining = need;
  for (const b of batches || []) {
    if (remaining <= 0) break;
    const take = Math.min(b.quantity, remaining);
    picks.push({ batch: b, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    const err = new Error(`Insufficient non-expired stock (short ${remaining})`);
    err.code = 'INSUFFICIENT_STOCK';
    err.shortfall = remaining;
    throw err;
  }
  return picks;
}

/**
 * Receive stock (GRN): create/update batch + movement + refresh medicine qty.
 */
export async function receiveStock({
  medicineId,
  batchNo,
  expiryDate,
  quantity,
  unitCost = 0,
  sellingPrice = null,
  supplier = null,
  actor = {},
  req = null,
}) {
  const qty = Number(quantity);
  if (!medicineId || !batchNo || !expiryDate || !qty || qty <= 0) {
    throw new Error('medicineId, batchNo, expiryDate and positive quantity required');
  }

  const grn_no = await nextDocumentNo('grn');
  const { data: existing } = await supabase
    .from('medicine_batches')
    .select('*')
    .eq('medicine_id', medicineId)
    .eq('batch_no', String(batchNo).trim())
    .maybeSingle();

  let batch;
  let before = 0;
  if (existing) {
    before = existing.quantity || 0;
    const { data, error } = await supabase
      .from('medicine_batches')
      .update({
        quantity: before + qty,
        unit_cost: unitCost != null ? Number(unitCost) : existing.unit_cost,
        selling_price: sellingPrice != null ? Number(sellingPrice) : existing.selling_price,
        supplier: supplier || existing.supplier,
        expiry_date: expiryDate,
        grn_no,
        updated_at: new Date().toISOString(),
        is_active: true,
      })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw error;
    batch = data;
  } else {
    const { data: med } = await supabase
      .from('medicines')
      .select('selling_price, price_per_unit, unit_cost')
      .eq('id', medicineId)
      .single();
    const { data, error } = await supabase
      .from('medicine_batches')
      .insert({
        medicine_id: medicineId,
        batch_no: String(batchNo).trim(),
        expiry_date: expiryDate,
        quantity: qty,
        unit_cost: Number(unitCost) || 0,
        selling_price:
          sellingPrice != null
            ? Number(sellingPrice)
            : med?.selling_price ?? med?.price_per_unit ?? 0,
        supplier: supplier || null,
        grn_no,
      })
      .select('*')
      .single();
    if (error) throw error;
    batch = data;
  }

  const movement = await writeMovement({
    medicineId,
    batchId: batch.id,
    movementType: 'receive',
    quantityDelta: qty,
    quantityBefore: before,
    quantityAfter: before + qty,
    reason: `GRN ${grn_no}`,
    referenceType: 'grn',
    referenceId: batch.id,
    actor,
    req,
  });

  const medicineStock = await refreshMedicineStock(medicineId);
  return { batch, movement, grn_no, medicine_stock: medicineStock };
}

/**
 * Adjustment / expire: quantityDelta can be negative.
 */
export async function adjustStock({
  medicineId,
  batchId,
  quantityDelta,
  reason,
  movementType = 'adjust',
  actor = {},
  req = null,
}) {
  const delta = Number(quantityDelta);
  if (!medicineId || !batchId || !delta || !reason) {
    throw new Error('medicineId, batchId, non-zero quantityDelta and reason required');
  }
  if (!['adjust', 'expire'].includes(movementType)) {
    throw new Error('movementType must be adjust or expire');
  }

  const { data: batch } = await supabase.from('medicine_batches').select('*').eq('id', batchId).single();
  if (!batch || batch.medicine_id !== medicineId) throw new Error('Batch not found');

  const before = batch.quantity || 0;
  const after = before + delta;
  if (after < 0) throw new Error('Adjustment would make batch quantity negative');

  const { data: updated, error } = await supabase
    .from('medicine_batches')
    .update({
      quantity: after,
      updated_at: new Date().toISOString(),
      is_active: after > 0 ? batch.is_active : false,
    })
    .eq('id', batchId)
    .select('*')
    .single();
  if (error) throw error;

  const movement = await writeMovement({
    medicineId,
    batchId,
    movementType,
    quantityDelta: delta,
    quantityBefore: before,
    quantityAfter: after,
    reason,
    referenceType: 'adjustment',
    referenceId: batchId,
    actor,
    req,
  });

  const medicineStock = await refreshMedicineStock(medicineId);
  return { batch: updated, movement, medicine_stock: medicineStock };
}

/**
 * Dispense using FEFO; writes dispense movements per batch.
 * @returns {{ allocations: Array, movements: Array }}
 */
export async function dispenseFefo({
  medicineId,
  quantity,
  referenceType = 'prescription',
  referenceId = null,
  actor = {},
  req = null,
}) {
  const picks = await pickFefoBatches(medicineId, quantity);
  const allocations = [];
  const movements = [];

  for (const { batch, quantity: take } of picks) {
    const before = batch.quantity;
    const after = before - take;
    const { data: updated, error } = await supabase
      .from('medicine_batches')
      .update({ quantity: after, updated_at: new Date().toISOString() })
      .eq('id', batch.id)
      .eq('quantity', before) // optimistic concurrency
      .select('*')
      .single();
    if (error || !updated) {
      throw new Error(`Concurrent stock change on batch ${batch.batch_no}; retry`);
    }

    const movement = await writeMovement({
      medicineId,
      batchId: batch.id,
      movementType: 'dispense',
      quantityDelta: -take,
      quantityBefore: before,
      quantityAfter: after,
      reason: 'Dispense',
      referenceType,
      referenceId,
      actor,
      req,
    });

    allocations.push({
      batch_id: batch.id,
      batch_no: batch.batch_no,
      expiry_date: batch.expiry_date,
      quantity: take,
      unit_cost: batch.unit_cost,
      selling_price: batch.selling_price,
    });
    movements.push(movement);
  }

  await refreshMedicineStock(medicineId);
  return { allocations, movements };
}

export async function listStock({ search = '' } = {}) {
  let mq = supabase
    .from('medicines')
    .select(
      'id, name, strength, form, unit, category, stock_quantity, reorder_level, low_stock_threshold, selling_price, price_per_unit, unit_cost, supplier, is_active'
    )
    .order('name');
  if (search) mq = mq.ilike('name', `%${search}%`);
  const { data: meds, error } = await mq;
  if (error) throw error;

  const ids = (meds || []).map((m) => m.id);
  const { data: batches } = ids.length
    ? await supabase
        .from('medicine_batches')
        .select('*')
        .in('medicine_id', ids)
        .eq('is_active', true)
        .order('expiry_date', { ascending: true })
    : { data: [] };

  const byMed = {};
  for (const b of batches || []) {
    if (!byMed[b.medicine_id]) byMed[b.medicine_id] = [];
    const reorder = 0;
    byMed[b.medicine_id].push({ ...b, status: batchStatus(b, reorder) });
  }

  return (meds || []).map((m) => {
    const reorder = m.reorder_level ?? m.low_stock_threshold ?? 10;
    const medBatches = (byMed[m.id] || []).map((b) => ({
      ...b,
      status: batchStatus(b, reorder),
    }));
    let status = 'ok';
    if ((m.stock_quantity ?? 0) <= reorder) status = 'low_stock';
    if (medBatches.some((b) => b.status === 'expired')) status = 'expired';
    else if (medBatches.some((b) => b.status === 'expiring')) status = 'expiring';
    else if (status === 'low_stock') status = 'low_stock';
    return { ...m, reorder_level: reorder, batches: medBatches, status };
  });
}

export async function listExpiring({ withinDays = EXPIRY_WARN_DAYS } = {}) {
  const limit = new Date();
  limit.setDate(limit.getDate() + withinDays);
  const { data, error } = await supabase
    .from('medicine_batches')
    .select('*, medicine:medicines(id, name, unit, reorder_level, low_stock_threshold)')
    .eq('is_active', true)
    .gt('quantity', 0)
    .lte('expiry_date', limit.toISOString().slice(0, 10))
    .order('expiry_date', { ascending: true });
  if (error) throw error;
  return (data || []).map((b) => ({
    ...b,
    status: batchStatus(b),
  }));
}

export { EXPIRY_WARN_DAYS, refreshMedicineStock };
