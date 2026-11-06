/**
 * Doctor API: patients, appointments (accept/reject), medical records, prescriptions. Scoped to req.user.id (doctor_id).
 * Phase 6: shared MRN on patient projections + encounter rows for Home/Reports.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';
import { createEncounter } from '../services/encounterService.js';
import { PATIENT_MIN_FIELDS, safeCreateEncounter } from '../services/patientProfileFields.js';

export async function getPatients(req, res) {
  try {
    const doctorId = req.user.id;
    const [appointmentsRes, recordsRes] = await Promise.all([
      supabase.from('appointments').select('patient_id').eq('doctor_id', doctorId),
      supabase.from('medical_records').select('patient_id').eq('doctor_id', doctorId),
    ]);
    const fromApts = (appointmentsRes.data || []).map((a) => a.patient_id);
    const fromRecords = (recordsRes.data || []).map((r) => r.patient_id);
    const patientIds = [...new Set([...fromApts, ...fromRecords])];
    if (patientIds.length === 0) return res.json([]);
    const { data, error } = await supabase
      .from('profiles')
      .select(PATIENT_MIN_FIELDS)
      .in('id', patientIds)
      .order('full_name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getAppointments(req, res) {
  try {
    const doctorId = req.user.id;
    const { data: rows, error } = await supabase
      .from('appointments')
      .select('id, scheduled_at, status, notes, created_at, patient_id')
      .eq('doctor_id', doctorId)
      .order('scheduled_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    const patientIds = [...new Set((rows || []).map((r) => r.patient_id).filter(Boolean))];
    const patients =
      patientIds.length > 0
        ? await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds)
        : { data: [] };
    const patientMap = Object.fromEntries((patients.data || []).map((p) => [p.id, p]));
    const data = (rows || []).map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateAppointmentStatus(req, res) {
  try {
    const doctorId = req.user.id;
    const { id } = req.params;
    const { status, notes } = req.body;
    if (!['confirmed', 'cancelled', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'status must be confirmed, cancelled, or completed' });
    }
    const payload = { status, updated_at: new Date().toISOString() };
    if (notes != null && String(notes).trim() !== '') payload.notes = String(notes).trim();
    const { data, error } = await supabase
      .from('appointments')
      .update(payload)
      .eq('id', id)
      .eq('doctor_id', doctorId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Appointment not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getRecords(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id } = req.query;
    let q = supabase
      .from('medical_records')
      .select('id, patient_id, diagnosis, notes, observations, created_at, updated_at')
      .eq('doctor_id', doctorId)
      .order('created_at', { ascending: false });
    if (patient_id) q = q.eq('patient_id', patient_id);
    const { data: rows, error } = await q;

    if (error) return res.status(500).json({ error: error.message });
    const patientIds = [...new Set((rows || []).map((r) => r.patient_id).filter(Boolean))];
    const patients =
      patientIds.length > 0
        ? await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds)
        : { data: [] };
    const patientMap = Object.fromEntries((patients.data || []).map((p) => [p.id, p]));
    const data = (rows || []).map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
    }));

    await writeAuditLog({
      actorId: doctorId,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'medical_record',
      patientId: patient_id || null,
      metadata: { count: data.length, scoped: 'doctor' },
      req,
      module: 'doctor',
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createRecord(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id, appointment_id, diagnosis, notes, observations } = req.body;
    if (!patient_id) {
      return res.status(400).json({ error: 'patient_id is required' });
    }
    const { data, error } = await supabase
      .from('medical_records')
      .insert({
        patient_id,
        doctor_id: doctorId,
        appointment_id: appointment_id || null,
        diagnosis: diagnosis || null,
        notes: notes || null,
        observations: observations || null,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await safeCreateEncounter(createEncounter, {
      patientId: patient_id,
      module: 'doctor',
      staffId: doctorId,
      status: 'done',
      metadata: { kind: 'medical_record', diagnosis: diagnosis || null },
      sourceTable: 'medical_records',
      sourceId: data.id,
    });

    await writeAuditLog({
      actorId: doctorId,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'medical_record',
      resourceId: data.id,
      patientId: patient_id,
      after: data,
      req,
      module: 'doctor',
    });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateRecord(req, res) {
  try {
    const doctorId = req.user.id;
    const { id } = req.params;
    const { diagnosis, notes, observations } = req.body;

    const { data: before, error: findErr } = await supabase
      .from('medical_records')
      .select('*')
      .eq('id', id)
      .eq('doctor_id', doctorId)
      .single();
    if (findErr || !before) return res.status(404).json({ error: 'Record not found' });

    const updates = { updated_at: new Date().toISOString() };
    if (diagnosis !== undefined) updates.diagnosis = diagnosis;
    if (notes !== undefined) updates.notes = notes;
    if (observations !== undefined) updates.observations = observations;

    const { data, error } = await supabase
      .from('medical_records')
      .update(updates)
      .eq('id', id)
      .eq('doctor_id', doctorId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await writeAuditLog({
      actorId: doctorId,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'medical_record',
      resourceId: id,
      patientId: before.patient_id,
      before,
      after: data,
      req,
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function deleteRecord(req, res) {
  try {
    const doctorId = req.user.id;
    const { id } = req.params;

    const { data: before, error: findErr } = await supabase
      .from('medical_records')
      .select('*')
      .eq('id', id)
      .eq('doctor_id', doctorId)
      .single();
    if (findErr || !before) return res.status(404).json({ error: 'Record not found' });

    const { error } = await supabase
      .from('medical_records')
      .delete()
      .eq('id', id)
      .eq('doctor_id', doctorId);

    if (error) return res.status(500).json({ error: error.message });

    await writeAuditLog({
      actorId: doctorId,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'delete',
      resourceType: 'medical_record',
      resourceId: id,
      patientId: before.patient_id,
      before,
      req,
    });

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getPrescriptions(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id } = req.query;
    let q = supabase
      .from('prescriptions')
      .select('id, patient_id, medication, dosage, instructions, frequency, duration, medical_record_id, status, created_at')
      .eq('doctor_id', doctorId)
      .order('created_at', { ascending: false });
    if (patient_id) q = q.eq('patient_id', patient_id);
    const { data: rows, error } = await q;

    if (error) return res.status(500).json({ error: error.message });
    const patientIds = [...new Set((rows || []).map((r) => r.patient_id).filter(Boolean))];
    const patients =
      patientIds.length > 0
        ? await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds)
        : { data: [] };
    const patientMap = Object.fromEntries((patients.data || []).map((p) => [p.id, p]));
    const data = (rows || []).map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function createPrescription(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id, medication, dosage, instructions, frequency, duration, medical_record_id } = req.body;
    if (!patient_id || !medication) {
      return res.status(400).json({ error: 'patient_id and medication are required' });
    }
    const { data, error } = await supabase
      .from('prescriptions')
      .insert({
        patient_id,
        doctor_id: doctorId,
        medication,
        dosage: dosage || null,
        instructions: instructions || null,
        frequency: frequency || null,
        duration: duration || null,
        medical_record_id: medical_record_id || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await safeCreateEncounter(createEncounter, {
      patientId: patient_id,
      module: 'doctor',
      staffId: doctorId,
      status: 'done',
      metadata: { kind: 'prescription', medication },
      sourceTable: 'prescriptions',
      sourceId: data.id,
    });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Create ambulance request for a patient (doctor-initiated). ICU uses requestIcuAdmission. */
export async function createEmergencyRequest(req, res) {
  try {
    const doctorId = req.user.id;
    const { type, patient_id, from_address, to_address, priority } = req.body || {};
    if (!['icu', 'ambulance'].includes(type)) {
      return res.status(400).json({ error: 'type must be icu or ambulance' });
    }
    if (type === 'icu') {
      return res.status(400).json({ error: 'Use POST /api/doctor/icu-admission-request for ICU admission' });
    }
    if (!patient_id || !from_address || !to_address) {
      return res.status(400).json({
        error: 'patient_id, from_address, and to_address are required for ambulance requests',
      });
    }

    const { data: patient } = await supabase
      .from('profiles')
      .select('id, role, full_name')
      .eq('id', patient_id)
      .eq('role', 'Patient')
      .single();
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const pr = ['High', 'Medium', 'Low'].includes(priority) ? priority : 'High';
    const { data, error } = await supabase
      .from('ambulance_requests')
      .insert({
        patient_id,
        from_address: String(from_address).trim(),
        to_address: String(to_address).trim(),
        priority: pr,
        status: 'pending',
        notes: `Requested by doctor ${doctorId}`,
      })
      .select()
      .single();

    if (error) {
      // notes column may not exist on older schemas — retry without it
      if (String(error.message || '').toLowerCase().includes('notes')) {
        const retry = await supabase
          .from('ambulance_requests')
          .insert({
            patient_id,
            from_address: String(from_address).trim(),
            to_address: String(to_address).trim(),
            priority: pr,
            status: 'pending',
          })
          .select()
          .single();
        if (retry.error) return res.status(400).json({ error: retry.error.message });
        await safeCreateEncounter(createEncounter, {
          patientId: patient_id,
          module: 'ambulance',
          staffId: doctorId,
          status: 'waiting',
          metadata: { kind: 'doctor_request', priority: pr },
          sourceTable: 'ambulance_requests',
          sourceId: retry.data.id,
        });
        await writeAuditLog({
          actorId: doctorId,
          actorEmail: req.user?.email,
          actorRole: req.role,
          action: 'create',
          resourceType: 'ambulance_request',
          resourceId: retry.data.id,
          patientId: patient_id,
          after: retry.data,
          metadata: { source: 'doctor_emergency' },
          req,
          module: 'ambulance',
        });
        return res.status(201).json(retry.data);
      }
      return res.status(400).json({ error: error.message });
    }

    await safeCreateEncounter(createEncounter, {
      patientId: patient_id,
      module: 'ambulance',
      staffId: doctorId,
      status: 'waiting',
      metadata: { kind: 'doctor_request', priority: pr },
      sourceTable: 'ambulance_requests',
      sourceId: data.id,
    });
    await writeAuditLog({
      actorId: doctorId,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'ambulance_request',
      resourceId: data.id,
      patientId: patient_id,
      after: data,
      metadata: { source: 'doctor_emergency' },
      req,
      module: 'ambulance',
    });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Request ICU admission for a patient. Creates pending request for ICU to approve/reject. */
export async function requestIcuAdmission(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id, priority_level, request_notes } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

    const priority = ['low', 'medium', 'high', 'critical'].includes(priority_level) ? priority_level : 'medium';
    const { data, error } = await supabase
      .from('icu_admission_requests')
      .insert({
        patient_id,
        doctor_id: doctorId,
        request_status: 'pending',
        priority_level: priority,
        request_notes: request_notes != null ? String(request_notes).trim() : null,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await safeCreateEncounter(createEncounter, {
      patientId: patient_id,
      module: 'icu',
      staffId: doctorId,
      status: 'waiting',
      metadata: { kind: 'admission_request', priority },
      sourceTable: 'icu_admission_requests',
      sourceId: data.id,
    });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const ACTIVE_TRIP_STATUSES = ['en_route', 'arrived', 'patient_picked', 'arrived_at_hospital'];

/** Get transfer trips: active ambulance trips for patients this doctor requested ICU admission for (for tracking). */
export async function getTransferTrips(req, res) {
  try {
    const doctorId = req.user.id;
    const { data: myRequests } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, request_status, priority_level, request_notes, assigned_bed_id, created_at')
      .eq('doctor_id', doctorId)
      .order('created_at', { ascending: false });

    if (!myRequests?.length) return res.json([]);

    const patientIds = [...new Set(myRequests.map((r) => r.patient_id))];
    const { data: trips } = await supabase
      .from('ambulance_requests')
      .select('id, patient_id, from_address, to_address, status, assigned_driver_id, ambulance_id, requested_at')
      .in('patient_id', patientIds)
      .in('status', ACTIVE_TRIP_STATUSES)
      .order('requested_at', { ascending: false });

    if (!trips?.length) return res.json([]);

    const requestByPatient = {};
    myRequests.forEach((r) => { requestByPatient[r.patient_id] = r; });
    const patientIdsInTrip = [...new Set(trips.map((t) => t.patient_id))];
    const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIdsInTrip);
    const patientMap = Object.fromEntries((patients || []).map((p) => [p.id, p]));

    const list = trips.map((trip) => ({
      ...trip,
      patient: patientMap[trip.patient_id] || null,
      icu_request: requestByPatient[trip.patient_id] || null,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** List ICU admission requests created by this doctor (for View ICU Patient Progress). */
export async function getMyIcuRequests(req, res) {
  try {
    const doctorId = req.user.id;
    const { data: requests, error } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, doctor_id, request_status, priority_level, request_notes, assigned_bed_id, created_at, reviewed_at')
      .eq('doctor_id', doctorId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    const list = requests || [];
    const patientIds = [...new Set(list.map((r) => r.patient_id))];
    const bedIds = [...new Set(list.map((r) => r.assigned_bed_id).filter(Boolean))];
    const patientMap = {};
    const bedMap = {};
    if (patientIds.length > 0) {
      const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds);
      (patients || []).forEach((p) => { patientMap[p.id] = p; });
    }
    if (bedIds.length > 0) {
      const { data: beds } = await supabase.from('icu_beds').select('id, bed_number').in('id', bedIds);
      (beds || []).forEach((b) => { bedMap[b.id] = b; });
    }
    const withDetails = list.map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
      bed: r.assigned_bed_id ? bedMap[r.assigned_bed_id] || null : null,
    }));
    res.json(withDetails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get read-only ICU monitoring for a patient – only if this doctor requested ICU for that patient. */
export async function getIcuMonitoringForPatient(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id } = req.query;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });

    const { data: reqRow } = await supabase
      .from('icu_admission_requests')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('patient_id', patient_id)
      .maybeSingle();
    if (!reqRow) return res.status(403).json({ error: 'Not authorized to view this patient ICU data' });

    const { data: logs, error } = await supabase
      .from('icu_patient_monitoring')
      .select('id, vital_signs, observation_notes, condition_status, recorded_at')
      .eq('patient_id', patient_id)
      .order('recorded_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(logs || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

/** Create blood request for a patient (Doctor). */
export async function createBloodRequest(req, res) {
  try {
    const doctorId = req.user.id;
    const { patient_id, blood_group_required, units_required, urgency_level, medical_reason } = req.body;
    if (!patient_id || !blood_group_required || !units_required) {
      return res.status(400).json({ error: 'patient_id, blood_group_required, and units_required are required' });
    }
    if (!BLOOD_GROUPS.includes(blood_group_required)) return res.status(400).json({ error: 'Invalid blood_group_required' });
    const units = Math.max(1, parseInt(units_required, 10) || 1);
    const urgency = ['routine', 'urgent', 'emergency'].includes(urgency_level) ? urgency_level : 'routine';
    const { data, error } = await supabase
      .from('blood_requests')
      .insert({
        patient_id,
        doctor_id: doctorId,
        blood_group_required,
        units_required: units,
        urgency_level: urgency,
        medical_reason: medical_reason != null ? String(medical_reason).trim() : null,
        request_status: 'pending',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await safeCreateEncounter(createEncounter, {
      patientId: patient_id,
      module: 'bloodbank',
      staffId: doctorId,
      status: urgency === 'emergency' ? 'urgent' : 'waiting',
      metadata: { kind: 'blood_request', blood_group_required, units },
      sourceTable: 'blood_requests',
      sourceId: data.id,
    });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
