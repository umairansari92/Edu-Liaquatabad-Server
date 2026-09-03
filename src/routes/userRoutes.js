import express from 'express';
import {
  handleAssignRoleAndDesignation,
  handleUpdateUserStatus,
  handleGetUsers,
  handleGetUserAuditHistory,
} from '../controllers/userManagementController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeHierarchy } from '../middlewares/authorizeHierarchy.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

// ─── Scoped User Listing ──────────────────────────────────────────────────────
router.get(
  '/',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  handleGetUsers
);

// ─── Assign Designation, Role & Scope (Hierarchy & Ceiling Protected) ────────
router.patch(
  '/:id/role-designation',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_ASSIGN_ROLE),
  authorizeHierarchy,
  handleAssignRoleAndDesignation
);

// ─── Update Lifecycle State (Activate, Suspend, Transfer, Retire) ──────────────
router.patch(
  '/:id/lifecycle',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_SUSPEND),
  authorizeHierarchy,
  handleUpdateUserStatus
);

// ─── User Immutable Audit History ─────────────────────────────────────────────
router.get(
  '/:id/audit-history',
  authenticate,
  authorizePermissions(PERMISSIONS.AUDIT_VIEW),
  handleGetUserAuditHistory
);

export default router;
