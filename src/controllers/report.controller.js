/**
 * Reports & export: patient census, visit logs, full patient record,
 * revenue, ANC, deliveries, immunization, HIV cascade.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from '../services/auditService.js';
import {
  buildExcelBuffer,
  buildMultiSheetExcel,
  buildPdfBuffer,
  sendBinary,
} from '../services/exportService.js';

function parseRange(query) {
  const from = query.from ? new Date(query.from).toISOString() : null;
  const to = query.to ? new Date(query.to).toISOString() : null;
  return { from, to };
}

function formatDate(v) {
  if (!v) return '';
  try {
    return new Date(v).toISOString();
  } catch {
    return String(v);
  }
}

async function fetchPatientCensus({ from, to }) {
  let q = supabase
    .from('profiles')
    .select('id, mrn, full_name, email, phone, date_of_birth, is_active, created_at, merged_into_id')
    .eq('role', 'Patient')
    .order('created_at', { ascending: false });

  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const active = rows.filter((r) => r.is_active && !r.merged_into_id).length;
  const merged = rows.filter((r) => r.merged_into_id).length;
  const inactive = rows.filter((r) => !r.is_active && !r.merged_into_id).length;

  return {
    summary: {
      total_registered: rows.length,
      active,
      inactive,
      merged,
    },
    rows,
  };
}

async function fetchVisitLogs({ from, to }) {
  let aq = supabase
    .from('appointments')
    .select(
      'id, patient_id, doctor_id, scheduled_at, status, notes, created_at, patient:profiles!appointments_patient_id_fkey(full_name, mrn), doctor:profiles!appointments_doctor_id_fkey(full_name)'
    )
    .order('scheduled_at', { ascending: false });

  if (from) aq = aq.gte('scheduled_at', from);
  if (to) aq = aq.lte('scheduled_at', to);

  const { data: appointments, error: aErr } = await aq;
  if (aErr) {
    // Fallback without embeds if FK names differ
    let q2 = supabase
      .from('appointments')
      .select('id, patient_id, doctor_id, scheduled_at, status, notes, created_at')
      .order('scheduled_at', { ascending: false });
    if (from) q2 = q2.gte('scheduled_at', from);
    if (to) q2 = q2.lte('scheduled_at', to);
    const { data, error } = await q2;
    if (error) throw new Error(error.message);
    return { rows: data || [] };
  }
  return { rows: appointments || [] };
}

async function fetchFullPatientRecord(patientId) {
  const { data: patient, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, phone, mrn, date_of_birth, is_active, created_at')
    .eq('id', patientId)
    .eq('role', 'Patient')
    .single();
  if (error || !patient) throw Object.assign(new Error('Patient not found'), { status: 404 });

  const [
    appointments,
    medicalRecords,
    prescriptions,
    ambulance,
    icuRequests,
    icuAdmissions,
    icuMonitoring,
    bloodRequests,
    transfusions,
  ] = await Promise.all([
    supabase.from('appointments').select('*').eq('patient_id', patientId).order('scheduled_at', { ascending: false }),
    supabase.from('medical_records').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }),
    supabase.from('prescriptions').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }),
    supabase.from('ambulance_requests').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }),
    supabase.from('icu_admission_requests').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }),
    supabase.from('icu_admission_records').select('*').eq('patient_id', patientId).order('admission_time', { ascending: false }),
    supabase.from('icu_patient_monitoring').select('*').eq('patient_id', patientId).order('recorded_at', { ascending: false }),
    supabase.from('blood_requests').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }),
    supabase.from('transfusion_logs').select('*').eq('patient_id', patientId).order('transfusion_time', { ascending: false }),
  ]);

  return {
    patient,
    appointments: appointments.data || [],
    medical_records: medicalRecords.data || [],
    prescriptions: prescriptions.data || [],
    ambulance_requests: ambulance.data || [],
    icu_admission_requests: icuRequests.data || [],
    icu_admission_records: icuAdmissions.data || [],
    icu_patient_monitoring: icuMonitoring.data || [],
    blood_requests: bloodRequests.data || [],
    transfusion_logs: transfusions.data || [],
  };
}

export async function listReportTypes(req, res) {
  res.json({
    reports: [
      {
        id: 'patient_census',
        name: 'Patient census',
        description: 'Patient registration counts and roster for a date range',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'visit_logs',
        name: 'Visit / appointment logs',
        description: 'Appointment visit log with status and participants',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'patient_full_record',
        name: 'Single patient full record',
        description: 'Complete chart export for referrals or patient requests (pass patientId)',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'revenue',
        name: 'Revenue / receipts',
        description: 'Payments collected in a date range',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'anc_attendance',
        name: 'ANC attendance',
        description: 'Antenatal visits in a date range',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'deliveries',
        name: 'Deliveries',
        description: 'Delivery outcomes in a date range',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'immunization_coverage',
        name: 'Immunization doses',
        description: 'Immunization doses given in a date range',
        formats: ['json', 'xlsx', 'pdf'],
      },
      {
        id: 'hiv_cascade',
        name: 'HIV cascade',
        description: 'HIV enrollments, ART, and VL documentation counts',
        formats: ['json', 'xlsx', 'pdf'],
      },
    ],
    notes: [
      'Program reports require the 20260924_jims_modules migration on Supabase.',
    ],
  });
}

export async function getReport(req, res) {
  try {
    const type = req.params.type;
    const format = String(req.query.format || 'json').toLowerCase();
    const { from, to } = parseRange(req.query);

    if (type === 'patient_census') {
      const { summary, rows } = await fetchPatientCensus({ from, to });
      await writeAuditLog({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        actorRole: req.role,
        action: 'view',
        resourceType: 'report',
        resourceId: type,
        metadata: { format, from, to, count: rows.length },
        req,
      });

      if (format === 'json') {
        return res.json({ type, summary, rows, from, to });
      }

      const headers = ['MRN', 'Full Name', 'Email', 'Phone', 'DOB', 'Active', 'Merged', 'Registered At'];
      const tableRows = rows.map((r) => [
        r.mrn || '',
        r.full_name || '',
        r.email || '',
        r.phone || '',
        r.date_of_birth || '',
        r.is_active ? 'yes' : 'no',
        r.merged_into_id ? 'yes' : 'no',
        formatDate(r.created_at),
      ]);

      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('Patient Census', headers, tableRows);
        return sendBinary(res, buf, {
          filename: `patient-census-${Date.now()}.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('Patient Census Report', [
          {
            heading: 'Summary',
            lines: [
              `Total registered: ${summary.total_registered}`,
              `Active: ${summary.active}`,
              `Inactive: ${summary.inactive}`,
              `Merged: ${summary.merged}`,
              `From: ${from || '—'}  To: ${to || '—'}`,
            ],
          },
          { heading: 'Patients', table: { headers, rows: tableRows } },
        ]);
        return sendBinary(res, buf, {
          filename: `patient-census-${Date.now()}.pdf`,
          contentType: 'application/pdf',
        });
      }
      return res.status(400).json({ error: 'Unsupported format. Use json, xlsx, or pdf.' });
    }

    if (type === 'visit_logs') {
      const { rows } = await fetchVisitLogs({ from, to });
      await writeAuditLog({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        actorRole: req.role,
        action: 'view',
        resourceType: 'report',
        resourceId: type,
        metadata: { format, from, to, count: rows.length },
        req,
      });

      if (format === 'json') {
        return res.json({ type, rows, from, to, count: rows.length });
      }

      const headers = ['Scheduled At', 'Status', 'Patient', 'MRN', 'Doctor', 'Notes'];
      const tableRows = rows.map((r) => [
        formatDate(r.scheduled_at),
        r.status || '',
        r.patient?.full_name || r.patient_id || '',
        r.patient?.mrn || '',
        r.doctor?.full_name || r.doctor_id || '',
        r.notes || '',
      ]);

      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('Visit Logs', headers, tableRows);
        return sendBinary(res, buf, {
          filename: `visit-logs-${Date.now()}.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('Visit / Appointment Logs', [
          {
            heading: 'Filters',
            lines: [`From: ${from || '—'}`, `To: ${to || '—'}`, `Rows: ${tableRows.length}`],
          },
          { heading: 'Visits', table: { headers, rows: tableRows } },
        ]);
        return sendBinary(res, buf, {
          filename: `visit-logs-${Date.now()}.pdf`,
          contentType: 'application/pdf',
        });
      }
      return res.status(400).json({ error: 'Unsupported format. Use json, xlsx, or pdf.' });
    }

    if (type === 'patient_full_record') {
      const patientId = req.query.patientId || req.params.patientId;
      if (!patientId) {
        return res.status(400).json({ error: 'patientId query parameter is required' });
      }
      return exportPatientFullRecord(req, res, patientId, format);
    }

    if (type === 'revenue') {
      let q = supabase.from('payments').select('*').order('paid_at', { ascending: false });
      if (from) q = q.gte('paid_at', from);
      if (to) q = q.lte('paid_at', to);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const list = rows || [];
      const total = list.reduce((s, r) => s + Number(r.amount || 0), 0);
      await writeAuditLog({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        actorRole: req.role,
        action: 'view',
        resourceType: 'report',
        resourceId: type,
        metadata: { format, from, to, count: list.length },
        req,
      });
      if (format === 'json') return res.json({ type, summary: { total_revenue: total, count: list.length }, rows: list, from, to });
      const headers = ['Receipt', 'Invoice ID', 'Amount', 'Method', 'Paid At'];
      const tableRows = list.map((r) => [r.receipt_no, r.invoice_id, r.amount, r.method, formatDate(r.paid_at)]);
      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('Revenue', headers, tableRows);
        return sendBinary(res, buf, { filename: `revenue-${Date.now()}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('Revenue / Receipts', [
          { heading: 'Summary', lines: [`Total: ${total}`, `Payments: ${list.length}`] },
          { heading: 'Payments', table: { headers, rows: tableRows } },
        ]);
        return sendBinary(res, buf, { filename: `revenue-${Date.now()}.pdf`, contentType: 'application/pdf' });
      }
    }

    if (type === 'anc_attendance') {
      let q = supabase.from('anc_visits').select('*').order('visit_date', { ascending: false });
      if (from) q = q.gte('visit_date', from.slice(0, 10));
      if (to) q = q.lte('visit_date', to.slice(0, 10));
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const list = rows || [];
      await writeAuditLog({
        actorId: req.user?.id, actorEmail: req.user?.email, actorRole: req.role,
        action: 'view', resourceType: 'report', resourceId: type, metadata: { count: list.length }, req,
      });
      if (format === 'json') return res.json({ type, rows: list, count: list.length, from, to });
      const headers = ['Visit Date', 'Pregnancy ID', 'Visit No', 'Weight', 'BP', 'Next Visit'];
      const tableRows = list.map((r) => [r.visit_date, r.pregnancy_id, r.visit_no, r.weight_kg, `${r.bp_systolic || ''}/${r.bp_diastolic || ''}`, r.next_visit_date]);
      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('ANC', headers, tableRows);
        return sendBinary(res, buf, { filename: `anc-${Date.now()}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('ANC Attendance', [{ heading: 'Visits', table: { headers, rows: tableRows } }]);
        return sendBinary(res, buf, { filename: `anc-${Date.now()}.pdf`, contentType: 'application/pdf' });
      }
    }

    if (type === 'deliveries') {
      let q = supabase.from('deliveries').select('*').order('delivered_at', { ascending: false });
      if (from) q = q.gte('delivered_at', from);
      if (to) q = q.lte('delivered_at', to);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const list = rows || [];
      await writeAuditLog({
        actorId: req.user?.id, actorEmail: req.user?.email, actorRole: req.role,
        action: 'view', resourceType: 'report', resourceId: type, metadata: { count: list.length }, req,
      });
      if (format === 'json') return res.json({ type, rows: list, count: list.length, from, to });
      const headers = ['Delivered At', 'Mode', 'Outcome', 'Admission ID'];
      const tableRows = list.map((r) => [formatDate(r.delivered_at), r.mode, r.outcome, r.admission_id]);
      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('Deliveries', headers, tableRows);
        return sendBinary(res, buf, { filename: `deliveries-${Date.now()}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('Deliveries', [{ heading: 'Records', table: { headers, rows: tableRows } }]);
        return sendBinary(res, buf, { filename: `deliveries-${Date.now()}.pdf`, contentType: 'application/pdf' });
      }
    }

    if (type === 'immunization_coverage') {
      let q = supabase.from('immunization_records').select('*').order('given_at', { ascending: false });
      if (from) q = q.gte('given_at', from.slice(0, 10));
      if (to) q = q.lte('given_at', to.slice(0, 10));
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const list = rows || [];
      await writeAuditLog({
        actorId: req.user?.id, actorEmail: req.user?.email, actorRole: req.role,
        action: 'view', resourceType: 'report', resourceId: type, metadata: { count: list.length }, req,
      });
      if (format === 'json') return res.json({ type, rows: list, count: list.length, from, to });
      const headers = ['Given At', 'Patient', 'Vaccine', 'Dose', 'Next Due'];
      const tableRows = list.map((r) => [r.given_at, r.patient_id, r.vaccine_id, r.dose_no, r.next_due]);
      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('Immunization', headers, tableRows);
        return sendBinary(res, buf, { filename: `imm-${Date.now()}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('Immunization Coverage', [{ heading: 'Doses', table: { headers, rows: tableRows } }]);
        return sendBinary(res, buf, { filename: `imm-${Date.now()}.pdf`, contentType: 'application/pdf' });
      }
    }

    if (type === 'hiv_cascade') {
      const { data: enrollments, error } = await supabase.from('hiv_enrollments').select('*');
      if (error) throw new Error(error.message);
      const list = enrollments || [];
      const onArt = list.filter((e) => e.art_started).length;
      const { count: vlCount } = await supabase
        .from('hiv_lab_results')
        .select('id', { count: 'exact', head: true })
        .not('viral_load', 'is', null);
      await writeAuditLog({
        actorId: req.user?.id, actorEmail: req.user?.email, actorRole: req.role,
        action: 'view', resourceType: 'report', resourceId: type, metadata: { enrolled: list.length }, req,
      });
      const summary = { enrolled: list.length, on_art: onArt, vl_documented: vlCount ?? 0 };
      if (format === 'json') return res.json({ type, summary, rows: list.map((e) => ({ id: e.id, status: e.status, art_started: e.art_started, enrollment_date: e.enrollment_date })) });
      const headers = ['Metric', 'Value'];
      const tableRows = Object.entries(summary).map(([k, v]) => [k, v]);
      if (format === 'xlsx') {
        const buf = await buildExcelBuffer('HIV Cascade', headers, tableRows);
        return sendBinary(res, buf, { filename: `hiv-cascade-${Date.now()}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (format === 'pdf') {
        const buf = await buildPdfBuffer('HIV Cascade', [{ heading: 'Summary', table: { headers, rows: tableRows } }]);
        return sendBinary(res, buf, { filename: `hiv-cascade-${Date.now()}.pdf`, contentType: 'application/pdf' });
      }
    }

    return res.status(404).json({ error: `Unknown report type: ${type}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

export async function exportPatientRecord(req, res) {
  try {
    const { id } = req.params;
    const format = String(req.query.format || 'pdf').toLowerCase();
    return exportPatientFullRecord(req, res, id, format);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

async function exportPatientFullRecord(req, res, patientId, format) {
  const pack = await fetchFullPatientRecord(patientId);

  await writeAuditLog({
    actorId: req.user?.id,
    actorEmail: req.user?.email,
    actorRole: req.role,
    action: 'view',
    resourceType: 'patient_export',
    resourceId: patientId,
    patientId,
    metadata: { format },
    req,
  });

  if (format === 'json') {
    return res.json(pack);
  }

  const p = pack.patient;
  const mrn = p.mrn || patientId.slice(0, 8);

  if (format === 'xlsx') {
    const sheets = [
      {
        name: 'Profile',
        headers: ['Field', 'Value'],
        rows: [
          ['MRN', p.mrn],
          ['Full Name', p.full_name],
          ['Email', p.email],
          ['Phone', p.phone],
          ['DOB', p.date_of_birth],
          ['Active', p.is_active ? 'yes' : 'no'],
          ['Registered', formatDate(p.created_at)],
        ],
      },
      {
        name: 'Appointments',
        headers: ['Scheduled At', 'Status', 'Doctor ID', 'Notes'],
        rows: pack.appointments.map((a) => [formatDate(a.scheduled_at), a.status, a.doctor_id, a.notes]),
      },
      {
        name: 'Medical Records',
        headers: ['Created', 'Diagnosis', 'Notes', 'Observations', 'Doctor ID'],
        rows: pack.medical_records.map((r) => [
          formatDate(r.created_at),
          r.diagnosis,
          r.notes,
          r.observations,
          r.doctor_id,
        ]),
      },
      {
        name: 'Prescriptions',
        headers: ['Created', 'Medication', 'Dosage', 'Status', 'Instructions'],
        rows: pack.prescriptions.map((r) => [
          formatDate(r.created_at),
          r.medication,
          r.dosage,
          r.status,
          r.instructions,
        ]),
      },
      {
        name: 'Ambulance',
        headers: ['Created', 'Status', 'Priority', 'From', 'To'],
        rows: pack.ambulance_requests.map((r) => [
          formatDate(r.created_at),
          r.status,
          r.priority,
          r.from_address,
          r.to_address,
        ]),
      },
      {
        name: 'ICU',
        headers: ['Type', 'Time', 'Status / Notes'],
        rows: [
          ...pack.icu_admission_records.map((r) => [
            'admission',
            formatDate(r.admission_time),
            r.discharge_time ? `Discharged ${formatDate(r.discharge_time)}` : 'Active',
          ]),
          ...pack.icu_patient_monitoring.map((r) => [
            'monitoring',
            formatDate(r.recorded_at),
            `${r.condition_status || ''} ${r.observation_notes || ''}`.trim(),
          ]),
        ],
      },
      {
        name: 'Blood',
        headers: ['Type', 'Time', 'Detail'],
        rows: [
          ...pack.blood_requests.map((r) => [
            'request',
            formatDate(r.created_at),
            `${r.request_number || ''} ${r.blood_group_required} ${r.request_status}`,
          ]),
          ...pack.transfusion_logs.map((r) => [
            'transfusion',
            formatDate(r.transfusion_time),
            r.notes || '',
          ]),
        ],
      },
    ];
    const buf = await buildMultiSheetExcel(sheets);
    return sendBinary(res, buf, {
      filename: `patient-${mrn}-full-record.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  if (format === 'pdf') {
    const buf = await buildPdfBuffer(`Patient Full Record — ${p.full_name || mrn}`, [
      {
        heading: 'Demographics',
        lines: [
          `MRN: ${p.mrn || '—'}`,
          `Name: ${p.full_name || '—'}`,
          `Email: ${p.email || '—'}`,
          `Phone: ${p.phone || '—'}`,
          `DOB: ${p.date_of_birth || '—'}`,
          `Registered: ${formatDate(p.created_at)}`,
        ],
      },
      {
        heading: `Appointments (${pack.appointments.length})`,
        table: {
          headers: ['When', 'Status', 'Notes'],
          rows: pack.appointments.map((a) => [formatDate(a.scheduled_at), a.status, a.notes || '']),
        },
      },
      {
        heading: `Medical Records (${pack.medical_records.length})`,
        table: {
          headers: ['When', 'Diagnosis', 'Notes'],
          rows: pack.medical_records.map((r) => [
            formatDate(r.created_at),
            r.diagnosis || '',
            r.notes || '',
          ]),
        },
      },
      {
        heading: `Prescriptions (${pack.prescriptions.length})`,
        table: {
          headers: ['When', 'Medication', 'Status'],
          rows: pack.prescriptions.map((r) => [
            formatDate(r.created_at),
            r.medication || '',
            r.status || '',
          ]),
        },
      },
      {
        heading: `Ambulance (${pack.ambulance_requests.length})`,
        table: {
          headers: ['When', 'Status', 'Route'],
          rows: pack.ambulance_requests.map((r) => [
            formatDate(r.created_at),
            r.status || '',
            `${r.from_address || ''} → ${r.to_address || ''}`,
          ]),
        },
      },
      {
        heading: `ICU Admissions (${pack.icu_admission_records.length})`,
        table: {
          headers: ['Admitted', 'Discharged', 'Reason'],
          rows: pack.icu_admission_records.map((r) => [
            formatDate(r.admission_time),
            formatDate(r.discharge_time),
            r.discharge_reason || r.final_status || '',
          ]),
        },
      },
      {
        heading: `Blood (${pack.blood_requests.length} requests / ${pack.transfusion_logs.length} transfusions)`,
        table: {
          headers: ['When', 'Type', 'Detail'],
          rows: [
            ...pack.blood_requests.map((r) => [
              formatDate(r.created_at),
              'request',
              `${r.request_number || ''} ${r.blood_group_required} (${r.request_status})`,
            ]),
            ...pack.transfusion_logs.map((r) => [
              formatDate(r.transfusion_time),
              'transfusion',
              r.notes || '',
            ]),
          ],
        },
      },
    ]);
    return sendBinary(res, buf, {
      filename: `patient-${mrn}-full-record.pdf`,
      contentType: 'application/pdf',
    });
  }

  return res.status(400).json({ error: 'Unsupported format. Use json, xlsx, or pdf.' });
}
