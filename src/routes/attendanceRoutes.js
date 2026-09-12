import express from "express";
import {
  handleGetAttendanceStatus,
  handleGetAttendanceSheet,
  handleSubmitAttendance,
  handleGetAttendanceRegister,
  handleGetMonthlySummary,
  handleGetAttendanceWindowStatus,
} from "../controllers/attendanceController.js";
import {
  handleGetStudentAttendanceAnalytics,
  handleGetSectionAttendanceAnalytics,
  handleGetSchoolAttendanceAnalytics,
  handleGetTownAttendanceOverview,
} from "../controllers/attendanceAnalyticsController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorizePermissions } from "../middlewares/authorizePermissions.js";
import { PERMISSIONS } from "../config/permissions.js";

const router = express.Router();

// All attendance routes require authentication
router.use(authenticate);

// ─── GET Real-Time Attendance Window & Closure Status ──────────────────────────
router.get(
  "/window-status",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetAttendanceWindowStatus
);

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

// ─── POST Submit Attendance (A/L exceptions only; P server-derived) ─────────────
// Teacher submits A and L exceptions; server derives PRESENT for all others.
// Authorized via TeachingAssignment — NOT classTeacherId.
router.post(
  "/submit",
  authorizePermissions(PERMISSIONS.ATTENDANCE_MARK),
  handleSubmitAttendance
);

// ─── GET Monthly Attendance Register (official P/A/L grid) ───────────────────
// Returns a full grid of daily P/A/L for all enrolled students in the section.
router.get(
  "/register",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetAttendanceRegister
);

// ─── GET Monthly Attendance Summary (Previous / Current / Total) ─────────────
// Returns cumulative P/A/L summary per student for government register format.
router.get(
  "/monthly-summary",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetMonthlySummary
);

// ─── High-Performance Multi-Level Attendance Intelligence (2026 Engine) ──────

// Level 1: Student / Parent view (Current %, Last Month %, Academic Year % from admissionDate)
router.get(
  "/analytics/student/:userId?",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetStudentAttendanceAnalytics
);

// Level 2: Section view with full student comparison roster
router.get(
  "/analytics/section/:sectionId",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetSectionAttendanceAnalytics
);

// Level 3: School-wide view with section comparisons and low attendance alerts
router.get(
  "/analytics/school/:schoolId?",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetSchoolAttendanceAnalytics
);

// Level 4: Town-wide municipal overview and school rankings
router.get(
  "/analytics/town-overview",
  authorizePermissions(PERMISSIONS.ATTENDANCE_VIEW),
  handleGetTownAttendanceOverview
);

export default router;
