import express from 'express';
import {
  handleGetActiveAnnouncement,
  handleGetAnnouncementHistory,
  handleCreateAnnouncement,
  handleArchiveAnnouncement,
} from '../controllers/announcementController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { idempotencyGuard } from '../middlewares/idempotency.js';

const router = express.Router();

// Public route: fetch current active announcement for landing page & announcement bar
router.get('/active', handleGetActiveAnnouncement);

// Protected routes (Requires Authenticated Session: ROOT_ADMIN, SUPER_ADMIN, ADMIN)
router.get('/history', authenticate, handleGetAnnouncementHistory);
router.post('/', authenticate, idempotencyGuard, handleCreateAnnouncement);
router.patch('/:id/archive', authenticate, idempotencyGuard, handleArchiveAnnouncement);

export default router;
