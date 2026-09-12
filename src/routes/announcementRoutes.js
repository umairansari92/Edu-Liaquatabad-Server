import express from 'express';
import {
  handleGetActiveAnnouncement,
  handleGetAnnouncementHistory,
  handleCreateAnnouncement,
  handleArchiveAnnouncement,
} from '../controllers/announcementController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = express.Router();

// Public route: fetch current active announcement for landing page & announcement bar
router.get('/active', handleGetActiveAnnouncement);

// Protected routes (Requires Authenticated Session: ROOT_ADMIN, SUPER_ADMIN, ADMIN)
router.get('/history', authenticate, handleGetAnnouncementHistory);
router.post('/', authenticate, handleCreateAnnouncement);
router.patch('/:id/archive', authenticate, handleArchiveAnnouncement);

export default router;
