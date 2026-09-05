import { sendError } from '../utils/apiResponse.js';
import { ROLE_HIERARCHY, ROLES } from '../../config/constants.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Server-Enforced Hierarchy Guard (The Golden Security Rule)
 * Asserts that the actor's role level is strictly greater than the target user's role level.
 * In addition, checks that the actor cannot elevate a target to a role equal to or higher than their own.
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

    const actorRoleLevel = requestingActor.roleLevel || ROLE_HIERARCHY[requestingActor.role] || 0;
    const targetRoleLevel = ROLE_HIERARCHY[targetUser.role] || 0;

    // 1. Target Level Protection: Actor must be strictly higher in hierarchy than target
    // Exception: ROOT_ADMIN (level 100) has supreme authority over all accounts
    if (requestingActor.role !== ROLES.ROOT_ADMIN && actorRoleLevel <= targetRoleLevel) {
      // Record DENIED audit log for security audit trail
      await AuditLog.create({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName: requestingActor.fullName || '',
        action: request.body.action || 'UNAUTHORIZED_HIERARCHY_MODIFICATION_ATTEMPT',
        targetModel: 'User',
        targetId: targetUser._id,
        targetName: targetUser.fullName,
        townId: requestingActor.townId,
        schoolId: requestingActor.schoolId || null,
        previousState: { role: targetUser.role, status: targetUser.status },
        newState: request.body,
        result: 'DENIED',
        reason: 'INSUFFICIENT_HIERARCHY: Actor authority level is lower than or equal to target account.',
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        requestId: request.headers['x-request-id'] || '',
      });

      return sendError(
        response,
        403,
        `Access denied. You cannot modify or manage an account with equal or higher authority (${targetUser.role}).`
      );
    }

    // 2. Proposed Role Elevation Protection: Actor cannot grant a role equal to or higher than their own
    if (request.body.newRole || request.body.role) {
      const proposedRole = request.body.newRole || request.body.role;
      const proposedLevel = ROLE_HIERARCHY[proposedRole] || 0;

      if (requestingActor.role !== ROLES.ROOT_ADMIN && proposedLevel >= actorRoleLevel) {
        await AuditLog.create({
          actorId: requestingActor._id || requestingActor.userId,
          actorRole: requestingActor.role,
          actorDesignation: requestingActor.designation || '',
          actorName: requestingActor.fullName || '',
          action: 'PRIVILEGE_ESCALATION_ATTEMPT',
          targetModel: 'User',
          targetId: targetUser._id,
          targetName: targetUser.fullName,
          townId: requestingActor.townId,
          schoolId: requestingActor.schoolId || null,
          previousState: { role: targetUser.role },
          newState: { attemptedRole: proposedRole },
          result: 'DENIED',
          reason: 'INSUFFICIENT_HIERARCHY: Actor cannot grant a role equal to or higher than their own level.',
          ipAddress: request.ip || '',
          userAgent: request.headers['user-agent'] || '',
          requestId: request.headers['x-request-id'] || '',
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
  } catch (error) {
    return sendError(response, 500, 'Hierarchy evaluation failed.', [{ message: error.message }]);
  }
};
