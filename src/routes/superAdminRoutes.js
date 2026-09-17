/**
 * Super Admin Management Routes
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * All routes require:
 *   1. authenticate   — valid JWT session
 *   2. authorizeRoles — caller must be ROOT_ADMIN or SUPER_ADMIN
 *   3. blockRootAdminCreation — body cannot contain role: ROOT_ADMIN
 *   4. authorizeHierarchy (on targeted routes) — prevents lateral/upward modifications
 */

import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { blockRootAdminCreation } from '../middlewares/blockRootAdminCreation.js';
import { validate } from '../middlewares/validate.js';
import { flushLockoutsSchema } from '../validations/userSchemas.js';
import {
  handleCreateSuperAdmin,
  handleDisableSuperAdmin,
  handleDemoteSuperAdmin,
  handleListSuperAdmins,
  handleGetPlatformOverview,
  handleGetSystemAuditLogs,
  handleGetPendingUsers,
  handleFlushSecurityLockouts,
  handleGetPlatformAnalytics,
  handleBroadcastAlert,
} from '../controllers/superAdminManagementController.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

// All routes in this file require authentication and minimum SUPER_ADMIN authority
router.use(authenticate);
router.use(authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN));

/**
 * GET /api/v1/admin/super-admins/overview
 * Platform Governance Overview metrics
 */
router.get('/overview', handleGetPlatformOverview);

/**
 * GET /api/v1/admin/super-admins/analytics
 * Real-time 2026 Telemetry & Analytics Hub
 */
router.get('/analytics', handleGetPlatformAnalytics);

/**
 * GET /api/v1/admin/super-admins/audit-logs
 * System immutable audit trail feed
 */
router.get('/audit-logs', handleGetSystemAuditLogs);

/**
 * GET /api/v1/admin/super-admins/pending-users
 * Pending user approval queue
 */
router.get('/pending-users', handleGetPendingUsers);

/**
 * POST /api/v1/admin/super-admins/flush-lockouts
 * Clear security IP lockouts and failed login strikes
 * Hardened: requires validate(flushLockoutsSchema) with typed reason and explicit confirmation
 */
router.post('/flush-lockouts', authorizeRoles(ROLES.ROOT_ADMIN), validate(flushLockoutsSchema), handleFlushSecurityLockouts);

/**
 * POST /api/v1/admin/super-admins/broadcast
 * Broadcast emergency alert across all portal instances
 */
router.post('/broadcast', handleBroadcastAlert);

/**
 * GET /api/v1/admin/super-admins
 * List all Super Admin accounts (no credentials exposed)
 */
router.get('/', handleListSuperAdmins);

/**
 * POST /api/v1/admin/super-admins
 * Create a new Super Admin account
 * blockRootAdminCreation: prevents body injection of role: ROOT_ADMIN
 */
router.post('/', blockRootAdminCreation, handleCreateSuperAdmin);

/**
 * PATCH /api/v1/admin/super-admins/:id/disable
 * Disable a Super Admin account (with safety guards inside controller)
 * Only targets SUPER_ADMIN accounts (ROOT_ADMIN cannot be targeted)
 */
router.patch('/:id/disable', handleDisableSuperAdmin);

/**
 * PATCH /api/v1/admin/super-admins/:id/demote
 * Demote a Super Admin account to Admin (with safety guards inside controller)
 * Permitted for ROOT_ADMIN or peer/self SUPER_ADMIN
 */
router.patch('/:id/demote', handleDemoteSuperAdmin);

export default router;
