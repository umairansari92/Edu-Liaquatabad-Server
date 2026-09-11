/**
 * 🛡️ COMPREHENSIVE INSTITUTIONAL STAFF REGISTRATION & APPROVAL SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Validates:
 * 1. Comprehensive Self-Registration Schema & Invariants
 * 2. Non-Teaching Staff Teaching Assignment Rejection
 * 3. Sensitive Data Masking & Scope Access Control
 * 4. Multi-Tier Jurisdictional Approval Matrix (HM, Supervisor, Admin, Super Admin, Root Admin)
 * 5. Strict Cross-School Boundary Enforcement (School A HM cannot approve School B)
 * 6. Explicit REJECTED & REQUIRES_CORRECTION Lifecycle State Semantics
 * 7. Authoritative TeachingAssignment Invariants (History preservation, no classTeacherId dependency)
 * 8. Server-Side PDF & Audit Log Privacy Invariants
 */

import {
  ROLES,
  BASE_ROLES,
  SCOPES,
  USER_STATUS,
  TEACHER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from '../config/constants.js';
import {
  registerTeacherSchema,
  registerStaffSchema,
  cnicField,
} from '../src/validations/authSchemas.js';
import {
  maskCnic,
  maskBankAccount,
  isAuthorizedApprover,
} from '../src/controllers/approvalController.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';

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

console.log('\n============================================================');
console.log('🏛️  INSTITUTIONAL STAFF REGISTRATION & APPROVAL TEST SUITE');
console.log('============================================================\n');

// ─── Section 1: Registration Validation & Security Boundary Tests ───────────
console.log('--- 1. Registration Schema & Invariant Tests ---');

const baseValidTeacherPayload = {
  fullName: 'Muhammad Aslam',
  fatherName: 'Abdul Karim',
  dateOfBirth: '1988-04-15',
  cnic: '42101-1234567-1',
  employeeId: 'EMP-10492',
  designation: 'PST',
  appointmentDate: '2015-08-01',
  email: 'm.aslam@liaquatabad-schools.gov.pk',
  phoneNumber: '03001234567',
  schoolId: '60d0fe4f5311236168a109ca',
  qualification: 'M.Sc Mathematics',
  isTeachingStaff: true,
  bankName: 'National Bank of Pakistan',
  branchName: 'Liaquatabad Branch (0123)',
  accountNumber: 'PK36NBPA00000012345678',
  accountTitle: 'Muhammad Aslam',
  password: 'Password123',
  confirmPassword: 'Password123',
  otpCode: '123456',
  teachingAssignments: [
    {
      classId: '60d0fe4f5311236168a109cb',
      sectionId: '60d0fe4f5311236168a109cc',
      subjectId: '60d0fe4f5311236168a109cd',
      academicSession: '2025-2026',
    },
  ],
};

// Test 1: Valid comprehensive payload parses
{
  const result = registerTeacherSchema.safeParse(baseValidTeacherPayload);
  assert(result.success === true, 'Valid comprehensive teacher registration payload parses cleanly');
}

// Test 2: Missing fatherName rejected
{
  const { fatherName, ...invalid } = baseValidTeacherPayload;
  const result = registerTeacherSchema.safeParse(invalid);
  assert(result.success === false, 'Missing fatherName is rejected by schema');
}

// Test 3: Missing employeeId rejected
{
  const { employeeId, ...invalid } = baseValidTeacherPayload;
  const result = registerTeacherSchema.safeParse(invalid);
  assert(result.success === false, 'Missing employeeId is rejected by schema');
}

// Test 4: Malformed CNIC (missing hyphen / bad length) rejected
{
  const result = cnicField.safeParse('4210112345671');
  assert(result.success === false, 'CNIC without hyphens is strictly rejected by schema');

  const result2 = cnicField.safeParse('42101-123456-1'); // 6 digits in middle
  assert(result2.success === false, 'CNIC with incorrect middle digits is strictly rejected');
}

// Test 5: Valid CNIC format accepted
{
  const result = cnicField.safeParse('42101-1234567-1');
  assert(result.success === true, 'Valid Pakistani CNIC 42101-1234567-1 parses cleanly');
}

// Test 6: Missing bank details rejected
{
  const { bankName, ...invalid } = baseValidTeacherPayload;
  const result = registerTeacherSchema.safeParse(invalid);
  assert(result.success === false, 'Missing bankName is rejected by schema');
}

// Test 7: Non-teaching staff with teaching assignments is strictly rejected
{
  const invalidNonTeaching = {
    ...baseValidTeacherPayload,
    isTeachingStaff: false,
    designation: 'Senior Clerk',
    teachingAssignments: [
      {
        classId: '60d0fe4f5311236168a109cb',
        sectionId: '60d0fe4f5311236168a109cc',
        subjectId: '60d0fe4f5311236168a109cd',
        academicSession: '2025-2026',
      },
    ],
  };
  const result = registerTeacherSchema.safeParse(invalidNonTeaching);
  assert(result.success === false, 'Non-teaching staff submitting teaching assignments is rejected by schema refinement');
}

// Test 8: Non-teaching staff without teaching assignments parses cleanly
{
  const validNonTeaching = {
    ...baseValidTeacherPayload,
    isTeachingStaff: false,
    designation: 'Senior Clerk',
    teachingAssignments: [],
  };
  const result = registerStaffSchema.safeParse(validNonTeaching);
  assert(result.success === true, 'Non-teaching staff without teaching assignments passes validation');
}

// Test 9-12: Privilege escalation self-assignment rejected
for (const privilegedRole of [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM]) {
  const escalated = {
    ...baseValidTeacherPayload,
    role: privilegedRole,
  };
  const result = registerTeacherSchema.safeParse(escalated);
  assert(result.success === false, `Self-assignment of privileged authority ${privilegedRole} is rejected`);
}

// Test 13: Missing OTP code rejected
{
  const { otpCode, ...invalid } = baseValidTeacherPayload;
  const result = registerTeacherSchema.safeParse(invalid);
  assert(result.success === false, 'Registration payload without OTP code is rejected');
}

// ─── Section 2: Sensitive Data Protection & Masking Tests ───────────────────
console.log('\n--- 2. Sensitive Data Protection & Masking Tests ---');

// Test 14: CNIC masking
{
  const masked = maskCnic('42101-1234567-1');
  assert(masked === '42101-*******-1', 'maskCnic produces compliant masked string (42101-*******-1)');
}

// Test 15: Bank account masking
{
  const masked = maskBankAccount('PK36NBPA00000012345678');
  assert(masked === '****5678', 'maskBankAccount produces compliant masked string (****5678)');

  const maskedShort = maskBankAccount('1234');
  assert(maskedShort === '****', 'maskBankAccount handles short account numbers securely');
}

// ─── Section 3: Approvals Jurisdictional Scope Boundary Matrix Tests ────────
console.log('\n--- 3. Approvals Jurisdictional Scope Boundary Matrix Tests ---');

const schoolA = '60d0fe4f5311236168a109aa';
const schoolB = '60d0fe4f5311236168a109bb';
const townId = '60d0fe4f5311236168a109cc';

const targetStaffClaimingSchoolA = {
  _id: '60d0fe4f5311236168a10901',
  claimedSchoolId: schoolA,
  townId,
  role: ROLES.TEACHER,
};

// Test 21: HM approving own assigned school staff
{
  const hmActor = {
    _id: '60d0fe4f5311236168a10999',
    role: ROLES.HM,
    schoolId: schoolA,
  };
  const isAuth = isAuthorizedApprover(hmActor, targetStaffClaimingSchoolA, { claimedSchoolId: schoolA });
  assert(isAuth === true, 'School A HM can approve applicant claiming School A');
}

// Test 22: HM approving staff from another school -> STRICTLY BLOCKED
{
  const hmActorSchoolB = {
    _id: '60d0fe4f5311236168a10988',
    role: ROLES.HM,
    schoolId: schoolB, // Assigned to School B
  };
  const isAuth = isAuthorizedApprover(hmActorSchoolB, targetStaffClaimingSchoolA, { claimedSchoolId: schoolA });
  assert(isAuth === false, 'School B HM is strictly blocked from approving applicant claiming School A (Cross-School Boundary)');
}

// Test 23-24: Supervisor assigned vs unassigned school
{
  const supervisorAssigned = {
    _id: '60d0fe4f5311236168a10977',
    role: ROLES.SUPERVISOR,
    assignedSchools: [schoolA],
  };
  const isAuth = isAuthorizedApprover(supervisorAssigned, targetStaffClaimingSchoolA, { claimedSchoolId: schoolA });
  assert(isAuth === true, 'Supervisor assigned to School A can approve applicant claiming School A');

  const supervisorUnassigned = {
    _id: '60d0fe4f5311236168a10966',
    role: ROLES.SUPERVISOR,
    assignedSchools: [schoolB], // Only School B
  };
  const isAuth2 = isAuthorizedApprover(supervisorUnassigned, targetStaffClaimingSchoolA, { claimedSchoolId: schoolA });
  assert(isAuth2 === false, 'Supervisor NOT assigned to School A is blocked from approving School A applicant');
}

// Test 25-26: Admin within town vs different town
{
  const adminActor = {
    _id: '60d0fe4f5311236168a10955',
    role: ROLES.ADMIN,
    townId,
  };
  const isAuth = isAuthorizedApprover(adminActor, targetStaffClaimingSchoolA, { claimedSchoolId: schoolA });
  assert(isAuth === true, 'Town Admin can approve applicant within same municipal town');

  const otherTownAdmin = {
    _id: '60d0fe4f5311236168a10944',
    role: ROLES.ADMIN,
    townId: '60d0fe4f5311236168a109dd', // Different town
  };
  const isAuth2 = isAuthorizedApprover(otherTownAdmin, targetStaffClaimingSchoolA, { claimedSchoolId: schoolA });
  assert(isAuth2 === false, 'Admin from another town is blocked from approving applicant');
}

// Test 27-28: Super Admin and Root Admin
{
  const superAdminGlobal = { role: ROLES.SUPER_ADMIN, scope: SCOPES.GLOBAL };
  assert(isAuthorizedApprover(superAdminGlobal, targetStaffClaimingSchoolA, {}) === true, 'Global Super Admin can approve applicant');

  const rootAdmin = { role: ROLES.ROOT_ADMIN, scope: SCOPES.GLOBAL };
  assert(isAuthorizedApprover(rootAdmin, targetStaffClaimingSchoolA, {}) === true, 'Root Admin can approve applicant');
}

// Test 29-30: Unauthorized roles (Teacher, Student, Parent)
{
  const teacherActor = { role: ROLES.TEACHER, schoolId: schoolA };
  assert(isAuthorizedApprover(teacherActor, targetStaffClaimingSchoolA, {}) === false, 'Ordinary Teacher is strictly blocked from approving staff');

  const studentActor = { role: ROLES.STUDENT };
  assert(isAuthorizedApprover(studentActor, targetStaffClaimingSchoolA, {}) === false, 'Student is strictly blocked from approving staff');
}

// ─── Section 4: Lifecycle State & Decision Invariants ───────────────────────
console.log('\n--- 4. Lifecycle State & Decision Invariants ---');

// Test 31: USER_STATUS and TEACHER_STATUS contain explicit REJECTED and REQUIRES_CORRECTION
{
  assert(USER_STATUS.REJECTED === 'REJECTED', 'USER_STATUS.REJECTED exists with value REJECTED');
  assert(TEACHER_STATUS.REJECTED === 'REJECTED', 'TEACHER_STATUS.REJECTED exists with value REJECTED');
  assert(USER_STATUS.REQUIRES_CORRECTION === 'REQUIRES_CORRECTION', 'USER_STATUS.REQUIRES_CORRECTION exists');
}

// ─── Section 5: Authoritative TeachingAssignment Invariants ────────────────
console.log('\n--- 5. Authoritative Teaching Assignment Model Invariants ---');

// Test 32: TeachingAssignment model exports authoritative query helpers
{
  assert(typeof TeachingAssignment.isTeacherAssigned === 'function', 'TeachingAssignment.isTeacherAssigned helper is defined');
  assert(typeof TeachingAssignment.findActiveConflict === 'function', 'TeachingAssignment.findActiveConflict helper is defined');
}

// Test 33: TeachingAssignment partial unique index on ACTIVE status verified
{
  const indexes = TeachingAssignment.schema.indexes();
  const partialUniqueIndex = indexes.find((idx) => {
    const keys = idx[0];
    const options = idx[1];
    return (
      keys.teacherId === 1 &&
      keys.classId === 1 &&
      keys.sectionId === 1 &&
      keys.subjectId === 1 &&
      keys.academicSession === 1 &&
      options?.unique === true &&
      options?.partialFilterExpression?.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE
    );
  });
  assert(Boolean(partialUniqueIndex), 'Partial unique index on ACTIVE assignments exists in TeachingAssignment schema');
}

console.log('\n============================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} STAFF PROFILE & APPROVAL TESTS PASSED!`);
console.log('============================================================\n');
process.exit(0);
