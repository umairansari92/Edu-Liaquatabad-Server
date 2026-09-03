import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';
import { validatePermissionCeiling } from '../config/permissions.js';

/**
 * Assign Designation, Role, Scope, and Custom Permissions to a User
 * PATCH /api/v1/users/:id/role-designation
 */
export const handleAssignRoleAndDesignation = asyncHandler(async (req, res) => {
  const targetUser = req.targetUser || (await User.findById(req.params.id));
  if (!targetUser) {
    return sendError(res, 404, 'Target user account not found.');
  }

  const { designation, role, scope, customPermissions, reason = 'Administrative role/designation adjustment' } = req.body;

  // 1. Validate Proposed Role
  if (role && !Object.values(ROLES).includes(role)) {
    return sendError(res, 400, `Invalid role. Must be one of: ${Object.values(ROLES).join(', ')}`);
  }

  // 2. Validate Proposed Scope
  if (scope && !Object.values(SCOPES).includes(scope)) {
    return sendError(res, 400, `Invalid scope. Must be one of: ${Object.values(SCOPES).join(', ')}`);
  }

  const targetRole = role || targetUser.role;

  // 3. Permission Ceiling Validation
  if (customPermissions && Array.isArray(customPermissions)) {
    const ceilingCheck = validatePermissionCeiling(targetRole, customPermissions);
    if (!ceilingCheck.valid) {
      return sendError(
        res,
        400,
        `Permission ceiling violation: The permissions [${ceilingCheck.forbiddenPermissions.join(', ')}] exceed the maximum authority ceiling for role (${targetRole}).`
      );
    }
  }

  // 4. Capture Before State Snapshot (Git-like Diff)
  const previousState = {
    designation: targetUser.designation || '',
    role: targetUser.role,
    scope: targetUser.scope,
    customPermissions: targetUser.customPermissions || [],
    tokenVersion: targetUser.tokenVersion || 0,
  };

  // 5. Apply Updates & Invalidate Existing Sessions
  if (designation !== undefined) targetUser.designation = String(designation).trim();
  if (role) targetUser.role = role;
  if (scope) targetUser.scope = scope;
  if (customPermissions) targetUser.customPermissions = customPermissions;

  // Atomically increment tokenVersion to revoke previous JWT sessions
  targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;

  await targetUser.save();

  // 6. Capture After State Snapshot
  const newState = {
    designation: targetUser.designation,
    role: targetUser.role,
    scope: targetUser.scope,
    customPermissions: targetUser.customPermissions,
    tokenVersion: targetUser.tokenVersion,
  };

  // 7. Write Git-like Immutable Audit Trail
  await AuditLog.create({
    actorId: req.user._id || req.user.userId,
    actorRole: req.user.role,
    actorDesignation: req.user.designation || '',
    actorName: req.user.fullName || '',
    action: 'USER_ROLE_AND_DESIGNATION_UPDATED',
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: req.user.townId,
    schoolId: targetUser.schoolId || null,
    previousState,
    newState,
    result: 'SUCCESS',
    reason,
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    requestId: req.headers['x-request-id'] || '',
  });

  return sendSuccess(res, 200, 'User designation and role updated successfully. Active sessions revoked.', {
    user: {
      _id: targetUser._id,
      fullName: targetUser.fullName,
      email: targetUser.email,
      designation: targetUser.designation,
      role: targetUser.role,
      scope: targetUser.scope,
      customPermissions: targetUser.customPermissions,
      status: targetUser.status,
      tokenVersion: targetUser.tokenVersion,
    },
  });
});

/**
 * Update User Lifecycle State (Activate, Suspend, Transfer, Retire)
 * PATCH /api/v1/users/:id/lifecycle
 */
export const handleUpdateUserStatus = asyncHandler(async (req, res) => {
  const targetUser = req.targetUser || (await User.findById(req.params.id));
  if (!targetUser) {
    return sendError(res, 404, 'Target user account not found.');
  }

  const { status, reason, correctionRemarks } = req.body;

  if (!status || !Object.values(USER_STATUS).includes(status)) {
    return sendError(res, 400, `Invalid lifecycle status. Must be one of: ${Object.values(USER_STATUS).join(', ')}`);
  }

  if (!reason || reason.trim().length < 3) {
    return sendError(res, 400, 'A mandatory justification reason is required for lifecycle status transitions.');
  }

  const previousState = {
    status: targetUser.status,
    approvalDetails: targetUser.approvalDetails,
    tokenVersion: targetUser.tokenVersion || 0,
  };

  targetUser.status = status;
  if (correctionRemarks) {
    targetUser.approvalDetails = {
      ...targetUser.approvalDetails,
      correctionRemarks,
    };
  }

  // Revoke active sessions on suspension or retirement
  if ([USER_STATUS.SUSPENDED, USER_STATUS.TRANSFERRED, USER_STATUS.RETIRED, USER_STATUS.INACTIVE].includes(status)) {
    targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;
  }

  await targetUser.save();

  const newState = {
    status: targetUser.status,
    approvalDetails: targetUser.approvalDetails,
    tokenVersion: targetUser.tokenVersion,
  };

  // Write Git-like Immutable Audit Log
  await AuditLog.create({
    actorId: req.user._id || req.user.userId,
    actorRole: req.user.role,
    actorDesignation: req.user.designation || '',
    actorName: req.user.fullName || '',
    action: `USER_LIFECYCLE_${status}`,
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: req.user.townId,
    schoolId: targetUser.schoolId || null,
    previousState,
    newState,
    result: 'SUCCESS',
    reason,
    ipAddress: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    requestId: req.headers['x-request-id'] || '',
  });

  return sendSuccess(res, 200, `User lifecycle state updated to ${status}.`, {
    userId: targetUser._id,
    status: targetUser.status,
    tokenVersion: targetUser.tokenVersion,
  });
});

/**
 * Get Users Scoped by Caller Permissions
 * GET /api/v1/users
 */
export const handleGetUsers = asyncHandler(async (req, res) => {
  const { role, status, schoolId, search, page = 1, limit = 20 } = req.query;

  const query = {};

  // Apply scope boundaries
  if (req.user.role === ROLES.SUPERVISOR) {
    query.schoolId = { $in: req.user.assignedSchools || [] };
  } else if ([ROLES.HM, ROLES.TEACHER].includes(req.user.role)) {
    query.schoolId = req.user.schoolId;
  }

  if (role) query.role = role;
  if (status) query.status = status;
  if (schoolId && (!query.schoolId || [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(req.user.role))) {
    query.schoolId = schoolId;
  }

  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { designation: { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const [users, total] = await Promise.all([
    User.find(query)
      .select('-passwordHash -refreshTokenHash')
      .populate('schoolId', 'name schoolCode emisCode')
      .populate('townId', 'name code')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    User.countDocuments(query),
  ]);

  return sendSuccess(res, 200, 'Users retrieved successfully.', {
    users,
    total,
    page: parseInt(page, 10),
    totalPages: Math.ceil(total / parseInt(limit, 10)),
  });
});

/**
 * Get Complete Immutable Audit History for a Specific User
 * GET /api/v1/users/:id/audit-history
 */
export const handleGetUserAuditHistory = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const history = await AuditLog.find({
    $or: [{ targetId: id }, { actorId: id }],
  }).sort({ createdAt: -1 });

  return sendSuccess(res, 200, 'User immutable audit trail retrieved.', { history });
});
