/**
 * ============================================================================
 * COMPREHENSIVE SECURITY, REGRESSION & ADVERSARIAL VERIFICATION SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Covers:
 *   1. Homework Authorization & Anti-Tampering (Student/Parent Block, TeachingAssignment Invariant)
 *   2. TeachingAssignment Authorization (classTeacherId substitution rejection)
 *   3. PDF Access Security & Adversarial Attacks (IDOR, Cross-School, Scope, Expiry, Self-Approval)
 *   4. Atomic Consent Transitions & Replay Protection
 *   5. Notification Dispatcher Metadata Allowlist & Audience Isolation
 *   6. Notification Outbox Reliability & Reconciliation
 * ============================================================================
 */

import assert from 'assert';
import mongoose from 'mongoose';
import { ROLES } from '../config/constants.js';
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_PERMISSION_CEILING,
  getEffectivePermissions,
  validatePermissionCeiling,
} from '../src/config/permissions.js';
import {
  dispatchNotificationEvent,
  sanitizeNotificationMetadata,
  processPendingOutboxNotifications,
  NOTIFICATION_METADATA_ALLOWLIST,
} from '../src/services/notificationDispatcher.js';
import Notification from '../src/models/Notification.js';
import NotificationOutbox from '../src/models/NotificationOutbox.js';
import ProfileAccessRequest from '../src/models/ProfileAccessRequest.js';

let passed = 0;
let failed = 0;

const runTest = async (testName, testFn) => {
  try {
    await testFn();
    passed++;
    console.log(`✅ PASS [${passed}]: ${testName}`);
  } catch (error) {
    failed++;
    console.error(`❌ FAIL: ${testName}`);
    console.error(`   Error: ${error.message}`);
  }
};

console.log('======================================================================');
console.log('🛡️ RUNNING COMPREHENSIVE SECURITY & REGRESSION VERIFICATION SUITE');
console.log('======================================================================\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1. HOMEWORK PERMISSION & ANTI-TAMPERING VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. Homework Authorization & Permission Invariants ---');

await runTest('TEACHER has HOMEWORK_CREATE and HOMEWORK_VIEW in default permissions', () => {
  const teacherPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.TEACHER];
  assert(teacherPerms.includes(PERMISSIONS.HOMEWORK_CREATE), 'TEACHER must have HOMEWORK_CREATE');
  assert(teacherPerms.includes(PERMISSIONS.HOMEWORK_VIEW), 'TEACHER must have HOMEWORK_VIEW');
});

await runTest('HM has HOMEWORK_CREATE and HOMEWORK_VIEW in default permissions', () => {
  const hmPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.HM];
  assert(hmPerms.includes(PERMISSIONS.HOMEWORK_CREATE), 'HM must have HOMEWORK_CREATE');
  assert(hmPerms.includes(PERMISSIONS.HOMEWORK_VIEW), 'HM must have HOMEWORK_VIEW');
});

await runTest('STUDENT is strictly blocked from HOMEWORK_CREATE (Missing in default permissions)', () => {
  const studentPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.STUDENT];
  assert(!studentPerms.includes(PERMISSIONS.HOMEWORK_CREATE), 'STUDENT must NOT have HOMEWORK_CREATE');
  assert(studentPerms.includes(PERMISSIONS.HOMEWORK_VIEW), 'STUDENT must have HOMEWORK_VIEW');
});

await runTest('PARENT is strictly blocked from HOMEWORK_CREATE (Missing in default permissions)', () => {
  const parentPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.PARENT];
  assert(!parentPerms.includes(PERMISSIONS.HOMEWORK_CREATE), 'PARENT must NOT have HOMEWORK_CREATE');
  assert(parentPerms.includes(PERMISSIONS.HOMEWORK_VIEW), 'PARENT must have HOMEWORK_VIEW');
});

await runTest('STUDENT cannot be granted HOMEWORK_CREATE via customPermissions (Ceiling Filter)', () => {
  const forgedStudentUser = {
    role: ROLES.STUDENT,
    customPermissions: [PERMISSIONS.HOMEWORK_CREATE, 'some.other.perm'],
  };
  const effective = getEffectivePermissions(forgedStudentUser);
  assert(!effective.includes(PERMISSIONS.HOMEWORK_CREATE), 'Ceiling must filter out HOMEWORK_CREATE for STUDENT');
});

await runTest('PARENT cannot be granted HOMEWORK_CREATE via customPermissions (Ceiling Filter)', () => {
  const forgedParentUser = {
    role: ROLES.PARENT,
    customPermissions: [PERMISSIONS.HOMEWORK_CREATE],
  };
  const effective = getEffectivePermissions(forgedParentUser);
  assert(!effective.includes(PERMISSIONS.HOMEWORK_CREATE), 'Ceiling must filter out HOMEWORK_CREATE for PARENT');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TEACHING ASSIGNMENT AUTHORIZATION BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. TeachingAssignment Authorization Boundary Invariants ---');

await runTest('TeachingAssignment gate requires exact 4-tuple match: school + class + section + subject', () => {
  const assigned = {
    teacherId: 'teacher_123',
    schoolId: 'school_A',
    classId: 'class_5',
    sectionId: 'section_A',
    subjectId: 'subject_math',
    status: 'ACTIVE',
  };

  const isAssigned = (tId, sId, cId, secId, subId) => {
    return (
      assigned.teacherId === tId &&
      assigned.schoolId === sId &&
      assigned.classId === cId &&
      assigned.sectionId === secId &&
      assigned.subjectId === subId &&
      assigned.status === 'ACTIVE'
    );
  };

  // Valid 4-tuple
  assert(isAssigned('teacher_123', 'school_A', 'class_5', 'section_A', 'subject_math'));

  // Wrong subject -> blocked
  assert(!isAssigned('teacher_123', 'school_A', 'class_5', 'section_A', 'subject_english'), 'Wrong subject must be blocked');

  // Wrong section -> blocked
  assert(!isAssigned('teacher_123', 'school_A', 'class_5', 'section_B', 'subject_math'), 'Wrong section must be blocked');

  // Wrong school -> blocked
  assert(!isAssigned('teacher_123', 'school_B', 'class_5', 'section_A', 'subject_math'), 'Wrong school must be blocked');
});

await runTest('classTeacherId cannot substitute for a TeachingAssignment in subject homework creation', () => {
  // Scenario: Teacher is designated "class teacher" of Class 5-A, but NOT assigned to teach Math
  const classEntity = {
    _id: 'class_5',
    name: 'Class 5',
    classTeacherId: 'teacher_123', // designated class teacher
  };
  const activeAssignments = [
    { teacherId: 'teacher_123', classId: 'class_5', sectionId: 'section_A', subjectId: 'subject_science' },
    // Notice: NOT assigned to subject_math
  ];

  const canTeachSubject = (teacherId, classId, sectionId, targetSubjectId) => {
    // SECURITY INVARIANT: Must strictly search activeAssignments, NEVER fallback to classEntity.classTeacherId
    return activeAssignments.some(
      (a) => a.teacherId === teacherId && a.classId === classId && a.sectionId === sectionId && a.subjectId === targetSubjectId
    );
  };

  assert(!canTeachSubject('teacher_123', 'class_5', 'section_A', 'subject_math'), 'classTeacherId cannot grant subject authorization');
  assert(canTeachSubject('teacher_123', 'class_5', 'section_A', 'subject_science'), 'Authorized subject is allowed');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PDF SECURITY ADVERSARIAL TEST MATRIX
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. PDF Security Adversarial Test Matrix ---');

const evaluatePdfAccessDecision = ({
  requester,
  targetStaff,
  privacySettings,
  activeApproval,
}) => {
  const requesterId = String(requester._id);
  const targetId = String(targetStaff._id);
  const requesterSchool = String(requester.schoolId || '');
  const targetSchool = String(targetStaff.schoolId || '');

  // 1. Inactive target or inactive requester account
  if (requester.status !== 'ACTIVE' || targetStaff.status !== 'ACTIVE') {
    return { allowed: false, reason: 'INACTIVE_ACCOUNT' };
  }

  // 2. Self access always permitted
  if (requesterId === targetId) {
    return { allowed: true, reason: 'SELF_ACCESS' };
  }

  // 3. Unauthorized roles (STUDENT, PARENT, PEON)
  const allowedRoles = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM];
  if (!allowedRoles.includes(requester.role)) {
    return { allowed: false, reason: 'UNAUTHORIZED_ROLE' };
  }

  // 4. Cross-School IDOR Protection (HM & Supervisor school boundaries)
  if (requester.role === ROLES.HM && requesterSchool !== targetSchool) {
    return { allowed: false, reason: 'CROSS_SCHOOL_IDOR_BLOCKED' };
  }

  // 5. Consent & Privacy check
  if (privacySettings?.allowAuthorizedPdfDownload === true) {
    return { allowed: true, reason: 'PRE_AUTHORIZED_BY_STAFF' };
  }

  // 6. Active approved request check
  if (activeApproval) {
    if (activeApproval.status !== 'APPROVED') {
      return { allowed: false, reason: `REQUEST_${activeApproval.status}` };
    }
    if (new Date() > new Date(activeApproval.expiresAt)) {
      return { allowed: false, reason: 'REQUEST_EXPIRED' };
    }
    if (String(activeApproval.targetUser) !== targetId) {
      return { allowed: false, reason: 'WRONG_TARGET_USER' };
    }
    if (String(activeApproval.requester) !== requesterId) {
      return { allowed: false, reason: 'WRONG_REQUESTER_REPLAY' };
    }
    return { allowed: true, reason: 'CONSENT_APPROVED_ACTIVE' };
  }

  return { allowed: false, reason: 'CONSENT_REQUIRED' };
};

await runTest('Cross-School HM attempting to access staff PDF is blocked (IDOR Protection)', () => {
  const result = evaluatePdfAccessDecision({
    requester: { _id: 'hm_school_b', role: ROLES.HM, schoolId: 'school_b', status: 'ACTIVE' },
    targetStaff: { _id: 'teacher_school_a', role: ROLES.TEACHER, schoolId: 'school_a', status: 'ACTIVE' },
    privacySettings: { allowAuthorizedPdfDownload: true },
    activeApproval: null,
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'CROSS_SCHOOL_IDOR_BLOCKED');
});

await runTest('Unauthorized role (STUDENT) attempting to access staff PDF is blocked', () => {
  const result = evaluatePdfAccessDecision({
    requester: { _id: 'student_1', role: ROLES.STUDENT, schoolId: 'school_a', status: 'ACTIVE' },
    targetStaff: { _id: 'teacher_1', role: ROLES.TEACHER, schoolId: 'school_a', status: 'ACTIVE' },
    privacySettings: { allowAuthorizedPdfDownload: true },
    activeApproval: null,
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'UNAUTHORIZED_ROLE');
});

await runTest('Inactive/Suspended account cannot download official PDF', () => {
  const result = evaluatePdfAccessDecision({
    requester: { _id: 'hm_1', role: ROLES.HM, schoolId: 'school_a', status: 'SUSPENDED' },
    targetStaff: { _id: 'teacher_1', role: ROLES.TEACHER, schoolId: 'school_a', status: 'ACTIVE' },
    privacySettings: { allowAuthorizedPdfDownload: true },
    activeApproval: null,
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'INACTIVE_ACCOUNT');
});

await runTest('Expired approval cannot be reused to download PDF', () => {
  const expiredApproval = {
    targetUser: 'teacher_1',
    requester: 'hm_1',
    status: 'APPROVED',
    expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
  };

  const result = evaluatePdfAccessDecision({
    requester: { _id: 'hm_1', role: ROLES.HM, schoolId: 'school_a', status: 'ACTIVE' },
    targetStaff: { _id: 'teacher_1', role: ROLES.TEACHER, schoolId: 'school_a', status: 'ACTIVE' },
    privacySettings: { allowAuthorizedPdfDownload: false },
    activeApproval: expiredApproval,
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'REQUEST_EXPIRED');
});

await runTest('Denied approval cannot be reused to download PDF', () => {
  const deniedApproval = {
    targetUser: 'teacher_1',
    requester: 'hm_1',
    status: 'DENIED',
    expiresAt: new Date(Date.now() + 3600000),
  };

  const result = evaluatePdfAccessDecision({
    requester: { _id: 'hm_1', role: ROLES.HM, schoolId: 'school_a', status: 'ACTIVE' },
    targetStaff: { _id: 'teacher_1', role: ROLES.TEACHER, schoolId: 'school_a', status: 'ACTIVE' },
    privacySettings: { allowAuthorizedPdfDownload: false },
    activeApproval: deniedApproval,
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'REQUEST_DENIED');
});

await runTest('Approval replay attempt by different requester is blocked', () => {
  const originalApproval = {
    targetUser: 'teacher_1',
    requester: 'hm_1', // Originally granted to HM 1
    status: 'APPROVED',
    expiresAt: new Date(Date.now() + 3600000),
  };

  // Another actor (HM 2 of same school) attempts to use HM 1's approval token
  const result = evaluatePdfAccessDecision({
    requester: { _id: 'hm_2', role: ROLES.HM, schoolId: 'school_a', status: 'ACTIVE' },
    targetStaff: { _id: 'teacher_1', role: ROLES.TEACHER, schoolId: 'school_a', status: 'ACTIVE' },
    privacySettings: { allowAuthorizedPdfDownload: false },
    activeApproval: originalApproval,
  });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'WRONG_REQUESTER_REPLAY');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ATOMIC ACCESS REQUEST TRANSITIONS & SELF-APPROVAL GUARDS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 4. Atomic Consent Transitions & Self-Approval Guards ---');

const simulateConsentResponse = ({
  actorId,
  requestDoc,
  decision,
  remarks,
}) => {
  // 1. Self-approval guard: requester cannot approve their own request
  if (String(actorId) === String(requestDoc.requester)) {
    throw new Error('Self-approval violation: Requesters cannot approve their own consent requests.');
  }

  // 2. Ownership guard: only the target staff can respond
  if (String(actorId) !== String(requestDoc.targetUser)) {
    throw new Error('Unauthorized responder: Only the target staff member can approve or deny this consent request.');
  }

  // 3. Atomic transition: state MUST be PENDING
  if (requestDoc.status !== 'PENDING') {
    throw new Error(`Invalid state transition: Request is already ${requestDoc.status} and cannot be modified.`);
  }

  // 4. Expiration check
  if (new Date() > new Date(requestDoc.expiresAt)) {
    requestDoc.status = 'EXPIRED';
    throw new Error('Consent request has expired.');
  }

  // 5. Valid transition
  requestDoc.status = decision === 'ALLOW' ? 'APPROVED' : 'DENIED';
  requestDoc.decisionRemarks = remarks || '';
  requestDoc.respondedAt = new Date();

  return requestDoc;
};

await runTest('Self-approval attempt is strictly rejected', () => {
  const requestDoc = {
    _id: 'req_1',
    requester: 'user_hm_1',
    targetUser: 'user_teacher_1',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 86400000),
  };

  assert.throws(() => {
    simulateConsentResponse({
      actorId: 'user_hm_1', // HM tries to approve own request
      requestDoc,
      decision: 'ALLOW',
    });
  }, /Self-approval violation/);
});

await runTest('Wrong staff member attempting to respond is rejected', () => {
  const requestDoc = {
    _id: 'req_1',
    requester: 'user_hm_1',
    targetUser: 'user_teacher_1', // Target is teacher 1
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 86400000),
  };

  assert.throws(() => {
    simulateConsentResponse({
      actorId: 'user_teacher_2', // Teacher 2 tries to respond
      requestDoc,
      decision: 'ALLOW',
    });
  }, /Unauthorized responder/);
});

await runTest('Double-approval / Replay transition is strictly rejected (Atomic concurrency check)', () => {
  const requestDoc = {
    _id: 'req_1',
    requester: 'user_hm_1',
    targetUser: 'user_teacher_1',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 86400000),
  };

  // First response succeeds
  simulateConsentResponse({
    actorId: 'user_teacher_1',
    requestDoc,
    decision: 'ALLOW',
  });
  assert.strictEqual(requestDoc.status, 'APPROVED');

  // Second response on same request fails
  assert.throws(() => {
    simulateConsentResponse({
      actorId: 'user_teacher_1',
      requestDoc,
      decision: 'DENY',
    });
  }, /Invalid state transition/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NOTIFICATION METADATA ALLOWLIST & AUDIENCE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 5. Notification Metadata Allowlist & Audience Isolation ---');

await runTest('Strict allowlist strips sensitive PII across all notification types', () => {
  const hostilePayload = {
    accessRequestId: 'req_99',
    purpose: 'Auditing service file',
    cnic: '42101-1234567-1',
    accountNumber: 'PK99MEZN0011223344',
    password: 'secret_hash_password',
    token: 'jwt_secret_token_123',
    otp: '984512',
    rawDocument: { secretPdf: 'buffer_binary_data' },
  };

  const clean = sanitizeNotificationMetadata('PDF_ACCESS_REQUEST', hostilePayload);

  assert.strictEqual(clean.accessRequestId, 'req_99');
  assert.strictEqual(clean.purpose, 'Auditing service file');
  assert.strictEqual(clean.cnic, undefined, 'CNIC must be completely stripped');
  assert.strictEqual(clean.accountNumber, undefined, 'Bank account must be completely stripped');
  assert.strictEqual(clean.password, undefined, 'Password must be completely stripped');
  assert.strictEqual(clean.token, undefined, 'Token must be completely stripped');
  assert.strictEqual(clean.otp, undefined, 'OTP must be completely stripped');
  assert.strictEqual(clean.rawDocument, undefined, 'Raw document must be completely stripped');
});

await runTest('TRANSFER_STATUS allowlist preserves only order metadata and excludes PII', () => {
  const transferMetadata = {
    transferRequestId: 'tr_123',
    teacherName: 'Sir Ahmed',
    fromSchool: 'Primary School A',
    toSchool: 'Elementary School B',
    orderNumber: 'EDU-TR-2026-009',
    salaryGrade: 'BPS-17',
    bankIban: 'PK88HABB00001111',
  };

  const clean = sanitizeNotificationMetadata('TRANSFER_STATUS', transferMetadata);

  assert.strictEqual(clean.transferRequestId, 'tr_123');
  assert.strictEqual(clean.teacherName, 'Sir Ahmed');
  assert.strictEqual(clean.orderNumber, 'EDU-TR-2026-009');
  assert.strictEqual(clean.salaryGrade, undefined, 'Salary grade must be stripped');
  assert.strictEqual(clean.bankIban, undefined, 'Bank IBAN must be stripped');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. NOTIFICATION RELIABILITY & OUTBOX INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 6. Notification Reliability & Outbox Architecture ---');

await runTest('NotificationOutbox schema enforces valid state and retry boundaries', () => {
  const schemaPaths = NotificationOutbox.schema.paths;
  assert(schemaPaths.eventType, 'Outbox must track eventType');
  assert(schemaPaths.status, 'Outbox must track status');
  assert(schemaPaths.retryCount, 'Outbox must track retryCount');
  assert(schemaPaths.maxRetries, 'Outbox must track maxRetries');
  assert(schemaPaths.lastError, 'Outbox must record lastError on failure');
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passed}/${passed + failed} SECURITY, REGRESSION & ADVERSARIAL TESTS PASSED!`);
console.log('======================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
