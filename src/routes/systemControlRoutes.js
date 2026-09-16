import express from 'express';
import {
  handleGetSystemControlStatus,
  handleToggleSystemControl,
} from '../controllers/systemControlController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { requireMfaVerified } from '../middlewares/requireMfa.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

// Both routes strictly restricted to ROOT_ADMIN and require verified MFA
router.use(authenticate, authorizeRoles(ROLES.ROOT_ADMIN), requireMfaVerified);

router.get('/status', handleGetSystemControlStatus);
router.post('/toggle', handleToggleSystemControl);

export default router;
