import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { idempotencyGuard } from '../middlewares/idempotency.js';
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
// idempotencyGuard: a consent decision (Allow/Deny) must not be double-executed on network retry
router.post('/access-requests/:id/respond', idempotencyGuard, handleRespondToAccessRequest);

export default router;
