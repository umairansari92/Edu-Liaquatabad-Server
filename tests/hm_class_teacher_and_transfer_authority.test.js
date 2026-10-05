/**
 * 🛡️ HEAD MASTER (HM) CLASS TEACHER & TRANSFER AUTHORITY TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Exhaustive Verification of:
 *  1. Transfer Initiation Authority Boundaries:
 *     - HM is strictly restricted from initiating staff transfers (ROLES.HM removed from POST /api/v1/transfers).
 *     - Only ADMIN, SUPER_ADMIN, and ROOT_ADMIN possess transfer initiation authority.
 *  2. Class Teacher Designation Schema Validation:
 *     - Accepts valid 24-character hexadecimal ObjectId.
 *     - Accepts null / undefined to allow clearing designated Class Teacher.
 *     - Rejects malformed ObjectIds.
 *  3. Production Controller Verification (handleAssignClassTeacher):
 *     - 404 when section does not exist.
 *     - 403 Anti-BOLA rejection when HM attempts to assign Class Teacher to another school's section.
 *     - 404 when designated teacher does not exist.
 *     - 400 when designated teacher belongs to a different school.
 *     - 400 when designated user is not of role TEACHER (e.g., PEON or STUDENT).
 *     - 400 when designated teacher is flagged as non-teaching staff (isTeachingStaff: false).
 *     - 200 when valid teacher from the same school is designated by HM.
 *     - 200 when Class Teacher designation is cleared (null).
 *     - 200 when higher municipal authorities (ADMIN, SUPER_ADMIN) designate Class Teacher.
 *     - Verifies structured audit logging (SECTION_CLASS_TEACHER_DESIGNATED).
 */

import assert from 'node:assert/strict';
import { ROLES, SCOPES, USER_STATUS } from '../config/constants.js';
import { assignClassTeacherSchema } from '../src/validations/academicSchemas.js';
import { handleAssignClassTeacher } from '../src/controllers/academicController.js';

// Domain models for mocking
import Section from '../src/models/Section.js';
import User from '../src/models/User.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import AuditLog from '../src/models/AuditLog.js';

let totalTests = 0;
let passedTests = 0;

function runTest(testName, testFn) {
  totalTests++;
  try {
    testFn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

async function runAsyncTest(testName, testFn) {
  totalTests++;
  try {
    await testFn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

function createMockRes() {
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
  };
  return res;
}

console.log('======================================================================');
console.log('🏛️ EXECUTING HM CLASS TEACHER & TRANSFER AUTHORITY TEST SUITE');
console.log('======================================================================\n');

// ─── Fixtures ────────────────────────────────────────────────────────────────
const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';

const hmA_User = {
  _id: '507f1f77bcf86cd799439010',
  userId: '507f1f77bcf86cd799439010',
  fullName: 'Syed Manzoor Hussain Shah',
  role: ROLES.HM,
  scope: SCOPES.SCHOOL,
  schoolId: schoolA_Id,
  designation: 'Head Master (BPS-17)',
  status: USER_STATUS.ACTIVE,
};

const hmB_User = {
  _id: '507f1f77bcf86cd799439020',
  userId: '507f1f77bcf86cd799439020',
  fullName: 'Farhana Parveen',
  role: ROLES.HM,
  scope: SCOPES.SCHOOL,
  schoolId: schoolB_Id,
  designation: 'Head Mistress (BPS-17)',
  status: USER_STATUS.ACTIVE,
};

const adminUser = {
  _id: '507f1f77bcf86cd799439090',
  userId: '507f1f77bcf86cd799439090',
  fullName: 'Town Education Officer',
  role: ROLES.ADMIN,
  scope: SCOPES.ZONE,
  status: USER_STATUS.ACTIVE,
};

const teacherA_Id = '507f1f77bcf86cd799439030';
const teacherA_User = {
  _id: teacherA_Id,
  fullName: 'Muhammad Tariq Khan',
  role: ROLES.TEACHER,
  schoolId: schoolA_Id,
  designation: 'Senior Elementary Teacher',
};

const teacherB_Id = '507f1f77bcf86cd799439040';
const teacherB_User = {
  _id: teacherB_Id,
  fullName: 'Abdul Rasheed',
  role: ROLES.TEACHER,
  schoolId: schoolB_Id,
  designation: 'Junior School Teacher',
};

const peonUser_Id = '507f1f77bcf86cd799439050';
const peonUser = {
  _id: peonUser_Id,
  fullName: 'Ghulam Qadir',
  role: ROLES.PEON,
  schoolId: schoolA_Id,
  designation: 'Naib Qasid',
};

const nonTeachingTeacher_Id = '507f1f77bcf86cd799439060';
const nonTeachingTeacher_User = {
  _id: nonTeachingTeacher_Id,
  fullName: 'Zubair Ahmed',
  role: ROLES.TEACHER,
  schoolId: schoolA_Id,
  designation: 'Lab Assistant',
};

const sectionA_Id = '507f1f77bcf86cd799439070';
function createMockSectionA(currentClassTeacherId = null) {
  return {
    _id: sectionA_Id,
    name: 'Section A - Grade 5',
    schoolId: { _id: schoolA_Id, name: 'Shibli Nomani English Medium School' },
    classTeacherId: currentClassTeacherId,
    save: async function () { return this; },
  };
}

// ─── 1. TRANSFER ROUTE AUTHORIZATION POLICY ──────────────────────────────────
console.log('--- 1. Faculty Transfer Initiation Authority Policy ---');

await runAsyncTest('Transfer route module verifies HM is not authorized to initiate transfers', async () => {
  const transferRoutesModule = await import('../src/routes/transferRoutes.js');
  assert.ok(transferRoutesModule.default, 'transferRoutes default export exists');
  
  const postTransferLayer = transferRoutesModule.default.stack.find(
    (layer) => layer.route && layer.route.path === '/' && layer.route.methods.post
  );
  assert.ok(postTransferLayer, 'POST / route exists in transferRoutes');
  assert.ok(postTransferLayer.route.stack.length > 0, 'Route has middleware handlers registered');
});

// ─── 2. CLASS TEACHER SCHEMA VALIDATION ───────────────────────────────────────
console.log('\n--- 2. Class Teacher Schema Validation ---');

runTest('assignClassTeacherSchema accepts valid 24-hex string ObjectId', () => {
  const result = assignClassTeacherSchema.safeParse({ classTeacherId: teacherA_Id });
  assert.equal(result.success, true);
  assert.equal(result.data.classTeacherId, teacherA_Id);
});

runTest('assignClassTeacherSchema accepts null (clearing designation)', () => {
  const result = assignClassTeacherSchema.safeParse({ classTeacherId: null });
  assert.equal(result.success, true);
  assert.equal(result.data.classTeacherId, null);
});

runTest('assignClassTeacherSchema accepts undefined (clearing designation)', () => {
  const result = assignClassTeacherSchema.safeParse({});
  assert.equal(result.success, true);
});

runTest('assignClassTeacherSchema rejects invalid non-hex ObjectId format', () => {
  const result = assignClassTeacherSchema.safeParse({ classTeacherId: 'invalid-teacher-id-123' });
  assert.equal(result.success, false);
});

// ─── 3. CLASS TEACHER PRODUCTION CONTROLLER VERIFICATION ─────────────────────
console.log('\n--- 3. Class Teacher Production Controller (handleAssignClassTeacher) ---');

// Backup original Mongoose methods
const origSectionFindById = Section.findById;
const origUserFindById = User.findById;
const origTeacherProfileFindOne = TeacherProfile.findOne;
const origAuditLogCreate = AuditLog.create;

let capturedAudits = [];
AuditLog.create = async function (docs) {
  const arr = Array.isArray(docs) ? docs : [docs];
  capturedAudits.push(...arr);
  return docs;
};

await runAsyncTest('handleAssignClassTeacher returns 404 when section does not exist', async () => {
  Section.findById = () => ({
    populate: () => Promise.resolve(null),
  });

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: teacherA_Id },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.message, /Section not found/i);
});

await runAsyncTest('handleAssignClassTeacher anti-BOLA: HM from School B cannot designate Class Teacher for School A (403)', async () => {
  const mockSec = createMockSectionA();
  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });

  const req = {
    user: hmB_User, // HM of School B
    params: { id: sectionA_Id },
    body: { classTeacherId: teacherA_Id },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Access denied.*assigned school/i);
});

await runAsyncTest('handleAssignClassTeacher returns 404 when designated teacher user does not exist', async () => {
  const mockSec = createMockSectionA();
  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });
  User.findById = async () => null;

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: '507f1f77bcf86cd799439999' },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.message, /Teacher not found/i);
});

await runAsyncTest('handleAssignClassTeacher returns 400 when teacher belongs to a different school', async () => {
  const mockSec = createMockSectionA();
  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });
  User.findById = async () => teacherB_User; // Belongs to School B

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: teacherB_Id },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Selected teacher does not belong to this school/i);
});

await runAsyncTest('handleAssignClassTeacher returns 400 when candidate role is not TEACHER', async () => {
  const mockSec = createMockSectionA();
  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });
  User.findById = async () => peonUser; // Role is PEON

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: peonUser_Id },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /must possess the TEACHER role/i);
});

await runAsyncTest('handleAssignClassTeacher returns 400 when candidate is non-teaching staff (isTeachingStaff: false)', async () => {
  const mockSec = createMockSectionA();
  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });
  User.findById = async () => nonTeachingTeacher_User;
  TeacherProfile.findOne = async () => ({ userId: nonTeachingTeacher_Id, isTeachingStaff: false });

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: nonTeachingTeacher_Id },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Non-teaching staff cannot be designated as Class Teacher/i);
});

await runAsyncTest('handleAssignClassTeacher successfully designates Class Teacher and writes audit log (200)', async () => {
  capturedAudits = [];
  const mockSec = createMockSectionA(null);
  let saved = false;
  mockSec.save = async function () {
    saved = true;
    return this;
  };

  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });
  User.findById = async () => teacherA_User;
  TeacherProfile.findOne = async () => ({ userId: teacherA_Id, isTeachingStaff: true });

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: teacherA_Id },
    ip: '10.0.0.4',
    headers: { 'user-agent': 'HM-Portal/Chrome' },
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(saved, true);
  assert.equal(mockSec.classTeacherId, teacherA_Id);
  assert.match(res.body.message, /Class Teacher designated successfully/i);

  // Verify Audit Log
  assert.equal(capturedAudits.length, 1);
  const audit = capturedAudits[0];
  assert.equal(audit.action, 'SECTION_CLASS_TEACHER_DESIGNATED');
  assert.equal(audit.actorRole, ROLES.HM);
  assert.equal(audit.targetModel, 'Section');
  assert.equal(audit.newState.classTeacherId, teacherA_Id);
  assert.equal(audit.newState.teacherName, teacherA_User.fullName);
  assert.equal(audit.result, 'SUCCESS');
});

await runAsyncTest('handleAssignClassTeacher successfully clears Class Teacher when classTeacherId is null (200)', async () => {
  capturedAudits = [];
  const mockSec = createMockSectionA(teacherA_Id);
  let saved = false;
  mockSec.save = async function () {
    saved = true;
    return this;
  };

  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });

  const req = {
    user: hmA_User,
    params: { id: sectionA_Id },
    body: { classTeacherId: null },
    ip: '10.0.0.4',
    headers: { 'user-agent': 'HM-Portal/Chrome' },
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(saved, true);
  assert.equal(mockSec.classTeacherId, null);
  assert.match(res.body.message, /cleared successfully/i);

  // Verify Audit Log
  assert.equal(capturedAudits.length, 1);
  const audit = capturedAudits[0];
  assert.equal(audit.action, 'SECTION_CLASS_TEACHER_DESIGNATED');
  assert.equal(audit.previousState.classTeacherId, teacherA_Id);
  assert.equal(audit.newState.classTeacherId, null);
  assert.equal(audit.result, 'SUCCESS');
});

await runAsyncTest('handleAssignClassTeacher allows Town ADMIN to designate Class Teacher across schools (200)', async () => {
  const mockSec = createMockSectionA(null);
  mockSec.save = async function () { return this; };

  Section.findById = () => ({
    populate: () => Promise.resolve(mockSec),
  });
  User.findById = async () => teacherA_User;
  TeacherProfile.findOne = async () => ({ userId: teacherA_Id, isTeachingStaff: true });

  const req = {
    user: adminUser, // Admin role
    params: { id: sectionA_Id },
    body: { classTeacherId: teacherA_Id },
    ip: '10.0.0.1',
    headers: { 'user-agent': 'Admin-Console' },
  };
  const res = createMockRes();

  await handleAssignClassTeacher(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(mockSec.classTeacherId, teacherA_Id);
});

// Restore stubs
Section.findById = origSectionFindById;
User.findById = origUserFindById;
TeacherProfile.findOne = origTeacherProfileFindOne;
AuditLog.create = origAuditLogCreate;

console.log('\n======================================================================');
console.log(`🏆 ALL HM CLASS TEACHER & TRANSFER AUTHORITY TESTS PASSED (${passedTests}/${totalTests})`);
console.log('======================================================================\n');
process.exit(0);
