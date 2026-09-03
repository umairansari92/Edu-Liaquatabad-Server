/**
 * Master Permissions & Capability Registry
 * Education Department Liaquatabad Town Centre (DMC)
 */

import { ROLES, ROLE_HIERARCHY } from '../../config/constants.js';

export const PERMISSIONS = Object.freeze({
  // User & Administrative Governance
  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_SUSPEND: 'users.suspend',
  USERS_ASSIGN_ROLE: 'users.assign_role',
  USERS_ASSIGN_DESIGNATION: 'users.assign_designation',
  USERS_APPROVE: 'users.approve',

  // School Institutional Management
  SCHOOLS_VIEW: 'schools.view',
  SCHOOLS_CREATE: 'schools.create',
  SCHOOLS_UPDATE: 'schools.update',
  SCHOOLS_SET_CODE: 'schools.set_code',

  // Attendance Operations
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_MARK: 'attendance.mark',
  ATTENDANCE_VERIFY: 'attendance.verify',

  // Academic & Examinations
  EXAMS_VIEW: 'exams.view',
  EXAMS_CREATE: 'exams.create',
  EXAMS_ENTER_MARKS: 'exams.enter_marks',
  EXAMS_VERIFY: 'exams.verify',

  // Faculty Transfers
  TRANSFERS_VIEW: 'transfers.view',
  TRANSFERS_INITIATE: 'transfers.initiate',
  TRANSFERS_APPROVE_JOINING: 'transfers.approve_joining',
  TRANSFERS_EMERGENCY_OVERRIDE: 'transfers.emergency_override',

  // Official Documents & Circulars
  DOCUMENTS_VIEW: 'documents.view',
  DOCUMENTS_PUBLISH: 'documents.publish',
  DOCUMENTS_DELETE: 'documents.delete',

  // Audit Logs & Security Telemetry
  AUDIT_VIEW: 'audit.view',
});

/**
 * Base Permissions intrinsically granted by Role
 */
export const ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  [ROLES.ROOT_ADMIN]: Object.values(PERMISSIONS),

  [ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS),

  [ROLES.ADMIN]: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.USERS_SUSPEND,
    PERMISSIONS.USERS_APPROVE,
    PERMISSIONS.USERS_ASSIGN_DESIGNATION,
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.SCHOOLS_UPDATE,
    PERMISSIONS.SCHOOLS_SET_CODE,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.TRANSFERS_VIEW,
    PERMISSIONS.TRANSFERS_INITIATE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_PUBLISH,
    PERMISSIONS.AUDIT_VIEW,
  ],

  [ROLES.SUPERVISOR]: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.TRANSFERS_VIEW,
    PERMISSIONS.TRANSFERS_INITIATE,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_PUBLISH,
    PERMISSIONS.AUDIT_VIEW,
  ],

  [ROLES.HM]: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_APPROVE,
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.SCHOOLS_UPDATE,
    PERMISSIONS.SCHOOLS_SET_CODE,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_VERIFY,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.EXAMS_VERIFY,
    PERMISSIONS.TRANSFERS_VIEW,
    PERMISSIONS.TRANSFERS_APPROVE_JOINING,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_PUBLISH,
  ],

  [ROLES.TEACHER]: [
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_MARK,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_ENTER_MARKS,
    PERMISSIONS.DOCUMENTS_VIEW,
  ],

  [ROLES.STUDENT]: [
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
  ],

  [ROLES.PARENT]: [
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
  ],
});

/**
 * Permissions strictly forbidden from being granted to lower roles via customPermissions
 * (Permission Ceiling Enforcement)
 */
export const ROLE_PERMISSION_CEILING = Object.freeze({
  [ROLES.TEACHER]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.USERS_SUSPEND,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.AUDIT_VIEW,
  ],
  [ROLES.STUDENT]: Object.values(PERMISSIONS).filter(
    (p) => ![PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.EXAMS_VIEW, PERMISSIONS.DOCUMENTS_VIEW].includes(p)
  ),
  [ROLES.PARENT]: Object.values(PERMISSIONS).filter(
    (p) => ![PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.EXAMS_VIEW, PERMISSIONS.DOCUMENTS_VIEW].includes(p)
  ),
  [ROLES.HM]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.AUDIT_VIEW,
  ],
  [ROLES.SUPERVISOR]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
  ],
  [ROLES.ADMIN]: [
    PERMISSIONS.USERS_ASSIGN_ROLE, // Role elevation reserved for Super Admin & Root Admin
  ],
});

/**
 * Validates whether proposed custom permissions exceed the role's allowed ceiling
 * @param {string} role 
 * @param {string[]} customPermissions 
 * @returns {{ valid: boolean, forbiddenPermissions: string[] }}
 */
export const validatePermissionCeiling = (role, customPermissions = []) => {
  const forbiddenList = ROLE_PERMISSION_CEILING[role] || [];
  const violations = customPermissions.filter((p) => forbiddenList.includes(p));

  return {
    valid: violations.length === 0,
    forbiddenPermissions: violations,
  };
};

/**
 * Resolves the complete set of effective permissions for a user
 * @param {Object} user 
 * @returns {string[]}
 */
export const getEffectivePermissions = (user) => {
  if (!user || !user.role) return [];
  const defaultPerms = ROLE_DEFAULT_PERMISSIONS[user.role] || [];
  const customPerms = Array.isArray(user.customPermissions) ? user.customPermissions : [];

  // Filter out any custom permissions that violate ceiling
  const ceilingForbidden = new Set(ROLE_PERMISSION_CEILING[user.role] || []);
  const safeCustomPerms = customPerms.filter((p) => !ceilingForbidden.has(p));

  return Array.from(new Set([...defaultPerms, ...safeCustomPerms]));
};
