/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🛡️ PARENT BFF (BACKEND-FOR-FRONTEND) SECURITY & INVARIANTS TEST SUITE
 * Education Department, Liaquatabad Town Centre (DMC)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifies Phase 3, Wave 3 Parent BFF Security Contract & Invariants:
 *
 * Core Security Invariant:
 * Authenticated Parent → VERIFIED ParentStudentLink → exact studentProfileId match → allow, otherwise 403.
 *
 * Verification Scenarios:
 *  01. Unauthenticated or non-parent actor blocked with 403 Forbidden
 *  02. Malformed or non-hex studentProfileId parameter rejected with 400 Bad Request
 *  03. Cross-Parent IDOR on ward profile blocked with 403 Forbidden
 *  04. Cross-Parent IDOR on ward attendance blocked with 403 Forbidden
 *  05. Cross-Parent IDOR on ward marksheets blocked with 403 Forbidden
 *  06. Cross-Parent IDOR on ward homework blocked with 403 Forbidden
 *  07. Cross-Parent IDOR on ward circulars blocked with 403 Forbidden
 *  08. Inactive / PENDING_OTP link blocked from accessing ward BFF with 403 Forbidden
 *  09. Inactive / PENDING_HM_APPROVAL link blocked from accessing ward BFF with 403 Forbidden
 *  10. Inactive / REJECTED or REVOKED link blocked from accessing ward BFF with 403 Forbidden
 *  11. Intercepted unauthorized access emits immutable PARENT_CROSS_WARD_ACCESS_BLOCKED audit log with DENIED status
 *  12. Legitimate parent with VERIFIED link receives sanitized ward profile with 200 OK
 *  13. Legitimate parent with VERIFIED link retrieves ward attendance analytics & history with 200 OK
 *  14. Legitimate parent with VERIFIED link retrieves published marksheet results with 200 OK
 *  15. Marksheet Publication Gate strictly hides DRAFT / SUBMITTED examination results
 *  16. Legitimate parent with VERIFIED link retrieves active homework and school/town circulars with 200 OK
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  BASE_ROLES,
  USER_STATUS,
  PARENT_STUDENT_LINK_STATUS,
  PARENT_RELATIONSHIP,
  STUDENT_STATUS,
} from '../config/constants.js';

import ParentStudentLink from '../src/models/ParentStudentLink.js';
import StudentProfile from '../src/models/StudentProfile.js';
import AuditLog from '../src/models/AuditLog.js';
import Result from '../src/models/Result.js';
import Exam from '../src/models/Exam.js';
import Homework from '../src/models/Homework.js';
import Document from '../src/models/Document.js';
import Attendance from '../src/models/Attendance.js';

import { verifyParentWardLink } from '../src/middlewares/verifyParentWardLink.js';
import {
  handleGetWardProfile,
  handleGetWardAttendance,
  handleGetWardMarksheets,
  handleGetWardHomework,
  handleGetWardCirculars,
} from '../src/controllers/parentBffController.js';

let totalTests = 0;
let passedTests = 0;

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

function createMockResponse() {
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
    setHeader(key, val) {
      this.headers[key] = val;
    },
    send(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

function makeChainable(mockData) {
  return {
    _data: mockData,
    populate() { return this; },
    sort() { return this; },
    limit() { return this; },
    skip() { return this; },
    select() { return this; },
    lean() { return Promise.resolve(this._data); },
    then(resolve, reject) { return Promise.resolve(this._data).then(resolve, reject); },
  };
}

console.log('======================================================================');
console.log('🛡️ RUNNING PARENT BFF SECURITY & INVARIANTS TEST SUITE (PHASE 3 WAVE 3)');
console.log('======================================================================\n');

// ─── Test Identifiers ────────────────────────────────────────────────────────
const parentA_Id = '507f1f77bcf86cd799439001';
const parentB_Id = '507f1f77bcf86cd799439002';
const studentProfile1_Id = '607f1f77bcf86cd799439011';
const studentProfile2_Id = '607f1f77bcf86cd799439012';
const studentUser1_Id = '507f1f77bcf86cd799439021';
const studentUser2_Id = '507f1f77bcf86cd799439022';
const school1_Id = '507f1f77bcf86cd799439031';
const town1_Id = '507f1f77bcf86cd799439041';
const class1_Id = '507f1f77bcf86cd799439051';
const section1_Id = '507f1f77bcf86cd799439061';

const mockParentAUser = {
  _id: parentA_Id,
  fullName: 'Tariq Mehmood (Parent A)',
  email: 'tariq.parent@gmail.com',
  role: ROLES.PARENT,
  baseRole: BASE_ROLES.PARENT,
  status: USER_STATUS.ACTIVE,
};

const mockParentBUser = {
  _id: parentB_Id,
  fullName: 'Kamran Akmal (Parent B)',
  email: 'kamran.parent@gmail.com',
  role: ROLES.PARENT,
  baseRole: BASE_ROLES.PARENT,
  status: USER_STATUS.ACTIVE,
};

const mockTeacherUser = {
  _id: '507f1f77bcf86cd799439009',
  fullName: 'Sir Aslam',
  role: ROLES.TEACHER,
  baseRole: BASE_ROLES.TEACHER,
  status: USER_STATUS.ACTIVE,
};

const mockWardProfile1 = {
  _id: studentProfile1_Id,
  userId: { _id: studentUser1_Id, fullName: 'Ahmed Tariq', email: 'ahmed@student.dmc.edu.pk' },
  schoolId: { _id: school1_Id, name: 'GBSS No 1 Liaquatabad', code: 'GBSS-01', emisCode: '4080101', townId: town1_Id },
  classId: { _id: class1_Id, name: 'Class 5', numericGrade: 5 },
  sectionId: { _id: section1_Id, name: 'A' },
  grNumber: 1042,
  gender: 'MALE',
  dateOfBirth: '2014-04-12',
  enrollmentDate: '2020-04-01',
  lifecycleStatus: STUDENT_STATUS.ACTIVE,
};

const mockWardProfile2 = {
  _id: studentProfile2_Id,
  userId: { _id: studentUser2_Id, fullName: 'Bilal Kamran', email: 'bilal@student.dmc.edu.pk' },
  schoolId: { _id: school1_Id, name: 'GBSS No 1 Liaquatabad', code: 'GBSS-01', emisCode: '4080101', townId: town1_Id },
  classId: { _id: class1_Id, name: 'Class 5', numericGrade: 5 },
  sectionId: { _id: section1_Id, name: 'A' },
  grNumber: 1043,
  gender: 'MALE',
  dateOfBirth: '2014-06-20',
  enrollmentDate: '2020-04-01',
  lifecycleStatus: STUDENT_STATUS.ACTIVE,
};

// ─── Tests Execution ─────────────────────────────────────────────────────────

await runAsyncTest('Scenario 01: Unauthenticated or non-parent actor blocked with 403 Forbidden', async () => {
  const req = {
    user: mockTeacherUser,
    params: { studentProfileId: studentProfile1_Id },
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
  assert.match(res.body.message, /Parent authority required/i);
});

await runAsyncTest('Scenario 02: Malformed or non-hex studentProfileId parameter rejected with 400 Bad Request', async () => {
  const req = {
    user: mockParentAUser,
    params: { studentProfileId: 'invalid-id-not-hex' },
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(nextCalled, false);
  assert.match(res.body.message, /Invalid student profile identifier/i);
});

await runAsyncTest('Scenario 03: Cross-Parent IDOR on ward profile blocked with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  const origAuditCreate = AuditLog.create;

  // Simulate DB finding no link between Parent A and Ward 2 (Ward 2 belongs to Parent B)
  ParentStudentLink.findOne = () => makeChainable(null);
  let auditCaptured = null;
  AuditLog.create = async (payload) => {
    auditCaptured = payload;
    return { _id: 'audit_idor_1' };
  };

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile2_Id },
    originalUrl: `/api/v1/parent/wards/${studentProfile2_Id}/profile`,
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
  assert.match(res.body.message, /do not hold an active, verified parental link/i);
  assert.strictEqual(auditCaptured.action, 'PARENT_CROSS_WARD_ACCESS_BLOCKED');
  assert.strictEqual(auditCaptured.result, 'DENIED');

  ParentStudentLink.findOne = origFindOne;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 04: Cross-Parent IDOR on ward attendance blocked with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable(null);

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile2_Id },
    originalUrl: `/api/v1/parent/wards/${studentProfile2_Id}/attendance`,
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 05: Cross-Parent IDOR on ward marksheets blocked with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable(null);

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile2_Id },
    originalUrl: `/api/v1/parent/wards/${studentProfile2_Id}/marksheets`,
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 06: Cross-Parent IDOR on ward homework blocked with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable(null);

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile2_Id },
    originalUrl: `/api/v1/parent/wards/${studentProfile2_Id}/homework`,
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 07: Cross-Parent IDOR on ward circulars blocked with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable(null);

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile2_Id },
    originalUrl: `/api/v1/parent/wards/${studentProfile2_Id}/circulars`,
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 08: Inactive / PENDING_OTP link blocked from accessing ward BFF with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable({
    parentId: parentA_Id,
    studentProfileId: studentProfile1_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
  });

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile1_Id },
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 09: Inactive / PENDING_HM_APPROVAL link blocked from accessing ward BFF with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable({
    parentId: parentA_Id,
    studentProfileId: studentProfile1_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
  });

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile1_Id },
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 10: Inactive / REJECTED or REVOKED link blocked from accessing ward BFF with 403 Forbidden', async () => {
  const origFindOne = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => makeChainable({
    parentId: parentA_Id,
    studentProfileId: studentProfile1_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.REVOKED,
  });

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile1_Id },
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);

  ParentStudentLink.findOne = origFindOne;
});

await runAsyncTest('Scenario 11: Intercepted unauthorized access emits immutable PARENT_CROSS_WARD_ACCESS_BLOCKED audit log with DENIED status', async () => {
  const origFindOne = ParentStudentLink.findOne;
  const origAuditCreate = AuditLog.create;

  ParentStudentLink.findOne = () => makeChainable(null);
  let auditCaptured = null;
  AuditLog.create = async (payload) => {
    auditCaptured = payload;
    return { _id: 'audit_blocked_99' };
  };

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile2_Id },
    originalUrl: `/api/v1/parent/wards/${studentProfile2_Id}/attendance`,
  };
  const res = createMockResponse();

  await verifyParentWardLink(req, res, () => {});

  assert.ok(auditCaptured, 'Audit log must be emitted');
  assert.strictEqual(auditCaptured.action, 'PARENT_CROSS_WARD_ACCESS_BLOCKED');
  assert.strictEqual(auditCaptured.result, 'DENIED');
  assert.strictEqual(auditCaptured.targetId, studentProfile2_Id);
  assert.strictEqual(auditCaptured.actorId, parentA_Id);

  ParentStudentLink.findOne = origFindOne;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 12: Legitimate parent with VERIFIED link receives sanitized ward profile with 200 OK', async () => {
  const origLinkFindOne = ParentStudentLink.findOne;
  const origProfileFindById = StudentProfile.findById;

  const mockVerifiedLink = {
    _id: 'link_111',
    parentId: parentA_Id,
    studentProfileId: studentProfile1_Id,
    schoolId: school1_Id,
    relationship: PARENT_RELATIONSHIP.FATHER,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
    hmVerifiedAt: new Date('2026-09-20'),
  };

  ParentStudentLink.findOne = () => makeChainable(mockVerifiedLink);
  StudentProfile.findById = () => makeChainable(mockWardProfile1);

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: studentProfile1_Id },
  };
  const res = createMockResponse();
  let nextCalled = false;

  await verifyParentWardLink(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.ok(req.parentWardLink);
  assert.ok(req.wardProfile);

  // Now execute handleGetWardProfile
  const profileRes = createMockResponse();
  await handleGetWardProfile(req, profileRes);

  assert.strictEqual(profileRes.statusCode, 200);
  assert.strictEqual(profileRes.body.data.fullName, 'Ahmed Tariq');
  assert.strictEqual(profileRes.body.data.grNumber, 1042);
  assert.strictEqual(profileRes.body.data.relationship, PARENT_RELATIONSHIP.FATHER);
  assert.strictEqual(profileRes.body.data.school.name, 'GBSS No 1 Liaquatabad');

  ParentStudentLink.findOne = origLinkFindOne;
  StudentProfile.findById = origProfileFindById;
});

await runAsyncTest('Scenario 13: Legitimate parent with VERIFIED link retrieves ward attendance analytics & history with 200 OK', async () => {
  const origAttendanceFind = Attendance.find;

  Attendance.find = () => makeChainable([
    {
      date: '2026-09-25',
      records: [{ userId: studentUser1_Id, status: 'PRESENT', remarks: '' }],
    },
    {
      date: '2026-09-24',
      records: [{ userId: studentUser1_Id, status: 'ABSENT', remarks: 'Fever' }],
    },
  ]);

  const req = {
    user: mockParentAUser,
    wardProfile: mockWardProfile1,
    parentWardLink: { relationship: PARENT_RELATIONSHIP.FATHER },
  };
  const res = createMockResponse();

  await handleGetWardAttendance(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.data.summary);
  assert.strictEqual(res.body.data.history.length, 2);
  assert.strictEqual(res.body.data.history[0].status, 'PRESENT');
  assert.strictEqual(res.body.data.history[1].status, 'ABSENT');

  Attendance.find = origAttendanceFind;
});

await runAsyncTest('Scenario 14: Legitimate parent with VERIFIED link retrieves published marksheet results with 200 OK', async () => {
  const origResultFind = Result.find;

  Result.find = () => makeChainable([
    {
      _id: 'result_pub_1',
      studentId: studentUser1_Id,
      status: 'PUBLISHED',
      totalMarksObtained: 615,
      totalMaxMarks: 700,
      percentage: 87.86,
      grade: 'A-1',
      rankFormatted: '1st in Section A',
      examId: {
        _id: 'exam_term_1',
        title: 'Mid-Term Examination 2026',
        term: 'Mid-Term',
        academicYear: '2025-2026',
        totalMarks: 700,
        passingMarks: 231,
      },
      subjectMarks: [
        {
          subjectId: { _id: 'sub_eng', name: 'English', code: 'ENG' },
          totalObtained: 88,
          maxMarks: 100,
          passingMarks: 33,
          isPassed: true,
          grade: 'A-1',
        },
      ],
    },
  ]);

  const req = {
    user: mockParentAUser,
    wardProfile: mockWardProfile1,
    parentWardLink: { relationship: PARENT_RELATIONSHIP.FATHER },
  };
  const res = createMockResponse();

  await handleGetWardMarksheets(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.count, 1);
  assert.strictEqual(res.body.data.marksheets[0].grade, 'A-1');
  assert.strictEqual(res.body.data.marksheets[0].rankFormatted, '1st in Section A');

  Result.find = origResultFind;
});

await runAsyncTest('Scenario 15: Marksheet Publication Gate strictly hides DRAFT / SUBMITTED examination results', async () => {
  const origResultFind = Result.find;

  // Result.find should filter status: 'PUBLISHED' in production controller.
  // We verify that passing query strictly includes status: 'PUBLISHED'
  let capturedQuery = null;
  Result.find = (query) => {
    capturedQuery = query;
    return makeChainable([]); // Empty because non-published are excluded
  };

  const req = {
    user: mockParentAUser,
    wardProfile: mockWardProfile1,
    parentWardLink: { relationship: PARENT_RELATIONSHIP.FATHER },
  };
  const res = createMockResponse();

  await handleGetWardMarksheets(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(capturedQuery.status, 'PUBLISHED');
  assert.strictEqual(capturedQuery.studentId, studentUser1_Id);

  Result.find = origResultFind;
});

await runAsyncTest('Scenario 16: Legitimate parent with VERIFIED link retrieves active homework and school/town circulars with 200 OK', async () => {
  const origHomeworkFind = Homework.find;
  const origDocumentFind = Document.find;

  Homework.find = () => makeChainable([
    {
      _id: 'hw_math_1',
      title: 'Chapter 4 Fractions Exercises',
      description: 'Solve questions 1-10 on notebook.',
      dueDate: new Date('2026-10-01'),
      subjectId: { _id: 'sub_math', name: 'Mathematics', code: 'MATH' },
      teacherId: { _id: 'teacher_1', fullName: 'Sir Naveed', designation: 'PST Teacher' },
    },
  ]);

  Document.find = () => makeChainable([
    {
      _id: 'doc_rain_1',
      title: 'Emergency Rain Advisory & School Timing Notification',
      documentType: 'CIRCULAR',
      scope: 'TOWN',
      category: 'EMERGENCY',
      summary: 'Heavy rainfall forecasted across Liaquatabad Town.',
      fileUrl: 'https://cloudinary.com/dmc/rain_advisory.pdf',
      publishedAt: new Date('2026-09-25'),
      publishedBy: { fullName: 'Town Education Officer', designation: 'TEO' },
    },
  ]);

  const req = {
    user: mockParentAUser,
    wardProfile: mockWardProfile1,
    parentWardLink: { relationship: PARENT_RELATIONSHIP.FATHER },
    query: {},
  };

  // Test Homework
  const hwRes = createMockResponse();
  await handleGetWardHomework(req, hwRes);
  assert.strictEqual(hwRes.statusCode, 200);
  assert.strictEqual(hwRes.body.data.count, 1);
  assert.strictEqual(hwRes.body.data.homework[0].title, 'Chapter 4 Fractions Exercises');

  // Test Circulars
  const circRes = createMockResponse();
  await handleGetWardCirculars(req, circRes);
  assert.strictEqual(circRes.statusCode, 200);
  assert.strictEqual(circRes.body.data.count, 1);
  assert.strictEqual(circRes.body.data.circulars[0].title, 'Emergency Rain Advisory & School Timing Notification');

  Homework.find = origHomeworkFind;
  Document.find = origDocumentFind;
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} PARENT BFF SECURITY TESTS PASSED!`);
console.log('======================================================================\n');
