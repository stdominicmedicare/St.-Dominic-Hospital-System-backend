/**
 * Phase 2 HMS controllers: Lab, Pharmacy, Billing, OPD handoffs, pending counts.
 */
import { supabase } from '../config/supabase.js';
import { createEncounter } from '../services/encounterService.js';
import { writeAuditLog } from '../services/auditService.js';
import {
  createLabRequest,
  advanceLabOrder,
  enterResult,
  verifyResult,
  createResultVersion,
  listWorklist,
  listCatalogue,
  upsertCatalogueTest,
} from '../services/labService.js';
import {
  createPrescription,
  listToDispense,
  dispensePrescription,
} from '../services/pharmacyDispenseService.js';
import {
  receiveStock,
  adjustStock,
  listStock,
  listExpiring,
} from '../services/stockService.js';
import {
  getPendingCounts,
  listPriceList,
  upsertPriceItem,
  recordPayment,
  waiveInvoice,
  markInsuranceClaim,
  createCreditNote,
  dailyCashSummary,
  addChargeLine,
  recalcInvoice,
  getOrCreateOpenInvoice,
} from '../services/billingService.js';
import { buildPdfBuffer, sendBinary } from '../services/exportService.js';

function actorFrom(req) {
  return {
    id: req.user?.id,
    email: req.user?.email || req.profile?.email,
    role: req.role,
  };
}

// ---------- Pending counts (Home) ----------
export async function pendingCounts(req, res) {
  try {
    const counts = await getPendingCounts();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------- OPD handoffs ----------
export async function opdOrderLab(req, res) {
  try {
    const { visitId } = req.params;
    const { test_ids, priority, notes, patient_id } = req.body || {};
    let patientId = patient_id;
    let opdVisitId = visitId === 'walk-in' ? null : visitId;

    if (opdVisitId) {
      const { data: visit } = await supabase.from('opd_visits').select('*').eq('id', opdVisitId).single();
      if (!visit) return res.status(404).json({ error: 'OPD visit not found' });
      patientId = visit.patient_id;
      await supabase
        .from('opd_visits')
        .update({ status: 'in_consultation', updated_at: new Date().toISOString() })
        .eq('id', opdVisitId);
    }
    if (!patientId) return res.status(400).json({ error: 'patient_id or visitId required' });

    const order = await createLabRequest({
      patientId,
      testIds: test_ids,
      priority: priority || 'routine',
      source: 'OPD',
      opdVisitId,
      notes,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function opdPrescribe(req, res) {
  try {
    const { visitId } = req.params;
    const { items, notes, patient_id } = req.body || {};
    let patientId = patient_id;
    let opdVisitId = visitId === 'walk-in' ? null : visitId;

    if (opdVisitId) {
      const { data: visit } = await supabase.from('opd_visits').select('*').eq('id', opdVisitId).single();
      if (!visit) return res.status(404).json({ error: 'OPD visit not found' });
      patientId = visit.patient_id;
    }
    if (!patientId) return res.status(400).json({ error: 'patient_id or visitId required' });

    const rx = await createPrescription({
      patientId,
      items: items || [],
      opdVisitId,
      notes,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(rx);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function opdComplete(req, res) {
  try {
    const { visitId } = req.params;
    const { data: visit } = await supabase.from('opd_visits').select('*').eq('id', visitId).single();
    if (!visit) return res.status(404).json({ error: 'OPD visit not found' });

    const { data: consult } = await supabase
      .from('charge_items')
      .select('*')
      .eq('code', 'OPD-CONSULT')
      .maybeSingle();

    const { invoice, line } = await addChargeLine({
      patientId: visit.patient_id,
      opdVisitId: visitId,
      chargeItemId: consult?.id || null,
      description: consult?.name || 'OPD Consultation',
      quantity: 1,
      unitPrice: consult?.unit_price ?? 500,
      sourceModule: 'opd',
      sourceTable: 'opd_visits',
      sourceId: visitId,
      createdBy: req.user?.id,
      actor: actorFrom(req),
      req,
    });

    await supabase
      .from('opd_visits')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', visitId);

    await createEncounter({
      patientId: visit.patient_id,
      module: 'billing',
      staffId: req.user?.id,
      status: 'waiting',
      metadata: { from: 'opd_complete', invoice_id: invoice.id },
      sourceTable: 'invoices',
      sourceId: invoice.id,
    });

    res.json({ visit_id: visitId, invoice, consultation_line: line });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ---------- Lab ----------
export async function labWorklist(req, res) {
  try {
    const data = await listWorklist({
      status: req.query.status || null,
      pendingOnly: req.query.all !== '1',
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function labCatalogue(req, res) {
  try {
    res.json(await listCatalogue());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function labCatalogueUpsert(req, res) {
  try {
    const row = await upsertCatalogueTest(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function labCreateWalkIn(req, res) {
  try {
    const order = await createLabRequest({
      patientId: req.body.patient_id,
      testIds: req.body.test_ids,
      priority: req.body.priority,
      source: req.body.source || 'walk-in',
      notes: req.body.notes,
      sampleType: req.body.sample_type,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function labAdvance(req, res) {
  try {
    const data = await advanceLabOrder({
      orderId: req.params.id,
      toStatus: req.body.status,
      sampleId: req.body.sample_id,
      sampleType: req.body.sample_type,
      actor: actorFrom(req),
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function labEnterResult(req, res) {
  try {
    const result = await enterResult({
      itemId: req.params.itemId,
      value: req.body.value,
      unit: req.body.unit,
      resultNotes: req.body.result_notes,
      actor: actorFrom(req),
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function labVerify(req, res) {
  try {
    const result = await verifyResult({
      itemId: req.params.itemId,
      actor: actorFrom(req),
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function labVersionResult(req, res) {
  try {
    const result = await createResultVersion({
      itemId: req.params.itemId,
      value: req.body.value,
      unit: req.body.unit,
      resultNotes: req.body.result_notes,
      changeReason: req.body.change_reason,
      actor: actorFrom(req),
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function labSend(req, res) {
  try {
    const data = await advanceLabOrder({
      orderId: req.params.id,
      toStatus: 'sent',
      actor: actorFrom(req),
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ---------- Pharmacy ----------
export async function pharmacyToDispense(req, res) {
  try {
    res.json(await listToDispense());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function pharmacyDispense(req, res) {
  try {
    const result = await dispensePrescription({
      prescriptionId: req.params.id,
      partialQuantities: req.body?.partial_quantities || null,
      actor: actorFrom(req),
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function pharmacyStock(req, res) {
  try {
    res.json(await listStock({ search: req.query.search || '' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function pharmacyReceive(req, res) {
  try {
    const result = await receiveStock({
      medicineId: req.body.medicine_id,
      batchNo: req.body.batch_no,
      expiryDate: req.body.expiry_date,
      quantity: req.body.quantity,
      unitCost: req.body.unit_cost,
      sellingPrice: req.body.selling_price,
      supplier: req.body.supplier,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function pharmacyAdjust(req, res) {
  try {
    const result = await adjustStock({
      medicineId: req.body.medicine_id,
      batchId: req.body.batch_id,
      quantityDelta: req.body.quantity_delta,
      reason: req.body.reason,
      movementType: req.body.movement_type || 'adjust',
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function pharmacyExpiring(req, res) {
  try {
    const days = Number(req.query.days) || 90;
    res.json(await listExpiring({ withinDays: days }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function pharmacyMovements(req, res) {
  try {
    let q = supabase
      .from('stock_movements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (req.query.medicine_id) q = q.eq('medicine_id', req.query.medicine_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------- Billing ----------
export async function billingInvoices(req, res) {
  try {
    let q = supabase.from('invoices').select('*').order('created_at', { ascending: false }).limit(200);
    if (req.query.status === 'open') {
      q = q.in('status', ['open', 'issued', 'partial', 'draft']);
    } else if (req.query.status) {
      q = q.eq('status', req.query.status);
    }
    if (req.query.patient_id) q = q.eq('patient_id', req.query.patient_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function billingInvoiceDetail(req, res) {
  try {
    const { id } = req.params;
    const { data: inv, error } = await supabase.from('invoices').select('*').eq('id', id).single();
    if (error || !inv) return res.status(404).json({ error: 'Invoice not found' });
    const { data: lines } = await supabase.from('invoice_lines').select('*').eq('invoice_id', id);
    const { data: payments } = await supabase.from('payments').select('*').eq('invoice_id', id);
    const { data: credits } = await supabase.from('credit_notes').select('*').eq('invoice_id', id);
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'invoice',
      resourceId: id,
      patientId: inv.patient_id,
      module: 'billing',
      req,
    });
    res.json({ ...inv, lines: lines || [], payments: payments || [], credit_notes: credits || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function billingPay(req, res) {
  try {
    const result = await recordPayment({
      invoiceId: req.params.id,
      amount: req.body.amount,
      method: req.body.method || 'cash',
      notes: req.body.notes,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function billingWaive(req, res) {
  try {
    const data = await waiveInvoice({
      invoiceId: req.params.id,
      reason: req.body.reason,
      actor: actorFrom(req),
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function billingInsurance(req, res) {
  try {
    const data = await markInsuranceClaim({
      invoiceId: req.params.id,
      scheme: req.body.insurance_scheme,
      memberNo: req.body.insurance_member_no,
      actor: actorFrom(req),
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function billingCreditNote(req, res) {
  try {
    const data = await createCreditNote({
      invoiceId: req.params.id,
      amount: req.body.amount,
      reason: req.body.reason,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function billingPriceList(req, res) {
  try {
    res.json(await listPriceList({ activeOnly: req.query.all !== '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function billingPriceUpsert(req, res) {
  try {
    const row = await upsertPriceItem(req.body || {}, actorFrom(req), req);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function billingCashSummary(req, res) {
  try {
    res.json(await dailyCashSummary({ date: req.query.date || null }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function billingManualCharge(req, res) {
  try {
    const { patient_id, charge_item_id, description, quantity, unit_price, opd_visit_id } = req.body || {};
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
    let desc = description;
    let price = unit_price;
    let chargeItemId = charge_item_id || null;
    if (charge_item_id) {
      const { data: ci } = await supabase.from('charge_items').select('*').eq('id', charge_item_id).single();
      if (ci) {
        desc = desc || ci.name;
        price = price != null ? price : ci.unit_price;
        chargeItemId = ci.id;
      }
    }
    const result = await addChargeLine({
      patientId: patient_id,
      opdVisitId: opd_visit_id || null,
      chargeItemId,
      description: desc || 'Manual charge',
      quantity: quantity || 1,
      unitPrice: price || 0,
      sourceModule: 'billing',
      sourceTable: 'manual',
      createdBy: req.user?.id,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function billingReceiptPdf(req, res) {
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
    const { data: lines } = await supabase.from('invoice_lines').select('*').eq('invoice_id', pay.invoice_id);

    const buf = await buildPdfBuffer('Payment Receipt', [
      {
        heading: pay.receipt_no,
        lines: [
          `Invoice: ${inv?.invoice_no || ''}`,
          `Patient: ${patient?.full_name || ''} (${patient?.mrn || ''})`,
          `Amount paid: ${pay.amount}`,
          `Method: ${pay.method}`,
          `Paid at: ${pay.paid_at}`,
          `Invoice total: ${inv?.total}`,
          `Status: ${inv?.status}`,
        ],
        table: {
          headers: ['Item', 'Qty', 'Unit', 'Total'],
          rows: (lines || []).map((l) => [
            l.description,
            String(l.quantity),
            String(l.unit_price),
            String(l.line_total),
          ]),
        },
      },
    ]);

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'print',
      resourceType: 'payment',
      resourceId: paymentId,
      patientId: inv?.patient_id,
      module: 'billing',
      metadata: { receipt_no: pay.receipt_no },
      req,
    });

    sendBinary(res, buf, {
      filename: `receipt-${pay.receipt_no}.pdf`,
      contentType: 'application/pdf',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function billingEnsureOpen(req, res) {
  try {
    const inv = await getOrCreateOpenInvoice({
      patientId: req.body.patient_id,
      opdVisitId: req.body.opd_visit_id,
      sourceModule: req.body.source_module || null,
      createdBy: req.user?.id,
    });
    const updated = await recalcInvoice(inv.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
