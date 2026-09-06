import express from 'express';
import {
  handleAssignRoleAndDesignation,
  handleUpdateUserStatus,
  handleGetUsers,
  handleGetUserAuditHistory,
  handleBulkUserAction,
} from '../controllers/userManagementController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeHierarchy } from '../middlewares/authorizeHierarchy.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { authorizeScope } from '../middlewares/authorizeScope.js';
import { blockRootAdminCreation } from '../middlewares/blockRootAdminCreation.js';
import { validate } from '../middlewares/validate.js';
import { assignRoleSchema, updateLifecycleSchema, bulkUserActionSchema } from '../validations/userSchemas.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

// ─── Scoped User Listing ──────────────────────────────────────────────────────
router.get(
  '/',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  handleGetUsers
);

// ─── Bulk User Status Operations (Approve / Suspend) ──────────────────────────
router.post(
  '/bulk',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_SUSPEND),
  validate(bulkUserActionSchema),
  handleBulkUserAction
);


// ─── Assign Designation, Role & Scope (Hierarchy, Scope & Ceiling Protected) ───
// blockRootAdminCreation: prevents body injection of role: ROOT_ADMIN by non-root actors
router.patch(
  '/:id/role-designation',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_ASSIGN_ROLE),
  blockRootAdminCreation,
  authorizeHierarchy,
  authorizeScope,
  validate(assignRoleSchema),
  handleAssignRoleAndDesignation
);

// ─── Update Lifecycle State (Activate, Suspend, Transfer, Retire) ──────────────
router.patch(
  '/:id/lifecycle',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_SUSPEND),
  authorizeHierarchy,
  authorizeScope,
  validate(updateLifecycleSchema),
  handleUpdateUserStatus
);

// ─── User Immutable Audit History (Scoped by Jurisdiction) ─────────────────────
router.get(
  '/:id/audit-history',
  authenticate,
  authorizePermissions(PERMISSIONS.AUDIT_VIEW),
  authorizeScope,
  handleGetUserAuditHistory
);

export default router;
