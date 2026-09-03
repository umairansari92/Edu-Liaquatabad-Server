import { verifyAccessToken } from '../utils/tokenUtils.js';
import { sendError } from '../utils/apiResponse.js';
import { USER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';
import { getEffectivePermissions } from '../config/permissions.js';
import User from '../models/User.js';

/**
 * Validates JWT Access Token and hydrates authoritative user context from DB
 */
export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 401, 'Authentication token is required.');
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    if (!decoded || !decoded.userId) {
      return sendError(res, 401, 'Invalid or expired session token.');
    }

    // Verify current authoritative user status & token version in MongoDB
    const user = await User.findById(decoded.userId).select('+tokenVersion');
    if (!user) {
      return sendError(res, 401, 'User account not found.');
    }

    // Check account lifecycle status
    if (user.status !== USER_STATUS.ACTIVE) {
      return sendError(res, 403, `Account session unavailable (Status: ${user.status}).`);
    }

    // Check if token was invalidated by tokenVersion increment (session revocation)
    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return sendError(res, 401, 'Session has been invalidated due to a security or role update. Please sign in again.');
    }

    const roleLevel = ROLE_HIERARCHY[user.role] || 0;
    const permissions = getEffectivePermissions(user);

    // Attach full authoritative claims to req.user
    req.user = {
      _id: user._id,
      userId: user._id,
      fullName: user.fullName,
      email: user.email,
      designation: user.designation || '',
      role: user.role,
      roleLevel,
      scope: user.scope,
      organizationId: user.organizationId,
      townId: user.townId,
      schoolId: user.schoolId,
      assignedSchools: user.assignedSchools || [],
      permissions,
      tokenVersion: user.tokenVersion,
    };

    next();
  } catch (error) {
    return sendError(res, 401, 'Session expired or token invalid.', [{ message: error.message }]);
  }
};
