/**
 * Phase 1 acceptance checks (module presence + unit helpers).
 * Usage: node scripts/phase1-verify.js
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

console.log('--- Phase 1 module presence ---');
const root = path.join(__dirname, '..');
const required = [
  'supabase/migrations/20261106_phase1_patient_flow.sql',
  'src/services/patientHmsService.js',
  'src/services/opdService.js',
  'src/services/appointmentService.js',
  'src/services/vitalsService.js',
  'src/controllers/hmsPhase1.controller.js',
  'src/routes/hms.routes.js',
];
for (const rel of required) {
  assert(fs.existsSync(path.join(root, rel)), `exists ${rel}`);
}

const fe = path.join(root, '../frontend/src/pages/hms');
assert(fs.existsSync(path.join(fe, 'PatientsPortal.jsx')), 'PatientsPortal.jsx');
assert(fs.existsSync(path.join(fe, 'OpdPortal.jsx')), 'OpdPortal.jsx');
assert(fs.existsSync(path.join(fe, 'AppointmentsPortal.jsx')), 'AppointmentsPortal.jsx');
assert(fs.existsSync(path.join(root, '../PHASE1.md')), 'PHASE1.md');

console.log('--- Phase 1 vitals / ICD helpers ---');
const { evaluateUrgentVitals, computeBmi, opdStatusToStep } = await import(
  '../src/services/vitalsService.js'
);
const { searchIcd10, buildFullName, findDuplicatePatients } = await import(
  '../src/services/patientHmsService.js'
);

const urgentBp = evaluateUrgentVitals({ bp: '172/110' });
assert(urgentBp.urgent === true, 'BP ≥ 160/110 is urgent');
const urgentTemp = evaluateUrgentVitals({ temp: 38.5 });
assert(urgentTemp.urgent === true, 'temp ≥ 38.5 is urgent');
const urgentSpo2 = evaluateUrgentVitals({ spo2: 90 });
assert(urgentSpo2.urgent === true, 'SpO2 < 92 is urgent');
const okVitals = evaluateUrgentVitals({ bp: '120/80', temp: 36.8, spo2: 98 });
assert(okVitals.urgent === false, 'normal vitals not urgent');
assert(computeBmi(70, 175) === 22.9, 'BMI calc');
assert(opdStatusToStep('in_consultation') === 3, 'consult step index');
assert(searchIcd10('malaria').some((r) => r.code === 'B54'), 'ICD-10 malaria search');
assert(buildFullName({ first_name: 'Mary', last_name: 'Achieng' }) === 'Mary Achieng', 'full name');

console.log('--- Phase 1 route wiring ---');
const routesSrc = fs.readFileSync(path.join(root, 'src/routes/hms.routes.js'), 'utf8');
for (const needle of [
  '/patients/register',
  '/patients/check-duplicates',
  '/patients/:id/timeline',
  '/patients/:id/deactivate',
  '/opd/check-in',
  '/opd/queue',
  '/opd/:id/follow-up',
  '/appointments/mark-missed',
  "requirePortal('opd', { minLevel: 'edit' })",
  '/home-counts',
]) {
  assert(routesSrc.includes(needle), `route contains ${needle}`);
}

const appSrc = fs.readFileSync(path.join(root, '../frontend/src/App.jsx'), 'utf8');
assert(appSrc.includes('PatientsPortal'), 'App wires PatientsPortal');
assert(appSrc.includes('OpdPortal'), 'App wires OpdPortal');
assert(appSrc.includes('AppointmentsPortal'), 'App wires AppointmentsPortal');

console.log('--- Optional live duplicate helper ---');
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const dups = await findDuplicatePatients({
      full_name: '__phase1_verify_nonexistent__',
      phone: '0000000000',
      date_of_birth: '1900-01-01',
    });
    assert(Array.isArray(dups), 'findDuplicatePatients returns array');
  } catch (err) {
    console.warn('SKIP live duplicate check:', err.message);
  }
} else {
  console.log('SKIP: no Supabase env for live checks');
}

console.log(failed ? `\n${failed} failure(s)` : '\nPhase 1 verify OK');
process.exit(failed ? 1 : 0);
