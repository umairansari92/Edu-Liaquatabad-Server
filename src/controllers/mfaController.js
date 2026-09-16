import crypto from 'crypto';
import asyncHandler from 'express-async-handler';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import Notification from '../models/Notification.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import {
  generateTotpSecret,
  generateTotpUri,
  encryptMfaSecret,
  decryptMfaSecret,
  verifyTotpToken,
  generateRecoveryCodes,
  verifyRecoveryCode,
} from '../utils/mfaUtils.js';
import {
  signAccessToken,
  signRefreshToken,
  hashToken,
  setRefreshCookie,
  clearRefreshCookie,
  parseDeviceLabel,
} from '../utils/tokenUtils.js';
import { verifyPassword } from '../utils/passwordUtils.js';
import { ROLE_HIERARCHY, ROLES, USER_STATUS } from '../../config/constants.js';
import { getEffectivePermissions } from '../config/permissions.js';

const MAX_ACTIVE_SESSIONS = 5;

/**
 * Initiate MFA Setup (Generates unconfirmed secret & QR URI)
 * POST /api/v1/auth/mfa/setup
 */
export const handleMfaSetup = asyncHandler(async (request, response) => {
  // Caller may be in MFA_PENDING (first-time Root Admin setup) or authenticated session
  const user = request.mfaUser || (await User.findById(request.user?.userId).select(
    '+mfa.secretCiphertext +mfa.secretIv +mfa.secretTag +mfa.pendingSecret +mfa.recoveryCodes +tokenVersion +passwordHash'
  ));

  if (!user) {
    return sendError(response, 401, 'User account not found.');
  }

  // Step-Up Authentication: If caller is authenticated via standard session, require password verification
  if (!request.mfaUser) {
    const { password } = request.body || {};
    if (!password) {
      return sendError(response, 401, 'Password confirmation is required to initiate MFA setup from an active session.');
    }
    const isPasswordValid = await verifyPassword(password, user.passwordHash);
    if (!isPasswordValid) {
      return sendError(response, 401, 'Invalid password. Step-up re-authentication failed.');
    }
  }

  // Generate 20-byte Base32 secret
  const plaintextSecret = generateTotpSecret();
  const encrypted = encryptMfaSecret(plaintextSecret);

  // Store as unconfirmed pending secret (10-minute window)
  user.mfa = user.mfa || {};
  user.mfa.pendingSecret = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  };
  await user.save();

  const otpAuthUri = generateTotpUri({
    secret: plaintextSecret,
    accountName: user.email,
  });

  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || '',
    actorName: user.fullName,
    action: 'MFA_SETUP_INITIATED',
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

  return sendSuccess(response, 200, 'MFA setup initiated. Scan QR code or enter secret into your authenticator app.', {
    secret: plaintextSecret,
    otpAuthUri,
  });
});

/**
 * Confirm MFA Setup with First Valid TOTP Code
 * POST /api/v1/auth/mfa/confirm
 */
export const handleMfaConfirm = asyncHandler(async (request, response) => {
  const { totpCode } = request.body;
  const user = request.mfaUser || (await User.findById(request.user?.userId).select(
    '+mfa.secretCiphertext +mfa.secretIv +mfa.secretTag +mfa.pendingSecret +mfa.recoveryCodes +tokenVersion'
  ));

  if (!user || !user.mfa?.pendingSecret?.ciphertext) {
    return sendError(response, 400, 'No pending MFA setup found. Please initiate setup first.');
  }

  if (new Date() > new Date(user.mfa.pendingSecret.expiresAt)) {
    user.mfa.pendingSecret = undefined;
    await user.save();
    return sendError(response, 400, 'MFA setup session expired. Please initiate setup again.');
  }

  let plaintextSecret;
  try {
    plaintextSecret = decryptMfaSecret({
      ciphertext: user.mfa.pendingSecret.ciphertext,
      iv: user.mfa.pendingSecret.iv,
      tag: user.mfa.pendingSecret.tag,
    });
  } catch {
    return sendError(response, 500, 'Cryptographic error decrypting MFA configuration.');
  }

  const verification = verifyTotpToken(plaintextSecret, totpCode, 0);
  if (!verification.valid) {
    return sendError(response, 401, 'Invalid authentication code. Please check your authenticator clock.');
  }

  // Promote pending secret to active secret
  user.mfa.secretCiphertext = user.mfa.pendingSecret.ciphertext;
  user.mfa.secretIv = user.mfa.pendingSecret.iv;
  user.mfa.secretTag = user.mfa.pendingSecret.tag;
  user.mfa.pendingSecret = undefined;
  user.mfa.enabled = true;
  user.mfa.enrolledAt = new Date();
  user.mfa.lastConsumedWindow = verification.matchedWindow;

  // Generate 8 Argon2id-hashed emergency backup codes
  const recResult = await generateRecoveryCodes(8);
  user.mfa.recoveryCodes = recResult.hashedCodes;

  // Invalidate any pre-existing sessions upon enabling MFA
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();

  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || '',
    actorName: user.fullName,
    action: 'MFA_ENROLLED',
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

  return sendSuccess(response, 200, 'Multi-Factor Authentication enabled successfully. Store these recovery codes in a secure vault; they will never be displayed again.', {
    recoveryCodes: recResult.plainCodes,
  });
});

/**
 * Verify TOTP Login (Step 2 Handshake)
 * POST /api/v1/auth/mfa/verify-login
 */
export const handleMfaVerifyLogin = asyncHandler(async (request, response) => {
  const { totpCode } = request.body;
  const user = request.mfaUser;

  if (!user || !user.mfa?.enabled || !user.mfa?.secretCiphertext) {
    return sendError(response, 400, 'MFA is not enrolled on this account.');
  }

  let plaintextSecret;
  try {
    plaintextSecret = decryptMfaSecret({
      ciphertext: user.mfa.secretCiphertext,
      iv: user.mfa.secretIv,
      tag: user.mfa.secretTag,
    });
  } catch {
    return sendError(response, 500, 'Cryptographic error accessing MFA secret.');
  }

  const lastConsumed = user.mfa.lastConsumedWindow || 0;
  const verification = verifyTotpToken(plaintextSecret, totpCode, lastConsumed);

  if (!verification.valid) {
    await AuditLog.create({
      actorId: user._id,
      actorRole: user.role,
      actorDesignation: user.designation || '',
      actorName: user.fullName,
      action: 'MFA_VERIFY_FAILED',
      targetModel: 'User',
      targetId: user._id,
      targetName: user.fullName,
      townId: user.townId,
      schoolId: user.schoolId || null,
      result: 'DENIED',
      reason: verification.reason || 'INVALID_TOTP_CODE',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });

    const errorMsg = verification.reason === 'WINDOW_ALREADY_CONSUMED'
      ? 'This authentication code has already been used. Please wait for the next 30-second token.'
      : 'Invalid authentication code. Please check your authenticator clock.';
    return sendError(response, 401, errorMsg);
  }

  // ATOMIC MONOTONIC WINDOW PERSISTENCE:
  // Strictly requires mfa.lastConsumedWindow < matchedWindow.
  // Guarantees exact-once consumption across simultaneous cluster requests.
  const updatedUser = await User.findOneAndUpdate(
    {
      _id: user._id,
      'mfa.lastConsumedWindow': { $lt: verification.matchedWindow },
    },
    {
      $set: {
        'mfa.lastConsumedWindow': verification.matchedWindow,
        'mfa.lastUsedAt': new Date(),
      },
    },
    { new: true }
  ).select('+activeSessions +tokenVersion');

  if (!updatedUser) {
    await AuditLog.create({
      actorId: user._id,
      actorRole: user.role,
      actorDesignation: user.designation || '',
      actorName: user.fullName,
      action: 'MFA_VERIFY_FAILED',
      targetModel: 'User',
      targetId: user._id,
      targetName: user.fullName,
      townId: user.townId,
      schoolId: user.schoolId || null,
      result: 'DENIED',
      reason: 'CONCURRENT_TOTP_REPLAY_DETECTED',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });
    return sendError(response, 401, 'Authentication code has already been consumed. Please wait for the next 30-second token.');
  }

  // ─── Issue Full Authorized Session (Step 2 Complete) ───
  const roleLevel = ROLE_HIERARCHY[updatedUser.role] || 0;
  const tokenPayload = {
    userId: updatedUser._id,
    role: updatedUser.role,
    roleLevel,
    designation: updatedUser.designation || '',
    scope: updatedUser.scope,
    tokenVersion: updatedUser.tokenVersion || 0,
    organizationId: updatedUser.organizationId,
    townId: updatedUser.townId,
    schoolId: updatedUser.schoolId,
    assignedSchools: updatedUser.assignedSchools || [],
    mfaVerified: true,
  };

  const sessionId = crypto.randomUUID();
  const tokenFamilyId = crypto.randomUUID();
  const deviceLabel = parseDeviceLabel(request.headers['user-agent']);

  const refreshToken = signRefreshToken({
    userId: updatedUser._id,
    tokenVersion: updatedUser.tokenVersion || 0,
    sessionId,
    tokenFamilyId,
  });

  const hashedRefreshToken = hashToken(refreshToken);

  if (!Array.isArray(updatedUser.activeSessions)) {
    updatedUser.activeSessions = [];
  }

  if (updatedUser.activeSessions.length >= MAX_ACTIVE_SESSIONS) {
    updatedUser.activeSessions.sort((a, b) => new Date(a.lastUsedAt || a.createdAt).getTime() - new Date(b.lastUsedAt || b.createdAt).getTime());
    updatedUser.activeSessions.shift();
  }

  updatedUser.activeSessions.push({
    sessionId,
    tokenFamilyId,
    refreshTokenHash: hashedRefreshToken,
    previousRefreshTokenHash: null,
    tokenRotatedAt: null,
    deviceLabel,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });

  updatedUser.lastLoginAt = new Date();
  await updatedUser.save();

  setRefreshCookie(response, refreshToken);
  const accessToken = signAccessToken(tokenPayload);

  await AuditLog.create({
    actorId: updatedUser._id,
    actorRole: updatedUser.role,
    actorDesignation: updatedUser.designation || '',
    actorName: updatedUser.fullName,
    action: 'MFA_VERIFY_SUCCESS',
    targetModel: 'User',
    targetId: updatedUser._id,
    targetName: updatedUser.fullName,
    townId: updatedUser.townId,
    schoolId: updatedUser.schoolId || null,
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'MFA authentication successful. Full session established.', {
    accessToken,
    user: {
      _id: updatedUser._id,
      fullName: updatedUser.fullName,
      email: updatedUser.email,
      designation: updatedUser.designation || '',
      baseRole: updatedUser.baseRole,
      role: updatedUser.role,
      roleLevel,
      scope: updatedUser.scope,
      permissions: getEffectivePermissions(updatedUser),
      status: updatedUser.status,
      schoolId: updatedUser.schoolId,
      townId: updatedUser.townId,
      assignedSchools: updatedUser.assignedSchools || [],
      mfaVerified: true,
    },
  });
});

/**
 * Emergency Break-Glass Recovery Code Login
 * POST /api/v1/auth/mfa/recovery-login
 */
export const handleMfaRecoveryLogin = asyncHandler(async (request, response) => {
  const { recoveryCode } = request.body;
  const user = request.mfaUser;

  if (!user || !user.mfa?.enabled || !Array.isArray(user.mfa.recoveryCodes)) {
    return sendError(response, 400, 'No MFA recovery codes configured on this account.');
  }

  const match = await verifyRecoveryCode(recoveryCode, user.mfa.recoveryCodes);
  if (!match.valid || !match.matchedSubdocId) {
    await AuditLog.create({
      actorId: user._id,
      actorRole: user.role,
      actorDesignation: user.designation || '',
      actorName: user.fullName,
      action: 'MFA_VERIFY_FAILED',
      targetModel: 'User',
      targetId: user._id,
      targetName: user.fullName,
      townId: user.townId,
      schoolId: user.schoolId || null,
      result: 'DENIED',
      reason: 'INVALID_OR_CONSUMED_RECOVERY_CODE',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });
    return sendError(response, 401, 'Invalid or already consumed recovery code.');
  }

  // ATOMIC CONSUMPTION:
  // Exactly one request can atomically transition usedAt from null to Date
  const updatedUser = await User.findOneAndUpdate(
    {
      _id: user._id,
      'mfa.recoveryCodes._id': match.matchedSubdocId,
      'mfa.recoveryCodes.usedAt': null,
    },
    {
      $set: {
        'mfa.recoveryCodes.$.usedAt': new Date(),
        'mfa.lastUsedAt': new Date(),
      },
    },
    { new: true }
  ).select('+activeSessions +tokenVersion +mfa.recoveryCodes');

  if (!updatedUser) {
    return sendError(response, 401, 'Recovery code has already been consumed.');
  }

  const remainingCodes = (updatedUser.mfa.recoveryCodes || []).filter(c => !c.usedAt).length;

  // ─── High-Severity Audit Event & Notifications ───
  await AuditLog.create({
    actorId: updatedUser._id,
    actorRole: updatedUser.role,
    actorDesignation: updatedUser.designation || '',
    actorName: updatedUser.fullName,
    action: 'MFA_BREAK_GLASS_RECOVERY_USED',
    targetModel: 'User',
    targetId: updatedUser._id,
    targetName: updatedUser.fullName,
    townId: updatedUser.townId,
    schoolId: updatedUser.schoolId || null,
    result: 'SUCCESS',
    reason: `Emergency recovery code consumed. Remaining unconsumed codes: ${remainingCodes}.`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  // Alert all active Super Admins
  const superAdmins = await User.find({ role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE });
  for (const sa of superAdmins) {
    await Notification.create({
      recipientUserId: sa._id,
      title: 'CRITICAL SECURITY ALERT: Break-Glass Recovery Code Used',
      message: `Emergency recovery code was used by ${updatedUser.fullName} (${updatedUser.role}) from IP ${request.ip || 'Unknown'}. Remaining backup codes: ${remainingCodes}.`,
      notificationType: 'SECURITY_ALERT',
      actionLink: '/dashboard',
    });
  }

  // Issue full session
  const roleLevel = ROLE_HIERARCHY[updatedUser.role] || 0;
  const tokenPayload = {
    userId: updatedUser._id,
    role: updatedUser.role,
    roleLevel,
    designation: updatedUser.designation || '',
    scope: updatedUser.scope,
    tokenVersion: updatedUser.tokenVersion || 0,
    organizationId: updatedUser.organizationId,
    townId: updatedUser.townId,
    schoolId: updatedUser.schoolId,
    assignedSchools: updatedUser.assignedSchools || [],
    mfaVerified: true,
  };

  const sessionId = crypto.randomUUID();
  const tokenFamilyId = crypto.randomUUID();
  const deviceLabel = parseDeviceLabel(request.headers['user-agent']);

  const refreshToken = signRefreshToken({
    userId: updatedUser._id,
    tokenVersion: updatedUser.tokenVersion || 0,
    sessionId,
    tokenFamilyId,
  });

  const hashedRefreshToken = hashToken(refreshToken);

  if (!Array.isArray(updatedUser.activeSessions)) {
    updatedUser.activeSessions = [];
  }

  if (updatedUser.activeSessions.length >= MAX_ACTIVE_SESSIONS) {
    updatedUser.activeSessions.sort((a, b) => new Date(a.lastUsedAt || a.createdAt).getTime() - new Date(b.lastUsedAt || b.createdAt).getTime());
    updatedUser.activeSessions.shift();
  }

  updatedUser.activeSessions.push({
    sessionId,
    tokenFamilyId,
    refreshTokenHash: hashedRefreshToken,
    previousRefreshTokenHash: null,
    tokenRotatedAt: null,
    deviceLabel,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });

  updatedUser.lastLoginAt = new Date();
  await updatedUser.save();

  setRefreshCookie(response, refreshToken);
  const accessToken = signAccessToken(tokenPayload);

  return sendSuccess(response, 200, 'Emergency break-glass recovery successful. Please regenerate recovery codes if supply is low.', {
    accessToken,
    remainingRecoveryCodes: remainingCodes,
    user: {
      _id: updatedUser._id,
      fullName: updatedUser.fullName,
      email: updatedUser.email,
      designation: updatedUser.designation || '',
      baseRole: updatedUser.baseRole,
      role: updatedUser.role,
      roleLevel,
      scope: updatedUser.scope,
      permissions: getEffectivePermissions(updatedUser),
      status: updatedUser.status,
      schoolId: updatedUser.schoolId,
      townId: updatedUser.townId,
      assignedSchools: updatedUser.assignedSchools || [],
      mfaVerified: true,
    },
  });
});

/**
 * Query MFA Configuration Status
 * GET /api/v1/auth/mfa/status
 */
export const handleMfaStatus = asyncHandler(async (request, response) => {
  const user = await User.findById(request.user.userId).select('+mfa.recoveryCodes +mfa.enabled +mfa.enrolledAt');
  if (!user) {
    return sendError(response, 404, 'User account not found.');
  }

  const isEnrolled = !!user.mfa?.enabled;
  const remainingCodes = isEnrolled && Array.isArray(user.mfa.recoveryCodes)
    ? user.mfa.recoveryCodes.filter(c => !c.usedAt).length
    : 0;

  return sendSuccess(response, 200, 'MFA configuration status retrieved.', {
    mfaEnabled: isEnrolled,
    mfaEnforced: user.role === ROLES.ROOT_ADMIN || isEnrolled,
    enrolledAt: user.mfa?.enrolledAt || null,
    remainingRecoveryCodes: remainingCodes,
  });
});

/**
 * Disable MFA (Strictly prohibited for Root Admin by authorization policy)
 * POST /api/v1/auth/mfa/disable
 */
export const handleMfaDisable = asyncHandler(async (request, response) => {
  const { password } = request.body;

  // Root Admin policy: Root Admin MFA is unconditional and CANNOT be disabled
  if (request.user.role === ROLES.ROOT_ADMIN) {
    return sendError(response, 403, 'Root Admin Multi-Factor Authentication is mandatory by authorization policy and cannot be disabled.');
  }

  const user = await User.findById(request.user.userId).select('+passwordHash +mfa +tokenVersion');
  if (!user || !user.mfa?.enabled) {
    return sendError(response, 400, 'MFA is not enabled on this account.');
  }

  // Step-up authentication: require current password confirmation
  const isPasswordValid = await verifyPassword(password || '', user.passwordHash);
  if (!isPasswordValid) {
    return sendError(response, 401, 'Invalid password. Password confirmation is required to disable MFA.');
  }

  user.mfa = {
    enabled: false,
    enrolledAt: null,
    lastUsedAt: null,
    lastConsumedWindow: 0,
    recoveryCodes: [],
  };

  // State-change invalidation: increment tokenVersion to terminate all existing sessions
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.activeSessions = [];
  await user.save();
  clearRefreshCookie(response);

  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || '',
    actorName: user.fullName,
    action: 'MFA_DISABLED',
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

  return sendSuccess(response, 200, 'Multi-Factor Authentication has been disabled. All active sessions have been terminated.');
});

/**
 * Regenerate Emergency Recovery Codes
 * POST /api/v1/auth/mfa/regenerate-recovery-codes
 */
export const handleMfaRegenerateRecoveryCodes = asyncHandler(async (request, response) => {
  const { password } = request.body;
  const user = await User.findById(request.user.userId).select('+passwordHash +mfa +tokenVersion');

  if (!user || !user.mfa?.enabled) {
    return sendError(response, 400, 'MFA is not enabled on this account.');
  }

  // Step-up authentication: require current password confirmation
  const isPasswordValid = await verifyPassword(password || '', user.passwordHash);
  if (!isPasswordValid) {
    return sendError(response, 401, 'Invalid password. Password confirmation is required to regenerate recovery codes.');
  }

  const recResult = await generateRecoveryCodes(8);
  user.mfa.recoveryCodes = recResult.hashedCodes;

  // State-change invalidation: increment tokenVersion to revoke pre-existing sessions
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();

  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || '',
    actorName: user.fullName,
    action: 'MFA_RECOVERY_CODES_REGENERATED',
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

  return sendSuccess(response, 200, 'Emergency recovery codes regenerated successfully. Prior recovery codes have been revoked.', {
    recoveryCodes: recResult.plainCodes,
  });
});

/**
 * Admin Reset MFA for Subordinate User
 * POST /api/v1/auth/mfa/admin-reset/:userId
 *
 * Rules:
 * - Requires authenticated session + mfaVerified: true.
 * - Caller must have role ROOT_ADMIN or SUPER_ADMIN.
 * - Hierarchy enforcement: Caller cannot reset MFA for an account with equal or higher authority.
 * - Target cannot be ROOT_ADMIN (Root Admin MFA is unconditionally required and immutable).
 * - Clears target user's MFA state.
 * - State-change invalidation: targetUser.tokenVersion incremented, targetUser.activeSessions = [].
 * - Writes immutable audit log.
 */
export const handleAdminMfaReset = asyncHandler(async (request, response) => {
  const { userId } = request.params;
  const { reason } = request.body;
  const requestingActor = request.user;

  if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
    return sendError(response, 400, 'Invalid user ID format.');
  }

  const targetUser = await User.findById(userId).select('+mfa +tokenVersion');
  if (!targetUser) {
    return sendError(response, 404, 'Target user not found.');
  }

  // Invariant 1: ROOT_ADMIN MFA is mandatory and cannot be reset or disabled by anyone
  if (targetUser.role === ROLES.ROOT_ADMIN) {
    return sendError(response, 403, 'Root Admin MFA is mandatory by authorization policy and cannot be reset or disabled.');
  }

  // Invariant 2: Only ROOT_ADMIN and SUPER_ADMIN can execute administrative MFA reset
  if (![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role)) {
    return sendError(response, 403, 'Access denied. Privileged platform authority (Root Admin or Super Admin) is required to reset MFA.');
  }

  // Invariant 3: Hierarchy enforcement
  const actorRoleLevel = requestingActor.roleLevel || ROLE_HIERARCHY[requestingActor.role] || 0;
  const targetRoleLevel = ROLE_HIERARCHY[targetUser.role] || 0;

  if (requestingActor.role !== ROLES.ROOT_ADMIN && actorRoleLevel <= targetRoleLevel) {
    return sendError(response, 403, `Access denied. You cannot reset MFA for a user of equal or higher authority (${targetUser.role}).`);
  }

  // Clear target user's MFA state
  targetUser.mfa = {
    enabled: false,
    enrolledAt: null,
    lastUsedAt: null,
    lastConsumedWindow: 0,
    recoveryCodes: [],
  };

  // State-change invalidation: Revoke all existing sessions for the target user
  targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;
  targetUser.activeSessions = [];
  await targetUser.save();

  await AuditLog.create({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName,
    action: 'ADMIN_MFA_RESET',
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: requestingActor.townId,
    schoolId: targetUser.schoolId || null,
    result: 'SUCCESS',
    reason: reason || 'Administrative MFA reset by platform authority.',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, `MFA configuration for user "${targetUser.fullName}" has been successfully reset. All active sessions have been terminated.`, {
    targetUserId: targetUser._id,
    mfaEnabled: false,
    tokenVersion: targetUser.tokenVersion,
  });
});


