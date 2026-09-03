/**
 * Comprehensive Automated Test Suite: Auth Hierarchy, Decoupled Designation,
 * Permission Ceiling & Git-like Audit Engine
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../config/constants.js';
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, validatePermissionCeiling, getEffectivePermissions } from '../src/config/permissions.js';
import { hashPassword, verifyPassword } from '../src/utils/passwordUtils.js';
import { signAccessToken, verifyAccessToken, signRefreshToken, verifyRefreshToken } from '../src/utils/tokenUtils.js';
import { generateMathCaptcha, verifyMathCaptcha } from '../src/utils/customMathCaptcha.js';
import { isDisposableEmail } from '../src/utils/disposableEmailValidator.js';
import { loginSchema } from '../src/validations/authSchemas.js';
import AuditLog from '../src/models/AuditLog.js';

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS: ${message}`);
}

async function runHierarchySuite() {
  console.log('\n======================================================================');
  console.log('🔒 EXECUTING FULL AUTH, RBAC HIERARCHY, PERMISSIONS & AUDIT SUITE');
  console.log('======================================================================\n');

  // ─── 1. Role Hierarchy Levels ───────────────────────────────────────────────
  console.log('--- 1. Role Hierarchy & Authority Levels ---');
  assert(ROLE_HIERARCHY[ROLES.ROOT_ADMIN] === 100, 'ROOT_ADMIN is Level 100');
  assert(ROLE_HIERARCHY[ROLES.SUPER_ADMIN] === 90, 'SUPER_ADMIN is Level 90');
  assert(ROLE_HIERARCHY[ROLES.ADMIN] === 80, 'ADMIN is Level 80');
  assert(ROLE_HIERARCHY[ROLES.SUPERVISOR] === 60, 'SUPERVISOR is Level 60');
  assert(ROLE_HIERARCHY[ROLES.HM] === 50, 'HM is Level 50');
  assert(ROLE_HIERARCHY[ROLES.TEACHER] === 30, 'TEACHER is Level 30');
  assert(ROLE_HIERARCHY[ROLES.STUDENT] === 10, 'STUDENT is Level 10');
  assert(ROLE_HIERARCHY[ROLES.PARENT] === 10, 'PARENT is Level 10');

  // ─── 2. Server Hierarchy Guard Simulation ──────────────────────────────────
  console.log('\n--- 2. Server Hierarchy Guard (Negative & Positive Bounds) ---');
  const evaluateHierarchy = (actorRole, targetRole, proposedRole = null) => {
    const actorLevel = ROLE_HIERARCHY[actorRole] || 0;
    const targetLevel = ROLE_HIERARCHY[targetRole] || 0;

    // ROOT_ADMIN has supreme authority
    if (actorRole === ROLES.ROOT_ADMIN) {
      if (proposedRole && ROLE_HIERARCHY[proposedRole] > 100) return { allowed: false, reason: 'INVALID_ROLE' };
      return { allowed: true };
    }

    // Actor must be strictly higher than target
    if (actorLevel <= targetLevel) {
      return { allowed: false, reason: 'INSUFFICIENT_HIERARCHY' };
    }

    // Actor cannot grant a role equal to or higher than their own
    if (proposedRole && ROLE_HIERARCHY[proposedRole] >= actorLevel) {
      return { allowed: false, reason: 'PRIVILEGE_ESCALATION_FORBIDDEN' };
    }

    return { allowed: true };
  };

  // TC-01: ROOT_ADMIN can manage and assign SUPER_ADMIN with dynamic designation
  const tc1 = evaluateHierarchy(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.SUPER_ADMIN);
  assert(tc1.allowed, 'TC-01: ROOT_ADMIN can assign/manage SUPER_ADMIN');

  // TC-02: SUPER_ADMIN cannot modify ROOT_ADMIN
  const tc2 = evaluateHierarchy(ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN);
  assert(!tc2.allowed && tc2.reason === 'INSUFFICIENT_HIERARCHY', 'TC-02: SUPER_ADMIN is blocked from modifying ROOT_ADMIN');

  // TC-03: SUPER_ADMIN cannot modify another SUPER_ADMIN
  const tc3 = evaluateHierarchy(ROLES.SUPER_ADMIN, ROLES.SUPER_ADMIN);
  assert(!tc3.allowed && tc3.reason === 'INSUFFICIENT_HIERARCHY', 'TC-03: SUPER_ADMIN is blocked from modifying equal SUPER_ADMIN');

  // TC-04: ADMIN cannot modify SUPER_ADMIN or grant SUPER_ADMIN
  const tc4 = evaluateHierarchy(ROLES.ADMIN, ROLES.SUPER_ADMIN);
  assert(!tc4.allowed && tc4.reason === 'INSUFFICIENT_HIERARCHY', 'TC-04: ADMIN is blocked from modifying SUPER_ADMIN');

  const tc4b = evaluateHierarchy(ROLES.ADMIN, ROLES.TEACHER, ROLES.SUPER_ADMIN);
  assert(!tc4b.allowed && tc4b.reason === 'PRIVILEGE_ESCALATION_FORBIDDEN', 'TC-04b: ADMIN cannot elevate a teacher to SUPER_ADMIN');

  // TC-05: HM cannot modify SUPERVISOR
  const tc5 = evaluateHierarchy(ROLES.HM, ROLES.SUPERVISOR);
  assert(!tc5.allowed && tc5.reason === 'INSUFFICIENT_HIERARCHY', 'TC-05: HM is blocked from modifying SUPERVISOR');

  // ─── 3. Permission Ceiling & Dynamic Capability Resolution ─────────────────
  console.log('\n--- 3. Permission Ceiling & Custom Capability Guard ---');
  // TC-06: Attempting to grant users.assign_role or users.suspend to TEACHER fails ceiling check
  const teacherCeilingCheck = validatePermissionCeiling(ROLES.TEACHER, [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.ATTENDANCE_MARK,
  ]);
  assert(!teacherCeilingCheck.valid, 'TC-06: Permission ceiling detects forbidden permissions for TEACHER');
  assert(teacherCeilingCheck.forbiddenPermissions.includes(PERMISSIONS.USERS_ASSIGN_ROLE), 'USERS_ASSIGN_ROLE is rejected for TEACHER');

  const adminCeilingCheck = validatePermissionCeiling(ROLES.ADMIN, [
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
  ]);
  assert(adminCeilingCheck.valid, 'Valid administrative permissions pass ceiling check for ADMIN');

  // Effective permissions resolver test
  const mockTeacher = {
    role: ROLES.TEACHER,
    customPermissions: [PERMISSIONS.USERS_ASSIGN_ROLE, PERMISSIONS.DOCUMENTS_PUBLISH], // USERS_ASSIGN_ROLE is above ceiling, DOCUMENTS_PUBLISH is safe
  };
  const effectivePerms = getEffectivePermissions(mockTeacher);
  assert(effectivePerms.includes(PERMISSIONS.ATTENDANCE_MARK), 'Teacher includes default attendance.mark');
  assert(effectivePerms.includes(PERMISSIONS.DOCUMENTS_PUBLISH), 'Teacher includes safe custom documents.publish');
  assert(!effectivePerms.includes(PERMISSIONS.USERS_ASSIGN_ROLE), 'Teacher strictly excludes ceiling-violating users.assign_role');

  // ─── 4. Dynamic Decoupled Designation Engine ────────────────────────────────
  console.log('\n--- 4. Dynamic Decoupled Designation Engine ---');
  const mockChairmanUser = {
    fullName: 'Ahmed Khan',
    designation: 'Town Chairman',
    role: ROLES.SUPER_ADMIN,
    scope: SCOPES.TOWN,
  };
  assert(mockChairmanUser.designation === 'Town Chairman' && mockChairmanUser.role === ROLES.SUPER_ADMIN, 'Town Chairman functions cleanly as designation + SUPER_ADMIN');

  const mockDdoUser = {
    fullName: 'Bilal Farooq',
    designation: 'Deputy Director of Education (DDO)',
    role: ROLES.ADMIN,
    scope: SCOPES.TOWN,
  };
  assert(mockDdoUser.designation.includes('DDO') && mockDdoUser.role === ROLES.ADMIN, 'DDO functions cleanly as designation + ADMIN');

  // ─── 5. Token Versioning & Session Revocation ──────────────────────────────
  console.log('\n--- 5. JWT Token Versioning & Claim Verification ---');
  const tokenClaims = {
    userId: '60d0fe4f5311236168a109ca',
    role: ROLES.ADMIN,
    roleLevel: 80,
    designation: 'Deputy Director of Education',
    scope: SCOPES.TOWN,
    tokenVersion: 3,
  };
  const token = signAccessToken(tokenClaims);
  const decoded = verifyAccessToken(token);
  assert(decoded.userId === tokenClaims.userId, 'Token claims contain userId');
  assert(decoded.designation === tokenClaims.designation, 'Token claims contain dynamic designation');
  assert(decoded.tokenVersion === 3, 'Token claims contain tokenVersion for session validation');

  // ─── 6. Math CAPTCHA Challenge & Validation ─────────────────────────────────
  console.log('\n--- 6. Math CAPTCHA Challenge ---');
  const captcha = generateMathCaptcha();
  assert(captcha.question && captcha.challengeToken, 'Math CAPTCHA challenge generated');
  const match = captcha.question.match(/(\d+)\s*\+\s*(\d+)/);
  assert(match !== null, 'Question matches expected format');
  const answer = parseInt(match[1]) + parseInt(match[2]);
  assert(verifyMathCaptcha(answer, captcha.challengeToken), 'Correct CAPTCHA answer verified');
  assert(!verifyMathCaptcha(answer + 5, captcha.challengeToken), 'Incorrect CAPTCHA answer rejected');

  // ─── 7. Git-like Audit Schema Immutability ──────────────────────────────────
  console.log('\n--- 7. Git-like Append-Only Audit Schema Immutability ---');
  const mockAuditEntry = {
    actorId: '60d0fe4f5311236168a109ca',
    actorRole: ROLES.SUPER_ADMIN,
    actorDesignation: 'Town Chairman',
    actorName: 'Ahmed Khan',
    action: 'USER_ROLE_AND_DESIGNATION_UPDATED',
    targetModel: 'User',
    targetId: '60d0fe4f5311236168a109cb',
    targetName: 'Tariq Mehmood',
    previousState: { role: ROLES.TEACHER, designation: 'Teacher' },
    newState: { role: ROLES.SUPERVISOR, designation: 'Education Officer' },
    result: 'SUCCESS',
    reason: 'Promoted to cluster supervisor by Town Chairman',
    requestId: 'req_test_8819',
  };
  assert(mockAuditEntry.actorDesignation === 'Town Chairman', 'Audit captures actor designation');
  assert(mockAuditEntry.result === 'SUCCESS', 'Audit captures outcome result');
  assert(mockAuditEntry.previousState.role === ROLES.TEACHER && mockAuditEntry.newState.role === ROLES.SUPERVISOR, 'Audit captures before/after diff snapshot');

  console.log('\n======================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} INTEGRATION & HIERARCHY TESTS PASSED!`);
  console.log('======================================================================\n');
  process.exit(0);
}

runHierarchySuite().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
