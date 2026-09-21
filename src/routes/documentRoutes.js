import express from 'express';
import {
  handleGetDocuments,
  handleGetDocumentById,
  handleViewDocument,
  handleCreateDocument,
  handleArchiveDocument,
  handleDeleteDocument,
} from '../controllers/documentController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { uploadInMemory, validateFileMagicBytes } from '../middlewares/fileUpload.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

router.use(authenticate);

// View documents and circulars (scoped by role/school/town)
router.get(
  '/',
  authorizePermissions(PERMISSIONS.DOCUMENTS_VIEW),
  handleGetDocuments
);

// Secure document viewing/byte access
router.get(
  '/:id/view',
  authorizePermissions(PERMISSIONS.DOCUMENTS_VIEW),
  handleViewDocument
);

// Get single document metadata
router.get(
  '/:id',
  authorizePermissions(PERMISSIONS.DOCUMENTS_VIEW),
  handleGetDocumentById
);

// Publish document or notice (HM, Supervisor, Admin, Super Admin, Root Admin)
router.post(
  '/',
  authorizeRoles(ROLES.HM, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.DOCUMENTS_PUBLISH),
  uploadInMemory.single('file'),
  validateFileMagicBytes,
  handleCreateDocument
);

// Archive document
router.patch(
  '/:id/archive',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.DOCUMENTS_PUBLISH),
  handleArchiveDocument
);

// Audited hard delete
router.delete(
  '/:id',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.DOCUMENTS_DELETE),
  handleDeleteDocument
);

export default router;
