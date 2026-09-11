import express from 'express';
import {
  handleGetSystemControlStatus,
  handleToggleSystemControl,
} from '../controllers/systemControlController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

// Both routes strictly restricted to ROOT_ADMIN
router.use(authenticate, authorizeRoles(ROLES.ROOT_ADMIN));

router.get('/status', handleGetSystemControlStatus);
router.post('/toggle', handleToggleSystemControl);

export default router;
