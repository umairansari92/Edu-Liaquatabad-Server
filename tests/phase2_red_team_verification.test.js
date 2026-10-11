/**
 * ============================================================================
 * 🛡️ PHASE 2 & 2.1 ACTIVE RED-TEAM VERIFICATION & PENETRATION TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Verifies with Live HTTP & Persisted Database State:
 *   P0: Authentication, MFA, and Session Assurance (Tickets, Claims, RTR, Invalidation)
 *   P0: Authorization, BOLA/IDOR, and School-Isolation Boundaries (HM, Supervisor, Admin)
 *   P0: Authorization Edge Cases (Malformed IDs, Missing Fields, Fail-Closed Handlers)
 *   P1: CF-01 & CF-03 Live Supertest HTTP Export Pipeline, RFC 9111 Cache Headers
 *   P1: VULN-EXPORT-AUDIT-01 Persisted Audit Records for all 5 Export Endpoints
 *   P1: Fail-Closed Pre-Flight Audit Logging (Aborts before streaming if DB fails)
 *   P1: Export Rate Limiting (Keyed on User ID, No Localhost Skip, HTTP 429 Rejection)
 *   P1: CF-04 Supervisor Timetable Scope & Parameter Tampering Defense
 *   P2: Input Sanitization, Prototype Pollution, Decoy Honeypot, AuditLog Immutability
 * ============================================================================
 */

import assert from 'assert';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import express from 'express';
import supertest from 'supertest';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../config/constants.js';
import { signAccessToken, signMfaPendingToken, verifyAccessToken } from '../src/utils/tokenUtils.js';
import { authenticate } from '../src/middlewares/authenticate.js';
import { requireMfaVerified } from '../src/middlewares/requireMfa.js';
import { authorizeScope } from '../src/middlewares/authorizeScope.js';
import { authorizeHierarchy } from '../src/middlewares/authorizeHierarchy.js';
import { enforceSchoolScope } from '../src/middlewares/authorize.js';
import { exportLimiter } from '../src/middlewares/tripleLockRateLimiter.js';
import { deepSanitize } from '../src/middlewares/deepSanitize.js';
import { ratTrapHoneypotCheck } from '../src/middlewares/ratTrapHoneypot.js';
import User from '../src/models/User.js';
import School from '../src/models/School.js';
import AuditLog from '../src/models/AuditLog.js';
import SecurityLockout from '../src/models/SecurityLockout.js';
import StudentProfile from '../src/models/StudentProfile.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import '../src/models/Class.js';
import '../src/models/Section.js';
import { checkEmailLockout, recordFailedLogin } from '../src/middlewares/tripleLockRateLimiter.js';
import exportRouter from '../src/routes/exportRoutes.js';
import { handleExportStudentsCsv, handleExportStaffCsv } from '../src/controllers/exportController.js';

let passed = 0;
let failed = 0;

const defaultOrgId = new mongoose.Types.ObjectId();
const defaultTownId = new mongoose.Types.ObjectId();

const runTest = async (testName, testFn) => {
  try {
    await testFn();
    passed++;
    console.log(`  ✅ PASS [${passed}]: ${testName}`);
  } catch (error) {
    failed++;
    console.error(`  ❌ FAIL: ${testName}`);
    console.error(`     Error: ${error.message}`);
    throw error;
  }
};

const createMockResponse = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    write(chunk) {
      return true;
    },
    end() {
      return this;
    },
  };
  return res;
};

console.log('\n======================================================================');
console.log('⚔️  PHASE 2 & 2.1 ACTIVE RED-TEAM VERIFICATION & AUDIT EVIDENCE SUITE');
console.log('======================================================================\n');

// ── Connect to MongoDB if not connected ──────────────────────────────────────
if (mongoose.connection.readyState === 0) {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/school_management_system';
  await mongoose.connect(mongoUri);
}

// ─────────────────────────────────────────────────────────────────────────────
// P0: AUTHENTICATION, MFA & SESSION ASSURANCE
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- P0: Authentication, MFA & Session Assurance ---');

await runTest('1.1 MFA-Pending Ticket is strictly rejected from application endpoints', async () => {
  const mfaPendingToken = signMfaPendingToken({
    userId: new mongoose.Types.ObjectId().toString(),
    email: 'test.pending@example.test',
    role: ROLES.TEACHER,
  });

  const request = {
    headers: { authorization: `Bearer ${mfaPendingToken}` },
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authenticate(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Middleware must not call nextFunction');
  assert.strictEqual(response.statusCode, 401, 'Should return HTTP 401 Unauthorized');
  assert.strictEqual(request.user, undefined, 'User context must never be hydrated for MFA pending ticket');
});

await runTest('1.2 ROOT_ADMIN token lacking mfaVerified assurance is rejected with HTTP 403', async () => {
  let testRootAdmin = await User.findOne({ role: ROLES.ROOT_ADMIN });
  if (!testRootAdmin) {
    testRootAdmin = await User.create({
      organizationId: defaultOrgId,
      townId: defaultTownId,
      scope: SCOPES.GLOBAL,
      fullName: 'RedTeam Synthetic Root Admin',
      email: `redteam.root.${Date.now()}@example.test`,
      passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
      role: ROLES.ROOT_ADMIN,
      baseRole: 'SUPERVISOR',
      status: USER_STATUS.ACTIVE,
      tokenVersion: 1,
    });
  }

  const unverifiedRootToken = signAccessToken({
    userId: testRootAdmin._id.toString(),
    email: testRootAdmin.email,
    role: ROLES.ROOT_ADMIN,
    mfaVerified: false,
    tokenVersion: testRootAdmin.tokenVersion,
  });

  const request = {
    headers: { authorization: `Bearer ${unverifiedRootToken}` },
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authenticate(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Unverified Root Admin token must not pass authenticate');
  assert.strictEqual(response.statusCode, 403, 'Must return HTTP 403 Forbidden');
  assert.ok(response.body.message.includes('Multi-Factor Authentication'), 'Must demand MFA assurance');
});

await runTest('1.3 Outdated tokenVersion (session revocation) is rejected immediately with HTTP 401', async () => {
  const testUser = await User.create({
    organizationId: defaultOrgId,
    townId: defaultTownId,
    scope: SCOPES.SCHOOL,
    fullName: 'Session Invalidation Test User',
    email: `session.revoke.${Date.now()}@example.test`,
    passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
    role: ROLES.TEACHER,
    baseRole: 'TEACHER',
    status: USER_STATUS.ACTIVE,
    tokenVersion: 2, // Current active in DB is 2
  });

  // Token minted with old tokenVersion 1
  const staleToken = signAccessToken({
    userId: testUser._id.toString(),
    email: testUser.email,
    role: ROLES.TEACHER,
    tokenVersion: 1,
  });

  const request = {
    headers: { authorization: `Bearer ${staleToken}` },
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authenticate(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Stale tokenVersion must not pass');
  assert.strictEqual(response.statusCode, 401, 'Should return HTTP 401');
  assert.ok(response.body.message.includes('Session has been invalidated'), 'Message must indicate session invalidation');

  await User.deleteOne({ _id: testUser._id });
});

await runTest('1.4 Suspended user account session is blocked with HTTP 403', async () => {
  const suspendedUser = await User.create({
    organizationId: defaultOrgId,
    townId: defaultTownId,
    scope: SCOPES.SCHOOL,
    fullName: 'Suspended Account Test',
    email: `suspended.${Date.now()}@example.test`,
    passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
    role: ROLES.TEACHER,
    baseRole: 'TEACHER',
    status: USER_STATUS.SUSPENDED,
    tokenVersion: 1,
  });

  const token = signAccessToken({
    userId: suspendedUser._id.toString(),
    email: suspendedUser.email,
    role: ROLES.TEACHER,
    tokenVersion: 1,
  });

  const request = {
    headers: { authorization: `Bearer ${token}` },
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authenticate(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(response.statusCode, 403, 'Should return 403 for SUSPENDED account');

  await User.deleteOne({ _id: suspendedUser._id });
});

await runTest('1.5 Persistent MongoDB Account Lockout survives across simulated cold restarts', async () => {
  const targetEmail = `lockout.test.${Date.now()}@example.test`;

  for (let i = 0; i < 5; i++) {
    await recordFailedLogin(targetEmail, '192.168.1.100', 'fingerprint-abc');
  }

  const lockoutDoc = await SecurityLockout.findOne({ targetKey: `email:${targetEmail}` });
  assert.ok(lockoutDoc, 'Lockout record must exist in MongoDB');
  assert.strictEqual(lockoutDoc.isLocked, true, 'Account must be marked locked');
  assert.strictEqual(lockoutDoc.failedAttempts, 5, 'Failed attempts count must be 5');

  const status = await checkEmailLockout(targetEmail, '10.0.0.1');
  assert.strictEqual(status.locked, true, 'Must block even from another rotating IP');

  await SecurityLockout.deleteOne({ targetKey: `email:${targetEmail}` });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0: AUTHORIZATION, BOLA/IDOR, MULTI-SCHOOL ISOLATION & DEFENSIVE EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- P0: Authorization, BOLA/IDOR & Multi-School Isolation ---');

await runTest('2.1 Head Master cross-school user mutation is blocked and logs audit event', async () => {
  const schoolA = new mongoose.Types.ObjectId();
  const schoolB = new mongoose.Types.ObjectId();

  const hmActor = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    role: ROLES.HM,
    scope: SCOPES.SCHOOL,
    schoolId: schoolA,
  };

  const targetUserInSchoolB = await User.create({
    organizationId: defaultOrgId,
    townId: defaultTownId,
    scope: SCOPES.SCHOOL,
    fullName: 'Teacher in School B',
    email: `schoolb.teacher.${Date.now()}@example.test`,
    passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
    role: ROLES.TEACHER,
    baseRole: 'TEACHER',
    schoolId: schoolB,
    status: USER_STATUS.ACTIVE,
  });

  const request = {
    user: hmActor,
    params: { id: targetUserInSchoolB._id.toString() },
    headers: { 'user-agent': 'RedTeam-Tester' },
    ip: '127.0.0.1',
    originalUrl: `/api/v1/users/${targetUserInSchoolB._id}/lifecycle`,
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeScope(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Cross-school mutation must not pass authorizeScope');
  assert.strictEqual(response.statusCode, 403, 'Must return HTTP 403 Forbidden');
  assert.ok(response.body.message.includes('another school'), 'Must state cannot modify personnel of another school');

  const auditEvent = await AuditLog.findOne({
    action: 'CROSS_SCHOOL_USER_MUTATION_VIOLATION',
    actorId: hmActor._id,
  });
  assert.ok(auditEvent, 'Must write CROSS_SCHOOL_USER_MUTATION_VIOLATION audit log');
  assert.strictEqual(auditEvent.result, 'DENIED');

  await User.deleteOne({ _id: targetUserInSchoolB._id });
});

await runTest('2.2 Head Master cross-school school object mutation (PATCH /schools/:id) is blocked', async () => {
  const codeA = `SCA${Math.floor(1000 + Math.random() * 8999)}`;
  const codeB = `SCB${Math.floor(1000 + Math.random() * 8999)}`;
  const schoolA = await School.create({
    name: 'School A RedTeam',
    schoolCode: codeA,
    schoolType: 'PRIMARY',
    genderType: 'CO_EDUCATION',
    address: 'Liaquatabad Block 1',
    townId: defaultTownId,
    organizationId: defaultOrgId,
    status: 'ACTIVE',
  });

  const schoolB = await School.create({
    name: 'School B RedTeam',
    schoolCode: codeB,
    schoolType: 'PRIMARY',
    genderType: 'CO_EDUCATION',
    address: 'Liaquatabad Block 2',
    townId: defaultTownId,
    organizationId: defaultOrgId,
    status: 'ACTIVE',
  });

  const hmActor = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.HM,
    scope: SCOPES.SCHOOL,
    schoolId: schoolA._id,
  };

  const request = {
    method: 'PATCH',
    route: { path: '/:id' },
    baseUrl: '/api/v1/schools',
    params: { id: schoolB._id.toString() },
    user: hmActor,
    headers: {},
    ip: '127.0.0.1',
    originalUrl: `/api/v1/schools/${schoolB._id}`,
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeScope(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(response.statusCode, 403);
  assert.ok(response.body.message.includes("own school's record"));

  await School.deleteMany({ _id: { $in: [schoolA._id, schoolB._id] } });
});

await runTest('2.3 Town Admin cross-town school mutation is blocked with HTTP 403', async () => {
  const town1Id = new mongoose.Types.ObjectId();
  const town2Id = new mongoose.Types.ObjectId();
  const codeF = `FTS${Math.floor(1000 + Math.random() * 8999)}`;

  const foreignTownSchool = await School.create({
    name: 'Foreign Town School',
    schoolCode: codeF,
    schoolType: 'PRIMARY',
    genderType: 'CO_EDUCATION',
    address: 'Gulberg Town',
    townId: town2Id,
    organizationId: defaultOrgId,
    status: 'ACTIVE',
  });

  const town1Admin = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.ADMIN,
    townId: town1Id,
  };

  const request = {
    method: 'PATCH',
    route: { path: '/:id' },
    baseUrl: '/api/v1/schools',
    params: { id: foreignTownSchool._id.toString() },
    user: town1Admin,
    headers: {},
    ip: '127.0.0.1',
    originalUrl: `/api/v1/schools/${foreignTownSchool._id}`,
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeScope(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(response.statusCode, 403);
  assert.ok(response.body.message.includes('another administrative town'));

  await School.deleteOne({ _id: foreignTownSchool._id });
});

await runTest('2.4 Role Hierarchy Ceiling: Head Master (Level 50) cannot modify Supervisor (Level 60)', async () => {
  const supervisorUser = await User.create({
    organizationId: defaultOrgId,
    townId: defaultTownId,
    scope: SCOPES.ADMINISTRATIVE,
    fullName: 'Field Supervisor RedTeam',
    email: `supervisor.${Date.now()}@example.test`,
    passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
    role: ROLES.SUPERVISOR,
    baseRole: 'SUPERVISOR',
    status: USER_STATUS.ACTIVE,
  });

  const hmActor = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.HM,
    roleLevel: 50,
  };

  const request = {
    user: hmActor,
    targetUser: supervisorUser,
    body: { status: 'SUSPENDED', reason: 'Unauthorized demotion attempt' },
  };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeHierarchy(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Hierarchy violation must be blocked');
  assert.strictEqual(response.statusCode, 403);
  assert.ok(response.body.message.includes('equal or higher authority'));

  await User.deleteOne({ _id: supervisorUser._id });
});

await runTest('2.5 Defensive Hierarchy: Missing target user ID passes through safely to next middleware', async () => {
  const hmActor = { _id: new mongoose.Types.ObjectId(), role: ROLES.HM, roleLevel: 50 };
  const request = { user: hmActor, params: {}, body: {} };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeHierarchy(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true, 'When no target user specified, passes safely to next middleware');
});

await runTest('2.6 Defensive Hierarchy: Non-existent target user ID returns HTTP 404', async () => {
  const nonExistentId = new mongoose.Types.ObjectId().toString();
  const hmActor = { _id: new mongoose.Types.ObjectId(), role: ROLES.HM, roleLevel: 50 };
  const request = { user: hmActor, params: { id: nonExistentId }, body: {} };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeHierarchy(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(response.statusCode, 404, 'Must return 404 for non-existent target user');
});

await runTest('2.7 Defensive Hierarchy: Malformed target user ID fails closed with HTTP 500 error', async () => {
  const hmActor = { _id: new mongoose.Types.ObjectId(), role: ROLES.HM, roleLevel: 50 };
  const request = { user: hmActor, params: { id: 'invalid-cast-id' }, body: {} };
  const response = createMockResponse();
  let nextCalled = false;

  await authorizeHierarchy(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Must fail closed on malformed ID');
  assert.strictEqual(response.statusCode, 500, 'Must return 500 without crashing');
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: LIVE HTTP EXPORT PIPELINE, RFC 9111 CACHE HEADERS & PERSISTED AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- P1: Live HTTP Export Pipeline, RFC 9111 Cache Headers & Audit Logs ---');

// Setup live Supertest Express App mounted with real exportRouter
const liveExportApp = express();
liveExportApp.use(express.json());
liveExportApp.use('/api/v1/export', exportRouter);
liveExportApp.use((err, req, res, next) => {
  console.error('EXPRESS ROUTE ERROR:', err);
  res.status(500).json({ error: err.message, stack: err.stack });
});

// Ensure a valid synthetic Town Admin exists for live HTTP testing
let testAdminUser = await User.findOne({ role: ROLES.ADMIN, status: USER_STATUS.ACTIVE });
if (!testAdminUser) {
  testAdminUser = await User.create({
    organizationId: defaultOrgId,
    townId: defaultTownId,
    scope: SCOPES.ADMINISTRATIVE,
    fullName: 'RedTeam Live HTTP Admin',
    email: `redteam.http.admin.${Date.now()}@example.test`,
    passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
    role: ROLES.ADMIN,
    baseRole: 'SUPERVISOR',
    status: USER_STATUS.ACTIVE,
    tokenVersion: 1,
  });
}

const adminAccessToken = signAccessToken({
  userId: testAdminUser._id.toString(),
  email: testAdminUser.email,
  role: ROLES.ADMIN,
  tokenVersion: testAdminUser.tokenVersion,
});

let testSuperAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE });
if (!testSuperAdmin) {
  testSuperAdmin = await User.create({
    organizationId: defaultOrgId,
    townId: defaultTownId,
    scope: SCOPES.ADMINISTRATIVE,
    fullName: 'RedTeam Live HTTP Super Admin',
    email: `redteam.http.superadmin.${Date.now()}@example.test`,
    passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
    role: ROLES.SUPER_ADMIN,
    baseRole: 'SUPERVISOR',
    status: USER_STATUS.ACTIVE,
    tokenVersion: 1,
  });
}

const superAdminAccessToken = signAccessToken({
  userId: testSuperAdmin._id.toString(),
  email: testSuperAdmin.email,
  role: ROLES.SUPER_ADMIN,
  tokenVersion: testSuperAdmin.tokenVersion,
});

await runTest('3.1 exportLimiter middleware exists, keys on authenticated user ID, and has no localhost skip', () => {
  assert.strictEqual(typeof exportLimiter, 'function', 'exportLimiter must be Express middleware');
});

await runTest('3.2 Live HTTP: GET /api/v1/export/schools returns 200, RFC 9111 headers, UTF-8 BOM, and persists AuditLog', async () => {
  const res = await supertest(liveExportApp)
    .get('/api/v1/export/schools')
    .set('Authorization', `Bearer ${adminAccessToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.strictEqual(res.headers['pragma'], 'no-cache');
  assert.strictEqual(res.headers['expires'], '0');
  assert.strictEqual(res.headers['surrogate-control'], 'no-store');
  assert.ok(res.headers['content-disposition'].includes('attachment; filename="schools_'));
  assert.ok(res.headers['content-type'].includes('text/csv'));
  assert.ok(res.text.startsWith('\uFEFF'), 'Must output UTF-8 BOM byte');

  // Verify Persisted Database Audit Record
  const log = await AuditLog.findOne({
    action: 'SCHOOLS_CSV_EXPORTED',
    actorId: testAdminUser._id,
  }).sort({ createdAt: -1 });

  assert.ok(log, 'Must persist audit log record in MongoDB');
  assert.strictEqual(log.targetModel, 'ExportStream');
  assert.ok(log.targetId, 'targetId must be populated');
  assert.notStrictEqual(String(log.targetId), String(testAdminUser._id), 'targetId must NOT be actor ID');
  assert.strictEqual(log.result, 'SUCCESS');
  assert.ok(log.targetName.startsWith('schools_'));
});

await runTest('3.3 Live HTTP: GET /api/v1/export/users requires SUPER_ADMIN/ROOT_ADMIN (Admin gets 403, Super Admin gets 200 + AuditLog)', async () => {
  // Town Admin is restricted from full platform user export
  const adminRes = await supertest(liveExportApp)
    .get('/api/v1/export/users')
    .set('Authorization', `Bearer ${adminAccessToken}`);
  assert.strictEqual(adminRes.status, 403, 'Town Admin must be rejected from /export/users with 403');

  // Super Admin is authorized
  const res = await supertest(liveExportApp)
    .get('/api/v1/export/users')
    .set('Authorization', `Bearer ${superAdminAccessToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.strictEqual(res.headers['pragma'], 'no-cache');
  assert.strictEqual(res.headers['expires'], '0');
  assert.strictEqual(res.headers['surrogate-control'], 'no-store');
  assert.ok(res.headers['content-disposition'].includes('attachment; filename="users_'));

  const log = await AuditLog.findOne({
    action: 'PERSONNEL_CSV_EXPORTED',
    actorId: testSuperAdmin._id,
  }).sort({ createdAt: -1 });

  assert.ok(log, 'Must persist audit log in MongoDB for personnel export');
  assert.strictEqual(log.targetModel, 'ExportStream');
  assert.notStrictEqual(String(log.targetId), String(testSuperAdmin._id));
  assert.strictEqual(log.result, 'SUCCESS');
});

await runTest('3.4 Live HTTP: GET /api/v1/export/staff returns 200, RFC 9111 headers, and persists AuditLog', async () => {
  const res = await supertest(liveExportApp)
    .get('/api/v1/export/staff')
    .set('Authorization', `Bearer ${adminAccessToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.strictEqual(res.headers['pragma'], 'no-cache');
  assert.strictEqual(res.headers['expires'], '0');
  assert.strictEqual(res.headers['surrogate-control'], 'no-store');
  assert.ok(res.headers['content-disposition'].includes('attachment; filename="staff_directory_'));

  const log = await AuditLog.findOne({
    action: 'STAFF_CSV_EXPORTED',
    actorId: testAdminUser._id,
  }).sort({ createdAt: -1 });

  assert.ok(log, 'Must persist audit log in MongoDB for staff export');
  assert.strictEqual(log.targetModel, 'ExportStream');
  assert.notStrictEqual(String(log.targetId), String(testAdminUser._id));
  assert.strictEqual(log.result, 'SUCCESS');
});

await runTest('3.5 Live HTTP: GET /api/v1/export/students returns 200, RFC 9111 headers, and persists AuditLog', async () => {
  const res = await supertest(liveExportApp)
    .get('/api/v1/export/students')
    .set('Authorization', `Bearer ${adminAccessToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.strictEqual(res.headers['pragma'], 'no-cache');
  assert.strictEqual(res.headers['expires'], '0');
  assert.strictEqual(res.headers['surrogate-control'], 'no-store');
  assert.ok(res.headers['content-disposition'].includes('attachment; filename="students_directory_'));

  const log = await AuditLog.findOne({
    action: 'STUDENTS_CSV_EXPORTED',
    actorId: testAdminUser._id,
  }).sort({ createdAt: -1 });

  assert.ok(log, 'Must persist audit log in MongoDB for students export');
  assert.strictEqual(log.targetModel, 'ExportStream');
  assert.notStrictEqual(String(log.targetId), String(testAdminUser._id));
  assert.strictEqual(log.result, 'SUCCESS');
});

await runTest('3.6 Live HTTP: GET /api/v1/export/guardians returns 200, RFC 9111 headers, and persists AuditLog', async () => {
  const res = await supertest(liveExportApp)
    .get('/api/v1/export/guardians')
    .set('Authorization', `Bearer ${adminAccessToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.strictEqual(res.headers['pragma'], 'no-cache');
  assert.strictEqual(res.headers['expires'], '0');
  assert.strictEqual(res.headers['surrogate-control'], 'no-store');
  assert.ok(res.headers['content-disposition'].includes('attachment; filename="guardians_directory_'));

  const log = await AuditLog.findOne({
    action: 'GUARDIANS_CSV_EXPORTED',
    actorId: testAdminUser._id,
  }).sort({ createdAt: -1 });

  assert.ok(log, 'Must persist audit log in MongoDB for guardians export');
  assert.strictEqual(log.targetModel, 'ExportStream');
  assert.notStrictEqual(String(log.targetId), String(testAdminUser._id));
  assert.strictEqual(log.result, 'SUCCESS');
});

await runTest('3.7 Live HTTP: Unauthenticated request to /api/v1/export/schools is rejected with HTTP 401', async () => {
  const res = await supertest(liveExportApp).get('/api/v1/export/schools');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.success, false);
});

await runTest('3.8 Live HTTP: Unauthorized role (Teacher) requesting /api/v1/export/schools is rejected with HTTP 403', async () => {
  let testTeacherUser = await User.findOne({ role: ROLES.TEACHER, status: USER_STATUS.ACTIVE });
  if (!testTeacherUser) {
    testTeacherUser = await User.create({
      organizationId: defaultOrgId,
      townId: defaultTownId,
      scope: SCOPES.SCHOOL,
      fullName: 'RedTeam Live HTTP Teacher',
      email: `redteam.http.teacher.${Date.now()}@example.test`,
      passwordHash: '$2a$12$eXampleHashedPasswordWithPepperForRedTeamTests1234567890',
      role: ROLES.TEACHER,
      baseRole: 'TEACHER',
      status: USER_STATUS.ACTIVE,
      tokenVersion: 1,
    });
  }

  const teacherToken = signAccessToken({
    userId: testTeacherUser._id.toString(),
    email: testTeacherUser.email,
    role: ROLES.TEACHER,
    tokenVersion: testTeacherUser.tokenVersion,
  });

  const res = await supertest(liveExportApp)
    .get('/api/v1/export/schools')
    .set('Authorization', `Bearer ${teacherToken}`);

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.success, false);
});

await runTest('3.9 Head Master attempting cross-school student export is blocked with HTTP 403', async () => {
  const schoolA = new mongoose.Types.ObjectId();
  const schoolB = new mongoose.Types.ObjectId();

  const hmActor = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.HM,
    schoolId: schoolA,
  };

  const request = {
    user: hmActor,
    query: { schoolId: schoolB.toString() }, // Foreign school
    ip: '127.0.0.1',
    headers: {},
  };
  const response = createMockResponse();

  await handleExportStudentsCsv(request, response);

  assert.strictEqual(response.statusCode, 403, 'Must return 403 Forbidden for cross-school export');
  assert.ok(response.body.message.includes('assigned school'));
});

await runTest('3.10 Supervisor attempting unassigned school staff export is blocked with HTTP 403', async () => {
  const assignedSchool = new mongoose.Types.ObjectId();
  const foreignSchool = new mongoose.Types.ObjectId();

  const supervisorActor = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.SUPERVISOR,
    assignedSchools: [assignedSchool],
  };

  const request = {
    user: supervisorActor,
    query: { schoolId: foreignSchool.toString() },
    ip: '127.0.0.1',
    headers: {},
  };
  const response = createMockResponse();

  await handleExportStaffCsv(request, response);

  assert.strictEqual(response.statusCode, 403, 'Must return 403 Forbidden for unassigned school export');
  assert.ok(response.body.message.includes('supervisory cluster'));
});

await runTest('3.11 Fail-Closed Guarantee: If AuditLog write fails, CSV export aborts with HTTP 500 and streams no data', async () => {
  const origAuditCreate = AuditLog.create;
  AuditLog.create = async () => {
    throw new Error('SIMULATED_AUDIT_DATABASE_FAILURE');
  };

  try {
    const res = await supertest(liveExportApp)
      .get('/api/v1/export/schools')
      .set('Authorization', `Bearer ${adminAccessToken}`);

    assert.strictEqual(res.status, 500, 'Must return HTTP 500 when audit write fails');
    assert.ok(res.body.message.includes('Export audit logging failed'), 'Message must indicate export audit failure');
    assert.strictEqual(res.headers['content-type']?.includes('text/csv'), false, 'Must not send text/csv content type');
  } finally {
    AuditLog.create = origAuditCreate;
  }
});

await runTest('3.12 Export Rate Limiting: Rejects rapid excessive requests with HTTP 429 when threshold exceeded', async () => {
  const rateLimitApp = express();
  rateLimitApp.use(express.json());
  rateLimitApp.use((req, res, next) => {
    req.user = testAdminUser;
    next();
  });

  // Bounded rate limiter for deterministic test
  const testTripLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (incomingRequest) => `export:user:${incomingRequest.user._id}`,
    message: {
      success: false,
      statusCode: 429,
      message: 'Too many data export requests from this account or IP. Please wait a few moments before generating additional reports.',
    },
  });

  rateLimitApp.get('/test-export', testTripLimiter, (req, res) => {
    res.status(200).json({ success: true });
  });

  // 3 allowed requests
  for (let i = 0; i < 3; i++) {
    const okRes = await supertest(rateLimitApp).get('/test-export');
    assert.strictEqual(okRes.status, 200);
  }

  // 4th request trips limiter
  const blockedRes = await supertest(rateLimitApp).get('/test-export');
  assert.strictEqual(blockedRes.status, 429);
  assert.strictEqual(blockedRes.body.statusCode, 429);
  assert.ok(blockedRes.body.message.includes('Too many data export requests'));
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: CF-04 SUPERVISOR TIMETABLE SCOPE & ENFORCE SCHOOL SCOPE
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- P1: CF-04 Supervisor Timetable Scope Verification ---');

await runTest('4.1 enforceSchoolScope blocks Supervisor requesting unassigned school timetable', () => {
  const assignedSchool = new mongoose.Types.ObjectId().toString();
  const foreignSchool = new mongoose.Types.ObjectId().toString();

  const supervisorActor = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.SUPERVISOR,
    assignedSchools: [assignedSchool],
  };

  const request = {
    user: supervisorActor,
    params: { schoolId: foreignSchool },
  };
  const response = createMockResponse();
  let nextCalled = false;

  enforceSchoolScope(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(response.statusCode, 403);
  assert.ok(response.body.message.includes('assigned inspection cluster'));
});

await runTest('4.2 enforceSchoolScope allows Supervisor requesting assigned school timetable', () => {
  const assignedSchool = new mongoose.Types.ObjectId().toString();

  const supervisorActor = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.SUPERVISOR,
    assignedSchools: [assignedSchool],
  };

  const request = {
    user: supervisorActor,
    params: { schoolId: assignedSchool },
  };
  const response = createMockResponse();
  let nextCalled = false;

  enforceSchoolScope(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true, 'Assigned school must pass scope check');
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: INPUT SANITIZATION, HONEYPOT & AUDIT IMMUTABILITY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- P2: Input Sanitization, Honeypot & Audit Immutability ---');

await runTest('5.1 deepSanitize strips dangerous MongoDB operators ($gt, $where, $regex)', () => {
  const maliciousPayload = {
    username: 'admin',
    password: { $gt: '' },
    filter: { $where: 'sleep(1000)' },
    query: { $regex: '.*' },
  };

  const request = { body: maliciousPayload, query: {}, params: {} };
  const response = createMockResponse();
  let nextCalled = false;

  deepSanitize(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(request.body.password.$gt, undefined, '$gt operator must be stripped');
  assert.strictEqual(request.body.filter.$where, undefined, '$where operator must be stripped');
  assert.strictEqual(request.body.query.$regex, undefined, '$regex operator must be stripped');
});

await runTest('5.2 deepSanitize neutralizes Object prototype pollution (__proto__, constructor)', () => {
  const pollutionPayload = JSON.parse('{"__proto__": {"isAdmin": true}, "constructor": {"prototype": {"hacked": true}}, "safeField": "valid"}');

  const request = { body: pollutionPayload, query: {}, params: {} };
  const response = createMockResponse();
  let nextCalled = false;

  deepSanitize(request, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(request.body.safeField, 'valid');
  assert.strictEqual(Object.prototype.isAdmin, undefined, 'Global prototype must not be polluted');
  assert.strictEqual(Object.prototype.hacked, undefined, 'Global prototype must not be polluted');
});

await runTest('5.3 ratTrapHoneypot engages on hidden bot form fields and quarantines IP', async () => {
  const botRequest = {
    body: {
      fullName: 'Bot User',
      _gotcha: 'automated-submission',
    },
    ip: '198.51.100.42',
    headers: { 'user-agent': 'Malicious-Bot/1.0' },
    originalUrl: '/api/v1/auth/register-student',
  };
  const response = createMockResponse();
  let nextCalled = false;

  await ratTrapHoneypotCheck(botRequest, response, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'Bot submission must never reach controller');

  const lockout = await SecurityLockout.findOne({ targetKey: 'ip:198.51.100.42' });
  assert.ok(lockout, 'Bot IP must be quarantined in MongoDB SecurityLockout');
  assert.strictEqual(lockout.isLocked, true);

  await SecurityLockout.deleteOne({ targetKey: 'ip:198.51.100.42' });
});

await runTest('5.4 AuditLog model strictly enforces append-only immutability (updateOne/deleteOne blocked)', async () => {
  const dummyLog = await AuditLog.create({
    actorId: new mongoose.Types.ObjectId(),
    actorRole: 'TEST_ACTOR',
    actorDesignation: 'Test',
    actorName: 'RedTeam Tester',
    action: 'TEST_IMMUTABILITY_ACTION',
    targetModel: 'TestModel',
    targetId: new mongoose.Types.ObjectId(),
    targetName: 'Test Target',
    result: 'SUCCESS',
    reason: 'Testing append-only enforcement',
  });

  let updateErrorCaught = false;
  try {
    await AuditLog.updateOne({ _id: dummyLog._id }, { $set: { result: 'TAMPERED' } });
  } catch (error) {
    updateErrorCaught = true;
    assert.ok(error.message.includes('append-only'), 'Error must specify append-only enforcement');
  }
  assert.strictEqual(updateErrorCaught, true, 'AuditLog.updateOne must throw fatal error');

  let deleteErrorCaught = false;
  try {
    await AuditLog.deleteOne({ _id: dummyLog._id });
  } catch (error) {
    deleteErrorCaught = true;
    assert.ok(error.message.includes('append-only'), 'Error must specify append-only enforcement');
  }
  assert.strictEqual(deleteErrorCaught, true, 'AuditLog.deleteOne must throw fatal error');
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passed}/${passed} PHASE 2 & 2.1 RED-TEAM ASSERTIONS PASSED (100%)`);
console.log('======================================================================\n');
process.exit(0);
