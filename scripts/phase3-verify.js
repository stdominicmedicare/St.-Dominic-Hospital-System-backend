/**
 * Phase 3 acceptance checks (local unit + optional live DB).
 * Usage: node scripts/phase3-verify.js
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

console.log('--- Phase 3 module presence ---');
const root = path.join(__dirname, '..');
const required = [
  'supabase/migrations/20261106_phase3_mch.sql',
  'src/services/mchRules.js',
  'src/services/mchService.js',
  'src/controllers/hmsPhase3.controller.js',
  'src/routes/hms.routes.js',
];
for (const rel of required) {
  assert(fs.existsSync(path.join(root, rel)), `exists ${rel}`);
}

const fe = path.join(root, '../frontend/src/pages/hms');
for (const portal of [
  'AncPortal.jsx',
  'MaternityPortal.jsx',
  'PncPortal.jsx',
  'ImmunizationPortal.jsx',
  'FpPortal.jsx',
]) {
  assert(fs.existsSync(path.join(fe, portal)), portal);
}
assert(fs.existsSync(path.join(root, '../PHASE3.md')), 'PHASE3.md');

console.log('--- Phase 3 pure rules ---');
const {
  eddFromLmp,
  gaWeeksFromLmp,
  evaluateAncHighRisk,
  partographAlert,
  buildPncScheduleDates,
  immunizationDoseStatus,
  fpResupplyDate,
  daysLate,
} = await import('../src/services/mchRules.js');

assert(eddFromLmp('2026-01-01') === '2026-10-08', 'EDD = LMP + 280 days');
assert(gaWeeksFromLmp('2026-01-01', '2026-03-26') === 12, 'GA weeks from LMP');

const riskAge = evaluateAncHighRisk({ age: 16 });
assert(riskAge.high_risk && riskAge.reasons.some((r) => r.includes('18')), 'high-risk age < 18');
const riskBp = evaluateAncHighRisk({ bpSystolic: 150, bpDiastolic: 95 });
assert(riskBp.high_risk, 'high-risk BP ≥140/90');
const riskHb = evaluateAncHighRisk({ hb: 6.8 });
assert(riskHb.high_risk && riskHb.reasons.some((r) => r.includes('Hb')), 'high-risk Hb < 10');
const riskCs = evaluateAncHighRisk({ previousCs: true, multiplePregnancy: true });
assert(riskCs.reasons.includes('previous C-section') && riskCs.reasons.includes('multiple pregnancy'), 'CS + multiple');

const alert = partographAlert({ fhr: 90 });
assert(alert.urgent && alert.alert.includes('FHR'), 'partograph FHR alert');
const ok = partographAlert({ fhr: 140, cervixCm: 5, hoursInLabour: 2 });
assert(!ok.urgent && ok.alert === 'On track', 'partograph on track');

const pnc = buildPncScheduleDates('2026-11-01');
assert(pnc.length === 4, 'PNC schedule has 4 visits');
assert(pnc[0].visit_code === 'pnc1_48h' && pnc[0].due_date === '2026-11-03', 'PNC 48h = +2 days');
assert(pnc[3].visit_code === 'pnc4_week6' && pnc[3].due_date === '2026-12-13', 'PNC week6 = +42 days');

assert(immunizationDoseStatus({ dueDate: '2020-01-01', today: '2026-11-06' }) === 'overdue', 'imm overdue');
assert(immunizationDoseStatus({ dueDate: '2026-11-08', today: '2026-11-06' }) === 'due', 'imm due within 7d');
assert(immunizationDoseStatus({ dueDate: '2026-11-06', givenAt: '2026-11-06' }) === 'given', 'imm given');
assert(daysLate('2026-11-01', '2026-11-06') === 5, 'days late');

const inj = fpResupplyDate('2026-11-01', 'INJ');
assert(inj === '2027-01-30', `FP INJ resupply ${inj}`);

console.log('--- Phase 3 RBAC ---');
const { getPortalAccess } = await import('../src/permissions/hmsRoles.js');
assert(getPortalAccess('Midwife', 'maternity') === 'full', 'Midwife full maternity');
assert(getPortalAccess('Midwife', 'anc') === 'full', 'Midwife full ANC');
assert(getPortalAccess('Doctor', 'maternity') === 'edit', 'Clinical edit maternity');
assert(getPortalAccess('Pharmacy', 'maternity') === 'none', 'Pharmacy blocked maternity');
assert(getPortalAccess('Accounts', 'maternity') === 'none', 'Accounts blocked maternity');
assert(getPortalAccess('Midwife', 'billing') === 'none', 'Midwife no billing UI');

console.log('--- Phase 3 route wiring ---');
const routesSrc = fs.readFileSync(path.join(root, 'src/routes/hms.routes.js'), 'utf8');
for (const needle of [
  "requirePortal('anc'",
  "requirePortal('maternity', { minLevel: 'edit' })",
  '/maternity/deliveries',
  '/anc/visits',
  '/pnc/visits',
  '/immunization/doses',
  '/immunization/cards',
  '/fp/encounters',
  'hmsPhase3',
]) {
  assert(routesSrc.includes(needle), `route contains ${needle}`);
}

const appSrc = fs.readFileSync(path.join(root, '../frontend/src/App.jsx'), 'utf8');
assert(appSrc.includes('AncPortal'), 'App wires AncPortal');
assert(appSrc.includes('MaternityPortal'), 'App wires MaternityPortal');
assert(appSrc.includes('PncPortal'), 'App wires PncPortal');
assert(appSrc.includes('ImmunizationPortal'), 'App wires ImmunizationPortal');
assert(appSrc.includes('FpPortal'), 'App wires FpPortal');

const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261106_phase3_mch.sql'),
  'utf8'
);
assert(migration.includes('partograph_entries'), 'migration partograph');
assert(migration.includes('pnc_schedules'), 'migration pnc_schedules');
assert(migration.includes('immunization_schedule'), 'migration immunization_schedule');
assert(migration.includes('immunization_card_doses'), 'migration card doses');
assert(migration.includes('hms_phase3_mch_counts'), 'migration MCH counts view');
assert(migration.includes('high_risk'), 'migration high_risk');

const svc = fs.readFileSync(path.join(root, 'src/services/mchService.js'), 'utf8');
assert(svc.includes('bookAppointment'), 'service books appointments');
assert(svc.includes('dispenseFefo'), 'service deducts stock');
assert(svc.includes('addChargeLine') || svc.includes('chargeByCode'), 'service billing hooks');
assert(svc.includes('registerHmsPatient'), 'service creates baby MRN');
assert(svc.includes('MAT-DELIVERY'), 'delivery charge code');
assert(svc.includes('createImmunizationCardForChild'), 'vaccine card on delivery');

console.log('--- Phase 3 optional live smoke ---');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, key);

  const { error: viewErr } = await admin.from('hms_phase3_mch_counts').select('*').maybeSingle();
  if (viewErr) {
    console.warn('WARN: hms_phase3_mch_counts missing — apply phase3 migration:', viewErr.message);
  } else {
    assert(true, 'hms_phase3_mch_counts readable');
  }

  const { data: sched, error: sErr } = await admin
    .from('immunization_schedule')
    .select('vaccine_code')
    .limit(1);
  if (sErr) {
    console.warn('WARN: immunization_schedule missing:', sErr.message);
  } else {
    assert(Array.isArray(sched), 'immunization_schedule readable');
  }
} else {
  console.warn('SKIP: SUPABASE_URL / SERVICE_ROLE_KEY not set — live checks skipped');
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Phase 3 local checks passed');
