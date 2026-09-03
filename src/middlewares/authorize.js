import { sendError } from '../utils/apiResponse.js';
import { ROLES, SCOPES } from '../../config/constants.js';

export { authorizeHierarchy } from './authorizeHierarchy.js';
export { authorizePermissions } from './authorizePermissions.js';

/**
 * Validates that the user's role is in the allowed list
 * @param  {...string} allowedRoles
 */
export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return sendError(res, 401, 'Unauthorized: User not authenticated.');
    }

    if (!allowedRoles.includes(req.user.role)) {
      return sendError(res, 403, `Access denied. Requires one of: ${allowedRoles.join(', ')}`);
    }

    next();
  };
};

/**
 * Enforces organizational scope boundaries on target school resources
 */
export const enforceSchoolScope = (req, res, next) => {
  if (!req.user) {
    return sendError(res, 401, 'Unauthorized.');
  }

  // ROOT_ADMIN, SUPER_ADMIN, and ADMIN have Global/Town scope
  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(req.user.role)) {
    return next();
  }

  // Supervisor must have target school in assignedSchools
  if (req.user.role === ROLES.SUPERVISOR) {
    const targetSchoolId = req.params.schoolId || req.body.schoolId || req.query.schoolId;
    if (targetSchoolId) {
      const isAssigned = (req.user.assignedSchools || []).some(
        (id) => String(id) === String(targetSchoolId)
      );
      if (!isAssigned) {
        return sendError(res, 403, 'Access denied: Target school is not in your assigned inspection cluster.');
      }
    }
    return next();
  }

  // HM, Assistant HM, Teacher must match their own school
  const targetSchoolId = req.params.schoolId || req.body.schoolId || req.query.schoolId;
  if (targetSchoolId && String(req.user.schoolId) !== String(targetSchoolId)) {
    return sendError(res, 403, 'Access denied: Cross-school operation is strictly prohibited.');
  }

  next();
};
