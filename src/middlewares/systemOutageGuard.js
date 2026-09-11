import { getSystemStatus } from '../services/systemControlService.js';
import { verifyAccessToken } from '../utils/tokenUtils.js';
import { ROLES } from '../../config/constants.js';

/**
 * Middleware: systemOutageGuard
 * Simulates technical cluster outage for all users except ROOT_ADMIN when killswitch is active.
 */
export const systemOutageGuard = (request, response, next) => {
  const status = getSystemStatus();

  // If system is healthy and operational, let all traffic pass
  if (!status.isSuspended) {
    return next();
  }

  const requestPath = request.originalUrl || request.path || '';

  // 1. Allow system-control management routes so ROOT_ADMIN can inspect or toggle switch
  if (requestPath.includes('/system-control')) {
    return next();
  }

  // 2. Allow login route so ROOT_ADMIN can authenticate (handleLogin checks if actor is ROOT_ADMIN)
  if (requestPath.includes('/auth/login')) {
    return next();
  }

  // 3. Allow requests authenticated with a valid ROOT_ADMIN bearer token
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = verifyAccessToken(token);
      if (decoded && decoded.role === ROLES.ROOT_ADMIN) {
        return next();
      }
    } catch {
      // Invalid/expired token falls through to simulated outage response
    }
  }

  // 4. For all other traffic, simulate realistic infrastructure/database outage
  return response.status(503).json({
    success: false,
    message: status.errorMessage,
    code: 'ERR_DB_CLUSTER_FAIL',
    timestamp: new Date().toISOString(),
  });
};
