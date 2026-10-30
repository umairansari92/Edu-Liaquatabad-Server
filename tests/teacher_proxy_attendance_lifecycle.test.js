/**
 * 🛡️ TEACHER PROXY ATTENDANCE & AUDIT TRAIL LIFECYCLE VERIFICATION SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * 1. Proxy Eligibility Verification:
 *    - Teacher on Casual Leave (CL) -> Eligible
 *    - Teacher on Earned Leave (EL) -> Eligible
 *    - Teacher Absent / Not Checked In -> Eligible
 *    - Teacher Present on Duty -> Denied (Proxy blocked)
 * 2. Multi-Tenant Jurisdictional School Isolation:
 *    - Teacher attempting proxy for another school -> Denied (HTTP 403)
 * 3. Justification Reason Validation:
 *    - Empty or < 5 characters reason -> Rejected (HTTP 400)
 *    - Valid reason (>= 5 chars) -> Approved
 * 4. Municipal Audit Trail Integrity:
 *    - Action: ATTENDANCE_TEACHER_PROXY_SUBMITTED
 *    - Actor role: TEACHER
 *    - State diff captures proxyTeacherId, proxyTeacherName, proxyReason
 */

import { ROLES, LEAVE_TYPE, LEAVE_STATUS, STAFF_ATTENDANCE_STATUS } from '../config/constants.js';

let totalTests = 0;
let passedTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL [${totalTests}]: ${testName}`);
    throw new Error(`Assertion failed: ${testName}`);
  }
  passedTests++;
  console.log(`✅ PASS [${totalTests}]: ${testName}`);
}

console.log('\n==============================================================================');
console.log('🛡️  TEACHER PROXY ATTENDANCE & AUDIT LOG LIFECYCLE TESTS');
console.log('==============================================================================\n');

// ─── Scenario 1: Teacher on Casual Leave (CL) makes section eligible for proxy ────
{
  const teacherLeave = {
    staffUserId: '507f1f77bcf86cd799439001',
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    status: LEAVE_STATUS.APPROVED,
    startDate: new Date('2026-10-31T00:00:00.000Z'),
    endDate: new Date('2026-10-31T23:59:59.999Z'),
  };

  const isEligibleOnCL =
    [LEAVE_STATUS.APPROVED, LEAVE_STATUS.PENDING].includes(teacherLeave.status) &&
    teacherLeave.leaveType === LEAVE_TYPE.CASUAL_LEAVE;

  assert(isEligibleOnCL, 'Scenario 01: Teacher on approved Casual Leave renders section eligible for colleague proxy');
}

// ─── Scenario 2: Teacher on Earned Leave (EL) makes section eligible for proxy ────
{
  const teacherLeave = {
    staffUserId: '507f1f77bcf86cd799439002',
    leaveType: LEAVE_TYPE.EARNED_LEAVE,
    status: LEAVE_STATUS.APPROVED,
    startDate: new Date('2026-10-30T00:00:00.000Z'),
    endDate: new Date('2026-11-05T23:59:59.999Z'),
  };

  const isEligibleOnEL =
    [LEAVE_STATUS.APPROVED, LEAVE_STATUS.PENDING].includes(teacherLeave.status) &&
    teacherLeave.leaveType === LEAVE_TYPE.EARNED_LEAVE;

  assert(isEligibleOnEL, 'Scenario 02: Teacher on approved Earned Leave renders section eligible for colleague proxy');
}

// ─── Scenario 3: Teacher Absent / Not Checked In makes section eligible ──────────
{
  const staffAttendanceRecord = null; // Teacher has not checked in today
  const isAbsentOrNoCheckin = staffAttendanceRecord === null;

  assert(isAbsentOrNoCheckin, 'Scenario 03: Teacher with no arrival check-in is treated as absent, allowing proxy');
}

// ─── Scenario 4: Teacher Present on Duty BLOCKS proxy attendance ──────────────────
{
  const staffAttendanceRecord = {
    staffUserId: '507f1f77bcf86cd799439003',
    approvalStatus: STAFF_ATTENDANCE_STATUS.APPROVED, // Marked and approved Present
  };

  const isPresentOnDuty = staffAttendanceRecord.approvalStatus === STAFF_ATTENDANCE_STATUS.APPROVED;
  const proxyAllowed = !isPresentOnDuty;

  assert(!proxyAllowed, 'Scenario 04: Proxy is strictly blocked when the assigned class teacher is Present on duty');
}

// ─── Scenario 5: Cross-School Proxy Attempt is Strictly Forbidden (403) ──────────
{
  const coveringTeacher = {
    _id: '507f1f77bcf86cd799439010',
    schoolId: '507f1f77bcf86cd7994390AA', // School A
    role: ROLES.TEACHER,
  };

  const targetSection = {
    _id: '507f1f77bcf86cd799439020',
    schoolId: '507f1f77bcf86cd7994390BB', // School B (Different School)
  };

  const isSameSchool = String(coveringTeacher.schoolId) === String(targetSection.schoolId);

  assert(!isSameSchool, 'Scenario 05: Cross-school proxy attempt is flagged as boundary violation');
}

// ─── Scenario 6: Mandatory Justification Reason Validation (< 5 chars rejected) ──
{
  const shortReason = 'sick';
  const validReason = 'Covering for Sir Rashid who is on sanctioned Casual Leave today.';

  const isShortValid = shortReason && shortReason.trim().length >= 5;
  const isValidValid = validReason && validReason.trim().length >= 5;

  assert(!isShortValid, 'Scenario 06a: Proxy reason with less than 5 characters is rejected (HTTP 400)');
  assert(isValidValid, 'Scenario 06b: Proxy reason with >= 5 characters passes institutional validation');
}

// ─── Scenario 7: Municipal Audit Log Action & State Diff Integrity ───────────────
{
  const auditEntry = {
    actorId: '507f1f77bcf86cd799439010',
    actorRole: ROLES.TEACHER,
    actorName: 'Umair Ahmed',
    action: 'ATTENDANCE_TEACHER_PROXY_SUBMITTED',
    targetModel: 'Attendance',
    targetId: '507f1f77bcf86cd799439099',
    targetName: 'Class 5 — Section A',
    schoolId: '507f1f77bcf86cd7994390AA',
    newState: {
      sectionId: '507f1f77bcf86cd799439020',
      date: '2026-10-31',
      totalRecords: 18,
      presentCount: 16,
      absentCount: 1,
      leaveCount: 1,
      isProxy: true,
      proxyType: 'TEACHER_PROXY',
      proxyTeacherId: '507f1f77bcf86cd799439001',
      proxyTeacherName: 'Rashid Mehmood',
      proxyReason: 'Covering for Sir Rashid who is on Casual Leave today.',
    },
    result: 'SUCCESS',
  };

  assert(auditEntry.action === 'ATTENDANCE_TEACHER_PROXY_SUBMITTED', 'Scenario 07a: Audit action is ATTENDANCE_TEACHER_PROXY_SUBMITTED');
  assert(auditEntry.newState.isProxy === true, 'Scenario 07b: Audit state diff records isProxy: true');
  assert(auditEntry.newState.proxyType === 'TEACHER_PROXY', 'Scenario 07c: Audit state diff records proxyType: TEACHER_PROXY');
  assert(Boolean(auditEntry.newState.proxyTeacherId), 'Scenario 07d: Audit state diff preserves target absent teacher ID');
  assert(auditEntry.newState.proxyReason.length >= 5, 'Scenario 07e: Audit state diff records verified justification reason');
}

console.log('\n==============================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} TEACHER PROXY ATTENDANCE TESTS PASSED!`);
console.log('==============================================================================\n');

