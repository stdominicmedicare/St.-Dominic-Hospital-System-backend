import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import {
  listOpdVisits,
  createOpdVisit,
  updateOpdVisit,
  listFollowUps,
  createFollowUp,
  updateFollowUp,
} from '../controllers/opd.controller.js';

const router = Router();
router.use(authMiddleware);

const OPD_ROLES = ['Admin', 'Doctor', 'Nurse', 'Receptionist', 'Midwife', 'RecordsOfficer'];
router.get('/visits', requireRole(...OPD_ROLES), listOpdVisits);
router.post('/visits', requireRole('Admin', 'Receptionist', 'Nurse', 'Doctor', 'Midwife'), createOpdVisit);
router.patch('/visits/:id', requireRole('Admin', 'Receptionist', 'Nurse', 'Doctor', 'Midwife'), updateOpdVisit);

router.get('/follow-ups', requireRole(...OPD_ROLES), listFollowUps);
router.post('/follow-ups', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist', 'Midwife'), createFollowUp);
router.patch('/follow-ups/:id', requireRole('Admin', 'Doctor', 'Nurse', 'Receptionist', 'Midwife'), updateFollowUp);

export default router;
