import express from 'express';
import {
  handleAssignRoleAndDesignation,
  handleUpdateUserStatus,
  handleGetUsers,
  handleGetUserById,
  handleGetUserAuditHistory,
  handleBulkUserAction,
  handleGetUserSummaryCounts,
  handleAssignEmployeeSchool,
} from '../controllers/userManagementController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { idempotencyGuard } from '../middlewares/idempotency.js';
import { authorizeHierarchy } from '../middlewares/authorizeHierarchy.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { authorizeScope } from '../middlewares/authorizeScope.js';
import { blockRootAdminCreation } from '../middlewares/blockRootAdminCreation.js';
import { validate } from '../middlewares/validate.js';
import {
  assignRoleSchema,
  updateLifecycleSchema,
  bulkUserActionSchema,
  assignSchoolSchema,
} from '../validations/userSchemas.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

// All user management routes require authentication and idempotency protection
router.use(authenticate);
router.use(idempotencyGuard);

// ─── Scoped User Listing ──────────────────────────────────────────────────────
router.get(
  '/',
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  handleGetUsers
);

// ─── Scoped User Summary Counts (Must precede /:id parameterized route) ───────
router.get(
  '/summary-counts',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  handleGetUserSummaryCounts
);

// ─── Get User by ID (Protected Identity Enforcement) ──────────────────────────
router.get(
  '/:id',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  authorizeScope,
  handleGetUserById
);

// ─── Bulk User Status Operations (Approve / Suspend) ──────────────────────────
router.post(
  '/bulk',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_SUSPEND),
  validate(bulkUserActionSchema),
  handleBulkUserAction
);

// ─── Assign School to Employee ────────────────────────────────────────────────
router.patch(
  '/:id/assign-school',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_ASSIGN_ROLE),
  authorizeHierarchy,
  authorizeScope,
  validate(assignSchoolSchema),
  handleAssignEmployeeSchool
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
