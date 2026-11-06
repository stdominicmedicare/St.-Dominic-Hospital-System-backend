/**
 * Shared appointment booking for OPD + ANC/PNC/Immunization/FP/HIV.
 * Other modules should call bookAppointment() rather than inserting directly.
 */
import { supabase } from '../config/supabase.js';
import { createEncounter, updateEncounterStatus } from './encounterService.js';
import { writeAuditLog } from './auditService.js';

export const CLINICS = ['opd', 'anc', 'pnc', 'immunization', 'fp', 'hiv'];
export const HMS_STATUSES = ['booked', 'reminded', 'arrived', 'seen', 'missed'];

const LEGACY_STATUS = {
  booked: 'pending',
  reminded: 'confirmed',
  arrived: 'confirmed',
  seen: 'completed',
  missed: 'cancelled',
};

function actorMeta(actor = {}) {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
  };
}

/**
 * Prevent double-book: same doctor_id + slot_start with active hms_status.
 */
export async function assertSlotFree({ doctorId, slotStart, excludeId = null }) {
  if (!doctorId || !slotStart) return;
  let q = supabase
    .from('appointments')
    .select('id, patient_id, hms_status')
    .eq('doctor_id', doctorId)
    .eq('slot_start', slotStart)
    .in('hms_status', ['booked', 'reminded', 'arrived'])
    .limit(1);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  if (error) throw error;
  if (data?.length) {
    const err = new Error('That provider slot is already booked');
    err.code = 'DOUBLE_BOOK';
    err.conflict = data[0];
    throw err;
  }
}

/**
 * @param {object} input
 */
export async function bookAppointment({
  patientId,
  clinic = 'opd',
  doctorId = null,
  scheduledAt,
  slotStart = null,
  slotEnd = null,
  reason = null,
  reminderPhone = null,
  reminderSms = false,
  notes = null,
  sourceModule = null,
  actor = {},
  req = null,
}) {
  if (!patientId) throw new Error('patientId is required');
  if (!CLINICS.includes(clinic)) throw new Error(`Invalid clinic: ${clinic}`);
  const when = slotStart || scheduledAt;
  if (!when) throw new Error('scheduledAt / slotStart is required');

  const slot = new Date(when).toISOString();
  await assertSlotFree({ doctorId, slotStart: slot });

  const payload = {
    patient_id: patientId,
    doctor_id: doctorId || null,
    scheduled_at: slot,
    slot_start: slot,
    slot_end: slotEnd ? new Date(slotEnd).toISOString() : null,
    clinic,
    hms_status: 'booked',
    status: LEGACY_STATUS.booked,
    reason: reason || null,
    notes: notes || null,
    reminder_phone: reminderPhone || null,
    reminder_sms: Boolean(reminderSms),
    source_module: sourceModule || clinic,
    created_by: actor.id || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from('appointments').insert(payload).select('*').single();
  if (error) {
    if (error.code === '23505') {
      const err = new Error('That provider slot is already booked');
      err.code = 'DOUBLE_BOOK';
      throw err;
    }
    throw error;
  }

  let encounter = null;
  try {
    encounter = await createEncounter({
      patientId,
      module: 'appointments',
      staffId: actor.id || null,
      dateTime: slot,
      status: 'waiting',
      metadata: { clinic, appointment_id: data.id, reason },
      sourceTable: 'appointments',
      sourceId: data.id,
    });
    await supabase
      .from('appointments')
      .update({ encounter_id: encounter.id })
      .eq('id', data.id);
    data.encounter_id = encounter.id;
  } catch (e) {
    console.warn('[appointments] encounter write skipped:', e.message);
  }

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'create',
    resourceType: 'appointment',
    resourceId: data.id,
    patientId,
    module: 'appointments',
    after: data,
    req,
  });

  return data;
}

export async function updateAppointmentStatus({
  id,
  hmsStatus,
  actor = {},
  req = null,
  patch = {},
}) {
  if (!HMS_STATUSES.includes(hmsStatus)) {
    throw new Error(`Invalid hms_status: ${hmsStatus}`);
  }
  const { data: before, error: bErr } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', id)
    .single();
  if (bErr || !before) throw new Error('Appointment not found');

  const now = new Date().toISOString();
  const updates = {
    hms_status: hmsStatus,
    status: LEGACY_STATUS[hmsStatus],
    updated_at: now,
    ...patch,
  };
  if (hmsStatus === 'reminded') updates.reminded_at = now;
  if (hmsStatus === 'arrived') updates.arrived_at = now;
  if (hmsStatus === 'seen') updates.seen_at = now;
  if (hmsStatus === 'missed') updates.missed_at = now;

  const { data, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;

  if (before.encounter_id) {
    const encStatus =
      hmsStatus === 'seen' ? 'done' : hmsStatus === 'missed' ? 'no_show' : hmsStatus === 'arrived' ? 'in_progress' : 'waiting';
    try {
      await updateEncounterStatus(before.encounter_id, encStatus, { hms_status: hmsStatus });
    } catch {
      /* ignore */
    }
  }

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'edit',
    resourceType: 'appointment',
    resourceId: id,
    patientId: data.patient_id,
    module: 'appointments',
    before,
    after: data,
    req,
  });

  return data;
}

export async function rescheduleAppointment({
  id,
  scheduledAt,
  slotStart = null,
  doctorId = undefined,
  actor = {},
  req = null,
}) {
  const { data: before } = await supabase.from('appointments').select('*').eq('id', id).single();
  if (!before) throw new Error('Appointment not found');
  if (['seen', 'missed'].includes(before.hms_status)) {
    throw new Error('Cannot reschedule a seen or missed appointment');
  }

  const slot = new Date(slotStart || scheduledAt).toISOString();
  const provider = doctorId !== undefined ? doctorId : before.doctor_id;
  await assertSlotFree({ doctorId: provider, slotStart: slot, excludeId: id });

  const { data, error } = await supabase
    .from('appointments')
    .update({
      scheduled_at: slot,
      slot_start: slot,
      doctor_id: provider,
      hms_status: 'booked',
      status: LEGACY_STATUS.booked,
      reminded_at: null,
      arrived_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      const err = new Error('That provider slot is already booked');
      err.code = 'DOUBLE_BOOK';
      throw err;
    }
    throw error;
  }

  await writeAuditLog({
    ...actorMeta(actor),
    action: 'edit',
    resourceType: 'appointment',
    resourceId: id,
    patientId: data.patient_id,
    module: 'appointments',
    before,
    after: data,
    metadata: { reschedule: true },
    req,
  });

  return data;
}

export async function listAppointments({
  date = null,
  from = null,
  to = null,
  clinic = null,
  hmsStatus = null,
  patientId = null,
  defaulters = false,
  limit = 200,
} = {}) {
  let q = supabase
    .from('appointments')
    .select(
      '*, patient:profiles!appointments_patient_id_fkey(id, full_name, mrn, phone, sex, date_of_birth), provider:profiles!appointments_doctor_id_fkey(id, full_name, role)'
    )
    .order('slot_start', { ascending: true })
    .limit(Math.min(limit, 500));

  if (patientId) q = q.eq('patient_id', patientId);
  if (clinic) q = q.eq('clinic', clinic);
  if (hmsStatus) q = q.eq('hms_status', hmsStatus);
  if (defaulters) {
    q = q.eq('hms_status', 'missed');
  } else if (date) {
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;
    q = q.gte('scheduled_at', dayStart).lte('scheduled_at', dayEnd);
  } else {
    if (from) q = q.gte('scheduled_at', from);
    if (to) q = q.lte('scheduled_at', to);
  }

  const { data, error } = await q;
  if (error) {
    // Fallback without joins if FK names differ
    let q2 = supabase.from('appointments').select('*').order('scheduled_at', { ascending: true }).limit(limit);
    if (patientId) q2 = q2.eq('patient_id', patientId);
    if (clinic) q2 = q2.eq('clinic', clinic);
    if (hmsStatus) q2 = q2.eq('hms_status', hmsStatus);
    if (defaulters) q2 = q2.eq('hms_status', 'missed');
    else if (date) {
      q2 = q2.gte('scheduled_at', `${date}T00:00:00.000Z`).lte('scheduled_at', `${date}T23:59:59.999Z`);
    }
    const fallback = await q2;
    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }
  return data || [];
}

/**
 * Mark booked/reminded appointments whose day has ended as missed.
 * Called manually (no cron yet) via POST /api/hms/appointments/mark-missed.
 */
export async function markMissedEndOfDay({ asOfDate = null, actor = {}, req = null } = {}) {
  const day = asOfDate || new Date().toISOString().slice(0, 10);
  const end = `${day}T23:59:59.999Z`;
  const { data: rows, error } = await supabase
    .from('appointments')
    .select('id')
    .lte('scheduled_at', end)
    .in('hms_status', ['booked', 'reminded'])
    .limit(500);
  if (error) throw error;

  const updated = [];
  for (const row of rows || []) {
    const appt = await updateAppointmentStatus({
      id: row.id,
      hmsStatus: 'missed',
      actor,
      req,
    });
    updated.push(appt);
  }
  return { date: day, marked: updated.length, appointments: updated };
}
