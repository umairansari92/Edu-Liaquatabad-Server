import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import School from '../models/School.js';
import TeacherProfile from '../models/TeacherProfile.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, BASE_ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';
import { validatePermissionCeiling } from '../config/permissions.js';

/**
 * Writes a DENIED audit record for SEC-CRIT-01 controller-level blocks.
 * Intentionally excludes passwords, tokens, or other secrets.
 */
const writeControllerDeniedAudit = async (request, requestingActor, targetUser, action, reason) => {
  try {
    await AuditLog.create({
      actorId:          requestingActor._id || requestingActor.userId,
      actorRole:        requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName:        requestingActor.fullName || '',
      action,
      targetModel:      'User',
      targetId:         targetUser._id,
      targetName:       targetUser.fullName,
      townId:           requestingActor.townId,
      schoolId:         targetUser.schoolId || null,
      previousState:    { role: targetUser.role, status: targetUser.status },
      newState:         {},
      result:           'DENIED',
      reason,
      ipAddress:        request.ip || '',
      userAgent:        request.headers['user-agent'] || '',
      requestId:        request.headers['x-request-id'] || '',
    });
  } catch (auditError) {
    console.error('[ControllerGuard Audit Error]', auditError.message);
  }
};

/**
 * Assign Designation, Role, Scope, and Custom Permissions to a User
 * PATCH /api/v1/users/:id/role-designation
 */
export const handleAssignRoleAndDesignation = asyncHandler(async (request, response) => {
  const targetUser = request.targetUser || (await User.findById(request.params.id));
  if (!targetUser) {
    return sendError(response, 404, 'Target user account not found.');
  }

  const requestingActor = request.user;
  const { designation, role, scope, schoolId, customPermissions, reason = 'Administrative role/designation adjustment' } = request.body;

  // ── SEC-CRIT-01 Defense-in-Depth: Controller-level invariant checks ──────────
  // These guards fire even if authorizeHierarchy middleware was somehow bypassed.

  // Guard A: ROOT_ADMIN accounts are immutable via web APIs
  const isMutationRequest = !!(role || scope || customPermissions || schoolId !== undefined);
  if (targetUser.role === ROLES.ROOT_ADMIN && isMutationRequest) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'ROOT_ADMIN_ROLE_MUTATION_ATTEMPT_BLOCKED',
      'CONTROLLER_GUARD: ROOT_ADMIN accounts cannot have role, scope, or permissions changed via web APIs.'
    );
    return sendError(response, 403, 'Forbidden: ROOT_ADMIN accounts are immutable via web APIs.');
  }

  // Guard B: Self-demotion prohibition
  const actorId    = String(requestingActor._id || requestingActor.userId);
  const targetId   = String(targetUser._id);
  const isSelfOp   = actorId === targetId;
  if (isSelfOp && (role || scope)) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'SELF_ROLE_MUTATION_ATTEMPT_BLOCKED',
      'CONTROLLER_GUARD: Actors cannot change their own role or scope via web APIs.'
    );
    return sendError(response, 403, 'Forbidden: You cannot change your own role or scope.');
  }

  // Guard C: Hierarchy privilege escalation check (actor cannot grant equal or higher authority)
  const actorRoleLevel = requestingActor.roleLevel || ROLE_HIERARCHY[requestingActor.role] || 0;
  const targetRoleLevel = ROLE_HIERARCHY[targetUser.role] || 0;

  if (requestingActor.role !== ROLES.ROOT_ADMIN && actorRoleLevel <= targetRoleLevel) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'HIERARCHY_VIOLATION_CONTROLLER_BLOCKED',
      `CONTROLLER_GUARD: Cannot modify user of equal or higher authority (${targetUser.role}).`
    );
    return sendError(response, 403, `Access denied. You cannot manage an account with equal or higher authority (${targetUser.role}).`);
  }

  if (role && requestingActor.role !== ROLES.ROOT_ADMIN && (ROLE_HIERARCHY[role] || 0) >= actorRoleLevel) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'PRIVILEGE_ESCALATION_CONTROLLER_BLOCKED',
      `CONTROLLER_GUARD: Actor cannot grant role equal to or higher than their own level (${role}).`
    );
    return sendError(response, 403, `Access denied. You cannot assign a role with equal or higher authority (${role}).`);
  }

  // Guard D: Identity Domain Boundary Enforcement (Students and Parents cannot hold staff/administrative authority)
  const isTargetAcademicEntity =
    [BASE_ROLES.STUDENT, BASE_ROLES.PARENT].includes(targetUser.baseRole) ||
    [ROLES.STUDENT, ROLES.PARENT].includes(targetUser.role);

  if (isTargetAcademicEntity && role && ![ROLES.STUDENT, ROLES.PARENT].includes(role)) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'ACADEMIC_ENTITY_PROMOTION_BLOCKED',
      `FORBIDDEN: Students and Parents cannot be elevated to administrative or staff authority (${role}).`
    );
    return sendError(
      response,
      403,
      'Forbidden: Student and Parent accounts are external academic beneficiaries and cannot be granted civil service or institutional administrative authority.'
    );
  }

  // Guard E: Staff cannot be mutated into Student or Parent accounts
  if (!isTargetAcademicEntity && role && [ROLES.STUDENT, ROLES.PARENT].includes(role)) {
    return sendError(
      response,
      400,
      'Invalid role transition: Institutional staff accounts cannot be converted to Student or Parent accounts.'
    );
  }

  // 1. Validate Proposed Role
  if (role && !Object.values(ROLES).includes(role)) {
    return sendError(response, 400, `Invalid role. Must be one of: ${Object.values(ROLES).join(', ')}`);
  }

  // 2. Validate Proposed Scope
  if (scope && !Object.values(SCOPES).includes(scope)) {
    return sendError(response, 400, `Invalid scope. Must be one of: ${Object.values(SCOPES).join(', ')}`);
  }

  const targetRole = role || targetUser.role;

  // 3. Validate Proposed School (if provided)
  if (schoolId !== undefined && schoolId !== null) {
    const schoolExists = await School.findById(schoolId).lean();
    if (!schoolExists) {
      return sendError(response, 404, 'Specified school entity not found in municipal registry.');
    }
  }

  // 4. Permission Ceiling Validation
  if (customPermissions && Array.isArray(customPermissions)) {
    const ceilingCheck = validatePermissionCeiling(targetRole, customPermissions);
    if (!ceilingCheck.valid) {
      return sendError(
        response,
        400,
        `Permission ceiling violation: The permissions [${ceilingCheck.forbiddenPermissions.join(', ')}] exceed the maximum authority ceiling for role (${targetRole}).`
      );
    }
  }

  // 5. Capture Before State Snapshot (Git-like Diff)
  const previousState = {
    designation: targetUser.designation || '',
    role: targetUser.role,
    scope: targetUser.scope,
    schoolId: targetUser.schoolId || null,
    customPermissions: targetUser.customPermissions || [],
    tokenVersion: targetUser.tokenVersion || 0,
  };

  // 6. Apply Updates & Invalidate Existing Sessions
  if (designation !== undefined) targetUser.designation = String(designation).trim();
  if (role) targetUser.role = role;
  if (scope) targetUser.scope = scope;
  if (schoolId !== undefined) {
    targetUser.schoolId = schoolId || null;
    await TeacherProfile.findOneAndUpdate(
      { userId: targetUser._id },
      { currentSchoolId: schoolId || null }
    );
  }
  if (customPermissions) targetUser.customPermissions = customPermissions;

  // Atomically increment tokenVersion to revoke previous JWT sessions
  targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;

  await targetUser.save();
  await targetUser.populate('schoolId', 'name schoolCode emisCode');

  // 7. Capture After State Snapshot
  const newState = {
    designation: targetUser.designation,
    role: targetUser.role,
    scope: targetUser.scope,
    schoolId: targetUser.schoolId || null,
    customPermissions: targetUser.customPermissions,
    tokenVersion: targetUser.tokenVersion,
  };

  // 8. Write Git-like Immutable Audit Trail
  await AuditLog.create({
    actorId: request.user._id || request.user.userId,
    actorRole: request.user.role,
    actorDesignation: request.user.designation || '',
    actorName: request.user.fullName || '',
    action: 'USER_ROLE_AND_DESIGNATION_UPDATED',
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: request.user.townId,
    schoolId: targetUser.schoolId || null,
    previousState,
    newState,
    result: 'SUCCESS',
    reason,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'User designation and role updated successfully. Active sessions revoked.', {
    user: {
      _id: targetUser._id,
      fullName: targetUser.fullName,
      email: targetUser.email,
      designation: targetUser.designation,
      baseRole: targetUser.baseRole,
      role: targetUser.role,
      grantedAuthority: targetUser.role,
      scope: targetUser.scope,
      schoolId: targetUser.schoolId,
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
export const handleUpdateUserStatus = asyncHandler(async (request, response) => {
  const targetUser = request.targetUser || (await User.findById(request.params.id));
  if (!targetUser) {
    return sendError(response, 404, 'Target user account not found.');
  }

  const requestingActor = request.user;
  const { status, reason, correctionRemarks } = request.body;

  // ── SEC-CRIT-01 Defense-in-Depth: Controller-level invariant checks ──────────

  // Guard A: ROOT_ADMIN accounts cannot be suspended/deactivated via web APIs
  const isDeactivation = status && status !== USER_STATUS.ACTIVE;
  if (targetUser.role === ROLES.ROOT_ADMIN && isDeactivation) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'ROOT_ADMIN_SUSPENSION_ATTEMPT_BLOCKED',
      `CONTROLLER_GUARD: ROOT_ADMIN accounts cannot be suspended or deactivated via web APIs. Attempted status: ${status}.`
    );
    return sendError(response, 403, 'Forbidden: ROOT_ADMIN accounts cannot be suspended or deactivated through web APIs.');
  }

  // Guard B: Self-suspension prohibition
  const actorId       = String(requestingActor._id || requestingActor.userId);
  const targetId      = String(targetUser._id);
  const isSelfOp      = actorId === targetId;
  if (isSelfOp && isDeactivation) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'SELF_SUSPENSION_ATTEMPT_BLOCKED',
      `CONTROLLER_GUARD: Actors cannot suspend or deactivate their own account via web APIs. Attempted status: ${status}.`
    );
    return sendError(response, 403, 'Forbidden: You cannot suspend or deactivate your own account.');
  }

  if (!status || !Object.values(USER_STATUS).includes(status)) {
    return sendError(response, 400, `Invalid lifecycle status. Must be one of: ${Object.values(USER_STATUS).join(', ')}`);
  }

  if (!reason || reason.trim().length < 3) {
    return sendError(response, 400, 'A mandatory justification reason is required for lifecycle status transitions.');
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
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: `USER_LIFECYCLE_${status}`,
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: requestingActor.townId,
    schoolId: targetUser.schoolId || null,
    previousState,
    newState,
    result: 'SUCCESS',
    reason,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, `User lifecycle state updated to ${status}.`, {
    userId: targetUser._id,
    status: targetUser.status,
    tokenVersion: targetUser.tokenVersion,
  });
});

/**
 * Get Users Scoped by Caller Permissions
 * GET /api/v1/users
 */
export const handleGetUsers = asyncHandler(async (request, response) => {
  const { role, status, schoolId, search, page = 1, limit = 20 } = request.query;

  const query = {};

  // Apply scope boundaries
  if (request.user.role === ROLES.SUPERVISOR) {
    query.schoolId = { $in: request.user.assignedSchools || [] };
  } else if ([ROLES.HM, ROLES.TEACHER].includes(request.user.role)) {
    query.schoolId = request.user.schoolId;
  } else if (request.user.role === ROLES.ADMIN && request.user.townId) {
    query.townId = request.user.townId;
  }

  // ROOT_ADMIN Stealth: ROOT_ADMIN is strictly hidden from general personnel listings
  if (role) {
    if (role === ROLES.ROOT_ADMIN) {
      query.role = '__NEVER_MATCH_HIDDEN__';
    } else {
      query.role = role;
    }
  } else {
    query.role = { $ne: ROLES.ROOT_ADMIN };
  }

  if (status) query.status = status;
  if (schoolId && (!query.schoolId || [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(request.user.role))) {
    query.schoolId = schoolId;
  }

  if (search && typeof search === 'string') {
    const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { fullName: { $regex: escapedSearch, $options: 'i' } },
      { email: { $regex: escapedSearch, $options: 'i' } },
      { designation: { $regex: escapedSearch, $options: 'i' } },
    ];
  }

  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skipCount = (safePage - 1) * safeLimit;

  const [users, total] = await Promise.all([
    User.find(query)
      .select('-passwordHash -refreshTokenHash')
      .populate('schoolId', 'name schoolCode emisCode')
      .populate('townId', 'name code')
      .sort({ createdAt: -1 })
      .skip(skipCount)
      .limit(safeLimit),
    User.countDocuments(query),
  ]);

  return sendSuccess(response, 200, 'Users retrieved successfully.', {
    users,
    total,
    page: safePage,
    totalPages: Math.ceil(total / safeLimit),
  });
});

/**
 * Get Complete Immutable Audit History for a Specific User
 * GET /api/v1/users/:id/audit-history
 */
export const handleGetUserAuditHistory = asyncHandler(async (request, response) => {
  const { id: targetUserId } = request.params;

  if (!targetUserId || !targetUserId.match(/^[0-9a-fA-F]{24}$/)) {
    return sendError(response, 400, 'Invalid user ID format.');
  }

  const auditHistory = await AuditLog.find({
    $or: [{ targetId: targetUserId }, { actorId: targetUserId }],
  }).sort({ createdAt: -1 }).limit(100);

  return sendSuccess(response, 200, 'User immutable audit trail retrieved.', { history: auditHistory });
});

/**
 * Bulk User Status Update (SEC-CRIT-01 hardened)
 * POST /api/v1/users/bulk
 * Supports bulk APPROVE (status: ACTIVE) and bulk SUSPEND (status: SUSPENDED).
 * Invariant: Never allows mutation or suspension of ROOT_ADMIN accounts.
 */
export const handleBulkUserAction = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { userIds, action, reason } = request.body;

  const targetStatus = (action === 'APPROVE' || action === 'ACTIVATE') 
    ? USER_STATUS.ACTIVE 
    : USER_STATUS.SUSPENDED;

  const results = {
    totalRequested: userIds.length,
    succeeded: 0,
    failed: 0,
    details: [],
  };

  const actorRank = ROLE_HIERARCHY[requestingActor.role] || 0;
  const isRootAdminActor = requestingActor.role === ROLES.ROOT_ADMIN;

  for (const targetId of userIds) {
    try {
      const targetUser = await User.findById(targetId);
      if (!targetUser) {
        results.failed++;
        results.details.push({ id: targetId, success: false, reason: 'User not found' });
        continue;
      }

      // Invariant 1: ROOT_ADMIN accounts are completely immutable via bulk operations
      if (targetUser.role === ROLES.ROOT_ADMIN) {
        await writeControllerDeniedAudit(
          request,
          requestingActor,
          targetUser,
          'ROOT_ADMIN_BULK_MUTATION_BLOCKED',
          'CONTROLLER_GUARD: ROOT_ADMIN accounts cannot be modified or suspended via bulk operations.'
        );
        results.failed++;
        results.details.push({ id: targetId, success: false, reason: 'ROOT_ADMIN accounts cannot be modified.' });
        continue;
      }

      // Invariant 2: Self-suspension is strictly prohibited
      if (targetUser._id.toString() === requestingActor._id.toString() && targetStatus === USER_STATUS.SUSPENDED) {
        await writeControllerDeniedAudit(
          request,
          requestingActor,
          targetUser,
          'SELF_SUSPENSION_BULK_BLOCKED',
          'CONTROLLER_GUARD: Actors cannot suspend their own account via bulk operations.'
        );
        results.failed++;
        results.details.push({ id: targetId, success: false, reason: 'Self-suspension is strictly prohibited.' });
        continue;
      }

      // Invariant 3: Hierarchy authority check
      const targetRank = ROLE_HIERARCHY[targetUser.role] || 0;
      if (!isRootAdminActor && targetRank <= actorRank) {
        await writeControllerDeniedAudit(
          request,
          requestingActor,
          targetUser,
          'HIERARCHY_VIOLATION_BULK_BLOCKED',
          `CONTROLLER_GUARD: Cannot modify user of equal or higher authority (${targetUser.role}).`
        );
        results.failed++;
        results.details.push({ id: targetId, success: false, reason: 'Insufficient hierarchical authority.' });
        continue;
      }

      // Invariant 4: Town scope containment for town-scoped actors
      if (requestingActor.scope === SCOPES.TOWN && targetUser.townId && requestingActor.townId) {
        if (targetUser.townId.toString() !== requestingActor.townId.toString()) {
          results.failed++;
          results.details.push({ id: targetId, success: false, reason: 'Cross-town mutation prohibited.' });
          continue;
        }
      }

      const previousStatus = targetUser.status;
      targetUser.status = targetStatus;
      await targetUser.save();

      // Immutable Audit Log
      await AuditLog.create({
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           `BULK_USER_${action}`,
        targetModel:      'User',
        targetId:         targetUser._id,
        targetName:       targetUser.fullName,
        townId:           targetUser.townId || requestingActor.townId,
        schoolId:         targetUser.schoolId || null,
        previousState:    { status: previousStatus },
        newState:         { status: targetStatus },
        result:           'SUCCESS',
        reason:           reason || `Bulk ${action} executed by ${requestingActor.role}`,
        ipAddress:        request.ip || '',
        userAgent:        request.headers['user-agent'] || '',
        requestId:        request.headers['x-request-id'] || '',
      });

      results.succeeded++;
      results.details.push({ id: targetId, name: targetUser.fullName, success: true, status: targetStatus });
    } catch (itemError) {
      results.failed++;
      results.details.push({ id: targetId, success: false, reason: itemError.message });
    }
  }

  return sendSuccess(response, 200, `Bulk operation completed: ${results.succeeded} succeeded, ${results.failed} failed.`, results);
});

/**
 * Privileged Authority Grant Controller
 * POST /api/v1/admin/users/:userId/authority
 *
 * Core Mandate:
 *   Designation != Base Role != Granted Authority != Scope != Permission != Account Status
 *
 * Explicit Actor-to-Authority Transition Policy Matrix:
 *   - ROOT_ADMIN: Can grant SUPER_ADMIN only. (ROOT_ADMIN -> ADMIN is rejected).
 *   - SUPER_ADMIN: Can grant SUPER_ADMIN or ADMIN.
 *   - ADMIN & operational roles: Cannot grant privileged authority.
 *   - No actor may grant ROOT_ADMIN.
 *   - Self-grant prohibited.
 */
export const handleGrantUserAuthority = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const targetUserId = request.params.userId || request.params.id;

  if (!targetUserId) {
    return sendError(response, 400, 'Target user ID is required in route parameter.');
  }

  const { authority, reason, scope } = request.body;

  // ── 1. Fetch Target User ──────────────────────────────────────────────────
  const targetUser = request.targetUser || (await User.findById(targetUserId));
  if (!targetUser) {
    return sendError(response, 404, 'Target user account not found.');
  }

  const actorIdString  = String(requestingActor._id || requestingActor.userId);
  const targetIdString = String(targetUser._id);

  // ── 2. Server-Enforced Guard: Self-grant Prohibition ──────────────────────
  if (actorIdString === targetIdString) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'SELF_AUTHORITY_GRANT_BLOCKED',
      'FORBIDDEN: Actor attempted to grant or escalate their own authority.'
    );
    return sendError(response, 403, 'Forbidden: You cannot grant or elevate your own authority.');
  }

  // ── 3. Server-Enforced Guard: ROOT_ADMIN Target Immutability ──────────────
  if (targetUser.role === ROLES.ROOT_ADMIN) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'ROOT_ADMIN_AUTHORITY_MUTATION_BLOCKED',
      'FORBIDDEN: ROOT_ADMIN accounts are immutable via web APIs.'
    );
    return sendError(response, 403, 'Forbidden: ROOT_ADMIN accounts cannot be modified through web APIs.');
  }

  // ── 4. Server-Enforced Guard: ROOT_ADMIN Authority Grant Prohibition ──────
  if (authority === ROLES.ROOT_ADMIN) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'ROOT_ADMIN_GRANT_ATTEMPT_BLOCKED',
      'FORBIDDEN: ROOT_ADMIN authority cannot be granted via web APIs.'
    );
    return sendError(response, 403, 'Forbidden: ROOT_ADMIN authority cannot be granted through web APIs.');
  }

  // ── 5. Server-Enforced Transition Policy Matrix ───────────────────────────
  if (requestingActor.role === ROLES.ROOT_ADMIN) {
    // ROOT_ADMIN can grant SUPER_ADMIN only
    if (authority !== ROLES.SUPER_ADMIN) {
      await writeControllerDeniedAudit(
        request, requestingActor, targetUser,
        'ROOT_ADMIN_INVALID_AUTHORITY_DELEGATION',
        `FORBIDDEN: ROOT_ADMIN can only authorize SUPER_ADMIN. Delegation of ${authority} authority must be performed by a Super Admin.`
      );
      return sendError(response, 403, `Access denied. ROOT_ADMIN can only authorize SUPER_ADMIN accounts. Delegation of ${authority} must be performed by an operational Super Admin.`);
    }
  } else if (requestingActor.role === ROLES.SUPER_ADMIN) {
    // SUPER_ADMIN can grant SUPER_ADMIN or ADMIN
    if (![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(authority)) {
      await writeControllerDeniedAudit(
        request, requestingActor, targetUser,
        'SUPER_ADMIN_INVALID_AUTHORITY_DELEGATION',
        `FORBIDDEN: SUPER_ADMIN can only authorize SUPER_ADMIN or ADMIN. Attempted: ${authority}.`
      );
      return sendError(response, 403, `Access denied. Super Admin can only grant SUPER_ADMIN or ADMIN authority.`);
    }
  } else {
    // All other roles (ADMIN, SUPERVISOR, HM, TEACHER, etc.) are strictly forbidden
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'UNAUTHORIZED_AUTHORITY_GRANT_ATTEMPT',
      `FORBIDDEN: Role ${requestingActor.role} has no authority to grant privileged system roles.`
    );
    return sendError(response, 403, 'Access denied. You do not have permission to grant privileged administrative authority.');
  }

  // ── 6. Hierarchy Check: Target cannot have equal or higher authority ───────
  const actorRoleLevel  = requestingActor.roleLevel || ROLE_HIERARCHY[requestingActor.role] || 0;
  const targetRoleLevel = ROLE_HIERARCHY[targetUser.role] || 0;

  if (requestingActor.role !== ROLES.ROOT_ADMIN && actorRoleLevel <= targetRoleLevel) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'HIERARCHY_VIOLATION_AUTHORITY_GRANT_BLOCKED',
      `FORBIDDEN: Actor cannot grant authority to user of equal or higher authority (${targetUser.role}).`
    );
    return sendError(response, 403, `Access denied. You cannot manage an account with equal or higher authority (${targetUser.role}).`);
  }

  // ── 7. Target Already Authorized Check ─────────────────────────────────────
  if (targetUser.role === authority) {
    return sendError(response, 409, `Conflict: Target user "${targetUser.fullName}" already holds ${authority} authority.`);
  }

  // ── 8. Account Status & Explicit Approval Policy ───────────────────────────
  // Suspended, retired, or inactive accounts must be remediated first
  if ([USER_STATUS.SUSPENDED, USER_STATUS.RETIRED, USER_STATUS.INACTIVE].includes(targetUser.status)) {
    return sendError(response, 400, `Cannot grant authority to an account in '${targetUser.status}' status. Remediate account lifecycle state first.`);
  }

  // Snapshot before state
  const previousState = {
    role:         targetUser.role,
    scope:        targetUser.scope,
    status:       targetUser.status,
    designation:  targetUser.designation,
    baseRole:     targetUser.baseRole,
    tokenVersion: targetUser.tokenVersion || 0,
  };

  // Explicit approval contract: Granting administrative authority to a pending user
  // constitutes explicit administrative approval and activates the account.
  let approvalActionTaken = false;
  if (targetUser.status === USER_STATUS.PENDING_APPROVAL) {
    targetUser.status = USER_STATUS.ACTIVE;
    targetUser.approvalDetails = {
      approvedBy: requestingActor._id || requestingActor.userId,
      approvedAt: new Date(),
      correctionRemarks: `Explicit administrative approval granted upon elevation to ${authority}. Justification: ${reason.trim()}`,
    };
    approvalActionTaken = true;
  }

  // ── 9. Resolve Canonical Scope ─────────────────────────────────────────────
  let resolvedScope = scope;
  if (!resolvedScope) {
    resolvedScope = authority === ROLES.SUPER_ADMIN ? SCOPES.GLOBAL : SCOPES.TOWN;
  }

  // Verify non-root cannot assign GLOBAL scope if they themselves are not global
  if (resolvedScope === SCOPES.GLOBAL && requestingActor.role !== ROLES.ROOT_ADMIN && requestingActor.scope !== SCOPES.GLOBAL) {
    await writeControllerDeniedAudit(
      request, requestingActor, targetUser,
      'GLOBAL_SCOPE_GRANT_DENIED',
      'FORBIDDEN: Only global administrators can assign GLOBAL scope.'
    );
    return sendError(response, 403, 'Access denied. You do not have authority to grant GLOBAL scope.');
  }

  // ── 10. Apply Authority & Session Invalidation (Designation & baseRole UNTOUCHED) ─
  targetUser.role         = authority;
  targetUser.scope        = resolvedScope;
  targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1; // Revokes all active JWT sessions

  await targetUser.save();

  // Snapshot after state
  const newState = {
    role:         targetUser.role,
    scope:        targetUser.scope,
    status:       targetUser.status,
    designation:  targetUser.designation,  // Verified unchanged
    baseRole:     targetUser.baseRole,     // Verified unchanged
    tokenVersion: targetUser.tokenVersion,
    approvalActionTaken,
  };

  // ── 11. Immutable Audit Log ────────────────────────────────────────────────
  await AuditLog.create({
    actorId:          requestingActor._id || requestingActor.userId,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'USER_AUTHORITY_GRANTED',
    targetModel:      'User',
    targetId:         targetUser._id,
    targetName:       targetUser.fullName,
    townId:           targetUser.townId || requestingActor.townId || null,
    schoolId:         targetUser.schoolId || null,
    previousState,
    newState,
    result:           'SUCCESS',
    reason:           reason.trim(),
    ipAddress:        request.ip || '',
    userAgent:        request.headers['user-agent'] || '',
    requestId:        request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, `Authority '${authority}' successfully granted to ${targetUser.fullName}. Active sessions revoked.`, {
    user: {
      _id:              targetUser._id,
      fullName:         targetUser.fullName,
      email:            targetUser.email,
      designation:      targetUser.designation,
      baseRole:         targetUser.baseRole,
      role:             targetUser.role,
      grantedAuthority: targetUser.role,
      scope:            targetUser.scope,
      status:           targetUser.status,
      tokenVersion:     targetUser.tokenVersion,
      approvalActionTaken,
    },
  });
});


