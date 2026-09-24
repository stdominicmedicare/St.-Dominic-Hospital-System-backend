/**
 * Clinical laboratory orders and results.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';

export async function listLabTests(req, res) {
  try {
    const { data, error } = await supabase
      .from('lab_tests')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listLabOrders(req, res) {
  try {
    const { status, patient_id } = req.query;
    let q = supabase.from('lab_orders').select('*').order('ordered_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (patient_id) q = q.eq('patient_id', patient_id);
    const { data, error } = await q.limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getLabOrder(req, res) {
  try {
    const { id } = req.params;
    const { data: order, error } = await supabase.from('lab_orders').select('*').eq('id', id).single();
    if (error || !order) return res.status(404).json({ error: 'Order not found' });
    const { data: items } = await supabase
      .from('lab_order_items')
      .select('*, test:lab_tests(*), result:lab_results(*)')
      .eq('order_id', id);
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'lab_order',
      resourceId: id,
      patientId: order.patient_id,
      req,
    });
    res.json({ ...order, items: items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createLabOrder(req, res) {
  try {
    const { patient_id, test_ids, priority, notes } = req.body;
    if (!patient_id || !Array.isArray(test_ids) || !test_ids.length) {
      return res.status(400).json({ error: 'patient_id and test_ids[] required' });
    }
    const { data: order, error } = await supabase
      .from('lab_orders')
      .insert({
        patient_id,
        ordered_by: req.user?.id || null,
        priority: priority || 'routine',
        notes: notes || null,
        status: 'ordered',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    const items = test_ids.map((test_id) => ({ order_id: order.id, test_id, status: 'pending' }));
    const { error: iErr } = await supabase.from('lab_order_items').insert(items);
    if (iErr) return res.status(500).json({ error: iErr.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'lab_order',
      resourceId: order.id,
      patientId: patient_id,
      after: order,
      req,
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateLabOrderStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const patch = { status, updated_at: new Date().toISOString() };
    if (status === 'completed') patch.completed_at = new Date().toISOString();
    const { data, error } = await supabase.from('lab_orders').update(patch).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function enterLabResult(req, res) {
  try {
    const { itemId } = req.params;
    const { value, unit, flagged, result_notes, verify } = req.body;
    const { data: item } = await supabase.from('lab_order_items').select('*, order:lab_orders(*)').eq('id', itemId).single();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const row = {
      item_id: itemId,
      value: value != null ? String(value) : null,
      unit: unit || null,
      flagged: !!flagged,
      result_notes: result_notes || null,
      entered_by: req.user?.id || null,
      entered_at: new Date().toISOString(),
    };
    if (verify) {
      row.verified_by = req.user?.id || null;
      row.verified_at = new Date().toISOString();
    }

    const { data: existing } = await supabase.from('lab_results').select('id').eq('item_id', itemId).maybeSingle();
    let result;
    if (existing?.id) {
      const { data, error } = await supabase.from('lab_results').update(row).eq('id', existing.id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      result = data;
    } else {
      const { data, error } = await supabase.from('lab_results').insert(row).select().single();
      if (error) return res.status(500).json({ error: error.message });
      result = data;
    }

    await supabase
      .from('lab_order_items')
      .update({ status: verify ? 'verified' : 'resulted' })
      .eq('id', itemId);

    const { data: siblings } = await supabase.from('lab_order_items').select('status').eq('order_id', item.order_id);
    const allDone = (siblings || []).every((s) => ['resulted', 'verified', 'cancelled'].includes(s.status));
    if (allDone) {
      await supabase
        .from('lab_orders')
        .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', item.order_id);
    } else {
      await supabase
        .from('lab_orders')
        .update({ status: 'in_progress', updated_at: new Date().toISOString() })
        .eq('id', item.order_id);
    }

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: verify ? 'edit' : 'create',
      resourceType: 'lab_result',
      resourceId: result.id,
      patientId: item.order?.patient_id,
      after: result,
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function labWorklist(req, res) {
  try {
    const { data, error } = await supabase
      .from('lab_orders')
      .select('*')
      .in('status', ['ordered', 'collected', 'in_progress'])
      .order('ordered_at', { ascending: true })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
