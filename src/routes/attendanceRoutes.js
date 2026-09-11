import express from "express";
import {
  handleGetAttendanceStatus,
  handleGetAttendanceSheet,
  handleSubmitAttendance,
} from "../controllers/attendanceController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorizePermissions } from "../middlewares/authorizePermissions.js";
import { PERMISSIONS } from "../config/permissions.js";

const router = express.Router();

// All attendance routes require authentication
router.use(authenticate);

// ─── GET Attendance Status ─────────────────────────────────────────────────────
// Teacher queries attendance submission status for their section (read-only)
router.get(
  "/status",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetAttendanceStatus
);

// ─── GET Attendance Sheet ──────────────────────────────────────────────────────
// Teacher fetches the student roster for marking (pre-filled if already submitted)
router.get(
  "/sheet",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetAttendanceSheet
);

// ─── POST Submit Attendance ────────────────────────────────────────────────────
// Teacher submits or updates attendance for their section
// Server enforces school boundary + classTeacherId assignment before writing
router.post(
  "/submit",
  authorizePermissions(PERMISSIONS.ATTENDANCE_MARK),
  handleSubmitAttendance
);

export default router;
