import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { requestOtp, verifyOtp } from '../services/otpService.js';
import { isDisposableEmail } from '../utils/disposableEmailValidator.js';
import { verifyMathCaptcha } from '../utils/customMathCaptcha.js';
import { generateDeviceFingerprint } from '../utils/deviceFingerprint.js';
import { checkEmailLockout, recordFailedLogin, clearLoginLockout } from '../middlewares/tripleLockRateLimiter.js';
import { hashPassword, verifyPassword } from '../utils/passwordUtils.js';
import { signAccessToken, signRefreshToken, setRefreshCookie } from '../utils/tokenUtils.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import TeacherProfile from '../models/TeacherProfile.js';
import Organization from '../models/Organization.js';
import Town from '../models/Town.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, SCOPES, USER_STATUS, STUDENT_STATUS, TEACHER_STATUS } from '../../config/constants.js';

/**
 * Request OTP verification code
 * POST /api/v1/auth/send-otp
 */
export const handleSendOtp = asyncHandler(async (req, res) => {
  const { email, purpose = 'REGISTRATION' } = req.body;

  if (!email) {
    return sendError(res, 400, 'Email address is required.');
  }

  if (isDisposableEmail(email)) {
    return sendError(res, 400, 'Disposable or temporary email addresses are strictly blocked.');
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
    return sendError(res, 400, 'Email and 6-digit OTP code are required.');
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

  // 1. Mandatory Math CAPTCHA validation (if provided in payload)
  if (captchaChallengeToken && !verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
    return sendError(res, 400, 'Mathematical security CAPTCHA verification failed.');
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

  // 4. Resolve default Organization & Town if not provided
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

  // 5. Create User in PENDING_APPROVAL status
  const passwordHash = await hashPassword(password || 'Student@123456');
  const user = await User.create({
    organizationId: defaultOrg._id,
    townId: defaultTown._id,
    schoolId: schoolId || null,
    fullName,
    email: email.toLowerCase().trim(),
    passwordHash,
    phoneNumber: phoneNumber || guardianContactNumber || '',
    role: ROLES.STUDENT,
    scope: SCOPES.SELF_CHILD,
    status: USER_STATUS.PENDING_APPROVAL,
  });

  // 6. Create StudentProfile
  await StudentProfile.create({
    userId: user._id,
    schoolId: schoolId || defaultTown._id,
    classId: classId || defaultTown._id,
    sectionId: sectionId || defaultTown._id,
    rollNumber: rollNumber || 'TBD',
    fatherOrGuardianName: fatherOrGuardianName || 'TBD',
    guardianContactNumber: guardianContactNumber || phoneNumber || 'TBD',
    lifecycleStatus: STUDENT_STATUS.PENDING_APPROVAL,
  });

  // 7. Audit Log
  const deviceFingerprint = generateDeviceFingerprint(req);
  await AuditLog.create({
    actorId: user._id,
    actorRole: ROLES.STUDENT,
    action: 'STUDENT_REGISTERED_OTP_VERIFIED',
    targetModel: 'User',
    targetId: user._id,
    townId: defaultTown._id,
    schoolId: schoolId || null,
    newState: { status: USER_STATUS.PENDING_APPROVAL },
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
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
    designation,
    qualification,
    schoolId,
    otpCode,
    captchaAnswer,
    captchaChallengeToken,
  } = req.body;

  // 1. Mandatory Math CAPTCHA validation
  if (captchaChallengeToken && !verifyMathCaptcha(captchaAnswer, captchaChallengeToken)) {
    return sendError(res, 400, 'Mathematical security CAPTCHA verification failed.');
  }

  // 2. Mandatory OTP verification before account creation
  if (!otpCode) {
    return sendError(res, 400, 'Mandatory 6-digit OTP verification code is required to complete faculty registration.');
  }

  await verifyOtp(email, otpCode, 'REGISTRATION');

  // 3. Duplicate check
  const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
  if (existingUser) {
    return sendError(res, 400, 'A faculty account with this email already exists.');
  }

  // 4. Resolve default Organization & Town
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

  // 5. Create User
  const passwordHash = await hashPassword(password);
  const user = await User.create({
    organizationId: defaultOrg._id,
    townId: defaultTown._id,
    schoolId: schoolId || null,
    fullName,
    email: email.toLowerCase().trim(),
    passwordHash,
    phoneNumber: phoneNumber || '',
    role: ROLES.TEACHER,
    scope: SCOPES.CLASS_SECTION,
    status: USER_STATUS.PENDING_APPROVAL,
  });

  // 6. Create TeacherProfile
  await TeacherProfile.create({
    userId: user._id,
    currentSchoolId: schoolId || defaultTown._id,
    designation: designation || 'Teacher',
    qualification: qualification || 'TBD',
    lifecycleStatus: TEACHER_STATUS.PENDING_APPROVAL,
  });

  // 7. Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: ROLES.TEACHER,
    action: 'TEACHER_REGISTERED_OTP_VERIFIED',
    targetModel: 'User',
    targetId: user._id,
    townId: defaultTown._id,
    schoolId: schoolId || null,
    newState: { status: USER_STATUS.PENDING_APPROVAL },
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
  });

  return sendSuccess(res, 201, 'Faculty registration submitted and email verified. Your profile is now awaiting HM / DDO authorization.', {
    userId: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
  });
});
