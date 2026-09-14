import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import {
  handleGetStaffProfile,
  handleUpdatePrivacySettings,
  handleRequestPdfAccess,
  handleGetStaffAccessHistory,
  handleGenerateStaffProfilePdf,
} from '../controllers/staffProfileController.js';

const router = express.Router();

router.use(authenticate);

// View staff profile (Self, HM of same school, Supervisor, Admin+)
router.get('/:id/profile', handleGetStaffProfile);

// Update staff field-level privacy settings & PDF consent
router.patch('/:id/privacy', handleUpdatePrivacySettings);

// Request official PDF access (consent lifecycle)
router.post('/:id/request-pdf-access', handleRequestPdfAccess);

// Access history & download audit telemetry
router.get('/:id/access-history', handleGetStaffAccessHistory);

// Download official service record PDF (Enforces consent, audited, transparent notification)
router.get('/:id/pdf', handleGenerateStaffProfilePdf);

export default router;
