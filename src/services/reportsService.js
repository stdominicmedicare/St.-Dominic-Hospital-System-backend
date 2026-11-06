/**
 * Phase 4 HMS Reports — shared queries for on-screen tables + Excel/PDF export.
 * Counts for "today" align with Home dashboard tiles for the same date range.
 */
import { supabase } from '../config/supabase.js';
import { writeAuditLog } from './auditService.js';
import {
  buildExcelBuffer,
  buildPdfBuffer,
  sendBinary,
} from './exportService.js';
import { isUnsuppressed } from './hivRules.js';

export const REPORT_CATALOG = [
  { id: 'opd_attendance', group: 'Patient flow', label: 'OPD attendance & top diagnoses' },
  { id: 'appointments_kept', group: 'Patient flow', label: 'Appointments kept vs missed' },
  { id: 'anc_visits', group: 'Maternal & child', label: 'ANC registrations & visits' },
  { id: 'deliveries', group: 'Maternal & child', label: 'Deliveries by mode & outcome' },
  { id: 'pnc_coverage', group: 'Maternal & child', label: 'PNC coverage' },
  { id: 'immunization_coverage', group: 'Maternal & child', label: 'Immunization coverage' },
  { id: 'fp_methods', group: 'Maternal & child', label: 'Family planning users by method' },
  { id: 'hiv_cascade', group: 'Programs & services', label: 'HIV testing & ART cascade' },
  { id: 'lab_tests', group: 'Programs & services', label: 'Lab tests done' },
  { id: 'pharmacy_stock', group: 'Programs & services', label: 'Pharmacy consumption & stock-outs' },
  { id: 'revenue', group: 'Finance', label: 'Revenue by service & payment' },
  { id: 'existing_modules', group: 'Existing modules', label: 'Doctors · ICU · Ambulance · Blood bank activity' },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseFilters(query = {}) {
  const from = query.from ? String(query.from).slice(0, 10) : todayIso();
  const to = query.to ? String(query.to).slice(0, 10) : from;
  return {
    from,
    to,
    department: query.department || query.module || null,
    sex: query.sex || null,
    ageGroup: query.age_group || query.ageGroup || null,
  };
}

function ageYears(dob, onDate = new Date()) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let age = onDate.getFullYear() - d.getFullYear();
  const m = onDate.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && onDate.getDate() < d.getDate())) age -= 1;
  return age;
}

function ageBucket(age) {
  if (age == null) return 'Unknown';
  if (age < 5) return 'Under 5';
  if (age < 15) return '5–14';
  if (age < 50) return '15–49';
  return '50+';
}

function matchesAgeGroup(age, group) {
  if (!group || group === 'all') return true;
  const g = String(group).toLowerCase();
  if (g === 'under_5' || g === 'under 5') return age != null && age < 5;
  if (g === '5_14' || g === '5–14' || g === '5-14') return age != null && age >= 5 && age < 15;
  if (g === '15_49' || g === '15–49' || g === '15-49') return age != null && age >= 15 && age < 50;
  if (g === '50_plus' || g === '50+') return age != null && age >= 50;
  return true;
}

async function patientsMap(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  const { data } = await supabase
    .from('profiles')
    .select('id, mrn, full_name, sex, date_of_birth')
    .in('id', uniq);
  const map = {};
  for (const p of data || []) map[p.id] = p;
  return map;
}

function filterByDemo(rows, getPatientId, filters) {
  return rows.filter((r) => {
    const p = r._patient || null;
    if (filters.sex && filters.sex !== 'all') {
      const sx = String(p?.sex || '').toLowerCase();
      if (sx !== String(filters.sex).toLowerCase()) return false;
    }
    if (filters.ageGroup && filters.ageGroup !== 'all') {
      const age = ageYears(p?.date_of_birth);
      if (!matchesAgeGroup(age, filters.ageGroup)) return false;
    }
    return true;
  });
}

async function attachPatients(rows, idKey = 'patient_id') {
  const map = await patientsMap(rows.map((r) => r[idKey]));
  return rows.map((r) => ({ ...r, _patient: map[r[idKey]] || null }));
}

/** Dashboard-aligned KPI snapshot for a date range (defaults today). */
export async function getDashboardAlignedCounts(filters = {}) {
  const f = parseFilters(filters);
  const singleDay = f.from === f.to ? f.from : null;
  const fromTs = `${f.from}T00:00:00.000Z`;
  const toTs = `${f.to}T23:59:59.999Z`;
  const monthStart = `${String(f.from).slice(0, 7)}-01`;

  const [
    opd,
    appt,
    missed,
    enc,
    labPending,
    openInv,
    toDispense,
    lowStock,
    ancVisits,
    inLabour,
    deliveries,
    deliveriesMtd,
    pncDue,
    immDue,
    fpToday,
    patientsToday,
    patientsTotal,
  ] = await Promise.all([
    supabase
      .from('opd_visits')
      .select('id', { count: 'exact', head: true })
      .gte('visit_date', f.from)
      .lte('visit_date', f.to)
      .neq('status', 'cancelled'),
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .gte('scheduled_at', fromTs)
      .lte('scheduled_at', toTs),
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('hms_status', 'missed')
      .gte('scheduled_at', fromTs)
      .lte('scheduled_at', toTs),
    supabase
      .from('encounters')
      .select('id, module', { count: 'exact' })
      .gte('date_time', fromTs)
      .lte('date_time', toTs),
    supabase
      .from('lab_orders')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'verified')
      .neq('status', 'cancelled')
      .neq('status', 'sent'),
    supabase.from('invoices').select('id', { count: 'exact', head: true }).in('status', ['open', 'partial']),
    supabase
      .from('prescriptions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'active']),
    supabase
      .from('medicines')
      .select('id, stock_quantity, reorder_level, low_stock_threshold')
      .eq('is_active', true)
      .limit(2000),
    supabase
      .from('anc_visits')
      .select('id', { count: 'exact', head: true })
      .gte('visit_date', f.from)
      .lte('visit_date', f.to),
    supabase
      .from('maternity_admissions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'in_labour'),
    supabase
      .from('deliveries')
      .select('id', { count: 'exact', head: true })
      .gte('delivered_at', fromTs)
      .lte('delivered_at', toTs),
    supabase
      .from('deliveries')
      .select('id', { count: 'exact', head: true })
      .gte('delivered_at', `${monthStart}T00:00:00.000Z`)
      .lte('delivered_at', toTs),
    supabase
      .from('pnc_schedules')
      .select('id', { count: 'exact', head: true })
      .in('status', ['booked', 'due', 'overdue'])
      .lte('due_date', f.to)
      .gte('due_date', f.from),
    supabase
      .from('immunization_card_doses')
      .select('id', { count: 'exact', head: true })
      .in('status', ['due', 'overdue']),
    supabase
      .from('fp_encounters')
      .select('id', { count: 'exact', head: true })
      .gte('provided_at', fromTs)
      .lte('provided_at', toTs),
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'Patient')
      .gte('created_at', fromTs)
      .lte('created_at', toTs),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'Patient').is('merged_into_id', null),
  ]);

  const byModule = {};
  for (const e of enc.data || []) {
    byModule[e.module] = (byModule[e.module] || 0) + 1;
  }

  let low_stock_items = 0;
  for (const m of lowStock.data || []) {
    const reorder = m.reorder_level ?? m.low_stock_threshold ?? 10;
    if ((m.stock_quantity || 0) <= reorder) low_stock_items += 1;
  }

  return {
    from: f.from,
    to: f.to,
    day: singleDay,
    // Keys aligned with HomeDashboard / getHomeDashboard
    opd_visits: opd.count || 0,
    opd_visits_today: opd.count || 0,
    appointments: appt.count || 0,
    appointments_today: appt.count || 0,
    appointments_missed: missed.count || 0,
    appointments_missed_today: missed.count || 0,
    pending_lab: labPending.count || 0,
    open_invoices: openInv.count || 0,
    to_dispense: toDispense.count || 0,
    low_stock_items,
    anc_visits_today: ancVisits.count || 0,
    maternity_in_labour: inLabour.count || 0,
    deliveries: deliveries.count || 0,
    deliveries_mtd: deliveriesMtd.count || 0,
    pnc_due_today: pncDue.count || 0,
    imm_due_week: immDue.count || 0,
    fp_clients_today: fpToday.count || 0,
    patients_registered_today: patientsToday.count || 0,
    total_patients: patientsTotal.count || 0,
    encounters_by_module: byModule,
  };
}

async function runOpdAttendance(filters) {
  const f = parseFilters(filters);
  let q = supabase
    .from('opd_visits')
    .select('id, patient_id, visit_date, status, diagnosis_text, diagnosis_code, triage_level')
    .gte('visit_date', f.from)
    .lte('visit_date', f.to)
    .neq('status', 'cancelled')
    .limit(2000);
  const { data, error } = await q;
  if (error) throw error;
  let rows = await attachPatients(data || []);
  rows = filterByDemo(rows, 'patient_id', f);

  const diag = {};
  const byAgeSex = {};
  for (const r of rows) {
    const label = r.diagnosis_text || r.diagnosis_code || 'Unspecified';
    diag[label] = (diag[label] || 0) + 1;
    const age = ageBucket(ageYears(r._patient?.date_of_birth));
    const sex = r._patient?.sex || 'Unknown';
    const key = `${age}|${sex}`;
    byAgeSex[key] = (byAgeSex[key] || 0) + 1;
  }
  const topDiagnoses = Object.entries(diag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const attendance = Object.entries(byAgeSex).map(([key, count]) => {
    const [age_group, sex] = key.split('|');
    return { age_group, sex, count };
  });

  return {
    title: 'OPD attendance & top diagnoses',
    summary: {
      total_visits: rows.length,
      unique_patients: new Set(rows.map((r) => r.patient_id)).size,
    },
    columns: ['Visit date', 'Patient', 'Sex', 'Age group', 'Diagnosis', 'Status'],
    rows: rows.slice(0, 500).map((r) => [
      r.visit_date,
      r._patient?.full_name || r._patient?.mrn || r.patient_id,
      r._patient?.sex || '—',
      ageBucket(ageYears(r._patient?.date_of_birth)),
      r.diagnosis_text || r.diagnosis_code || '—',
      r.status,
    ]),
    chart: {
      type: 'bar',
      label: 'Top diagnoses',
      items: topDiagnoses.map((d) => ({ label: d.name, value: d.count })),
    },
    extra: { top_diagnoses: topDiagnoses, attendance_by_age_sex: attendance },
  };
}

async function runAppointments(filters) {
  const f = parseFilters(filters);
  let q = supabase
    .from('appointments')
    .select('id, patient_id, clinic, scheduled_at, hms_status, status')
    .gte('scheduled_at', `${f.from}T00:00:00.000Z`)
    .lte('scheduled_at', `${f.to}T23:59:59.999Z`)
    .limit(2000);
  if (f.department) q = q.eq('clinic', f.department);
  const { data, error } = await q;
  if (error) throw error;
  let rows = await attachPatients(data || []);
  rows = filterByDemo(rows, 'patient_id', f);
  const kept = rows.filter((r) => ['arrived', 'seen', 'completed'].includes(r.hms_status || r.status)).length;
  const missed = rows.filter((r) => (r.hms_status || r.status) === 'missed').length;
  const booked = rows.filter((r) => ['booked', 'reminded', 'pending', 'confirmed'].includes(r.hms_status || r.status)).length;
  return {
    title: 'Appointments kept vs missed',
    summary: { total: rows.length, kept, missed, booked },
    columns: ['When', 'Clinic', 'Patient', 'Status'],
    rows: rows.slice(0, 500).map((r) => [
      String(r.scheduled_at || '').slice(0, 16),
      r.clinic,
      r._patient?.full_name || r.patient_id,
      r.hms_status || r.status,
    ]),
    chart: {
      type: 'bar',
      label: 'Status',
      items: [
        { label: 'Kept', value: kept },
        { label: 'Missed', value: missed },
        { label: 'Booked/pending', value: booked },
      ],
    },
  };
}

async function runAnc(filters) {
  const f = parseFilters(filters);
  const [{ data: regs }, { data: visits }] = await Promise.all([
    supabase
      .from('anc_pregnancies')
      .select('id, patient_id, anc_no, registration_date, enrollment_date, created_at, high_risk, status')
      .limit(1000),
    supabase
      .from('anc_visits')
      .select('id, pregnancy_id, visit_date, gestational_age_weeks')
      .gte('visit_date', f.from)
      .lte('visit_date', f.to)
      .limit(2000),
  ]);
  const newRegs = (regs || []).filter((r) => {
    const d = String(r.registration_date || r.enrollment_date || r.created_at || '').slice(0, 10);
    return d >= f.from && d <= f.to;
  });
  const visitCounts = {};
  for (const v of visits || []) visitCounts[v.pregnancy_id] = (visitCounts[v.pregnancy_id] || 0) + 1;
  const fourPlus = Object.values(visitCounts).filter((n) => n >= 4).length;
  const early = (visits || []).filter((v) => v.gestational_age_weeks != null && Number(v.gestational_age_weeks) < 12).length;
  return {
    title: 'ANC registrations & visits',
    summary: {
      new_registrations: newRegs.length,
      visits_in_range: (visits || []).length,
      first_visit_before_12w: early,
      four_plus_visits: fourPlus,
      high_risk_active: (regs || []).filter((r) => r.status === 'active' && r.high_risk).length,
    },
    columns: ['ANC no', 'Registered', 'High risk', 'Status'],
    rows: newRegs.slice(0, 500).map((r) => [
      r.anc_no || r.id,
      String(r.registration_date || r.enrollment_date || r.created_at || '').slice(0, 10),
      r.high_risk ? 'Yes' : 'No',
      r.status,
    ]),
    chart: {
      type: 'bar',
      label: 'ANC',
      items: [
        { label: 'New regs', value: newRegs.length },
        { label: 'Visits', value: (visits || []).length },
        { label: '1st <12w', value: early },
        { label: '4+ visits', value: fourPlus },
      ],
    },
  };
}

async function runDeliveries(filters) {
  const f = parseFilters(filters);
  const { data, error } = await supabase
    .from('deliveries')
    .select('id, mother_id, delivered_at, mode, delivery_mode, outcome, baby_outcome, attendant')
    .gte('delivered_at', `${f.from}T00:00:00.000Z`)
    .lte('delivered_at', `${f.to}T23:59:59.999Z`)
    .limit(1000);
  if (error) throw error;
  const rows = data || [];
  const byMode = {};
  const byOutcome = {};
  for (const r of rows) {
    const mode = r.mode || r.delivery_mode || 'Unknown';
    const outcome = r.outcome || r.baby_outcome || 'Unknown';
    byMode[mode] = (byMode[mode] || 0) + 1;
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
  }
  return {
    title: 'Deliveries by mode & outcome',
    summary: { total: rows.length, by_mode: byMode, by_outcome: byOutcome },
    columns: ['Delivered', 'Mode', 'Outcome', 'Attendant'],
    rows: rows.map((r) => [
      String(r.delivered_at || '').slice(0, 16),
      r.mode || r.delivery_mode || '—',
      r.outcome || r.baby_outcome || '—',
      r.attendant || '—',
    ]),
    chart: {
      type: 'bar',
      label: 'Mode',
      items: Object.entries(byMode).map(([label, value]) => ({ label, value })),
    },
  };
}

async function runPnc(filters) {
  const f = parseFilters(filters);
  const { data } = await supabase.from('pnc_schedules').select('*').limit(2000);
  const rows = data || [];
  const due = rows.filter((r) => r.due_date >= f.from && r.due_date <= f.to);
  const completed = due.filter((r) => r.status === 'completed').length;
  const missed = due.filter((r) => r.status === 'missed' || (r.status !== 'completed' && r.due_date < todayIso())).length;
  return {
    title: 'PNC coverage',
    summary: { scheduled_in_range: due.length, completed, missed },
    columns: ['Visit', 'Due', 'Status', 'Mother'],
    rows: due.slice(0, 500).map((r) => [r.visit_code, r.due_date, r.status, r.mother_id]),
    chart: {
      type: 'bar',
      label: 'PNC',
      items: [
        { label: 'Scheduled', value: due.length },
        { label: 'Completed', value: completed },
        { label: 'Missed', value: missed },
      ],
    },
  };
}

async function runImm(filters) {
  const f = parseFilters(filters);
  const { data } = await supabase
    .from('immunization_card_doses')
    .select('id, patient_id, vaccine_code, dose_no, due_date, given_at, status')
    .limit(3000);
  const rows = data || [];
  const given = rows.filter((r) => {
    const d = String(r.given_at || '').slice(0, 10);
    return d && d >= f.from && d <= f.to;
  });
  const byVaccine = {};
  for (const r of given) {
    const k = r.vaccine_code || 'Unknown';
    byVaccine[k] = (byVaccine[k] || 0) + 1;
  }
  const overdue = rows.filter((r) => r.status === 'overdue' || (r.due_date < todayIso() && !r.given_at)).length;
  return {
    title: 'Immunization coverage',
    summary: { doses_given: given.length, overdue, by_vaccine: byVaccine },
    columns: ['Vaccine', 'Dose', 'Given', 'Status'],
    rows: given.slice(0, 500).map((r) => [r.vaccine_code, r.dose_no, r.given_at, r.status]),
    chart: {
      type: 'bar',
      label: 'By vaccine',
      items: Object.entries(byVaccine).map(([label, value]) => ({ label, value })),
    },
  };
}

async function runFp(filters) {
  const f = parseFilters(filters);
  const { data } = await supabase
    .from('fp_encounters')
    .select('id, patient_id, method_code, client_type, provided_at, status')
    .gte('provided_at', f.from)
    .lte('provided_at', f.to)
    .limit(2000);
  const rows = data || [];
  const byMethod = {};
  let neu = 0;
  let cont = 0;
  for (const r of rows) {
    byMethod[r.method_code || 'Unknown'] = (byMethod[r.method_code || 'Unknown'] || 0) + 1;
    if (r.client_type === 'new') neu += 1;
    if (r.client_type === 'continuing') cont += 1;
  }
  return {
    title: 'Family planning users by method',
    summary: { total: rows.length, new_users: neu, continuing: cont, by_method: byMethod },
    columns: ['Date', 'Type', 'Method', 'Status'],
    rows: rows.slice(0, 500).map((r) => [r.provided_at, r.client_type, r.method_code, r.status]),
    chart: {
      type: 'bar',
      label: 'Methods',
      items: Object.entries(byMethod).map(([label, value]) => ({ label, value })),
    },
  };
}

async function runHivCascade(filters) {
  const f = parseFilters(filters);
  const [{ data: hts }, { data: enrollments }] = await Promise.all([
    supabase
      .from('hiv_hts_tests')
      .select('id, test_date, result, patient_id')
      .gte('test_date', f.from)
      .lte('test_date', f.to)
      .limit(2000),
    supabase.from('hiv_enrollments').select('*').limit(2000),
  ]);
  const tested = hts || [];
  const positive = tested.filter((t) => t.result === 'positive').length;
  const onArt = (enrollments || []).filter((e) => e.art_started && e.status === 'active').length;
  const withVl = (enrollments || []).filter((e) => e.status === 'active' && e.last_viral_load != null);
  const suppressed = withVl.filter((e) => !isUnsuppressed(e.last_viral_load)).length;
  return {
    title: 'HIV testing & ART cascade',
    summary: {
      tested: tested.length,
      positive,
      on_art: onArt,
      vl_suppressed: suppressed,
      vl_with_result: withVl.length,
      suppressed_pct: withVl.length ? Math.round((1000 * suppressed.length) / withVl.length) / 10 : null,
    },
    columns: ['Metric', 'Value'],
    rows: [
      ['HTS tested', tested.length],
      ['HTS positive', positive],
      ['On ART (active)', onArt],
      ['VL suppressed', suppressed],
      ['VL results', withVl.length],
    ],
    chart: {
      type: 'bar',
      label: 'Cascade',
      items: [
        { label: 'Tested', value: tested.length },
        { label: 'Positive', value: positive },
        { label: 'On ART', value: onArt },
        { label: 'VL suppressed', value: suppressed },
      ],
    },
  };
}

async function runLab(filters) {
  const f = parseFilters(filters);
  const { data } = await supabase
    .from('lab_orders')
    .select('id, patient_id, status, priority, created_at, source')
    .gte('created_at', `${f.from}T00:00:00.000Z`)
    .lte('created_at', `${f.to}T23:59:59.999Z`)
    .limit(2000);
  const rows = data || [];
  const byStatus = {};
  for (const r of rows) byStatus[r.status || 'unknown'] = (byStatus[r.status || 'unknown'] || 0) + 1;
  return {
    title: 'Lab tests done',
    summary: { total_orders: rows.length, by_status: byStatus },
    columns: ['Created', 'Source', 'Priority', 'Status'],
    rows: rows.slice(0, 500).map((r) => [
      String(r.created_at || '').slice(0, 16),
      r.source || '—',
      r.priority || '—',
      r.status,
    ]),
    chart: {
      type: 'bar',
      label: 'Status',
      items: Object.entries(byStatus).map(([label, value]) => ({ label, value })),
    },
  };
}

async function runPharmacy(filters) {
  const f = parseFilters(filters);
  const [{ data: meds }, { data: moves }] = await Promise.all([
    supabase
      .from('medicines')
      .select('id, name, stock_quantity, reorder_level, low_stock_threshold, is_active')
      .limit(1000),
    supabase
      .from('stock_movements')
      .select('id, medicine_id, quantity_delta, reason, created_at')
      .gte('created_at', `${f.from}T00:00:00.000Z`)
      .lte('created_at', `${f.to}T23:59:59.999Z`)
      .limit(2000),
  ]);
  const low = (meds || []).filter(
    (m) =>
      m.is_active !== false &&
      (m.stock_quantity || 0) <= (m.reorder_level ?? m.low_stock_threshold ?? 10)
  );
  const consumed = (moves || []).filter((m) => (m.quantity_delta || 0) < 0);
  return {
    title: 'Pharmacy consumption & stock-outs',
    summary: {
      low_stock_items: low.length,
      consumption_events: consumed.length,
      units_out: Math.abs(consumed.reduce((s, m) => s + (m.quantity_delta || 0), 0)),
    },
    columns: ['Medicine', 'Stock', 'Reorder', 'Status'],
    rows: (meds || []).slice(0, 500).map((m) => [
      m.name,
      m.stock_quantity ?? 0,
      m.reorder_level ?? m.low_stock_threshold ?? 10,
      (m.stock_quantity || 0) <= (m.reorder_level ?? m.low_stock_threshold ?? 10) ? 'Low' : 'OK',
    ]),
    chart: {
      type: 'bar',
      label: 'Stock',
      items: [
        { label: 'Low stock', value: low.length },
        { label: 'Consumption events', value: consumed.length },
      ],
    },
  };
}

async function runRevenue(filters) {
  const f = parseFilters(filters);
  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount, method, payment_method, created_at, invoice_id')
    .gte('created_at', `${f.from}T00:00:00.000Z`)
    .lte('created_at', `${f.to}T23:59:59.999Z`)
    .limit(2000);
  const rows = payments || [];
  const byMethod = {};
  let total = 0;
  for (const p of rows) {
    const method = p.method || p.payment_method || 'Unknown';
    const amt = Number(p.amount) || 0;
    byMethod[method] = (byMethod[method] || 0) + amt;
    total += amt;
  }
  const { data: lines } = await supabase
    .from('invoice_lines')
    .select('id, description, line_total, source_module, created_at')
    .gte('created_at', `${f.from}T00:00:00.000Z`)
    .lte('created_at', `${f.to}T23:59:59.999Z`)
    .limit(2000);
  const byService = {};
  for (const l of lines || []) {
    const k = l.source_module || l.description || 'Other';
    byService[k] = (byService[k] || 0) + (Number(l.line_total) || 0);
  }
  return {
    title: 'Revenue by service & payment',
    summary: { total_collected: total, payments: rows.length, by_method: byMethod, by_service: byService },
    columns: ['When', 'Method', 'Amount'],
    rows: rows.slice(0, 500).map((p) => [
      String(p.created_at || '').slice(0, 16),
      p.method || p.payment_method || '—',
      Number(p.amount) || 0,
    ]),
    chart: {
      type: 'bar',
      label: 'By payment method',
      items: Object.entries(byMethod).map(([label, value]) => ({ label, value: Math.round(value) })),
    },
  };
}

async function runExistingModules(filters) {
  const f = parseFilters(filters);
  const modules = ['doctor', 'icu', 'ambulance', 'bloodbank'];
  const { data: enc } = await supabase
    .from('encounters')
    .select('id, patient_id, module, status, date_time, metadata')
    .in('module', modules)
    .gte('date_time', `${f.from}T00:00:00.000Z`)
    .lte('date_time', `${f.to}T23:59:59.999Z`)
    .order('date_time', { ascending: false })
    .limit(2000);
  let rows = await attachPatients(enc || []);
  rows = filterByDemo(rows, 'patient_id', f);
  const byModule = {};
  for (const r of rows) {
    byModule[r.module] = (byModule[r.module] || 0) + 1;
  }
  return {
    title: 'Doctors · ICU · Ambulance · Blood bank activity',
    summary: { total: rows.length, by_module: byModule },
    columns: ['When', 'Module', 'MRN', 'Patient', 'Status'],
    rows: rows.slice(0, 500).map((r) => [
      String(r.date_time || '').slice(0, 16),
      r.module,
      r._patient?.mrn || '—',
      r._patient?.full_name || '—',
      r.status || '—',
    ]),
    chart: {
      type: 'bar',
      label: 'Encounters by module',
      items: Object.entries(byModule).map(([label, value]) => ({ label, value })),
    },
  };
}

const RUNNERS = {
  opd_attendance: runOpdAttendance,
  appointments_kept: runAppointments,
  anc_visits: runAnc,
  deliveries: runDeliveries,
  pnc_coverage: runPnc,
  immunization_coverage: runImm,
  fp_methods: runFp,
  hiv_cascade: runHivCascade,
  lab_tests: runLab,
  pharmacy_stock: runPharmacy,
  revenue: runRevenue,
  existing_modules: runExistingModules,
};

export async function runReport(type, filters = {}) {
  const runner = RUNNERS[type];
  if (!runner) {
    throw Object.assign(new Error(`Unknown report type: ${type}`), { status: 404 });
  }
  const result = await runner(filters);
  return {
    type,
    filters: parseFilters(filters),
    generated_at: new Date().toISOString(),
    ...result,
  };
}

export async function exportReport(type, format, filters, actor = {}, req = null) {
  const report = await runReport(type, filters);
  const headers = report.columns || ['Col'];
  const rows = report.rows || [];
  let buffer;
  let contentType;
  let filename;
  if (format === 'pdf') {
    buffer = await buildPdfBuffer(report.title || type, [
      {
        heading: report.title,
        table: { headers, rows },
      },
    ]);
    contentType = 'application/pdf';
    filename = `${type}.pdf`;
  } else {
    buffer = await buildExcelBuffer(report.title || type, headers, rows);
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    filename = `${type}.xlsx`;
  }

  await writeAuditLog({
    actorId: actor.id || null,
    actorEmail: actor.email || null,
    actorRole: actor.role || null,
    action: 'export',
    resourceType: 'report',
    module: 'reports',
    metadata: {
      format: format === 'pdf' ? 'pdf' : 'xlsx',
      name: type,
      filters: report.filters,
      row_count: rows.length,
    },
    req,
  });

  return { buffer, contentType, filename, report };
}

export { sendBinary, parseFilters };
