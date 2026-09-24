/**
 * Billing: charge items, invoices, payments, receipts.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';
import { buildPdfBuffer, sendBinary } from '../services/exportService.js';

async function nextInvoiceNo() {
  const year = new Date().getUTCFullYear();
  const prefix = `INV-${year}-`;
  const { data } = await supabase
    .from('invoices')
    .select('invoice_no')
    .ilike('invoice_no', `${prefix}%`)
    .order('invoice_no', { ascending: false })
    .limit(1);
  const last = data?.[0]?.invoice_no;
  const n = last ? parseInt(last.split('-').pop(), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(5, '0')}`;
}

async function nextReceiptNo() {
  const year = new Date().getUTCFullYear();
  const prefix = `RCP-${year}-`;
  const { data } = await supabase
    .from('payments')
    .select('receipt_no')
    .ilike('receipt_no', `${prefix}%`)
    .order('receipt_no', { ascending: false })
    .limit(1);
  const last = data?.[0]?.receipt_no;
  const n = last ? parseInt(last.split('-').pop(), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(5, '0')}`;
}

async function recalcInvoice(invoiceId) {
  const { data: lines } = await supabase.from('invoice_lines').select('*').eq('invoice_id', invoiceId);
  const subtotal = (lines || []).reduce((s, l) => s + Number(l.line_total || 0), 0);
  const { data: pays } = await supabase.from('payments').select('amount').eq('invoice_id', invoiceId);
  const paid = (pays || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  let status = 'issued';
  if (paid <= 0) status = 'issued';
  else if (paid + 0.001 >= subtotal) status = 'paid';
  else status = 'partial';
  const { data: inv } = await supabase
    .from('invoices')
    .update({
      subtotal,
      total: subtotal,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .select()
    .single();
  return inv;
}

export async function listChargeItems(req, res) {
  try {
    const { data, error } = await supabase
      .from('charge_items')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createChargeItem(req, res) {
  try {
    const { code, name, category, unit_price } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const { data, error } = await supabase
      .from('charge_items')
      .insert({
        code: String(code).trim(),
        name: String(name).trim(),
        category: category || 'general',
        unit_price: parseFloat(unit_price) || 0,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listInvoices(req, res) {
  try {
    const { patient_id, status } = req.query;
    let q = supabase.from('invoices').select('*').order('created_at', { ascending: false });
    if (patient_id) q = q.eq('patient_id', patient_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q.limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getInvoice(req, res) {
  try {
    const { id } = req.params;
    const { data: inv, error } = await supabase.from('invoices').select('*').eq('id', id).single();
    if (error || !inv) return res.status(404).json({ error: 'Invoice not found' });
    const { data: lines } = await supabase.from('invoice_lines').select('*').eq('invoice_id', id);
    const { data: payments } = await supabase.from('payments').select('*').eq('invoice_id', id);
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'invoice',
      resourceId: id,
      patientId: inv.patient_id,
      req,
    });
    res.json({ ...inv, lines: lines || [], payments: payments || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createInvoice(req, res) {
  try {
    const { patient_id, opd_visit_id, notes, lines } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
    const invoice_no = await nextInvoiceNo();
    const { data: inv, error } = await supabase
      .from('invoices')
      .insert({
        invoice_no,
        patient_id,
        opd_visit_id: opd_visit_id || null,
        status: 'issued',
        notes: notes || null,
        created_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const lineRows = (lines || []).map((l) => {
      const qty = parseFloat(l.quantity) || 1;
      const price = parseFloat(l.unit_price) || 0;
      return {
        invoice_id: inv.id,
        charge_item_id: l.charge_item_id || null,
        description: l.description || 'Charge',
        quantity: qty,
        unit_price: price,
        line_total: Math.round(qty * price * 100) / 100,
      };
    });
    if (lineRows.length) {
      const { error: lErr } = await supabase.from('invoice_lines').insert(lineRows);
      if (lErr) return res.status(500).json({ error: lErr.message });
    }
    const updated = await recalcInvoice(inv.id);
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'invoice',
      resourceId: inv.id,
      patientId: patient_id,
      after: updated,
      req,
    });
    res.status(201).json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function recordPayment(req, res) {
  try {
    const { id } = req.params;
    const { amount, method, notes } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    const { data: inv } = await supabase.from('invoices').select('*').eq('id', id).single();
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'void') return res.status(400).json({ error: 'Invoice is void' });
    const receipt_no = await nextReceiptNo();
    const { data: pay, error } = await supabase
      .from('payments')
      .insert({
        invoice_id: id,
        amount: amt,
        method: method || 'cash',
        receipt_no,
        received_by: req.user?.id || null,
        notes: notes || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    const updated = await recalcInvoice(id);
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'payment',
      resourceId: pay.id,
      patientId: inv.patient_id,
      after: pay,
      req,
    });
    res.status(201).json({ payment: pay, invoice: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function receiptPdf(req, res) {
  try {
    const { paymentId } = req.params;
    const { data: pay } = await supabase.from('payments').select('*').eq('id', paymentId).single();
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    const { data: inv } = await supabase.from('invoices').select('*').eq('id', pay.invoice_id).single();
    const { data: patient } = await supabase
      .from('profiles')
      .select('full_name, mrn')
      .eq('id', inv?.patient_id)
      .single();
    const buf = await buildPdfBuffer('Payment Receipt', [
      {
        heading: pay.receipt_no,
        lines: [
          `Invoice: ${inv?.invoice_no || ''}`,
          `Patient: ${patient?.full_name || ''}`,
          `MRN: ${patient?.mrn || ''}`,
          `Amount: ${pay.amount}`,
          `Method: ${pay.method}`,
          `Paid at: ${pay.paid_at}`,
        ],
      },
    ]);
    sendBinary(res, buf, {
      filename: `receipt-${pay.receipt_no}.pdf`,
      contentType: 'application/pdf',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function revenueSummary(req, res) {
  try {
    const { from, to } = req.query;
    let q = supabase.from('payments').select('id, amount, method, paid_at, invoice_id');
    if (from) q = q.gte('paid_at', from);
    if (to) q = q.lte('paid_at', to);
    const { data, error } = await q.order('paid_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    res.json({ summary: { payment_count: rows.length, total_revenue: total }, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
