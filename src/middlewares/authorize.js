import { sendError } from '../utils/apiResponse.js';
import { ROLES, SCOPES } from '../../config/constants.js';

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

export const enforceSchoolScope = (req, res, next) => {
  if (!req.user) {
    return sendError(res, 401, 'Unauthorized.');
  }

  // Super Admin and DDO have Town/Global scope
  if ([ROLES.SUPER_ADMIN, ROLES.DDO].includes(req.user.role)) {
    return next();
  }

  // Supervisor must have target school in assignedSchools
  if (req.user.role === ROLES.SUPERVISOR) {
    const targetSchoolId = req.params.schoolId || req.body.schoolId || req.query.schoolId;
    if (targetSchoolId && !req.user.assignedSchools.includes(targetSchoolId)) {
      return sendError(res, 403, 'Access denied: Target school is not in your assigned inspection list.');
    }
    return next();
  }

  // HM, Assistant HM, Teacher must match their own school
  const targetSchoolId = req.params.schoolId || req.body.schoolId || req.query.schoolId;
  if (targetSchoolId && String(req.user.schoolId) !== String(targetSchoolId)) {
    return sendError(res, 403, 'Access denied: Cross-school access is strictly prohibited.');
  }

  next();
};
