import express from 'express';
import {
  handleInitiateTransfer,
  handleGetTransfers,
  handleGetTransferById,
  handleRelieveTeacher,
  handleApproveJoining,
  handleRejectJoining,
  handleAdminReview,
  handleCancelTransfer,
} from '../controllers/transferController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { validate } from '../middlewares/validate.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';
import {
  initiateTransferSchema,
  relieveTeacherSchema,
  approveJoiningSchema,
  rejectJoiningSchema,
  adminReviewSchema,
  cancelTransferSchema,
} from '../validations/transferSchemas.js';

const router = express.Router();

router.use(authenticate);

// ─── List Transfer Records ─────────────────────────────────────────────────────
router.get(
  '/',
  authorizePermissions(PERMISSIONS.TRANSFERS_VIEW),
  handleGetTransfers
);

// ─── Single Transfer Record (BOLA/IDOR protected) ──────────────────────────────
router.get(
  '/:id',
  authorizePermissions(PERMISSIONS.TRANSFERS_VIEW),
  handleGetTransferById
);

// ─── Initiate Teacher Transfer ─────────────────────────────────────────────────
router.post(
  '/',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM),
  authorizePermissions(PERMISSIONS.TRANSFERS_INITIATE),
  validate(initiateTransferSchema),
  handleInitiateTransfer
);

// ─── Source HM Relieves Teacher ────────────────────────────────────────────────
router.patch(
  '/:id/relieve',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.TRANSFERS_RELIEVE),
  validate(relieveTeacherSchema),
  handleRelieveTeacher
);

// ─── Destination HM Approves Joining ───────────────────────────────────────────
router.patch(
  '/:id/approve-joining',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.TRANSFERS_APPROVE_JOINING),
  validate(approveJoiningSchema),
  handleApproveJoining
);

// ─── Destination HM Rejects Joining ────────────────────────────────────────────
router.patch(
  '/:id/reject',
  authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
  authorizePermissions(PERMISSIONS.TRANSFERS_APPROVE_JOINING),
  validate(rejectJoiningSchema),
  handleRejectJoining
);

// ─── Town Admin Reconsideration / Administrative Review ───────────────────────
router.patch(
  '/:id/admin-review',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizePermissions(PERMISSIONS.TRANSFERS_ADMIN_REVIEW),
  validate(adminReviewSchema),
  handleAdminReview
);

// ─── Cancel Transfer Directive ────────────────────────────────────────────────
router.patch(
  '/:id/cancel',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizePermissions(PERMISSIONS.TRANSFERS_CANCEL),
  validate(cancelTransferSchema),
  handleCancelTransfer
);

export default router;
