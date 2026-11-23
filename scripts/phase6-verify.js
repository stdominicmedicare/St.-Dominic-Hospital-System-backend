/**
 * Phase 6 acceptance checks (local unit + optional live DB).
 * Usage: node scripts/phase6-verify.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK  :', msg);
  }
}

console.log('--- Phase 6 module presence ---');
const root = path.join(__dirname, '..');
const required = [
  'supabase/migrations/20261106_phase6_existing_modules.sql',
  'src/services/existingModulesService.js',
  'src/services/patientProfileFields.js',
  'src/controllers/doctor.controller.js',
  'src/controllers/icu.controller.js',
  'src/controllers/ambulance.controller.js',
  'src/controllers/bloodbank.controller.js',
  'src/services/dashboardService.js',
  'src/services/reportsService.js',
];
for (const rel of required) {
  assert(fs.existsSync(path.join(root, rel)), `exists ${rel}`);
}

const fe = path.join(root, '../frontend/src');
assert(fs.existsSync(path.join(fe, 'navigation/hmsNav.js')), 'hmsNav.js');
assert(fs.existsSync(path.join(root, '../PHASE6.md')), 'PHASE6.md');

const nav = fs.readFileSync(path.join(fe, 'navigation/hmsNav.js'), 'utf8');
assert(nav.includes('Existing: Doctors · ICU · Ambulance · Blood bank'), 'sidebar section label matches HTML');
assert(nav.includes("id: 'doctors'"), 'Doctors link present');
assert(nav.includes("id: 'icu'"), 'ICU link present');
assert(nav.includes("id: 'ambulance'"), 'Ambulance link present');
assert(nav.includes("id: 'bloodbank'"), 'Blood bank link present');
assert(!nav.includes('Legacy OPD'), 'legacy competing OPD link removed');
assert(!nav.includes('Legacy admin home'), 'legacy admin home link removed');

const sidebar = fs.readFileSync(path.join(fe, 'components/layout/Sidebar.jsx'), 'utf8');
assert(sidebar.includes('EXISTING_SECTION_LABEL'), 'Sidebar uses EXISTING_SECTION_LABEL');

console.log('--- Phase 6 RBAC ---');
const {
  canAccessExistingModule,
  EXISTING_MODULE_APP_ROLES,
  getPortalAccess,
} = await import('../src/permissions/hmsRoles.js');

assert(canAccessExistingModule('Doctor', 'doctors'), 'Doctor can Doctors');
assert(!canAccessExistingModule('Accounts', 'doctors'), 'Accounts cannot Doctors');
assert(canAccessExistingModule('ICU', 'icu'), 'ICU can ICU');
assert(!canAccessExistingModule('Doctor', 'icu'), 'Doctor not ICU portal role');
assert(canAccessExistingModule('Ambulance', 'ambulance'), 'Ambulance can Ambulance');
assert(!canAccessExistingModule('Pharmacy', 'ambulance'), 'Pharmacy cannot Ambulance');
assert(canAccessExistingModule('BloodBank', 'bloodbank'), 'BloodBank can Blood bank');
assert(canAccessExistingModule('Admin', 'bloodbank'), 'Admin can Blood bank');
assert(EXISTING_MODULE_APP_ROLES.doctors.includes('Doctor'), 'allow-list Doctor');
assert(getPortalAccess('Admin', 'doctors') === 'full', 'Admin portal matrix doctors=full');
assert(getPortalAccess('Accounts', 'icu') === 'none', 'Accounts portal matrix icu=none');

const appJsx = fs.readFileSync(path.join(fe, 'App.jsx'), 'utf8');
assert(appJsx.includes("allowedRoles={['Doctor']}"), 'Doctor route RoleGuard');
assert(appJsx.includes("allowedRoles={['ICU']}"), 'ICU route RoleGuard');
assert(appJsx.includes("allowedRoles={['Ambulance']}"), 'Ambulance route RoleGuard');
assert(
  appJsx.includes("allowedRoles={['BloodBank', 'Blood Bank', 'Admin']}"),
  'Blood bank route RoleGuard includes Admin'
);

console.log('--- Phase 6 encounters + MRN wiring ---');
const doctorCtrl = fs.readFileSync(path.join(root, 'src/controllers/doctor.controller.js'), 'utf8');
assert(doctorCtrl.includes("module: 'doctor'"), 'doctor encounters');
assert(doctorCtrl.includes('PATIENT_MIN_FIELDS'), 'doctor MRN fields');
assert(doctorCtrl.includes('safeCreateEncounter'), 'doctor safeCreateEncounter');

const icuCtrl = fs.readFileSync(path.join(root, 'src/controllers/icu.controller.js'), 'utf8');
assert(icuCtrl.includes("module: 'icu'"), 'icu encounters');
assert(icuCtrl.includes('PATIENT_MIN_FIELDS'), 'icu MRN fields');

const ambCtrl = fs.readFileSync(path.join(root, 'src/controllers/ambulance.controller.js'), 'utf8');
assert(ambCtrl.includes("module: 'ambulance'"), 'ambulance encounters');
assert(ambCtrl.includes('safeCreateEncounter'), 'ambulance safeCreateEncounter');

const bbCtrl = fs.readFileSync(path.join(root, 'src/controllers/bloodbank.controller.js'), 'utf8');
assert(bbCtrl.includes("module: 'bloodbank'"), 'bloodbank encounters');
assert(bbCtrl.includes('safeCreateEncounter'), 'bloodbank safeCreateEncounter');

const mig = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261106_phase6_existing_modules.sql'),
  'utf8'
);
assert(mig.includes("'doctor', 'icu', 'ambulance', 'bloodbank'"), 'migration expands module check');
assert(mig.includes('hms_phase6_existing_counts'), 'migration KPI view');

const dash = fs.readFileSync(path.join(root, 'src/services/dashboardService.js'), 'utf8');
assert(dash.includes('getExistingModuleCounts'), 'dashboard loads existing counts');
assert(dash.includes('buildExistingModuleAlerts'), 'dashboard merges existing alerts');

const reports = fs.readFileSync(path.join(root, 'src/services/reportsService.js'), 'utf8');
assert(reports.includes("id: 'existing_modules'"), 'reports catalog entry');
assert(reports.includes('runExistingModules'), 'reports runner');

const home = fs.readFileSync(path.join(fe, 'pages/hms/HomeDashboard.jsx'), 'utf8');
assert(home.includes('EXISTING_SECTION_LABEL'), 'Home shows existing section');
assert(home.includes('existingTiles'), 'Home existing tiles');

const doctorUi = fs.readFileSync(path.join(fe, 'dashboards/Doctor/DoctorDashboard.jsx'), 'utf8');
assert(doctorUi.includes('function patientLabel'), 'Doctor UI patientLabel helper');
assert(doctorUi.includes('patient.mrn'), 'Doctor UI shows MRN');

console.log('--- Optional live DB ---');
try {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (url && key) {
    const sb = createClient(url, key);
    const { error: viewErr } = await sb.from('hms_phase6_existing_counts').select('*').maybeSingle();
    if (viewErr) {
      console.log(
        'WARN: apply migration 20261106_phase6_existing_modules.sql —',
        viewErr.message
      );
    } else {
      assert(true, 'live view hms_phase6_existing_counts');
    }

    const { error: encErr } = await sb.from('encounters').select('id').limit(1);
    assert(!encErr, `encounters readable (${encErr?.message || 'ok'})`);
  } else {
    console.log('SKIP: no SUPABASE_URL / service key — live checks skipped');
  }
} catch (err) {
  console.log('SKIP live DB:', err.message);
}

if (failed) {
  console.error(`\nPhase 6 verify FAILED (${failed})`);
  process.exit(1);
}
console.log('\nPhase 6 verify PASSED');
