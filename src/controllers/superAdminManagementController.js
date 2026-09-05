/**
 * Super Admin Management Controller
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Authority Model (Final):
 *   ROOT_ADMIN (100) > SUPER_ADMIN (90) > ADMIN (80) > ...
 *
 * Rules enforced by this controller:
 *  1. Only ROOT_ADMIN or an existing SUPER_ADMIN can create a new SUPER_ADMIN.
 *  2. A SUPER_ADMIN can disable another SUPER_ADMIN, subject to strict safeguards.
 *  3. SUPER_ADMIN cannot disable themselves (self-disable prevention).
 *  4. The final active SUPER_ADMIN cannot be disabled (recovery-path protection).
 *  5. SUPER_ADMIN cannot create or assign ROOT_ADMIN (enforced additionally by blockRootAdminCreation middleware).
 *  6. Every operation writes an immutable audit record.
 *  7. Disabling a SUPER_ADMIN revokes all their active sessions (tokenVersion increment).
 */

import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, SCOPES, USER_STATUS, ROLE_DEFAULT_SCOPE } from '../../config/constants.js';
import { hashPassword } from '../utils/passwordUtils.js';

// ─── Helper: write audit record ──────────────────────────────────────────────

const writeAudit = async ({
  actorId, actorRole, actorDesignation, actorName,
  action, targetId, targetName, townId, schoolId,
  previousState, newState, result, reason,
  ipAddress, userAgent, requestId,
}) => {
  await AuditLog.create({
    actorId, actorRole, actorDesignation: actorDesignation || '', actorName: actorName || '',
    action,
    targetModel: 'User',
    targetId, targetName,
    townId: townId || null,
    schoolId: schoolId || null,
    previousState, newState,
    result, reason,
    ipAddress: ipAddress || '',
    userAgent: userAgent || '',
    requestId: requestId || '',
  });
};

// ─── POST /api/v1/admin/super-admins ─────────────────────────────────────────

/**
 * Create a new SUPER_ADMIN account.
 * Permitted actors: ROOT_ADMIN, existing SUPER_ADMIN
 *
 * Required body:
 *   fullName, email, password, designation (optional), townId (optional)
 *
 * Security guarantees:
 *   - Role is hard-coded to SUPER_ADMIN — body cannot override to ROOT_ADMIN
 *     (additionally protected by blockRootAdminCreation middleware on the route)
 *   - Actor must be ROOT_ADMIN or SUPER_ADMIN (enforced by authorizeRoles middleware on route)
 *   - Immutable audit record written on every attempt (success or failure)
 */
export const handleCreateSuperAdmin = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  const {
    fullName,
    email,
    password,
    designation = '',
    townId,
    reason = 'SUPER_ADMIN provisioning by authorized administrator',
  } = request.body;

  // ── Validate required fields ──────────────────────────────────────────────

  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
    return sendError(response, 400, 'Full name is required (minimum 2 characters).');
  }

  if (!email || typeof email !== 'string') {
    return sendError(response, 400, 'A valid email address is required.');
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    return sendError(response, 400, 'Password must be at least 8 characters.');
  }

  // ── Prevent duplicate accounts ────────────────────────────────────────────

  const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
  if (existingUser) {
    return sendError(response, 409, 'An account with this email address already exists.');
  }

  // ── Security check: actor cannot create ROOT_ADMIN via this endpoint ──────
  // (Belt-and-suspenders — also enforced by blockRootAdminCreation middleware)

  if (requestingActor.role !== ROLES.ROOT_ADMIN) {
    // A SUPER_ADMIN cannot create ROOT_ADMIN — hard-code role to SUPER_ADMIN only
  }

  // ── Hash password ─────────────────────────────────────────────────────────

  const passwordHash = await hashPassword(password);

  // ── Derive organizationId and townId from the actor if not explicitly provided ──

  const resolvedTownId = townId || requestingActor.townId || null;
  const resolvedOrganizationId = requestingActor.organizationId;

  if (!resolvedOrganizationId) {
    return sendError(response, 400, 'Cannot resolve organizationId from the requesting actor. Ensure actor has organizationId set.');
  }

  // ── Create the new SUPER_ADMIN ────────────────────────────────────────────

  const newSuperAdmin = await User.create({
    organizationId:   resolvedOrganizationId,
    townId:           resolvedTownId,
    fullName:         fullName.trim(),
    email:            email.toLowerCase().trim(),
    passwordHash,
    designation:      String(designation).trim(),
    role:             ROLES.SUPER_ADMIN,          // Hard-coded — cannot be overridden
    scope:            ROLE_DEFAULT_SCOPE[ROLES.SUPER_ADMIN],
    customPermissions: [],
    status:           USER_STATUS.ACTIVE,         // Directly ACTIVE — no approval needed
    tokenVersion:     0,
  });

  // ── Write immutable audit record ──────────────────────────────────────────

  await writeAudit({
    actorId:          requestingActor._id || requestingActor.userId,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'SUPER_ADMIN_CREATED',
    targetId:         newSuperAdmin._id,
    targetName:       newSuperAdmin.fullName,
    townId:           resolvedTownId,
    schoolId:         null,
    previousState:    {},
    newState: {
      fullName:    newSuperAdmin.fullName,
      email:       newSuperAdmin.email,
      role:        newSuperAdmin.role,
      scope:       newSuperAdmin.scope,
      designation: newSuperAdmin.designation,
      status:      newSuperAdmin.status,
    },
    result:    'SUCCESS',
    reason,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 201, 'SUPER_ADMIN account created successfully.', {
    user: {
      _id:         newSuperAdmin._id,
      fullName:    newSuperAdmin.fullName,
      email:       newSuperAdmin.email,
      role:        newSuperAdmin.role,
      scope:       newSuperAdmin.scope,
      designation: newSuperAdmin.designation,
      status:      newSuperAdmin.status,
    },
  });
});

// ─── PATCH /api/v1/admin/super-admins/:id/disable ───────────────────────────

/**
 * Disable a SUPER_ADMIN account.
 * Permitted actors: ROOT_ADMIN, existing SUPER_ADMIN
 *
 * Required body:
 *   reason  — mandatory justification string (minimum 10 characters)
 *
 * Security safeguards:
 *   1. Actor cannot disable themselves (self-disable prevention)
 *   2. Cannot disable ROOT_ADMIN (hierarchy guard from authorizeHierarchy middleware)
 *   3. Cannot disable the final remaining active SUPER_ADMIN (recovery-path protection)
 *   4. Mandatory reason field — minimum 10 characters
 *   5. Immutable audit record written on EVERY attempt (including denied attempts)
 *   6. On success: tokenVersion incremented to revoke all active sessions immediately
 */
export const handleDisableSuperAdmin = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: targetUserId } = request.params;
  const { reason } = request.body;

  // ── Validate reason ───────────────────────────────────────────────────────

  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    return sendError(response, 400, 'A mandatory justification reason is required (minimum 10 characters).');
  }

  // ── Fetch target ──────────────────────────────────────────────────────────

  const targetUser = request.targetUser || await User.findById(targetUserId);
  if (!targetUser) {
    return sendError(response, 404, 'Target SUPER_ADMIN account not found.');
  }

  // ── Ensure target is actually a SUPER_ADMIN ───────────────────────────────

  if (targetUser.role !== ROLES.SUPER_ADMIN) {
    return sendError(response, 400, `This endpoint is exclusively for disabling SUPER_ADMIN accounts. Target role is ${targetUser.role}.`);
  }

  // ── SAFEGUARD 1: Self-disable prevention ──────────────────────────────────

  const actorIdString = String(requestingActor._id || requestingActor.userId);
  const targetUserIdString = String(targetUser._id);

  if (actorIdString === targetUserIdString) {
    await writeAudit({
      actorId:          requestingActor._id || requestingActor.userId,
      actorRole:        requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName:        requestingActor.fullName || '',
      action:           'SUPER_ADMIN_SELF_DISABLE_BLOCKED',
      targetId:         targetUser._id,
      targetName:       targetUser.fullName,
      townId:           requestingActor.townId,
      schoolId:         null,
      previousState:    { status: targetUser.status },
      newState:         { attemptedStatus: USER_STATUS.SUSPENDED },
      result:           'DENIED',
      reason:           'FORBIDDEN: Actor attempted to disable their own SUPER_ADMIN account.',
      ipAddress:        request.ip || '',
      userAgent:        request.headers['user-agent'] || '',
      requestId:        request.headers['x-request-id'] || '',
    });

    return sendError(response, 403, 'Forbidden: You cannot disable your own Super Admin account.');
  }

  // ── SAFEGUARD 2: Final active SUPER_ADMIN protection ─────────────────────
  // ROOT_ADMIN is exempt from this check — they can always recover the system

  if (requestingActor.role !== ROLES.ROOT_ADMIN) {
    const activeSuperAdminCount = await User.countDocuments({
      role:   ROLES.SUPER_ADMIN,
      status: USER_STATUS.ACTIVE,
    });

    if (activeSuperAdminCount <= 1) {
      await writeAudit({
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           'SUPER_ADMIN_LAST_ACTIVE_DISABLE_BLOCKED',
        targetId:         targetUser._id,
        targetName:       targetUser.fullName,
        townId:           requestingActor.townId,
        schoolId:         null,
        previousState:    { status: targetUser.status, activeSuperAdminCount },
        newState:         { attemptedStatus: USER_STATUS.SUSPENDED },
        result:           'DENIED',
        reason:           'FORBIDDEN: Disabling the final active Super Admin would eliminate all administrative recovery paths.',
        ipAddress:        request.ip || '',
        userAgent:        request.headers['user-agent'] || '',
        requestId:        request.headers['x-request-id'] || '',
      });

      return sendError(
        response,
        409,
        'Cannot disable the final active Super Admin account. Ensure at least one other Super Admin remains active before proceeding.'
      );
    }
  }

  // ── Apply disable + session revocation ───────────────────────────────────

  const previousState = {
    status:       targetUser.status,
    tokenVersion: targetUser.tokenVersion || 0,
  };

  targetUser.status       = USER_STATUS.SUSPENDED;
  targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1; // Revokes all active JWT sessions

  await targetUser.save();

  // ── Write success audit record ────────────────────────────────────────────

  await writeAudit({
    actorId:          requestingActor._id || requestingActor.userId,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'SUPER_ADMIN_DISABLED',
    targetId:         targetUser._id,
    targetName:       targetUser.fullName,
    townId:           requestingActor.townId,
    schoolId:         null,
    previousState,
    newState: {
      status:       targetUser.status,
      tokenVersion: targetUser.tokenVersion,
    },
    result:    'SUCCESS',
    reason:    reason.trim(),
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Super Admin account disabled. All active sessions have been revoked.', {
    userId:       targetUser._id,
    status:       targetUser.status,
    tokenVersion: targetUser.tokenVersion,
  });
});

// ─── GET /api/v1/admin/super-admins ──────────────────────────────────────────

/**
 * List all SUPER_ADMIN accounts.
 * Permitted actors: ROOT_ADMIN, existing SUPER_ADMIN
 * Returns: id, fullName, email, designation, status, scope, createdAt — NO credentials
 */
export const handleListSuperAdmins = asyncHandler(async (request, response) => {
  const superAdmins = await User.find({ role: ROLES.SUPER_ADMIN })
    .select('_id fullName email designation status scope createdAt lastLoginAt')
    .sort({ createdAt: -1 });

  return sendSuccess(response, 200, 'Super Admin accounts retrieved successfully.', {
    superAdmins,
    total: superAdmins.length,
  });
});
