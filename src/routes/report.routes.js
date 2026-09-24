/**
 * Reports routes: catalog + exportable standard reports.
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import { listReportTypes, getReport } from '../controllers/report.controller.js';

const router = Router();
const REPORT_ROLES = ['Admin', 'RecordsOfficer', 'Doctor', 'Accounts', 'Midwife'];

router.use(authMiddleware);
router.use(requireRole(...REPORT_ROLES));

router.get('/', listReportTypes);
router.get('/:type', getReport);

export default router;
