/**
 * Immunization, family planning, HIV care.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';

const HIV_ROLES = new Set(['Admin', 'Doctor', 'Nurse', 'Midwife']);

function assertHivAccess(req, res) {
  if (!HIV_ROLES.has(req.role)) {
    res.status(403).json({ error: 'HIV module access denied for this role' });
    return false;
  }
  return true;
}

// ---- Immunization ----
export async function listVaccines(req, res) {
  try {
    const { data, error } = await supabase.from('vaccines').select('*').eq('is_active', true).order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listImmunizations(req, res) {
  try {
    const { patient_id, due } = req.query;
    if (String(due) === 'true') {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('immunization_records')
        .select('*')
        .lte('next_due', today)
        .not('next_due', 'is', null)
        .order('next_due')
        .limit(100);
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data || []);
    }
    let q = supabase.from('immunization_records').select('*').order('given_at', { ascending: false });
    if (patient_id) q = q.eq('patient_id', patient_id);
    const { data, error } = await q.limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function recordImmunization(req, res) {
  try {
    const { patient_id, vaccine_id, dose_no, given_at, batch_no, next_due, notes } = req.body;
    if (!patient_id || !vaccine_id) {
      return res.status(400).json({ error: 'patient_id and vaccine_id required' });
    }
    const { data, error } = await supabase
      .from('immunization_records')
      .insert({
        patient_id,
        vaccine_id,
        dose_no: dose_no != null ? parseInt(dose_no, 10) : 1,
        given_at: given_at || new Date().toISOString().slice(0, 10),
        batch_no: batch_no || null,
        next_due: next_due || null,
        given_by: req.user?.id || null,
        notes: notes || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'immunization',
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

// ---- Family planning ----
export async function listFpMethods(req, res) {
  try {
    const { data, error } = await supabase.from('fp_methods').select('*').eq('is_active', true).order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listFpEncounters(req, res) {
  try {
    const { patient_id } = req.query;
    let q = supabase.from('fp_encounters').select('*').order('provided_at', { ascending: false });
    if (patient_id) q = q.eq('patient_id', patient_id);
    const { data, error } = await q.limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createFpEncounter(req, res) {
  try {
    const { patient_id, method_id, provided_at, quantity, counseling_notes, next_visit } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
    const { data, error } = await supabase
      .from('fp_encounters')
      .insert({
        patient_id,
        method_id: method_id || null,
        provided_at: provided_at || new Date().toISOString().slice(0, 10),
        quantity: quantity != null ? parseFloat(quantity) : null,
        counseling_notes: counseling_notes || null,
        next_visit: next_visit || null,
        provided_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'fp_encounter',
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

// ---- HIV ----
export async function listHivEnrollments(req, res) {
  if (!assertHivAccess(req, res)) return;
  try {
    const { status } = req.query;
    let q = supabase.from('hiv_enrollments').select('*').order('enrollment_date', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'hiv_enrollment',
      metadata: { list: true, count: (data || []).length },
      req,
    });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function enrollHiv(req, res) {
  if (!assertHivAccess(req, res)) return;
  try {
    const { patient_id, enrollment_date, art_started, art_start_date, notes } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
    const { data, error } = await supabase
      .from('hiv_enrollments')
      .insert({
        patient_id,
        enrollment_date: enrollment_date || new Date().toISOString().slice(0, 10),
        art_started: !!art_started,
        art_start_date: art_start_date || null,
        notes: notes || null,
        created_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'hiv_enrollment',
      resourceId: data.id,
      patientId: patient_id,
      after: { id: data.id, status: data.status },
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getHivChart(req, res) {
  if (!assertHivAccess(req, res)) return;
  try {
    const { id } = req.params;
    const { data: enrollment, error } = await supabase.from('hiv_enrollments').select('*').eq('id', id).single();
    if (error || !enrollment) return res.status(404).json({ error: 'Enrollment not found' });
    const { data: visits } = await supabase
      .from('hiv_visits')
      .select('*')
      .eq('enrollment_id', id)
      .order('visit_date', { ascending: false });
    const { data: labs } = await supabase
      .from('hiv_lab_results')
      .select('*')
      .eq('enrollment_id', id)
      .order('result_date', { ascending: false });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'hiv_enrollment',
      resourceId: id,
      patientId: enrollment.patient_id,
      req,
    });
    res.json({ enrollment, visits: visits || [], labs: labs || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function addHivVisit(req, res) {
  if (!assertHivAccess(req, res)) return;
  try {
    const { enrollment_id, visit_date, who_stage, weight_kg, notes } = req.body;
    if (!enrollment_id) return res.status(400).json({ error: 'enrollment_id required' });
    const { data: enr } = await supabase.from('hiv_enrollments').select('patient_id').eq('id', enrollment_id).single();
    const { data, error } = await supabase
      .from('hiv_visits')
      .insert({
        enrollment_id,
        visit_date: visit_date || new Date().toISOString().slice(0, 10),
        who_stage: who_stage != null ? parseInt(who_stage, 10) : null,
        weight_kg: weight_kg != null ? parseFloat(weight_kg) : null,
        notes: notes || null,
        created_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'hiv_visit',
      resourceId: data.id,
      patientId: enr?.patient_id,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function addHivLab(req, res) {
  if (!assertHivAccess(req, res)) return;
  try {
    const { enrollment_id, result_date, cd4, viral_load, notes } = req.body;
    if (!enrollment_id) return res.status(400).json({ error: 'enrollment_id required' });
    const { data: enr } = await supabase.from('hiv_enrollments').select('patient_id').eq('id', enrollment_id).single();
    const { data, error } = await supabase
      .from('hiv_lab_results')
      .insert({
        enrollment_id,
        result_date: result_date || new Date().toISOString().slice(0, 10),
        cd4: cd4 != null ? parseInt(cd4, 10) : null,
        viral_load: viral_load != null ? parseFloat(viral_load) : null,
        notes: notes || null,
        created_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (req.body.art_started) {
      await supabase
        .from('hiv_enrollments')
        .update({
          art_started: true,
          art_start_date: req.body.art_start_date || new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        .eq('id', enrollment_id);
    }
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'hiv_lab',
      resourceId: data.id,
      patientId: enr?.patient_id,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
