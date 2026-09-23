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
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import AuditLog from '../models/AuditLog.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
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

// Roles authorized to inspect school student directory
const DIRECTORY_ALLOWED_ROLES = new Set([
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
    bFormNumber,
    mediumOfInstruction = 'URDU',
    guardianName,
    guardianContact,
    residentialAddress,
    classId,
    sectionId,
    admissionDate,
    manualGrNumber,
    email,
  } = request.body;

  // ── Step 0: Academic Cross-Validation Guard (Critical Security Boundary) ───
  const targetClass = await Class.findById(classId).lean();
  if (!targetClass) {
    return sendError(response, 400, 'Invalid class selected. The specified class does not exist.');
  }
  if (String(targetClass.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 400, 'Invalid class selected. The specified class does not belong to the target school.');
  }

  const targetSection = await Section.findById(sectionId).lean();
  if (!targetSection) {
    return sendError(response, 400, 'Invalid section selected. The specified section does not exist.');
  }
  if (String(targetSection.classId) !== String(classId)) {
    return sendError(response, 400, 'Invalid section selected. The section does not belong to the specified class.');
  }
  if (targetSection.schoolId && String(targetSection.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 400, 'Invalid section selected. The section does not belong to the target school.');
  }

  // ── Step 1: Determine GR No ────────────────────────────────────────────────
  let assignedGrNumber;

  if (admissionType === 'NEW_ADMISSION') {
    // Atomically increment and get next GR No
    assignedGrNumber = await generateNextGrNumber(effectiveSchoolId);
  } else {
    // EXISTING_ENTRY: validate the manually provided GR is not already taken
    try {
      await validateManualGrNumber(effectiveSchoolId, manualGrNumber);
    } catch (manualGrValidationError) {
      return sendError(
        response,
        manualGrValidationError.statusCode || 400,
        manualGrValidationError.message || 'Invalid GR number provided.'
      );
    }
    assignedGrNumber = manualGrNumber;
    // Sync counter so future auto-GRs don't collide
    await syncGrCounterIfNeeded(effectiveSchoolId, manualGrNumber);
  }

  // ── Step 2: Generate Global Student ID ─────────────────────────────────────
  // Returns null if schoolCode not yet assigned to this school (deferred)
  const globalStudentId = await generateGlobalStudentId(effectiveSchoolId);

  // ── Step 3: Determine Student Email & Create User Account ──────────────────
  const targetSchool = await School.findById(effectiveSchoolId).select('code schoolCode').lean();
  const rawSchoolCode = targetSchool?.schoolCode || targetSchool?.code || 'dmc';
  const schoolCodeClean = rawSchoolCode.toLowerCase().replace(/[^a-z0-9]/g, '');

  let studentEmail = (email || '').trim().toLowerCase();
  if (!studentEmail) {
    studentEmail = `gr-${assignedGrNumber}.${schoolCodeClean}@student.liaquatabad-schools.gov.pk`;
  }

  const existingUser = await User.findOne({ email: studentEmail });
  if (existingUser) {
    return sendError(response, 400, 'An account with this student email or GR identity already exists.');
  }

  const temporaryPasswordHash = await hashPassword(`Student@${assignedGrNumber}`);
  const enrolledUser = await User.create({
    organizationId: request.user?.organizationId,
    townId: request.user?.townId,
    schoolId: effectiveSchoolId,
    fullName: fullName.trim(),
    email: studentEmail,
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
    studentFullName: fullName.trim(),
    admissionType,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
    gender,
    bFormNumber: bFormNumber ? bFormNumber.trim() : undefined,
    mediumOfInstruction: (mediumOfInstruction || 'URDU').toUpperCase(),
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
    schoolId: effectiveSchoolId,
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
 * GET /api/v1/students/my-profile
 * Dedicated Student Workspace Profile Endpoint
 * Resolves exclusively from authenticated request.user._id (Zero trust for client input).
 * Sanitized projection: Zero credentials, tokens, session metadata, or administrative notes.
 * Enforces active lifecycleStatus and verified school linkage.
 */
export const handleGetMyStudentProfile = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  if (requestingActor.role !== ROLES.STUDENT) {
    return sendError(response, 403, 'Access denied. Only registered students may access the student profile endpoint.');
  }

  const authenticatedStudentUserId = requestingActor._id || requestingActor.userId;

  const studentProfile = await StudentProfile.findOne({
    userId: authenticatedStudentUserId,
  })
    .populate('userId', 'fullName email phoneNumber status')
    .populate('schoolId', 'name schoolCode code emisCode address townId')
    .populate('classId', 'name numericGrade code')
    .populate('sectionId', 'name roomNumber capacity')
    .lean();

  if (!studentProfile) {
    return sendError(response, 404, 'Active student profile record not found. Please contact your school Head Master.');
  }

  if (studentProfile.lifecycleStatus !== STUDENT_STATUS.ACTIVE) {
    return sendError(
      response,
      403,
      `Your student profile status is "${studentProfile.lifecycleStatus}". Only active students can access their workspace.`
    );
  }

  const sanitizedProfile = {
    _id: studentProfile._id,
    studentFullName: studentProfile.studentFullName || studentProfile.userId?.fullName || 'Student',
    grNumber: studentProfile.grNumber,
    rollNumber: studentProfile.rollNumber || String(studentProfile.grNumber),
    admissionRegisterNumber: studentProfile.admissionRegisterNumber || '',
    globalStudentId: studentProfile.globalStudentId || '',
    admissionType: studentProfile.admissionType,
    dateOfBirth: studentProfile.dateOfBirth,
    dateOfBirthInWords: studentProfile.dateOfBirthInWords || '',
    gender: studentProfile.gender,
    religion: studentProfile.religion || 'ISLAM',
    placeOfBirth: studentProfile.placeOfBirth || '',
    studentPhotoUrl: studentProfile.studentPhotoUrl || '',
    bFormNumber: studentProfile.bFormNumber || '',
    school: studentProfile.schoolId ? {
      _id: studentProfile.schoolId._id,
      name: studentProfile.schoolId.name,
      code: studentProfile.schoolId.code || studentProfile.schoolId.schoolCode || '',
      schoolCode: studentProfile.schoolId.schoolCode || studentProfile.schoolId.code || '',
      emisCode: studentProfile.schoolId.emisCode || '',
      address: studentProfile.schoolId.address || '',
    } : null,
    class: studentProfile.classId ? {
      _id: studentProfile.classId._id,
      name: studentProfile.classId.name,
      numericGrade: studentProfile.classId.numericGrade,
      code: studentProfile.classId.code,
    } : null,
    section: studentProfile.sectionId ? {
      _id: studentProfile.sectionId._id,
      name: studentProfile.sectionId.name,
      roomNumber: studentProfile.sectionId.roomNumber || '',
    } : null,
    guardian: {
      fullName: studentProfile.fatherFullName || studentProfile.fatherOrGuardianName || '',
      cellNumber: studentProfile.guardianCellNumber || studentProfile.guardianContactNumber || '',
      relationship: studentProfile.relationshipWithStudent || 'FATHER',
    },
    admissionDate: studentProfile.admissionDate,
    lifecycleStatus: studentProfile.lifecycleStatus,
  };

  return sendSuccess(response, 200, 'Student profile retrieved successfully.', {
    profile: sanitizedProfile,
  });
});

/**
 * GET /api/v1/students/section/:sectionId
 * Authoritative Student Roster for an assigned section
 * Strict server-side verification:
 * - Active session required
 * - Role = STUDENT explicitly rejected with 403 Forbidden (Privacy boundary)
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

  // ── Privacy & Anti-Harassment Boundary: Students cannot inspect section rosters ──
  if (requestingActor.role === ROLES.STUDENT) {
    await AuditLog.create({
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorName: requestingActor.fullName || '',
      action: 'STUDENT_ROSTER_ACCESS_BLOCKED',
      targetModel: 'Section',
      targetId: sectionId,
      targetName: request.originalUrl,
      schoolId: requestingActor.schoolId || null,
      previousState: {
        attemptedSectionId: sectionId,
        studentUserId: String(requestingActor._id || requestingActor.userId),
      },
      result: 'DENIED',
      reason: 'Privacy boundary violation: Student attempted to access class section student roster.',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
    });
    return sendError(response, 403, 'Access denied. Students are not authorized to view class section rosters.');
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

    const actorId = String(requestingActor._id || requestingActor.userId);
    const isClassTeacher = section.classTeacherId && String(section.classTeacherId._id || section.classTeacherId) === actorId;
    const isSubjectTeacher = await TeachingAssignment.isTeacherAssigned({
      teacherId: actorId,
      schoolId: teacherSchoolId,
      sectionId: section._id,
    });

    if (!isClassTeacher && !isSubjectTeacher) {
      return sendError(response, 403, 'Access denied. You are not assigned to this section as Class Teacher or Subject Teacher.');
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

/**
 * GET /api/v1/students/school
 * Authoritative School Student Directory
 * Strict server-side verification:
 * - Active session required
 * - Role must be authorized (HM, SUPERVISOR, ADMIN, SUPER_ADMIN, ROOT_ADMIN)
 * - If HM: strictly scoped to request.user.schoolId. Explicitly rejects manipulated schoolId with 403.
 * - Server-side search (numeric GR fast-path, globalStudentId, name search)
 * - Pagination with safe bounded limit (max 100)
 * - Filtering by classId, sectionId, gender, lifecycleStatus
 * - Minimal response projection (Zero credentials/passwords exposed)
 */
export const handleGetSchoolStudents = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorRole = requestingActor?.role;

  if (!DIRECTORY_ALLOWED_ROLES.has(actorRole)) {
    return sendError(response, 403, 'Access denied. You do not have permission to view the student directory.');
  }

  // ── Strict School Scope Enforcement (Anti-BOLA/IDOR Shield) ───────────────
  let effectiveSchoolId;

  if (actorRole === ROLES.HM) {
    if (!requestingActor.schoolId) {
      return sendError(response, 400, 'Your Head Master account is not linked to an authorized school.');
    }
    // Explicit test requirement: HM School A requesting School B must be rejected with 403
    if (request.query.schoolId && String(request.query.schoolId) !== String(requestingActor.schoolId)) {
      return sendError(response, 403, 'Access denied. You can only access students belonging to your assigned school.');
    }
    effectiveSchoolId = requestingActor.schoolId;
  } else {
    // For Supervisor / Admin / Root Admin:
    effectiveSchoolId = request.query.schoolId || requestingActor.schoolId;
    if (!effectiveSchoolId) {
      return sendError(response, 400, 'School identifier is required to view the student directory.');
    }
  }

  const {
    page = 1,
    limit = 20,
    search,
    classId,
    sectionId,
    gender,
    lifecycleStatus,
    sortBy = 'grNumber',
    sortOrder = 'asc',
  } = request.query;

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skipCount = (pageNumber - 1) * pageSize;

  // ── Construct Scoped Query Filter ──────────────────────────────────────────
  const queryFilter = { schoolId: effectiveSchoolId };

  if (classId) queryFilter.classId = classId;
  if (sectionId) queryFilter.sectionId = sectionId;
  if (gender) queryFilter.gender = gender;
  if (lifecycleStatus) {
    queryFilter.lifecycleStatus = lifecycleStatus;
  }

  // ── Server-Side Search Engine (Optimized Index Strategy) ───────────────────
  if (search && search.trim()) {
    const rawSearch = search.trim();
    const numericSearch = Number(rawSearch);
    const isPureInteger = !Number.isNaN(numericSearch) && Number.isInteger(numericSearch);

    if (isPureInteger) {
      // 100% Index lookup on { schoolId: 1, grNumber: 1 }
      queryFilter.grNumber = numericSearch;
    } else {
      // Safe escaped regex against ReDoS injection
      const sanitizedSearch = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(sanitizedSearch, 'i');

      // Find any user accounts belonging to this school matching the name
      const matchingUserIds = await User.find({
        schoolId: effectiveSchoolId,
        fullName: searchRegex,
      }).distinct('_id');

      queryFilter.$or = [
        { globalStudentId: searchRegex },
        { studentFullName: searchRegex },
        { userId: { $in: matchingUserIds } },
      ];
    }
  }

  // ── Determine Sort Direction ───────────────────────────────────────────────
  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const sortCriteria = {};
  if (sortBy === 'createdAt') {
    sortCriteria.createdAt = sortDirection;
  } else if (sortBy === 'fullName') {
    sortCriteria.studentFullName = sortDirection;
  } else {
    sortCriteria.grNumber = sortDirection;
  }

  // ── Execute Concurrent Query & Count with Minimum Projection ───────────────
  const [studentProfiles, totalRecords] = await Promise.all([
    StudentProfile.find(queryFilter)
      .populate('userId', 'fullName email phoneNumber status')
      .populate('classId', 'name numericGrade')
      .populate('sectionId', 'name')
      .sort(sortCriteria)
      .skip(skipCount)
      .limit(pageSize)
      .lean(),
    StudentProfile.countDocuments(queryFilter),
  ]);

  // ── Minimal Data Sanitization (Zero credentials/passwords exposed) ──────────
  const sanitizedStudents = studentProfiles.map((studentProfile) => ({
    _id: studentProfile._id,
    grNumber: studentProfile.grNumber,
    globalStudentId: studentProfile.globalStudentId || `GR-${studentProfile.grNumber}`,
    studentName: studentProfile.userId?.fullName || studentProfile.studentFullName || 'Student',
    gender: studentProfile.gender || 'UNSPECIFIED',
    className: studentProfile.classId?.name || '—',
    classId: studentProfile.classId?._id || studentProfile.classId,
    sectionName: studentProfile.sectionId?.name || '—',
    sectionId: studentProfile.sectionId?._id || studentProfile.sectionId,
    guardianName: studentProfile.fatherOrGuardianName || '—',
    guardianContact: studentProfile.guardianContactNumber || '—',
    lifecycleStatus: studentProfile.lifecycleStatus,
    admissionDate: studentProfile.admissionDate,
    admissionType: studentProfile.admissionType,
  }));

  const totalPages = Math.ceil(totalRecords / pageSize);

  return sendSuccess(response, 200, 'School student directory retrieved successfully.', {
    students: sanitizedStudents,
    pagination: {
      currentPage: pageNumber,
      pageSize,
      totalRecords,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPreviousPage: pageNumber > 1,
    },
  });
});

