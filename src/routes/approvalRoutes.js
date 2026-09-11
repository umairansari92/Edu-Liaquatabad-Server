import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { PERMISSIONS } from '../config/permissions.js';
import {
  handleGetPendingApprovals,
  handleGetApprovalDetail,
  handleProcessApprovalDecision,
} from '../controllers/approvalController.js';

const router = express.Router();

// All approval routes require valid JWT session and USERS_APPROVE capability
router.use(authenticate);
router.use(authorizePermissions(PERMISSIONS.USERS_APPROVE));

// List pending registrations (masked sensitive fields)
router.get('/pending', handleGetPendingApprovals);

// Full detailed inspection of applicant profile
router.get('/:userId/detail', handleGetApprovalDetail);

// Process approval decision (APPROVE | REQUEST_CORRECTION | REJECT)
router.post('/:userId/decision', handleProcessApprovalDecision);

export default router;
