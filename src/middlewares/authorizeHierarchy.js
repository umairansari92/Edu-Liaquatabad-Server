import { sendError } from '../utils/apiResponse.js';
import { ROLE_HIERARCHY, ROLES } from '../../config/constants.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Server-Enforced Hierarchy Guard (The Golden Security Rule)
 * Asserts that the actor's role level is strictly greater than the target user's role level.
 * In addition, checks that the actor cannot elevate a target to a role equal to or higher than their own.
 */
export const authorizeHierarchy = async (req, res, next) => {
  try {
    const actor = req.user;
    if (!actor) {
      return sendError(res, 401, 'Unauthorized: User not authenticated.');
    }

    const targetUserId = req.params.id || req.params.userId || req.body.userId || req.body.targetId;
    if (!targetUserId) {
      return next(); // If no target user ID is specified, hierarchy check passes to next middleware
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return sendError(res, 404, 'Target user account not found.');
    }

    const actorLevel = actor.roleLevel || ROLE_HIERARCHY[actor.role] || 0;
    const targetLevel = ROLE_HIERARCHY[targetUser.role] || 0;

    // 1. Target Level Protection: Actor must be strictly higher in hierarchy than target
    // Exception: ROOT_ADMIN (level 100) has supreme authority over all accounts
    if (actor.role !== ROLES.ROOT_ADMIN && actorLevel <= targetLevel) {
      // Record DENIED audit log for security audit trail
      await AuditLog.create({
        actorId: actor._id || actor.userId,
        actorRole: actor.role,
        actorDesignation: actor.designation || '',
        actorName: actor.fullName || '',
        action: req.body.action || 'UNAUTHORIZED_HIERARCHY_MODIFICATION_ATTEMPT',
        targetModel: 'User',
        targetId: targetUser._id,
        targetName: targetUser.fullName,
        townId: actor.townId,
        schoolId: actor.schoolId || null,
        previousState: { role: targetUser.role, status: targetUser.status },
        newState: req.body,
        result: 'DENIED',
        reason: 'INSUFFICIENT_HIERARCHY: Actor authority level is lower than or equal to target account.',
        ipAddress: req.ip || '',
        userAgent: req.headers['user-agent'] || '',
        requestId: req.headers['x-request-id'] || '',
      });

      return sendError(
        res,
        403,
        `Access denied. You cannot modify or manage an account with equal or higher authority (${targetUser.role}).`
      );
    }

    // 2. Proposed Role Elevation Protection: Actor cannot grant a role equal to or higher than their own
    if (req.body.newRole || req.body.role) {
      const proposedRole = req.body.newRole || req.body.role;
      const proposedLevel = ROLE_HIERARCHY[proposedRole] || 0;

      if (actor.role !== ROLES.ROOT_ADMIN && proposedLevel >= actorLevel) {
        await AuditLog.create({
          actorId: actor._id || actor.userId,
          actorRole: actor.role,
          actorDesignation: actor.designation || '',
          actorName: actor.fullName || '',
          action: 'PRIVILEGE_ESCALATION_ATTEMPT',
          targetModel: 'User',
          targetId: targetUser._id,
          targetName: targetUser.fullName,
          townId: actor.townId,
          schoolId: actor.schoolId || null,
          previousState: { role: targetUser.role },
          newState: { attemptedRole: proposedRole },
          result: 'DENIED',
          reason: 'INSUFFICIENT_HIERARCHY: Actor cannot grant a role equal to or higher than their own level.',
          ipAddress: req.ip || '',
          userAgent: req.headers['user-agent'] || '',
          requestId: req.headers['x-request-id'] || '',
        });

        return sendError(
          res,
          403,
          `Access denied. You cannot assign a role with equal or higher authority (${proposedRole}).`
        );
      }
    }

    // Attach target user to request for downstream controller efficiency
    req.targetUser = targetUser;
    next();
  } catch (error) {
    return sendError(res, 500, 'Hierarchy evaluation failed.', [{ message: error.message }]);
  }
};
