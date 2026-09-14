import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import {
  handleGetNotifications,
  handleMarkNotificationRead,
  handleMarkAllNotificationsRead,
  handleRespondToAccessRequest,
} from '../controllers/notificationController.js';

const router = express.Router();

router.use(authenticate);

// ─── Notification Operations ──────────────────────────────────────────────────
router.get('/', handleGetNotifications);
router.patch('/mark-all-read', handleMarkAllNotificationsRead);
router.patch('/:id/read', handleMarkNotificationRead);

// ─── Profile PDF Consent Action Response (Allow / Deny) ──────────────────────
router.post('/access-requests/:id/respond', handleRespondToAccessRequest);

export default router;
