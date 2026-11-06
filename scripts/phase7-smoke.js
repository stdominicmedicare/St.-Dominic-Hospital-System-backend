/**
 * Phase 7 live smoke paths against /api/hms/*
 * Usage: node scripts/phase7-smoke.js
 *
 * Paths:
 *  A) Register → OPD → Lab → Pharmacy → Pay bill
 *  B) ANC → Delivery → PNC → Immunization
 *  C) HIV denied without flag; allowed with flag (portal probe)
 *  D) Admin users/roles + audit export
 *  E) Dashboard counts vs aligned report (same day)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const API = (process.env.API_BASE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL || 'admin@memon1.local';
const ADMIN_PASS = process.env.QA_ADMIN_PASSWORD || 'Medicare@123@#';

let failed = 0;
const results = [];

function ok(msg, evidence = '') {
  results.push({ status: 'PASS', msg, evidence });
  console.log('OK  :', msg, evidence ? `— ${evidence}` : '');
}
function fail(msg, evidence = '') {
  failed += 1;
  results.push({ status: 'FAIL', msg, evidence });
  console.error('FAIL:', msg, evidence ? `— ${evidence}` : '');
}
function assert(cond, msg, evidence = '') {
  if (cond) ok(msg, evidence);
  else fail(msg, evidence);
}

async function api(method, p, { token, data } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: data != null ? JSON.stringify(data) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, ok: res.ok };
}

async function login(email, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`);
  return data.session.access_token;
}

async function ensureMedicine(admin) {
  const { data: existing } = await admin.from('medicines').select('id,name').limit(1);
  if (existing?.length) return existing[0];
  const { data, error } = await admin
    .from('medicines')
    .insert({
      name: 'Paracetamol 500mg',
      category: 'Analgesic',
      unit: 'Tablets',
      stock_quantity: 0,
      price_per_unit: 5,
      selling_price: 10,
      low_stock_threshold: 20,
      reorder_level: 20,
    })
    .select('id,name')
    .single();
  if (error) throw new Error(`Seed medicine failed: ${error.message}`);
  return data;
}

async function ensureStaffUser(admin, { email, password, fullName, role, flags = {} }) {
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  let user = (list.data?.users || []).find((u) => u.email === email);
  if (!user) {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    });
    if (created.error) throw created.error;
    user = created.data.user;
  }
  await admin.from('profiles').upsert({
    id: user.id,
    email,
    full_name: fullName,
    role,
    is_active: true,
    can_access_hiv: Boolean(flags.can_access_hiv),
    can_verify_lab: Boolean(flags.can_verify_lab),
    can_give_discounts: Boolean(flags.can_give_discounts),
    can_export_reports: Boolean(flags.can_export_reports),
    password_changed_at: new Date().toISOString(),
  });
  return { email, password, id: user.id, role };
}

async function ensureClinicalUserWithoutHiv(admin) {
  return ensureStaffUser(admin, {
    email: process.env.QA_CLINICAL_EMAIL || 'pw-clinical-nohiv@memon1.local',
    password: process.env.QA_CLINICAL_PASSWORD || 'TestClinical@123!',
    fullName: 'QA Clinical NoHIV',
    role: 'Doctor',
    flags: {},
  });
}

async function ensureHivFlaggedUser(admin) {
  return ensureStaffUser(admin, {
    email: process.env.QA_HIV_EMAIL || 'pw-hiv-doctor@memon1.local',
    password: process.env.QA_HIV_PASSWORD || 'TestHivDoc@123!',
    fullName: 'QA HIV Doctor',
    role: 'Doctor',
    flags: { can_access_hiv: true, can_verify_lab: true, can_export_reports: true },
  });
}

const stamp = Date.now();
const today = new Date().toISOString().slice(0, 10);

console.log('=== Phase 7 smoke @', API, '===');

const health = await fetch(`${API}/`);
assert(health.ok, 'API health', await health.text());

const adminToken = await login(ADMIN_EMAIL, ADMIN_PASS);
ok('Admin login', ADMIN_EMAIL);

const admin = createClient(SUPABASE_URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Role-shaped users (HTML matrix: Admin is view-only on clinical/billing write paths)
const doctor = await ensureStaffUser(admin, {
  email: process.env.QA_DOCTOR_EMAIL || 'pw-doctor@memon1.local',
  password: process.env.QA_DOCTOR_PASSWORD || 'TestDoctor@123!',
  fullName: 'QA Doctor',
  role: 'Doctor',
  flags: { can_export_reports: true },
});
const midwife = await ensureStaffUser(admin, {
  email: process.env.QA_MIDWIFE_EMAIL || 'pw-midwife@memon1.local',
  password: process.env.QA_MIDWIFE_PASSWORD || 'TestMidwife@123!',
  fullName: 'QA Midwife',
  role: 'Midwife',
});
const labUser = await ensureStaffUser(admin, {
  email: process.env.QA_LAB_EMAIL || 'pw-lab@memon1.local',
  password: process.env.QA_LAB_PASSWORD || 'TestLab@123!',
  fullName: 'QA Lab Supervisor',
  role: 'Laboratory',
  flags: { can_verify_lab: true },
});
const pharmUser = await ensureStaffUser(admin, {
  email: process.env.QA_PHARM_EMAIL || 'pw-pharm@memon1.local',
  password: process.env.QA_PHARM_PASSWORD || 'TestPharm@123!',
  fullName: 'QA Pharmacist',
  role: 'Pharmacy',
});
const accounts = await ensureStaffUser(admin, {
  email: process.env.QA_ACCOUNTS_EMAIL || 'pw-accounts@memon1.local',
  password: process.env.QA_ACCOUNTS_PASSWORD || 'TestAccounts@123!',
  fullName: 'QA Cashier',
  role: 'Accounts',
  flags: { can_give_discounts: true },
});

const doctorToken = await login(doctor.email, doctor.password);
const midwifeToken = await login(midwife.email, midwife.password);
const labToken = await login(labUser.email, labUser.password);
const pharmToken = await login(pharmUser.email, pharmUser.password);
const accountsToken = await login(accounts.email, accounts.password);
ok('Role users ready', 'Doctor/Midwife/Lab/Pharmacy/Accounts');

// ---------------------------------------------------------------------------
// A) Register → OPD → Lab → Pharmacy → Pay
// ---------------------------------------------------------------------------
console.log('\n--- Path A: clinical pay loop ---');
const med = await ensureMedicine(admin);
ok('Medicine available', med.name);

const recv = await api('POST', '/api/hms/pharmacy/receive', {
  token: pharmToken,
  data: {
    medicine_id: med.id,
    batch_no: `P7-${stamp}`,
    expiry_date: '2027-12-31',
    quantity: 200,
    unit_cost: 3,
    selling_price: 10,
    supplier: 'Phase7 smoke',
  },
});
assert([200, 201].includes(recv.status), 'Receive pharmacy stock (GRN)', JSON.stringify(recv.body).slice(0, 160));

const reg = await api('POST', '/api/hms/patients/register', {
  token: doctorToken,
  data: {
    first_name: 'Phase7',
    last_name: `Smoke${stamp}`,
    sex: 'female',
    date_of_birth: '1995-03-15',
    phone: `0300${String(stamp).slice(-7)}`,
    data_consent: true,
    address: 'Phase7 village',
  },
});
assert(reg.status === 201, 'Register patient', reg.body?.mrn || reg.body?.error);
const patientId = reg.body?.id;

const checkIn = await api('POST', '/api/hms/opd/check-in', {
  token: doctorToken,
  data: {
    patient_id: patientId,
    visit_type: 'new',
    chief_complaint: 'Fever phase7',
  },
});
assert(checkIn.status === 201, 'OPD check-in', `token ${checkIn.body?.token_no}`);
const visitId = checkIn.body?.id;

const triage = await api('PATCH', `/api/hms/opd/${visitId}`, {
  token: doctorToken,
  data: {
    status: 'triaged',
    vitals: { bp: '120/80', temp: 37.2, pulse: 78, spo2: 98, weight: 62, height: 160 },
  },
});
assert(triage.ok, 'OPD triage/vitals', triage.body?.status || triage.body?.error);

const cat = await api('GET', '/api/hms/lab/catalogue', { token: labToken });
const testId = cat.body?.[0]?.id || cat.body?.[0]?.test_id;
assert(Boolean(testId), 'Lab catalogue has tests', String(testId));

const labOrder = await api('POST', `/api/hms/opd/${visitId}/order-lab`, {
  token: doctorToken,
  data: { test_ids: [testId], priority: 'routine' },
});
assert(labOrder.status === 201, 'OPD order lab', labOrder.body?.id || labOrder.body?.error);
const orderId = labOrder.body?.id;

let itemId = labOrder.body?.items?.[0]?.id;
if (!itemId && orderId) {
  const wl = await api('GET', '/api/hms/lab/worklist', { token: labToken });
  const found = (Array.isArray(wl.body) ? wl.body : wl.body?.orders || []).find((o) => o.id === orderId);
  itemId = found?.items?.[0]?.id;
}

if (orderId) {
  await api('PATCH', `/api/hms/lab/orders/${orderId}`, {
    token: labToken,
    data: { status: 'sample_collected' },
  });
  await api('PATCH', `/api/hms/lab/orders/${orderId}`, {
    token: labToken,
    data: { status: 'in_progress' },
  });
}

if (itemId) {
  const result = await api('POST', `/api/hms/lab/items/${itemId}/result`, {
    token: labToken,
    data: { value: '95', unit: 'mg/dL' },
  });
  assert(result.ok, 'Lab enter result', JSON.stringify(result.body).slice(0, 120));
  const verify = await api('POST', `/api/hms/lab/items/${itemId}/verify`, { token: labToken, data: {} });
  assert(verify.ok, 'Lab verify (supervisor flag)', JSON.stringify(verify.body).slice(0, 120));
} else {
  fail('Lab item id for result/verify', 'order missing items');
}

const rx = await api('POST', `/api/hms/opd/${visitId}/prescribe`, {
  token: doctorToken,
  data: {
    items: [
      {
        medicine_id: med.id,
        medication_text: med.name,
        dosage: '500mg',
        frequency: 'TDS',
        quantity: 10,
      },
    ],
  },
});
assert(rx.status === 201, 'OPD prescribe', rx.body?.id || rx.body?.error);
const rxId = rx.body?.id;

const complete = await api('POST', `/api/hms/opd/${visitId}/complete`, { token: doctorToken, data: {} });
assert(complete.ok, 'OPD complete → billing charge', complete.body?.invoice?.id || complete.body?.error);

if (rxId) {
  const disp = await api('POST', `/api/hms/pharmacy/prescriptions/${rxId}/dispense`, {
    token: pharmToken,
    data: {},
  });
  assert(disp.ok, 'Pharmacy FEFO dispense', JSON.stringify(disp.body).slice(0, 160));
}

const invoices = await api('GET', `/api/hms/billing/invoices?patient_id=${patientId}`, { token: accountsToken });
const invList = Array.isArray(invoices.body)
  ? invoices.body
  : invoices.body?.invoices || invoices.body?.data || [];
const openInv =
  invList.find((i) => ['open', 'partial', 'unpaid'].includes(String(i.status).toLowerCase())) || invList[0];
assert(Boolean(openInv?.id), 'Open invoice for patient', openInv?.invoice_no || invoices.body?.error);

if (openInv?.id) {
  const bal =
    openInv.balance_due != null
      ? Number(openInv.balance_due)
      : Number(openInv.total || openInv.amount_due || 0) - Number(openInv.amount_paid || 0);
  const pay = await api('POST', `/api/hms/billing/invoices/${openInv.id}/pay`, {
    token: accountsToken,
    data: { amount: bal > 0 ? bal : Number(openInv.total) || 100, method: 'cash' },
  });
  assert([200, 201].includes(pay.status), 'Pay bill / receipt', pay.body?.payment?.receipt_no || pay.body?.error);
}

// ---------------------------------------------------------------------------
// B) ANC → Delivery → PNC → Immunization
// ---------------------------------------------------------------------------
console.log('\n--- Path B: MCH loop ---');
const mom = await api('POST', '/api/hms/patients/register', {
  token: midwifeToken,
  data: {
    first_name: 'Phase7Mom',
    last_name: `Mch${stamp}`,
    sex: 'female',
    date_of_birth: '1998-06-01',
    phone: `0311${String(stamp).slice(-7)}`,
    data_consent: true,
  },
});
assert(mom.status === 201, 'Register mother', mom.body?.mrn || mom.body?.error);
const momId = mom.body?.id;

const preg = await api('POST', '/api/hms/anc/pregnancies', {
  token: midwifeToken,
  data: {
    patient_id: momId,
    lmp: '2026-02-01',
    gravida: 1,
    para: 0,
    hb_g_dl: 11.5,
  },
});
assert(preg.status === 201, 'ANC register pregnancy', preg.body?.anc_no || preg.body?.error);
const pregnancyId = preg.body?.id;

const ancVisit = await api('POST', '/api/hms/anc/visits', {
  token: midwifeToken,
  data: {
    pregnancy_id: pregnancyId,
    visit_no: 1,
    bp_systolic: 118,
    bp_diastolic: 72,
    weight_kg: 64,
    next_visit_date: '2026-12-01',
  },
});
assert([200, 201].includes(ancVisit.status), 'ANC visit saved', ancVisit.body?.id || ancVisit.body?.error);

const admit = await api('POST', '/api/hms/maternity/admit', {
  token: midwifeToken,
  data: {
    patient_id: momId,
    pregnancy_id: pregnancyId,
    ward: 'Labour',
    cervix_cm: 4,
    contractions_per_10min: 3,
    fhr: 140,
  },
});
assert(admit.status === 201, 'Maternity admit', admit.body?.id || admit.body?.error);
const admissionId = admit.body?.id;

const delivery = await api('POST', '/api/hms/maternity/deliveries', {
  token: midwifeToken,
  data: {
    admission_id: admissionId,
    mode: 'svd',
    outcome: 'live_birth',
    attendant: 'Phase7 Midwife',
    placenta_complete: true,
    newborn: {
      sex: 'female',
      birth_weight_g: 3100,
      apgar_1: 8,
      apgar_5: 9,
      bcg_given: true,
      opv0_given: true,
    },
  },
});
assert(
  delivery.status === 201,
  'Delivery recorded + baby patient',
  delivery.body?.newborn?.linked_patient_id || delivery.body?.error
);
const babyId = delivery.body?.newborn?.linked_patient_id || delivery.body?.baby_patient?.id;

const pncDue = await api('GET', '/api/hms/pnc/due', { token: midwifeToken });
assert(pncDue.ok, 'PNC due list loads', `status ${pncDue.status}`);

const pncVisit = await api('POST', '/api/hms/pnc/visits', {
  token: midwifeToken,
  data: {
    mother_id: momId,
    newborn_id: delivery.body?.newborn?.id || null,
    baby_patient_id: babyId || null,
    visit_code: 'pnc1_48h',
    visit_no: 1,
    mother_bp_systolic: 110,
    mother_bp_diastolic: 70,
    bleeding: 'normal',
    baby_weight_kg: 3.1,
    breastfeeding: 'exclusive',
  },
});
assert([200, 201].includes(pncVisit.status), 'PNC visit saved', pncVisit.body?.id || pncVisit.body?.error);

if (babyId) {
  const card = await api('GET', `/api/hms/immunization/cards/${babyId}`, { token: midwifeToken });
  assert(card.ok, 'Baby immunization card', JSON.stringify(card.body).slice(0, 120));
  const doses = Array.isArray(card.body) ? card.body : card.body?.doses || card.body?.card || [];
  const dueDose =
    (doses || []).find((d) => ['due', 'upcoming', 'overdue'].includes(d.status)) || doses?.[0];
  if (dueDose?.id) {
    const dose = await api('POST', '/api/hms/immunization/doses', {
      token: midwifeToken,
      data: {
        patient_id: babyId,
        card_dose_id: dueDose.id,
        site: 'left arm',
        deduct_stock: false,
      },
    });
    assert([200, 201].includes(dose.status), 'Immunization dose recorded', dose.body?.id || dose.body?.error);
  } else {
    ok('Immunization card present (no dose id to record yet)', String(doses?.length || 0));
  }
} else {
  fail('Baby patient id from delivery for immunization');
}

// ---------------------------------------------------------------------------
// C) HIV access gate
// ---------------------------------------------------------------------------
console.log('\n--- Path C: HIV access ---');
const noHiv = await ensureClinicalUserWithoutHiv(admin);
const hivUser = await ensureHivFlaggedUser(admin);
const noHivToken = await login(noHiv.email, noHiv.password);
const hivToken = await login(hivUser.email, hivUser.password);

const deniedPortal = await api('GET', '/api/hms/portals/hiv', { token: noHivToken });
assert(deniedPortal.status === 403, 'HIV denied for clinical user without flag', `status ${deniedPortal.status}`);

const deniedArt = await api('GET', '/api/hms/hiv/art', { token: noHivToken });
assert(deniedArt.status === 403, 'HIV ART API denied without flag', `status ${deniedArt.status}`);

const allowedPortal = await api('GET', '/api/hms/portals/hiv', { token: hivToken });
assert(allowedPortal.ok, 'HIV allowed with can_access_hiv flag', `status ${allowedPortal.status}`);

const allowedArt = await api('GET', '/api/hms/hiv/art', { token: hivToken });
assert(allowedArt.ok, 'HIV ART list with flag', `status ${allowedArt.status}`);

// ---------------------------------------------------------------------------
// D) Admin users/roles + audit export
// ---------------------------------------------------------------------------
console.log('\n--- Path D: admin / audit ---');
const users = await api('GET', '/api/hms/users', { token: adminToken });
assert(
  users.ok && (users.body?.users || users.body)?.length >= 1,
  'Users list',
  `count ${(users.body?.users || users.body || []).length}`
);

const matrix = await api('GET', '/api/hms/users/matrix', { token: adminToken });
assert(matrix.ok, 'Roles matrix', `status ${matrix.status}`);

const audit = await api('GET', '/api/hms/security/audit?limit=20', { token: adminToken });
assert(audit.ok, 'Audit log list', `rows ${(audit.body?.logs || audit.body || []).length}`);

const auditXlsx = await api('GET', '/api/hms/security/audit/export.xlsx', { token: adminToken });
assert(auditXlsx.status === 200, 'Audit export xlsx', `status ${auditXlsx.status}`);

const mutate = await api('PATCH', '/api/hms/security/audit/00000000-0000-0000-0000-000000000001', {
  token: adminToken,
  data: { action: 'tamper' },
});
assert(mutate.status === 405 || mutate.status === 403, 'Audit append-only (mutate rejected)', `status ${mutate.status}`);

// ---------------------------------------------------------------------------
// E) Dashboard vs aligned report
// ---------------------------------------------------------------------------
console.log('\n--- Path E: dashboard vs report ---');
const home = await api('GET', '/api/hms/home-counts', { token: adminToken });
assert(home.ok, 'Home counts', `opd ${home.body?.opd_visits_today}`);

const aligned = await api('GET', `/api/hms/reports/aligned-counts?from=${today}&to=${today}`, {
  token: adminToken,
});
assert(aligned.ok, 'Aligned counts API', JSON.stringify(aligned.body).slice(0, 160));

if (home.ok && aligned.ok) {
  const homeOpd = Number(home.body.opd_visits_today || 0);
  const reportOpd = Number(aligned.body.opd_visits || 0);
  assert(
    homeOpd === reportOpd,
    'OPD today Home == Reports aligned',
    `home=${homeOpd} aligned=${reportOpd}`
  );
}

// Persist summary for traceability
const outPath = path.join(__dirname, '../../PHASE7_SMOKE_RESULTS.json');
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      ran_at: new Date().toISOString(),
      api: API,
      failed,
      passed: results.filter((r) => r.status === 'PASS').length,
      results,
    },
    null,
    2
  )
);
console.log('\nWrote', outPath);
console.log(failed ? `\nPHASE7 SMOKE FAILED (${failed})` : '\nPHASE7 SMOKE PASSED');
process.exit(failed ? 1 : 0);
