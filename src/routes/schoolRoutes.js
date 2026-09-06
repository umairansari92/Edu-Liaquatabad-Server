import express from 'express';
import {
  handleCreateSchool,
  handleGetSchools,
  handleGetSchoolById,
  handleUpdateSchool,
} from '../controllers/schoolController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { authorizeScope } from '../middlewares/authorizeScope.js';
import { validate } from '../middlewares/validate.js';
import { createSchoolSchema, updateSchoolSchema } from '../validations/schoolSchemas.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

// All school routes require valid JWT session
router.use(authenticate);

// ─── List Schools (Scoped by User Authority) ──────────────────────────────────
router.get('/', authorizePermissions(PERMISSIONS.SCHOOLS_VIEW), handleGetSchools);

// ─── Get Single School Details ───────────────────────────────────────────────
router.get('/:id', authorizePermissions(PERMISSIONS.SCHOOLS_VIEW), handleGetSchoolById);

// ─── Register New Municipal School (ROOT_ADMIN, SUPER_ADMIN, ADMIN) ──────────
router.post(
  '/',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizePermissions(PERMISSIONS.SCHOOLS_CREATE),
  validate(createSchoolSchema),
  handleCreateSchool
);

// ─── Update Municipal School Details (SEC-CRIT-02 Hardened) ──────────────────
// authorizePermissions: only actors with SCHOOLS_UPDATE can proceed.
// authorizeScope:       enforces jurisdictional boundary (ADMIN → own townId only,
//                       SUPER_ADMIN → global or scoped town, HM → own school only,
//                       SUPERVISOR → assigned schools only).
router.patch(
  '/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  authorizeScope,
  validate(updateSchoolSchema),
  handleUpdateSchool
);

export default router;
