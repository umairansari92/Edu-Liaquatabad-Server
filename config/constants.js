/**
 * Core Application Constants & Enums
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  CONSTITUTIONAL LAW (IMMUTABLE):                            ║
 * ║  Designation (Civil Title) ≠ Role (System Authority Level)  ║
 * ║  ≠ Permissions ≠ Scope                                      ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  EXAMPLES (Designation → Role):                             ║
 * ║  "Town Chairman"               → SUPER_ADMIN                ║
 * ║  "Vice Chairman"               → SUPER_ADMIN / ADMIN        ║
 * ║  "Deputy Director (DDO)"       → ADMIN                      ║
 * ║  "Education Officer"           → SUPERVISOR                 ║
 * ║  "Head Master"                 → HM                         ║
 * ║  "Assistant Head Master"       → HM                         ║
 * ║                                                              ║
 * ║  DDO is a DESIGNATION. ADMIN is the ROLE. They are NOT      ║
 * ║  the same. SUPER_ADMIN assigns ADMIN role to the DDO.        ║
 * ║  Chairman is a DESIGNATION. SUPER_ADMIN is the ROLE.        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ─── System Roles (8 Fixed Roles — NEVER add designations as roles) ───────────

export const ROLES = Object.freeze({
  ROOT_ADMIN:  'ROOT_ADMIN',   // Level 100 — Platform technical root. Emergency CLI only.
  SUPER_ADMIN: 'SUPER_ADMIN',  // Level 90  — e.g., Town Chairman. Town/Global authority.
  ADMIN:       'ADMIN',        // Level 80  — e.g., DDO. Town administrative governance.
  SUPERVISOR:  'SUPERVISOR',   // Level 60  — e.g., Education Officer. Multi-school oversight.
  HM:          'HM',           // Level 50  — e.g., Head Master. School authority.
  TEACHER:     'TEACHER',      // Level 30  — Class & section authority.
  STUDENT:     'STUDENT',      // Level 10  — Self-scope read access.
  PARENT:      'PARENT',       // Level 10  — Child-scoped read access.
});

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
  [ROLES.STUDENT]:     10,
  [ROLES.PARENT]:      10,
});

/**
 * Data Boundary Scopes — controls how far a role's data visibility extends.
 */
export const SCOPES = Object.freeze({
  GLOBAL:           'GLOBAL',           // Cross-organization (ROOT_ADMIN only)
  TOWN:             'TOWN',             // All schools in this town (SUPER_ADMIN, ADMIN)
  ASSIGNED_SCHOOLS: 'ASSIGNED_SCHOOLS', // Multiple assigned schools (SUPERVISOR field)
  SCHOOL:           'SCHOOL',           // Single school (HM)
  CLASS_SECTION:    'CLASS_SECTION',    // Specific class/section (TEACHER)
  SELF:             'SELF',             // Own record only (STUDENT)
  CHILD:            'CHILD',            // Own child's record only (PARENT)
});

/**
 * Default scope assigned per role at account provisioning.
 * SUPER_ADMIN can override scope when assigning a role to a user.
 */
export const ROLE_DEFAULT_SCOPE = Object.freeze({
  [ROLES.ROOT_ADMIN]:  SCOPES.GLOBAL,
  [ROLES.SUPER_ADMIN]: SCOPES.TOWN,
  [ROLES.ADMIN]:       SCOPES.TOWN,
  [ROLES.SUPERVISOR]:  SCOPES.ASSIGNED_SCHOOLS,
  [ROLES.HM]:          SCOPES.SCHOOL,
  [ROLES.TEACHER]:     SCOPES.CLASS_SECTION,
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
