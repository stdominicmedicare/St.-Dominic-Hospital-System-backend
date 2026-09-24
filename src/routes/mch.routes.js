import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import {
  listPregnancies,
  createPregnancy,
  listAncVisits,
  createAncVisit,
  listAdmissions,
  createAdmission,
  recordDelivery,
  listPncVisits,
  createPncVisit,
  mchDueLists,
} from '../controllers/mch.controller.js';

const router = Router();
router.use(authMiddleware);

const MCH = ['Admin', 'Midwife', 'Doctor', 'Nurse'];
router.use(requireRole(...MCH));

router.get('/due', mchDueLists);
router.get('/pregnancies', listPregnancies);
router.post('/pregnancies', createPregnancy);
router.get('/anc-visits', listAncVisits);
router.post('/anc-visits', createAncVisit);
router.get('/admissions', listAdmissions);
router.post('/admissions', createAdmission);
router.post('/deliveries', recordDelivery);
router.get('/pnc-visits', listPncVisits);
router.post('/pnc-visits', createPncVisit);

export default router;
