/**
 * Root Admin Creation Blocker Middleware
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * SECURITY MANDATE: No actor below ROOT_ADMIN may assign or request the ROOT_ADMIN role.
 * This middleware intercepts ALL role-assignment attempts before the controller runs.
 *
 * Enforces:
 *  - req.body.role       cannot be ROOT_ADMIN (unless actor is ROOT_ADMIN)
 *  - req.body.newRole    cannot be ROOT_ADMIN (unless actor is ROOT_ADMIN)
 *  - Attempted violations are written to the immutable AuditLog
 *  - Response: 403 Forbidden
 */

import { sendError } from '../utils/apiResponse.js';
import { ROLES } from '../../config/constants.js';
import AuditLog from '../models/AuditLog.js';

export const blockRootAdminCreation = async (req, res, next) => {
  const actor = req.user;

  if (!actor) {
    return sendError(res, 401, 'Unauthorized: Authentication required.');
  }

  // ROOT_ADMIN is permitted to perform ROOT_ADMIN operations (emergency recovery only)
  if (actor.role === ROLES.ROOT_ADMIN) {
    return next();
  }

  // Inspect every possible field that could carry a role value
  const proposedRole = req.body?.role || req.body?.newRole || null;

  if (proposedRole === ROLES.ROOT_ADMIN) {
    // Write immutable audit event — even failed attempts must be recorded
    try {
      await AuditLog.create({
        actorId:          actor._id || actor.userId,
        actorRole:        actor.role,
        actorDesignation: actor.designation || '',
        actorName:        actor.fullName || '',
        action:           'ROOT_ADMIN_CREATION_ATTEMPT_BLOCKED',
        targetModel:      'User',
        targetId:         actor._id || actor.userId,
        targetName:       actor.fullName || '',
        townId:           actor.townId || null,
        schoolId:         actor.schoolId || null,
        previousState:    {},
        newState:         { attemptedRole: ROLES.ROOT_ADMIN },
        result:           'DENIED',
        reason:           'FORBIDDEN: Attempt to assign ROOT_ADMIN role by non-root actor. Request blocked by blockRootAdminCreation middleware.',
        ipAddress:        req.ip || '',
        userAgent:        req.headers['user-agent'] || '',
        requestId:        req.headers['x-request-id'] || '',
      });
    } catch (auditError) {
      // Audit write failure must not suppress the security block
      console.error('[SecurityGuard] ROOT_ADMIN attempt audit write failed:', auditError.message);
    }

    return sendError(
      res,
      403,
      'Forbidden: ROOT_ADMIN role cannot be assigned through standard administrative workflows.'
    );
  }

  next();
};
