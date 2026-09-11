import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeScope } from '../middlewares/authorizeScope.js';
import { authLimiter } from '../middlewares/tripleLockRateLimiter.js';
import { validate, validateQuery } from '../middlewares/validate.js';
import {
  enrollStudentSchema,
  checkGrSchema,
  setSchoolCodeSchema,
} from '../validations/studentSchemas.js';
import {
  handleEnrollStudent,
  handlePreviewNextGr,
  handleCheckGrAvailability,
  handleSetSchoolCode,
  handleGetSectionStudents,
} from '../controllers/studentController.js';

const router = express.Router();

/**
 * Student Enrollment & Management Routes
 * All routes require authentication and jurisdictional scope verification.
 */
router.use(authenticate);
router.use(authorizeScope);

// Preview next auto-generated GR No (before form submission)
router.get('/next-gr/:schoolId', handlePreviewNextGr);

// Check if a specific manual GR is already taken (live uniqueness check on blur)
router.get('/check-gr', validateQuery(checkGrSchema), handleCheckGrAvailability);

// HM + authorized staff enrolls a student (new admission or old entry)
router.post('/enroll', authLimiter, validate(enrollStudentSchema), handleEnrollStudent);

/**
 * School Code Management
 * PATCH /api/v1/students/schools/:schoolId/code
 * Sets the school code used as prefix for Global Student IDs (e.g. MMHA → MMHA-0001)
 */
router.patch('/schools/:schoolId/code', authLimiter, validate(setSchoolCodeSchema), handleSetSchoolCode);

// Authoritative Student Roster for an assigned section
router.get('/section/:sectionId', handleGetSectionStudents);

export default router;
