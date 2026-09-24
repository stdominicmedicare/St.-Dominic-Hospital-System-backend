import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import {
  listLabTests,
  listLabOrders,
  getLabOrder,
  createLabOrder,
  updateLabOrderStatus,
  enterLabResult,
  labWorklist,
} from '../controllers/lab.controller.js';

const router = Router();
router.use(authMiddleware);

router.get('/tests', requireRole('Admin', 'Laboratory', 'Doctor', 'Nurse', 'Midwife'), listLabTests);
router.get('/worklist', requireRole('Admin', 'Laboratory'), labWorklist);
router.get('/orders', requireRole('Admin', 'Laboratory', 'Doctor', 'Nurse', 'Midwife'), listLabOrders);
router.get('/orders/:id', requireRole('Admin', 'Laboratory', 'Doctor', 'Nurse', 'Midwife'), getLabOrder);
router.post('/orders', requireRole('Admin', 'Doctor', 'Nurse', 'Midwife', 'Laboratory'), createLabOrder);
router.patch('/orders/:id', requireRole('Admin', 'Laboratory'), updateLabOrderStatus);
router.post('/items/:itemId/result', requireRole('Admin', 'Laboratory'), enterLabResult);

export default router;
