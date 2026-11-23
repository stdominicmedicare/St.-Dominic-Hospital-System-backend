/**
 * Phase 2 billing: open invoices, auto charges, payments, receipts, credit notes.
 */
import { supabase } from '../config/supabase.js';
import { nextDocumentNo } from './documentSequenceService.js';
import { writeAuditLog } from './auditService.js';

const OPEN_STATUSES = new Set(['open', 'issued', 'draft', 'partial']);
const LOCKED_STATUSES = new Set(['paid', 'waived', 'void']);

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export async function recalcInvoice(invoiceId) {
  const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
  if (!inv) throw new Error('Invoice not found');

  const { data: lines } = await supabase.from('invoice_lines').select('*').eq('invoice_id', invoiceId);
  const subtotal = roundMoney((lines || []).reduce((s, l) => s + Number(l.line_total || 0), 0));
  const discount = roundMoney(inv.discount || 0);
  const total = roundMoney(Math.max(0, subtotal - discount));

  const { data: pays } = await supabase.from('payments').select('amount').eq('invoice_id', invoiceId);
  const amountPaid = roundMoney((pays || []).reduce((s, p) => s + Number(p.amount || 0), 0));

  let status = inv.status;
  if (!['waived', 'insurance_claim', 'void'].includes(status)) {
    if (amountPaid <= 0) status = 'open';
    else if (amountPaid + 0.001 >= total) status = 'paid';
    else status = 'partial';
  }

  const patch = {
    subtotal,
    total,
    amount_paid: amountPaid,
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === 'paid' && !inv.locked_at) {
    patch.locked_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('invoices')
    .update(patch)
    .eq('id', invoiceId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Find or create an open invoice for a patient (optionally tied to an OPD visit).
 */
export async function getOrCreateOpenInvoice({
  patientId,
  opdVisitId = null,
  sourceModule = null,
  createdBy = null,
}) {
  if (!patientId) throw new Error('patientId required');

  let q = supabase
    .from('invoices')
    .select('*')
    .eq('patient_id', patientId)
    .in('status', ['open', 'issued', 'draft', 'partial'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (opdVisitId) q = q.eq('opd_visit_id', opdVisitId);

  const { data: existing } = await q.maybeSingle();
  if (existing) {
    if (sourceModule && !(existing.source_modules || []).includes(sourceModule)) {
      const modules = [...new Set([...(existing.source_modules || []), sourceModule])];
      const { data: updated } = await supabase
        .from('invoices')
        .update({ source_modules: modules, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('*')
        .single();
      return updated || existing;
    }
    return existing;
  }

  const invoice_no = await nextDocumentNo('invoice');
  const { data, error } = await supabase
    .from('invoices')
    .insert({
      invoice_no,
      patient_id: patientId,
      opd_visit_id: opdVisitId || null,
      status: 'open',
      source_modules: sourceModule ? [sourceModule] : [],
      created_by: createdBy || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Add a charge line. Rejects if invoice is paid/waived/void.
 */
export async function addChargeLine({
  patientId,
  opdVisitId = null,
  invoiceId = null,
  chargeItemId = null,
  description,
  quantity = 1,
  unitPrice = 0,
  sourceModule = null,
  sourceTable = null,
  sourceId = null,
  createdBy = null,
  actor = {},
  req = null,
}) {
  let invoice;
  if (invoiceId) {
    const { data } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
    invoice = data;
  } else {
    invoice = await getOrCreateOpenInvoice({
      patientId,
      opdVisitId,
      sourceModule,
      createdBy,
    });
  }
  if (!invoice) throw new Error('Invoice not found');
  if (LOCKED_STATUSES.has(invoice.status)) {
    throw new Error('Paid/waived invoices are immutable — create a credit note for corrections');
  }

  const qty = Number(quantity) || 1;
  const price = Number(unitPrice) || 0;
  const line = {
    invoice_id: invoice.id,
    charge_item_id: chargeItemId || null,
    description: description || 'Charge',
    quantity: qty,
    unit_price: price,
    line_total: roundMoney(qty * price),
    source_module: sourceModule || null,
    source_table: sourceTable || null,
    source_id: sourceId || null,
  };

  const { data: inserted, error } = await supabase.from('invoice_lines').insert(line).select('*').single();
  if (error) throw error;

  const updated = await recalcInvoice(invoice.id);
  await writeAuditLog({
    actorId: actor.id || createdBy || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'create',
    resourceType: 'invoice_line',
    resourceId: inserted.id,
    patientId,
    module: 'billing',
    after: inserted,
    metadata: { invoice_id: invoice.id, sourceModule, sourceTable, sourceId },
    req,
  });

  return { invoice: updated, line: inserted };
}

export async function listPriceList({ activeOnly = true } = {}) {
  let q = supabase.from('charge_items').select('*').order('category').order('name');
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function upsertPriceItem(payload, actor = {}, req = null) {
  const row = {
    code: String(payload.code || '').trim(),
    name: String(payload.name || '').trim(),
    category: payload.category || 'general',
    unit_price: Number(payload.unit_price) || 0,
    is_active: payload.is_active !== false,
    description: payload.description || null,
    module_hint: payload.module_hint || null,
    updated_at: new Date().toISOString(),
  };
  if (!row.code || !row.name) throw new Error('code and name required');

  const { data, error } = await supabase
    .from('charge_items')
    .upsert(row, { onConflict: 'code' })
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'charge_item',
    resourceId: data.id,
    module: 'billing',
    after: data,
    req,
  });
  return data;
}

export async function recordPayment({
  invoiceId,
  amount,
  method = 'cash',
  notes = null,
  actor = {},
  req = null,
}) {
  const amt = roundMoney(amount);
  if (amt <= 0) throw new Error('amount must be > 0');

  const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'void') throw new Error('Invoice is void');
  if (inv.status === 'waived') throw new Error('Invoice is waived');
  if (inv.status === 'paid') throw new Error('Invoice already paid — use a credit note for corrections');

  const methodNorm = method === 'mobile' ? 'mobile_money' : method;
  const receipt_no = await nextDocumentNo('receipt');
  const { data: pay, error } = await supabase
    .from('payments')
    .insert({
      invoice_id: invoiceId,
      amount: amt,
      method: methodNorm,
      receipt_no,
      received_by: actor.id || null,
      cashier_id: actor.id || null,
      notes: notes || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  const updated = await recalcInvoice(invoiceId);
  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'create',
    resourceType: 'payment',
    resourceId: pay.id,
    patientId: inv.patient_id,
    module: 'billing',
    after: pay,
    metadata: { receipt_no, invoice_no: inv.invoice_no },
    req,
  });

  return { payment: pay, invoice: updated };
}

export async function waiveInvoice({ invoiceId, reason, actor = {}, req = null }) {
  const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
  if (!inv) throw new Error('Invoice not found');
  if (LOCKED_STATUSES.has(inv.status) && inv.status !== 'waived') {
    throw new Error('Cannot waive a paid/void invoice');
  }
  const { data, error } = await supabase
    .from('invoices')
    .update({
      status: 'waived',
      waived_reason: reason || null,
      waived_by: actor.id || null,
      waived_at: new Date().toISOString(),
      locked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'delete_void',
    resourceType: 'invoice',
    resourceId: invoiceId,
    patientId: inv.patient_id,
    module: 'billing',
    before: inv,
    after: data,
    metadata: { reason },
    req,
  });
  return data;
}

export async function markInsuranceClaim({ invoiceId, scheme, memberNo, actor = {}, req = null }) {
  const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'paid' || inv.status === 'void') {
    throw new Error('Cannot mark paid/void invoice as insurance claim');
  }
  const { data, error } = await supabase
    .from('invoices')
    .update({
      status: 'insurance_claim',
      insurance_scheme: scheme || inv.insurance_scheme,
      insurance_member_no: memberNo || inv.insurance_member_no,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'edit',
    resourceType: 'invoice',
    resourceId: invoiceId,
    patientId: inv.patient_id,
    module: 'billing',
    before: inv,
    after: data,
    req,
  });
  return data;
}

export async function createCreditNote({ invoiceId, amount, reason, actor = {}, req = null }) {
  const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
  if (!inv) throw new Error('Invoice not found');
  if (inv.status !== 'paid' && inv.status !== 'waived') {
    throw new Error('Credit notes are for paid/waived invoices only');
  }
  const amt = roundMoney(amount);
  if (amt <= 0) throw new Error('amount must be > 0');
  if (!reason) throw new Error('reason required');

  const credit_note_no = await nextDocumentNo('credit_note');
  const { data, error } = await supabase
    .from('credit_notes')
    .insert({
      credit_note_no,
      invoice_id: invoiceId,
      amount: amt,
      reason,
      created_by: actor.id || null,
    })
    .select('*')
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'create',
    resourceType: 'credit_note',
    resourceId: data.id,
    patientId: inv.patient_id,
    module: 'billing',
    after: data,
    req,
  });
  return data;
}

export async function dailyCashSummary({ date = null } = {}) {
  const day = date || new Date().toISOString().slice(0, 10);
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  const { data, error } = await supabase
    .from('payments')
    .select('id, amount, method, paid_at, cashier_id, received_by, receipt_no, invoice_id')
    .gte('paid_at', from)
    .lte('paid_at', to)
    .order('paid_at', { ascending: true });
  if (error) throw error;

  const rows = data || [];
  const byCashier = {};
  const byMethod = {};
  let total = 0;
  for (const r of rows) {
    const cashier = r.cashier_id || r.received_by || 'unknown';
    const method = r.method || 'other';
    total += Number(r.amount || 0);
    byCashier[cashier] = roundMoney((byCashier[cashier] || 0) + Number(r.amount || 0));
    byMethod[method] = roundMoney((byMethod[method] || 0) + Number(r.amount || 0));
  }

  return {
    date: day,
    receipt_count: rows.length,
    total: roundMoney(total),
    by_cashier: byCashier,
    by_method: byMethod,
    rows,
  };
}

export async function getPendingCounts() {
  const { data, error } = await supabase.from('hms_pending_counts').select('*').maybeSingle();
  if (!error && data) return data;

  // Fallback without view
  const [lab, rx, inv] = await Promise.all([
    supabase
      .from('lab_orders')
      .select('id', { count: 'exact', head: true })
      .not('status', 'in', '(verified,sent,completed,cancelled)'),
    supabase
      .from('prescriptions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'active']),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'issued', 'partial', 'draft']),
  ]);

  return {
    pending_lab: lab.count || 0,
    pending_lab_urgent: 0,
    to_dispense: rx.count || 0,
    open_invoices: inv.count || 0,
    low_stock_items: 0,
    expiring_batches_90d: 0,
  };
}

export { OPEN_STATUSES, LOCKED_STATUSES, roundMoney };
