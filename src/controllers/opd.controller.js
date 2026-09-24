/**
 * OPD visits + follow-ups.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';

async function nextTokenForDate(visitDate) {
  const { count } = await supabase
    .from('opd_visits')
    .select('id', { count: 'exact', head: true })
    .eq('visit_date', visitDate);
  return (count || 0) + 1;
}

export async function listOpdVisits(req, res) {
  try {
    const { date, status, doctor_id, patient_id } = req.query;
    let q = supabase
      .from('opd_visits')
      .select(
        '*, patient:profiles!opd_visits_patient_id_fkey(id, full_name, mrn, phone), doctor:profiles!opd_visits_doctor_id_fkey(id, full_name)'
      )
      .order('token_no', { ascending: true });
    if (date) q = q.eq('visit_date', date);
    else q = q.eq('visit_date', new Date().toISOString().slice(0, 10));
    if (status) q = q.eq('status', status);
    if (doctor_id) q = q.eq('doctor_id', doctor_id);
    if (patient_id) q = q.eq('patient_id', patient_id);
    const { data, error } = await q;
    if (error) {
      let q2 = supabase.from('opd_visits').select('*').order('created_at', { ascending: false });
      if (date) q2 = q2.eq('visit_date', date);
      else q2 = q2.eq('visit_date', new Date().toISOString().slice(0, 10));
      if (status) q2 = q2.eq('status', status);
      const fallback = await q2;
      if (fallback.error) return res.status(500).json({ error: fallback.error.message });
      return res.json(fallback.data || []);
    }
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createOpdVisit(req, res) {
  try {
    const {
      patient_id,
      department_id,
      doctor_id,
      appointment_id,
      visit_date,
      chief_complaint,
      triage_level,
      vitals,
      notes,
    } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });
    const vd = visit_date || new Date().toISOString().slice(0, 10);
    const token_no = await nextTokenForDate(vd);
    const payload = {
      patient_id,
      department_id: department_id || null,
      doctor_id: doctor_id || null,
      appointment_id: appointment_id || null,
      visit_date: vd,
      token_no,
      chief_complaint: chief_complaint || null,
      triage_level: triage_level || null,
      vitals: vitals || {},
      status: 'waiting',
      notes: notes || null,
      created_by: req.user?.id || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('opd_visits').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'opd_visit',
      resourceId: data.id,
      patientId: patient_id,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateOpdVisit(req, res) {
  try {
    const { id } = req.params;
    const { data: before } = await supabase.from('opd_visits').select('*').eq('id', id).single();
    if (!before) return res.status(404).json({ error: 'Visit not found' });
    const allowed = [
      'doctor_id',
      'department_id',
      'chief_complaint',
      'triage_level',
      'vitals',
      'status',
      'notes',
    ];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    if (patch.status === 'triaged' && !before.triage_level && !patch.triage_level) {
      patch.triage_level = 'medium';
    }
    const { data, error } = await supabase.from('opd_visits').update(patch).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'opd_visit',
      resourceId: id,
      patientId: data.patient_id,
      before,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listFollowUps(req, res) {
  try {
    const { due_before, due_after, status, patient_id, overdue } = req.query;
    let q = supabase.from('follow_ups').select('*').order('due_date', { ascending: true });
    if (patient_id) q = q.eq('patient_id', patient_id);
    if (status) q = q.eq('status', status);
    if (due_before) q = q.lte('due_date', due_before);
    if (due_after) q = q.gte('due_date', due_after);
    if (String(overdue) === 'true') {
      q = q.lt('due_date', new Date().toISOString().slice(0, 10)).eq('status', 'scheduled');
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createFollowUp(req, res) {
  try {
    const {
      patient_id,
      doctor_id,
      related_appointment_id,
      related_opd_visit_id,
      reason,
      due_date,
      notes,
    } = req.body;
    if (!patient_id || !due_date) {
      return res.status(400).json({ error: 'patient_id and due_date are required' });
    }
    const payload = {
      patient_id,
      doctor_id: doctor_id || null,
      related_appointment_id: related_appointment_id || null,
      related_opd_visit_id: related_opd_visit_id || null,
      reason: reason || null,
      due_date,
      status: 'scheduled',
      notes: notes || null,
      created_by: req.user?.id || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('follow_ups').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'follow_up',
      resourceId: data.id,
      patientId: patient_id,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateFollowUp(req, res) {
  try {
    const { id } = req.params;
    const { data: before } = await supabase.from('follow_ups').select('*').eq('id', id).single();
    if (!before) return res.status(404).json({ error: 'Follow-up not found' });
    const patch = { updated_at: new Date().toISOString() };
    for (const k of ['status', 'due_date', 'reason', 'notes', 'completed_appointment_id', 'doctor_id']) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    const { data, error } = await supabase.from('follow_ups').update(patch).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'follow_up',
      resourceId: id,
      patientId: data.patient_id,
      before,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
