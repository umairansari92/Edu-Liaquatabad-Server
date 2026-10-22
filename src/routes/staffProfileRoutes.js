import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { idempotencyGuard } from '../middlewares/idempotency.js';
import { uploadProfilePhotoMemory, validateFileMagicBytes } from '../middlewares/fileUpload.js';
import {
  handleGetStaffProfile,
  handleUpdateStaffProfile,
  handleUploadProfilePhoto,
  handleDeleteProfilePhoto,
  handleUpdatePrivacySettings,
  handleRequestPdfAccess,
  handleGetStaffAccessHistory,
  handleGenerateStaffProfilePdf,
  handleGetSchoolFaculty,
} from '../controllers/staffProfileController.js';

const router = express.Router();

router.use(authenticate);
router.use(idempotencyGuard);

// Scoped school faculty directory (HM, Supervisor, Admin+)
router.get('/school', handleGetSchoolFaculty);

// View staff profile (Self, HM of same school, Supervisor, Admin+)
router.get('/:id/profile', handleGetStaffProfile);

// Update staff self-managed profile details
router.patch('/:id/profile', handleUpdateStaffProfile);

// Upload or replace profile photo (with file magic-bytes security validation)
router.post(
  '/:id/photo',
  uploadProfilePhotoMemory.single('photo'),
  validateFileMagicBytes,
  handleUploadProfilePhoto
);

// Delete profile photo
router.delete('/:id/photo', handleDeleteProfilePhoto);

// Update staff field-level privacy settings & PDF consent
router.patch('/:id/privacy', handleUpdatePrivacySettings);

// Request official PDF access (consent lifecycle)
router.post('/:id/request-pdf-access', handleRequestPdfAccess);

// Access history & download audit telemetry
router.get('/:id/access-history', handleGetStaffAccessHistory);

// Download official service record PDF (Enforces consent, audited, transparent notification)
router.get('/:id/pdf', handleGenerateStaffProfilePdf);

export default router;
