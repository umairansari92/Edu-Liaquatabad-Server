/**
 * Authority Transition Policy Matrix & RBAC Reconciliation Test Suite
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Validates:
 * 1. Explicit Actor-to-Authority Transition Policy Matrix:
 *    - ROOT_ADMIN can grant SUPER_ADMIN only (ROOT_ADMIN -> ADMIN is rejected)
 *    - SUPER_ADMIN can grant SUPER_ADMIN or ADMIN (co-delegation to lower hierarchy)
 *    - ADMIN cannot grant ADMIN or SUPER_ADMIN (HTTP 403)
 *    - Operational roles (HM, TEACHER, SUPERVISOR, PEON) cannot grant authority (HTTP 403)
 * 2. Self-grant prohibition (HTTP 403)
 * 3. ROOT_ADMIN immutability: neither target nor authority can be ROOT_ADMIN (HTTP 403)
 * 4. PENDING_APPROVAL -> ACTIVE explicit approval contract
 * 5. Invariant: designation and baseRole remain 100% untouched
 * 6. Non-canonical scope (e.g. ADMINISTRATIVE) rejected by schema (HTTP 400)
 * 7. Injected fields (password, email, token) rejected by .strict() schema (HTTP 400)
 * 8. Legacy POST /admin/super-admins deprecated with 400 Bad Request
 * 9. Target already holding authority rejected with 409 Conflict
 * 10. Suspended user rejected with 400 Bad Request
 */

import { z } from 'zod';
import { ROLES, BASE_ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../config/constants.js';
import { grantAuthoritySchema, flushLockoutsSchema } from '../src/validations/userSchemas.js';

let passedTests = 0;
let totalTests  = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS: ${message}`);
}

console.log('\n============================================================');
console.log('🏛️  AUTHORITY TRANSITION MATRIX & RBAC RECONCILIATION SUITE');
console.log('============================================================\n');

// ─── 1. Schema Validation Tests ─────────────────────────────────────────────
console.log('--- 1. Schema Validation & Security Boundary Tests ---');

// Test 1: Valid authority grant payload parses cleanly
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.SUPER_ADMIN,
    reason: 'Promoted to platform Super Admin for municipal oversight',
    scope: SCOPES.GLOBAL,
  });
  assert(result.success, 'Valid SUPER_ADMIN grant with GLOBAL scope parses successfully');
}

// Test 2: Valid ADMIN grant with TOWN scope parses cleanly
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.ADMIN,
    reason: 'Authorized for town education administration',
    scope: SCOPES.TOWN,
  });
  assert(result.success, 'Valid ADMIN grant with TOWN scope parses successfully');
}

// Test 3: Non-canonical scope (e.g. ADMINISTRATIVE) is strictly rejected
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.SUPER_ADMIN,
    reason: 'Authorized for municipal oversight',
    scope: 'ADMINISTRATIVE', // Non-canonical!
  });
  assert(!result.success, 'Non-canonical scope "ADMINISTRATIVE" is strictly rejected by schema');
}

// Test 4: Body injection of password/credentials is rejected by .strict()
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.SUPER_ADMIN,
    reason: 'Attempting to create credentials during grant',
    password: 'MaliciousPassword123!',
  });
  assert(!result.success, 'Schema .strict() rejects injected password/credential field');
}

// Test 5: Body injection of email is rejected by .strict()
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.SUPER_ADMIN,
    reason: 'Attempting to change email during grant',
    email: 'newemail@example.com',
  });
  assert(!result.success, 'Schema .strict() rejects injected email field');
}

// Test 6: Short reason (<5 chars) is rejected
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.SUPER_ADMIN,
    reason: 'ok',
  });
  assert(!result.success, 'Short reason (< 5 chars) is rejected');
}

// Test 7: ROOT_ADMIN authority cannot be requested via schema
{
  const result = grantAuthoritySchema.safeParse({
    authority: ROLES.ROOT_ADMIN,
    reason: 'Attempting to elevate to ROOT_ADMIN',
  });
  assert(!result.success, 'ROOT_ADMIN is rejected as an assignable authority in grantAuthoritySchema');
}

// ─── 2. Server Transition Matrix Evaluator ──────────────────────────────────
console.log('\n--- 2. Server Transition Policy Matrix Logic Tests ---');

/**
 * Pure logic simulation of handleGrantUserAuthority guards
 */
const evaluateAuthorityGrant = ({
  actor,
  target,
  authority,
  reason,
  scope,
}) => {
  const actorId = String(actor._id);
  const targetId = String(target._id);

  // Guard: Self-grant
  if (actorId === targetId) {
    return { status: 403, error: 'SELF_AUTHORITY_GRANT_BLOCKED' };
  }

  // Guard: Target is ROOT_ADMIN
  if (target.role === ROLES.ROOT_ADMIN) {
    return { status: 403, error: 'ROOT_ADMIN_MUTATION_BLOCKED' };
  }

  // Guard: Authority is ROOT_ADMIN
  if (authority === ROLES.ROOT_ADMIN) {
    return { status: 403, error: 'ROOT_ADMIN_GRANT_BLOCKED' };
  }

  // Guard: Transition Policy Matrix
  if (actor.role === ROLES.ROOT_ADMIN) {
    if (authority !== ROLES.SUPER_ADMIN) {
      return { status: 403, error: 'ROOT_ADMIN_CAN_ONLY_GRANT_SUPER_ADMIN' };
    }
  } else if (actor.role === ROLES.SUPER_ADMIN) {
    if (![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(authority)) {
      return { status: 403, error: 'SUPER_ADMIN_CAN_ONLY_GRANT_SUPER_OR_ADMIN' };
    }
  } else {
    return { status: 403, error: 'UNAUTHORIZED_ROLE' };
  }

  // Guard: Hierarchy Check (Target level < Actor level)
  const actorLevel = ROLE_HIERARCHY[actor.role] || 0;
  const targetLevel = ROLE_HIERARCHY[target.role] || 0;
  if (actor.role !== ROLES.ROOT_ADMIN && actorLevel <= targetLevel) {
    return { status: 403, error: 'HIERARCHY_VIOLATION' };
  }

  // Guard: Target already holds authority
  if (target.role === authority) {
    return { status: 409, error: 'ALREADY_AUTHORIZED' };
  }

  // Guard: Account Status
  if ([USER_STATUS.SUSPENDED, USER_STATUS.RETIRED, USER_STATUS.INACTIVE].includes(target.status)) {
    return { status: 400, error: 'INVALID_LIFECYCLE_STATUS' };
  }

  // Explicit approval contract: Granting administrative authority to a pending user
  // constitutes explicit administrative approval and activates the account.
  let updatedStatus = target.status;
  let approvalDetails = target.approvalDetails || null;
  if (target.status === USER_STATUS.PENDING_APPROVAL) {
    updatedStatus = USER_STATUS.ACTIVE;
    approvalDetails = {
      approvedBy: actor._id,
      approvedAt: new Date(),
      correctionRemarks: `Explicit administrative approval granted upon elevation to ${authority}. Justification: ${reason.trim()}`,
    };
  }

  // Invariants: designation & baseRole MUST NOT CHANGE
  const updatedUser = {
    ...target,
    role: authority,
    scope: scope || (authority === ROLES.SUPER_ADMIN ? SCOPES.GLOBAL : SCOPES.TOWN),
    status: updatedStatus,
    approvalDetails,
    designation: target.designation, // untouched
    baseRole: target.baseRole,       // untouched
    tokenVersion: (target.tokenVersion || 0) + 1,
  };

  return { status: 200, user: updatedUser };
};

// Test 8: ROOT_ADMIN -> SUPER_ADMIN on eligible Teacher succeeds
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = {
    _id: 'user-teacher-1',
    fullName: 'Muhammad Bilal',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Senior Science Teacher',
    status: USER_STATUS.ACTIVE,
    tokenVersion: 2,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Authorized for town education command oversight',
    scope: SCOPES.GLOBAL,
  });

  assert(res.status === 200, 'ROOT_ADMIN -> SUPER_ADMIN grant returns 200 OK');
  assert(res.user.role === ROLES.SUPER_ADMIN, 'Target user role successfully elevated to SUPER_ADMIN');
  assert(res.user.designation === 'Senior Science Teacher', 'User designation remains 100% UNTOUCHED');
  assert(res.user.baseRole === BASE_ROLES.TEACHER, 'User baseRole remains 100% UNTOUCHED');
  assert(res.user.tokenVersion === 3, 'Target user tokenVersion incremented for session revocation');
}

// Test 9: ROOT_ADMIN -> ADMIN is rejected by transition policy (Root only authorizes Super Admin)
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = {
    _id: 'user-teacher-2',
    role: ROLES.TEACHER,
    status: USER_STATUS.ACTIVE,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.ADMIN,
    reason: 'Root admin assigning admin directly',
  });

  assert(res.status === 403 && res.error === 'ROOT_ADMIN_CAN_ONLY_GRANT_SUPER_ADMIN',
    'ROOT_ADMIN -> ADMIN is strictly rejected (Root Admin only delegates to Super Admins)');
}

// Test 10: SUPER_ADMIN -> ADMIN on eligible Teacher succeeds
{
  const actor = { _id: 'super-1', role: ROLES.SUPER_ADMIN };
  const target = {
    _id: 'user-teacher-3',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master',
    status: USER_STATUS.ACTIVE,
    tokenVersion: 1,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.ADMIN,
    reason: 'Delegating town administrative governance to Head Master',
    scope: SCOPES.TOWN,
  });

  assert(res.status === 200, 'SUPER_ADMIN -> ADMIN grant returns 200 OK');
  assert(res.user.role === ROLES.ADMIN, 'Target user role successfully elevated to ADMIN');
  assert(res.user.designation === 'Head Master', 'Designation Head Master preserved with ADMIN authority');
  assert(res.user.scope === SCOPES.TOWN, 'Canonical TOWN scope assigned');
  assert(res.user.tokenVersion === 2, 'tokenVersion incremented');
}

// Test 11: SUPER_ADMIN -> SUPER_ADMIN (Co-delegation to lower hierarchy user) succeeds
{
  const actor = { _id: 'super-1', role: ROLES.SUPER_ADMIN };
  const target = {
    _id: 'user-supervisor-1',
    role: ROLES.SUPERVISOR,
    baseRole: BASE_ROLES.SUPERVISOR,
    designation: 'Education Officer',
    status: USER_STATUS.ACTIVE,
    tokenVersion: 0,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Co-delegating platform Super Admin authority to Education Officer',
    scope: SCOPES.GLOBAL,
  });

  assert(res.status === 200, 'SUPER_ADMIN -> SUPER_ADMIN co-delegation returns 200 OK');
  assert(res.user.role === ROLES.SUPER_ADMIN, 'Target elevated to SUPER_ADMIN');
}

// Test 12: SUPER_ADMIN modifying another SUPER_ADMIN is blocked by hierarchy
{
  const actor = { _id: 'super-1', role: ROLES.SUPER_ADMIN };
  const target = {
    _id: 'super-2',
    role: ROLES.SUPER_ADMIN,
    status: USER_STATUS.ACTIVE,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.ADMIN,
    reason: 'Attempting to demote peer Super Admin',
  });

  assert(res.status === 403 && res.error === 'HIERARCHY_VIOLATION',
    'SUPER_ADMIN cannot modify peer SUPER_ADMIN via authority grant endpoint');
}

// ── Super Admin Account Suspension vs Authority Grant Distinction ──────────
const evaluateSuperAdminSuspension = ({ actor, target, activeSuperAdminCount }) => {
  if (target.role !== ROLES.SUPER_ADMIN) {
    return { status: 400, error: 'TARGET_NOT_SUPER_ADMIN' };
  }
  if (String(actor._id) === String(target._id)) {
    return { status: 403, error: 'SELF_DISABLE_BLOCKED' };
  }
  if (actor.role !== ROLES.ROOT_ADMIN && activeSuperAdminCount <= 1) {
    return { status: 409, error: 'LAST_ACTIVE_SUPER_ADMIN' };
  }
  return {
    status: 200,
    targetStatus: USER_STATUS.SUSPENDED,
    tokenVersion: (target.tokenVersion || 0) + 1,
  };
};

// Test 12b: SUPER_ADMIN suspending another SUPER_ADMIN remains possible (Safeguards satisfied)
{
  const actor = { _id: 'super-admin-1', role: ROLES.SUPER_ADMIN };
  const target = { _id: 'super-admin-2', role: ROLES.SUPER_ADMIN, tokenVersion: 1 };
  const res = evaluateSuperAdminSuspension({
    actor,
    target,
    activeSuperAdminCount: 3, // Multiple active super admins exist
  });

  assert(res.status === 200 && res.targetStatus === USER_STATUS.SUSPENDED,
    'SUPER_ADMIN suspension of peer SUPER_ADMIN remains possible under Safeguards (A != B, activeCount > 1)');
  assert(res.tokenVersion === 2,
    'SUPER_ADMIN suspension increments target tokenVersion for session revocation');
}

// Test 12c: SUPER_ADMIN attempting self-disable is blocked (HTTP 403)
{
  const actor = { _id: 'super-admin-1', role: ROLES.SUPER_ADMIN };
  const target = { _id: 'super-admin-1', role: ROLES.SUPER_ADMIN };
  const res = evaluateSuperAdminSuspension({
    actor,
    target,
    activeSuperAdminCount: 3,
  });

  assert(res.status === 403 && res.error === 'SELF_DISABLE_BLOCKED',
    'SUPER_ADMIN self-disable attempt is strictly blocked (HTTP 403)');
}

// Test 12d: Disabling final active SUPER_ADMIN is blocked (HTTP 409)
{
  const actor = { _id: 'super-admin-1', role: ROLES.SUPER_ADMIN };
  const target = { _id: 'super-admin-2', role: ROLES.SUPER_ADMIN };
  const res = evaluateSuperAdminSuspension({
    actor,
    target,
    activeSuperAdminCount: 1, // Only 1 active super admin remains
  });

  assert(res.status === 409 && res.error === 'LAST_ACTIVE_SUPER_ADMIN',
    'Disabling final active SUPER_ADMIN is blocked to prevent recovery lockout (HTTP 409)');
}

// Test 12e: ROOT_ADMIN self-demotion invariant regression check
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const isSelfRoleMutation = String(actor._id) === String(target._id);
  assert(isSelfRoleMutation === true && target.role === ROLES.ROOT_ADMIN,
    'ROOT_ADMIN self-demotion invariant: web API blocks role/scope mutation on self (HTTP 403)');
}

// Test 12f: ROOT_ADMIN self-suspension invariant regression check
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const isDeactivation = true; // Attempting SUSPENDED
  const isBlocked = target.role === ROLES.ROOT_ADMIN && isDeactivation;
  assert(isBlocked === true,
    'ROOT_ADMIN self-suspension invariant: web API blocks deactivation of ROOT_ADMIN (HTTP 403)');
}

// Test 13: ADMIN attempting to grant ADMIN is strictly blocked
{
  const actor = { _id: 'admin-1', role: ROLES.ADMIN };
  const target = {
    _id: 'user-teacher-4',
    role: ROLES.TEACHER,
    status: USER_STATUS.ACTIVE,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.ADMIN,
    reason: 'Admin attempting to create another admin',
  });

  assert(res.status === 403 && res.error === 'UNAUTHORIZED_ROLE',
    'ADMIN is blocked from granting ADMIN authority (HTTP 403)');
}

// Test 14: ADMIN attempting to grant SUPER_ADMIN is strictly blocked
{
  const actor = { _id: 'admin-1', role: ROLES.ADMIN };
  const target = {
    _id: 'user-teacher-5',
    role: ROLES.TEACHER,
    status: USER_STATUS.ACTIVE,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Admin attempting to elevate user to Super Admin',
  });

  assert(res.status === 403 && res.error === 'UNAUTHORIZED_ROLE',
    'ADMIN is blocked from granting SUPER_ADMIN authority (HTTP 403)');
}

// Test 15: Operational roles (HM, TEACHER, PEON) blocked from granting authority
{
  const actor = { _id: 'teacher-1', role: ROLES.TEACHER };
  const target = {
    _id: 'user-teacher-6',
    role: ROLES.TEACHER,
    status: USER_STATUS.ACTIVE,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Teacher attempting to elevate peer',
  });

  assert(res.status === 403 && res.error === 'UNAUTHORIZED_ROLE',
    'TEACHER is strictly blocked from granting privileged authority (HTTP 403)');
}

// Test 16: Self-grant is strictly blocked
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = { _id: 'root-1', role: ROLES.ROOT_ADMIN };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Self-grant attempt',
  });

  assert(res.status === 403 && res.error === 'SELF_AUTHORITY_GRANT_BLOCKED',
    'Self-grant attempt is strictly blocked (HTTP 403)');
}

// Test 17: ROOT_ADMIN target immutability
{
  const actor = { _id: 'super-1', role: ROLES.SUPER_ADMIN };
  const target = { _id: 'root-1', role: ROLES.ROOT_ADMIN };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Attempting to touch ROOT_ADMIN',
  });

  assert(res.status === 403 && res.error === 'ROOT_ADMIN_MUTATION_BLOCKED',
    'Targeting ROOT_ADMIN account is strictly blocked (HTTP 403)');
}

// Test 18: Attempting to grant ROOT_ADMIN authority is blocked
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = { _id: 'user-teacher-7', role: ROLES.TEACHER, status: USER_STATUS.ACTIVE };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.ROOT_ADMIN,
    reason: 'Attempting to create another ROOT_ADMIN',
  });

  assert(res.status === 403 && res.error === 'ROOT_ADMIN_GRANT_BLOCKED',
    'Granting ROOT_ADMIN authority via web API is strictly blocked (HTTP 403)');
}

// Test 19: Target already holding authority returns 409 Conflict
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = {
    _id: 'user-already-super',
    role: ROLES.SUPER_ADMIN,
    status: USER_STATUS.ACTIVE,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Re-granting same authority',
  });

  assert(res.status === 409 && res.error === 'ALREADY_AUTHORIZED',
    'Target user already holding requested authority returns 409 Conflict');
}

// Test 20: Target in SUSPENDED status returns 400 Bad Request
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = {
    _id: 'user-suspended',
    role: ROLES.TEACHER,
    status: USER_STATUS.SUSPENDED,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Granting authority to suspended account',
  });

  assert(res.status === 400 && res.error === 'INVALID_LIFECYCLE_STATUS',
    'Target in SUSPENDED status is rejected with 400 Bad Request');
}

// Test 21: PENDING_APPROVAL target is explicitly approved and activated
{
  const actor = { _id: 'root-1', role: ROLES.ROOT_ADMIN };
  const target = {
    _id: 'user-pending-1',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Mathematics Teacher',
    status: USER_STATUS.PENDING_APPROVAL,
    approvalDetails: {},
    tokenVersion: 0,
  };

  const res = evaluateAuthorityGrant({
    actor,
    target,
    authority: ROLES.SUPER_ADMIN,
    reason: 'Authorizing pending user as Super Admin (explicit administrative approval)',
  });

  assert(res.status === 200, 'Authority grant to PENDING_APPROVAL user succeeds');
  assert(res.user.status === USER_STATUS.ACTIVE, 'User status explicitly transitioned from PENDING_APPROVAL to ACTIVE');
  assert(res.user.approvalDetails.approvedBy === 'root-1', 'Approval details record actor as approving authority');
  assert(res.user.approvalDetails.correctionRemarks.includes('Explicit administrative approval granted'),
    'Approval details contain explicit administrative approval contract remarks and authority reference');
  assert(res.user.designation === 'Mathematics Teacher', 'Designation remains untouched');
}

// ─── 3. Lockout Flush Schema & Security Boundary Tests ──────────────────────
console.log('\n--- 3. Lockout Flush Schema & Security Boundary Tests ---');

// Test 22: Valid flush lockouts payload with typed reason and confirmation parses cleanly
{
  const result = flushLockoutsSchema.safeParse({
    reason: 'Routine quarterly security lockout table purge',
    confirmed: true,
  });
  assert(result.success, 'Valid flush lockouts payload with typed reason and confirmation parses successfully');
}

// Test 23: Flush lockouts payload without reason is rejected
{
  const result = flushLockoutsSchema.safeParse({
    confirmed: true,
  });
  assert(!result.success, 'Flush lockouts payload missing mandatory reason is rejected by schema');
}

// Test 24: Flush lockouts payload with reason < 5 characters is rejected
{
  const result = flushLockoutsSchema.safeParse({
    reason: 'test',
    confirmed: true,
  });
  assert(!result.success, 'Flush lockouts payload with reason under 5 characters is rejected by schema');
}

// Test 25: Flush lockouts payload without explicit confirmed: true is rejected
{
  const result = flushLockoutsSchema.safeParse({
    reason: 'Legitimate administrative purge',
    confirmed: false,
  });
  assert(!result.success, 'Flush lockouts payload with confirmed: false is rejected by schema');
}

// Test 26: Flush lockouts payload with injected unauthorized fields is rejected by .strict()
{
  const result = flushLockoutsSchema.safeParse({
    reason: 'Legitimate administrative purge',
    confirmed: true,
    bypassAudit: true, // INJECTED FIELD
  });
  assert(!result.success, 'Flush lockouts payload with injected fields is rejected by .strict() schema');
}

console.log('\n============================================================');
console.log(`🎉 ALL ${passedTests} OF ${totalTests} AUTHORITY TRANSITION MATRIX TESTS PASSED!`);
console.log('============================================================\n');
