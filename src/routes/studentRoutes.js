import express from 'express';
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
} from '../controllers/studentController.js';

const router = express.Router();

/**
 * Student Enrollment Routes
 * All routes require authenticated staff — auth middleware applied at v1/index level.
 */

// Preview next auto-generated GR No (before form submission)
router.get('/next-gr/:schoolId', handlePreviewNextGr);

// Check if a specific manual GR is already taken (live uniqueness check on blur)
router.get('/check-gr', validateQuery(checkGrSchema), handleCheckGrAvailability);

// HM + authorized staff enrolls a student (new admission or old entry)
router.post('/enroll', authLimiter, validate(enrollStudentSchema), handleEnrollStudent);

/**
 * School Code Management
 * PATCH /api/v1/schools/:schoolId/code
 * Sets the school code used as prefix for Global Student IDs (e.g. MMHA → MMHA-0001)
 */
router.patch('/schools/:schoolId/code', authLimiter, validate(setSchoolCodeSchema), handleSetSchoolCode);

export default router;
