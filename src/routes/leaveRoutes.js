/**
 * Leave Management Routes
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * All routes require authenticated JWT (authenticateUser).
 * Permission checks are enforced per-route via authorizePermissions middleware.
 * School/scope isolation is enforced inside controllers.
 */

import express from 'express';
import { authenticate }         from '../middlewares/authenticate.js';
import { idempotencyGuard }     from '../middlewares/idempotency.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { PERMISSIONS }          from '../config/permissions.js';
import {
  handleSubmitLeaveRequest,
  handleGetMyLeaveRequests,
  handleGetClBalance,
  handleGetPendingLeaveRequests,
  handleApproveLeaveRequest,
  handleRejectLeaveRequest,
  handleHmInitiateLeaveOrAbsent,
  handleGetSchoolLeaveSummary,
  handleLateCorrectionLeaveRequest,
} from '../controllers/leaveController.js';

const leaveRouter = express.Router();

// ── All routes require valid JWT & Idempotency Protection ───────────────────────
leaveRouter.use(authenticate);
leaveRouter.use(idempotencyGuard);

// ── Staff: Submit own leave request ──────────────────────────────────────────
leaveRouter.post(
  '/submit',
  authorizePermissions(PERMISSIONS.LEAVE_SUBMIT),
  handleSubmitLeaveRequest
);

// ── Staff: View own leave history ─────────────────────────────────────────────
leaveRouter.get(
  '/my-requests',
  authorizePermissions(PERMISSIONS.LEAVE_VIEW),
  handleGetMyLeaveRequests
);

// ── Staff: View own CL balance ────────────────────────────────────────────────
leaveRouter.get(
  '/cl-balance',
  authorizePermissions(PERMISSIONS.LEAVE_VIEW),
  handleGetClBalance
);

// ── Approver: View pending leave requests ─────────────────────────────────────
leaveRouter.get(
  '/pending',
  authorizePermissions(PERMISSIONS.LEAVE_APPROVE_CL),
  handleGetPendingLeaveRequests
);

// ── Approver: Approve a leave request ─────────────────────────────────────────
leaveRouter.post(
  '/:id/approve',
  authorizePermissions(PERMISSIONS.LEAVE_APPROVE_CL),
  handleApproveLeaveRequest
);

// ── Approver: Reject a leave request ──────────────────────────────────────────
leaveRouter.post(
  '/:id/reject',
  authorizePermissions(PERMISSIONS.LEAVE_APPROVE_CL),
  handleRejectLeaveRequest
);

// ── Approver: Late correction on superseded/rejected leave request ──────────
leaveRouter.post(
  '/:id/correct',
  authorizePermissions(PERMISSIONS.LEAVE_APPROVE_CL),
  handleLateCorrectionLeaveRequest
);

// ── HM: Initiate CL or Absent on behalf of absent teacher ─────────────────────
leaveRouter.post(
  '/hm-initiate',
  authorizePermissions(PERMISSIONS.LEAVE_INITIATE_HM),
  handleHmInitiateLeaveOrAbsent
);

// ── HM/Admin: School leave summary ───────────────────────────────────────────
leaveRouter.get(
  '/school-summary',
  authorizePermissions(PERMISSIONS.LEAVE_VIEW),
  handleGetSchoolLeaveSummary
);

export default leaveRouter;
