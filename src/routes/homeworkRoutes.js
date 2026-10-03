import express from 'express';
import {
  handleCreateHomework,
  handleGetMyHomework,
  handleGetStudentHomework,
  handleGetSchoolHomework,
  handleUpdateHomework,
  handleCancelHomework,
} from '../controllers/homeworkController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { idempotencyGuard } from '../middlewares/idempotency.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { PERMISSIONS } from '../config/permissions.js';
import {
  uploadHomeworkAttachments,
  validateFileMagicBytes,
  validateHomeworkUploadLimits,
} from '../middlewares/fileUpload.js';

const router = express.Router();

// All routes require authentication and idempotency protection
router.use(authenticate);
router.use(idempotencyGuard);

// ─── Create homework (Teacher/HM) ─────────────────────────────────────────────
router.post(
  '/',
  authorizePermissions(PERMISSIONS.HOMEWORK_CREATE),
  uploadHomeworkAttachments.array('attachments', 10),
  validateHomeworkUploadLimits,
  validateFileMagicBytes,
  handleCreateHomework
);

// ─── Teacher: My own homework list ────────────────────────────────────────────
router.get(
  '/my',
  authorizePermissions(PERMISSIONS.HOMEWORK_VIEW),
  handleGetMyHomework
);

// ─── Student: My class/section homework (boundary derived from StudentProfile) ─
router.get(
  '/student',
  authorizePermissions(PERMISSIONS.HOMEWORK_VIEW),
  handleGetStudentHomework
);

// ─── HM: All school homework ──────────────────────────────────────────────────
router.get(
  '/school',
  authorizePermissions(PERMISSIONS.HOMEWORK_VIEW),
  handleGetSchoolHomework
);

// ─── Edit homework (Teacher who created it, or HM) ────────────────────────────
router.patch(
  '/:id',
  authorizePermissions(PERMISSIONS.HOMEWORK_CREATE),
  uploadHomeworkAttachments.array('attachments', 10),
  validateHomeworkUploadLimits,
  validateFileMagicBytes,
  handleUpdateHomework
);

// ─── Cancel homework (soft-delete, preserves history) ─────────────────────────
router.delete(
  '/:id',
  authorizePermissions(PERMISSIONS.HOMEWORK_CREATE),
  handleCancelHomework
);

export default router;
