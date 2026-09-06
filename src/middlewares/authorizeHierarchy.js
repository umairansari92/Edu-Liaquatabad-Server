import { sendError } from '../utils/apiResponse.js';
import { ROLE_HIERARCHY, ROLES, USER_STATUS } from '../../config/constants.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Server-Enforced Hierarchy Guard (The Golden Security Rule)
 * Asserts that the actor's role level is strictly greater than the target user's role level.
 * In addition, checks that the actor cannot elevate a target to a role equal to or higher than their own.
 *
 * SEC-CRIT-01 INVARIANTS (Wave 1 Remediation):
 *  1. ROOT_ADMIN target is ALWAYS immutable via web APIs — nobody can demote, suspend, or delete
 *     a ROOT_ADMIN account through the web portal. Emergency recovery uses the CLI script only.
 *  2. Self-demotion / self-suspension is prohibited for every role including ROOT_ADMIN themselves.
 *  3. Lower/equal authority actors cannot modify ROOT_ADMIN accounts, bypassed or not.
 *  4. Every blocked attempt is written to the immutable AuditLog without logging any secrets.
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
    // No actor — not even another ROOT_ADMIN — may demote, suspend, or otherwise
    // mutate a ROOT_ADMIN account through the web portal. CLI break-glass only.
    const isRoleOrStatusMutationRequest =
      request.body.role ||
      request.body.newRole ||
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

    // ── INVARIANT 2: Self-demotion / self-suspension prohibition ─────────────────
    // No actor may change their own role, scope, or set their own status to a
    // non-active lifecycle state (suspension, retirement, etc.) via web APIs.
    const actorId      = String(requestingActor._id || requestingActor.userId);
    const targetId     = String(targetUser._id);
    const isSelfTarget = actorId === targetId;

    if (isSelfTarget) {
      const isRoleChangeAttempt = !!(request.body.role || request.body.newRole || request.body.scope);
      const isDeactivationAttempt = !!(
        request.body.status &&
        request.body.status !== USER_STATUS.ACTIVE
      );

      if (isRoleChangeAttempt || isDeactivationAttempt) {
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
    // Actor must be strictly higher in hierarchy than target.
    // Exception: ROOT_ADMIN (level 100) has supreme authority over all non-ROOT_ADMIN accounts.
    if (requestingActor.role !== ROLES.ROOT_ADMIN && actorRoleLevel <= targetRoleLevel) {
      await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
        reason: 'INSUFFICIENT_HIERARCHY: Actor authority level is lower than or equal to target account.',
        action: 'UNAUTHORIZED_HIERARCHY_MODIFICATION_ATTEMPT',
      });

      return sendError(
        response,
        403,
        `Access denied. You cannot modify or manage an account with equal or higher authority (${targetUser.role}).`
      );
    }

    // ── INVARIANT 4: Proposed Role Elevation Protection ───────────────────────────
    // Actor cannot grant a role equal to or higher than their own.
    if (request.body.newRole || request.body.role) {
      const proposedRole  = request.body.newRole || request.body.role;
      const proposedLevel = ROLE_HIERARCHY[proposedRole] || 0;

      if (requestingActor.role !== ROLES.ROOT_ADMIN && proposedLevel >= actorRoleLevel) {
        await writeHierarchyAuditDenied(request, requestingActor, targetUser, {
          reason: 'INSUFFICIENT_HIERARCHY: Actor cannot grant a role equal to or higher than their own level.',
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
