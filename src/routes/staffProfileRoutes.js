import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import {
  handleGetStaffProfile,
  handleGenerateStaffProfilePdf,
} from '../controllers/staffProfileController.js';

const router = express.Router();

router.use(authenticate);

// View staff profile (Self, HM of same school, Supervisor, Admin+)
router.get('/:id/profile', handleGetStaffProfile);

// Download official service record PDF (Separate independent authorization & audited)
router.get('/:id/pdf', handleGenerateStaffProfilePdf);

export default router;
