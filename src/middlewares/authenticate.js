import { verifyAccessToken } from '../utils/tokenUtils.js';
import { sendError } from '../utils/apiResponse.js';
import { USER_STATUS } from '../../config/constants.js';

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

    // Attach decoded token claims to request
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      scope: decoded.scope,
      organizationId: decoded.organizationId,
      townId: decoded.townId,
      schoolId: decoded.schoolId,
      assignedSchools: decoded.assignedSchools || [],
    };

    next();
  } catch (error) {
    return sendError(res, 401, 'Session expired or token invalid.', [{ message: error.message }]);
  }
};
