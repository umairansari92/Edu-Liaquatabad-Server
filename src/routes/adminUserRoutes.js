import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { authorizeHierarchy } from '../middlewares/authorizeHierarchy.js';
import { authorizeScope } from '../middlewares/authorizeScope.js';
import { validate } from '../middlewares/validate.js';
import { PERMISSIONS } from '../config/permissions.js';
import { grantAuthoritySchema } from '../validations/userSchemas.js';
import { handleGrantUserAuthority } from '../controllers/userManagementController.js';

const router = express.Router();

/**
 * POST /api/v1/admin/users/:userId/authority
 * Canonical Privileged Authority Grant Endpoint
 *
 * Enforces:
 *   - Authentication (valid JWT session)
 *   - USERS_ASSIGN_ROLE permission (held by ROOT_ADMIN and SUPER_ADMIN)
 *   - Server-enforced hierarchy guard (prevent lateral/upward elevation)
 *   - Jurisdictional scope guard (Anti-BOLA/IDOR protection)
 *   - Zod strict schema validation (blocks password/token injection)
 *   - Controller-level invariant checks & transition policy matrix
 */
router.post(
  '/:userId/authority',
  authenticate,
  authorizePermissions(PERMISSIONS.USERS_ASSIGN_ROLE),
  authorizeHierarchy,
  authorizeScope,
  validate(grantAuthoritySchema),
  handleGrantUserAuthority
);

export default router;
