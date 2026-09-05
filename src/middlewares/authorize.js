import { sendError } from '../utils/apiResponse.js';
import { ROLES, SCOPES } from '../../config/constants.js';

export { authorizeHierarchy } from './authorizeHierarchy.js';
export { authorizePermissions } from './authorizePermissions.js';

/**
 * Validates that the user's role is in the allowed list
 * @param  {...string} allowedRoles
 */
export const authorizeRoles = (...allowedRoles) => {
  return (request, response, nextFunction) => {
    if (!request.user || !request.user.role) {
      return sendError(response, 401, 'Unauthorized: User not authenticated.');
    }

    if (!allowedRoles.includes(request.user.role)) {
      return sendError(response, 403, `Access denied. Requires one of: ${allowedRoles.join(', ')}`);
    }

    nextFunction();
  };
};

/**
 * Enforces organizational scope boundaries on target school resources
 */
export const enforceSchoolScope = (request, response, nextFunction) => {
  if (!request.user) {
    return sendError(response, 401, 'Unauthorized.');
  }

  // ROOT_ADMIN, SUPER_ADMIN, and ADMIN have Global/Town scope — bypass school boundary checks
  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(request.user.role)) {
    return nextFunction();
  }

  // Supervisor must have target school in assignedSchools
  if (request.user.role === ROLES.SUPERVISOR) {
    const targetSchoolId = request.params.schoolId || request.body.schoolId || request.query.schoolId;
    if (targetSchoolId) {
      const isAssigned = (request.user.assignedSchools || []).some(
        (assignedSchoolId) => String(assignedSchoolId) === String(targetSchoolId)
      );
      if (!isAssigned) {
        return sendError(response, 403, 'Access denied: Target school is not in your assigned inspection cluster.');
      }
    }
    return nextFunction();
  }

  // HM, Assistant HM, Teacher must match their own school
  const targetSchoolId = request.params.schoolId || request.body.schoolId || request.query.schoolId;
  if (targetSchoolId && String(request.user.schoolId) !== String(targetSchoolId)) {
    return sendError(response, 403, 'Access denied: Cross-school operation is strictly prohibited.');
  }

  nextFunction();
};
