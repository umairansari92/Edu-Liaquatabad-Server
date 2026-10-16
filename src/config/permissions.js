/**
 * Master Permissions & Capability Registry
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * FINAL AUTHORITY MODEL:
 *   ROOT_ADMIN(100) > SUPER_ADMIN(90) > ADMIN(80) > SUPERVISOR(60) > HM(50) > TEACHER(30) > STUDENT(10) | PARENT(10)
 *
 * CONSTITUTIONAL LAW — Role ≠ Designation:
 *   Designation is purely descriptive institutional metadata (e.g., "Head Master", "Education Officer").
 *   System authority is determined EXCLUSIVELY by the Role field, which is explicitly assigned
 *   through the role-management system. ANY designation may hold ANY role.
 *
 * PROHIBITED:
 *   - DDO, CHAIRMAN, VICE_CHAIRMAN as hard-coded system roles
 *   - Any logic that derives role from designation
 *   - Designation changes granting system authority
 */

import { ROLES } from '../../config/constants.js';

// ─── Permission Keys ──────────────────────────────────────────────────────────

export const PERMISSIONS = Object.freeze({
  // User & Administrative Governance
  USERS_VIEW:               'users.view',
  USERS_CREATE:             'users.create',
  USERS_UPDATE:             'users.update',
  USERS_SUSPEND:            'users.suspend',
  USERS_ASSIGN_ROLE:        'users.assign_role',
  USERS_ASSIGN_DESIGNATION: 'users.assign_designation',
  USERS_APPROVE:            'users.approve',

  // School Institutional Management
  SCHOOLS_VIEW:           'schools.view',
  SCHOOLS_CREATE:         'schools.create',
  SCHOOLS_UPDATE:         'schools.update',
  SCHOOLS_SET_CODE:       'schools.set_code',
  SCHOOLS_TIMINGS_UPDATE: 'schools.timings_update',

  // Attendance Operations
  ATTENDANCE_VIEW:   'attendance.view',
  ATTENDANCE_MARK:   'attendance.mark',
  ATTENDANCE_VERIFY: 'attendance.verify',

  // Academic & Examinations
  EXAMS_VIEW:        'exams.view',
  EXAMS_CREATE:      'exams.create',
  EXAMS_ENTER_MARKS: 'exams.enter_marks',
  EXAMS_VERIFY:      'exams.verify',

  // Faculty Transfers
  TRANSFERS_VIEW:               'transfers.view',
  TRANSFERS_INITIATE:           'transfers.initiate',
  TRANSFERS_RELIEVE:            'transfers.relieve',
  TRANSFERS_APPROVE_JOINING:    'transfers.approve_joining',
  TRANSFERS_EMERGENCY_OVERRIDE: 'transfers.emergency_override',
  TRANSFERS_ADMIN_REVIEW:       'transfers.admin_review',
  TRANSFERS_CANCEL:             'transfers.cancel',

  // Official Documents & Circulars
  DOCUMENTS_VIEW:    'documents.view',
  DOCUMENTS_PUBLISH: 'documents.publish',
  DOCUMENTS_DELETE:  'documents.delete',

  // Audit Logs & Security Telemetry
  AUDIT_VIEW: 'audit.view',

  // Homework Operations
  HOMEWORK_VIEW:   'homework.view',
  HOMEWORK_CREATE: 'homework.create',

  // Leave Management (CL / EL)
  LEAVE_VIEW:             'leave.view',           // View own or school leave records
  LEAVE_SUBMIT:           'leave.submit',          // Submit own CL or EL request
  LEAVE_APPROVE_CL:       'leave.approve_cl',      // Approve/reject CL (HM for school staff; Supervisor/Admin for HM)
  LEAVE_APPROVE_EL:       'leave.approve_el',      // Approve/reject EL (Admin-level and above ONLY)
  LEAVE_INITIATE_HM:      'leave.initiate_hm',     // HM initiating CL/Absent on behalf of absent teacher (school-scope)

  // Staff Self-Submission Attendance
  STAFF_ATTENDANCE_SUBMIT:  'staff_attendance.submit',  // Staff submits own attendance for approval
  STAFF_ATTENDANCE_APPROVE: 'staff_attendance.approve', // Approver (HM/Admin) approves/rejects staff attendance
});

// ─── Role Default Permissions ─────────────────────────────────────────────────

/**
 * Base permissions intrinsically granted by Role.
 * These are the floor — cannot be removed from a role.
 */
export const ROLE_DEFAULT_PERMISSIONS = Object.freeze({

  // ROOT_ADMIN: Supreme platform authority — all permissions. Never publicly visible.
  [ROLES.ROOT_ADMIN]: Object.values(PERMISSIONS),

  // SUPER_ADMIN: Full operational platform authority — all permissions.
  // Role assigned explicitly by ROOT_ADMIN. Designation is separate (can be any civil title).
  [ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS),

  // ADMIN: Town administrative governance.
  // Role assigned explicitly by SUPER_ADMIN. Designation is separate (can be any civil title).
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
    PERMISSIONS.SCHOOLS_TIMINGS_UPDATE,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.EXAMS_ENTER_MARKS,
    PERMISSIONS.EXAMS_VERIFY,
    PERMISSIONS.TRANSFERS_VIEW,
    PERMISSIONS.TRANSFERS_INITIATE,
    PERMISSIONS.TRANSFERS_RELIEVE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.TRANSFERS_ADMIN_REVIEW,
    PERMISSIONS.TRANSFERS_CANCEL,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_PUBLISH,
    PERMISSIONS.DOCUMENTS_DELETE,
    PERMISSIONS.AUDIT_VIEW,
    // Leave management — Admin approves office staff CL/EL and HM EL
    PERMISSIONS.LEAVE_VIEW,
    PERMISSIONS.LEAVE_SUBMIT,
    PERMISSIONS.LEAVE_APPROVE_CL,
    PERMISSIONS.LEAVE_APPROVE_EL,
    PERMISSIONS.STAFF_ATTENDANCE_SUBMIT,
    PERMISSIONS.STAFF_ATTENDANCE_APPROVE,
  ],

  // SUPERVISOR: Field oversight across assigned schools
  // e.g., Education Officer holds SUPERVISOR role
  [ROLES.SUPERVISOR]: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_APPROVE,
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_VERIFY,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.EXAMS_VERIFY,
    PERMISSIONS.TRANSFERS_VIEW,
    PERMISSIONS.TRANSFERS_INITIATE,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_PUBLISH,
    PERMISSIONS.AUDIT_VIEW,
    // Supervisor may approve HM CL requests (per confirmed institutional policy)
    // Supervisor CANNOT approve EL unless separately granted Admin-level authority
    PERMISSIONS.LEAVE_VIEW,
    PERMISSIONS.LEAVE_SUBMIT,
    PERMISSIONS.LEAVE_APPROVE_CL,
    PERMISSIONS.STAFF_ATTENDANCE_SUBMIT,
  ],

  // HM: School authority
  // e.g., Head Master or Assistant Head Master holds HM role
  //
  // ATTENDANCE_MARK is intentionally included here:
  //   HM may submit student-section attendance directly when the assigned
  //   teacher is on Casual Leave (CL) or otherwise absent. The resolveTeacherSection
  //   gate already grants HM school-boundary access without a TeachingAssignment;
  //   this permission unlocks the route-level authorizePermissions check.
  [ROLES.HM]: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_APPROVE,
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.SCHOOLS_SET_CODE,
    PERMISSIONS.SCHOOLS_TIMINGS_UPDATE,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_MARK,
    PERMISSIONS.ATTENDANCE_VERIFY,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_CREATE,
    PERMISSIONS.EXAMS_ENTER_MARKS,
    PERMISSIONS.EXAMS_VERIFY,
    PERMISSIONS.TRANSFERS_VIEW,
    PERMISSIONS.TRANSFERS_RELIEVE,
    PERMISSIONS.TRANSFERS_APPROVE_JOINING,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_PUBLISH,
    PERMISSIONS.DOCUMENTS_DELETE,
    PERMISSIONS.HOMEWORK_VIEW,
    PERMISSIONS.HOMEWORK_CREATE,
    // Leave management — HM approves school staff CL; HM initiates CL/Absent for absent teachers
    // HM CANNOT approve EL (Admin-level authority required)
    PERMISSIONS.LEAVE_VIEW,
    PERMISSIONS.LEAVE_SUBMIT,
    PERMISSIONS.LEAVE_APPROVE_CL,
    PERMISSIONS.LEAVE_INITIATE_HM,
    PERMISSIONS.STAFF_ATTENDANCE_SUBMIT,
    PERMISSIONS.STAFF_ATTENDANCE_APPROVE,
  ],

  // TEACHER: Class/section operational authority
  [ROLES.TEACHER]: [
    PERMISSIONS.SCHOOLS_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_MARK,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.EXAMS_ENTER_MARKS,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.HOMEWORK_VIEW,
    PERMISSIONS.HOMEWORK_CREATE,
    // Teachers can submit their own CL requests and view their leave history
    PERMISSIONS.LEAVE_VIEW,
    PERMISSIONS.LEAVE_SUBMIT,
    PERMISSIONS.STAFF_ATTENDANCE_SUBMIT,
  ],

  // PEON: Operational support staff — documents view + can submit own attendance/leave
  [ROLES.PEON]: [
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.LEAVE_VIEW,
    PERMISSIONS.LEAVE_SUBMIT,
    PERMISSIONS.STAFF_ATTENDANCE_SUBMIT,
  ],

  // STUDENT: Read-only access to own records
  [ROLES.STUDENT]: [
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.HOMEWORK_VIEW,
  ],

  // PARENT: Read-only access to child's records
  [ROLES.PARENT]: [
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.EXAMS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.HOMEWORK_VIEW,
  ],
});

// ─── Permission Ceiling Enforcement ──────────────────────────────────────────

/**
 * Permissions that CANNOT be granted to a role even via customPermissions.
 * This is the security ceiling — prevents privilege escalation attacks.
 */
export const ROLE_PERMISSION_CEILING = Object.freeze({
  // ADMIN cannot assign system roles — that is SUPER_ADMIN/ROOT_ADMIN authority only
  [ROLES.ADMIN]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
  ],

  [ROLES.SUPERVISOR]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.SCHOOLS_CREATE,
    PERMISSIONS.SCHOOLS_TIMINGS_UPDATE,
  ],

  [ROLES.HM]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.SCHOOLS_CREATE,
    PERMISSIONS.SCHOOLS_UPDATE,
  ],

  [ROLES.TEACHER]: [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.USERS_SUSPEND,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_APPROVE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
    PERMISSIONS.TRANSFERS_INITIATE,
    PERMISSIONS.TRANSFERS_APPROVE_JOINING,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.SCHOOLS_CREATE,
    PERMISSIONS.SCHOOLS_UPDATE,
    PERMISSIONS.SCHOOLS_SET_CODE,
    PERMISSIONS.SCHOOLS_TIMINGS_UPDATE,
  ],

  [ROLES.PEON]: Object.values(PERMISSIONS).filter(
    (permissionKey) => ![PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.ATTENDANCE_VIEW].includes(permissionKey)
  ),

  [ROLES.STUDENT]: Object.values(PERMISSIONS).filter(
    (permissionKey) => ![
      PERMISSIONS.ATTENDANCE_VIEW,
      PERMISSIONS.EXAMS_VIEW,
      PERMISSIONS.DOCUMENTS_VIEW,
      PERMISSIONS.HOMEWORK_VIEW,
    ].includes(permissionKey)
  ),

  [ROLES.PARENT]: Object.values(PERMISSIONS).filter(
    (permissionKey) => ![
      PERMISSIONS.ATTENDANCE_VIEW,
      PERMISSIONS.EXAMS_VIEW,
      PERMISSIONS.DOCUMENTS_VIEW,
      PERMISSIONS.HOMEWORK_VIEW,
    ].includes(permissionKey)
  ),
});

// ─── Utility Functions ────────────────────────────────────────────────────────

/**
 * Validates whether proposed custom permissions exceed the role's allowed ceiling.
 * @param {string} role
 * @param {string[]} customPermissions
 * @returns {{ valid: boolean, forbiddenPermissions: string[] }}
 */
export const validatePermissionCeiling = (role, customPermissions = []) => {
  const forbiddenList = ROLE_PERMISSION_CEILING[role] || [];
  const violations = customPermissions.filter((customPermission) => forbiddenList.includes(customPermission));
  return {
    valid: violations.length === 0,
    forbiddenPermissions: violations,
  };
};

/**
 * Resolves the complete set of effective permissions for a user.
 * Merges role defaults with safe custom permissions (ceiling-filtered).
 * @param {Object} user
 * @returns {string[]}
 */
export const getEffectivePermissions = (user) => {
  if (!user || !user.role) return [];
  const defaultPerms = ROLE_DEFAULT_PERMISSIONS[user.role] || [];
  const customPerms = Array.isArray(user.customPermissions) ? user.customPermissions : [];

  // Strip any ceiling violations from custom permissions
  const ceilingForbidden = new Set(ROLE_PERMISSION_CEILING[user.role] || []);
  const safeCustomPerms = customPerms.filter((customPermission) => !ceilingForbidden.has(customPermission));

  return Array.from(new Set([...defaultPerms, ...safeCustomPerms]));
};
