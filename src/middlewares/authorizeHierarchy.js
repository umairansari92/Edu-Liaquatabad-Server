import { sendError } from '../utils/apiResponse.js';
import { ROLE_HIERARCHY, ROLES, USER_STATUS } from '../../config/constants.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Evaluates whether the target user is protected or invisible to the requesting actor.
 * Invariant: ROOT_ADMIN is invisible/protected from SUPER_ADMIN, ADMIN, and all subordinate roles.
 * Invariant: SUPER_ADMIN is invisible/protected from ADMIN and subordinates in management endpoints.
 */
export const isTargetProtectedFromActor = (actor, targetUser) => {
  if (!actor || !targetUser) return false;
  // ROOT_ADMIN is protected from everyone except ROOT_ADMIN themselves
  if (targetUser.role === ROLES.ROOT_ADMIN && actor.role !== ROLES.ROOT_ADMIN) {
    return true;
  }
  // SUPER_ADMIN is protected from ADMIN and below in management contexts
  if (targetUser.role === ROLES.SUPER_ADMIN && [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT].includes(actor.role)) {
    return true;
  }
  return false;
};

/**
 * Server-Enforced Hierarchy Guard (The Golden Security Rule)
 * Asserts that the actor's role level is strictly greater than the target user's role level,
 * with explicit policy provisions for SUPER_ADMIN peer/self governance.
 *
 * POLICY INVARIANTS:
 *  1. ROOT_ADMIN target is ALWAYS immutable via web APIs — cannot be demoted, suspended, or modified.
 *  2. SUPER_ADMIN may manage peer SUPER_ADMINs (suspend, demote, grant authority) and self-suspend/self-demote,
 *     provided at least one other active platform administrator (ROOT_ADMIN or SUPER_ADMIN) remains.
 *  3. ADMIN cannot manage, grant, demote, or suspend another ADMIN, SUPER_ADMIN, or ROOT_ADMIN.
 *  4. Self-mutation for non-SUPER_ADMIN roles remains prohibited.
 *  5. Every blocked attempt is written to the immutable AuditLog without logging secrets.
 */
export const authorizeHierarchy = async (request, response, nextFunction) => {
  try {
    const requestingActor = request.user;
    if (!requestingActor) {
      return sendError(response, 401, 'Unauthorized: User not authenticated.');
    }

    const targetUserId = request.params.id || request.params.userId || request.body.userId || request.body.targetId;
    if (!targetUserId) {
      return nextFunction(); // If no target user ID is specified, hierarchy check passes to next middleware
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return sendError(response, 404, 'Target user account not found.');
    }

    const actorRoleLevel  = requestingActor.roleLevel || ROLE_HIERARCHY[requestingActor.role] || 0;
    const targetRoleLevel = ROLE_HIERARCHY[targetUser.role] || 0;

    // ── INVARIANT 1: ROOT_ADMIN target is ALWAYS immutable via web APIs ──────────
    const isRoleOrStatusMutationRequest =
      request.body.role ||
      request.body.newRole ||
      request.body.authority ||
      request.body.status ||
      request.body.scope ||
      request.body.customPermissions;

    if (targetUser.role === ROLES.ROOT_ADMIN && isRoleOrStatusMutationRequest) {
      await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
        reason: 'ROOT_ADMIN_IMMUTABILITY_VIOLATION: ROOT_ADMIN accounts are immutable via web APIs. Use the CLI break-glass script for emergency recovery.',
        action: 'ROOT_ADMIN_MUTATION_ATTEMPT_BLOCKED',
      });

      return sendError(
        response,
        403,
        'Forbidden: ROOT_ADMIN accounts cannot be modified through web APIs. Use the emergency CLI recovery script for authorised changes.'
      );
    }

    // ── INVARIANT 2: Self-mutation policies ──────────────────────────────────────
    const actorId      = String(requestingActor._id || requestingActor.userId);
    const targetId     = String(targetUser._id);
    const isSelfTarget = actorId === targetId;

    if (isSelfTarget) {
      const isRoleChangeAttempt = !!(request.body.role || request.body.newRole || request.body.authority || request.body.scope);
      const isDeactivationAttempt = !!(
        request.body.status &&
        request.body.status !== USER_STATUS.ACTIVE
      );

      // Special provision: SUPER_ADMIN may self-suspend or self-demote if platform governance is safe
      if (requestingActor.role === ROLES.SUPER_ADMIN && (isRoleChangeAttempt || isDeactivationAttempt)) {
        const proposedRole = request.body.role || request.body.newRole || request.body.authority;
        // Cannot elevate self to ROOT_ADMIN
        if (proposedRole === ROLES.ROOT_ADMIN) {
          await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
            reason: 'ROOT_ADMIN_ELEVATION_FORBIDDEN: Cannot elevate account to ROOT_ADMIN via web APIs.',
            action: 'PRIVILEGE_ESCALATION_ATTEMPT',
          });
          return sendError(response, 403, 'Forbidden: You cannot elevate your account to ROOT_ADMIN.');
        }

        // Safety check: At least one other active administrator (ROOT_ADMIN or SUPER_ADMIN) must remain
        const activeGovCount = await User.countDocuments({
          _id: { $ne: requestingActor._id },
          role: { $in: [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN] },
          status: USER_STATUS.ACTIVE,
        });

        if (activeGovCount < 1) {
          await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
            reason: 'GOVERNANCE_SAFETY_VIOLATION: Cannot self-suspend or self-demote without at least one other active Root Admin or Super Admin.',
            action: 'SELF_MUTATION_SAFETY_BLOCKED',
          });
          return sendError(
            response,
            409,
            'Governance safety violation: At least one other active platform administrator (Root Admin or Super Admin) must remain before self-suspension or demotion.'
          );
        }
        // Allow downstream controller to handle self-action with session revocation
      } else if (isRoleChangeAttempt || isDeactivationAttempt) {
        await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
          reason: 'SELF_MUTATION_FORBIDDEN: Actors cannot demote, change scope, or suspend their own accounts via web APIs.',
          action: 'SELF_MUTATION_ATTEMPT_BLOCKED',
        });

        return sendError(
          response,
          403,
          'Forbidden: You cannot modify your own role, scope, or lifecycle status through this endpoint.'
        );
      }
    }

    // ── INVARIANT 3: Target Level Protection ─────────────────────────────────────
    if (requestingActor.role === ROLES.ROOT_ADMIN) {
      // Supreme authority over non-ROOT_ADMIN accounts
    } else if (requestingActor.role === ROLES.SUPER_ADMIN) {
      // Super Admin cannot modify Root Admin
      if (targetUser.role === ROLES.ROOT_ADMIN) {
        await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
          reason: 'ROOT_ADMIN_PROTECTED: Super Admin cannot modify Root Admin accounts.',
          action: 'UNAUTHORIZED_HIERARCHY_MODIFICATION_ATTEMPT',
        });
        return sendError(response, 403, 'Access denied. You cannot modify Root Admin accounts.');
      }
      // Super Admin CAN manage peer Super Admins, Admins, and subordinates
    } else {
      // Other roles (ADMIN, SUPERVISOR, etc.) strictly cannot modify equal or higher authority
      if (actorRoleLevel <= targetRoleLevel) {
        await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
          reason: `INSUFFICIENT_HIERARCHY: Role ${requestingActor.role} cannot modify account of equal or higher authority (${targetUser.role}).`,
          action: 'UNAUTHORIZED_HIERARCHY_MODIFICATION_ATTEMPT',
        });

        return sendError(
          response,
          403,
          `Access denied. You cannot modify or manage an account with equal or higher authority (${targetUser.role}).`
        );
      }
    }

    // ── INVARIANT 4: Proposed Role Elevation Protection ───────────────────────────
    if (request.body.newRole || request.body.role || request.body.authority) {
      const proposedRole  = request.body.newRole || request.body.role || request.body.authority;
      const proposedLevel = ROLE_HIERARCHY[proposedRole] || 0;

      if (requestingActor.role === ROLES.ROOT_ADMIN) {
        if (proposedRole === ROLES.ROOT_ADMIN) {
          return sendError(response, 403, 'Access denied. ROOT_ADMIN cannot be granted via web APIs.');
        }
      } else if (requestingActor.role === ROLES.SUPER_ADMIN) {
        if (proposedRole === ROLES.ROOT_ADMIN) {
          await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
            reason: 'SUPER_ADMIN_CANNOT_GRANT_ROOT_ADMIN: Super Admin cannot grant ROOT_ADMIN authority.',
            action: 'PRIVILEGE_ESCALATION_ATTEMPT',
          });
          return sendError(response, 403, 'Access denied. Super Admin cannot grant ROOT_ADMIN authority.');
        }
      } else {
        // ADMIN and lower roles cannot grant equal or higher authority
        if (proposedLevel >= actorRoleLevel) {
          await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
            reason: `INSUFFICIENT_HIERARCHY: Actor (${requestingActor.role}) cannot grant role equal to or higher than their own level (${proposedRole}).`,
            action: 'PRIVILEGE_ESCALATION_ATTEMPT',
            newState: { attemptedRole: proposedRole },
          });

          return sendError(
            response,
            403,
            `Access denied. You cannot assign a role with equal or higher authority (${proposedRole}).`
          );
        }
      }
    }

    // Attach target user to request for downstream controller efficiency
    request.targetUser = targetUser;
    nextFunction();
  } catch (hierarchyError) {
    return sendError(response, 500, 'Hierarchy evaluation failed.', [{ message: hierarchyError.message }]);
  }
};

/**
 * Writes an immutable DENIED audit event for every blocked hierarchy/immutability violation.
 * Intentionally excludes passwords, tokens, and other secrets.
 */
const writeHierarchyAuditDenied = async (request, requestingActor, targetUser, { reason, action, newState = null }) => {
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
      schoolId:         requestingActor.schoolId || null,
      previousState:    { role: targetUser.role, status: targetUser.status },
      newState:         newState || { requestedBody: sanitiseBodyForAudit(request.body) },
      result:           'DENIED',
      reason,
      ipAddress:        request.ip || '',
      userAgent:        request.headers['user-agent'] || '',
      requestId:        request.headers['x-request-id'] || '',
    });
  } catch (auditWriteError) {
    // Audit write failure must NEVER suppress the security block — log to stderr only
    console.error('[HierarchyGuard Audit Error]', auditWriteError.message);
  }
};

/**
 * Returns a sanitised copy of the request body, stripping any credential-like fields
 * to ensure audit logs never contain secrets.
 */
const sanitiseBodyForAudit = (requestBody = {}) => {
  const {
    password,
    passwordHash,
    refreshToken,
    accessToken,
    token,
    otp,
    secret,
    ...safeFields
  } = requestBody;
  return safeFields;
};
