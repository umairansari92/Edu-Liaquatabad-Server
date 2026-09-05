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

export const blockRootAdminCreation = async (request, response, nextFunction) => {
  const requestingActor = request.user;

  if (!requestingActor) {
    return sendError(response, 401, 'Unauthorized: Authentication required.');
  }

  // ROOT_ADMIN is permitted to perform ROOT_ADMIN operations (emergency recovery only)
  if (requestingActor.role === ROLES.ROOT_ADMIN) {
    return nextFunction();
  }

  // Inspect every possible field that could carry a role value
  const proposedRole = request.body?.role || request.body?.newRole || null;

  if (proposedRole === ROLES.ROOT_ADMIN) {
    // Write immutable audit event — even failed attempts must be recorded
    try {
      await AuditLog.create({
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           'ROOT_ADMIN_CREATION_ATTEMPT_BLOCKED',
        targetModel:      'User',
        targetId:         requestingActor._id || requestingActor.userId,
        targetName:       requestingActor.fullName || '',
        townId:           requestingActor.townId || null,
        schoolId:         requestingActor.schoolId || null,
        previousState:    {},
        newState:         { attemptedRole: ROLES.ROOT_ADMIN },
        result:           'DENIED',
        reason:           'FORBIDDEN: Attempt to assign ROOT_ADMIN role by non-root actor. Request blocked by blockRootAdminCreation middleware.',
        ipAddress:        request.ip || '',
        userAgent:        request.headers['user-agent'] || '',
        requestId:        request.headers['x-request-id'] || '',
      });
    } catch (auditError) {
      // Audit write failure must not suppress the security block
      console.error('[SecurityGuard] ROOT_ADMIN attempt audit write failed:', auditError.message);
    }

    return sendError(
      response,
      403,
      'Forbidden: ROOT_ADMIN role cannot be assigned through standard administrative workflows.'
    );
  }

  nextFunction();
};
