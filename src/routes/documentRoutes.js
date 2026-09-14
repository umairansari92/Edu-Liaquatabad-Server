import express from 'express';
import { handleGetDocuments, handleCreateDocument } from '../controllers/documentController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

router.use(authenticate);

// View documents/circulars (scoped by role/school)
router.get(
  '/',
  authorizePermissions(PERMISSIONS.DOCUMENTS_VIEW),
  handleGetDocuments
);

// Publish document/notice (HM, Supervisor, Admin, Super Admin, Root Admin)
router.post(
  '/',
  authorizeRoles(ROLES.HM, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.DOCUMENTS_PUBLISH),
  handleCreateDocument
);

export default router;
