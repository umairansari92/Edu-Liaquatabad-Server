/**
 * Core Application Constants & Enums
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  FINAL AUTHORITY MODEL (IMMUTABLE CONSTITUTIONAL LAW):      ║
 * ║                                                              ║
 * ║  Role  ≠  Designation  ≠  Permission  ≠  Scope              ║
 * ║                                                              ║
 * ║  A person's official civil designation (e.g., "Head Master" ║
 * ║  "Education Officer", "Senior Teacher") is DESCRIPTIVE      ║
 * ║  institutional metadata only.                               ║
 * ║                                                              ║
 * ║  System authority is determined EXCLUSIVELY by the          ║
 * ║  Role field — explicitly assigned by an authorized          ║
 * ║  administrator through the role-management system.          ║
 * ║                                                              ║
 * ║  Valid examples (ANY combination is possible):              ║
 * ║    designation: "Teacher"       + role: SUPER_ADMIN         ║
 * ║    designation: "Head Master"   + role: ADMIN               ║
 * ║    designation: "Officer"       + role: HM                  ║
 * ║                                                              ║
 * ║  PROHIBITED: logic that derives role from designation.      ║
 * ║  PROHIBITED: DDO / CHAIRMAN / VICE_CHAIRMAN as system roles.║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ─── System Roles (Canonical System Authorities — NEVER add civil designations as roles) ─────

export const ROLES = Object.freeze({
  ROOT_ADMIN:  'ROOT_ADMIN',   // Level 100 — Protected platform root. Emergency CLI only. Never publicly visible.
  SUPER_ADMIN: 'SUPER_ADMIN',  // Level 90  — Operational platform admin. Explicitly assigned by ROOT_ADMIN.
  ADMIN:       'ADMIN',        // Level 80  — Sub-administrative governance (e.g. Town Education Officer). Assigned by SUPER_ADMIN.
  SUPERVISOR:  'SUPERVISOR',   // Level 60  — Multi-school field oversight.
  HM:          'HM',           // Level 50  — Single school institutional authority.
  TEACHER:     'TEACHER',      // Level 30  — Class & section operational authority.
  PEON:        'PEON',         // Level 20  — Institutional operational support staff.
  STUDENT:     'STUDENT',      // Level 10  — Self-scope read access.
  PARENT:      'PARENT',       // Level 10  — Child-scoped read access.
});

/**
 * Controlled Base Roles available at public onboarding/registration.
 * Privileged authorities (ROOT_ADMIN, SUPER_ADMIN, ADMIN, HM) are STRICTLY excluded.
 */
export const BASE_ROLES = Object.freeze({
  PEON:       'PEON',
  TEACHER:    'TEACHER',
  SUPERVISOR: 'SUPERVISOR',
  STUDENT:    'STUDENT',
  PARENT:     'PARENT',
});

export const PUBLIC_REGISTRATION_ROLES = Object.freeze([
  BASE_ROLES.PEON,
  BASE_ROLES.TEACHER,
  BASE_ROLES.SUPERVISOR,
  BASE_ROLES.STUDENT,
  BASE_ROLES.PARENT,
]);

/**
 * Role Hierarchy Levels — higher number = higher authority.
 * Used in JWT payload (roleLevel) and server-side hierarchy guards.
 */
export const ROLE_HIERARCHY = Object.freeze({
  [ROLES.ROOT_ADMIN]:  100,
  [ROLES.SUPER_ADMIN]: 90,
  [ROLES.ADMIN]:       80,
  [ROLES.SUPERVISOR]:  60,
  [ROLES.HM]:          50,
  [ROLES.TEACHER]:     30,
  [ROLES.PEON]:        20,
  [ROLES.STUDENT]:     10,
  [ROLES.PARENT]:      10,
});

/**
 * Data Boundary Scopes — controls how far an authority's data visibility extends.
 * Canonical vocabulary: GLOBAL, TOWN, ASSIGNED_SCHOOLS, SCHOOL, CLASS_SECTION, SELF, CHILD.
 */
export const SCOPES = Object.freeze({
  GLOBAL:           'GLOBAL',           // Cross-organization (ROOT_ADMIN, global SUPER_ADMIN)
  TOWN:             'TOWN',             // Operational administrative scope across town (ADMIN)
  ADMINISTRATIVE:   'TOWN',             // Backwards-compatibility alias for transition
  ASSIGNED_SCHOOLS: 'ASSIGNED_SCHOOLS', // Multiple assigned schools (SUPERVISOR field)
  SCHOOL:           'SCHOOL',           // Single school (HM, PEON)
  CLASS_SECTION:    'CLASS_SECTION',    // Specific class/section (TEACHER)
  SELF:             'SELF',             // Own record only (STUDENT)
  CHILD:            'CHILD',            // Own child's record only (PARENT)
  SELF_CHILD:       'SELF',             // Backwards-compatibility alias
});

/**
 * Default scope assigned per role at account provisioning.
 * Authorized administrators can set scope within permissible boundaries.
 */
export const ROLE_DEFAULT_SCOPE = Object.freeze({
  [ROLES.ROOT_ADMIN]:  SCOPES.GLOBAL,
  [ROLES.SUPER_ADMIN]: SCOPES.GLOBAL,
  [ROLES.ADMIN]:       SCOPES.TOWN,
  [ROLES.SUPERVISOR]:  SCOPES.ASSIGNED_SCHOOLS,
  [ROLES.HM]:          SCOPES.SCHOOL,
  [ROLES.TEACHER]:     SCOPES.CLASS_SECTION,
  [ROLES.PEON]:        SCOPES.SCHOOL,
  [ROLES.STUDENT]:     SCOPES.SELF,
  [ROLES.PARENT]:      SCOPES.CHILD,
});

// ─── Account Lifecycle Statuses ───────────────────────────────────────────────

export const USER_STATUS = Object.freeze({
  ACTIVE:              'ACTIVE',
  PENDING_APPROVAL:    'PENDING_APPROVAL',
  REQUIRES_CORRECTION: 'REQUIRES_CORRECTION',
  SUSPENDED:           'SUSPENDED',
  TRANSFERRED:         'TRANSFERRED',
  RETIRED:             'RETIRED',
  INACTIVE:            'INACTIVE',
});

export const STUDENT_STATUS = Object.freeze({
  ACTIVE:              'ACTIVE',
  PENDING_APPROVAL:    'PENDING_APPROVAL',
  REQUIRES_CORRECTION: 'REQUIRES_CORRECTION',
  TRANSFERRED:         'TRANSFERRED',
  GRADUATED:           'GRADUATED',
  DROPPED_OUT:         'DROPPED_OUT',
  INACTIVE:            'INACTIVE',
});

export const TEACHER_STATUS = Object.freeze({
  ACTIVE:              'ACTIVE',
  PENDING_APPROVAL:    'PENDING_APPROVAL',
  REQUIRES_CORRECTION: 'REQUIRES_CORRECTION',
  TRANSFERRED:         'TRANSFERRED',
  RETIRED:             'RETIRED',
  SUSPENDED:           'SUSPENDED',
  INACTIVE:            'INACTIVE',
});

// ─── Operational Enums ────────────────────────────────────────────────────────

export const ATTENDANCE_STATUS = Object.freeze({
  PRESENT: 'PRESENT',
  ABSENT:  'ABSENT',
  LEAVE:   'LEAVE',
  LATE:    'LATE',
});

export const TRANSFER_STATUS = Object.freeze({
  INITIATED:                  'INITIATED',
  AWAITING_DESTINATION_HM:    'AWAITING_DESTINATION_HM',
  JOINING_APPROVED:           'JOINING_APPROVED',
  REJECTED_BY_HM:             'REJECTED_BY_HM',
  OVERRIDDEN_AND_TRANSFERRED: 'OVERRIDDEN_AND_TRANSFERRED',
  CANCELLED:                  'CANCELLED',
});

export const DOCUMENT_TYPES = Object.freeze({
  NOTICE:               'NOTICE',
  CIRCULAR:             'CIRCULAR',
  MEETING_NOTIFICATION: 'MEETING_NOTIFICATION',
  OFFICIAL_ORDER:       'OFFICIAL_ORDER',
  SYLLABUS:             'SYLLABUS',
  PDF_BOOK:             'PDF_BOOK',
  ANNOUNCEMENT:         'ANNOUNCEMENT',
});

export const AUDIENCE_TYPES = Object.freeze({
  ALL:                 'ALL',
  GOVERNMENT_OFFICERS: 'GOVERNMENT_OFFICERS',
  HM:                  'HM',
  TEACHERS:            'TEACHERS',
  STUDENTS:            'STUDENTS',
  PARENTS:             'PARENTS',
});
