/**
 * Phase 1 HMS: Patients (13), OPD (01), Appointments (02), Home counts.
 */
import { supabase } from '../config/supabase.js';
import { normalizeFlags } from '../permissions/hmsRoles.js';
import {
  listPatientsForHms,
  registerHmsPatient,
  updateHmsPatient,
  deactivatePatient,
  findDuplicatePatients,
  getHmsTimeline,
  patientListKpis,
  searchIcd10,
  PATIENT_SELECT,
  buildFullName,
} from '../services/patientHmsService.js';
import {
  listOpdQueue,
  checkInPatient,
  updateOpdVisit,
  bookFollowUpFromOpd,
  getOpdKpis,
} from '../services/opdService.js';
import {
  bookAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
  listAppointments,
  markMissedEndOfDay,
  CLINICS,
} from '../services/appointmentService.js';
import { getPendingCounts } from '../services/billingService.js';
import { getMchHomeCounts } from '../services/mchService.js';
import { mergePatients } from './records.controller.js';
import { buildExcelBuffer, buildPdfBuffer, sendBinary } from '../services/exportService.js';
import { writeAuditLog } from '../services/auditService.js';
import { OPD_STEPS, opdStatusToStep } from '../services/vitalsService.js';

function actorFrom(req) {
  return {
    id: req.user?.id,
    email: req.user?.email || req.profile?.email,
    role: req.role,
  };
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

// ---------- Home ----------
export async function homeCounts(req, res) {
  try {
    const p2 = await getPendingCounts().catch(() => ({}));
    let row = {};
    const viewRes = await supabase.from('hms_phase1_counts').select('*').maybeSingle();
    if (!viewRes.error && viewRes.data) row = viewRes.data;
    // Fallback KPIs if Phase 1 view not applied yet
    if (viewRes.error || row.opd_visits_today == null) {
      const today = new Date().toISOString().slice(0, 10);
      const [opd, appt, missed, patients] = await Promise.all([
        supabase
          .from('opd_visits')
          .select('id', { count: 'exact', head: true })
          .eq('visit_date', today)
          .neq('status', 'cancelled'),
        supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .gte('scheduled_at', `${today}T00:00:00.000Z`)
          .lte('scheduled_at', `${today}T23:59:59.999Z`),
        supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('hms_status', 'missed')
          .gte('scheduled_at', `${today}T00:00:00.000Z`)
          .lte('scheduled_at', `${today}T23:59:59.999Z`),
        supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'Patient')
          .is('merged_into_id', null)
          .eq('is_active', true),
      ]);
      row = {
        opd_visits_today: opd.count || 0,
        appointments_today: appt.count || 0,
        appointments_missed_today: missed.count || 0,
        total_patients: patients.count || 0,
        patients_registered_today: 0,
        opd_waiting_triage: 0,
      };
    }
    const mch = await getMchHomeCounts().catch(() => ({}));
    res.json({
      ...row,
      ...p2,
      ...mch,
      opd_visits_today: row.opd_visits_today ?? 0,
      appointments_today: row.appointments_today ?? 0,
      appointments_missed_today: row.appointments_missed_today ?? 0,
      total_patients: row.total_patients ?? 0,
      patients_registered_today: row.patients_registered_today ?? 0,
      anc_visits_today: mch.anc_visits_today ?? 0,
      maternity_in_labour: mch.maternity_in_labour ?? 0,
      deliveries_mtd: mch.deliveries_mtd ?? 0,
      pnc_due_today: mch.pnc_due_today ?? 0,
      imm_due_week: mch.imm_due_week ?? 0,
      fp_clients_today: mch.fp_clients_today ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------- Patients ----------
export async function patientsList(req, res) {
  try {
    const rows = await listPatientsForHms({
      q: req.query.q || '',
      limit: Number(req.query.limit) || 50,
      includeInactive: req.query.inactive === '1',
    });
    const enriched = rows.map((p) => ({
      ...p,
      age: ageFromDob(p.date_of_birth),
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function patientsKpis(req, res) {
  try {
    const kpis = await patientListKpis();
    res.json(kpis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function patientsCheckDuplicates(req, res) {
  try {
    const body = req.body || {};
    const full_name = buildFullName(body);
    const duplicates = await findDuplicatePatients({
      full_name,
      phone: body.phone,
      date_of_birth: body.date_of_birth,
      email: body.email,
      exclude_id: body.exclude_id,
    });
    res.json({ duplicates, count: duplicates.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function patientsRegister(req, res) {
  try {
    const patient = await registerHmsPatient(req.body || {}, actorFrom(req), req);
    res.status(201).json(patient);
  } catch (err) {
    if (err.code === 'DUPLICATE_PATIENT') {
      return res.status(409).json({
        error: err.message,
        code: 'DUPLICATE_PATIENT',
        duplicates: err.duplicates || [],
      });
    }
    res.status(400).json({ error: err.message });
  }
}

export async function patientsGet(req, res) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(PATIENT_SELECT)
      .eq('id', req.params.id)
      .eq('role', 'Patient')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'view',
      resourceType: 'patient_record',
      resourceId: data.id,
      patientId: data.id,
      module: 'records',
      req,
    });
    res.json({ ...data, age: ageFromDob(data.date_of_birth) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function patientsUpdate(req, res) {
  try {
    const data = await updateHmsPatient(req.params.id, req.body || {}, actorFrom(req), req);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function patientsDeactivate(req, res) {
  try {
    // Admin only — enforced by route requirePortal full + role check below
    if (req.role !== 'Admin' && req.portalAccess !== 'full') {
      return res.status(403).json({ error: 'Only administrators can deactivate patients', code: 'PORTAL_LEVEL_FORBIDDEN' });
    }
    const data = await deactivatePatient(req.params.id, req.body?.reason, actorFrom(req), req);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function patientsMerge(req, res) {
  // Reuse existing merge; Admin/RecordsOfficer enforced on legacy route — here require full portal
  return mergePatients(req, res);
}

export async function patientsTimeline(req, res) {
  try {
    const flags = normalizeFlags(req.profile || {});
    const pack = await getHmsTimeline(req.params.id, {
      canAccessHiv: Boolean(flags.can_access_hiv) || req.role === 'Admin',
      actor: actorFrom(req),
      req,
    });
    res.json(pack);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}

export async function patientsExportXlsx(req, res) {
  try {
    const rows = await listPatientsForHms({ q: req.query.q || '', limit: 500 });
    const buffer = await buildExcelBuffer(
      'Patients',
      ['Patient ID', 'Name', 'Sex', 'DOB', 'Phone', 'Insurance', 'Active'],
      rows.map((p) => [
        p.mrn || '',
        p.full_name || '',
        p.sex || '',
        p.date_of_birth || '',
        p.phone || '',
        p.insurance_scheme || 'none',
        p.is_active ? 'yes' : 'no',
      ])
    );
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'export',
      resourceType: 'patient_list',
      module: 'records',
      metadata: { format: 'xlsx', count: rows.length },
      req,
    });
    sendBinary(res, buffer, {
      filename: 'patients.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function patientsExportPdf(req, res) {
  try {
    const rows = await listPatientsForHms({ q: req.query.q || '', limit: 200 });
    const buffer = await buildPdfBuffer('Patient register', [
      {
        heading: 'Patients',
        table: {
          headers: ['Patient ID', 'Name', 'Sex', 'Phone', 'Insurance'],
          rows: rows.map((p) => [
            p.mrn || '',
            p.full_name || '',
            p.sex || '',
            p.phone || '',
            p.insurance_scheme || 'none',
          ]),
        },
      },
    ]);
    await writeAuditLog({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      actorRole: req.role,
      action: 'export',
      resourceType: 'patient_list',
      module: 'records',
      metadata: { format: 'pdf', count: rows.length },
      req,
    });
    sendBinary(res, buffer, {
      filename: 'patients.pdf',
      contentType: 'application/pdf',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------- OPD ----------
export async function opdQueue(req, res) {
  try {
    const rows = await listOpdQueue({
      date: req.query.date || null,
      status: req.query.status || null,
      stage: req.query.stage || null,
    });
    const withMeta = rows.map((r) => ({
      ...r,
      wait_min: r.checked_in_at
        ? Math.max(0, Math.round((Date.now() - new Date(r.checked_in_at).getTime()) / 60000))
        : null,
      step_index: opdStatusToStep(r.status),
      steps: OPD_STEPS,
      age: ageFromDob(r.patient?.date_of_birth),
    }));
    res.json(withMeta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function opdKpis(req, res) {
  try {
    res.json(await getOpdKpis(req.query.date || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function opdCheckIn(req, res) {
  try {
    const body = req.body || {};
    const visit = await checkInPatient({
      patientId: body.patient_id,
      doctorId: body.doctor_id,
      appointmentId: body.appointment_id,
      visitDate: body.visit_date,
      visitType: body.visit_type,
      chiefComplaint: body.chief_complaint,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(visit);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function opdUpdate(req, res) {
  try {
    const visit = await updateOpdVisit({
      id: req.params.id,
      patch: req.body || {},
      actor: actorFrom(req),
      req,
    });
    res.json(visit);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function opdBookFollowUp(req, res) {
  try {
    const appt = await bookFollowUpFromOpd({
      visitId: req.params.id,
      scheduledAt: req.body?.scheduled_at,
      doctorId: req.body?.doctor_id,
      reason: req.body?.reason,
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(appt);
  } catch (err) {
    const status = err.code === 'DOUBLE_BOOK' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
}

export async function icd10Search(req, res) {
  res.json(searchIcd10(req.query.q || '', Number(req.query.limit) || 20));
}

export async function staffProviders(req, res) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, specialty')
      .in('role', ['Doctor', 'Nurse', 'Midwife'])
      .eq('is_active', true)
      .order('full_name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------- Appointments ----------
export async function appointmentsList(req, res) {
  try {
    const rows = await listAppointments({
      date: req.query.date || null,
      from: req.query.from || null,
      to: req.query.to || null,
      clinic: req.query.clinic || null,
      hmsStatus: req.query.status || null,
      patientId: req.query.patient_id || null,
      defaulters: req.query.defaulters === '1',
      limit: Number(req.query.limit) || 200,
    });
    // Hide HIV patient names unless permitted
    const flags = normalizeFlags(req.profile || {});
    const canHiv = Boolean(flags.can_access_hiv) || req.role === 'Admin';
    const masked = rows.map((r) => {
      if (r.clinic === 'hiv' && !canHiv) {
        return {
          ...r,
          patient: r.patient
            ? { ...r.patient, full_name: 'Name hidden', phone: null }
            : r.patient,
        };
      }
      return r;
    });
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function appointmentsKpis(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const [day, missed, defaulters] = await Promise.all([
      listAppointments({ date }),
      listAppointments({ date, hmsStatus: 'missed' }),
      listAppointments({ defaulters: true, limit: 500 }),
    ]);
    res.json({
      booked_today: day.filter((a) => ['booked', 'reminded', 'arrived', 'seen'].includes(a.hms_status)).length,
      arrived: day.filter((a) => a.hms_status === 'arrived').length,
      missed_today: missed.length,
      defaulters_to_call: defaulters.length,
      clinics: CLINICS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function appointmentsBook(req, res) {
  try {
    const body = req.body || {};
    const appt = await bookAppointment({
      patientId: body.patient_id,
      clinic: body.clinic || 'opd',
      doctorId: body.doctor_id || body.provider_id || null,
      scheduledAt: body.scheduled_at || body.slot_start,
      slotStart: body.slot_start || body.scheduled_at,
      slotEnd: body.slot_end,
      reason: body.reason,
      reminderPhone: body.reminder_phone || body.phone,
      reminderSms: body.reminder_sms,
      notes: body.notes,
      sourceModule: body.source_module || body.clinic || 'appointments',
      actor: actorFrom(req),
      req,
    });
    res.status(201).json(appt);
  } catch (err) {
    const status = err.code === 'DOUBLE_BOOK' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
}

export async function appointmentsPatch(req, res) {
  try {
    const body = req.body || {};
    if (body.reschedule) {
      const appt = await rescheduleAppointment({
        id: req.params.id,
        scheduledAt: body.scheduled_at || body.slot_start,
        slotStart: body.slot_start,
        doctorId: body.doctor_id,
        actor: actorFrom(req),
        req,
      });
      return res.json(appt);
    }
    if (!body.hms_status && !body.status) {
      return res.status(400).json({ error: 'hms_status or reschedule required' });
    }
    const hmsStatus = body.hms_status || body.status;
    const patch = {};
    for (const k of ['reason', 'reminder_phone', 'reminder_sms', 'notes', 'clinic']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    const appt = await updateAppointmentStatus({
      id: req.params.id,
      hmsStatus,
      actor: actorFrom(req),
      req,
      patch,
    });
    res.json(appt);
  } catch (err) {
    const status = err.code === 'DOUBLE_BOOK' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
}

/**
 * End-of-day missed rule — MANUAL endpoint (no cron yet).
 * Documented in PHASE1.md.
 */
export async function appointmentsMarkMissed(req, res) {
  try {
    const result = await markMissedEndOfDay({
      asOfDate: req.body?.date || req.query?.date || null,
      actor: actorFrom(req),
      req,
    });
    res.json({
      ...result,
      note: 'Manual mark-missed (cron not ready). Call this after end of day or use per-row status=missed.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
