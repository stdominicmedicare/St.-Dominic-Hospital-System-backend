/**
 * ICU module: bed availability, admission requests (approve/reject/assign), monitoring, discharge.
 * All operations scoped to ICU role; doctor creates admission requests.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';
import { createEncounter } from '../services/encounterService.js';
import { PATIENT_MIN_FIELDS, safeCreateEncounter } from '../services/patientProfileFields.js';

/** Get ICU dashboard: beds, stats, pending admission requests, critical alerts. */
export async function getDashboard(req, res) {
  try {
    const { data: beds, error: bedsError } = await supabase
      .from('icu_beds')
      .select('id, bed_number, bed_type, ward, floor, equipment_list, status, current_patient_id, admission_id')
      .order('bed_number');

    if (bedsError) return res.status(500).json({ error: bedsError.message });

    const list = beds || [];
    const totalBeds = list.length;
    const availableBeds = list.filter((b) => b.status === 'available').length;
    const occupiedBeds = list.filter((b) => b.status === 'occupied').length;
    const occupancyRate = totalBeds ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

    const { data: requests } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, doctor_id, request_status, priority_level, request_notes, created_at')
      .eq('request_status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

    const patientIds = [...new Set((requests || []).map((r) => r.patient_id).filter(Boolean))];
    const doctorIds = [...new Set((requests || []).map((r) => r.doctor_id).filter(Boolean))];
    const patientMap = {};
    const doctorMap = {};
    if (patientIds.length > 0) {
      const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds);
      (patients || []).forEach((p) => { patientMap[p.id] = p; });
    }
    if (doctorIds.length > 0) {
      const { data: doctors } = await supabase.from('profiles').select('id, full_name').in('id', doctorIds);
      (doctors || []).forEach((d) => { doctorMap[d.id] = d; });
    }

    const admissionRequestList = (requests || []).map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
      doctor: doctorMap[r.doctor_id] || null,
    }));

    const patientIdsInBeds = list.map((b) => b.current_patient_id).filter(Boolean);
    const { data: admissionRecords } = await supabase
      .from('icu_admission_records')
      .select('id, patient_id, bed_id, admission_time')
      .is('discharge_time', null);
    const admittedPatientIds = [...new Set((admissionRecords || []).map((r) => r.patient_id))];
    const allPatientIds = [...new Set([...patientIdsInBeds, ...admittedPatientIds])];
    const bedPatientMap = {};
    if (allPatientIds.length > 0) {
      const { data: bedPatients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', allPatientIds);
      (bedPatients || []).forEach((p) => { bedPatientMap[p.id] = p; });
    }
    const recordByBed = {};
    (admissionRecords || []).forEach((r) => { recordByBed[r.bed_id] = r; });

    const bedsWithPatient = list.map((bed) => {
      const record = recordByBed[bed.id];
      const patient = bed.current_patient_id ? bedPatientMap[bed.current_patient_id] : null;
      const admissionTime = record?.admission_time || null;
      return {
        ...bed,
        patient,
        admission_time: admissionTime,
      };
    });

    res.json({
      beds: bedsWithPatient,
      stats: {
        totalBeds,
        availableBeds,
        occupiedBeds,
        occupancyRate,
      },
      admissionRequests: admissionRequestList,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Update a bed's status (available, occupied, reserved, maintenance). Optionally clear patient. */
export async function updateBedStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['available', 'occupied', 'reserved', 'maintenance'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'status must be one of: available, occupied, reserved, maintenance' });
    }

    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'available' || status === 'maintenance' || status === 'reserved') {
      updates.current_patient_id = null;
      updates.admission_id = null;
    }

    const { data, error } = await supabase
      .from('icu_beds')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Bed not found' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'icu_bed',
      resourceId: id,
      patientId: data.current_patient_id || null,
      after: data,
      req,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** List admission requests (pending by default; optional status filter). */
export async function getAdmissionRequests(req, res) {
  try {
    const status = req.query.status || 'pending';
    const { data, error } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, doctor_id, request_status, priority_level, assigned_bed_id, request_notes, created_at, reviewed_at')
      .eq('request_status', status)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    const list = data || [];
    const patientIds = [...new Set(list.map((r) => r.patient_id).filter(Boolean))];
    const doctorIds = [...new Set(list.map((r) => r.doctor_id).filter(Boolean))];
    const patientMap = {};
    const doctorMap = {};
    if (patientIds.length > 0) {
      const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds);
      (patients || []).forEach((p) => { patientMap[p.id] = p; });
    }
    if (doctorIds.length > 0) {
      const { data: doctors } = await supabase.from('profiles').select('id, full_name').in('id', doctorIds);
      (doctors || []).forEach((d) => { doctorMap[d.id] = d; });
    }
    const bedIds = [...new Set(list.map((r) => r.assigned_bed_id).filter(Boolean))];
    let bedMap = {};
    if (bedIds.length > 0) {
      const { data: beds } = await supabase.from('icu_beds').select('id, bed_number').in('id', bedIds);
      (beds || []).forEach((b) => { bedMap[b.id] = b; });
    }
    res.json(list.map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
      doctor: doctorMap[r.doctor_id] || null,
      bed: r.assigned_bed_id ? bedMap[r.assigned_bed_id] || null : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Approve admission request and optionally assign bed (assign bed = admit patient). */
export async function approveRequest(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { assigned_bed_id } = req.body;

    const { data: reqRow, error: fetchErr } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, request_status')
      .eq('id', id)
      .single();
    if (fetchErr || !reqRow) return res.status(404).json({ error: 'Request not found' });
    if (reqRow.request_status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const updatePayload = {
      request_status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (assigned_bed_id) updatePayload.assigned_bed_id = assigned_bed_id;

    const { data: updated, error: updateErr } = await supabase
      .from('icu_admission_requests')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    if (assigned_bed_id) {
      const { error: bedErr } = await supabase
        .from('icu_beds')
        .update({
          status: 'occupied',
          current_patient_id: reqRow.patient_id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', assigned_bed_id);
      if (bedErr) return res.status(500).json({ error: bedErr.message });

      const { data: admissionRecord, error: recErr } = await supabase
        .from('icu_admission_records')
        .insert({
          patient_id: reqRow.patient_id,
          bed_id: assigned_bed_id,
          request_id: id,
          admission_time: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (recErr) return res.status(500).json({ error: recErr.message });

      await supabase
        .from('icu_beds')
        .update({ admission_id: admissionRecord?.id, updated_at: new Date().toISOString() })
        .eq('id', assigned_bed_id);

      await safeCreateEncounter(createEncounter, {
        patientId: reqRow.patient_id,
        module: 'icu',
        staffId: userId,
        status: 'in_progress',
        metadata: { kind: 'admission', bed_id: assigned_bed_id },
        sourceTable: 'icu_admission_records',
        sourceId: admissionRecord?.id,
      });
    }

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'icu_admission_request',
      resourceId: id,
      patientId: reqRow.patient_id,
      after: updated,
      before: { request_status: reqRow.request_status },
      req,
      module: 'icu',
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Reject admission request. */
export async function rejectRequest(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('icu_admission_requests')
      .update({
        request_status: 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('request_status', 'pending')
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Request not found or already processed' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'icu_admission_request',
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

/** Assign bed to an approved request (admit patient) – if not already assigned during approve. */
export async function assignBed(req, res) {
  try {
    const { id } = req.params;
    const { assigned_bed_id } = req.body;
    if (!assigned_bed_id) return res.status(400).json({ error: 'assigned_bed_id required' });

    const { data: reqRow, error: fetchErr } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, request_status, assigned_bed_id')
      .eq('id', id)
      .single();
    if (fetchErr || !reqRow) return res.status(404).json({ error: 'Request not found' });
    if (reqRow.request_status !== 'approved') return res.status(400).json({ error: 'Request must be approved first' });
    if (reqRow.assigned_bed_id) return res.status(400).json({ error: 'Bed already assigned' });

    const { data: bed } = await supabase.from('icu_beds').select('id, status').eq('id', assigned_bed_id).single();
    if (!bed || bed.status !== 'available') return res.status(400).json({ error: 'Bed not available' });

    const { data: admissionRecord, error: recErr } = await supabase
      .from('icu_admission_records')
      .insert({
        patient_id: reqRow.patient_id,
        bed_id: assigned_bed_id,
        request_id: id,
        admission_time: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (recErr) return res.status(500).json({ error: recErr.message });

    await supabase
      .from('icu_beds')
      .update({
        status: 'occupied',
        current_patient_id: reqRow.patient_id,
        admission_id: admissionRecord?.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', assigned_bed_id);

    const { data: updated } = await supabase
      .from('icu_admission_requests')
      .update({ assigned_bed_id, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    await safeCreateEncounter(createEncounter, {
      patientId: reqRow.patient_id,
      module: 'icu',
      staffId: req.user?.id,
      status: 'in_progress',
      metadata: { kind: 'admission', bed_id: assigned_bed_id },
      sourceTable: 'icu_admission_records',
      sourceId: admissionRecord?.id,
    });

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'icu_admission_request',
      module: 'icu',
      resourceId: id,
      patientId: reqRow.patient_id,
      after: updated || { ok: true, assigned_bed_id },
      req,
    });
    res.json(updated || { ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const ACTIVE_TRIP_STATUSES = ['en_route', 'arrived', 'patient_picked', 'arrived_at_hospital'];

/** Get incoming patients: approved ICU admission requests with an active ambulance trip (for live tracking). */
export async function getIncomingPatients(req, res) {
  try {
    const { data: approvedRequests } = await supabase
      .from('icu_admission_requests')
      .select('id, patient_id, doctor_id, priority_level, request_notes, assigned_bed_id, created_at')
      .eq('request_status', 'approved')
      .order('created_at', { ascending: false });

    if (!approvedRequests?.length) return res.json([]);

    const patientIds = [...new Set(approvedRequests.map((r) => r.patient_id))];
    const { data: trips } = await supabase
      .from('ambulance_requests')
      .select('id, patient_id, from_address, to_address, status, assigned_driver_id, ambulance_id, requested_at')
      .in('patient_id', patientIds)
      .in('status', ACTIVE_TRIP_STATUSES)
      .order('requested_at', { ascending: false });

    if (!trips?.length) return res.json([]);

    const tripByPatient = {};
    trips.forEach((t) => { tripByPatient[t.patient_id] = t; });
    const requestByPatient = {};
    approvedRequests.forEach((r) => { requestByPatient[r.patient_id] = r; });

    const patientIdsInTrip = [...new Set(trips.map((t) => t.patient_id))];
    const doctorIds = [...new Set(approvedRequests.map((r) => r.doctor_id).filter(Boolean))];
    const driverIds = [...new Set(trips.map((t) => t.assigned_driver_id).filter(Boolean))];
    const ambulanceIds = [...new Set(trips.map((t) => t.ambulance_id).filter(Boolean))];

    const [patientsRes, doctorsRes, driversRes, ambulancesRes] = await Promise.all([
      patientIdsInTrip.length ? supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIdsInTrip) : { data: [] },
      doctorIds.length ? supabase.from('profiles').select('id, full_name').in('id', doctorIds) : { data: [] },
      driverIds.length ? supabase.from('profiles').select('id, full_name, phone').in('id', driverIds) : { data: [] },
      ambulanceIds.length ? supabase.from('ambulances').select('id, vehicle_number').in('id', ambulanceIds) : { data: [] },
    ]);
    const patientMap = Object.fromEntries((patientsRes.data || []).map((p) => [p.id, p]));
    const doctorMap = Object.fromEntries((doctorsRes.data || []).map((d) => [d.id, d]));
    const driverMap = Object.fromEntries((driversRes.data || []).map((d) => [d.id, d]));
    const ambulanceMap = Object.fromEntries((ambulancesRes.data || []).map((a) => [a.id, a]));

    const list = trips.map((trip) => {
      const request = requestByPatient[trip.patient_id];
      const patient = patientMap[trip.patient_id] || null;
      const doctor = request ? doctorMap[request.doctor_id] || null : null;
      const driver = trip.assigned_driver_id ? driverMap[trip.assigned_driver_id] || null : null;
      const ambulance = trip.ambulance_id ? ambulanceMap[trip.ambulance_id] || null : null;
      return {
        ...trip,
        patient,
        doctor,
        driver: driver ? { id: driver.id, full_name: driver.full_name, phone: driver.phone } : null,
        ambulance: ambulance ? { id: ambulance.id, vehicle_number: ambulance.vehicle_number } : null,
        icu_request: request ? { id: request.id, priority_level: request.priority_level, request_notes: request.request_notes, assigned_bed_id: request.assigned_bed_id } : null,
      };
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get active ICU patients (occupied beds + admission record) for monitoring list. */
export async function getActivePatients(req, res) {
  try {
    const { data: records } = await supabase
      .from('icu_admission_records')
      .select('id, patient_id, bed_id, admission_time')
      .is('discharge_time', null)
      .order('admission_time', { ascending: false });

    if (!records?.length) return res.json([]);

    const bedIds = [...new Set(records.map((r) => r.bed_id))];
    const patientIds = [...new Set(records.map((r) => r.patient_id))];
    const { data: beds } = await supabase.from('icu_beds').select('id, bed_number, bed_type, ward, floor').in('id', bedIds);
    const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds);
    const bedMap = Object.fromEntries((beds || []).map((b) => [b.id, b]));
    const patientMap = Object.fromEntries((patients || []).map((p) => [p.id, p]));

    const list = records.map((r) => ({
      ...r,
      bed: bedMap[r.bed_id] || null,
      patient: patientMap[r.patient_id] || null,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get monitoring logs for a patient (or for an admission record). */
export async function getMonitoringLogs(req, res) {
  try {
    const { patientId, admissionRecordId } = req.query;
    if (!patientId && !admissionRecordId) return res.status(400).json({ error: 'patientId or admissionRecordId required' });

    let query = supabase
      .from('icu_patient_monitoring')
      .select('id, patient_id, bed_id, vital_signs, observation_notes, condition_status, recorded_by, recorded_at')
      .order('recorded_at', { ascending: false })
      .limit(100);
    if (patientId) query = query.eq('patient_id', patientId);
    if (admissionRecordId) query = query.eq('admission_record_id', admissionRecordId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Add a monitoring log (vitals, notes, condition). */
export async function addMonitoringLog(req, res) {
  try {
    const userId = req.user.id;
    const { patient_id, bed_id, admission_record_id, vital_signs, observation_notes, condition_status } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id required' });

    const payload = {
      patient_id,
      recorded_by: userId,
      recorded_at: new Date().toISOString(),
      vital_signs: vital_signs || {},
      observation_notes: observation_notes != null ? String(observation_notes) : null,
      condition_status: ['stable', 'critical', 'improving', 'emergency'].includes(condition_status) ? condition_status : null,
    };
    if (bed_id) payload.bed_id = bed_id;
    if (admission_record_id) payload.admission_record_id = admission_record_id;

    const { data, error } = await supabase.from('icu_patient_monitoring').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'icu_patient_monitoring',
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

/** Discharge patient: set discharge_time on admission record, free the bed. */
export async function dischargePatient(req, res) {
  try {
    const { id } = req.params;
    const { discharge_reason, final_status } = req.body;

    const { data: record, error: fetchErr } = await supabase
      .from('icu_admission_records')
      .select('id, patient_id, bed_id')
      .eq('id', id)
      .is('discharge_time', null)
      .single();
    if (fetchErr || !record) return res.status(404).json({ error: 'Admission record not found or already discharged' });

    const now = new Date().toISOString();
    const { error: updateRecErr } = await supabase
      .from('icu_admission_records')
      .update({
        discharge_time: now,
        discharge_reason: discharge_reason != null ? String(discharge_reason) : null,
        final_status: final_status != null ? String(final_status) : null,
        updated_at: now,
      })
      .eq('id', id);
    if (updateRecErr) return res.status(500).json({ error: updateRecErr.message });

    await supabase
      .from('icu_beds')
      .update({
        status: 'available',
        current_patient_id: null,
        admission_id: null,
        updated_at: now,
      })
      .eq('id', record.bed_id);

    await safeCreateEncounter(createEncounter, {
      patientId: record.patient_id,
      module: 'icu',
      staffId: req.user?.id,
      status: 'done',
      metadata: { kind: 'discharge', discharge_reason, final_status },
      sourceTable: 'icu_admission_records',
      sourceId: id,
    });

    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'icu_admission_record',
      resourceId: id,
      patientId: record.patient_id,
      after: { ok: true, discharge_time: now, discharge_reason, final_status },
      before: record,
      req,
      module: 'icu',
    });
    res.json({ ok: true, discharge_time: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Transfer patient to another bed. */
export async function transferBed(req, res) {
  try {
    const { id } = req.params;
    const { new_bed_id } = req.body;
    if (!new_bed_id) return res.status(400).json({ error: 'new_bed_id required' });

    const { data: record, error: fetchErr } = await supabase
      .from('icu_admission_records')
      .select('id, patient_id, bed_id')
      .eq('id', id)
      .is('discharge_time', null)
      .single();
    if (fetchErr || !record) return res.status(404).json({ error: 'Admission record not found or already discharged' });
    if (record.bed_id === new_bed_id) return res.status(400).json({ error: 'Patient already in this bed' });

    const { data: newBed } = await supabase.from('icu_beds').select('id, status').eq('id', new_bed_id).single();
    if (!newBed || newBed.status !== 'available') return res.status(400).json({ error: 'Target bed not available' });

    const now = new Date().toISOString();
    await supabase.from('icu_beds').update({ status: 'available', current_patient_id: null, admission_id: null, updated_at: now }).eq('id', record.bed_id);
    await supabase.from('icu_beds').update({ status: 'occupied', current_patient_id: record.patient_id, admission_id: id, updated_at: now }).eq('id', new_bed_id);
    const { error: updateRecErr } = await supabase.from('icu_admission_records').update({ bed_id: new_bed_id, updated_at: now }).eq('id', id);
    if (updateRecErr) return res.status(500).json({ error: updateRecErr.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'edit',
      resourceType: 'icu_admission_record',
      resourceId: id,
      patientId: record.patient_id,
      after: { ok: true, new_bed_id },
      before: { bed_id: record.bed_id },
      req,
    });
    res.json({ ok: true, new_bed_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Request ambulance transfer for an ICU patient (e.g. to another hospital). */
export async function requestAmbulanceTransfer(req, res) {
  try {
    const { patient_id, to_address, priority } = req.body;
    if (!patient_id || !to_address) return res.status(400).json({ error: 'patient_id and to_address required' });

    const pr = ['High', 'Medium', 'Low'].includes(priority) ? priority : 'High';
    const { data, error } = await supabase
      .from('ambulance_requests')
      .insert({
        patient_id,
        from_address: 'Hospital ICU',
        to_address: String(to_address).trim(),
        priority: pr,
        status: 'pending',
        notes: 'Requested by ICU staff',
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
      resourceType: 'ambulance_request',
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

/** ICU history: discharged admission records with optional filters. */
export async function getHistory(req, res) {
  try {
    const { data, error } = await supabase
      .from('icu_admission_records')
      .select('id, patient_id, bed_id, admission_time, discharge_time, discharge_reason, final_status, request_id')
      .not('discharge_time', 'is', null)
      .order('discharge_time', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    const list = data || [];
    const patientIds = [...new Set(list.map((r) => r.patient_id))];
    const bedIds = [...new Set(list.map((r) => r.bed_id))];
    const patientMap = {};
    const bedMap = {};
    if (patientIds.length > 0) {
      const { data: patients } = await supabase.from('profiles').select(PATIENT_MIN_FIELDS).in('id', patientIds);
      (patients || []).forEach((p) => { patientMap[p.id] = p; });
    }
    if (bedIds.length > 0) {
      const { data: beds } = await supabase.from('icu_beds').select('id, bed_number, bed_type').in('id', bedIds);
      (beds || []).forEach((b) => { bedMap[b.id] = b; });
    }
    res.json(list.map((r) => ({
      ...r,
      patient: patientMap[r.patient_id] || null,
      bed: bedMap[r.bed_id] || null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

/** Create emergency blood request (ICU). Uses ICU staff as doctor_id (requester). */
export async function createBloodRequest(req, res) {
  try {
    const requesterId = req.user.id;
    const { patient_id, blood_group_required, units_required, medical_reason } = req.body;
    if (!patient_id || !blood_group_required || !units_required) {
      return res.status(400).json({ error: 'patient_id, blood_group_required, and units_required are required' });
    }
    if (!BLOOD_GROUPS.includes(blood_group_required)) return res.status(400).json({ error: 'Invalid blood_group_required' });
    const units = Math.max(1, parseInt(units_required, 10) || 1);
    const { data, error } = await supabase
      .from('blood_requests')
      .insert({
        patient_id,
        doctor_id: requesterId,
        blood_group_required,
        units_required: units,
        urgency_level: 'emergency',
        medical_reason: medical_reason != null ? String(medical_reason).trim() : null,
        request_status: 'pending',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'blood_request',
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
