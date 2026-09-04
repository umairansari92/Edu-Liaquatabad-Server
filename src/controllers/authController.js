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
import { ROLES, SCOPES, USER_STATUS, STUDENT_STATUS, TEACHER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';
import { getEffectivePermissions } from '../config/permissions.js';

/**
 * Generate Math Security CAPTCHA
 * GET /api/v1/auth/captcha
 */
export const handleGetCaptcha = (req, res) => {
  const captcha = generateMathCaptcha();
  return sendSuccess(res, 200, 'Security CAPTCHA challenge generated.', captcha);
};

/**
 * Request OTP verification code
 * POST /api/v1/auth/send-otp
 */
export const handleSendOtp = asyncHandler(async (req, res) => {
  const { email, purpose = 'REGISTRATION' } = req.body;

  if (!email) {
    return sendError(res, 400, 'Official email address is required.');
  }

  if (isDisposableEmail(email)) {
    return sendError(res, 400, 'Disposable or temporary email addresses are strictly prohibited.');
  }

  const result = await requestOtp(email, purpose);
  return sendSuccess(res, 200, `A 6-digit verification code has been dispatched to ${email}.`, result);
});

/**
 * Verify OTP standalone
 * POST /api/v1/auth/verify-otp
 */
export const handleVerifyOtp = asyncHandler(async (req, res) => {
  const { email, otpCode, purpose = 'REGISTRATION' } = req.body;

  if (!email || !otpCode) {
    return sendError(res, 400, 'Email and 6-digit verification code are required.');
  }

  await verifyOtp(email, otpCode, purpose);
  return sendSuccess(res, 200, 'Verification code validated successfully.', { verified: true });
});

/**
 * Student Self-Registration (Mandatory OTP Verified)
 * POST /api/v1/auth/register-student
 */
export const handleRegisterStudent = asyncHandler(async (req, res) => {
  const {
    fullName,
    email,
    password,
    phoneNumber,
    fatherOrGuardianName,
    guardianContactNumber,
    rollNumber,
    schoolId,
    classId,
    sectionId,
    otpCode,
    captchaAnswer,
    captchaChallengeToken,
  } = req.body;

  // 1. Math CAPTCHA validation
  if (captchaChallengeToken || captchaAnswer) {
    if (!verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
      return sendError(res, 400, 'Mathematical security CAPTCHA verification failed.');
    }
  }

  // 2. Mandatory OTP verification before account creation
  if (!otpCode) {
    return sendError(res, 400, 'Mandatory 6-digit OTP verification code is required to complete registration.');
  }

  await verifyOtp(email, otpCode, 'REGISTRATION');

  // 3. Prevent duplicate email
  const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
  if (existingUser) {
    return sendError(res, 400, 'An account with this official email already exists.');
  }

  // 4. Validate school exists and is active (if provided)
  let validSchool = null;
  if (schoolId) {
    validSchool = await School.findById(schoolId);
    if (!validSchool) {
      return sendError(res, 400, 'The selected municipal school does not exist.');
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

  // 6. Create User in PENDING_APPROVAL status (role locked to STUDENT)
  const passwordHash = await hashPassword(password);
  const user = await User.create({
    organizationId: defaultOrg._id,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    fullName,
    email: email.toLowerCase().trim(),
    passwordHash,
    phoneNumber: phoneNumber || guardianContactNumber || '',
    designation: 'Enrolled Student',
    role: ROLES.STUDENT,
    scope: SCOPES.SELF,
    status: USER_STATUS.PENDING_APPROVAL,
    tokenVersion: 1,
  });

  // 7. Create StudentProfile
  await StudentProfile.create({
    userId: user._id,
    schoolId: validSchool ? validSchool._id : defaultTown._id,
    classId: classId || defaultTown._id,
    sectionId: sectionId || defaultTown._id,
    rollNumber: rollNumber || 'TBD',
    fatherOrGuardianName: fatherOrGuardianName || 'TBD',
    guardianContactNumber: guardianContactNumber || phoneNumber || 'TBD',
    lifecycleStatus: STUDENT_STATUS.PENDING_APPROVAL,
  });

  // 8. Immutable Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: ROLES.STUDENT,
    actorDesignation: 'Enrolled Student',
    actorName: user.fullName,
    action: 'STUDENT_REGISTERED_OTP_VERIFIED',
    targetModel: 'User',
    targetId: user._id,
    targetName: user.fullName,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    newState: { status: USER_STATUS.PENDING_APPROVAL, email: user.email, role: user.role },
    result: 'SUCCESS',
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    requestId: req.headers['x-request-id'] || '',
  });

  return sendSuccess(res, 201, 'Student account registered and email verified. Your profile is now awaiting Head Master (HM) approval.', {
    userId: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
  });
});

/**
 * Teacher Self-Registration (Mandatory OTP Verified)
 * POST /api/v1/auth/register-teacher
 */
export const handleRegisterTeacher = asyncHandler(async (req, res) => {
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
  } = req.body;

  // 1. Math CAPTCHA validation
  if (captchaChallengeToken || captchaAnswer) {
    if (!verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
      return sendError(res, 400, 'Mathematical security CAPTCHA verification failed.');
    }
  }

  // 2. Mandatory OTP verification before account creation
  if (!otpCode) {
    return sendError(res, 400, 'Mandatory 6-digit OTP verification code is required to complete faculty registration.');
  }

  await verifyOtp(email, otpCode, 'REGISTRATION');

  // 3. Duplicate check
  const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
  if (existingUser) {
    return sendError(res, 400, 'A faculty account with this official email already exists.');
  }

  // 4. Validate school exists
  let validSchool = null;
  if (schoolId) {
    validSchool = await School.findById(schoolId);
    if (!validSchool) {
      return sendError(res, 400, 'The selected municipal school does not exist.');
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

  // 6. Create User in PENDING_APPROVAL status (role locked to TEACHER)
  const passwordHash = await hashPassword(password);
  const user = await User.create({
    organizationId: defaultOrg._id,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    fullName,
    email: email.toLowerCase().trim(),
    passwordHash,
    phoneNumber: phoneNumber || '',
    designation: designation || 'Teacher',
    role: ROLES.TEACHER,
    scope: SCOPES.CLASS_SECTION,
    status: USER_STATUS.PENDING_APPROVAL,
    tokenVersion: 1,
  });

  // 7. Create TeacherProfile
  await TeacherProfile.create({
    userId: user._id,
    currentSchoolId: validSchool ? validSchool._id : defaultTown._id,
    designation: designation || 'Teacher',
    qualification: qualification || 'TBD',
    lifecycleStatus: TEACHER_STATUS.PENDING_APPROVAL,
  });

  // 8. Immutable Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: ROLES.TEACHER,
    actorDesignation: user.designation,
    actorName: user.fullName,
    action: 'TEACHER_REGISTERED_OTP_VERIFIED',
    targetModel: 'User',
    targetId: user._id,
    targetName: user.fullName,
    townId: defaultTown._id,
    schoolId: validSchool ? validSchool._id : null,
    newState: { status: USER_STATUS.PENDING_APPROVAL, email: user.email, role: user.role },
    result: 'SUCCESS',
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    requestId: req.headers['x-request-id'] || '',
  });

  return sendSuccess(res, 201, 'Faculty registration submitted and email verified. Your profile is now awaiting HM / Admin authorization.', {
    userId: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
  });
});

/**
 * Official Account Sign In (Triple-Lock Rate Limited & Password Protected)
 * POST /api/v1/auth/login
 */
export const handleLogin = asyncHandler(async (req, res) => {
  const { email, password, captchaAnswer, captchaChallengeToken } = req.body;

  const normalizedEmail = email.toLowerCase().trim();
  const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '0.0.0.0';

  // 1. Check Triple-Lock Account Lockout Status
  const lockoutStatus = await checkEmailLockout(normalizedEmail, clientIp);
  if (lockoutStatus.locked) {
    return sendError(
      res,
      423,
      `Account locked due to excessive failed attempts. Please retry in ${lockoutStatus.minutesRemaining} minute(s).`
    );
  }

  // 2. Math CAPTCHA verification
  if (captchaChallengeToken || captchaAnswer) {
    if (!verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
      await recordFailedLogin(normalizedEmail, clientIp);
      return sendError(res, 400, 'Mathematical security CAPTCHA verification failed.');
    }
  }

  // 3. User Lookup (including passwordHash, refreshTokenHash & tokenVersion)
  const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash +refreshTokenHash +tokenVersion');

  if (!user) {
    await recordFailedLogin(normalizedEmail, clientIp);
    return sendError(res, 401, 'Invalid official email or password.');
  }

  // 4. Password Verification with Server Pepper (Uniform error message prevents account enumeration)
  const isMatch = await verifyPassword(password, user.passwordHash);
  if (!isMatch) {
    await recordFailedLogin(normalizedEmail, clientIp);
    return sendError(res, 401, 'Invalid official email or password.');
  }

  // 5. Password Verified — Clear Lockout Counters
  await clearLoginLockout(normalizedEmail);

  // 6. Account Lifecycle Status Verification
  if (user.status === USER_STATUS.PENDING_APPROVAL) {
    return sendError(res, 403, 'Your account is awaiting approval by your Head Master or Administration.');
  }

  if (user.status === USER_STATUS.SUSPENDED) {
    return sendError(res, 403, 'Your account is currently suspended. Please contact the Town Education Directorate.');
  }

  if (user.status === USER_STATUS.TRANSFERRED) {
    return sendError(res, 403, 'Your account has been transferred. Please report to your destination school Head Master for joining approval.');
  }

  if (user.status === USER_STATUS.REQUIRES_CORRECTION) {
    const remarks = user.approvalDetails?.correctionRemarks ? `: ${user.approvalDetails.correctionRemarks}` : '';
    return sendError(res, 403, `Your profile requires correction${remarks}. Please contact your school administrator.`);
  }

  if (user.status === USER_STATUS.RETIRED || user.status === USER_STATUS.INACTIVE) {
    return sendError(res, 403, 'This account is inactive.');
  }

  // 7. Generate JWT Tokens with Authoritative Claims
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

  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken({ userId: user._id, tokenVersion: user.tokenVersion || 0 });

  // Store SHA-256 hash of active refresh token on user for reuse detection
  user.refreshTokenHash = hashToken(refreshToken);
  user.lastLoginAt = new Date();
  await user.save();

  // 8. Set Secure HttpOnly Refresh Cookie
  setRefreshCookie(res, refreshToken);

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
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    requestId: req.headers['x-request-id'] || '',
  });

  return sendSuccess(res, 200, 'Authentication successful. Welcome to Liaquatabad Education Portal.', {
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
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
    accessToken,
  });
});

/**
 * Rotate Access Token via HttpOnly Refresh Cookie
 * POST /api/v1/auth/refresh-token
 */
export const handleRefreshToken = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!token) {
    return sendError(res, 401, 'No active refresh session found. Please sign in again.');
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    clearRefreshCookie(res);
    return sendError(res, 401, 'Session token expired or invalid. Please sign in again.');
  }

  const user = await User.findById(decoded.userId).select('+refreshTokenHash +tokenVersion');
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    clearRefreshCookie(res);
    return sendError(res, 401, 'Account session revoked or account is no longer active.');
  }

  // Verify tokenVersion to reject revoked tokens
  if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
    clearRefreshCookie(res);
    return sendError(res, 401, 'Session has been invalidated due to a security update. Please sign in again.');
  }

  // Refresh Token Reuse Detection
  const incomingHash = hashToken(token);
  if (user.refreshTokenHash && user.refreshTokenHash !== incomingHash) {
    // Replay/Theft detected: Revoke all active sessions for this account immediately
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.refreshTokenHash = null;
    await user.save();
    clearRefreshCookie(res);

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
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      requestId: req.headers['x-request-id'] || '',
    });

    return sendError(res, 401, 'Security alert: Token reuse detected. All active sessions have been invalidated.');
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

  setRefreshCookie(res, newRefreshToken);

  return sendSuccess(res, 200, 'Session token refreshed.', {
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
export const handleLogout = asyncHandler(async (req, res) => {
  clearRefreshCookie(res);

  if (req.user && (req.user.userId || req.user._id)) {
    const targetUserId = req.user.userId || req.user._id;

    // Immediately revoke server-side sessions by incrementing tokenVersion and wiping token hash
    await User.findByIdAndUpdate(targetUserId, {
      $inc: { tokenVersion: 1 },
      $unset: { refreshTokenHash: 1 },
    });

    await AuditLog.create({
      actorId: targetUserId,
      actorRole: req.user.role,
      actorDesignation: req.user.designation || '',
      actorName: req.user.fullName || '',
      action: 'USER_LOGOUT',
      targetModel: 'User',
      targetId: targetUserId,
      targetName: req.user.fullName,
      townId: req.user.townId,
      schoolId: req.user.schoolId || null,
      result: 'SUCCESS',
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      requestId: req.headers['x-request-id'] || '',
    });
  }

  return sendSuccess(res, 200, 'Signed out successfully.');
});

/**
 * Get Authenticated User Profile (Hydrate Redux on App Load)
 * GET /api/v1/auth/me
 */
export const handleGetMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.userId)
    .populate('schoolId', 'name schoolCode emisCode')
    .populate('townId', 'name code');

  if (!user) {
    return sendError(res, 404, 'User profile not found.');
  }

  const permissions = getEffectivePermissions(user);
  const roleLevel = ROLE_HIERARCHY[user.role] || 0;

  return sendSuccess(res, 200, 'Active user session profile retrieved.', {
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      designation: user.designation || '',
      role: user.role,
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
export const handleForgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = email.toLowerCase().trim();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    return sendSuccess(res, 200, `If an active account exists for ${normalizedEmail}, a 6-digit password reset code has been sent.`);
  }

  await requestOtp(normalizedEmail, 'PASSWORD_RESET');
  return sendSuccess(res, 200, `A 6-digit password reset code has been sent to ${normalizedEmail}.`);
});

/**
 * Confirm Password Reset with OTP
 * POST /api/v1/auth/reset-password
 */
export const handleResetPassword = asyncHandler(async (req, res) => {
  const { email, otpCode, newPassword } = req.body;
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Verify OTP
  await verifyOtp(normalizedEmail, otpCode, 'PASSWORD_RESET');

  // 2. Find User & Update Password
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return sendError(res, 404, 'User account not found.');
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
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    requestId: req.headers['x-request-id'] || '',
  });

  return sendSuccess(res, 200, 'Password has been successfully updated. You may now sign in with your new password.');
});
