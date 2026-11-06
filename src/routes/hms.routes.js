/**
 * Phase 0–5 HMS routes (patient flow … HIV/reports + users/security).
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  requirePortal,
  requireFlag,
  requireExportPermission,
  requireOpdAction,
  canSeePortal,
  normalizeFlags,
  toHmsRole,
} from '../middleware/permissions.js';
import { PORTAL_MATRIX } from '../permissions/hmsRoles.js';
import { writeAuditLog } from '../services/auditService.js';
import { createEncounter, listEncounters } from '../services/encounterService.js';
import {
  buildExcelBuffer,
  buildPdfBuffer,
  sendBinary,
} from '../services/exportService.js';
import * as p1 from '../controllers/hmsPhase1.controller.js';
import * as p2 from '../controllers/hmsPhase2.controller.js';
import * as p3 from '../controllers/hmsPhase3.controller.js';
import * as p4 from '../controllers/hmsPhase4.controller.js';
import * as p5 from '../controllers/hmsPhase5.controller.js';

const router = Router();
router.use(authMiddleware);

const PORTALS = Object.keys(PORTAL_MATRIX);

/** GET /api/hms/me — HMS role bucket + flags + visible portals (for menu). */
router.get('/me', (req, res) => {
  const flags = normalizeFlags(req.profile || {});
  const visiblePortals = PORTALS.filter((p) => canSeePortal(req.role, p, flags));
  res.json({
    role: req.role,
    hmsRole: toHmsRole(req.role),
    flags,
    visiblePortals,
  });
});

/**
 * GET /api/hms/portals/:portalKey
 * Placeholder portal probe — returns 403 if role/flag cannot access.
 */
router.get('/portals/:portalKey', (req, res) => {
  const portalKey = String(req.params.portalKey || '').toLowerCase();
  if (!PORTAL_MATRIX[portalKey]) {
    return res.status(404).json({ error: 'Unknown portal', portal: portalKey });
  }
  return requirePortal(portalKey)(req, res, () => {
    res.json({
      ok: true,
      portal: portalKey,
      access: req.portalAccess,
      hmsRole: req.hmsRole,
      phase: 0,
      message: 'Portal placeholder — full UI in later phases',
    });
  });
});

/** POST /api/hms/audit/sample — create a sample audit log row. */
router.post('/audit/sample', requirePortal('security'), async (req, res) => {
  try {
    await writeAuditLog({
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: req.body?.action || 'view',
      resourceType: 'phase0_sample',
      resourceId: null,
      module: req.body?.module || 'security',
      metadata: { note: 'Phase 0 sample audit row', ...(req.body?.metadata || {}) },
      req,
    });
    res.status(201).json({ ok: true, message: 'Sample audit log written' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/hms/encounters — create unified encounter row. */
router.post('/encounters', requirePortal('patients'), async (req, res) => {
  try {
    const { patientId, module, status, metadata, sourceTable, sourceId, dateTime } = req.body || {};
    const row = await createEncounter({
      patientId,
      module,
      staffId: req.user.id,
      status,
      metadata,
      sourceTable,
      sourceId,
      dateTime,
    });
    await writeAuditLog({
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'create',
      resourceType: 'encounter',
      resourceId: row.id,
      patientId,
      module,
      after: row,
      req,
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/hms/encounters — list encounters (foundation for KPIs/reports). */
router.get('/encounters', requirePortal('reports'), async (req, res) => {
  try {
    const { data, error, count } = await listEncounters({
      patientId: req.query.patientId,
      module: req.query.module,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ data, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const SAMPLE_ROWS = [
  ['PT-00001', 'Amina Mensah', 'OPD', 'waiting'],
  ['PT-00002', 'Kwame Boateng', 'ANC', 'in_progress'],
  ['PT-00003', 'Efua Asante', 'Lab', 'done'],
];

/** GET /api/hms/export/sample.xlsx — gated Excel sample. */
router.get('/export/sample.xlsx', requireExportPermission(), async (req, res) => {
  try {
    const buffer = await buildExcelBuffer(
      'Sample',
      ['Patient ID', 'Name', 'Module', 'Status'],
      SAMPLE_ROWS
    );
    await writeAuditLog({
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'export',
      resourceType: 'report',
      module: 'reports',
      metadata: { format: 'xlsx', name: 'phase0-sample' },
      req,
    });
    sendBinary(res, buffer, {
      filename: 'phase0-sample.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/hms/export/sample.pdf — gated PDF sample. */
router.get('/export/sample.pdf', requireExportPermission(), async (req, res) => {
  try {
    const buffer = await buildPdfBuffer('Phase 0 Sample Export', [
      {
        heading: 'Encounters (sample)',
        table: {
          headers: ['Patient ID', 'Name', 'Module', 'Status'],
          rows: SAMPLE_ROWS,
        },
      },
    ]);
    await writeAuditLog({
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorRole: req.role,
      action: 'export',
      resourceType: 'report',
      module: 'reports',
      metadata: { format: 'pdf', name: 'phase0-sample' },
      req,
    });
    sendBinary(res, buffer, {
      filename: 'phase0-sample.pdf',
      contentType: 'application/pdf',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// Phase 1 — Patients / OPD / Appointments (+ Home counts)
// ===========================================================================

/** Home tiles: Phase 1–4 KPIs + alerts (refresh ~60s on UI) */
router.get('/home-counts', requirePortal('home'), p4.homeDashboard);
router.get('/pending-counts', requirePortal('home'), p4.homeDashboard);
router.get('/home/alerts', requirePortal('home'), p4.homeAlerts);

router.get('/providers', requirePortal('appointments'), p1.staffProviders);
router.get('/icd10', requirePortal('opd'), p1.icd10Search);

// --- Patients (13) ---
router.get('/patients', requirePortal('patients'), p1.patientsList);
router.get('/patients/kpis', requirePortal('patients'), p1.patientsKpis);
router.post('/patients/check-duplicates', requirePortal('patients', { minLevel: 'edit' }), p1.patientsCheckDuplicates);
router.post('/patients/register', requirePortal('patients', { minLevel: 'edit' }), p1.patientsRegister);
router.get('/patients/export.xlsx', requirePortal('patients'), requireExportPermission(), p1.patientsExportXlsx);
router.get('/patients/export.pdf', requirePortal('patients'), requireExportPermission(), p1.patientsExportPdf);
router.post('/patients/merge', requirePortal('patients', { minLevel: 'full' }), p1.patientsMerge);
router.get('/patients/:id', requirePortal('patients'), p1.patientsGet);
router.patch('/patients/:id', requirePortal('patients', { minLevel: 'edit' }), p1.patientsUpdate);
router.post('/patients/:id/deactivate', requirePortal('patients', { minLevel: 'full' }), p1.patientsDeactivate);
router.get('/patients/:id/timeline', requirePortal('patients'), p1.patientsTimeline);

// --- OPD queue + workflow (01); handoffs remain below ---
router.get('/opd/queue', requirePortal('opd'), p1.opdQueue);
router.get('/opd/kpis', requirePortal('opd'), p1.opdKpis);
router.post(
  '/opd/check-in',
  requirePortal('opd', { minLevel: 'edit' }),
  requireOpdAction('check_in'),
  p1.opdCheckIn
);
router.patch(
  '/opd/:id',
  requirePortal('opd', { minLevel: 'edit' }),
  requireOpdAction('triage'),
  p1.opdUpdate
);
router.post(
  '/opd/:id/follow-up',
  requirePortal('opd', { minLevel: 'edit' }),
  requireOpdAction('consult'),
  p1.opdBookFollowUp
);

// --- Appointments (02) ---
router.get('/appointments', requirePortal('appointments'), p1.appointmentsList);
router.get('/appointments/kpis', requirePortal('appointments'), p1.appointmentsKpis);
router.post('/appointments', requirePortal('appointments', { minLevel: 'edit' }), p1.appointmentsBook);
router.patch('/appointments/:id', requirePortal('appointments', { minLevel: 'edit' }), p1.appointmentsPatch);
router.post('/appointments/mark-missed', requirePortal('appointments', { minLevel: 'edit' }), p1.appointmentsMarkMissed);

// ===========================================================================
// Phase 2 — clinical → dispense → pay loop
// ===========================================================================

// --- OPD handoffs (consumed by Lab/Pharmacy/Billing) ---
router.post(
  '/opd/:visitId/order-lab',
  requirePortal('opd', { minLevel: 'edit' }),
  requireOpdAction('consult'),
  p2.opdOrderLab
);
router.post(
  '/opd/:visitId/prescribe',
  requirePortal('opd', { minLevel: 'edit' }),
  requireOpdAction('consult'),
  p2.opdPrescribe
);
router.post(
  '/opd/:visitId/complete',
  requirePortal('opd', { minLevel: 'edit' }),
  requireOpdAction('consult'),
  p2.opdComplete
);

// --- Laboratory (03) ---
router.get('/lab/worklist', requirePortal('lab'), p2.labWorklist);
router.get('/lab/catalogue', requirePortal('lab'), p2.labCatalogue);
router.post('/lab/catalogue', requirePortal('lab', { minLevel: 'edit' }), p2.labCatalogueUpsert);
router.post('/lab/orders', requirePortal('lab', { minLevel: 'edit' }), p2.labCreateWalkIn);
router.patch('/lab/orders/:id', requirePortal('lab', { minLevel: 'edit' }), p2.labAdvance);
router.post('/lab/orders/:id/send', requirePortal('lab', { minLevel: 'edit' }), p2.labSend);
router.post('/lab/items/:itemId/result', requirePortal('lab', { minLevel: 'edit' }), p2.labEnterResult);
router.post(
  '/lab/items/:itemId/verify',
  requirePortal('lab', { minLevel: 'edit' }),
  requireFlag('can_verify_lab'),
  p2.labVerify
);
router.post(
  '/lab/items/:itemId/version',
  requirePortal('lab', { minLevel: 'edit' }),
  requireFlag('can_verify_lab'),
  p2.labVersionResult
);

// --- Pharmacy (04) ---
router.get('/pharmacy/to-dispense', requirePortal('pharmacy'), p2.pharmacyToDispense);
router.post('/pharmacy/prescriptions/:id/dispense', requirePortal('pharmacy', { minLevel: 'edit' }), p2.pharmacyDispense);
router.get('/pharmacy/stock', requirePortal('pharmacy'), p2.pharmacyStock);
router.post('/pharmacy/receive', requirePortal('pharmacy', { minLevel: 'edit' }), p2.pharmacyReceive);
router.post('/pharmacy/adjust', requirePortal('pharmacy', { minLevel: 'edit' }), p2.pharmacyAdjust);
router.get('/pharmacy/expiring', requirePortal('pharmacy'), p2.pharmacyExpiring);
router.get('/pharmacy/movements', requirePortal('pharmacy'), p2.pharmacyMovements);

// --- Billing (11) ---
router.get('/billing/invoices', requirePortal('billing'), p2.billingInvoices);
router.get('/billing/invoices/:id', requirePortal('billing'), p2.billingInvoiceDetail);
router.post('/billing/invoices/:id/pay', requirePortal('billing', { minLevel: 'edit' }), p2.billingPay);
router.post(
  '/billing/invoices/:id/waive',
  requirePortal('billing', { minLevel: 'edit' }),
  requireFlag('can_give_discounts'),
  p2.billingWaive
);
router.post('/billing/invoices/:id/insurance', requirePortal('billing', { minLevel: 'edit' }), p2.billingInsurance);
router.post('/billing/invoices/:id/credit-note', requirePortal('billing', { minLevel: 'full' }), p2.billingCreditNote);
router.post('/billing/manual-charge', requirePortal('billing', { minLevel: 'edit' }), p2.billingManualCharge);
router.post('/billing/ensure-open', requirePortal('billing', { minLevel: 'edit' }), p2.billingEnsureOpen);
router.get('/billing/price-list', requirePortal('billing'), p2.billingPriceList);
router.post('/billing/price-list', requirePortal('billing', { minLevel: 'full' }), p2.billingPriceUpsert);
router.get('/billing/cash-summary', requirePortal('billing'), p2.billingCashSummary);
router.get('/billing/payments/:paymentId/receipt.pdf', requirePortal('billing'), p2.billingReceiptPdf);

// ===========================================================================
// Phase 3 — MCH suite (05–09)
// ===========================================================================

router.get('/mch/home-counts', requirePortal('home'), p3.mchHomeCounts);

// --- ANC (05) ---
router.get('/anc/kpis', requirePortal('anc'), p3.ancKpis);
router.get('/anc/pregnancies', requirePortal('anc'), p3.ancList);
router.get('/anc/defaulters', requirePortal('anc'), p3.ancDefaulters);
router.post('/anc/pregnancies', requirePortal('anc', { minLevel: 'edit' }), p3.ancRegister);
router.get('/anc/pregnancies/:pregnancyId/visits', requirePortal('anc'), p3.ancVisits);
router.post('/anc/visits', requirePortal('anc', { minLevel: 'edit' }), p3.ancSaveVisit);
router.post('/anc/pregnancies/:pregnancyId/refer-maternity', requirePortal('anc', { minLevel: 'edit' }), p3.ancReferMaternity);

// --- Maternity (06) — write requires edit (Accounts/Lab/Pharmacy blocked by matrix) ---
router.get('/maternity/kpis', requirePortal('maternity'), p3.maternityKpis);
router.get('/maternity/board', requirePortal('maternity'), p3.maternityBoard);
router.get('/maternity/deliveries', requirePortal('maternity'), p3.maternityDeliveries);
router.post('/maternity/admit', requirePortal('maternity', { minLevel: 'edit' }), p3.maternityAdmit);
router.get('/maternity/:admissionId/partograph', requirePortal('maternity'), p3.maternityPartographList);
router.post('/maternity/:admissionId/partograph', requirePortal('maternity', { minLevel: 'edit' }), p3.maternityPartographAdd);
router.post('/maternity/deliveries', requirePortal('maternity', { minLevel: 'edit' }), p3.maternityDelivery);

// --- PNC (07) ---
router.get('/pnc/kpis', requirePortal('pnc'), p3.pncKpis);
router.get('/pnc/due', requirePortal('pnc'), p3.pncDue);
router.post('/pnc/visits', requirePortal('pnc', { minLevel: 'edit' }), p3.pncSaveVisit);

// --- Immunization (08) ---
router.get('/immunization/kpis', requirePortal('immunization'), p3.immKpis);
router.get('/immunization/schedule', requirePortal('immunization'), p3.immScheduleList);
router.post('/immunization/schedule', requirePortal('immunization', { minLevel: 'full' }), p3.immScheduleUpsert);
router.get('/immunization/cards', requirePortal('immunization'), p3.immCards);
router.get('/immunization/cards/:patientId', requirePortal('immunization'), p3.immCard);
router.post('/immunization/register', requirePortal('immunization', { minLevel: 'edit' }), p3.immRegisterChild);
router.post('/immunization/doses', requirePortal('immunization', { minLevel: 'edit' }), p3.immRecordDose);

// --- Family planning (09) ---
router.get('/fp/kpis', requirePortal('fp'), p3.fpKpis);
router.get('/fp/methods', requirePortal('fp'), p3.fpMethods);
router.get('/fp/clients', requirePortal('fp'), p3.fpClients);
router.post('/fp/encounters', requirePortal('fp', { minLevel: 'edit' }), p3.fpSave);

// ===========================================================================
// Phase 4 — HIV (10) + Reports (12)
// HIV: STRICT — requirePortal('hiv') enforces can_access_hiv + matrix level
// ===========================================================================

router.get('/hiv/kpis', requirePortal('hiv'), p4.hivKpis);
router.post('/hiv/sync-ltfu', requirePortal('hiv', { minLevel: 'edit' }), p4.hivSyncLtfu);

router.get('/hiv/hts', requirePortal('hiv'), p4.hivHtsList);
router.post('/hiv/hts', requirePortal('hiv', { minLevel: 'edit' }), p4.hivHtsCreate);

router.get('/hiv/art', requirePortal('hiv'), p4.hivArtList);
router.post('/hiv/art', requirePortal('hiv', { minLevel: 'edit' }), p4.hivArtEnroll);
router.get('/hiv/art/:id', requirePortal('hiv'), p4.hivArtGet);
router.patch('/hiv/art/:id', requirePortal('hiv', { minLevel: 'edit' }), p4.hivArtPatch);

router.get('/hiv/viral-load', requirePortal('hiv'), p4.hivVlList);
router.post('/hiv/viral-load', requirePortal('hiv', { minLevel: 'edit' }), p4.hivVlCreate);

router.get('/hiv/refills', requirePortal('hiv'), p4.hivRefills);
router.post('/hiv/refills', requirePortal('hiv', { minLevel: 'edit' }), p4.hivRefillMark);

// --- Reports (12) ---
router.get('/reports/catalog', requirePortal('reports'), p4.reportsCatalog);
router.get('/reports/aligned-counts', requirePortal('reports'), p4.reportsAlignedCounts);
router.get('/reports/:type', requirePortal('reports'), p4.reportsRun);
router.get(
  '/reports/:type/export.:format',
  requirePortal('reports'),
  requireExportPermission(),
  p4.reportsExport
);

// ===========================================================================
// Phase 5 — Users & roles (14) + Security / audit / backups (15)
// Administrator only via requirePortal('roles'|'security')
// ===========================================================================

router.get('/users/kpis', requirePortal('roles'), p5.usersKpis);
router.get('/users/matrix', requirePortal('roles'), p5.usersMatrix);
router.get('/users', requirePortal('roles'), p5.usersList);
router.post('/users', requirePortal('roles'), p5.usersCreate);
router.patch('/users/:id', requirePortal('roles'), p5.usersUpdate);
router.get('/users/export.:format', requirePortal('roles'), p5.usersExport);

router.get('/security/kpis', requirePortal('security'), p5.securityKpis);
router.get('/security/policy', requirePortal('security'), p5.securityPolicy);
router.get('/security/audit', requirePortal('security'), p5.auditList);
router.get('/security/audit/export.:format', requirePortal('security'), p5.auditExport);
router.patch('/security/audit/:id', requirePortal('security'), p5.auditMutateRejected);
router.delete('/security/audit/:id', requirePortal('security'), p5.auditMutateRejected);
router.get('/security/backups', requirePortal('security'), p5.backupsStatus);
router.post('/security/backups/run', requirePortal('security'), p5.backupsRunNow);
router.post('/security/backups/test-restore', requirePortal('security'), p5.backupsTestRestore);

export default router;
