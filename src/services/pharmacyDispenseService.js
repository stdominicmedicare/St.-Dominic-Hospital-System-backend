/**
 * Prescription → FEFO dispense → Billing charge.
 */
import { supabase } from '../config/supabase.js';
import { createEncounter } from './encounterService.js';
import { dispenseFefo } from './stockService.js';
import { addChargeLine } from './billingService.js';
import { writeAuditLog } from './auditService.js';

/**
 * Create prescription from OPD Prescribe handoff.
 */
export async function createPrescription({
  patientId,
  items,
  opdVisitId = null,
  notes = null,
  actor = {},
  req = null,
}) {
  if (!patientId) throw new Error('patientId required');
  if (!Array.isArray(items) || !items.length) throw new Error('items[] required');

  const encounter = await createEncounter({
    patientId,
    module: 'pharmacy',
    staffId: actor.id || null,
    status: 'waiting',
    metadata: { opd_visit_id: opdVisitId },
    sourceTable: 'prescriptions',
  });

  const first = items[0];
  const { data: rx, error } = await supabase
    .from('prescriptions')
    .insert({
      patient_id: patientId,
      doctor_id: actor.id || null,
      medication: first.medication_text || first.name || 'Prescription',
      dosage: first.dosage || null,
      frequency: first.frequency || null,
      quantity: first.quantity || 1,
      instructions: notes || first.instructions || null,
      status: 'pending',
      opd_visit_id: opdVisitId || null,
      encounter_id: encounter.id,
      source: 'OPD',
    })
    .select('*')
    .single();
  if (error) throw error;

  await supabase.from('encounters').update({ source_id: rx.id }).eq('id', encounter.id);

  const rows = items.map((it) => ({
    prescription_id: rx.id,
    medicine_id: it.medicine_id || null,
    medication_text: it.medication_text || it.name || null,
    dosage: it.dosage || null,
    frequency: it.frequency || null,
    quantity: Number(it.quantity) || 1,
    instructions: it.instructions || null,
    status: 'prescribed',
  }));
  const { data: inserted, error: iErr } = await supabase
    .from('prescription_items')
    .insert(rows)
    .select('*');
  if (iErr) throw iErr;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'create',
    resourceType: 'prescription',
    resourceId: rx.id,
    patientId,
    module: 'pharmacy',
    after: { ...rx, items: inserted },
    req,
  });

  return { ...rx, items: inserted };
}

export async function listToDispense() {
  const { data: list, error } = await supabase
    .from('prescriptions')
    .select('*')
    .in('status', ['pending', 'active'])
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;

  const ids = (list || []).map((r) => r.id);
  if (!ids.length) return [];

  const patientIds = [...new Set((list || []).map((r) => r.patient_id).filter(Boolean))];
  const { data: patients } = await supabase
    .from('profiles')
    .select('id, full_name, mrn')
    .in('id', patientIds);
  const patientMap = Object.fromEntries((patients || []).map((p) => [p.id, p]));

  const { data: items } = await supabase
    .from('prescription_items')
    .select('*, medicine:medicines(id, name, stock_quantity, selling_price, price_per_unit, unit)')
    .in('prescription_id', ids);

  const byRx = {};
  for (const it of items || []) {
    if (!byRx[it.prescription_id]) byRx[it.prescription_id] = [];
    byRx[it.prescription_id].push(it);
  }

  return (list || []).map((r) => ({
    ...r,
    patient: patientMap[r.patient_id] || null,
    items: byRx[r.id] || [],
  }));
}

/**
 * Dispense one prescription with FEFO + billing charges.
 */
export async function dispensePrescription({
  prescriptionId,
  actor = {},
  req = null,
  partialQuantities = null,
}) {
  const { data: rx } = await supabase.from('prescriptions').select('*').eq('id', prescriptionId).single();
  if (!rx) throw new Error('Prescription not found');
  // 'active' = partially dispensed (avoid new prescription_status enum label in same migration txn)
  if (!['pending', 'active'].includes(rx.status)) {
    throw new Error('Prescription is not awaiting dispense');
  }

  const { data: items } = await supabase
    .from('prescription_items')
    .select('*, medicine:medicines(*)')
    .eq('prescription_id', prescriptionId);
  if (!items?.length) throw new Error('No prescription items');

  const allAllocations = [];
  let anyPartial = false;

  for (const item of items) {
    const already = item.qty_dispensed || 0;
    const ordered = item.quantity || 1;
    const remaining = Math.max(0, ordered - already);
    if (remaining <= 0 || item.status === 'dispensed') continue;

    let medicineId = item.medicine_id;
    if (!medicineId && item.medication_text) {
      const { data: byName } = await supabase
        .from('medicines')
        .select('id, selling_price, price_per_unit, name')
        .ilike('name', `%${item.medication_text}%`)
        .limit(1)
        .maybeSingle();
      if (byName) medicineId = byName.id;
    }
    if (!medicineId) {
      await supabase
        .from('prescription_items')
        .update({ status: 'out_of_stock' })
        .eq('id', item.id);
      anyPartial = true;
      continue;
    }

    const want =
      partialQuantities && partialQuantities[item.id] != null
        ? Number(partialQuantities[item.id])
        : remaining;
    const take = Math.min(want, remaining);
    if (take <= 0) continue;

    let allocations;
    try {
      ({ allocations } = await dispenseFefo({
        medicineId,
        quantity: take,
        referenceType: 'prescription',
        referenceId: prescriptionId,
        actor,
        req,
      }));
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK') {
        await supabase
          .from('prescription_items')
          .update({ status: 'out_of_stock' })
          .eq('id', item.id);
        anyPartial = true;
        continue;
      }
      throw err;
    }

    const newDispensed = already + take;
    const itemStatus = newDispensed >= ordered ? 'dispensed' : 'partial';
    if (itemStatus !== 'dispensed') anyPartial = true;

    await supabase
      .from('prescription_items')
      .update({ qty_dispensed: newDispensed, status: itemStatus, medicine_id: medicineId })
      .eq('id', item.id);

    const { data: med } = await supabase
      .from('medicines')
      .select('name, selling_price, price_per_unit')
      .eq('id', medicineId)
      .single();

    const unitPrice =
      allocations[0]?.selling_price ??
      med?.selling_price ??
      med?.price_per_unit ??
      0;

    await addChargeLine({
      patientId: rx.patient_id,
      opdVisitId: rx.opd_visit_id || null,
      description: `Drug: ${med?.name || item.medication_text || 'Medicine'}`,
      quantity: take,
      unitPrice,
      sourceModule: 'pharmacy',
      sourceTable: 'prescriptions',
      sourceId: prescriptionId,
      createdBy: actor.id || null,
      actor,
      req,
    });

    allAllocations.push({ item_id: item.id, medicine_id: medicineId, allocations });
  }

  const status = anyPartial ? 'active' : 'dispensed';
  await supabase
    .from('prescriptions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', prescriptionId);

  const { data: disp } = await supabase
    .from('dispense_records')
    .insert({
      prescription_id: prescriptionId,
      dispensed_by: actor.id || null,
      dispensed_at: new Date().toISOString(),
      notes: status === 'active' ? 'Partially dispensed' : 'Dispensed',
      batch_allocations: allAllocations,
    })
    .select('*')
    .single();

  if (rx.encounter_id) {
    await supabase
      .from('encounters')
      .update({
        status: status === 'dispensed' ? 'done' : 'in_progress',
        updated_at: new Date().toISOString(),
      })
      .eq('id', rx.encounter_id);
  }

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'prescription',
    resourceId: prescriptionId,
    patientId: rx.patient_id,
    module: 'pharmacy',
    after: { status, allocations: allAllocations, dispense_id: disp?.id },
    req,
  });

  return { status, allocations: allAllocations, dispense: disp };
}
