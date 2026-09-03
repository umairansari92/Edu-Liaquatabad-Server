import { sendError } from '../utils/apiResponse.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Validates whether the authenticated user has all required atomic permissions
 * @param  {...string} requiredPermissions
 */
export const authorizePermissions = (...requiredPermissions) => {
  return async (req, res, next) => {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized: User not authenticated.');
    }

    const userPermissions = new Set(req.user.permissions || []);
    const missingPermissions = requiredPermissions.filter((p) => !userPermissions.has(p));

    if (missingPermissions.length > 0) {
      // Record DENIED audit log for permission deficit
      await AuditLog.create({
        actorId: req.user._id || req.user.userId,
        actorRole: req.user.role,
        actorDesignation: req.user.designation || '',
        actorName: req.user.fullName || '',
        action: req.body.action || 'UNAUTHORIZED_PERMISSION_ATTEMPT',
        targetModel: 'Endpoint',
        targetId: req.user._id,
        townId: req.user.townId,
        schoolId: req.user.schoolId || null,
        result: 'DENIED',
        reason: `MISSING_PERMISSIONS: Required [${missingPermissions.join(', ')}]`,
        ipAddress: req.ip || '',
        userAgent: req.headers['user-agent'] || '',
        requestId: req.headers['x-request-id'] || '',
      });

      return sendError(
        res,
        403,
        `Access denied. Missing required permission(s): ${missingPermissions.join(', ')}`
      );
    }

    next();
  };
};
