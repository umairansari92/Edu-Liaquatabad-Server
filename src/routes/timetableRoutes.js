import express from 'express';
import {
  handleGetSchoolTimetable,
  handleManageTimetable,
  handleGetTownLiveMonitor,
  handleGetMySchedule,
} from '../controllers/timetableController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles, enforceSchoolScope } from '../middlewares/authorize.js';
import { validate } from '../middlewares/validate.js';
import { manageTimetableSchema } from '../validations/timetableSchemas.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

// All timetable operations require valid authentication
router.use(authenticate);

// ─── 1. School Timetable & Live Period Status ────────────────────────────────
router.get(
  '/school/:schoolId',
  enforceSchoolScope,
  handleGetSchoolTimetable
);

// ─── 2. Authoritative Timetable Management (Creation & Modification) ────────
router.post(
  '/manage',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM),
  enforceSchoolScope,
  validate(manageTimetableSchema),
  handleManageTimetable
);

// ─── 3. Town-Wide Live Period Classroom Monitor (Oversight View) ─────────────
router.get(
  '/town-live-monitor',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR),
  handleGetTownLiveMonitor
);

// ─── 4. Personalized Schedule Resolver (Teacher / Student / Parent) ─────────
router.get(
  '/my-schedule',
  authorizeRoles(ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT),
  handleGetMySchedule
);

export default router;
