/**
 * Municipal School Inspection Routes
 * Education Department Liaquatabad Town Centre (DMC)
 */

import express from 'express';
import {
  handleCreateInspection,
  handleGetInspections,
  handleGetInspectionById,
  handleUpdateInspection,
  handleSubmitInspection,
  handleCloseInspection,
} from '../controllers/schoolInspectionController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { validate } from '../middlewares/validate.js';
import { ROLES } from '../../config/constants.js';
import {
  createSchoolInspectionSchema,
  updateSchoolInspectionSchema,
  closeInspectionSchema,
} from '../validations/schoolInspectionSchemas.js';

const router = express.Router();

router.use(authenticate);

// List inspections (Supervisors see assigned cluster; HMs see own school; Admins see town)
router.get(
  '/',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM),
  handleGetInspections
);

// Single inspection detail
router.get(
  '/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM),
  handleGetInspectionById
);

// Create new inspection
router.post(
  '/',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR),
  validate(createSchoolInspectionSchema),
  handleCreateInspection
);

// Update draft inspection
router.patch(
  '/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR),
  validate(updateSchoolInspectionSchema),
  handleUpdateInspection
);

// Submit inspection (finalizes draft)
router.post(
  '/:id/submit',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR),
  handleSubmitInspection
);

// Close inspection (remediation confirmed)
router.patch(
  '/:id/close',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR),
  validate(closeInspectionSchema),
  handleCloseInspection
);

export default router;
