import express from 'express';
import { handleInitiateTransfer, handleGetTransfers } from '../controllers/transferController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { ROLES } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const router = express.Router();

router.use(authenticate);

// ─── List Transfer Records ─────────────────────────────────────────────────────
router.get(
  '/',
  authorizePermissions(PERMISSIONS.USERS_VIEW),
  handleGetTransfers
);

// ─── Initiate Teacher Transfer ─────────────────────────────────────────────────
router.post(
  '/',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizePermissions(PERMISSIONS.USERS_SUSPEND), // governance-level action
  handleInitiateTransfer
);

export default router;
