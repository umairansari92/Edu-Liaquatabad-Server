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
import Section from '../models/Section.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, BASE_ROLES, SCOPES, USER_STATUS, STUDENT_STATUS } from '../../config/constants.js';
import { hashPassword } from '../utils/passwordUtils.js';

// Roles authorized to enroll students
const ENROLLMENT_ALLOWED_ROLES = new Set([
  ROLES.ROOT_ADMIN,
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.SUPERVISOR,
  ROLES.HM,
]);

// Roles authorized to set school code
const SCHOOL_CODE_ALLOWED_ROLES = new Set([
  ROLES.ROOT_ADMIN,
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.SUPERVISOR,
  ROLES.HM,
]);

/**
 * GET /api/v1/students/next-gr/:schoolId
 * Preview the next auto-generated GR No for a school — shown in HM form
 */
export const handlePreviewNextGr = asyncHandler(async (request, response) => {
  const { schoolId } = request.params;
  const nextGr = await previewNextGrNumber(schoolId);

  return sendSuccess(response, 200, 'Next GR number preview.', {
    suggestedGrNumber: nextGr,
    note: 'This will be auto-assigned for NEW_ADMISSION. For EXISTING_ENTRY, provide the original GR from school records.',
  });
});

/**
 * GET /api/v1/students/check-gr?schoolId=...&grNumber=...
 * Check if a specific GR number is available in a school (for old student entry)
 */
export const handleCheckGrAvailability = asyncHandler(async (request, response) => {
  const { schoolId, grNumber } = request.query;
  const existingRecord = await StudentProfile.findOne({ schoolId, grNumber: Number(grNumber) });

  return sendSuccess(response, 200, 'GR availability check complete.', {
    grNumber: Number(grNumber),
    available: !existingRecord,
  });
});

/**
 * POST /api/v1/students/enroll
 * HM (and admin+) enrolls a student — new admission or old record entry.
 * Assigns GR No and Global Student ID automatically.
 * Role-protected: ENROLLMENT_ALLOWED_ROLES only.
 */
export const handleEnrollStudent = asyncHandler(async (request, response) => {
  const actorRole = request.user?.role;

  if (!ENROLLMENT_ALLOWED_ROLES.has(actorRole)) {
    return sendError(response, 403, 'Access denied. Only authorized staff can enroll students.');
  }

  if (actorRole === ROLES.HM) {
    if (!request.user.schoolId) {
      return sendError(response, 400, 'Your Head Master account is not linked to an authorized school.');
    }
    if (request.body.schoolId && String(request.body.schoolId) !== String(request.user.schoolId)) {
      return sendError(response, 403, 'Access denied. You can only enroll students in your own assigned school.');
    }
  }

  const effectiveSchoolId = (actorRole === ROLES.HM)
    ? request.user.schoolId
    : (request.body.schoolId || request.user?.schoolId);

  if (!effectiveSchoolId) {
    return sendError(response, 400, 'Target school identifier is required for student enrollment.');
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
  } = request.body;

  // ── Step 1: Determine GR No ────────────────────────────────────────────────
  let assignedGrNumber;

  if (admissionType === 'NEW_ADMISSION') {
    // Atomically increment and get next GR No
    assignedGrNumber = await generateNextGrNumber(effectiveSchoolId);
  } else {
    // EXISTING_ENTRY: validate the manually provided GR is not already taken
    await validateManualGrNumber(effectiveSchoolId, manualGrNumber);
    assignedGrNumber = manualGrNumber;
    // Sync counter so future auto-GRs don't collide
    await syncGrCounterIfNeeded(effectiveSchoolId, manualGrNumber);
  }

  // ── Step 2: Generate Global Student ID ─────────────────────────────────────
  // Returns null if schoolCode not yet assigned to this school (deferred)
  const globalStudentId = await generateGlobalStudentId(effectiveSchoolId);

  // ── Step 3: Create a system-managed User account for the student ───────────
  // A minimal account — no password needed yet (HM enrolls, student logs in later)
  const temporaryPasswordHash = await hashPassword(`Student@${assignedGrNumber}`);
  const enrolledUser = await User.create({
    organizationId: request.user?.organizationId,
    townId: request.user?.townId,
    schoolId: effectiveSchoolId,
    fullName: fullName.trim(),
    email: null, // Email optional at enrollment — can be added later
    passwordHash: temporaryPasswordHash,
    phoneNumber: guardianContact,
    designation: 'Enrolled Student',
    baseRole: BASE_ROLES.STUDENT,
    role: ROLES.STUDENT,
    scope: SCOPES.SELF,
    status: USER_STATUS.PENDING_APPROVAL,
  });

  // ── Step 4: Create StudentProfile with dual numbers ─────────────────────────
  const studentProfile = await StudentProfile.create({
    userId: enrolledUser._id,
    schoolId: effectiveSchoolId,
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
    enrolledBy: request.user?._id,
    enrolledAt: new Date(),
  });

  // ── Step 5: Audit Log ───────────────────────────────────────────────────────
  await AuditLog.create({
    actorId: request.user?._id,
    actorRole,
    action: admissionType === 'NEW_ADMISSION' ? 'STUDENT_NEW_ADMISSION' : 'STUDENT_EXISTING_ENTRY',
    targetModel: 'StudentProfile',
    targetId: studentProfile._id,
    townId: request.user?.townId,
    schoolId: actorSchoolId,
    newState: {
      grNumber: assignedGrNumber,
      globalStudentId,
      admissionType,
      lifecycleStatus: STUDENT_STATUS.ACTIVE,
    },
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 201, 'Student enrolled successfully.', {
    studentId: studentProfile._id,
    grNumber: assignedGrNumber,
    globalStudentId: globalStudentId || 'Pending (school code not yet configured)',
    admissionType,
    fullName: enrolledUser.fullName,
  });
});

/**
 * PATCH /api/v1/schools/:schoolId/code
 * Set or update school code — authorized roles only.
 * This triggers backfill of Global Student IDs for existing students.
 */
export const handleSetSchoolCode = asyncHandler(async (request, response) => {
  const actorRole = request.user?.role;

  if (!SCHOOL_CODE_ALLOWED_ROLES.has(actorRole)) {
    return sendError(response, 403, 'Access denied. Only HM, Supervisor, or Admin can set the school code.');
  }

  const { schoolId } = request.params;
  const { schoolCode } = request.body;

  // Check uniqueness across all schools
  const conflictingSchoolRecord = await School.findOne({ schoolCode: schoolCode.toUpperCase(), _id: { $ne: schoolId } });
  if (conflictingSchoolRecord) {
    return sendError(response, 409, `School code '${schoolCode.toUpperCase()}' is already in use by another school.`);
  }

  await School.findByIdAndUpdate(schoolId, {
    schoolCode: schoolCode.toUpperCase(),
    schoolCodeSetBy: request.user?._id,
    schoolCodeSetAt: new Date(),
  });

  // Backfill Global Student IDs for any students who didn't have one yet
  const backfilledCount = await backfillGlobalStudentIds(schoolId);

  await AuditLog.create({
    actorId: request.user?._id,
    actorRole,
    action: 'SCHOOL_CODE_SET',
    targetModel: 'School',
    targetId: schoolId,
    newState: { schoolCode: schoolCode.toUpperCase(), backfilledStudents: backfilledCount },
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, `School code '${schoolCode.toUpperCase()}' set successfully.`, {
    schoolCode: schoolCode.toUpperCase(),
    backfilledStudents: backfilledCount,
  });
});

/**
 * GET /api/v1/students/section/:sectionId
 * Authoritative Student Roster for an assigned section
 * Strict server-side verification:
 * - Active session required
 * - If TEACHER: must match teacher's schoolId and assigned section
 * - Strictly strips all credentials, passwords, tokens, and admin-only fields
 */
export const handleGetSectionStudents = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { sectionId } = request.params;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, 'A valid 24-character hexadecimal sectionId is required.');
  }

  const section = await Section.findById(sectionId)
    .populate('classId', 'name numericGrade code')
    .populate('classTeacherId', 'fullName designation email')
    .lean();

  if (!section) {
    return sendError(response, 404, 'Class section not found in municipal registry.');
  }

  // Enforce active account
  if (requestingActor.status && requestingActor.status !== USER_STATUS.ACTIVE) {
    return sendError(response, 403, 'Access denied. Your account is not in an active state. Contact your Head Master.');
  }

  // ── Jurisdictional Authorization Boundary ──────────────────────────────────
  if (requestingActor.role === ROLES.TEACHER) {
    const teacherSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    const sectionSchoolId = String(section.schoolId);

    if (!teacherSchoolId || teacherSchoolId !== sectionSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot view student rosters for a school other than your verified posting.');
    }

    if (!section.classTeacherId) {
      return sendError(response, 403, 'Access denied. You are not assigned to this section. Subject-teacher section access requires a TeacherSectionAssignment domain model which is not yet implemented.');
    }

    const assignedTeacherId = String(section.classTeacherId._id || section.classTeacherId);
    const actorId = String(requestingActor._id || requestingActor.userId);
    if (assignedTeacherId !== actorId) {
      return sendError(response, 403, 'Access denied. You are not the assigned class teacher for this section.');
    }
  } else if (requestingActor.role === ROLES.HM) {
    const hmSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (hmSchoolId !== String(section.schoolId)) {
      return sendError(response, 403, 'Access denied. This section belongs to another school.');
    }
  }

  // ── Retrieve Active Students ───────────────────────────────────────────────
  const studentProfiles = await StudentProfile.find({
    sectionId: section._id,
    schoolId: section.schoolId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  })
    .populate('userId', 'fullName email phoneNumber status')
    .sort({ grNumber: 1 })
    .lean();

  // ── Strict Data Sanitization (Zero credentials/passwords exposed) ───────────
  const sanitizedStudents = studentProfiles.map((profile) => ({
    _id: profile._id,
    userId: profile.userId?._id,
    fullName: profile.userId?.fullName || 'Student',
    email: profile.userId?.email || '',
    phoneNumber: profile.userId?.phoneNumber || '',
    grNumber: profile.grNumber,
    globalStudentId: profile.globalStudentId || `GR-${profile.grNumber}`,
    gender: profile.gender || 'UNSPECIFIED',
    fatherOrGuardianName: profile.fatherOrGuardianName,
    guardianContactNumber: profile.guardianContactNumber,
    admissionDate: profile.admissionDate,
    lifecycleStatus: profile.lifecycleStatus,
  }));

  return sendSuccess(response, 200, 'Section student roster retrieved successfully.', {
    section: {
      _id: section._id,
      name: section.name,
      roomNumber: section.roomNumber || '',
      capacity: section.capacity,
      class: section.classId,
      classTeacher: section.classTeacherId,
    },
    students: sanitizedStudents,
    totalCount: sanitizedStudents.length,
  });
});
