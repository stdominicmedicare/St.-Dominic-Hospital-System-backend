/**
 * MCH: ANC, maternity/delivery, postnatal.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';

export async function listPregnancies(req, res) {
  try {
    const { patient_id, status } = req.query;
    let q = supabase.from('anc_pregnancies').select('*').order('created_at', { ascending: false });
    if (patient_id) q = q.eq('patient_id', patient_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createPregnancy(req, res) {
  try {
    const { patient_id, lmp, edd, gravida, para, risk_notes } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
    const { data, error } = await supabase
      .from('anc_pregnancies')
      .insert({
        patient_id,
        lmp: lmp || null,
        edd: edd || null,
        gravida: gravida != null ? parseInt(gravida, 10) : null,
        para: para != null ? parseInt(para, 10) : null,
        risk_notes: risk_notes || null,
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
      resourceType: 'anc_pregnancy',
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

export async function listAncVisits(req, res) {
  try {
    const { pregnancy_id } = req.query;
    let q = supabase.from('anc_visits').select('*').order('visit_date', { ascending: false });
    if (pregnancy_id) q = q.eq('pregnancy_id', pregnancy_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createAncVisit(req, res) {
  try {
    const body = req.body;
    if (!body.pregnancy_id) return res.status(400).json({ error: 'pregnancy_id required' });
    const { data: preg } = await supabase
      .from('anc_pregnancies')
      .select('patient_id')
      .eq('id', body.pregnancy_id)
      .single();
    const payload = {
      pregnancy_id: body.pregnancy_id,
      visit_no: body.visit_no != null ? parseInt(body.visit_no, 10) : null,
      visit_date: body.visit_date || new Date().toISOString().slice(0, 10),
      weight_kg: body.weight_kg != null ? parseFloat(body.weight_kg) : null,
      bp_systolic: body.bp_systolic != null ? parseInt(body.bp_systolic, 10) : null,
      bp_diastolic: body.bp_diastolic != null ? parseInt(body.bp_diastolic, 10) : null,
      fundal_height_cm: body.fundal_height_cm != null ? parseFloat(body.fundal_height_cm) : null,
      fetal_heart_rate: body.fetal_heart_rate != null ? parseInt(body.fetal_heart_rate, 10) : null,
      next_visit_date: body.next_visit_date || null,
      notes: body.notes || null,
      created_by: req.user?.id || null,
    };
    const { data, error } = await supabase.from('anc_visits').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'anc_visit',
      resourceId: data.id,
      patientId: preg?.patient_id,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listAdmissions(req, res) {
  try {
    const { status } = req.query;
    let q = supabase.from('maternity_admissions').select('*').order('admitted_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createAdmission(req, res) {
  try {
    const { patient_id, pregnancy_id, ward, bed, notes } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
    const { data, error } = await supabase
      .from('maternity_admissions')
      .insert({
        patient_id,
        pregnancy_id: pregnancy_id || null,
        ward: ward || null,
        bed: bed || null,
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
      resourceType: 'maternity_admission',
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

export async function recordDelivery(req, res) {
  try {
    const { admission_id, delivered_at, mode, outcome, complications, notes, newborn } = req.body;
    if (!admission_id) return res.status(400).json({ error: 'admission_id required' });
    const { data: adm } = await supabase
      .from('maternity_admissions')
      .select('*')
      .eq('id', admission_id)
      .single();
    if (!adm) return res.status(404).json({ error: 'Admission not found' });
    const { data: delivery, error } = await supabase
      .from('deliveries')
      .insert({
        admission_id,
        delivered_at: delivered_at || new Date().toISOString(),
        mode: mode || null,
        outcome: outcome || 'live_birth',
        complications: complications || null,
        notes: notes || null,
        created_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    let nb = null;
    if (newborn) {
      const { data: n, error: nErr } = await supabase
        .from('newborns')
        .insert({
          delivery_id: delivery.id,
          sex: newborn.sex || null,
          birth_weight_g: newborn.birth_weight_g != null ? parseInt(newborn.birth_weight_g, 10) : null,
          apgar_1: newborn.apgar_1 != null ? parseInt(newborn.apgar_1, 10) : null,
          apgar_5: newborn.apgar_5 != null ? parseInt(newborn.apgar_5, 10) : null,
          notes: newborn.notes || null,
        })
        .select()
        .single();
      if (nErr) return res.status(500).json({ error: nErr.message });
      nb = n;
    }

    await supabase
      .from('maternity_admissions')
      .update({ status: 'delivered', updated_at: new Date().toISOString() })
      .eq('id', admission_id);
    if (adm.pregnancy_id) {
      await supabase
        .from('anc_pregnancies')
        .update({ status: 'delivered', updated_at: new Date().toISOString() })
        .eq('id', adm.pregnancy_id);
    }

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'delivery',
      resourceId: delivery.id,
      patientId: adm.patient_id,
      after: { delivery, newborn: nb },
      req,
    });
    res.status(201).json({ delivery, newborn: nb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listPncVisits(req, res) {
  try {
    const { mother_id } = req.query;
    let q = supabase.from('pnc_visits').select('*').order('visit_date', { ascending: false });
    if (mother_id) q = q.eq('mother_id', mother_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createPncVisit(req, res) {
  try {
    const body = req.body;
    if (!body.mother_id) return res.status(400).json({ error: 'mother_id required' });
    const { data, error } = await supabase
      .from('pnc_visits')
      .insert({
        mother_id: body.mother_id,
        newborn_id: body.newborn_id || null,
        delivery_id: body.delivery_id || null,
        visit_no: body.visit_no != null ? parseInt(body.visit_no, 10) : null,
        visit_date: body.visit_date || new Date().toISOString().slice(0, 10),
        mother_status: body.mother_status || null,
        baby_status: body.baby_status || null,
        next_visit_date: body.next_visit_date || null,
        notes: body.notes || null,
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
      resourceType: 'pnc_visit',
      resourceId: data.id,
      patientId: body.mother_id,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function mchDueLists(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: ancDue } = await supabase
      .from('anc_visits')
      .select('id, pregnancy_id, next_visit_date, visit_date')
      .lte('next_visit_date', today)
      .not('next_visit_date', 'is', null)
      .order('next_visit_date')
      .limit(50);
    const { data: pncDue } = await supabase
      .from('pnc_visits')
      .select('id, mother_id, next_visit_date')
      .lte('next_visit_date', today)
      .not('next_visit_date', 'is', null)
      .order('next_visit_date')
      .limit(50);
    const { data: labour } = await supabase
      .from('maternity_admissions')
      .select('*')
      .eq('status', 'in_labour');
    res.json({
      anc_due: ancDue || [],
      pnc_due: pncDue || [],
      in_labour: labour || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
