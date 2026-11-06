/**
 * OPD visit workflow: check-in → triage → waiting → consultation → lab/pharmacy → billing → done.
 */
import { supabase } from '../config/supabase.js';
import { createEncounter, updateEncounterStatus } from './encounterService.js';
import { writeAuditLog } from './auditService.js';
import {
  evaluateUrgentVitals,
  computeBmi,
  normalizeOpdStatus,
} from './vitalsService.js';
import { bookAppointment } from './appointmentService.js';

const ALLOWED_STATUS = new Set([
  'check_in',
  'waiting',
  'triage',
  'triaged',
  'waiting_doctor',
  'in_consult',
  'in_consultation',
  'lab_pharmacy',
  'billing',
  'completed',
  'cancelled',
]);

async function nextTokenForDate(visitDate) {
  const { count } = await supabase
    .from('opd_visits')
    .select('id', { count: 'exact', head: true })
    .eq('visit_date', visitDate);
  return (count || 0) + 1;
}

function actorMeta(actor = {}) {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
  };
}

export async function listOpdQueue({ date = null, status = null, stage = null } = {}) {
  const vd = date || new Date().toISOString().slice(0, 10);
  let q = supabase
    .from('opd_visits')
    .select(
      '*, patient:profiles!opd_visits_patient_id_fkey(id, full_name, mrn, phone, sex, date_of_birth), doctor:profiles!opd_visits_doctor_id_fkey(id, full_name)'
    )
    .eq('visit_date', vd)
    .neq('status', 'cancelled');

  if (status) q = q.eq('status', status);
  if (stage) q = q.eq('stage', stage);

  const { data, error } = await q;
  if (error) {
    let q2 = supabase.from('opd_visits').select('*').eq('visit_date', vd).neq('status', 'cancelled');
    if (status) q2 = q2.eq('status', status);
    const fb = await q2;
    if (fb.error) throw fb.error;
    return sortQueue(fb.data || []);
  }
  return sortQueue(data || []);
}

/** Urgent first, then token ascending. */
function sortQueue(rows) {
  return [...rows].sort((a, b) => {
    const ua = a.is_urgent ? 1 : 0;
    const ub = b.is_urgent ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return (a.token_no || 0) - (b.token_no || 0);
  });
}

export async function checkInPatient({
  patientId,
  doctorId = null,
  appointmentId = null,
  visitDate = null,
  visitType = 'new',
  chiefComplaint = null,
  actor = {},
  req = null,
}) {
  if (!patientId) throw new Error('patientId is required');
  const vd = visitDate || new Date().toISOString().slice(0, 10);
  const token_no = await nextTokenForDate(vd);
  const now = new Date().toISOString();

  const payload = {
    patient_id: patientId,
    doctor_id: doctorId || null,
    appointment_id: appointmentId || null,
    visit_date: vd,
    token_no,
    visit_type: visitType === 'revisit' ? 'revisit' : 'new',
    chief_complaint: chiefComplaint || null,
    status: 'check_in',
    stage: 'check_in',
    checked_in_at: now,
    vitals: {},
    is_urgent: false,
    created_by: actor.id || null,
    updated_at: now,
  };

  const { data, error } = await supabase.from('opd_visits').insert(payload).select('*').single();
  if (error) throw error;

  let encounter = null;
  try {
    encounter = await createEncounter({
      patientId,
      module: 'opd',
      staffId: actor.id || null,
      dateTime: now,
      status: 'waiting',
      metadata: { token_no, visit_type: payload.visit_type },
      sourceTable: 'opd_visits',
      sourceId: data.id,
    });
    await supabase.from('opd_visits').update({ encounter_id: encounter.id }).eq('id', data.id);
    data.encounter_id = encounter.id;
  } catch (e) {
    console.warn('[opd] encounter write skipped:', e.message);
  }

  // Spec: Arrived auto when checked in — use explicit appointment_id, else today's booked/reminded
  try {
    const { updateAppointmentStatus } = await import('./appointmentService.js');
    let arriveId = appointmentId || null;
    if (!arriveId) {
      const dayStart = `${vd}T00:00:00.000Z`;
      const dayEnd = `${vd}T23:59:59.999Z`;
      const { data: todays } = await supabase
        .from('appointments')
        .select('id')
        .eq('patient_id', patientId)
        .in('hms_status', ['booked', 'reminded'])
        .gte('scheduled_at', dayStart)
        .lte('scheduled_at', dayEnd)
        .order('scheduled_at', { ascending: true })
        .limit(1);
      arriveId = todays?.[0]?.id || null;
    }
    if (arriveId) {
      await updateAppointmentStatus({
        id: arriveId,
        hmsStatus: 'arrived',
        actor,
        req,
      });
      data.appointment_id = arriveId;
      if (!appointmentId) {
        await supabase.from('opd_visits').update({ appointment_id: arriveId }).eq('id', data.id);
      }
    }
  } catch (e) {
    console.warn('[opd] appointment arrive skipped:', e.message);
  }

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'create',
    resourceType: 'opd_visit',
    resourceId: data.id,
    patientId,
    module: 'opd',
    after: data,
    req,
  });

  return data;
}

export async function updateOpdVisit({
  id,
  patch = {},
  actor = {},
  req = null,
}) {
  const { data: before } = await supabase.from('opd_visits').select('*').eq('id', id).single();
  if (!before) throw new Error('Visit not found');

  const allowed = [
    'doctor_id',
    'department_id',
    'chief_complaint',
    'triage_level',
    'vitals',
    'status',
    'stage',
    'notes',
    'history',
    'examination',
    'diagnosis',
    'diagnosis_icd10',
    'plan',
    'visit_type',
    'is_urgent',
  ];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (patch[k] !== undefined) updates[k] = patch[k];
  }

  if (updates.vitals) {
    const vitals = { ...(before.vitals || {}), ...updates.vitals };
    const bmi = computeBmi(vitals.weight, vitals.height);
    if (bmi != null) vitals.bmi = bmi;
    updates.vitals = vitals;
    const { urgent, reasons } = evaluateUrgentVitals(vitals);
    updates.is_urgent = urgent;
    if (urgent) {
      updates.triage_level = 'critical';
      updates.notes = [before.notes, `URGENT: ${reasons.join(', ')}`].filter(Boolean).join('\n');
    }
  }

  if (updates.status) {
    if (!ALLOWED_STATUS.has(updates.status)) {
      throw new Error(`Invalid OPD status: ${updates.status}`);
    }
    updates.status = normalizeOpdStatus(updates.status);
    updates.stage = updates.status;
  }

  const { data, error } = await supabase.from('opd_visits').update(updates).eq('id', id).select('*').single();
  if (error) throw error;

  // Re-sort: if urgent after triage, move toward waiting_doctor automatically
  if (data.is_urgent && ['triage', 'triaged', 'check_in', 'waiting'].includes(data.status)) {
    const { data: bumped } = await supabase
      .from('opd_visits')
      .update({
        status: 'waiting_doctor',
        stage: 'waiting_doctor',
        triage_level: 'critical',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (bumped) Object.assign(data, bumped);
  }

  if (before.encounter_id && updates.status) {
    const encMap = {
      check_in: 'waiting',
      waiting: 'waiting',
      triage: 'in_progress',
      waiting_doctor: 'waiting',
      in_consultation: 'in_progress',
      lab_pharmacy: 'in_progress',
      billing: 'in_progress',
      completed: 'done',
      cancelled: 'cancelled',
    };
    const encStatus = data.is_urgent ? 'urgent' : encMap[data.status] || 'in_progress';
    try {
      await updateEncounterStatus(before.encounter_id, encStatus, {
        opd_status: data.status,
        is_urgent: data.is_urgent,
      });
    } catch {
      /* ignore */
    }
  }

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'edit',
    resourceType: 'opd_visit',
    resourceId: id,
    patientId: data.patient_id,
    module: 'opd',
    before,
    after: data,
    req,
  });

  return data;
}

export async function bookFollowUpFromOpd({
  visitId,
  scheduledAt,
  doctorId = null,
  reason = null,
  actor = {},
  req = null,
}) {
  const { data: visit } = await supabase.from('opd_visits').select('*').eq('id', visitId).single();
  if (!visit) throw new Error('Visit not found');

  const appt = await bookAppointment({
    patientId: visit.patient_id,
    clinic: 'opd',
    doctorId: doctorId || visit.doctor_id,
    scheduledAt,
    reason: reason || 'OPD follow-up',
    sourceModule: 'opd',
    actor,
    req,
  });

  return appt;
}

export async function getOpdKpis(date = null) {
  const vd = date || new Date().toISOString().slice(0, 10);
  const rows = await listOpdQueue({ date: vd });
  const waitingTriage = rows.filter((r) =>
    ['check_in', 'waiting', 'triage', 'triaged'].includes(r.status)
  ).length;
  const waitingDoctor = rows.filter((r) =>
    ['waiting_doctor'].includes(r.status) || (r.status === 'waiting' && r.stage === 'waiting_doctor')
  ).length;
  const waits = rows
    .filter((r) => r.checked_in_at && r.status !== 'completed')
    .map((r) => (Date.now() - new Date(r.checked_in_at).getTime()) / 60000);
  const avgWait = waits.length
    ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length)
    : 0;
  return {
    visits_today: rows.length,
    waiting_triage: waitingTriage,
    waiting_doctor: waitingDoctor,
    average_wait_min: avgWait,
    urgent: rows.filter((r) => r.is_urgent && r.status !== 'completed').length,
  };
}
