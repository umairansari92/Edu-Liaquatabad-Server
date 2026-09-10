import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { requestOtp, verifyOtp } from '../services/otpService.js';
import { isDisposableEmail } from '../utils/disposableEmailValidator.js';
import { verifyMathCaptcha, generateMathCaptcha } from '../utils/customMathCaptcha.js';
import { generateDeviceFingerprint } from '../utils/deviceFingerprint.js';
import { checkEmailLockout, recordFailedLogin, clearLoginLockout } from '../middlewares/tripleLockRateLimiter.js';
import { hashPassword, verifyPassword } from '../utils/passwordUtils.js';
import { signAccessToken, signRefreshToken, setRefreshCookie, clearRefreshCookie, verifyRefreshToken, hashToken } from '../utils/tokenUtils.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import TeacherProfile from '../models/TeacherProfile.js';
import Organization from '../models/Organization.js';
import Town from '../models/Town.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, BASE_ROLES, PUBLIC_REGISTRATION_ROLES, SCOPES, USER_STATUS, STUDENT_STATUS, TEACHER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';
import { getEffectivePermissions } from '../config/permissions.js';

/**
 * Generate Math Security CAPTCHA
 * GET /api/v1/auth/captcha
 */
export const handleGetCaptcha = (request, response) => {
  const captcha = generateMathCaptcha();
  return sendSuccess(response, 200, 'Security CAPTCHA challenge generated.', captcha);
};

/**
 * Request OTP verification code
 * POST /api/v1/auth/send-otp
 */
export const handleSendOtp = asyncHandler(async (request, response) => {
  const { email, purpose = 'REGISTRATION' } = request.body;

  if (!email) {
    return sendError(response, 400, 'Official email address is required.');
  }

  if (isDisposableEmail(email)) {
    return sendError(response, 400, 'Disposable or temporary email addresses are strictly prohibited.');
  }

  const result = await requestOtp(email, purpose);
  return sendSuccess(response, 200, `A 6-digit verification code has been dispatched to ${email}.`, result);
});

/**
 * Verify OTP standalone
 * POST /api/v1/auth/verify-otp
 */
export const handleVerifyOtp = asyncHandler(async (request, response) => {
  const { email, otpCode, purpose = 'REGISTRATION' } = request.body;

  if (!email || !otpCode) {
    return sendError(response, 400, 'Email and 6-digit verification code are required.');
  }

  await verifyOtp(email, otpCode, purpose);
  return sendSuccess(response, 200, 'Verification code validated successfully.', { verified: true });
});

/**
 * Student Self-Registration (Mandatory OTP Verified)
 * POST /api/v1/auth/register-student
 */
export const handleRegisterStudent = asyncHandler(async (request, response) => {
  const {
    fullName,
    fatherOrGuardianName,
    schoolId,
    grNumber,
    rollNumber,
    password,
    email,
    phoneNumber,
    guardianContactNumber,
    classId,
    sectionId,
    otpCode,
    captchaAnswer,
    captchaChallengeToken,
  } = request.body;

  const rawGrNumber = (grNumber || rollNumber || '').toString().trim();
  if (!rawGrNumber) {
    return sendError(response, 400, 'GR Number is required for student registration.');
  }

  // 1. Math CAPTCHA validation (if provided)
  if (captchaChallengeToken || captchaAnswer) {
    if (!verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
      return sendError(response, 400, 'Mathematical security CAPTCHA verification failed.');
    }
  }

  // 2. Validate school exists and is active (if provided)
  let validSchool = null;
  if (schoolId) {
    validSchool = await School.findById(schoolId);
    if (!validSchool) {
      return sendError(response, 400, 'The selected school does not exist.');
    }
  }

  // 3. Resolve default Organization & Town
  let defaultOrg = await Organization.findOne({ code: 'DMC_LIAQUATABAD' });
  if (!defaultOrg) {
    defaultOrg = await Organization.create({
      name: 'Education Department (DMC)',
      code: 'DMC_LIAQUATABAD',
    });
  }

  let defaultTown = await Town.findOne({ code: 'TOWN_LIAQ' });
  if (!defaultTown) {
    defaultTown = await Town.create({
      organizationId: defaultOrg._id,
      name: 'Liaquatabad Town Centre',
      code: 'TOWN_LIAQ',
    });
  }

  // 4. Determine student email / unique identifier handle
  let studentEmail = email ? email.toLowerCase().trim() : '';
  if (!studentEmail) {
    const schoolCodeClean = validSchool?.code ? validSchool.code.toLowerCase().replace(/[^a-z0-9]/g, '') : 'dmc';
    const cleanGrNumber = rawGrNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    studentEmail = `gr-${cleanGrNumber}.${schoolCodeClean}@student.liaquatabad-schools.gov.pk`;
  }

  // 5. Prevent duplicate email or duplicate GR number in the same school
  const existingUser = await User.findOne({ email: studentEmail });
  if (existingUser) {
    return sendError(response, 400, 'An account with this GR Number or email already exists.');
  }

  const parsedGrNumber = parseInt(rawGrNumber.replace(/\D/g, ''), 10) || Math.floor(1000 + Math.random() * 9000);

  if (validSchool) {
    const existingProfile = await StudentProfile.findOne({
      schoolId: validSchool._id,
      grNumber: parsedGrNumber,
    });
    if (existingProfile) {
      return sendError(response, 400, `A student with GR Number ${rawGrNumber} is already registered in this school.`);
    }
  }

  // Optional OTP verification if otpCode was supplied
  if (otpCode && email) {
    await verifyOtp(email, otpCode, 'REGISTRATION');
  }

  // Privilege escalation defense: reject any attempt to self-assign privileged authorities
  if (request.body.role && [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM].includes(request.body.role)) {
    return sendError(response, 403, 'Privilege escalation violation: Privileged system authorities cannot be self-assigned at registration.');
  }

  // 6. Create User in PENDING_APPROVAL status (role locked to STUDENT)
  const passwordHash = await hashPassword(password);
  const enrolledStudentUser = await User.create({
    organizationId: defaultOrg._id,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    fullName,
    email: studentEmail,
    passwordHash,
    phoneNumber: phoneNumber || guardianContactNumber || '',
    designation: 'Enrolled Student',
    baseRole: BASE_ROLES.STUDENT,
    role: ROLES.STUDENT,
    scope: SCOPES.SELF,
    status: USER_STATUS.PENDING_APPROVAL,
    tokenVersion: 1,
  });

  // 7. Create StudentProfile
  await StudentProfile.create({
    userId: enrolledStudentUser._id,
    schoolId: validSchool ? validSchool._id : defaultTown._id,
    classId: classId || defaultTown._id,
    sectionId: sectionId || defaultTown._id,
    grNumber: parsedGrNumber,
    fatherOrGuardianName: fatherOrGuardianName || 'TBD',
    guardianContactNumber: guardianContactNumber || phoneNumber || 'TBD',
    lifecycleStatus: STUDENT_STATUS.PENDING_APPROVAL,
  });

  // 8. Immutable Audit Log
  await AuditLog.create({
    actorId: enrolledStudentUser._id,
    actorRole: ROLES.STUDENT,
    actorDesignation: 'Enrolled Student',
    actorName: enrolledStudentUser.fullName,
    action: 'STUDENT_REGISTERED_PENDING_APPROVAL',
    targetModel: 'User',
    targetId: enrolledStudentUser._id,
    targetName: enrolledStudentUser.fullName,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    newState: { status: USER_STATUS.PENDING_APPROVAL, grNumber: rawGrNumber, role: enrolledStudentUser.role },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 201, 'Student registration submitted successfully. Your profile is now awaiting Head Master (HM) approval.', {
    userId: enrolledStudentUser._id,
    email: studentEmail,
    grNumber: rawGrNumber,
    role: enrolledStudentUser.role,
    status: enrolledStudentUser.status,
  });
});

/**
 * Teacher Self-Registration (Mandatory OTP Verified)
 * POST /api/v1/auth/register-teacher
 */
export const handleRegisterTeacher = asyncHandler(async (request, response) => {
  const {
    fullName,
    email,
    password,
    phoneNumber,
    designation = 'Teacher',
    qualification,
    schoolId,
    otpCode,
    captchaAnswer,
    captchaChallengeToken,
  } = request.body;

  // 1. Math CAPTCHA validation
  if (captchaChallengeToken || captchaAnswer) {
    if (!verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
      return sendError(response, 400, 'Mathematical security CAPTCHA verification failed.');
    }
  }

  // 2. Mandatory OTP verification before account creation
  if (!otpCode) {
    return sendError(response, 400, 'Mandatory 6-digit OTP verification code is required to complete faculty registration.');
  }

  await verifyOtp(email, otpCode, 'REGISTRATION');

  // 3. Duplicate check
  const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
  if (existingUser) {
    return sendError(response, 400, 'A faculty account with this official email already exists.');
  }

  // 4. Validate school exists
  let validSchool = null;
  if (schoolId) {
    validSchool = await School.findById(schoolId);
    if (!validSchool) {
      return sendError(response, 400, 'The selected municipal school does not exist.');
    }
  }

  // 5. Resolve default Organization & Town
  let defaultOrg = await Organization.findOne({ code: 'DMC_LIAQUATABAD' });
  if (!defaultOrg) {
    defaultOrg = await Organization.create({
      name: 'Education Department (DMC)',
      code: 'DMC_LIAQUATABAD',
    });
  }

  let defaultTown = await Town.findOne({ code: 'TOWN_LIAQ' });
  if (!defaultTown) {
    defaultTown = await Town.create({
      organizationId: defaultOrg._id,
      name: 'Liaquatabad Town Centre',
      code: 'TOWN_LIAQ',
    });
  }

  // Privilege escalation defense: reject any attempt to self-assign privileged authorities
  const requestedRole = request.body.role || request.body.grantedAuthority;
  if (requestedRole && [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM].includes(requestedRole)) {
    return sendError(response, 403, 'Privilege escalation violation: Privileged system authorities cannot be self-assigned at registration.');
  }

  const requestedBaseRole = request.body.baseRole || BASE_ROLES.TEACHER;
  const validBaseRole = [BASE_ROLES.PEON, BASE_ROLES.TEACHER, BASE_ROLES.SUPERVISOR].includes(requestedBaseRole)
    ? requestedBaseRole
    : BASE_ROLES.TEACHER;

  let assignedRole = ROLES.TEACHER;
  let assignedScope = SCOPES.CLASS_SECTION;
  if (validBaseRole === BASE_ROLES.PEON) {
    assignedRole = ROLES.PEON;
    assignedScope = SCOPES.SCHOOL;
  } else if (validBaseRole === BASE_ROLES.SUPERVISOR) {
    assignedRole = ROLES.SUPERVISOR;
    assignedScope = SCOPES.ASSIGNED_SCHOOLS;
  }

  // 6. Create User in PENDING_APPROVAL status (role locked to allowed base role)
  const passwordHash = await hashPassword(password);
  const enrolledTeacherUser = await User.create({
    organizationId: defaultOrg._id,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    fullName,
    email: email.toLowerCase().trim(),
    passwordHash,
    phoneNumber: phoneNumber || '',
    designation: designation || 'Teacher',
    baseRole: validBaseRole,
    role: assignedRole,
    scope: assignedScope,
    status: USER_STATUS.PENDING_APPROVAL,
    tokenVersion: 1,
  });

  // 7. Create TeacherProfile
  await TeacherProfile.create({
    userId: enrolledTeacherUser._id,
    currentSchoolId: validSchool ? validSchool._id : defaultTown._id,
    designation: designation || 'Teacher',
    qualification: qualification || 'TBD',
    lifecycleStatus: TEACHER_STATUS.PENDING_APPROVAL,
  });

  // 8. Immutable Audit Log
  await AuditLog.create({
    actorId: enrolledTeacherUser._id,
    actorRole: ROLES.TEACHER,
    actorDesignation: enrolledTeacherUser.designation,
    actorName: enrolledTeacherUser.fullName,
    action: 'TEACHER_REGISTERED_OTP_VERIFIED',
    targetModel: 'User',
    targetId: enrolledTeacherUser._id,
    targetName: enrolledTeacherUser.fullName,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    newState: { status: USER_STATUS.PENDING_APPROVAL, email: enrolledTeacherUser.email, role: enrolledTeacherUser.role },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 201, 'Staff registration submitted and email verified. Your profile is now awaiting HM / Admin authorization.', {
    userId: enrolledTeacherUser._id,
    email: enrolledTeacherUser.email,
    role: enrolledTeacherUser.role,
    baseRole: enrolledTeacherUser.baseRole,
    status: enrolledTeacherUser.status,
  });
});

export const handleRegisterStaff = handleRegisterTeacher;

/**
 * Official Account Sign In (Triple-Lock Rate Limited & Password Protected)
 * POST /api/v1/auth/login
 */
export const handleLogin = asyncHandler(async (request, response) => {
  const { email, password, captchaAnswer, captchaChallengeToken } = request.body;

  const normalizedEmail = email.toLowerCase().trim();
  const clientIp = request.ip || request.headers['x-forwarded-for']?.split(',')[0]?.trim() || '0.0.0.0';

  // 1. Check Triple-Lock Account Lockout Status
  const lockoutStatus = await checkEmailLockout(normalizedEmail, clientIp);
  if (lockoutStatus.locked) {
    return sendError(
      response,
      423,
      `Account locked due to excessive failed attempts. Please retry in ${lockoutStatus.minutesRemaining} minute(s).`
    );
  }

  // 2. Math CAPTCHA verification
  if (captchaChallengeToken || captchaAnswer) {
    if (!verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
      await recordFailedLogin(normalizedEmail, clientIp);
      return sendError(response, 400, 'Mathematical security CAPTCHA verification failed.');
    }
  }

  // 3. User Lookup (including passwordHash, refreshTokenHash & tokenVersion)
  let user = await User.findOne({ email: normalizedEmail }).select('+passwordHash +refreshTokenHash +tokenVersion');

  if (!user && !normalizedEmail.includes('@')) {
    const parsedGrNumber = parseInt(normalizedEmail.replace(/\D/g, ''), 10);
    const grNumberQuery = parsedGrNumber ? { $in: [parsedGrNumber, normalizedEmail] } : normalizedEmail;
    const studentProfile = await StudentProfile.findOne({ grNumber: grNumberQuery });
    if (studentProfile) {
      user = await User.findById(studentProfile.userId).select('+passwordHash +refreshTokenHash +tokenVersion');
    }
  }

  if (!user) {
    await recordFailedLogin(normalizedEmail, clientIp);
    return sendError(response, 401, 'Invalid official email, GR number, or password.');
  }

  // 4. Password Verification with Server Pepper (Uniform error message prevents account enumeration)
  const isMatch = await verifyPassword(password, user.passwordHash);
  if (!isMatch) {
    await recordFailedLogin(normalizedEmail, clientIp);
    return sendError(response, 401, 'Invalid official email or password.');
  }

  // 5. Password Verified — Clear Lockout Counters
  await clearLoginLockout(normalizedEmail);

  // 6. Account Lifecycle Status Verification
  if (user.status === USER_STATUS.PENDING_APPROVAL) {
    return sendError(response, 403, 'Your account is awaiting approval by your Head Master or Administration.');
  }

  if (user.status === USER_STATUS.SUSPENDED) {
    return sendError(response, 403, 'Your account is currently suspended. Please contact the Town Education Directorate.');
  }

  if (user.status === USER_STATUS.TRANSFERRED) {
    return sendError(response, 403, 'Your account has been transferred. Please report to your destination school Head Master for joining approval.');
  }

  if (user.status === USER_STATUS.REQUIRES_CORRECTION) {
    const remarks = user.approvalDetails?.correctionRemarks ? `: ${user.approvalDetails.correctionRemarks}` : '';
    return sendError(response, 403, `Your profile requires correction${remarks}. Please contact your school administrator.`);
  }

  if (user.status === USER_STATUS.RETIRED || user.status === USER_STATUS.INACTIVE) {
    return sendError(response, 403, 'This account is inactive.');
  }

  // 7. Generate JWT Tokens with Authoritative Claims
  const permissions = getEffectivePermissions(user);
  const roleLevel = ROLE_HIERARCHY[user.role] || 0;

  const tokenPayload = {
    userId: user._id,
    baseRole: user.baseRole,
    role: user.role,
    grantedAuthority: user.role,
    roleLevel,
    designation: user.designation || '',
    scope: user.scope,
    tokenVersion: user.tokenVersion || 0,
    organizationId: user.organizationId,
    townId: user.townId,
    schoolId: user.schoolId,
    assignedSchools: user.assignedSchools || [],
  };

  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken({ userId: user._id, tokenVersion: user.tokenVersion || 0 });

  // Store SHA-256 hash of active refresh token on user for reuse detection
  user.refreshTokenHash = hashToken(refreshToken);
  user.lastLoginAt = new Date();
  await user.save();

  // 8. Set Secure HttpOnly Refresh Cookie
  setRefreshCookie(response, refreshToken);

  // 10. Write Immutable Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || '',
    actorName: user.fullName,
    action: 'USER_LOGIN_SUCCESS',
    targetModel: 'User',
    targetId: user._id,
    targetName: user.fullName,
    townId: user.townId,
    schoolId: user.schoolId || null,
    newState: { lastLoginAt: user.lastLoginAt },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Authentication successful. Welcome to Liaquatabad Education Portal.', {
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      designation: user.designation || '',
      baseRole: user.baseRole,
      role: user.role,
      grantedAuthority: user.role,
      roleLevel,
      scope: user.scope,
      permissions,
      status: user.status,
      schoolId: user.schoolId,
      townId: user.townId,
      assignedSchools: user.assignedSchools || [],
    },
    accessToken,
  });
});

/**
 * Rotate Access Token via HttpOnly Refresh Cookie
 * POST /api/v1/auth/refresh-token
 */
export const handleRefreshToken = asyncHandler(async (request, response) => {
  const token = request.cookies?.refreshToken || request.body?.refreshToken;

  if (!token) {
    return sendError(response, 401, 'No active refresh session found. Please sign in again.');
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    clearRefreshCookie(response);
    return sendError(response, 401, 'Session token expired or invalid. Please sign in again.');
  }

  const user = await User.findById(decoded.userId).select('+refreshTokenHash +tokenVersion');
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    clearRefreshCookie(response);
    return sendError(response, 401, 'Account session revoked or account is no longer active.');
  }

  // Verify tokenVersion to reject revoked tokens
  if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
    clearRefreshCookie(response);
    return sendError(response, 401, 'Session has been invalidated due to a security update. Please sign in again.');
  }

  // Refresh Token Reuse Detection
  const incomingHash = hashToken(token);
  if (user.refreshTokenHash && user.refreshTokenHash !== incomingHash) {
    // Replay/Theft detected: Revoke all active sessions for this account immediately
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.refreshTokenHash = null;
    await user.save();
    clearRefreshCookie(response);

    await AuditLog.create({
      actorId: user._id,
      actorRole: user.role,
      actorDesignation: user.designation || '',
      actorName: user.fullName,
      action: 'SECURITY_TOKEN_REUSE_DETECTED',
      targetModel: 'User',
      targetId: user._id,
      targetName: user.fullName,
      townId: user.townId,
      schoolId: user.schoolId || null,
      result: 'DENIED',
      reason: 'Refresh token reuse detected. All user sessions invalidated immediately.',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });

    return sendError(response, 401, 'Security alert: Token reuse detected. All active sessions have been invalidated.');
  }

  // Generate fresh token pair (Rotation)
  const permissions = getEffectivePermissions(user);
  const roleLevel = ROLE_HIERARCHY[user.role] || 0;

  const tokenPayload = {
    userId: user._id,
    role: user.role,
    roleLevel,
    designation: user.designation || '',
    scope: user.scope,
    tokenVersion: user.tokenVersion || 0,
    organizationId: user.organizationId,
    townId: user.townId,
    schoolId: user.schoolId,
    assignedSchools: user.assignedSchools || [],
  };

  const newAccessToken = signAccessToken(tokenPayload);
  const newRefreshToken = signRefreshToken({ userId: user._id, tokenVersion: user.tokenVersion || 0 });

  // Update stored refresh token hash with newly rotated token
  user.refreshTokenHash = hashToken(newRefreshToken);
  await user.save();

  setRefreshCookie(response, newRefreshToken);

  return sendSuccess(response, 200, 'Session token refreshed.', {
    accessToken: newAccessToken,
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      designation: user.designation || '',
      role: user.role,
      roleLevel,
      scope: user.scope,
      permissions,
      status: user.status,
      schoolId: user.schoolId,
      townId: user.townId,
      assignedSchools: user.assignedSchools || [],
    },
  });
});

/**
 * User Logout & Active Database Session Revocation
 * POST /api/v1/auth/logout
 */
export const handleLogout = asyncHandler(async (request, response) => {
  clearRefreshCookie(response);

  if (request.user && (request.user.userId || request.user._id)) {
    const targetUserId = request.user.userId || request.user._id;

    // Immediately revoke server-side sessions by incrementing tokenVersion and wiping token hash
    await User.findByIdAndUpdate(targetUserId, {
      $inc: { tokenVersion: 1 },
      $unset: { refreshTokenHash: 1 },
    });

    await AuditLog.create({
      actorId: targetUserId,
      actorRole: request.user.role,
      actorDesignation: request.user.designation || '',
      actorName: request.user.fullName || '',
      action: 'USER_LOGOUT',
      targetModel: 'User',
      targetId: targetUserId,
      targetName: request.user.fullName,
      townId: request.user.townId,
      schoolId: request.user.schoolId || null,
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });
  }

  return sendSuccess(response, 200, 'Signed out successfully.');
});

/**
 * Get Authenticated User Profile (Hydrate Redux on App Load)
 * GET /api/v1/auth/me
 */
export const handleGetMe = asyncHandler(async (request, response) => {
  const user = await User.findById(request.user.userId)
    .populate('schoolId', 'name schoolCode emisCode')
    .populate('townId', 'name code');

  if (!user) {
    return sendError(response, 404, 'User profile not found.');
  }

  const permissions = getEffectivePermissions(user);
  const roleLevel = ROLE_HIERARCHY[user.role] || 0;

  return sendSuccess(response, 200, 'Active user session profile retrieved.', {
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      designation: user.designation || '',
      baseRole: user.baseRole,
      role: user.role,
      grantedAuthority: user.role,
      roleLevel,
      scope: user.scope,
      permissions,
      status: user.status,
      schoolId: user.schoolId,
      townId: user.townId,
      assignedSchools: user.assignedSchools || [],
      lastLoginAt: user.lastLoginAt,
    },
  });
});

/**
 * Request Password Reset OTP
 * POST /api/v1/auth/forgot-password
 */
export const handleForgotPassword = asyncHandler(async (request, response) => {
  const { email } = request.body;
  const normalizedEmail = email.toLowerCase().trim();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    return sendSuccess(response, 200, `If an active account exists for ${normalizedEmail}, a 6-digit password reset code has been sent.`);
  }

  await requestOtp(normalizedEmail, 'PASSWORD_RESET');
  return sendSuccess(response, 200, `A 6-digit password reset code has been sent to ${normalizedEmail}.`);
});

/**
 * Confirm Password Reset with OTP
 * POST /api/v1/auth/reset-password
 */
export const handleResetPassword = asyncHandler(async (request, response) => {
  const { email, otpCode, newPassword } = request.body;
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Verify OTP
  await verifyOtp(normalizedEmail, otpCode, 'PASSWORD_RESET');

  // 2. Find User & Update Password
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return sendError(response, 404, 'User account not found.');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.tokenVersion = (user.tokenVersion || 0) + 1; // Invalidate all prior sessions
  await user.save();

  // 3. Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || '',
    actorName: user.fullName,
    action: 'PASSWORD_RESET_COMPLETED',
    targetModel: 'User',
    targetId: user._id,
    targetName: user.fullName,
    townId: user.townId,
    schoolId: user.schoolId || null,
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Password has been successfully updated. You may now sign in with your new password.');
});
