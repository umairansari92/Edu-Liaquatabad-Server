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
  REJECTED:            'REJECTED',
  SUSPENDED:           'SUSPENDED',
  TRANSFERRED:         'TRANSFERRED',
  STRUCK_OFF:          'STRUCK_OFF',
  RETIRED:             'RETIRED',
  INACTIVE:            'INACTIVE',
});

export const STUDENT_STATUS = Object.freeze({
  ACTIVE:              'ACTIVE',
  PENDING_APPROVAL:    'PENDING_APPROVAL',
  REQUIRES_CORRECTION: 'REQUIRES_CORRECTION',
  REJECTED:            'REJECTED',
  TRANSFERRED:         'TRANSFERRED',
  GRADUATED:           'GRADUATED',
  DROPPED_OUT:         'DROPPED_OUT',
  STRUCK_OFF:          'STRUCK_OFF',
  INACTIVE:            'INACTIVE',
});

export const TEACHER_STATUS = Object.freeze({
  ACTIVE:              'ACTIVE',
  PENDING_APPROVAL:    'PENDING_APPROVAL',
  REQUIRES_CORRECTION: 'REQUIRES_CORRECTION',
  REJECTED:            'REJECTED',
  TRANSFERRED:         'TRANSFERRED',
  RETIRED:             'RETIRED',
  SUSPENDED:           'SUSPENDED',
  INACTIVE:            'INACTIVE',
});

export const TEACHING_ASSIGNMENT_STATUS = Object.freeze({
  ACTIVE:      'ACTIVE',
  INACTIVE:    'INACTIVE',
  COMPLETED:   'COMPLETED',
  TRANSFERRED: 'TRANSFERRED',
});

// ─── Operational Enums ────────────────────────────────────────────────────────

export const ATTENDANCE_STATUS = Object.freeze({
  PRESENT: 'PRESENT',
  ABSENT:  'ABSENT',
  LEAVE:   'LEAVE',
  LATE:    'LATE',
});

export const TRANSFER_STATUS = Object.freeze({
  // Canonical Municipal Lifecycle
  PENDING_TARGET_HM_APPROVAL: 'PENDING_TARGET_HM_APPROVAL',
  TRANSFER_REQUESTED:         'TRANSFER_REQUESTED',
  APPROVED:                   'APPROVED',
  RELIEVED:                   'RELIEVED',
  JOINED:                     'JOINED',

  // Exception / Governance Paths
  REJECTED:                   'REJECTED',
  REJECTED_BY_HM:             'REJECTED_BY_HM',
  ADMIN_REVIEW_REQUIRED:      'ADMIN_REVIEW_REQUIRED',
  CANCELLED:                  'CANCELLED',
  OVERRIDDEN_AND_TRANSFERRED: 'OVERRIDDEN_AND_TRANSFERRED',

  // Backward-Compatibility Aliases
  INITIATED:                  'INITIATED',
  AWAITING_DESTINATION_HM:    'AWAITING_DESTINATION_HM',
  JOINING_APPROVED:           'JOINING_APPROVED',
  EN_ROUTE:                   'RELIEVED',
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

// ─── Parent-Student Relationship & Verification Enums ────────────────────────

export const PARENT_STUDENT_LINK_STATUS = Object.freeze({
  PENDING_OTP:         'PENDING_OTP',
  PENDING_HM_APPROVAL: 'PENDING_HM_APPROVAL',
  VERIFIED:            'VERIFIED',
  REJECTED:            'REJECTED',
  REVOKED:             'REVOKED',
});

export const PARENT_RELATIONSHIP = Object.freeze({
  FATHER:   'FATHER',
  MOTHER:   'MOTHER',
  GUARDIAN: 'GUARDIAN',
});

// ─── Timetable Engine Constants & Enums ──────────────────────────────────────

export const TIMETABLE_SLOT_TYPE = Object.freeze({
  TEACHING:         'TEACHING',
  ASSEMBLY:         'ASSEMBLY',
  RECESS:           'RECESS',
  ZERO_PERIOD:      'ZERO_PERIOD',
  SPECIAL_ACTIVITY: 'SPECIAL_ACTIVITY',
});

export const TIMETABLE_STATUS = Object.freeze({
  ACTIVE:   'ACTIVE',
  DRAFT:    'DRAFT',
  ARCHIVED: 'ARCHIVED',
});

export const TIMETABLE_DAYS = Object.freeze([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
]);

// ─── Staff Category — School Staff vs Office Staff ─────────────────────────────
// Governs WHO approves attendance and leave requests.
// school_staff → HM approves  |  office_staff → Admin approves
// NOTE: staffCategory is derived from the User record, NOT from designation text.

export const STAFF_CATEGORY = Object.freeze({
  SCHOOL_STAFF: 'SCHOOL_STAFF', // School teachers, peons, clerks, head clerks assigned to a school
  OFFICE_STAFF: 'OFFICE_STAFF', // Education office staff regardless of designation
});

// ─── Casual / Earned Leave — Types & Statuses ─────────────────────────────────

export const LEAVE_TYPE = Object.freeze({
  CASUAL_LEAVE: 'CASUAL_LEAVE', // CL — 24 days per calendar year; reset 1 January; no carry-forward
  EARNED_LEAVE:  'EARNED_LEAVE',  // EL — minimum 3 consecutive calendar days; Admin-level approval required
});

export const LEAVE_STATUS = Object.freeze({
  PENDING:    'PENDING',    // Submitted; awaiting approver decision
  APPROVED:   'APPROVED',   // Approved by authorized approver
  REJECTED:   'REJECTED',   // Rejected by approver; day treated per attendance policy
  CANCELLED:  'CANCELLED',  // Withdrawn by requester before decision
  SUPERSEDED: 'SUPERSEDED', // Original record replaced by an authorized correction (original history preserved)
});

// Source identifies HOW the leave record was created.
export const LEAVE_SOURCE = Object.freeze({
  TEACHER_INITIATED: 'TEACHER_INITIATED', // Staff submitted their own CL request via platform
  HM_INITIATED:      'HM_INITIATED',      // HM created leave on behalf of absent staff
  SYSTEM:            'SYSTEM',            // Automated process (e.g., midnight CL→ABSENT transition)
});

// ─── Staff Attendance Approval Flow Statuses ───────────────────────────────────
// Used in the staff self-submission attendance flow (distinct from student attendance).

export const STAFF_ATTENDANCE_STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL', // Submitted by staff; awaiting HM/Admin approval
  APPROVED:         'APPROVED',         // Approved by authorized approver
  REJECTED:         'REJECTED',         // Rejected — day treated per attendance policy
});

// ─── CL Annual Policy (Owner-Confirmed — DO NOT CHANGE without explicit owner authorization) ──
export const CL_POLICY = Object.freeze({
  ANNUAL_ENTITLEMENT_DAYS: 24,   // Calendar year entitlement per staff member
  CARRY_FORWARD_ALLOWED:   false, // Unused CL does NOT carry forward to next year
  RESET_MONTH:             1,     // January (1-indexed)
  RESET_DAY:               1,     // 1st of January
});

// ─── EL Policy — PARTIALLY SPECIFIED ──────────────────────────────────────────
// CONFIRMED: minimum duration, approval authority
// UNVERIFIED / POLICY DECISION REQUIRED: annual entitlement, carry-forward, max duration, accrual
export const EL_POLICY = Object.freeze({
  MINIMUM_DURATION_CALENDAR_DAYS: 3, // Inclusive calendar days (weekends + holidays count)
  // ANNUAL_ENTITLEMENT: POLICY_DECISION_REQUIRED
  // CARRY_FORWARD: POLICY_DECISION_REQUIRED
  // MAXIMUM_DURATION: POLICY_DECISION_REQUIRED
  // ACCRUAL_FORMULA: POLICY_DECISION_REQUIRED
});

// ─── Approval 5-Minute Relaxation Window ──────────────────────────────────────
// Within this window, approver may approve staff attendance without a free-text reason.
// After this window, a mandatory free-text reason is required.
export const APPROVAL_RELAXATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

