/**
 * Phase 0 acceptance checks (offline where possible).
 * Usage: node scripts/phase0-verify.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const {
  canSeePortal,
  getPortalAccess,
  canExportReports,
  toHmsRole,
} = await import('../src/permissions/hmsRoles.js');
const { buildExcelBuffer, buildPdfBuffer } = await import('../src/services/exportService.js');
const { AUDIT_ACTIONS } = await import('../src/services/auditService.js');

const outDir = path.join(__dirname, '../.phase0-artifacts');
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK  :', msg);
  }
}

console.log('--- Phase 0 permission matrix ---');
assert(toHmsRole('Doctor') === 'Doctor', 'Doctor maps to Doctor');
assert(toHmsRole('Clerk') === 'Clerk', 'Clerk maps to Clerk');
assert(toHmsRole('Receptionist') === 'Clerk', 'Receptionist aliases to Clerk');
assert(toHmsRole('Nurse') === 'Nurse', 'Nurse maps to Nurse');
assert(toHmsRole('Admin') === 'Administrator', 'Admin maps to Administrator');
assert(getPortalAccess('Pharmacy', 'billing') === 'none', 'Pharmacy has no billing access');
assert(canSeePortal('Pharmacy', 'billing', {}) === false, 'Pharmacy cannot see billing portal');
assert(canSeePortal('Accounts', 'billing', {}) === true, 'Accounts can see billing');
assert(canSeePortal('Doctor', 'hiv', {}) === false, 'Doctor without HIV flag cannot see HIV');
assert(canSeePortal('Doctor', 'hiv', { can_access_hiv: true }) === true, 'Doctor with HIV flag can see HIV');
assert(canSeePortal('Clerk', 'anc', {}) === false, 'Clerk cannot see ANC');
assert(canSeePortal('Nurse', 'pnc', {}) === true, 'Nurse can see PNC');
assert(canExportReports('Admin', {}) === true, 'Admin can export');
assert(canExportReports('Midwife', {}) === false, 'Midwife without flag cannot export');
assert(canExportReports('Midwife', { can_export_reports: true }) === true, 'Midwife with flag can export');
assert(AUDIT_ACTIONS.includes('failed_login'), 'Audit actions include failed_login');
assert(AUDIT_ACTIONS.includes('export'), 'Audit actions include export');
assert(AUDIT_ACTIONS.includes('permission_change'), 'Audit actions include permission_change');

console.log('--- Phase 0 export helpers ---');
const rows = [
  ['PT-00001', 'Amina Mensah', 'OPD', 'waiting'],
  ['PT-00002', 'Kwame Boateng', 'ANC', 'in_progress'],
];
const xlsx = await buildExcelBuffer('Sample', ['Patient ID', 'Name', 'Module', 'Status'], rows);
const pdf = await buildPdfBuffer('Phase 0 Sample', [
  { heading: 'Rows', table: { headers: ['Patient ID', 'Name', 'Module', 'Status'], rows } },
]);
const xlsxPath = path.join(outDir, 'phase0-sample.xlsx');
const pdfPath = path.join(outDir, 'phase0-sample.pdf');
fs.writeFileSync(xlsxPath, Buffer.from(xlsx));
fs.writeFileSync(pdfPath, Buffer.from(pdf));
assert(fs.statSync(xlsxPath).size > 100, `Excel written (${xlsxPath})`);
assert(fs.statSync(pdfPath).size > 100, `PDF written (${pdfPath})`);

console.log('--- Phase 0 optional live audit insert ---');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  const { writeAuditLog } = await import('../src/services/auditService.js');
  const { createClient } = await import('@supabase/supabase-js');

  await writeAuditLog({
    actorId: null,
    actorEmail: 'phase0-verify@local',
    actorRole: 'Admin',
    action: 'view',
    resourceType: 'phase0_verify',
    module: 'security',
    metadata: { source: 'phase0-verify.js' },
  });

  const admin = createClient(url, key);
  const { data, error } = await admin
    .from('audit_logs')
    .select('id, action, resource_type, created_at')
    .eq('resource_type', 'phase0_verify')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('WARN: audit probe failed (apply migration?):', error.message);
  } else if (!data?.length) {
    console.warn('WARN: audit insert may have failed silently — check action CHECK constraint / migration');
  } else {
    assert(true, 'Sample audit log row present');
  }
} else {
  console.warn('SKIP: SUPABASE_URL / SERVICE_ROLE_KEY not set — audit live insert skipped');
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Phase 0 local checks passed');
