import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { generateDeviceFingerprint } from '../utils/deviceFingerprint.js';
import {
  generateNextGrNumber,
  previewNextGrNumber,
  validateManualGrNumber,
  syncGrCounterIfNeeded,
  generateGlobalStudentId,
  backfillGlobalStudentIds,
} from '../services/grNumberService.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, SCOPES, USER_STATUS, STUDENT_STATUS } from '../../config/constants.js';
import { hashPassword } from '../utils/passwordUtils.js';

// Roles authorized to enroll students
const ENROLLMENT_ALLOWED_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.CHAIRMAN,
  ROLES.VICE_CHAIRMAN,
  ROLES.DDO,
  ROLES.SUPERVISOR,
  ROLES.HM,
  ROLES.ASSISTANT_HM,
]);

// Roles authorized to set school code
const SCHOOL_CODE_ALLOWED_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.CHAIRMAN,
  ROLES.VICE_CHAIRMAN,
  ROLES.DDO,
  ROLES.SUPERVISOR,
  ROLES.HM,
]);

/**
 * GET /api/v1/students/next-gr/:schoolId
 * Preview the next auto-generated GR No for a school — shown in HM form
 */
export const handlePreviewNextGr = asyncHandler(async (req, res) => {
  const { schoolId } = req.params;
  const nextGr = await previewNextGrNumber(schoolId);

  return sendSuccess(res, 200, 'Next GR number preview.', {
    suggestedGrNumber: nextGr,
    note: 'This will be auto-assigned for NEW_ADMISSION. For EXISTING_ENTRY, provide the original GR from school records.',
  });
});

/**
 * GET /api/v1/students/check-gr?schoolId=...&grNumber=...
 * Check if a specific GR number is available in a school (for old student entry)
 */
export const handleCheckGrAvailability = asyncHandler(async (req, res) => {
  const { schoolId, grNumber } = req.query;
  const existing = await StudentProfile.findOne({ schoolId, grNumber: Number(grNumber) });

  return sendSuccess(res, 200, 'GR availability check complete.', {
    grNumber: Number(grNumber),
    available: !existing,
    takenBy: existing ? existing.userId : null,
  });
});

/**
 * POST /api/v1/students/enroll
 * HM (and admin+) enrolls a student — new admission or old record entry.
 * Assigns GR No and Global Student ID automatically.
 * Role-protected: ENROLLMENT_ALLOWED_ROLES only.
 */
export const handleEnrollStudent = asyncHandler(async (req, res) => {
  const actorRole = req.user?.role;

  if (!ENROLLMENT_ALLOWED_ROLES.has(actorRole)) {
    return sendError(res, 403, 'Access denied. Only authorized staff can enroll students.');
  }

  const actorSchoolId = req.user?.schoolId;
  if (!actorSchoolId) {
    return sendError(res, 400, 'Your account is not linked to a school.');
  }

  const {
    admissionType,
    fullName,
    dateOfBirth,
    gender,
    guardianName,
    guardianContact,
    residentialAddress,
    classId,
    sectionId,
    admissionDate,
    manualGrNumber,
  } = req.body;

  // ── Step 1: Determine GR No ────────────────────────────────────────────────
  let assignedGrNumber;

  if (admissionType === 'NEW_ADMISSION') {
    // Atomically increment and get next GR No
    assignedGrNumber = await generateNextGrNumber(actorSchoolId);
  } else {
    // EXISTING_ENTRY: validate the manually provided GR is not already taken
    await validateManualGrNumber(actorSchoolId, manualGrNumber);
    assignedGrNumber = manualGrNumber;
    // Sync counter so future auto-GRs don't collide
    await syncGrCounterIfNeeded(actorSchoolId, manualGrNumber);
  }

  // ── Step 2: Generate Global Student ID ─────────────────────────────────────
  // Returns null if schoolCode not yet assigned to this school (deferred)
  const globalStudentId = await generateGlobalStudentId(actorSchoolId);

  // ── Step 3: Create a system-managed User account for the student ───────────
  // A minimal account — no password needed yet (HM enrolls, student logs in later)
  const tempPasswordHash = await hashPassword(`Student@${assignedGrNumber}`);
  const user = await User.create({
    organizationId: req.user?.organizationId,
    townId: req.user?.townId,
    schoolId: actorSchoolId,
    fullName: fullName.trim(),
    email: null, // Email optional at enrollment — can be added later
    passwordHash: tempPasswordHash,
    phoneNumber: guardianContact,
    role: ROLES.STUDENT,
    scope: SCOPES.SELF_CHILD,
    status: USER_STATUS.PENDING_APPROVAL,
  });

  // ── Step 4: Create StudentProfile with dual numbers ─────────────────────────
  const profile = await StudentProfile.create({
    userId: user._id,
    schoolId: actorSchoolId,
    classId,
    sectionId,
    grNumber: assignedGrNumber,
    globalStudentId: globalStudentId || undefined,
    admissionType,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
    gender,
    fatherOrGuardianName: guardianName,
    guardianContactNumber: guardianContact,
    residentialAddress: residentialAddress || '',
    admissionDate: admissionDate ? new Date(admissionDate) : new Date(),
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
    enrolledBy: req.user?._id,
    enrolledAt: new Date(),
  });

  // ── Step 5: Audit Log ───────────────────────────────────────────────────────
  await AuditLog.create({
    actorId: req.user?._id,
    actorRole,
    action: admissionType === 'NEW_ADMISSION' ? 'STUDENT_NEW_ADMISSION' : 'STUDENT_EXISTING_ENTRY',
    targetModel: 'StudentProfile',
    targetId: profile._id,
    townId: req.user?.townId,
    schoolId: actorSchoolId,
    newState: {
      grNumber: assignedGrNumber,
      globalStudentId,
      admissionType,
      lifecycleStatus: STUDENT_STATUS.ACTIVE,
    },
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
  });

  return sendSuccess(res, 201, 'Student enrolled successfully.', {
    studentId: profile._id,
    grNumber: assignedGrNumber,
    globalStudentId: globalStudentId || 'Pending (school code not yet configured)',
    admissionType,
    fullName: user.fullName,
  });
});

/**
 * PATCH /api/v1/schools/:schoolId/code
 * Set or update school code — authorized roles only.
 * This triggers backfill of Global Student IDs for existing students.
 */
export const handleSetSchoolCode = asyncHandler(async (req, res) => {
  const actorRole = req.user?.role;

  if (!SCHOOL_CODE_ALLOWED_ROLES.has(actorRole)) {
    return sendError(res, 403, 'Access denied. Only HM, Supervisor, or Admin can set the school code.');
  }

  const { schoolId } = req.params;
  const { schoolCode } = req.body;

  // Check uniqueness across all schools
  const codeConflict = await School.findOne({ schoolCode: schoolCode.toUpperCase(), _id: { $ne: schoolId } });
  if (codeConflict) {
    return sendError(res, 409, `School code '${schoolCode.toUpperCase()}' is already in use by another school.`);
  }

  await School.findByIdAndUpdate(schoolId, {
    schoolCode: schoolCode.toUpperCase(),
    schoolCodeSetBy: req.user?._id,
    schoolCodeSetAt: new Date(),
  });

  // Backfill Global Student IDs for any students who didn't have one yet
  const backfilledCount = await backfillGlobalStudentIds(schoolId);

  await AuditLog.create({
    actorId: req.user?._id,
    actorRole,
    action: 'SCHOOL_CODE_SET',
    targetModel: 'School',
    targetId: schoolId,
    newState: { schoolCode: schoolCode.toUpperCase(), backfilledStudents: backfilledCount },
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
  });

  return sendSuccess(res, 200, `School code '${schoolCode.toUpperCase()}' set successfully.`, {
    schoolCode: schoolCode.toUpperCase(),
    backfilledStudents: backfilledCount,
  });
});
