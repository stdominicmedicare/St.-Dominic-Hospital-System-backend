/**
 * Pre-launch QA walkthrough (sample data only).
 * Usage: node scripts/prelaunch-qa.mjs
 * Reads Backend .env; never prints secrets.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  const key = m[1];
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const API = process.env.API_BASE_URL ? `${process.env.API_BASE_URL}/api` : 'http://127.0.0.1:5000/api';
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL || 'admin@stdominic.local';
const ADMIN_PASS = process.env.QA_ADMIN_PASSWORD || 'Medicare@123@#';
const TS = Date.now();
const STAFF_PASS = 'TestStaff@123!';

const results = [];
function ok(name, detail) {
  results.push({ status: 'PASS', name, detail });
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  results.push({ status: 'FAIL', name, detail });
  console.log(`FAIL  ${name} — ${detail}`);
}
function info(name, detail) {
  results.push({ status: 'INFO', name, detail });
  console.log(`INFO  ${name}${detail ? ' — ' + detail : ''}`);
}

async function supabaseLogin(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, token: body.access_token };
}

async function api(method, path, token, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

const createdStaff = {};
let patientId = null;
let patient2Id = null;
const patientEmail = `qa.patient.${TS}@stdominic.local`;

async function walkRole(role, allowedPath, deniedPath) {
  const s = createdStaff[role];
  if (!s) {
    fail(`Role walk: ${role}`, 'user not created');
    return;
  }
  const login = await supabaseLogin(s.email, s.password);
  if (!login.token) {
    fail(`Role login: ${role}`, JSON.stringify(login.body));
    return;
  }
  ok(`Role login: ${role}`, s.email);

  const allowed = await api('GET', allowedPath, login.token);
  if (allowed.status === 200 || allowed.status === 201) {
    ok(`Role ${role}: allowed ${allowedPath}`, `HTTP ${allowed.status}`);
  } else {
    fail(`Role ${role}: allowed ${allowedPath}`, `${allowed.status} ${JSON.stringify(allowed.data).slice(0, 160)}`);
  }

  if (deniedPath) {
    const denied = await api('GET', deniedPath, login.token);
    if (denied.status === 403 || denied.status === 401) {
      ok(`Edge: ${role} denied ${deniedPath}`, `HTTP ${denied.status}`);
    } else {
      fail(`Edge: ${role} denied ${deniedPath}`, `expected 403 got ${denied.status}`);
    }
  }
}

try {
  console.log('\n=== PRE-LAUNCH TESTING (Sample Data) ===\n');
  if (!SUPABASE_URL || !ANON) {
    fail('Env', 'SUPABASE_URL / SUPABASE_ANON_KEY missing');
    process.exit(1);
  }

  const bad = await supabaseLogin(ADMIN_EMAIL, 'WrongPassword@999');
  if (bad.status === 400 || bad.status === 401) ok('Edge: wrong password rejected', `HTTP ${bad.status}`);
  else fail('Edge: wrong password rejected', `unexpected HTTP ${bad.status}`);

  const adminLogin = await supabaseLogin(ADMIN_EMAIL, ADMIN_PASS);
  if (!adminLogin.token) {
    fail('Admin login', JSON.stringify(adminLogin.body));
    console.log('\nABORT: cannot continue without admin token\n');
    process.exit(1);
  }
  ok('Admin login', ADMIN_EMAIL);
  const adminTok = adminLogin.token;

  const me = await api('GET', '/auth/me', adminTok);
  if (me.status === 200) {
    const role = me.data?.role || me.data?.user?.role || me.data?.profile?.role;
    ok('Admin /auth/me', `role=${role || 'present'}`);
  } else fail('Admin /auth/me', `${me.status} ${JSON.stringify(me.data)}`);

  const dash = await api('GET', '/admin/dashboard', adminTok);
  if (dash.status === 200) ok('Admin dashboard', 'loaded');
  else fail('Admin dashboard', `${dash.status} ${JSON.stringify(dash.data)}`);

  const roles = await api('GET', '/admin/roles', adminTok);
  if (roles.status === 200) {
    ok(
      'Permissions: list roles',
      Array.isArray(roles.data) ? roles.data.join(', ') : JSON.stringify(roles.data).slice(0, 180)
    );
  } else fail('Permissions: list roles', `${roles.status} ${JSON.stringify(roles.data)}`);

  const staffDefs = [
    { role: 'Doctor', email: `qa.doctor.${TS}@stdominic.local`, full_name: 'QA Doctor Sample' },
    { role: 'Nurse', email: `qa.nurse.${TS}@stdominic.local`, full_name: 'QA Nurse Sample' },
    { role: 'Receptionist', email: `qa.desk.${TS}@stdominic.local`, full_name: 'QA Front Desk Sample' },
    { role: 'RecordsOfficer', email: `qa.records.${TS}@stdominic.local`, full_name: 'QA Records Officer Sample' },
    { role: 'Pharmacy', email: `qa.pharmacy.${TS}@stdominic.local`, full_name: 'QA Pharmacy Sample' },
    { role: 'ICU', email: `qa.icu.${TS}@stdominic.local`, full_name: 'QA ICU Sample' },
    { role: 'Ambulance', email: `qa.ambulance.${TS}@stdominic.local`, full_name: 'QA Ambulance Sample' },
    { role: 'BloodBank', email: `qa.bloodbank.${TS}@stdominic.local`, full_name: 'QA Blood Bank Sample' },
    { role: 'Volunteer', email: `qa.volunteer.${TS}@stdominic.local`, full_name: 'QA Volunteer Sample' },
  ];

  for (const s of staffDefs) {
    const created = await api('POST', '/admin/users', adminTok, {
      email: s.email,
      password: STAFF_PASS,
      full_name: s.full_name,
      role: s.role,
      phone: `0300${String(TS).slice(-7)}`,
    });
    if (created.status === 201 || created.status === 200) {
      ok(`Create staff: ${s.role}`, s.email);
      createdStaff[s.role] = { ...s, id: created.data?.id, password: STAFF_PASS };
    } else {
      fail(`Create staff: ${s.role}`, `${created.status} ${JSON.stringify(created.data)}`);
    }
  }

  if (createdStaff.Doctor) {
    const doc = await api('POST', '/admin/doctors', adminTok, {
      email: `qa.docprofile.${TS}@stdominic.local`,
      password: STAFF_PASS,
      full_name: 'QA Doctor Profile Sample',
      specialty: 'General Medicine',
      department: 'Internal Medicine',
      license_number: `LIC-QA-${TS}`,
    });
    if (doc.status === 201 || doc.status === 200) ok('Create doctor via /admin/doctors', doc.data?.email || 'ok');
    else info('Create doctor via /admin/doctors', `${doc.status} ${JSON.stringify(doc.data).slice(0, 200)}`);
  }

  const patientBody = {
    email: patientEmail,
    password: 'Patient@Test99!',
    full_name: 'QA Fake Patient One',
    phone: `0311${String(TS).slice(-7)}`,
    date_of_birth: '1990-05-15',
    data_consent: true,
  };
  const reg = await api('POST', '/records/register', adminTok, patientBody);
  if (reg.status === 201) {
    patientId = reg.data?.id;
    ok('Registration: create sample patient', `id=${patientId} mrn=${reg.data?.mrn || 'n/a'}`);
  } else fail('Registration: create sample patient', `${reg.status} ${JSON.stringify(reg.data)}`);

  const dupCheck = await api('POST', '/records/check-duplicates', adminTok, {
    full_name: patientBody.full_name,
    phone: patientBody.phone,
    date_of_birth: patientBody.date_of_birth,
    email: patientBody.email,
  });
  if (dupCheck.status === 200 && (dupCheck.data?.count > 0 || (dupCheck.data?.duplicates || []).length > 0)) {
    ok('Edge: duplicate check finds match', `count=${dupCheck.data.count ?? dupCheck.data.duplicates?.length}`);
  } else fail('Edge: duplicate check finds match', `${dupCheck.status} ${JSON.stringify(dupCheck.data)}`);

  const dupReg = await api('POST', '/records/register', adminTok, {
    ...patientBody,
    email: `qa.patient.dup.${TS}@stdominic.local`,
  });
  if (dupReg.status === 409) ok('Edge: duplicate patient blocked', dupReg.data?.code || '409');
  else fail('Edge: duplicate patient blocked', `${dupReg.status} ${JSON.stringify(dupReg.data)}`);

  const patient2 = await api('POST', '/records/register', adminTok, {
    email: `qa.patient2.${TS}@stdominic.local`,
    password: 'Patient@Test99!',
    full_name: 'QA Fake Patient Two',
    phone: `0322${String(TS).slice(-7)}`,
    date_of_birth: '1985-11-02',
    data_consent: true,
  });
  patient2Id = patient2.data?.id;
  if (patient2.status === 201) ok('Registration: second sample patient', patient2Id);
  else fail('Registration: second sample patient', `${patient2.status} ${JSON.stringify(patient2.data)}`);

  const search = await api('GET', `/records/search?q=${encodeURIComponent('QA Fake Patient')}`, adminTok);
  if (search.status === 200 && Array.isArray(search.data) && search.data.length >= 1) {
    ok('Search patients', `hits=${search.data.length}`);
  } else fail('Search patients', `${search.status} ${JSON.stringify(search.data).slice(0, 200)}`);

  if (patientId) {
    const rec = await api('GET', `/records/${patientId}`, adminTok);
    if (rec.status === 200) ok('Records: view patient', rec.data?.full_name || patientId);
    else fail('Records: view patient', `${rec.status} ${JSON.stringify(rec.data)}`);

    const tl = await api('GET', `/records/${patientId}/timeline`, adminTok);
    if (tl.status === 200) ok('Records: timeline', Array.isArray(tl.data) ? `events=${tl.data.length}` : 'ok');
    else fail('Records: timeline', `${tl.status} ${JSON.stringify(tl.data)}`);

    const exp = await api('GET', `/records/${patientId}/export`, adminTok);
    if (exp.status === 200) ok('Records: export patient', typeof exp.data === 'object' ? 'json ok' : 'ok');
    else fail('Records: export patient', `${exp.status} ${JSON.stringify(exp.data).slice(0, 200)}`);
  }

  const reportTypes = await api('GET', '/reports/', adminTok);
  if (reportTypes.status === 200) ok('Reports: catalog', JSON.stringify(reportTypes.data).slice(0, 180));
  else fail('Reports: catalog', `${reportTypes.status} ${JSON.stringify(reportTypes.data)}`);

  const census = await api('GET', '/reports/patient_census?format=json', adminTok);
  if (census.status === 200) {
    const rows = census.data?.rows || census.data;
    ok('Reports: patient_census', Array.isArray(rows) ? `rows=${rows.length}` : 'ok');
  } else fail('Reports: patient_census', `${census.status} ${JSON.stringify(census.data).slice(0, 200)}`);

  const empty = await api('GET', '/reports/visit_logs?format=json&from=2099-01-01&to=2099-01-02', adminTok);
  if (empty.status === 200) {
    const rows = empty.data?.rows || empty.data?.data || (Array.isArray(empty.data) ? empty.data : null);
    ok('Edge: empty report export window', `HTTP 200 rows=${Array.isArray(rows) ? rows.length : 'n/a'}`);
  } else if (empty.status === 404 || empty.status === 204) {
    ok('Edge: empty report export window', `HTTP ${empty.status}`);
  } else {
    fail('Edge: empty report export window', `${empty.status} ${JSON.stringify(empty.data).slice(0, 200)}`);
  }

  const audit = await api('GET', '/admin/audit-logs', adminTok);
  if (audit.status === 200) {
    const rows = Array.isArray(audit.data) ? audit.data : audit.data?.logs || audit.data?.data || [];
    ok('Audit trail: list logs', `entries=${Array.isArray(rows) ? rows.length : 'present'}`);
  } else fail('Audit trail: list logs', `${audit.status} ${JSON.stringify(audit.data).slice(0, 200)}`);

  await walkRole('Receptionist', '/records/search?q=QA', '/admin/users');
  await walkRole('Nurse', '/records/search?q=QA', '/admin/users');
  await walkRole('RecordsOfficer', '/admin/audit-logs', '/admin/users');
  await walkRole('Doctor', '/doctor/patients', '/admin/users');
  await walkRole('Pharmacy', '/pharmacy/dashboard', '/admin/users');
  await walkRole('ICU', '/icu/dashboard', '/admin/users');
  await walkRole('Ambulance', '/ambulance/dashboard', '/admin/users');
  await walkRole('BloodBank', '/bloodbank/dashboard', '/admin/users');
  await walkRole('Volunteer', '/volunteer/profile', '/admin/users');

  if (patientId) {
    const pl = await supabaseLogin(patientEmail, 'Patient@Test99!');
    if (pl.token) {
      ok('Role login: Patient', patientEmail);
      const pd = await api('GET', '/patient/dashboard/stats', pl.token);
      if (pd.status === 200) ok('Role Patient: dashboard', 'ok');
      else fail('Role Patient: dashboard', `${pd.status} ${JSON.stringify(pd.data).slice(0, 160)}`);

      const denied = await api('GET', '/admin/users', pl.token);
      if (denied.status === 403 || denied.status === 401) ok('Edge: Patient denied /admin/users', `HTTP ${denied.status}`);
      else fail('Edge: Patient denied /admin/users', `expected 403 got ${denied.status}`);

      const deniedReg = await api('POST', '/records/register', pl.token, patientBody);
      if (deniedReg.status === 403 || deniedReg.status === 401) {
        ok('Edge: Patient denied registration API', `HTTP ${deniedReg.status}`);
      } else fail('Edge: Patient denied registration API', `expected 403 got ${deniedReg.status}`);
    } else fail('Role login: Patient', JSON.stringify(pl.body));
  }

  if (createdStaff.Doctor) {
    const dl = await supabaseLogin(createdStaff.Doctor.email, STAFF_PASS);
    if (dl.token) {
      const denied = await api('POST', '/records/register', dl.token, {
        email: `qa.shouldfail.${TS}@stdominic.local`,
        password: 'Patient@Test99!',
        full_name: 'Should Fail',
        data_consent: true,
      });
      if (denied.status === 403) ok('Edge: Doctor denied patient registration', 'HTTP 403');
      else fail('Edge: Doctor denied patient registration', `expected 403 got ${denied.status}`);
    }
  }

  if (createdStaff.Nurse) {
    const nl = await supabaseLogin(createdStaff.Nurse.email, STAFF_PASS);
    if (nl.token) {
      const denied = await api('GET', '/reports/patient_census?format=json', nl.token);
      if (denied.status === 403) ok('Edge: Nurse denied reports', 'HTTP 403');
      else fail('Edge: Nurse denied reports', `expected 403 got ${denied.status}`);
    }
  }

  const users = await api('GET', '/admin/users', adminTok);
  if (users.status === 200 && Array.isArray(users.data)) ok('Admin user list', `users=${users.data.length}`);
  else fail('Admin user list', `${users.status}`);

  const wipeIds = [];
  for (const role of Object.keys(createdStaff)) {
    if (createdStaff[role]?.id) wipeIds.push({ role, id: createdStaff[role].id, email: createdStaff[role].email });
  }
  const allUsers = users.status === 200 ? users.data : [];
  const docProfile = allUsers.find((u) => u.email === `qa.docprofile.${TS}@stdominic.local`);
  if (docProfile) wipeIds.push({ role: 'Doctor', id: docProfile.id, email: docProfile.email });
  if (patientId) wipeIds.push({ role: 'Patient', id: patientId, email: patientEmail });
  if (patient2Id) wipeIds.push({ role: 'Patient', id: patient2Id, email: `qa.patient2.${TS}@stdominic.local` });

  info('Sample data inventory (for wipe)', wipeIds.map((w) => `${w.role}:${w.email}`).join(' | '));

  let deactivated = 0;
  for (const w of wipeIds) {
    const patch = await api('PATCH', `/admin/users/${w.id}`, adminTok, { is_active: false });
    if (patch.status === 200) deactivated++;
  }
  if (deactivated === wipeIds.length) {
    ok('Wipe prep: deactivate all QA accounts created this run', `${deactivated} accounts`);
  } else {
    fail('Wipe prep: deactivate all QA accounts created this run', `${deactivated}/${wipeIds.length}`);
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fails = results.filter((r) => r.status === 'FAIL');
  console.log('\n=== SUMMARY ===');
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fails.length}`);
  if (fails.length) {
    console.log('\nFailures:');
    for (const f of fails) console.log(` - ${f.name}: ${f.detail}`);
  }
  console.log('\nQA_INVENTORY_JSON=' + JSON.stringify(wipeIds));
  process.exit(fails.length ? 2 : 0);
} catch (e) {
  console.error('FATAL', e.message || e);
  process.exit(1);
}
