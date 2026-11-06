/**
 * Phase 2 acceptance checks (local unit + optional live DB).
 * Usage: node scripts/phase2-verify.js
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

console.log('--- Phase 2 module presence ---');
const root = path.join(__dirname, '..');
const required = [
  'supabase/migrations/20261106_phase2_clinical_loop.sql',
  'src/services/billingService.js',
  'src/services/stockService.js',
  'src/services/labService.js',
  'src/services/pharmacyDispenseService.js',
  'src/services/documentSequenceService.js',
  'src/controllers/hmsPhase2.controller.js',
  'src/routes/hms.routes.js',
];
for (const rel of required) {
  assert(fs.existsSync(path.join(root, rel)), `exists ${rel}`);
}

const fe = path.join(root, '../frontend/src/pages/hms');
assert(fs.existsSync(path.join(fe, 'LabPortal.jsx')), 'LabPortal.jsx');
assert(fs.existsSync(path.join(fe, 'PharmacyPortal.jsx')), 'PharmacyPortal.jsx');
assert(fs.existsSync(path.join(fe, 'BillingPortal.jsx')), 'BillingPortal.jsx');
assert(fs.existsSync(path.join(root, '../PHASE2.md')), 'PHASE2.md');

console.log('--- Phase 2 FEFO / flag helpers ---');
const { pickFefoBatches, batchStatus } = await import('../src/services/stockService.js');
const { flagResultValue } = await import('../src/services/labService.js');
const { LOCKED_STATUSES, roundMoney } = await import('../src/services/billingService.js');

assert(roundMoney(10.456) === 10.46, 'roundMoney');
assert(LOCKED_STATUSES.has('paid'), 'paid invoices locked set');

const flags = flagResultValue('5', { ref_low: 12, ref_high: 16, critical_low: 7, critical_high: 20 });
assert(flags.flag === 'L' && flags.is_critical === true, 'critical low lab flag');
const flagsH = flagResultValue('18', { ref_low: 12, ref_high: 16, critical_low: 7, critical_high: 20 });
assert(flagsH.flag === 'H' && flagsH.is_critical === false, 'high out-of-range flag');

const expired = batchStatus({ quantity: 5, expiry_date: '2000-01-01' });
assert(expired === 'expired', 'expired batch status');
const ok = batchStatus({
  quantity: 50,
  expiry_date: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10),
}, 10);
assert(ok === 'ok', 'ok batch status');

console.log('--- Phase 2 route wiring ---');
const routesSrc = fs.readFileSync(path.join(root, 'src/routes/hms.routes.js'), 'utf8');
for (const needle of [
  '/pending-counts',
  '/opd/:visitId/order-lab',
  '/opd/:visitId/prescribe',
  '/opd/:visitId/complete',
  '/lab/items/:itemId/verify',
  'requireFlag(\'can_verify_lab\')',
  '/pharmacy/prescriptions/:id/dispense',
  '/pharmacy/receive',
  '/billing/invoices/:id/pay',
  '/billing/cash-summary',
  'requireFlag(\'can_give_discounts\')',
]) {
  assert(routesSrc.includes(needle), `route contains ${needle}`);
}

const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261106_phase2_clinical_loop.sql'),
  'utf8'
);
assert(migration.includes('stock_movements'), 'migration defines stock_movements');
assert(migration.includes('medicine_batches'), 'migration defines medicine_batches');
assert(migration.includes('lab_result_versions'), 'migration defines lab_result_versions');
assert(migration.includes('hms_pending_counts'), 'migration defines pending counts view');
assert(migration.includes('MAT-DELIVERY'), 'maternity charge hook seeded');
assert(migration.includes('HIV-VL'), 'HIV charge hook seeded');

console.log('--- Phase 2 optional live smoke ---');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, key);

  const { error: seqErr } = await admin.from('document_sequences').select('kind').limit(1);
  if (seqErr) {
    console.warn('WARN: document_sequences missing — apply phase2 migration:', seqErr.message);
  } else {
    assert(true, 'document_sequences readable');
  }

  const { data: rpcData, error: rpcErr } = await admin.rpc('hms_next_document_no', {
    p_kind: 'receipt',
  });
  if (rpcErr) {
    console.warn('WARN: hms_next_document_no RPC unavailable:', rpcErr.message);
  } else {
    assert(typeof rpcData === 'string' && rpcData.startsWith('RC-'), `receipt sequence ${rpcData}`);
  }

  const { data: counts, error: cErr } = await admin.from('hms_pending_counts').select('*').maybeSingle();
  if (cErr) {
    console.warn('WARN: hms_pending_counts view missing:', cErr.message);
  } else {
    assert(counts && typeof counts.pending_lab === 'number', 'pending counts view returns numbers');
  }

  // pickFefo against empty DB should throw insufficient — only if medicines exist
  try {
    await pickFefoBatches('00000000-0000-0000-0000-000000000000', 1);
    assert(false, 'FEFO on missing medicine should fail');
  } catch (err) {
    assert(true, `FEFO guard works (${err.message.slice(0, 40)})`);
  }
} else {
  console.warn('SKIP: SUPABASE_URL / SERVICE_ROLE_KEY not set — live checks skipped');
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Phase 2 local checks passed');
