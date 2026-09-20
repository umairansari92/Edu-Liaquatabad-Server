import express from 'express';
import {
  handleGetExams,
  handleCreateExam,
  handleGetExamResults,
  handleSubmitStudentMarks,
  handleVerifyExamResult,
  handleBatchVerifyExamResults,
  handlePublishExamResults,
} from '../controllers/examController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

router.use(authenticate);

// List exams for school
router.get(
  '/',
  authorizePermissions(PERMISSIONS.EXAMS_VIEW),
  handleGetExams
);

// Schedule exam
router.post(
  '/',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_CREATE),
  handleCreateExam
);

// List results for exam (data minimized)
router.get(
  '/:id/results',
  authorizePermissions(PERMISSIONS.EXAMS_VIEW),
  handleGetExamResults
);

// Submit student marks for exam
router.post(
  '/:id/results',
  authorizeRoles(ROLES.TEACHER, ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_ENTER_MARKS),
  handleSubmitStudentMarks
);

// HM batch verifies submitted results
router.post(
  '/:id/results/batch-verify',
  authorizeRoles(ROLES.HM, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_VERIFY),
  handleBatchVerifyExamResults
);

// HM verifies submitted result
router.patch(
  '/results/:id/verify',
  authorizeRoles(ROLES.HM, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_VERIFY),
  handleVerifyExamResult
);

// HM publishes verified exam gazette
router.post(
  '/:id/publish',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_VERIFY),
  handlePublishExamResults
);

export default router;
