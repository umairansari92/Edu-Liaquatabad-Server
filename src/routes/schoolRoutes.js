import express from 'express';
import {
  handleCreateSchool,
  handleGetSchools,
  handleGetSchoolById,
  handleUpdateSchool,
} from '../controllers/schoolController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { validate } from '../middlewares/validate.js';
import { createSchoolSchema, updateSchoolSchema } from '../validations/schoolSchemas.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

// All school routes require valid JWT session
router.use(authenticate);

// ─── List Schools (Scoped by User Authority) ──────────────────────────────────
router.get('/', handleGetSchools);

// ─── Get Single School Details ───────────────────────────────────────────────
router.get('/:id', handleGetSchoolById);

// ─── Register New Municipal School (ROOT_ADMIN, SUPER_ADMIN, ADMIN) ──────────
router.post(
  '/',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  validate(createSchoolSchema),
  handleCreateSchool
);

// ─── Update Municipal School Details ─────────────────────────────────────────
router.patch(
  '/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  validate(updateSchoolSchema),
  handleUpdateSchool
);

export default router;
