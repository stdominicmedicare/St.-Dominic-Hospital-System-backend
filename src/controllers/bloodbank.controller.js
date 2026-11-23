/**
 * Blood Bank module: dashboard, donors, blood units, testing, requests, allocations, transfusion & disposal logs.
 * All operations require BloodBank or Admin role (except request creation by Doctor/ICU and patient read).
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';
import { createEncounter } from '../services/encounterService.js';
import { PATIENT_MIN_FIELDS, safeCreateEncounter } from '../services/patientProfileFields.js';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const CRITICAL_THRESHOLD = 5;
const LOW_THRESHOLD = 15;
const ADEQUATE_THRESHOLD = 30;

/** Dashboard KPIs: total units, critical stock count, pending tests, pending requests. */
export async function getDashboard(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [unitsRes, testingRes, requestsRes] = await Promise.all([
      supabase.from('blood_units').select('id, blood_group, status, expiry_date'),
      supabase.from('blood_testing').select('id').eq('test_status', 'pending'),
      supabase.from('blood_requests').select('id', { count: 'exact', head: true }).eq('request_status', 'pending'),
    ]);
    const units = unitsRes.data || [];
    const available = units.filter((u) => u.status === 'available' && u.expiry_date >= today);
    const byGroup = {};
    BLOOD_GROUPS.forEach((bg) => { byGroup[bg] = 0; });
    available.forEach((u) => { byGroup[u.blood_group] = (byGroup[u.blood_group] || 0) + 1; });
    let criticalStock = 0;
    Object.values(byGroup).forEach((count) => {
      if (count < CRITICAL_THRESHOLD) criticalStock++;
    });
    res.json({
      totalBloodUnits: units.length,
      criticalStock,
      pendingTestsCount: (testingRes.data || []).length,
      pendingRequestsCount: requestsRes.count ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** List donors with optional search. */
export async function getDonors(req, res) {
  try {
    const { search } = req.query;
    let q = supabase
      .from('donors')
      .select('id, donor_code, full_name, blood_group, contact_phone, contact_email, last_donation_date, total_donations, eligible_date, created_at')
      .order('full_name');
    if (search && String(search).trim()) {
      q = q.or(`full_name.ilike.%${search.trim()}%,donor_code.ilike.%${search.trim()}%,contact_email.ilike.%${search.trim()}%`);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Create donor. */
export async function createDonor(req, res) {
  try {
    const { full_name, blood_group, contact_phone, contact_email, medical_screening_notes, last_donation_date, total_donations, eligible_date, donor_code } = req.body;
    if (!full_name || !blood_group) return res.status(400).json({ error: 'full_name and blood_group are required' });
    if (!BLOOD_GROUPS.includes(blood_group)) return res.status(400).json({ error: 'Invalid blood_group' });
    const payload = {
      full_name: String(full_name).trim(),
      blood_group,
      contact_phone: contact_phone != null ? String(contact_phone).trim() : null,
      contact_email: contact_email != null ? String(contact_email).trim() : null,
      medical_screening_notes: medical_screening_notes != null ? String(medical_screening_notes).trim() : null,
      last_donation_date: last_donation_date || null,
      total_donations: Math.max(0, parseInt(total_donations, 10) || 0),
      eligible_date: eligible_date || null,
      donor_code: donor_code || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('donors').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'donor',
      resourceId: data.id,
      patientId: null,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Update donor. */
export async function updateDonor(req, res) {
  try {
    const { id } = req.params;
    const allowed = ['full_name', 'blood_group', 'contact_phone', 'contact_email', 'medical_screening_notes', 'last_donation_date', 'total_donations', 'eligible_date'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) {
        if (k === 'total_donations') updates[k] = Math.max(0, parseInt(req.body[k], 10) ?? 0);
        else if (k === 'blood_group') updates[k] = BLOOD_GROUPS.includes(req.body[k]) ? req.body[k] : undefined;
        else updates[k] = req.body[k];
      }
    });
    const { data, error } = await supabase.from('donors').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'donor',
      resourceId: id,
      patientId: null,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Inventory by blood group (counts + status label). */
export async function getInventoryByGroup(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: units, error } = await supabase
      .from('blood_units')
      .select('id, blood_group, status, expiry_date')
      .in('status', ['available'])
      .gte('expiry_date', today);
    if (error) return res.status(500).json({ error: error.message });
    const byGroup = {};
    BLOOD_GROUPS.forEach((bg) => { byGroup[bg] = { blood_group: bg, unitsAvailable: 0, status: 'Critical' }; });
    (units || []).forEach((u) => {
      byGroup[u.blood_group].unitsAvailable++;
    });
    Object.keys(byGroup).forEach((bg) => {
      const n = byGroup[bg].unitsAvailable;
      byGroup[bg].status = n >= ADEQUATE_THRESHOLD ? 'Good' : n >= LOW_THRESHOLD ? 'Adequate' : n >= CRITICAL_THRESHOLD ? 'Low' : 'Critical';
    });
    res.json(Object.values(byGroup));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** List blood units with optional blood_group and status filter. */
export async function getBloodUnits(req, res) {
  try {
    const { blood_group, status } = req.query;
    let q = supabase
      .from('blood_units')
      .select('id, donor_id, blood_group, component_type, collection_date, expiry_date, status, storage_location, created_at')
      .order('collection_date', { ascending: false });
    if (blood_group && BLOOD_GROUPS.includes(blood_group)) q = q.eq('blood_group', blood_group);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Create blood unit (on donation). */
export async function createBloodUnit(req, res) {
  try {
    const { donor_id, blood_group, component_type, collection_date, expiry_date, storage_location } = req.body;
    if (!blood_group) return res.status(400).json({ error: 'blood_group is required' });
    if (!BLOOD_GROUPS.includes(blood_group)) return res.status(400).json({ error: 'Invalid blood_group' });
    const compTypes = ['whole_blood', 'plasma', 'platelets', 'rbc'];
    const payload = {
      donor_id: donor_id || null,
      blood_group,
      component_type: compTypes.includes(component_type) ? component_type : 'whole_blood',
      collection_date: collection_date || new Date().toISOString().slice(0, 10),
      expiry_date: expiry_date || null,
      status: 'collected',
      storage_location: storage_location != null ? String(storage_location).trim() : null,
      updated_at: new Date().toISOString(),
    };
    if (!payload.expiry_date && payload.collection_date) {
      const d = new Date(payload.collection_date);
      d.setDate(d.getDate() + 42);
      payload.expiry_date = d.toISOString().slice(0, 10);
    }
    const { data: unit, error: unitErr } = await supabase.from('blood_units').insert(payload).select().single();
    if (unitErr) return res.status(500).json({ error: unitErr.message });
    await supabase.from('blood_testing').insert({
      unit_id: unit.id,
      test_status: 'pending',
      approved_flag: false,
      updated_at: new Date().toISOString(),
    });
    const { data: updated } = await supabase.from('blood_units').update({ status: 'testing', updated_at: new Date().toISOString() }).eq('id', unit.id).select().single();
    const result = updated || unit;
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'blood_unit',
      resourceId: result.id,
      patientId: null,
      after: result,
      req,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Update blood unit (e.g. storage, or manual status). */
export async function updateBloodUnit(req, res) {
  try {
    const { id } = req.params;
    const allowed = ['storage_location', 'status'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    const { data, error } = await supabase.from('blood_units').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_unit',
      resourceId: id,
      patientId: null,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Units under testing (for Donations & Testing tab). */
export async function getUnitsUnderTesting(req, res) {
  try {
    const { data: testingList, error: tErr } = await supabase
      .from('blood_testing')
      .select('id, unit_id, test_results, test_status, approved_flag, tested_at')
      .eq('test_status', 'pending');
    if (tErr) return res.status(500).json({ error: tErr.message });
    const unitIds = (testingList || []).map((t) => t.unit_id);
    if (unitIds.length === 0) return res.json([]);
    const { data: units, error: uErr } = await supabase
      .from('blood_units')
      .select('id, donor_id, blood_group, component_type, collection_date, expiry_date, status')
      .in('id', unitIds);
    if (uErr) return res.status(500).json({ error: uErr.message });
    const testingMap = Object.fromEntries((testingList || []).map((t) => [t.unit_id, t]));
    const result = (units || []).map((u) => ({ ...u, testing: testingMap[u.id] }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Approve unit: set testing approved, unit status available. */
export async function approveUnit(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { data: unit } = await supabase.from('blood_units').select('id, status').eq('id', id).single();
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    if (unit.status !== 'testing') return res.status(400).json({ error: 'Unit is not under testing' });
    await supabase.from('blood_testing').update({
      test_status: 'passed',
      approved_flag: true,
      tested_by: userId,
      tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('unit_id', id);
    await supabase.from('blood_units').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', id);
    const { data: updated } = await supabase.from('blood_units').select('*').eq('id', id).single();
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_unit',
      resourceId: id,
      patientId: null,
      after: updated,
      before: { status: unit.status },
      req,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Reject unit: set testing failed, unit status disposed (and disposal log). */
export async function rejectUnit(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { data: unit } = await supabase.from('blood_units').select('id, status').eq('id', id).single();
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    if (unit.status !== 'testing') return res.status(400).json({ error: 'Unit is not under testing' });
    await supabase.from('blood_testing').update({
      test_status: 'failed',
      approved_flag: false,
      tested_by: userId,
      tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('unit_id', id);
    await supabase.from('blood_units').update({ status: 'disposed', updated_at: new Date().toISOString() }).eq('id', id);
    await supabase.from('disposal_logs').insert({
      unit_id: id,
      disposal_reason: 'Failed screening',
      disposal_date: new Date().toISOString().slice(0, 10),
      disposed_by: userId,
    });
    const { data: updated } = await supabase.from('blood_units').select('*').eq('id', id).single();
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_unit',
      resourceId: id,
      patientId: null,
      after: updated,
      before: { status: unit.status },
      req,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Pending blood requests with patient and doctor info. */
export async function getBloodRequests(req, res) {
  try {
    const { status } = req.query;
    let q = supabase
      .from('blood_requests')
      .select('id, request_number, patient_id, doctor_id, blood_group_required, units_required, urgency_level, request_status, medical_reason, rejection_reason, requested_at, created_at')
      .order('requested_at', { ascending: false });
    if (status) q = q.eq('request_status', status);
    const { data: requests, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const list = requests || [];
    const patientIds = [...new Set(list.map((r) => r.patient_id))];
    const doctorIds = [...new Set(list.map((r) => r.doctor_id))];
    const [patientsRes, doctorsRes] = await Promise.all([
      patientIds.length ? supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds) : { data: [] },
      doctorIds.length ? supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', doctorIds) : { data: [] },
    ]);
    const patientMap = Object.fromEntries((patientsRes.data || []).map((p) => [p.id, p]));
    const doctorMap = Object.fromEntries((doctorsRes.data || []).map((d) => [d.id, d]));
    const result = list.map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
      doctor: doctorMap[r.doctor_id] || null,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Approve request (allocation done separately or inline). */
export async function approveRequest(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('blood_requests').update({
      request_status: 'approved',
      rejection_reason: null,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('request_status', 'pending').select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Request not found or not pending' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_request',
      resourceId: id,
      patientId: data.patient_id,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Reject request. */
export async function rejectRequest(req, res) {
  try {
    const { id } = req.params;
    const { rejection_reason } = req.body || {};
    const { data, error } = await supabase.from('blood_requests').update({
      request_status: 'rejected',
      rejection_reason: rejection_reason != null ? String(rejection_reason).trim() : null,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('request_status', 'pending').select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Request not found or not pending' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_request',
      resourceId: id,
      patientId: data.patient_id,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Allocate units to request: pick available units by blood_group, create allocations, set unit status allocated. */
export async function allocateRequest(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const today = new Date().toISOString().slice(0, 10);
    const { data: reqRow } = await supabase.from('blood_requests').select('*').eq('id', id).single();
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    if (reqRow.request_status !== 'approved') return res.status(400).json({ error: 'Request must be approved before allocation' });
    const needed = reqRow.units_required || 1;
    const bloodGroup = reqRow.blood_group_required;
    const { data: availableUnits } = await supabase
      .from('blood_units')
      .select('id')
      .eq('blood_group', bloodGroup)
      .eq('status', 'available')
      .gte('expiry_date', today)
      .limit(needed);
    if (!availableUnits || availableUnits.length < needed) {
      return res.status(400).json({ error: `Insufficient available units for ${bloodGroup}. Need ${needed}.` });
    }
    for (const u of availableUnits) {
      await supabase.from('blood_allocations').insert({
        request_id: id,
        unit_id: u.id,
        allocated_by: userId,
        allocation_time: new Date().toISOString(),
      });
      await supabase.from('blood_units').update({ status: 'allocated', updated_at: new Date().toISOString() }).eq('id', u.id);
    }
    await supabase.from('blood_requests').update({ request_status: 'fulfilled', updated_at: new Date().toISOString() }).eq('id', id);
    const { data: allocations } = await supabase.from('blood_allocations').select('*').eq('request_id', id);
    const result = { allocated: availableUnits.length, allocations: allocations || [] };
    if (reqRow.patient_id) {
      await safeCreateEncounter(createEncounter, {
        patientId: reqRow.patient_id,
        module: 'bloodbank',
        staffId: userId,
        status: 'done',
        metadata: { kind: 'allocate', units: availableUnits.length, blood_group: bloodGroup },
        sourceTable: 'blood_requests',
        sourceId: id,
      });
    }
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_request',
      resourceId: id,
      patientId: reqRow.patient_id,
      after: result,
      before: { request_status: reqRow.request_status },
      req,
      module: 'bloodbank',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Record transfusion (create log, set unit status transfused). */
export async function recordTransfusion(req, res) {
  try {
    const { request_id, unit_id, patient_id, doctor_id, notes } = req.body;
    if (!unit_id || !patient_id || !doctor_id) return res.status(400).json({ error: 'unit_id, patient_id, doctor_id required' });
    const { data: unit } = await supabase.from('blood_units').select('id, status').eq('id', unit_id).single();
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    if (unit.status !== 'allocated') return res.status(400).json({ error: 'Unit must be allocated first' });
    const { data: log, error } = await supabase.from('transfusion_logs').insert({
      patient_id,
      doctor_id,
      unit_id,
      request_id: request_id || null,
      transfusion_time: new Date().toISOString(),
      notes: notes != null ? String(notes).trim() : null,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('blood_units').update({ status: 'transfused', updated_at: new Date().toISOString() }).eq('id', unit_id);
    await safeCreateEncounter(createEncounter, {
      patientId: patient_id,
      module: 'bloodbank',
      staffId: req.user?.id,
      status: 'done',
      metadata: { kind: 'transfusion', unit_id, doctor_id },
      sourceTable: 'transfusion_logs',
      sourceId: log.id,
    });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'transfusion_log',
      resourceId: log.id,
      patientId: patient_id,
      after: log,
      req,
      module: 'bloodbank',
    });
    res.status(201).json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Transfusion logs list (for blood bank). */
export async function getTransfusionLogs(req, res) {
  try {
    const { data, error } = await supabase
      .from('transfusion_logs')
      .select('id, patient_id, doctor_id, unit_id, request_id, transfusion_time, notes, created_at')
      .order('transfusion_time', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Dispose unit: create disposal log, set unit status disposed. */
export async function disposeUnit(req, res) {
  try {
    const { id } = req.params;
    const { disposal_reason } = req.body || {};
    if (!disposal_reason || !String(disposal_reason).trim()) return res.status(400).json({ error: 'disposal_reason is required' });
    const userId = req.user?.id;
    const { data: unit } = await supabase.from('blood_units').select('id, status').eq('id', id).single();
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    await supabase.from('disposal_logs').insert({
      unit_id: id,
      disposal_reason: String(disposal_reason).trim(),
      disposal_date: new Date().toISOString().slice(0, 10),
      disposed_by: userId,
    });
    await supabase.from('blood_units').update({ status: 'disposed', updated_at: new Date().toISOString() }).eq('id', id);
    const { data: updated } = await supabase.from('blood_units').select('*').eq('id', id).single();
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_unit',
      resourceId: id,
      patientId: null,
      after: updated,
      before: { status: unit.status },
      req,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Disposal logs list. */
export async function getDisposalLogs(req, res) {
  try {
    const { data, error } = await supabase
      .from('disposal_logs')
      .select('id, unit_id, disposal_reason, disposal_date, disposed_by, created_at')
      .order('disposal_date', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Blood availability (for Doctor/ICU to view). */
export async function getBloodAvailability(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('blood_units')
      .select('blood_group, id')
      .eq('status', 'available')
      .gte('expiry_date', today);
    if (error) return res.status(500).json({ error: error.message });
    const byGroup = {};
    BLOOD_GROUPS.forEach((bg) => { byGroup[bg] = 0; });
    (data || []).forEach((u) => { byGroup[u.blood_group] = (byGroup[u.blood_group] || 0) + 1; });
    res.json(byGroup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ——— Blood donation requests (for volunteers) ———

/** List blood donation requests (open/closed). */
export async function getDonationRequests(req, res) {
  try {
    const { status } = req.query;
    let q = supabase
      .from('blood_donation_requests')
      .select('id, blood_group, quantity_required, location, urgency, status, created_by, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Create blood donation request. */
export async function createDonationRequest(req, res) {
  try {
    const userId = req.user?.id;
    const { blood_group, quantity_required, location, urgency } = req.body;
    if (!blood_group || !BLOOD_GROUPS.includes(blood_group)) {
      return res.status(400).json({ error: 'Valid blood_group is required' });
    }
    const qty = Math.max(1, parseInt(quantity_required, 10) || 1);
    const urg = ['High', 'Medium', 'Low'].includes(urgency) ? urgency : 'Medium';
    const { data, error } = await supabase
      .from('blood_donation_requests')
      .insert({
        blood_group,
        quantity_required: qty,
        location: location != null ? String(location).trim() : null,
        urgency: urg,
        status: 'open',
        created_by: userId,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'blood_donation_request',
      resourceId: data.id,
      patientId: null,
      after: data,
      req,
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Update blood donation request (e.g. close). */
export async function updateDonationRequest(req, res) {
  try {
    const { id } = req.params;
    const { status, location, urgency } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status === 'open' || status === 'closed') updates.status = status;
    if (location !== undefined) updates.location = String(location).trim() || null;
    if (urgency !== undefined && ['High', 'Medium', 'Low'].includes(urgency)) updates.urgency = urgency;
    const { data, error } = await supabase
      .from('blood_donation_requests')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Request not found' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'blood_donation_request',
      resourceId: id,
      patientId: null,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** List pledges (volunteer_donations) for a donation request. */
export async function getDonationRequestPledges(req, res) {
  try {
    const { id } = req.params;
    const { data: reqRow } = await supabase.from('blood_donation_requests').select('id').eq('id', id).single();
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    const { data: pledges, error } = await supabase
      .from('volunteer_donations')
      .select('id, volunteer_id, status, accepted_at, completed_at, notes, created_at')
      .eq('donation_request_id', id)
      .order('accepted_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const volunteerIds = [...new Set((pledges || []).map((p) => p.volunteer_id))];
    const { data: profiles } = volunteerIds.length
      ? await supabase.from('profiles').select('id, full_name, email, phone').in('id', volunteerIds)
      : { data: [] };
    const profileMap = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
    const list = (pledges || []).map((p) => ({
      ...p,
      volunteer: profileMap[p.volunteer_id] || null,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Mark a volunteer donation (pledge) as completed. */
export async function completeVolunteerDonation(req, res) {
  try {
    const { pledgeId } = req.params;
    const { notes } = req.body || {};
    const { data, error } = await supabase
      .from('volunteer_donations')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        notes: notes != null ? String(notes).trim() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pledgeId)
      .eq('status', 'pending')
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Pledge not found or already completed' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'volunteer_donation',
      resourceId: pledgeId,
      patientId: null,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
