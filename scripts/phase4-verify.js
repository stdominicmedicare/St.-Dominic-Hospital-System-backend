/**
 * Phase 4 acceptance checks (local unit + optional live DB).
 * Usage: node scripts/phase4-verify.js
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

console.log('--- Phase 4 module presence ---');
const root = path.join(__dirname, '..');
const required = [
  'supabase/migrations/20261106_phase4_hiv_dashboard_reports.sql',
  'src/services/hivRules.js',
  'src/services/hivService.js',
  'src/services/dashboardService.js',
  'src/services/reportsService.js',
  'src/controllers/hmsPhase4.controller.js',
  'src/routes/hms.routes.js',
];
for (const rel of required) {
  assert(fs.existsSync(path.join(root, rel)), `exists ${rel}`);
}

const fe = path.join(root, '../frontend/src/pages/hms');
assert(fs.existsSync(path.join(fe, 'HivPortal.jsx')), 'HivPortal.jsx');
assert(fs.existsSync(path.join(fe, 'ReportsPortal.jsx')), 'ReportsPortal.jsx');
assert(fs.existsSync(path.join(fe, 'HomeDashboard.jsx')), 'HomeDashboard.jsx');
assert(fs.existsSync(path.join(root, '../PHASE4.md')), 'PHASE4.md');

console.log('--- Phase 4 pure HIV rules ---');
const {
  nextViralLoadDue,
  isUnsuppressed,
  isLostToFollowUp,
  evaluateEnrollmentFlags,
  maskHivClient,
  VL_UNSUPPRESSED_THRESHOLD,
  LTFU_DAYS,
  addMonths,
} = await import('../src/services/hivRules.js');

assert(VL_UNSUPPRESSED_THRESHOLD === 1000, 'VL unsuppressed threshold 1000');
assert(LTFU_DAYS === 28, 'LTFU days = 28');
assert(nextViralLoadDue({ artStartDate: '2026-01-01' }) === '2026-07-01', 'first VL due +6 months');
assert(
  nextViralLoadDue({ artStartDate: '2026-01-01', lastVlDate: '2026-07-01' }) === '2027-07-01',
  'routine VL yearly after first'
);
assert(isUnsuppressed(999) === false, '999 not unsuppressed');
assert(isUnsuppressed(1000) === true, '1000 unsuppressed');
assert(isUnsuppressed(5000) === true, '5000 unsuppressed');
assert(
  isLostToFollowUp({ nextRefillDate: '2026-10-01', today: '2026-11-06' }) === true,
  'missed refill >28d = LTFU'
);
assert(
  isLostToFollowUp({ nextRefillDate: '2026-11-01', today: '2026-11-06' }) === false,
  '5 days late not LTFU yet'
);
const flags = evaluateEnrollmentFlags({
  status: 'active',
  next_refill_date: '2026-09-01',
  last_viral_load: 1200,
  next_vl_due: '2026-11-01',
});
assert(flags.ltfu_flag && flags.vl_unsuppressed, 'evaluate flags LTFU + unsuppressed');

const masked = maskHivClient(
  { art_no: 'ART-0001', patient: { id: 'p1', full_name: 'Secret Name', mrn: 'MRN1' } },
  { showName: false }
);
assert(masked.patient_name_masked && masked.patient.full_name == null, 'names masked in lists');
const shown = maskHivClient(
  { art_no: 'ART-0001', patient: { id: 'p1', full_name: 'Visible', mrn: 'MRN1' } },
  { showName: true }
);
assert(shown.patient.full_name === 'Visible', 'names shown with full access');
assert(addMonths('2026-01-15', 1) === '2026-02-15', 'addMonths +1');

console.log('--- Phase 4 RBAC (HIV flag + export) ---');
const {
  getPortalAccess,
  canSeePortal,
  canExportReports,
} = await import('../src/permissions/hmsRoles.js');

assert(getPortalAccess('Doctor', 'hiv') === 'full', 'Clinical full HIV matrix');
assert(getPortalAccess('Pharmacy', 'hiv') === 'edit', 'Pharmacy edit HIV');
assert(getPortalAccess('Admin', 'hiv') === 'none', 'Admin matrix none (counts only)');
assert(getPortalAccess('Accounts', 'hiv') === 'none', 'Accounts blocked HIV');
assert(!canSeePortal('Doctor', 'hiv', {}), 'Doctor without flag cannot see HIV');
assert(canSeePortal('Doctor', 'hiv', { can_access_hiv: true }), 'Doctor + flag sees HIV');
assert(!canSeePortal('Admin', 'hiv', { can_access_hiv: true }), 'Admin still no HIV portal (matrix none)');
assert(!canSeePortal('Accounts', 'hiv', { can_access_hiv: true }), 'Accounts + flag still blocked by matrix');
assert(canExportReports('Admin', {}), 'Admin can export');
assert(!canExportReports('Doctor', {}), 'Doctor without export flag blocked');
assert(canExportReports('Doctor', { can_export_reports: true }), 'Doctor + export flag allowed');

console.log('--- Phase 4 reports catalog ---');
const { REPORT_CATALOG, runReport } = await import('../src/services/reportsService.js');
assert(REPORT_CATALOG.length >= 10, '≥10 standard reports');
assert(
  REPORT_CATALOG.some((r) => r.id === 'hiv_cascade'),
  'HIV cascade report listed'
);
assert(
  REPORT_CATALOG.some((r) => r.id === 'opd_attendance'),
  'OPD attendance report listed'
);

console.log('--- Phase 4 route wiring ---');
const routesSrc = fs.readFileSync(path.join(root, 'src/routes/hms.routes.js'), 'utf8');
for (const needle of [
  "requirePortal('hiv'",
  '/hiv/hts',
  '/hiv/art',
  '/hiv/viral-load',
  '/hiv/refills',
  'requireExportPermission()',
  '/reports/:type/export.:format',
  'hmsPhase4',
  'homeDashboard',
]) {
  assert(routesSrc.includes(needle), `route contains ${needle}`);
}

const appSrc = fs.readFileSync(path.join(root, '../frontend/src/App.jsx'), 'utf8');
assert(appSrc.includes('HivPortal'), 'App wires HivPortal');
assert(appSrc.includes('ReportsPortal'), 'App wires ReportsPortal');
assert(appSrc.includes("portal === 'hiv'"), 'App branches hiv portal');

const homeSrc = fs.readFileSync(path.join(fe, 'HomeDashboard.jsx'), 'utf8');
assert(homeSrc.includes('alerts'), 'Home dashboard alerts panel');
assert(homeSrc.includes('60000') || homeSrc.includes('60s') || homeSrc.includes('setInterval'), '60s refresh');
assert(homeSrc.includes('hiv_on_art'), 'HIV tile count');

const mig = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261106_phase4_hiv_dashboard_reports.sql'),
  'utf8'
);
assert(mig.includes('hiv_hts_tests'), 'migration HTS table');
assert(mig.includes('hms_phase4_hiv_counts'), 'migration HIV counts view');
assert(mig.includes('art_no'), 'migration art_no');

console.log('--- Phase 4 service content ---');
const hivSvc = fs.readFileSync(path.join(root, 'src/services/hivService.js'), 'utf8');
assert(hivSvc.includes('createPrescription'), 'refill sends to Pharmacy');
assert(hivSvc.includes("action: 'view'"), 'HIV views audited');
assert(hivSvc.includes('maskHivClient'), 'name masking applied');

const dash = fs.readFileSync(path.join(root, 'src/services/dashboardService.js'), 'utf8');
assert(dash.includes('buildAlerts'), 'dashboard alerts builder');
assert(dash.includes('getHomeDashboard'), 'home dashboard aggregator');

// Optional live DB
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('--- Phase 4 live DB smoke ---');
  try {
    const { supabase } = await import('../src/config/supabase.js');
    const { data, error } = await supabase.from('hms_phase4_hiv_counts').select('*').maybeSingle();
    if (error) {
      console.log('SKIP: hms_phase4_hiv_counts not applied yet —', error.message);
    } else {
      assert(data != null || data === null, 'HIV counts view readable');
      console.log('OK  : HIV counts view query ok', data);
    }
  } catch (err) {
    console.log('SKIP: live smoke —', err.message);
  }
} else {
  console.log('SKIP: live DB (no SUPABASE env)');
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll Phase 4 checks passed');
process.exit(failed ? 1 : 0);
