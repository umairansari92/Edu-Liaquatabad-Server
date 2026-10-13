/**
 * Staff Attendance Routes
 * Education Department Liaquatabad Town Centre (DMC)
 */

import express from 'express';
import { authenticate }         from '../middlewares/authenticate.js';
import { idempotencyGuard }     from '../middlewares/idempotency.js';
import { authorizePermissions } from '../middlewares/authorizePermissions.js';
import { PERMISSIONS }          from '../config/permissions.js';
import {
  handleHmSelfAttendance,
  handleSubmitStaffAttendance,
  handleGetPendingStaffAttendance,
  handleApproveStaffAttendance,
  handleRejectStaffAttendance,
  handleGetMyStaffAttendanceHistory,
} from '../controllers/staffAttendanceController.js';

const staffAttendanceRouter = express.Router();

staffAttendanceRouter.use(authenticate);
staffAttendanceRouter.use(idempotencyGuard);

// HM marks own attendance (self-effective, no external approval)
staffAttendanceRouter.post(
  '/hm-self',
  authorizePermissions(PERMISSIONS.STAFF_ATTENDANCE_SUBMIT),
  handleHmSelfAttendance
);

// Staff submits attendance for approval
staffAttendanceRouter.post(
  '/submit',
  authorizePermissions(PERMISSIONS.STAFF_ATTENDANCE_SUBMIT),
  handleSubmitStaffAttendance
);

// View own attendance history
staffAttendanceRouter.get(
  '/my-history',
  authorizePermissions(PERMISSIONS.STAFF_ATTENDANCE_SUBMIT),
  handleGetMyStaffAttendanceHistory
);

// Approver: view pending staff attendance
staffAttendanceRouter.get(
  '/pending',
  authorizePermissions(PERMISSIONS.STAFF_ATTENDANCE_APPROVE),
  handleGetPendingStaffAttendance
);

// Approver: approve with 5-minute rule
staffAttendanceRouter.post(
  '/:id/approve',
  authorizePermissions(PERMISSIONS.STAFF_ATTENDANCE_APPROVE),
  handleApproveStaffAttendance
);

// Approver: reject with mandatory reason
staffAttendanceRouter.post(
  '/:id/reject',
  authorizePermissions(PERMISSIONS.STAFF_ATTENDANCE_APPROVE),
  handleRejectStaffAttendance
);

export default staffAttendanceRouter;
