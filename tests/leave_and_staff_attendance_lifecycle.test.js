/**
 * 🛡️ LEAVE AND STAFF ATTENDANCE LIFECYCLE VERIFICATION SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * 1. CL Policy (24 days/year, reset 1 Jan, no carry-forward)
 * 2. EL Policy (minimum 3 calendar days, Admin-level approval only)
 * 3. Approval Authority Matrix (School Staff CL, HM CL, EL, Admin/Supervisor/HM boundaries)
 * 4. Staff Attendance 5-Minute Relaxation Rule (<= 5 min optional, > 5 min mandatory reason)
 * 5. Rejection Reason Enforcement (rejection requires mandatory reason)
 * 6. HM Self-Attendance Invariants (self-effective, non-HM blocked)
 * 7. Request Fingerprint Determinism
 * 8. Annual CL Reset & Rollover Invariants
 * 9. RBAC & Permissions Integrity
 * 10. Controller Response Contract & Validation Guards
 */

import {
  ROLES,
  LEAVE_TYPE,
  LEAVE_STATUS,
  LEAVE_SOURCE,
  STAFF_ATTENDANCE_STATUS,
  STAFF_CATEGORY,
  CL_POLICY,
  EL_POLICY,
  APPROVAL_RELAXATION_WINDOW_MS,
} from '../config/constants.js';
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
} from '../src/config/permissions.js';
import {
  parsePktDateString,
  getPktYearFromDate,
  calculateInclusiveDurationDays,
  validateEarnedLeaveDuration,
  generateLeaveRequestFingerprint,
  resolveLeaveApprovalAuthority,
  performAnnualClReset,
} from '../src/services/leaveService.js';
import {
  handleHmSelfAttendance,
  handleApproveStaffAttendance,
  handleRejectStaffAttendance,
  handleGetPendingStaffAttendance,
} from '../src/controllers/staffAttendanceController.js';
import {
  handleLateCorrectionLeaveRequest,
  handleApproveLeaveRequest,
} from '../src/controllers/leaveController.js';
import {
  processMidnightHmClTransition,
} from '../src/services/leaveService.js';
import Notification from '../src/models/Notification.js';
import NotificationOutbox from '../src/models/NotificationOutbox.js';

Notification.insertMany = async () => [];
NotificationOutbox.create = async () => ({ _id: 'mock_outbox_id' });

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL [${totalTests}]: ${testName}`);
    throw new Error(`Assertion failed: ${testName}`);
  }
  passedTests++;
  console.log(`✅ PASS [${totalTests}]: ${testName}`);
}

function createMockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

console.log('\n==============================================================================');
console.log('🏛️  LEAVE & STAFF ATTENDANCE LIFECYCLE COMPREHENSIVE VERIFICATION SUITE');
console.log('==============================================================================\n');

// ─── 1. Policy Constants & Baseline Invariants ──────────────────────────────
console.log('--- 1. Policy Constants & Baseline Invariants ---');

assert(CL_POLICY.ANNUAL_ENTITLEMENT_DAYS === 24, 'CL Annual Entitlement is strictly 24 days');
assert(CL_POLICY.CARRY_FORWARD_ALLOWED === false, 'CL does NOT carry forward to the next year');
assert(CL_POLICY.RESET_MONTH === 1 && CL_POLICY.RESET_DAY === 1, 'CL resets on 1 January');
assert(EL_POLICY.MINIMUM_DURATION_CALENDAR_DAYS === 3, 'EL minimum duration is 3 consecutive calendar days');
assert(APPROVAL_RELAXATION_WINDOW_MS === 300000, 'Staff attendance approval relaxation window is exactly 5 minutes (300,000 ms)');

// ─── 2. Date Helpers & Duration Calculation ──────────────────────────────────
console.log('\n--- 2. Date Calculations & Duration Invariants ---');

const testStartDate = parsePktDateString('2026-10-14');
const testEndDate = parsePktDateString('2026-10-16');
const durationThreeDays = calculateInclusiveDurationDays(testStartDate, testEndDate);
assert(durationThreeDays === 3, '2026-10-14 to 2026-10-16 inclusive is exactly 3 calendar days');

const singleDayStart = parsePktDateString('2026-05-01');
const singleDayEnd = parsePktDateString('2026-05-01');
assert(calculateInclusiveDurationDays(singleDayStart, singleDayEnd) === 1, 'Same start and end date equals 1 calendar day');

const pktYear = getPktYearFromDate(testStartDate);
assert(pktYear === 2026, 'getPktYearFromDate extracts 2026 accurately');

// ─── 3. Earned Leave (EL) Validation ─────────────────────────────────────────
console.log('\n--- 3. Earned Leave (EL) Duration Validation ---');

const elShort = validateEarnedLeaveDuration(parsePktDateString('2026-11-01'), parsePktDateString('2026-11-02'));
assert(elShort.valid === false, 'EL for 2 calendar days is rejected (less than 3 days minimum)');
assert(elShort.error.includes('minimum duration is 3 consecutive calendar days'), 'EL rejection contains explicit minimum duration message');

const elValidThree = validateEarnedLeaveDuration(parsePktDateString('2026-11-01'), parsePktDateString('2026-11-03'));
assert(elValidThree.valid === true, 'EL for 3 consecutive days is valid');
assert(elValidThree.durationDays === 3, 'EL duration is correctly counted as 3 days');

const elInverted = validateEarnedLeaveDuration(parsePktDateString('2026-11-05'), parsePktDateString('2026-11-01'));
assert(elInverted.valid === false, 'EL with end date before start date is rejected');

// ─── 4. Approval Authority Resolution Matrix ─────────────────────────────────
console.log('\n--- 4. Leave Approval Authority Resolution Matrix ---');

const schoolAId = '65d1a1b2c3d4e5f600000001';
const schoolBId = '65d1a1b2c3d4e5f600000002';

// 4a. School Teacher CL
const teacherClRecord = {
  leaveType: LEAVE_TYPE.CASUAL_LEAVE,
  staffRole: ROLES.TEACHER,
  schoolId: schoolAId,
};

const hmA = { role: ROLES.HM, schoolId: schoolAId };
const hmB = { role: ROLES.HM, schoolId: schoolBId };
const supervisorA = { role: ROLES.SUPERVISOR, assignedSchools: [schoolAId] };
const adminActor = { role: ROLES.ADMIN };
const superAdminActor = { role: ROLES.SUPER_ADMIN };
const rootAdminActor = { role: ROLES.ROOT_ADMIN };

assert(resolveLeaveApprovalAuthority(hmA, teacherClRecord).authorized === true, 'HM of same school is authorized to approve teacher CL');
assert(resolveLeaveApprovalAuthority(hmB, teacherClRecord).authorized === false, 'HM of different school is blocked from approving teacher CL (BOLA check)');
assert(resolveLeaveApprovalAuthority(supervisorA, teacherClRecord).authorized === false, 'Supervisor cannot directly approve ordinary teacher CL (HM responsibility)');
assert(resolveLeaveApprovalAuthority(adminActor, teacherClRecord).authorized === true, 'Admin has overarching authority to approve CL');
assert(resolveLeaveApprovalAuthority(superAdminActor, teacherClRecord).authorized === true, 'Super Admin has authority to approve CL');
assert(resolveLeaveApprovalAuthority(rootAdminActor, teacherClRecord).authorized === true, 'Root Admin has authority to approve CL');

// 4b. HM's Own CL (The HM Exception)
const hmClRecord = {
  leaveType: LEAVE_TYPE.CASUAL_LEAVE,
  staffRole: ROLES.HM,
  schoolId: schoolAId,
};

assert(resolveLeaveApprovalAuthority(hmA, hmClRecord).authorized === false, 'HM CANNOT approve their own CL request');
assert(resolveLeaveApprovalAuthority(supervisorA, hmClRecord).authorized === true, 'Assigned Supervisor CAN approve HM Casual Leave');
const supervisorB = { role: ROLES.SUPERVISOR, assignedSchools: [schoolBId] };
assert(resolveLeaveApprovalAuthority(supervisorB, hmClRecord).authorized === false, 'Unassigned Supervisor cannot approve HM CL outside their cluster');
assert(resolveLeaveApprovalAuthority(adminActor, hmClRecord).authorized === true, 'Admin CAN approve HM Casual Leave');

// 4c. Earned Leave (EL) Strict Restriction
const elRecord = {
  leaveType: LEAVE_TYPE.EARNED_LEAVE,
  staffRole: ROLES.TEACHER,
  schoolId: schoolAId,
};

assert(resolveLeaveApprovalAuthority(hmA, elRecord).authorized === false, 'HM CANNOT approve Earned Leave (EL)');
assert(resolveLeaveApprovalAuthority(supervisorA, elRecord).authorized === false, 'Supervisor CANNOT approve Earned Leave (EL)');
assert(resolveLeaveApprovalAuthority(adminActor, elRecord).authorized === true, 'Admin CAN approve Earned Leave (EL)');
assert(resolveLeaveApprovalAuthority(superAdminActor, elRecord).authorized === true, 'Super Admin CAN approve Earned Leave (EL)');
assert(resolveLeaveApprovalAuthority(rootAdminActor, elRecord).authorized === true, 'Root Admin CAN approve Earned Leave (EL)');

// ─── 5. Request Fingerprinting & Idempotency ────────────────────────────────
console.log('\n--- 5. Request Fingerprinting & Tamper Detection ---');

const fp1 = generateLeaveRequestFingerprint('user123', LEAVE_TYPE.CASUAL_LEAVE, testStartDate, testEndDate);
const fp2 = generateLeaveRequestFingerprint('user123', LEAVE_TYPE.CASUAL_LEAVE, testStartDate, testEndDate);
const fp3 = generateLeaveRequestFingerprint('user999', LEAVE_TYPE.CASUAL_LEAVE, testStartDate, testEndDate);

assert(fp1 === fp2, 'Fingerprint generation is strictly deterministic for identical parameters');
assert(fp1 !== fp3, 'Fingerprint differs when staff user ID differs');
assert(typeof fp1 === 'string' && fp1.length === 64, 'Fingerprint is a valid 64-character SHA-256 hex string');

// ─── 6. Annual CL Reset Lifecycle ───────────────────────────────────────────
console.log('\n--- 6. Annual CL Reset Invariants ---');

import LeaveRequest from '../src/models/LeaveRequest.js';
import StaffAttendanceRecord from '../src/models/StaffAttendanceRecord.js';

const origCount = LeaveRequest.countDocuments;
LeaveRequest.countDocuments = async () => 15;

const currentYear = new Date().getFullYear();
const resetResult = await performAnnualClReset(currentYear);
assert(resetResult.success === true, 'Annual CL reset executes successfully');
assert(resetResult.previousYearApprovedRecordsPreserved === 15, 'Approved records from previous year preserved');
assert(resetResult.message.includes('CL balance resets to 24 days'), 'Reset message confirms 24 days entitlement baseline');

LeaveRequest.countDocuments = origCount;

// ─── 7. Staff Attendance 5-Minute Relaxation Rule Logic ─────────────────────
console.log('\n--- 7. Staff Attendance 5-Minute Relaxation Window Logic ---');

const fiveMinutesMs = APPROVAL_RELAXATION_WINDOW_MS;

// Scenario A: Within 5 minutes (e.g. 2 minutes = 120,000 ms)
const delayWithinWindow = 120000;
const reasonWithin = '';
const isLateWithin = delayWithinWindow > fiveMinutesMs;
assert(!isLateWithin, '120,000 ms is within 5-minute relaxation window');
assert(Boolean(!isLateWithin || (reasonWithin && reasonWithin.trim().length >= 5)) === true, 'Approval within window does not require mandatory reason');

// Scenario B: After 5 minutes (e.g. 6 minutes = 360,000 ms) WITHOUT reason
const delayAfterWindow = 360000;
const isLateAfter = delayAfterWindow > fiveMinutesMs;
assert(isLateAfter, '360,000 ms exceeds 5-minute relaxation window');
const reasonMissing = '';
const isValidWithoutReason = Boolean(!isLateAfter || (reasonMissing && reasonMissing.trim().length >= 5));
assert(isValidWithoutReason === false, 'Approval after 5 minutes without reason is invalid (requires mandatory reason)');

// Scenario C: After 5 minutes WITH reason
const reasonProvided = 'Network latency in town office verified';
const isValidWithReason = Boolean(!isLateAfter || (reasonProvided && reasonProvided.trim().length >= 5));
assert(isValidWithReason === true, 'Approval after 5 minutes with valid reason is accepted');

// ─── 8. HM Self-Attendance Invariants ────────────────────────────────────────
console.log('\n--- 8. HM Self-Attendance Controller Validation ---');

// 8a. Non-HM user blocked
const nonHmReq = {
  user: { role: ROLES.TEACHER, fullName: 'Teacher Ali' },
  body: { attendanceDate: '2026-10-14' },
};
const mockRes1 = createMockResponse();
await handleHmSelfAttendance(nonHmReq, mockRes1);
assert(mockRes1.statusCode === 403, 'Non-HM actor is blocked from /hm-self endpoint with 403 Forbidden');

// 8b. Missing attendanceDate
const hmReqMissingDate = {
  user: { role: ROLES.HM, fullName: 'HM Aslam', schoolId: schoolAId },
  body: {},
};
const mockRes2 = createMockResponse();
await handleHmSelfAttendance(hmReqMissingDate, mockRes2);
assert(mockRes2.statusCode === 400, 'Missing attendanceDate returns 400 Bad Request');

// 8c. Valid HM self-attendance creation
import AuditLog from '../src/models/AuditLog.js';

const origFindOne = StaffAttendanceRecord.findOne;
const origCreate = StaffAttendanceRecord.create;
const origAuditCreate = AuditLog.create;

StaffAttendanceRecord.findOne = () => ({ lean: async () => null });
StaffAttendanceRecord.create = async (doc) => ({ _id: '65d1a1b2c3d4e5f600000099', ...doc });
AuditLog.create = async () => ({ _id: '65d1a1b2c3d4e5f600000077' });

const validHmReq = {
  user: { _id: '65d1a1b2c3d4e5f600000088', role: ROLES.HM, fullName: 'HM Aslam', schoolId: schoolAId, townId: '65d1a1b2c3d4e5f600000010' },
  body: { attendanceDate: '2026-10-14' },
};
const mockRes3 = createMockResponse();
await handleHmSelfAttendance(validHmReq, mockRes3);
assert(mockRes3.statusCode === 201, 'Valid HM self-attendance returns 201 Created');
assert(mockRes3.body.attendanceRecord.isHmSelfRecord === true, 'HM self-attendance is tagged isHmSelfRecord = true');
assert(mockRes3.body.attendanceRecord.approvalStatus === STAFF_ATTENDANCE_STATUS.APPROVED, 'HM self-attendance is immediately APPROVED');

// 8d. Duplicate HM self-attendance returns 409 Conflict
StaffAttendanceRecord.findOne = () => ({
  lean: async () => ({ _id: '65d1a1b2c3d4e5f600000099', approvalStatus: STAFF_ATTENDANCE_STATUS.APPROVED }),
});
const mockRes4 = createMockResponse();
await handleHmSelfAttendance(validHmReq, mockRes4);
assert(mockRes4.statusCode === 409, 'Duplicate HM self-attendance on same day returns 409 Conflict');

StaffAttendanceRecord.findOne = origFindOne;
StaffAttendanceRecord.create = origCreate;
AuditLog.create = origAuditCreate;

// ─── 9. RBAC & Permissions Integrity ────────────────────────────────────────
console.log('\n--- 9. RBAC & Permissions Integrity ---');

// Teacher permissions
const teacherPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.TEACHER];
assert(teacherPerms.includes(PERMISSIONS.LEAVE_VIEW), 'Teacher has LEAVE_VIEW');
assert(teacherPerms.includes(PERMISSIONS.LEAVE_SUBMIT), 'Teacher has LEAVE_SUBMIT');
assert(teacherPerms.includes(PERMISSIONS.STAFF_ATTENDANCE_SUBMIT), 'Teacher has STAFF_ATTENDANCE_SUBMIT');
assert(!teacherPerms.includes(PERMISSIONS.LEAVE_APPROVE_CL), 'Teacher DOES NOT have LEAVE_APPROVE_CL');
assert(!teacherPerms.includes(PERMISSIONS.LEAVE_APPROVE_EL), 'Teacher DOES NOT have LEAVE_APPROVE_EL');

// HM permissions
const hmPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.HM];
assert(hmPerms.includes(PERMISSIONS.LEAVE_VIEW), 'HM has LEAVE_VIEW');
assert(hmPerms.includes(PERMISSIONS.LEAVE_SUBMIT), 'HM has LEAVE_SUBMIT');
assert(hmPerms.includes(PERMISSIONS.LEAVE_APPROVE_CL), 'HM has LEAVE_APPROVE_CL');
assert(hmPerms.includes(PERMISSIONS.LEAVE_INITIATE_HM), 'HM has LEAVE_INITIATE_HM');
assert(hmPerms.includes(PERMISSIONS.STAFF_ATTENDANCE_SUBMIT), 'HM has STAFF_ATTENDANCE_SUBMIT');
assert(hmPerms.includes(PERMISSIONS.STAFF_ATTENDANCE_APPROVE), 'HM has STAFF_ATTENDANCE_APPROVE');
assert(!hmPerms.includes(PERMISSIONS.LEAVE_APPROVE_EL), 'HM DOES NOT have LEAVE_APPROVE_EL (EL restricted to Admin+)');

// Supervisor permissions
const supPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.SUPERVISOR];
assert(supPerms.includes(PERMISSIONS.LEAVE_VIEW), 'Supervisor has LEAVE_VIEW');
assert(supPerms.includes(PERMISSIONS.LEAVE_APPROVE_CL), 'Supervisor has LEAVE_APPROVE_CL');
assert(!supPerms.includes(PERMISSIONS.LEAVE_APPROVE_EL), 'Supervisor DOES NOT have LEAVE_APPROVE_EL');

// Admin permissions
const adminPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.ADMIN];
assert(adminPerms.includes(PERMISSIONS.LEAVE_VIEW), 'Admin has LEAVE_VIEW');
assert(adminPerms.includes(PERMISSIONS.LEAVE_APPROVE_CL), 'Admin has LEAVE_APPROVE_CL');
assert(adminPerms.includes(PERMISSIONS.LEAVE_APPROVE_EL), 'Admin has LEAVE_APPROVE_EL');
assert(adminPerms.includes(PERMISSIONS.STAFF_ATTENDANCE_APPROVE), 'Admin has STAFF_ATTENDANCE_APPROVE');

// ─── 10. Approval Delays at 4:59, 5:00, and 5:01 (Server Timestamps) ─────────
console.log('\n--- 10. Staff Attendance Approval Delay Boundary Tests (4:59, 5:00, 5:01) ---');

// Mock AuditLog.create for all subsequent unit tests in this standalone suite
AuditLog.create = async (doc) => ({ _id: 'mock_audit_log_id', ...doc });

const origFindById = StaffAttendanceRecord.findById;
const teacherUserId = '65d1a1b2c3d4e5f600000033';
const recordId1 = '65d1a1b2c3d4e5f600000055';

const buildMockAttendanceDoc = (delayMs, customFields = {}) => ({
  _id: recordId1,
  schoolId: schoolAId,
  townId: '65d1a1b2c3d4e5f600000010',
  staffUserId: {
    _id: teacherUserId,
    fullName: 'Teacher Ali',
    role: ROLES.TEACHER,
    staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
    schoolId: schoolAId,
  },
  staffRole: ROLES.TEACHER,
  staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
  approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
  submittedAt: new Date(Date.now() - delayMs),
  save: async function () { return this; },
  toObject: function () { return { ...this }; },
  ...customFields,
});

const hmAUser = {
  _id: '65d1a1b2c3d4e5f600000044',
  role: ROLES.HM,
  fullName: 'HM Aslam',
  schoolId: schoolAId,
};

// 10a. Exactly 4:59 (299,000 ms) delay — no reason required
StaffAttendanceRecord.findById = () => ({
  populate: () => buildMockAttendanceDoc(299000),
});
const mockResDelay459 = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: {} },
  mockResDelay459
);
assert(mockResDelay459.statusCode === 200, '4:59 delay (299,000 ms) approves successfully without reason (200 OK)');
assert(mockResDelay459.body.attendanceRecord.isLateApproval === false, '4:59 delay is marked isLateApproval = false');

// 10b. Exactly 5:00 (300,000 ms) delay — no reason required (window is > 300,000 ms)
StaffAttendanceRecord.findById = () => ({
  populate: () => buildMockAttendanceDoc(300000),
});
const mockResDelay500 = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: {} },
  mockResDelay500
);
assert(mockResDelay500.statusCode === 200, 'Exactly 5:00 delay (300,000 ms) approves successfully without reason (200 OK)');
assert(mockResDelay500.body.attendanceRecord.isLateApproval === false, 'Exactly 5:00 delay is marked isLateApproval = false');

// 10c. Exactly 5:01 (301,000 ms) delay WITHOUT reason — must fail closed (400 Bad Request)
StaffAttendanceRecord.findById = () => ({
  populate: () => buildMockAttendanceDoc(301000),
});
const mockResDelay501NoReason = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: {} },
  mockResDelay501NoReason
);
assert(mockResDelay501NoReason.statusCode === 400, '5:01 delay (301,000 ms) without reason fails closed with 400 Bad Request');
assert(mockResDelay501NoReason.body.requiresReason === true, '5:01 rejection requiresReason flag is true');
assert(mockResDelay501NoReason.body.message.includes('free-text explanation (min 5 characters) is mandatory'), '400 message enforces free-text explanation');

// 10d. Exactly 5:01 (301,000 ms) delay with reason < 5 chars — must fail closed (400 Bad Request)
const mockResDelay501Short = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: { lateApprovalReason: 'Late' } },
  mockResDelay501Short
);
assert(mockResDelay501Short.statusCode === 400, '5:01 delay with reason under 5 characters fails closed with 400 Bad Request');

// 10e. Exactly 5:01 (301,000 ms) delay with valid reason — must succeed (200 OK)
const mockResDelay501Valid = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: { lateApprovalReason: 'Network connection at school office restored late' } },
  mockResDelay501Valid
);
assert(mockResDelay501Valid.statusCode === 200, '5:01 delay with valid reason approves successfully (200 OK)');
assert(mockResDelay501Valid.body.attendanceRecord.isLateApproval === true, '5:01 delay is recorded as isLateApproval = true');

// ─── 11. Role Matrix & Scope Boundary Enforcement ────────────────────────────
console.log('\n--- 11. Role Matrix & Scope Boundary Enforcement (Controller Enforced) ---');

// 11a. School staff -> authorized HM of same school
StaffAttendanceRecord.findById = () => ({
  populate: () => buildMockAttendanceDoc(60000),
});
const mockResSameHm = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: {} },
  mockResSameHm
);
assert(mockResSameHm.statusCode === 200, 'HM of same school is authorized to approve staff attendance');

// 11b. Cross-school IDOR/BOLA attempt: HM of School B tries to approve School A staff
const hmBUser = {
  _id: '65d1a1b2c3d4e5f600000045',
  role: ROLES.HM,
  fullName: 'HM School B',
  schoolId: schoolBId,
};
const mockResCrossHm = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmBUser, params: { id: recordId1 }, body: {} },
  mockResCrossHm
);
assert(mockResCrossHm.statusCode === 403, 'HM of different school is blocked with 403 Forbidden (cross-school BOLA blocked)');

// 11c. Self-approval attempt: Staff member tries to approve their own attendance
const teacherActor = {
  _id: teacherUserId,
  role: ROLES.TEACHER,
  fullName: 'Teacher Ali',
  schoolId: schoolAId,
};
const mockResSelfApprove = createMockResponse();
await handleApproveStaffAttendance(
  { user: teacherActor, params: { id: recordId1 }, body: {} },
  mockResSelfApprove
);
assert(mockResSelfApprove.statusCode === 403, 'Self-approval of staff attendance is rejected with 403 Forbidden');
assert(mockResSelfApprove.body.message.includes('Self-approval of staff attendance is prohibited'), 'Self-approval returns explicit prohibition message');

// 11d. Office staff attendance -> HM blocked, Admin authorized
const officeStaffRecord = buildMockAttendanceDoc(60000, {
  staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
  staffRole: ROLES.CLERK,
  staffUserId: {
    _id: '65d1a1b2c3d4e5f600000036',
    fullName: 'Clerk Farhan',
    role: ROLES.CLERK,
    staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
  },
});
StaffAttendanceRecord.findById = () => ({
  populate: () => officeStaffRecord,
});
const mockResOfficeHm = createMockResponse();
await handleApproveStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: {} },
  mockResOfficeHm
);
assert(mockResOfficeHm.statusCode === 403, 'HM cannot approve office staff attendance (403 Forbidden)');

const adminUser = {
  _id: '65d1a1b2c3d4e5f600000021',
  role: ROLES.ADMIN,
  fullName: 'Admin Liaquatabad',
};
const mockResOfficeAdmin = createMockResponse();
await handleApproveStaffAttendance(
  { user: adminUser, params: { id: recordId1 }, body: {} },
  mockResOfficeAdmin
);
assert(mockResOfficeAdmin.statusCode === 200, 'Admin can approve office staff attendance (200 OK)');

// 11e. Admin attendance -> Admin peer blocked, Super Admin / Root Admin authorized
const adminStaffRecord = buildMockAttendanceDoc(60000, {
  staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
  staffRole: ROLES.ADMIN,
  staffUserId: {
    _id: '65d1a1b2c3d4e5f600000022',
    fullName: 'Admin Tariq',
    role: ROLES.ADMIN,
    staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
  },
});
StaffAttendanceRecord.findById = () => ({
  populate: () => adminStaffRecord,
});
const mockResAdminPeer = createMockResponse();
await handleApproveStaffAttendance(
  { user: adminUser, params: { id: recordId1 }, body: {} },
  mockResAdminPeer
);
assert(mockResAdminPeer.statusCode === 403, 'Admin cannot approve another Admin attendance (403 Forbidden)');

const superAdminUser = {
  _id: '65d1a1b2c3d4e5f600000011',
  role: ROLES.SUPER_ADMIN,
  fullName: 'Super Admin Directorate',
};
const mockResSuperAdmin = createMockResponse();
await handleApproveStaffAttendance(
  { user: superAdminUser, params: { id: recordId1 }, body: {} },
  mockResSuperAdmin
);
assert(mockResSuperAdmin.statusCode === 200, 'Super Admin CAN approve Admin attendance (200 OK)');

// 11f. Rejection reason mandatory invariant
const mockResRejectNoReason = createMockResponse();
await handleRejectStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: { rejectionReason: '' } },
  mockResRejectNoReason
);
assert(mockResRejectNoReason.statusCode === 400, 'Rejection without reason returns 400 Bad Request');

const mockResRejectShort = createMockResponse();
await handleRejectStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: { rejectionReason: 'No' } },
  mockResRejectShort
);
assert(mockResRejectShort.statusCode === 400, 'Rejection with reason under 5 characters returns 400 Bad Request');

StaffAttendanceRecord.findById = () => ({
  _id: recordId1,
  approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
  staffUserId: teacherUserId,
  staffRole: ROLES.TEACHER,
  staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
  schoolId: schoolAId,
  save: async function () { return this; },
  toObject: function () { return { ...this }; },
});
const mockResRejectValid = createMockResponse();
await handleRejectStaffAttendance(
  { user: hmAUser, params: { id: recordId1 }, body: { rejectionReason: 'Teacher was not present at school today' } },
  mockResRejectValid
);
assert(mockResRejectValid.statusCode === 200, 'Rejection with valid reason succeeds (200 OK)');

StaffAttendanceRecord.findById = origFindById;

// ─── 12. Pending Staff Attendance Controller & UI Badge Alignment ────────────
console.log('\n--- 12. Pending Staff Attendance Controller & UI Badge Alignment ---');

const origFind = StaffAttendanceRecord.find;
const origCountDocs = StaffAttendanceRecord.countDocuments;

StaffAttendanceRecord.find = () => ({
  populate: () => ({
    sort: () => ({
      skip: () => ({
        limit: () => ({
          lean: async () => [
            {
              _id: 'rec_within',
              submittedAt: new Date(Date.now() - 120000), // 2 mins ago
              staffUserId: { fullName: 'Teacher 1' },
            },
            {
              _id: 'rec_late',
              submittedAt: new Date(Date.now() - 420000), // 7 mins ago
              staffUserId: { fullName: 'Teacher 2' },
            },
          ],
        }),
      }),
    }),
  }),
});
StaffAttendanceRecord.countDocuments = async () => 2;

const mockResPending = createMockResponse();
await handleGetPendingStaffAttendance(
  { user: hmAUser, query: {} },
  mockResPending
);
assert(mockResPending.statusCode === 200, 'Pending staff attendance endpoint returns 200 OK');
assert(mockResPending.body.records.length === 2, 'Pending endpoint returns 2 records');
assert(mockResPending.body.records[0].lateApprovalReasonRequired === false, 'Record within 5 min has lateApprovalReasonRequired = false (aligns with Green badge)');
assert(mockResPending.body.records[1].lateApprovalReasonRequired === true, 'Record exceeding 5 min has lateApprovalReasonRequired = true (aligns with Amber badge)');

StaffAttendanceRecord.find = origFind;
StaffAttendanceRecord.countDocuments = origCountDocs;

// ─── 13. Midnight Rollover State Machine & Provenance Retention ──────────────
console.log('\n--- 13. Midnight Rollover State Machine & Provenance Retention ---');

const origLeaveFind = LeaveRequest.find;
const origLeaveFindByIdAndUpdate = LeaveRequest.findByIdAndUpdate;
const origStaffFindOneAndUpdate = StaffAttendanceRecord.findOneAndUpdate;

let supersededLeaveCall = null;
let upsertedAttendanceCall = null;
let midnightAuditCall = null;

const fakeYesterdayHmCl = {
  _id: '65d1a1b2c3d4e5f600000088',
  staffUserId: '65d1a1b2c3d4e5f600000044', // HM Aslam
  staffRole: ROLES.HM,
  schoolId: schoolAId,
  townId: '65d1a1b2c3d4e5f600000010',
  leaveType: LEAVE_TYPE.CASUAL_LEAVE,
  status: LEAVE_STATUS.PENDING,
  startDate: parsePktDateString('2026-10-13'),
  durationDays: 1,
  submittedAt: new Date(Date.now() - 86400000),
};

LeaveRequest.find = () => ({
  lean: async () => [fakeYesterdayHmCl],
});

LeaveRequest.findByIdAndUpdate = async (id, update) => {
  supersededLeaveCall = { id, update };
  return { _id: id, ...update.$set };
};

StaffAttendanceRecord.findOneAndUpdate = async (filter, update, opts) => {
  upsertedAttendanceCall = { filter, update, opts };
  return { ...filter, ...update.$set };
};

AuditLog.create = async (doc) => {
  midnightAuditCall = doc;
  return { _id: 'audit_rollover_1', ...doc };
};

const rolloverSummary = await processMidnightHmClTransition();
assert(rolloverSummary.processed === 1, 'processMidnightHmClTransition processed 1 unapproved HM CL');
assert(supersededLeaveCall.update.$set.status === LEAVE_STATUS.SUPERSEDED, 'LeaveRequest status transitioned to SUPERSEDED');
assert(supersededLeaveCall.update.$set.decisionReason.includes('Auto-superseded at midnight PKT'), 'LeaveRequest contains explicit rollover reason');
assert(upsertedAttendanceCall.update.$set.approvalStatus === STAFF_ATTENDANCE_STATUS.REJECTED, 'StaffAttendanceRecord transitioned to REJECTED (Absent)');
assert(upsertedAttendanceCall.update.$set.rejectionReason.includes('Auto-defaulted to ABSENT at midnight PKT'), 'StaffAttendanceRecord retains explicit Absent reason');
assert(midnightAuditCall.action === 'HM_CL_MIDNIGHT_SUPERSEDED_ABSENT', 'AuditLog emitted with HM_CL_MIDNIGHT_SUPERSEDED_ABSENT');
assert(midnightAuditCall.newState.attendanceResult === 'ABSENT', 'AuditLog records attendanceResult = ABSENT');

// Verify that normal handleApproveLeaveRequest REJECTS a SUPERSEDED request (fails closed)
const origLeaveFindById = LeaveRequest.findById;
LeaveRequest.findById = () => ({
  _id: fakeYesterdayHmCl._id,
  status: LEAVE_STATUS.SUPERSEDED,
  leaveType: LEAVE_TYPE.CASUAL_LEAVE,
  staffUserId: fakeYesterdayHmCl.staffUserId,
  schoolId: schoolAId,
});
const mockResNormalApproveSup = createMockResponse();
await handleApproveLeaveRequest(
  { user: adminUser, params: { id: fakeYesterdayHmCl._id }, body: {} },
  mockResNormalApproveSup
);
assert(mockResNormalApproveSup.statusCode === 409, 'Standard approve endpoint blocks SUPERSEDED request with 409 Conflict');

LeaveRequest.find = origLeaveFind;
LeaveRequest.findByIdAndUpdate = origLeaveFindByIdAndUpdate;
StaffAttendanceRecord.findOneAndUpdate = origStaffFindOneAndUpdate;

// ─── 14. Late Correction Lifecycle (handleLateCorrectionLeaveRequest) ────────
console.log('\n--- 14. Late Correction Lifecycle & History Preservation ---');

const supersededHmLeaveDoc = {
  _id: '65d1a1b2c3d4e5f600000088',
  schoolId: schoolAId,
  townId: '65d1a1b2c3d4e5f600000010',
  staffUserId: '65d1a1b2c3d4e5f600000044', // HM Aslam
  staffRole: ROLES.HM,
  leaveType: LEAVE_TYPE.CASUAL_LEAVE,
  startDate: parsePktDateString('2026-10-13'),
  endDate: parsePktDateString('2026-10-13'),
  startDatePkt: '2026-10-13',
  durationDays: 1,
  leaveYear: 2026,
  status: LEAVE_STATUS.SUPERSEDED,
  decisionReason: 'Auto-superseded at midnight PKT: CL not approved before date rollover.',
  correctionHistory: [],
  save: async function () { return this; },
  toObject: function () { return { ...this }; },
};

const linkedAbsentAttendanceDoc = {
  _id: '65d1a1b2c3d4e5f600000099',
  staffUserId: '65d1a1b2c3d4e5f600000044',
  attendanceDate: parsePktDateString('2026-10-13'),
  approvalStatus: STAFF_ATTENDANCE_STATUS.REJECTED,
  rejectionReason: 'Auto-defaulted to ABSENT at midnight PKT: Casual Leave was not approved by Supervisor/Admin before date rollover.',
  lateApprovalReason: null,
  save: async function () { return this; },
};

LeaveRequest.findById = () => supersededHmLeaveDoc;
StaffAttendanceRecord.findOne = () => linkedAbsentAttendanceDoc;
LeaveRequest.find = () => ({
  select: () => ({
    lean: async () => [],
  }),
});

// 14a. Self-correction attempt by HM -> rejected (403 Forbidden)
const mockResHmSelfCorrect = createMockResponse();
await handleLateCorrectionLeaveRequest(
  { user: hmAUser, params: { id: supersededHmLeaveDoc._id }, body: { correctionReason: 'HM correcting self' } },
  mockResHmSelfCorrect
);
assert(mockResHmSelfCorrect.statusCode === 403, 'HM self-correction attempt is blocked with 403 Forbidden');

// 14b. Unassigned Supervisor attempt -> rejected (403 Forbidden)
const supervisorBUser = {
  _id: '65d1a1b2c3d4e5f600000078',
  role: ROLES.SUPERVISOR,
  assignedSchools: [schoolBId],
  fullName: 'Supervisor Cluster B',
};
const mockResSupBCorrect = createMockResponse();
await handleLateCorrectionLeaveRequest(
  { user: supervisorBUser, params: { id: supersededHmLeaveDoc._id }, body: { correctionReason: 'Late correction attempt' } },
  mockResSupBCorrect
);
assert(mockResSupBCorrect.statusCode === 403, 'Unassigned Supervisor is blocked with 403 Forbidden');

// 14c. Missing or short correction reason (< 5 characters) -> 400 Bad Request
const supervisorAUser = {
  _id: '65d1a1b2c3d4e5f600000079',
  role: ROLES.SUPERVISOR,
  assignedSchools: [schoolAId],
  fullName: 'Supervisor Cluster A',
};
const mockResShortReason = createMockResponse();
await handleLateCorrectionLeaveRequest(
  { user: supervisorAUser, params: { id: supersededHmLeaveDoc._id }, body: { correctionReason: 'Fix' } },
  mockResShortReason
);
assert(mockResShortReason.statusCode === 400, 'Correction reason under 5 characters fails with 400 Bad Request');

// 14d. Valid late correction by assigned Supervisor
let correctionAuditDoc = null;
AuditLog.create = async (doc) => {
  correctionAuditDoc = doc;
  return { _id: 'audit_corr_1', ...doc };
};

const mockResValidCorrection = createMockResponse();
await handleLateCorrectionLeaveRequest(
  {
    user: supervisorAUser,
    params: { id: supersededHmLeaveDoc._id },
    body: { correctionReason: 'Hardcopy leave application verified and approved by Town Office.' },
  },
  mockResValidCorrection
);
assert(mockResValidCorrection.statusCode === 200, 'Valid late correction executes successfully (200 OK)');
assert(supersededHmLeaveDoc.status === LEAVE_STATUS.APPROVED, 'LeaveRequest status updated to APPROVED');
assert(supersededHmLeaveDoc.correctionHistory.length === 1, 'correctionHistory contains 1 historical entry');
assert(supersededHmLeaveDoc.correctionHistory[0].previousStatus === LEAVE_STATUS.SUPERSEDED, 'correctionHistory preserves previousStatus = SUPERSEDED');
assert(supersededHmLeaveDoc.correctionHistory[0].newStatus === LEAVE_STATUS.APPROVED, 'correctionHistory records newStatus = APPROVED');
assert(supersededHmLeaveDoc.correctionHistory[0].correctionReason.includes('Hardcopy leave application verified'), 'correctionHistory preserves exact correction reason');

// 14e. Verify linked StaffAttendanceRecord is updated without silently erasing the original Absent event
assert(linkedAbsentAttendanceDoc.approvalStatus === STAFF_ATTENDANCE_STATUS.APPROVED, 'Linked StaffAttendanceRecord status updated to APPROVED');
assert(linkedAbsentAttendanceDoc.lateApprovalReason.includes('Auto-defaulted to ABSENT at midnight PKT'), 'Linked attendance record preserves original Absent reason in lateApprovalReason');
assert(linkedAbsentAttendanceDoc.lateApprovalReason.includes('Hardcopy leave application verified'), 'Linked attendance record preserves late correction reason');

// 14f. Audit log emitted with action LEAVE_REQUEST_LATE_CORRECTION
assert(correctionAuditDoc.action === 'LEAVE_REQUEST_LATE_CORRECTION', 'AuditLog emitted with LEAVE_REQUEST_LATE_CORRECTION');
assert(correctionAuditDoc.previousState.status === LEAVE_STATUS.SUPERSEDED, 'AuditLog records previousState.status = SUPERSEDED');
assert(correctionAuditDoc.newState.status === LEAVE_STATUS.APPROVED, 'AuditLog records newState.status = APPROVED');

// 14g. Attempting correction on already APPROVED request fails with 409 Conflict
const mockResAlreadyApproved = createMockResponse();
await handleLateCorrectionLeaveRequest(
  {
    user: supervisorAUser,
    params: { id: supersededHmLeaveDoc._id },
    body: { correctionReason: 'Trying again on already approved leave' },
  },
  mockResAlreadyApproved
);
assert(mockResAlreadyApproved.statusCode === 409, 'Attempting late correction on already approved request returns 409 Conflict');

LeaveRequest.findById = origLeaveFindById;
StaffAttendanceRecord.findOne = origFindOne;

console.log('\n==============================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED CLEANLY! ZERO FAILURES!`);
console.log('==============================================================================\n');
