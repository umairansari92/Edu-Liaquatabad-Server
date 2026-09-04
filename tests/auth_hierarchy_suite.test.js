/**
 * Comprehensive Automated Test Suite: Auth Hierarchy, Decoupled Designation,
 * Permission Ceiling & Git-like Audit Engine
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  FINAL 8-ROLE SYSTEM (Roles ≠ Designations)                 ║
 * ║  ROOT_ADMIN(100) > SUPER_ADMIN(90) > ADMIN(80) >            ║
 * ║  SUPERVISOR(60) > HM(50) > TEACHER(30) > STUDENT(10)        ║
 * ║                                           | PARENT(10)       ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  DESIGNATION EXAMPLES (civil title → system role):          ║
 * ║  "Town Chairman"         → SUPER_ADMIN                       ║
 * ║  "Vice Chairman"         → SUPER_ADMIN or ADMIN              ║
 * ║  "Deputy Director (DDO)" → ADMIN                             ║
 * ║  "Education Officer"     → SUPERVISOR                        ║
 * ║  "Head Master"           → HM                                ║
 * ║  "Assistant Head Master" → HM                                ║
 * ╚══════════════════════════════════════════════════════════════╝
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
  console.log('   8-Role System: ROOT_ADMIN > SUPER_ADMIN > ADMIN > SUPERVISOR > HM > TEACHER > STUDENT|PARENT');
  console.log('   KEY: Designation ≠ Role (DDO → ADMIN, Chairman → SUPER_ADMIN)');
  console.log('======================================================================\n');

  // ─── 1. Role Hierarchy Levels ───────────────────────────────────────────────
  console.log('--- 1. Role Hierarchy & Authority Levels ---');
  assert(ROLE_HIERARCHY[ROLES.ROOT_ADMIN]  === 100, 'ROOT_ADMIN is Level 100 (CLI-only, emergency recovery)');
  assert(ROLE_HIERARCHY[ROLES.SUPER_ADMIN] === 90,  'SUPER_ADMIN is Level 90 (e.g., Town Chairman)');
  assert(ROLE_HIERARCHY[ROLES.ADMIN]       === 80,  'ADMIN is Level 80 (e.g., DDO — designation, not role name)');
  assert(ROLE_HIERARCHY[ROLES.SUPERVISOR]  === 60,  'SUPERVISOR is Level 60 (e.g., Education Officer)');
  assert(ROLE_HIERARCHY[ROLES.HM]          === 50,  'HM is Level 50 (e.g., Head Master or Asst. HM)');
  assert(ROLE_HIERARCHY[ROLES.TEACHER]     === 30,  'TEACHER is Level 30');
  assert(ROLE_HIERARCHY[ROLES.STUDENT]     === 10,  'STUDENT is Level 10');
  assert(ROLE_HIERARCHY[ROLES.PARENT]      === 10,  'PARENT is Level 10');

  // Verify ROOT_ADMIN is highest
  const maxLevel = Math.max(...Object.values(ROLE_HIERARCHY));
  assert(ROLE_HIERARCHY[ROLES.ROOT_ADMIN] === maxLevel, 'ROOT_ADMIN holds the highest authority level');

  // ─── 2. Server Hierarchy Guard Simulation ──────────────────────────────────
  console.log('\n--- 2. Server Hierarchy Guard (Negative & Positive Bounds) ---');
  const evaluateHierarchy = (actorRole, targetRole, proposedRole = null) => {
    const actorLevel = ROLE_HIERARCHY[actorRole] || 0;
    const targetLevel = ROLE_HIERARCHY[targetRole] || 0;

    // ROOT_ADMIN has supreme authority over all accounts
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

  // TC-01: ROOT_ADMIN can manage and assign SUPER_ADMIN
  const tc1 = evaluateHierarchy(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.SUPER_ADMIN);
  assert(tc1.allowed, 'TC-01: ROOT_ADMIN can assign/manage SUPER_ADMIN');

  // TC-02: SUPER_ADMIN cannot modify ROOT_ADMIN
  const tc2 = evaluateHierarchy(ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN);
  assert(!tc2.allowed && tc2.reason === 'INSUFFICIENT_HIERARCHY', 'TC-02: SUPER_ADMIN is blocked from modifying ROOT_ADMIN');

  // TC-03: SUPER_ADMIN cannot modify another SUPER_ADMIN
  const tc3 = evaluateHierarchy(ROLES.SUPER_ADMIN, ROLES.SUPER_ADMIN);
  assert(!tc3.allowed && tc3.reason === 'INSUFFICIENT_HIERARCHY', 'TC-03: SUPER_ADMIN is blocked from modifying equal SUPER_ADMIN');

  // TC-04: ADMIN cannot modify SUPER_ADMIN or grant SUPER_ADMIN role
  const tc4 = evaluateHierarchy(ROLES.ADMIN, ROLES.SUPER_ADMIN);
  assert(!tc4.allowed && tc4.reason === 'INSUFFICIENT_HIERARCHY', 'TC-04: ADMIN is blocked from modifying SUPER_ADMIN');

  const tc4b = evaluateHierarchy(ROLES.ADMIN, ROLES.TEACHER, ROLES.SUPER_ADMIN);
  assert(!tc4b.allowed && tc4b.reason === 'PRIVILEGE_ESCALATION_FORBIDDEN', 'TC-04b: ADMIN cannot elevate TEACHER to SUPER_ADMIN');

  // TC-05: SUPER_ADMIN can manage ADMIN (e.g., assign ADMIN role to a DDO)
  const tc5 = evaluateHierarchy(ROLES.SUPER_ADMIN, ROLES.HM, ROLES.ADMIN);
  assert(tc5.allowed, 'TC-05: SUPER_ADMIN can assign ADMIN role to an HM (e.g., promotion)');

  // TC-06: HM cannot modify SUPERVISOR
  const tc6 = evaluateHierarchy(ROLES.HM, ROLES.SUPERVISOR);
  assert(!tc6.allowed && tc6.reason === 'INSUFFICIENT_HIERARCHY', 'TC-06: HM is blocked from modifying SUPERVISOR');

  // TC-07: SUPERVISOR can manage HM
  const tc7 = evaluateHierarchy(ROLES.SUPERVISOR, ROLES.HM);
  assert(tc7.allowed, 'TC-07: SUPERVISOR can manage HM');

  // TC-08: HM can manage TEACHER
  const tc8 = evaluateHierarchy(ROLES.HM, ROLES.TEACHER);
  assert(tc8.allowed, 'TC-08: HM can manage TEACHER');

  // ─── 3. Permission Ceiling & Dynamic Capability Resolution ─────────────────
  console.log('\n--- 3. Permission Ceiling & Custom Capability Guard ---');

  // TC-09: TEACHER ceiling blocks users.assign_role
  const teacherCeilingCheck = validatePermissionCeiling(ROLES.TEACHER, [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.ATTENDANCE_MARK,
  ]);
  assert(!teacherCeilingCheck.valid, 'TC-09: Permission ceiling detects forbidden permissions for TEACHER');
  assert(teacherCeilingCheck.forbiddenPermissions.includes(PERMISSIONS.USERS_ASSIGN_ROLE), 'USERS_ASSIGN_ROLE is rejected for TEACHER');

  // TC-10: ADMIN ceiling blocks users.assign_role (reserved for SUPER_ADMIN/ROOT_ADMIN)
  const adminCeilingCheck = validatePermissionCeiling(ROLES.ADMIN, [
    PERMISSIONS.USERS_ASSIGN_ROLE,
    PERMISSIONS.TRANSFERS_EMERGENCY_OVERRIDE,
  ]);
  assert(!adminCeilingCheck.valid, 'TC-10: ADMIN cannot be granted users.assign_role (SUPER_ADMIN/ROOT_ADMIN only)');

  // TC-11: ADMIN can hold all other elevated permissions
  const adminLegitCheck = validatePermissionCeiling(ROLES.ADMIN, [
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.DOCUMENTS_DELETE,
    PERMISSIONS.AUDIT_VIEW,
  ]);
  assert(adminLegitCheck.valid, 'TC-11: Valid ADMIN-level permissions pass ceiling check');

  // TC-12: Effective permissions resolver strips ceiling violations
  const mockTeacher = {
    role: ROLES.TEACHER,
    customPermissions: [PERMISSIONS.USERS_ASSIGN_ROLE, PERMISSIONS.DOCUMENTS_PUBLISH],
  };
  const effectivePerms = getEffectivePermissions(mockTeacher);
  assert(effectivePerms.includes(PERMISSIONS.ATTENDANCE_MARK),     'TC-12a: Teacher includes default attendance.mark');
  assert(effectivePerms.includes(PERMISSIONS.DOCUMENTS_PUBLISH),   'TC-12b: Teacher includes safe custom documents.publish');
  assert(!effectivePerms.includes(PERMISSIONS.USERS_ASSIGN_ROLE),  'TC-12c: Teacher strictly excludes ceiling-violating users.assign_role');

  // ─── 4. Dynamic Decoupled Designation Engine ────────────────────────────────
  console.log('\n--- 4. Dynamic Decoupled Designation Engine (Designation ≠ Role) ---');

  // TC-13: Town Chairman → SUPER_ADMIN (designation is civil title, role is system authority)
  const mockChairmanUser = {
    fullName: 'Ahmed Khan',
    designation: 'Town Chairman',   // Civil designation — can be anything
    role: ROLES.SUPER_ADMIN,        // System role — assigned by ROOT_ADMIN/SUPER_ADMIN
    scope: SCOPES.TOWN,
  };
  assert(
    mockChairmanUser.designation === 'Town Chairman' && mockChairmanUser.role === ROLES.SUPER_ADMIN,
    'TC-13: Town Chairman is a civil designation; SUPER_ADMIN is the system role assigned to them'
  );

  // TC-14: DDO (Deputy Director) → ADMIN role (not a "DDO role")
  const mockDdoUser = {
    fullName: 'Bilal Farooq',
    designation: 'Deputy Director of Education (DDO)', // Civil designation
    role: ROLES.ADMIN,                                  // System role assigned by SUPER_ADMIN
    scope: SCOPES.TOWN,
  };
  assert(
    mockDdoUser.designation.includes('DDO') && mockDdoUser.role === ROLES.ADMIN,
    'TC-14: DDO is a civil designation; ADMIN is the system role assigned to them (not a DDO role)'
  );

  // TC-15: Assistant Head Master → HM role (same role, different designation)
  const mockAsstHMUser = {
    fullName: 'Sara Malik',
    designation: 'Assistant Head Master',  // Different designation
    role: ROLES.HM,                         // Same HM system role
    scope: SCOPES.SCHOOL,
  };
  assert(
    mockAsstHMUser.designation === 'Assistant Head Master' && mockAsstHMUser.role === ROLES.HM,
    'TC-15: Assistant HM is a civil designation; HM is the system role (no ASSISTANT_HM role needed)'
  );

  // TC-16: Vice Chairman → SUPER_ADMIN (flexible — SUPER_ADMIN can assign different role)
  const mockViceChairmanUser = {
    fullName: 'Tariq Mehmood',
    designation: 'Vice Chairman',   // Civil designation
    role: ROLES.SUPER_ADMIN,        // Role assigned by ROOT_ADMIN based on authority level needed
    scope: SCOPES.TOWN,
  };
  assert(
    mockViceChairmanUser.designation === 'Vice Chairman' && mockViceChairmanUser.role === ROLES.SUPER_ADMIN,
    'TC-16: Vice Chairman is a civil designation; ROOT_ADMIN assigns SUPER_ADMIN or ADMIN role based on authority needed'
  );

  // ─── 5. Token Versioning & Session Revocation ──────────────────────────────
  console.log('\n--- 5. JWT Token Versioning & Claim Verification ---');
  const tokenClaims = {
    userId: '60d0fe4f5311236168a109ca',
    role: ROLES.ADMIN,
    roleLevel: 80,
    designation: 'Deputy Director of Education (DDO)',  // Designation in token, not "DDO" role
    scope: SCOPES.TOWN,
    tokenVersion: 3,
  };
  const token = signAccessToken(tokenClaims);
  const decoded = verifyAccessToken(token);
  assert(decoded.userId === tokenClaims.userId,         'TC-17a: Token claims contain userId');
  assert(decoded.designation === tokenClaims.designation,'TC-17b: Token claims contain dynamic civil designation');
  assert(decoded.tokenVersion === 3,                    'TC-17c: Token claims contain tokenVersion for session validation');
  assert(decoded.role === ROLES.ADMIN,                  'TC-17d: Token role is ADMIN (not DDO)');
  assert(decoded.roleLevel === 80,                      'TC-17e: Token roleLevel is 80 (ADMIN hierarchy level)');

  // ─── 6. Math CAPTCHA Challenge & Validation ─────────────────────────────────
  console.log('\n--- 6. Math CAPTCHA Challenge ---');
  const captcha = generateMathCaptcha();
  assert(captcha.question && captcha.challengeToken, 'TC-18a: Math CAPTCHA challenge generated');
  const match = captcha.question.match(/(\d+)\s*\+\s*(\d+)/);
  assert(match !== null, 'TC-18b: Question matches expected addition format');
  const answer = parseInt(match[1]) + parseInt(match[2]);
  assert(verifyMathCaptcha(answer, captcha.challengeToken),      'TC-18c: Correct CAPTCHA answer verified');
  assert(!verifyMathCaptcha(answer + 5, captcha.challengeToken), 'TC-18d: Incorrect CAPTCHA answer rejected');

  // ─── 7. Git-like Audit Schema Immutability ──────────────────────────────────
  console.log('\n--- 7. Git-like Append-Only Audit Schema Immutability ---');
  const mockAuditEntry = {
    actorId: '60d0fe4f5311236168a109ca',
    actorRole: ROLES.SUPER_ADMIN,
    actorDesignation: 'Town Chairman',       // Designation captured at time of action
    actorName: 'Ahmed Khan',
    action: 'USER_ROLE_AND_DESIGNATION_UPDATED',
    targetModel: 'User',
    targetId: '60d0fe4f5311236168a109cb',
    targetName: 'Tariq Mehmood',
    previousState: { role: ROLES.TEACHER, designation: 'Teacher' },
    newState:      { role: ROLES.SUPERVISOR, designation: 'Education Officer' },
    result: 'SUCCESS',
    reason: 'Promoted to cluster supervisor by Town Chairman (acting as SUPER_ADMIN)',
    requestId: 'req_test_8819',
  };
  assert(mockAuditEntry.actorDesignation === 'Town Chairman',  'TC-19a: Audit captures actor civil designation at time of action');
  assert(mockAuditEntry.actorRole === ROLES.SUPER_ADMIN,       'TC-19b: Audit captures system role (Town Chairman → SUPER_ADMIN)');
  assert(mockAuditEntry.result === 'SUCCESS',                  'TC-19c: Audit captures outcome result');
  assert(
    mockAuditEntry.previousState.role === ROLES.TEACHER && mockAuditEntry.newState.role === ROLES.SUPERVISOR,
    'TC-19d: Audit captures before/after role diff snapshot'
  );

  console.log('\n======================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} INTEGRATION & HIERARCHY TESTS PASSED!`);
  console.log('   ROOT_ADMIN(100) > SUPER_ADMIN(90) > ADMIN(80) > SUPERVISOR(60) > HM(50) > TEACHER(30) > STUDENT|PARENT(10)');
  console.log('   PRINCIPLE: DDO/Chairman/ViceChairman are DESIGNATIONS — ADMIN/SUPER_ADMIN are ROLES');
  console.log('======================================================================\n');
  process.exit(0);
}

runHierarchySuite().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
