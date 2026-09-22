import express from 'express';
import {
  handleGetExams,
  handleCreateExam,
  handleGetExamResults,
  handleSubmitStudentMarks,
  handleVerifyExamResult,
  handleBatchVerifyExamResults,
  handlePublishExamResults,
  handleDownloadStudentMarksheet,
  handleDownloadClassTabulationPdf,
  handleGetClassTabulationData,
  handleGetExamMarksEntryRoster,
  handleBulkSubmitStudentMarks,
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

// Get marks entry roster for teacher (exam + class + section + optional subject)
router.get(
  '/:id/entry-roster',
  authorizePermissions(PERMISSIONS.EXAMS_ENTER_MARKS),
  handleGetExamMarksEntryRoster
);

// List results for exam (data minimized)
router.get(
  '/:id/results',
  authorizePermissions(PERMISSIONS.EXAMS_VIEW),
  handleGetExamResults
);

// Submit student marks for exam (single student)
router.post(
  '/:id/results',
  authorizeRoles(ROLES.TEACHER, ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_ENTER_MARKS),
  handleSubmitStudentMarks
);

// Bulk submit student marks for section/subject (entire class/section)
router.post(
  '/:id/results/bulk',
  authorizeRoles(ROLES.TEACHER, ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.EXAMS_ENTER_MARKS),
  handleBulkSubmitStudentMarks
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

// Stream official individual student marksheet PDF (A4 Portrait, Image 1 Replica)
router.get(
  '/:id/results/:studentId/marksheet',
  authorizePermissions(PERMISSIONS.EXAMS_VIEW),
  handleDownloadStudentMarksheet
);

// Stream official class tabulation sheet PDF (Legal Landscape, Image 2 Replica)
router.get(
  '/:id/tabulation-sheet',
  authorizePermissions(PERMISSIONS.EXAMS_VIEW),
  handleDownloadClassTabulationPdf
);

// Get auto-calculated class tabulation spreadsheet data for web grid
router.get(
  '/:id/tabulation-data',
  authorizePermissions(PERMISSIONS.EXAMS_VIEW),
  handleGetClassTabulationData
);

export default router;

