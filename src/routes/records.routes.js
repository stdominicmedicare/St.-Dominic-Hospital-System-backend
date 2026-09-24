/**
 * Patient records routes: search, register, duplicates, merge, timeline.
 * Accessible by Admin, Doctor, Nurse, Receptionist, RecordsOfficer.
 * Patients may only access their own timeline.
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/roleGuard.js';
import {
  searchPatients,
  getPatientRecord,
  checkDuplicates,
  registerPatient,
  mergePatients,
  getPatientTimeline,
  updatePatientDemographics,
} from '../controllers/records.controller.js';
import { exportPatientRecord } from '../controllers/report.controller.js';

const router = Router();
const STAFF = ['Admin', 'Doctor', 'Nurse', 'Receptionist', 'RecordsOfficer', 'Midwife', 'Laboratory', 'Accounts'];
const REG_MERGE = ['Admin', 'Receptionist', 'RecordsOfficer'];

router.use(authMiddleware);

router.get('/search', requireRole(...STAFF), searchPatients);
router.post('/check-duplicates', requireRole(...REG_MERGE), checkDuplicates);
router.post('/register', requireRole(...REG_MERGE), registerPatient);
router.post('/merge', requireRole('Admin', 'RecordsOfficer'), mergePatients);

router.get('/:id/timeline', requireRole(...STAFF, 'Patient'), getPatientTimeline);
router.get('/:id/export', requireRole(...STAFF), exportPatientRecord);
router.get('/:id', requireRole(...STAFF), getPatientRecord);
router.patch('/:id', requireRole(...REG_MERGE), updatePatientDemographics);

export default router;
