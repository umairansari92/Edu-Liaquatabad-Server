import { sendError } from '../utils/apiResponse.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Validates whether the authenticated user has all required atomic permissions
 * @param  {...string} requiredPermissions
 */
export const authorizePermissions = (...requiredPermissions) => {
  return async (request, response, nextFunction) => {
    if (!request.user) {
      return sendError(response, 401, 'Unauthorized: User not authenticated.');
    }

    const userPermissions = new Set(request.user.permissions || []);
    const missingPermissions = requiredPermissions.filter((permission) => !userPermissions.has(permission));

    if (missingPermissions.length > 0) {
      // Record DENIED audit log for permission deficit
      await AuditLog.create({
        actorId: request.user._id || request.user.userId,
        actorRole: request.user.role,
        actorDesignation: request.user.designation || '',
        actorName: request.user.fullName || '',
        action: request.body.action || 'UNAUTHORIZED_PERMISSION_ATTEMPT',
        targetModel: 'Endpoint',
        targetId: request.user._id,
        townId: request.user.townId,
        schoolId: request.user.schoolId || null,
        result: 'DENIED',
        reason: `MISSING_PERMISSIONS: Required [${missingPermissions.join(', ')}]`,
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        requestId: request.headers['x-request-id'] || '',
      });

      return sendError(
        response,
        403,
        `Access denied. Missing required permission(s): ${missingPermissions.join(', ')}`
      );
    }

    nextFunction();
  };
};
