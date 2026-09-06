import express from 'express';
import {
  handleGetClasses,
  handleCreateClass,
  handleUpdateClass,
  handleGetSections,
  handleCreateSection,
  handleUpdateSection,
  handleGetSubjects,
  handleCreateSubject,
  handleUpdateSubject,
} from '../controllers/academicController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { validate } from '../middlewares/validate.js';
import {
  createClassSchema, updateClassSchema,
  createSectionSchema, updateSectionSchema,
  createSubjectSchema, updateSubjectSchema,
} from '../validations/academicSchemas.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

// All academic routes require authentication
router.use(authenticate);

// ─── Classes ──────────────────────────────────────────────────────────────────
router.get('/classes', authorizePermissions(PERMISSIONS.SCHOOLS_VIEW), handleGetClasses);
router.post('/classes',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  validate(createClassSchema),
  handleCreateClass
);
router.patch('/classes/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  validate(updateClassSchema),
  handleUpdateClass
);

// ─── Sections ─────────────────────────────────────────────────────────────────
router.get('/sections', authorizePermissions(PERMISSIONS.SCHOOLS_VIEW), handleGetSections);
router.post('/sections',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  validate(createSectionSchema),
  handleCreateSection
);
router.patch('/sections/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  validate(updateSectionSchema),
  handleUpdateSection
);

// ─── Subjects ─────────────────────────────────────────────────────────────────
router.get('/subjects', authorizePermissions(PERMISSIONS.SCHOOLS_VIEW), handleGetSubjects);
router.post('/subjects',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  validate(createSubjectSchema),
  handleCreateSubject
);
router.patch('/subjects/:id',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM),
  authorizePermissions(PERMISSIONS.SCHOOLS_UPDATE),
  validate(updateSubjectSchema),
  handleUpdateSubject
);

export default router;
