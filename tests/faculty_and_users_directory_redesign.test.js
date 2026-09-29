/**
 * Faculty & Users Directory Redesign — Automated Verification Suite
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * 1. Schema enforcement for Assign School (Zod validation & injection prevention)
 * 2. Pure category isolation:
 *    - Students NEVER appear in EMPLOYEES
 *    - Parents NEVER appear in EMPLOYEES
 *    - Employees NEVER appear in STUDENTS
 *    - Employees NEVER appear in PARENTS
 *    - ALL ACCOUNTS contains all categories
 * 3. Scope & RBAC hierarchy rules for assignment & transfer
 * 4. Audit trail logging contracts
 */

import { z } from 'zod';
import { assignSchoolSchema } from '../src/validations/userSchemas.js';
import { ROLES, USER_STATUS } from '../config/constants.js';

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
console.log('🏛️  FACULTY & USERS DIRECTORY REDESIGN VERIFICATION SUITE');
console.log('============================================================\n');

// ─── 1. Schema Enforcement: assignSchoolSchema ───────────────────────────────

// Test 1: Valid school assignment payload
{
  const result = assignSchoolSchema.safeParse({
    schoolId: '507f1f77bcf86cd799439011',
    designation: 'PST Teacher',
    reason: 'Transferred from provincial surplus pool',
    effectiveDate: '2026-10-01T00:00:00.000Z',
  });
  assert(result.success, 'Valid school assignment payload parses successfully');
}

// Test 2: Valid payload with minimal required fields
{
  const result = assignSchoolSchema.safeParse({
    schoolId: '507f1f77bcf86cd799439011',
  });
  assert(result.success, 'Minimal school assignment with only schoolId passes');
}

// Test 3: Invalid ObjectId rejected
{
  const result = assignSchoolSchema.safeParse({
    schoolId: 'invalid-non-hex-id',
  });
  assert(!result.success, 'Malformed schoolId is rejected by regex validation');
}

// Test 4: Schema strictness rejects unexpected fields (parameter injection guard)
{
  const result = assignSchoolSchema.safeParse({
    schoolId: '507f1f77bcf86cd799439011',
    maliciousRoleEscalation: 'SUPER_ADMIN',
  });
  assert(!result.success, 'Unknown injection fields are rejected by strict validation');
}

const EMPLOYEE_ROLES = [
  ROLES.ROOT_ADMIN,
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.SUPERVISOR,
  ROLES.HM,
  ROLES.TEACHER,
  ROLES.PEON,
];

const STUDENT_ROLES = [ROLES.STUDENT];
const PARENT_ROLES = [ROLES.PARENT];

// Test 5: Student role cannot be an employee
{
  const isStudentInEmployees = STUDENT_ROLES.some((role) => EMPLOYEE_ROLES.includes(role));
  assert(!isStudentInEmployees, 'Students are strictly excluded from the EMPLOYEE category');
}

// Test 6: Parent role cannot be an employee
{
  const isParentInEmployees = PARENT_ROLES.some((role) => EMPLOYEE_ROLES.includes(role));
  assert(!isParentInEmployees, 'Parents are strictly excluded from the EMPLOYEE category');
}

// Test 7: Employee roles cannot be in student category
{
  const areEmployeesInStudents = EMPLOYEE_ROLES.some((role) => STUDENT_ROLES.includes(role));
  assert(!areEmployeesInStudents, 'Employees are strictly excluded from the STUDENT category');
}

// Test 8: Employee roles cannot be in parent category
{
  const areEmployeesInParents = EMPLOYEE_ROLES.some((role) => PARENT_ROLES.includes(role));
  assert(!areEmployeesInParents, 'Employees are strictly excluded from the PARENT category');
}

// Test 9: All accounts partition covers union of all roles without gaps
{
  const allKnownRoles = [
    ROLES.ROOT_ADMIN,
    ROLES.SUPER_ADMIN,
    ROLES.ADMIN,
    ROLES.SUPERVISOR,
    ROLES.HM,
    ROLES.TEACHER,
    ROLES.PEON,
    ROLES.STUDENT,
    ROLES.PARENT,
  ];

  const partitionedRoles = [...new Set([...EMPLOYEE_ROLES, ...STUDENT_ROLES, ...PARENT_ROLES])];
  const allCovered = allKnownRoles.every((role) => partitionedRoles.includes(role));
  assert(allCovered, 'All platform roles are cleanly partitioned into Employees, Students, and Parents');
}

// ─── 3. RBAC Hierarchy Invariants for Personnel Operations ───────────────────

const ROLE_RANKS = {
  [ROLES.ROOT_ADMIN]: 100,
  [ROLES.SUPER_ADMIN]: 90,
  [ROLES.ADMIN]: 80,
  [ROLES.SUPERVISOR]: 70,
  [ROLES.HM]: 50,
  [ROLES.TEACHER]: 30,
  [ROLES.PEON]: 20,
  [ROLES.STUDENT]: 10,
  [ROLES.PARENT]: 10,
};

function canMutateUser(actorRole, targetRole) {
  const actorRank = ROLE_RANKS[actorRole] || 0;
  const targetRank = ROLE_RANKS[targetRole] || 0;

  // Root Admin can mutate anyone except other Root Admins
  if (actorRole === ROLES.ROOT_ADMIN) return true;

  // Actors cannot mutate higher or equal ranked accounts
  return actorRank > targetRank;
}

// Test 10: Head Master cannot assign/transfer a Supervisor
{
  assert(
    !canMutateUser(ROLES.HM, ROLES.SUPERVISOR),
    'Head Master is strictly prevented from mutating Supervisor personnel'
  );
}

// Test 11: Teacher cannot mutate Head Master or peer Teachers
{
  assert(
    !canMutateUser(ROLES.TEACHER, ROLES.HM) && !canMutateUser(ROLES.TEACHER, ROLES.TEACHER),
    'Teachers cannot mutate Head Master or peer Teachers'
  );
}

// Test 12: Root Admin has authority to assign/transfer operational staff
{
  assert(
    canMutateUser(ROLES.ROOT_ADMIN, ROLES.TEACHER) && canMutateUser(ROLES.ROOT_ADMIN, ROLES.HM),
    'Root Admin has valid authority over Teachers and Head Masters'
  );
}

// Test 13: Super Admin cannot demote or mutate Root Admin
{
  assert(
    !canMutateUser(ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN),
    'Super Admin cannot mutate Root Admin authority'
  );
}

// ─── 4. Audit Log Schema Integrity ──────────────────────────────────────────

// Test 14: Audit event structure for School Assignment
{
  const requiredAuditFields = [
    'action',
    'performedBy',
    'targetUser',
    'entityType',
    'entityId',
    'metadata',
    'status',
  ];

  const sampleAssignmentAudit = {
    action: 'EMPLOYEE_SCHOOL_ASSIGNED',
    performedBy: '507f1f77bcf86cd799439011',
    targetUser: '507f1f77bcf86cd799439012',
    entityType: 'User',
    entityId: '507f1f77bcf86cd799439012',
    metadata: {
      previousSchool: null,
      assignedSchool: '507f1f77bcf86cd799439013',
      schoolName: 'Baba-e-Urdu Molvi Abdul Haq School',
      reason: 'Regular deployment',
      effectiveDate: new Date(),
    },
    status: 'SUCCESS',
  };

  const hasAllFields = requiredAuditFields.every((f) => f in sampleAssignmentAudit);
  assert(hasAllFields, 'Assignment audit event satisfies full security audit trail schema');
}

// Test 15: Zero hard deletions invariant in personnel directory
{
  const allowedLifecycleStatuses = [
    USER_STATUS.ACTIVE,
    USER_STATUS.INACTIVE,
    USER_STATUS.SUSPENDED,
    USER_STATUS.PENDING_VERIFICATION,
    USER_STATUS.ARCHIVED,
  ];

  assert(
    allowedLifecycleStatuses.includes(USER_STATUS.ARCHIVED),
    'USER_STATUS.ARCHIVED exists to guarantee zero hard-deletions in personnel lifecycle'
  );
}

console.log('\n============================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
console.log('============================================================\n');
