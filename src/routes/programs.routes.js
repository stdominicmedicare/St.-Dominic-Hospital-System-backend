import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import {
  listVaccines,
  listImmunizations,
  recordImmunization,
  listFpMethods,
  listFpEncounters,
  createFpEncounter,
  listHivEnrollments,
  enrollHiv,
  getHivChart,
  addHivVisit,
  addHivLab,
} from '../controllers/programs.controller.js';

const router = Router();
router.use(authMiddleware);

const CLINICAL = ['Admin', 'Doctor', 'Nurse', 'Midwife'];

router.get('/vaccines', requireRole(...CLINICAL), listVaccines);
router.get('/immunizations', requireRole(...CLINICAL), listImmunizations);
router.post('/immunizations', requireRole(...CLINICAL), recordImmunization);

router.get('/fp/methods', requireRole(...CLINICAL), listFpMethods);
router.get('/fp/encounters', requireRole(...CLINICAL), listFpEncounters);
router.post('/fp/encounters', requireRole(...CLINICAL), createFpEncounter);

router.get('/hiv/enrollments', requireRole(...CLINICAL), listHivEnrollments);
router.post('/hiv/enrollments', requireRole(...CLINICAL), enrollHiv);
router.get('/hiv/enrollments/:id', requireRole(...CLINICAL), getHivChart);
router.post('/hiv/visits', requireRole(...CLINICAL), addHivVisit);
router.post('/hiv/labs', requireRole(...CLINICAL), addHivLab);

export default router;
