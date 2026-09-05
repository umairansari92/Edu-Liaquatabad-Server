import { verifyAccessToken } from '../utils/tokenUtils.js';
import { sendError } from '../utils/apiResponse.js';
import { USER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';
import { getEffectivePermissions } from '../config/permissions.js';
import User from '../models/User.js';

/**
 * Validates JWT Access Token and hydrates authoritative user context from DB
 */
export const authenticate = async (request, response, nextFunction) => {
  try {
    const authorizationHeader = request.headers.authorization;
    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
      return sendError(response, 401, 'Authentication token is required.');
    }

    const bearerToken = authorizationHeader.split(' ')[1];
    const decodedTokenPayload = verifyAccessToken(bearerToken);

    if (!decodedTokenPayload || !decodedTokenPayload.userId) {
      return sendError(response, 401, 'Invalid or expired session token.');
    }

    // Verify current authoritative user status & token version in MongoDB
    const authenticatedUser = await User.findById(decodedTokenPayload.userId).select('+tokenVersion');
    if (!authenticatedUser) {
      return sendError(response, 401, 'User account not found.');
    }

    // Check account lifecycle status
    if (authenticatedUser.status !== USER_STATUS.ACTIVE) {
      return sendError(response, 403, `Account session unavailable (Status: ${authenticatedUser.status}).`);
    }

    // Check if token was invalidated by tokenVersion increment (session revocation)
    if (decodedTokenPayload.tokenVersion !== undefined && decodedTokenPayload.tokenVersion !== authenticatedUser.tokenVersion) {
      return sendError(response, 401, 'Session has been invalidated due to a security or role update. Please sign in again.');
    }

    const actorRoleLevel = ROLE_HIERARCHY[authenticatedUser.role] || 0;
    const effectivePermissions = getEffectivePermissions(authenticatedUser);

    // Attach full authoritative claims to request.user
    request.user = {
      _id: authenticatedUser._id,
      userId: authenticatedUser._id,
      fullName: authenticatedUser.fullName,
      email: authenticatedUser.email,
      designation: authenticatedUser.designation || '',
      role: authenticatedUser.role,
      roleLevel: actorRoleLevel,
      scope: authenticatedUser.scope,
      organizationId: authenticatedUser.organizationId,
      townId: authenticatedUser.townId,
      schoolId: authenticatedUser.schoolId,
      assignedSchools: authenticatedUser.assignedSchools || [],
      permissions: effectivePermissions,
      tokenVersion: authenticatedUser.tokenVersion,
    };

    nextFunction();
  } catch (authenticationError) {
    return sendError(response, 401, 'Session expired or token invalid.', [{ message: authenticationError.message }]);
  }
};
