/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🛡️ PARENT PORTAL - HEAD MASTER VERIFICATION BRIDGE TEST SUITE
 * Education Department, Liaquatabad Town Centre (DMC)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifies End-to-End Parent-HM Verification Loop & BFF Entitlements:
 *  1. HM Parent Link Queue scoping by schoolId and status filtering
 *  2. Cross-school BOLA prevention on verification decisions
 *  3. HM physical verification approval (B-Form & CNIC checklist confirmation)
 *  4. Idempotency & state machine validation (no duplicate approvals)
 *  5. Immediate parent access to verified ward directory (handleGetMyWards)
 *  6. Immediate parent access to all 5 Ward BFF endpoints post-verification
 *  7. Blocking of unapproved claims (PENDING_HM_APPROVAL) across all BFF endpoints
 *  8. Rejection lifecycle with mandatory minimum 10-char reason
 *  9. Revocation lifecycle and immediate termination of ward BFF access
 * 10. Audit logging and parent notification dispatch integrity
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  BASE_ROLES,
  SCOPES,
  USER_STATUS,
  PARENT_STUDENT_LINK_STATUS,
  PARENT_RELATIONSHIP,
  STUDENT_STATUS,
} from '../config/constants.js';

import ParentStudentLink from '../src/models/ParentStudentLink.js';
import StudentProfile from '../src/models/StudentProfile.js';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';
import Result from '../src/models/Result.js';
import Exam from '../src/models/Exam.js';
import Homework from '../src/models/Homework.js';
import Document from '../src/models/Document.js';
import Attendance from '../src/models/Attendance.js';

import {
  handleGetHmParentLinks,
  handleHmVerifyParentLink,
  handleHmRejectParentLink,
  handleHmRevokeParentLink,
  handleGetMyWards,
} from '../src/controllers/parentLinkController.js';

import { verifyParentWardLink } from '../src/middlewares/verifyParentWardLink.js';
import {
  handleGetWardProfile,
  handleGetWardAttendance,
  handleGetWardMarksheets,
  handleGetWardHomework,
  handleGetWardCirculars,
} from '../src/controllers/parentBffController.js';

import {
  hmVerifyLinkSchema,
  hmRejectLinkSchema,
  hmRevokeLinkSchema,
} from '../src/validations/parentSchemas.js';

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
console.log('🛡️ RUNNING PARENT PORTAL - HM VERIFICATION BRIDGE TEST SUITE');
console.log('======================================================================\n');

// ─── Test Identities ─────────────────────────────────────────────────────────
const schoolA_Id = new mongoose.Types.ObjectId();
const schoolB_Id = new mongoose.Types.ObjectId();

const hmA_Id = new mongoose.Types.ObjectId();
const hmB_Id = new mongoose.Types.ObjectId();

const parentA_Id = new mongoose.Types.ObjectId();
const student1_Id = new mongoose.Types.ObjectId();

const mockHmAUser = {
  _id: hmA_Id,
  role: ROLES.HM,
  baseRole: BASE_ROLES.HM,
  schoolId: schoolA_Id,
  fullName: 'Sir Bashir Ahmed (HM School A)',
  designation: 'Head Master',
};

const mockHmBUser = {
  _id: hmB_Id,
  role: ROLES.HM,
  baseRole: BASE_ROLES.HM,
  schoolId: schoolB_Id,
  fullName: 'Sir Khalid Farooq (HM School B)',
  designation: 'Head Master',
};

const mockParentAUser = {
  _id: parentA_Id,
  role: ROLES.PARENT,
  baseRole: BASE_ROLES.PARENT,
  scope: SCOPES.CHILD,
  fullName: 'Muhammad Usman Khan',
  email: 'usman.parent@example.com',
  phoneNumber: '03001234567',
};

// ─── SECTION 1: HM Verification Queue Scoping ───────────────────────────────
console.log('--- 1. HM Verification Queue Scoping & Query Isolation ---');

await runAsyncTest('HM queue strictly scopes queries to HM schoolId and default status', async () => {
  let capturedQuery = null;

  const originalFind = ParentStudentLink.find;
  const originalCount = ParentStudentLink.countDocuments;

  ParentStudentLink.find = (query) => {
    capturedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({
              skip: () => ({
                limit: () => Promise.resolve([
                  {
                    _id: new mongoose.Types.ObjectId(),
                    parentId: { fullName: 'Muhammad Usman Khan', email: 'usman@example.com' },
                    studentProfileId: { studentFullName: 'Bilal Khan', grNumber: 2041 },
                    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
                    schoolId: schoolA_Id,
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    };
  };
  ParentStudentLink.countDocuments = () => Promise.resolve(1);

  const req = {
    user: mockHmAUser,
    query: { status: 'PENDING_HM_APPROVAL', page: '1', limit: '20' },
  };
  const res = createMockResponse();

  await handleGetHmParentLinks(req, res);

  ParentStudentLink.find = originalFind;
  ParentStudentLink.countDocuments = originalCount;

  assert.equal(res.statusCode, 200);
  assert.equal(String(capturedQuery.schoolId), String(schoolA_Id));
  assert.equal(capturedQuery.verificationStatus, 'PENDING_HM_APPROVAL');
  assert.equal(res.body.data.claims.length, 1);
  assert.equal(res.body.data.pagination.totalCount, 1);
});

await runAsyncTest('HM queue supports status filter ALL to review history', async () => {
  let capturedQuery = null;

  const originalFind = ParentStudentLink.find;
  const originalCount = ParentStudentLink.countDocuments;

  ParentStudentLink.find = (query) => {
    capturedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({
              skip: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      }),
    };
  };
  ParentStudentLink.countDocuments = () => Promise.resolve(0);

  const req = {
    user: mockHmAUser,
    query: { status: 'ALL' },
  };
  const res = createMockResponse();

  await handleGetHmParentLinks(req, res);

  ParentStudentLink.find = originalFind;
  ParentStudentLink.countDocuments = originalCount;

  assert.equal(res.statusCode, 200);
  assert.equal(String(capturedQuery.schoolId), String(schoolA_Id));
  assert.equal(capturedQuery.verificationStatus, undefined, 'statusFilter ALL must not constrain verificationStatus');
});

// ─── SECTION 2: Cross-School BOLA Protection ────────────────────────────────
console.log('\n--- 2. Cross-School BOLA & IDOR Defenses ---');

await runAsyncTest('Foreign HM of School B is blocked from verifying School A claim (403 BOLA)', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkId,
    schoolId: schoolA_Id, // Belongs to School A
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
  };

  const originalFindById = ParentStudentLink.findById;
  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });

  const req = {
    user: mockHmBUser, // HM of School B
    params: { linkId: String(linkId) },
    body: { remarks: 'Malicious cross-school verification attempt.' },
  };
  const res = createMockResponse();

  await handleHmVerifyParentLink(req, res);

  ParentStudentLink.findById = originalFindById;

  assert.equal(res.statusCode, 403);
  assert.ok((res.body.message || '').includes('cannot verify parent claims for another school'));
});

// ─── SECTION 3: Legitimate HM Approval & Audit Trail ─────────────────────────
console.log('\n--- 3. Legitimate HM Verification Approval & Audit Invariants ---');

let approvedLinkId = new mongoose.Types.ObjectId();
let capturedAudit = null;
let capturedNotif = null;

await runAsyncTest('Legitimate HM verifies claim with checklist remarks: emits audit & notifies parent', async () => {
  const mockLink = {
    _id: approvedLinkId,
    parentId: { _id: parentA_Id },
    studentProfileId: { _id: student1_Id, studentFullName: 'Bilal Khan' },
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    save: function () {
      return Promise.resolve(this);
    },
  };

  const originalFindById = ParentStudentLink.findById;
  const originalAuditCreate = AuditLog.create;
  const originalNotifCreate = Notification.create;

  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });
  AuditLog.create = (doc) => {
    capturedAudit = doc;
    return Promise.resolve(doc);
  };
  Notification.create = (doc) => {
    capturedNotif = doc;
    return Promise.resolve(doc);
  };

  const req = {
    user: mockHmAUser,
    params: { linkId: String(approvedLinkId) },
    body: { remarks: 'B-Form and Father CNIC verified against municipal admission file.' },
  };
  const res = createMockResponse();

  await handleHmVerifyParentLink(req, res);

  ParentStudentLink.findById = originalFindById;
  AuditLog.create = originalAuditCreate;
  Notification.create = originalNotifCreate;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.VERIFIED);
  assert.equal(String(mockLink.verifiedBy), String(hmA_Id));
  assert.ok(mockLink.verifiedAt instanceof Date);

  // Audit assertions
  assert.ok(capturedAudit, 'Audit log must be emitted');
  assert.equal(capturedAudit.action, 'PARENT_STUDENT_LINK_APPROVED');
  assert.equal(String(capturedAudit.targetId), String(approvedLinkId));
  assert.equal(capturedAudit.newState.verificationStatus, PARENT_STUDENT_LINK_STATUS.VERIFIED);
  assert.equal(capturedAudit.newState.remarks, 'B-Form and Father CNIC verified against municipal admission file.');

  // Notification assertions
  assert.ok(capturedNotif, 'Parent notification must be created');
  assert.equal(String(capturedNotif.recipientUserId), String(parentA_Id));
  assert.equal(capturedNotif.actionLink, '/parent/dashboard');
});

await runAsyncTest('Duplicate verification of already VERIFIED link is rejected with 400 Bad Request', async () => {
  const mockLink = {
    _id: approvedLinkId,
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED, // Already verified
  };

  const originalFindById = ParentStudentLink.findById;
  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });

  const req = {
    user: mockHmAUser,
    params: { linkId: String(approvedLinkId) },
    body: { remarks: 'Attempting duplicate approval.' },
  };
  const res = createMockResponse();

  await handleHmVerifyParentLink(req, res);

  ParentStudentLink.findById = originalFindById;

  assert.equal(res.statusCode, 400);
  assert.ok((res.body.message || '').includes('Must be in a pending state'));
});

// ─── SECTION 4: Immediate Parent Wards Retrieval ─────────────────────────────
console.log('\n--- 4. Post-Verification Parent Wards Retrieval ---');

await runAsyncTest('Parent retrieves newly verified ward in handleGetMyWards', async () => {
  let capturedQuery = null;

  const originalFind = ParentStudentLink.find;
  ParentStudentLink.find = (query) => {
    capturedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          sort: () => Promise.resolve([
            {
              _id: approvedLinkId,
              relationship: PARENT_RELATIONSHIP.FATHER,
              verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
              verifiedAt: new Date(),
              studentProfileId: {
                _id: student1_Id,
                studentFullName: 'Bilal Khan',
                grNumber: 2041,
              },
              schoolId: {
                _id: schoolA_Id,
                name: 'GBPS Liaquatabad No 1',
              },
            },
          ]),
        }),
      }),
    };
  };

  const req = { user: mockParentAUser };
  const res = createMockResponse();

  await handleGetMyWards(req, res);

  ParentStudentLink.find = originalFind;

  assert.equal(res.statusCode, 200);
  assert.equal(String(capturedQuery.parentId), String(parentA_Id));
  assert.equal(capturedQuery.verificationStatus, PARENT_STUDENT_LINK_STATUS.VERIFIED);
  assert.equal(res.body.data.wards.length, 1);
  assert.equal(res.body.data.wards[0].studentProfile.studentFullName, 'Bilal Khan');
  assert.equal(res.body.data.wards[0].relationship, PARENT_RELATIONSHIP.FATHER);
});

// ─── SECTION 5: Post-Verification BFF Access Entitlements ────────────────────
console.log('\n--- 5. Post-Verification Ward BFF Entitlements (All 5 Modules) ---');

const studentUserDocId = new mongoose.Types.ObjectId();

// Mock Student Profile
const mockStudentDoc = {
  _id: student1_Id,
  userId: { _id: studentUserDocId, fullName: 'Bilal Khan' },
  grNumber: 2041,
  gender: 'MALE',
  dateOfBirth: '2014-04-12',
  enrollmentDate: '2020-04-01',
  lifecycleStatus: STUDENT_STATUS.ACTIVE,
  schoolId: { _id: schoolA_Id, name: 'GBPS Liaquatabad No 1', code: 'GBPS-01', emisCode: '4080101', address: 'Town Centre' },
  classId: { _id: new mongoose.Types.ObjectId(), name: 'Class 4', numericGrade: 4 },
  sectionId: { _id: new mongoose.Types.ObjectId(), name: 'A' },
};

const mockVerifiedLink = {
  _id: approvedLinkId,
  parentId: parentA_Id,
  studentProfileId: student1_Id,
  schoolId: schoolA_Id,
  relationship: PARENT_RELATIONSHIP.FATHER,
  verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
  hmVerifiedAt: new Date(),
};

await runAsyncTest('BFF Middleware permits verified parent and attaches parentWardLink and wardProfile', async () => {
  const originalLinkFind = ParentStudentLink.findOne;
  const originalStudentFind = StudentProfile.findById;

  ParentStudentLink.findOne = () => ({ lean: () => Promise.resolve(mockVerifiedLink) });
  StudentProfile.findById = () => makeChainable(mockStudentDoc);

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: String(student1_Id) },
  };
  const res = createMockResponse();
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  await verifyParentWardLink(req, res, next);

  ParentStudentLink.findOne = originalLinkFind;
  StudentProfile.findById = originalStudentFind;

  assert.ok(nextCalled, 'Middleware must invoke next() on verified link');
  assert.ok(req.wardProfile, 'Middleware must attach wardProfile to request');
  assert.equal(String(req.wardProfile._id), String(student1_Id));
  assert.ok(req.parentWardLink, 'Middleware must attach parentWardLink to request');
});

await runAsyncTest('Verified parent accesses Ward Profile (handleGetWardProfile)', async () => {
  const req = {
    wardProfile: mockStudentDoc,
    parentWardLink: mockVerifiedLink,
  };
  const res = createMockResponse();

  await handleGetWardProfile(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.fullName, 'Bilal Khan');
  assert.equal(res.body.data.relationship, PARENT_RELATIONSHIP.FATHER);
});

await runAsyncTest('Verified parent accesses Ward Attendance (handleGetWardAttendance)', async () => {
  const originalFind = Attendance.find;
  Attendance.find = () => makeChainable([
    {
      date: new Date(),
      records: [
        {
          userId: studentUserDocId,
          status: 'PRESENT',
          remarks: 'Present on time',
        },
      ],
    },
  ]);

  const req = {
    wardProfile: mockStudentDoc,
    parentWardLink: mockVerifiedLink,
    query: {},
  };
  const res = createMockResponse();

  await handleGetWardAttendance(req, res);

  Attendance.find = originalFind;

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.data.history);
  assert.equal(res.body.data.history.length, 1);
  assert.equal(res.body.data.history[0].status, 'PRESENT');
});

await runAsyncTest('Verified parent accesses Ward Marksheets (handleGetWardMarksheets)', async () => {
  const originalResultFind = Result.find;

  const mockExamId = new mongoose.Types.ObjectId();
  Result.find = () => makeChainable([
    {
      _id: new mongoose.Types.ObjectId(),
      studentId: studentUserDocId,
      status: 'PUBLISHED',
      examId: {
        _id: mockExamId,
        title: 'Mid-Term Examinations 2025-2026',
        term: 'FIRST_TERM',
        academicYear: '2025-2026',
        totalMarks: 700,
        passingMarks: 231,
      },
      subjectMarks: [
        {
          subjectId: { _id: new mongoose.Types.ObjectId(), name: 'Mathematics', code: 'MATH-04' },
          marksObtained: 85,
          totalMarks: 100,
          passingMarks: 33,
          grade: 'A',
          isPassed: true,
        },
      ],
      totalMarksObtained: 85,
      totalMaxMarks: 100,
      percentage: 85,
      grade: 'A',
      rankFormatted: '1st in Section',
    },
  ]);

  const req = {
    wardProfile: mockStudentDoc,
    parentWardLink: mockVerifiedLink,
  };
  const res = createMockResponse();

  await handleGetWardMarksheets(req, res);

  Result.find = originalResultFind;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.count, 1);
  assert.equal(res.body.data.marksheets[0].grade, 'A');
});

await runAsyncTest('Verified parent accesses Ward Homework (handleGetWardHomework)', async () => {
  const originalFind = Homework.find;
  Homework.find = () => makeChainable([
    {
      _id: new mongoose.Types.ObjectId(),
      title: 'Mathematics Chapter 4 Exercises',
      description: 'Complete exercises 4.1 to 4.3 in workbook',
      subjectId: { name: 'Mathematics' },
      dueDate: new Date(Date.now() + 86400000),
      teacherId: { fullName: 'Sir Naveed', designation: 'PST Teacher' },
    },
  ]);

  const req = {
    wardProfile: mockStudentDoc,
    parentWardLink: mockVerifiedLink,
    query: {},
  };
  const res = createMockResponse();

  await handleGetWardHomework(req, res);

  Homework.find = originalFind;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.count, 1);
  assert.equal(res.body.data.homework[0].title, 'Mathematics Chapter 4 Exercises');
});

await runAsyncTest('Verified parent accesses Ward Circulars (handleGetWardCirculars)', async () => {
  const originalFind = Document.find;
  Document.find = () => makeChainable([
    {
      _id: new mongoose.Types.ObjectId(),
      title: 'Annual Sports Day Notice',
      summary: 'Sports day will be held next Friday.',
      documentType: 'CIRCULAR',
      scope: 'SCHOOL',
      category: 'GENERAL',
      fileUrl: 'https://cloudinary.com/dmc/sports.pdf',
      publishedAt: new Date(),
      publishedBy: { fullName: 'Head Master', designation: 'HM' },
    },
  ]);

  const req = {
    wardProfile: mockStudentDoc,
    parentWardLink: mockVerifiedLink,
    query: {},
  };
  const res = createMockResponse();

  await handleGetWardCirculars(req, res);

  Document.find = originalFind;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.count, 1);
  assert.equal(res.body.data.circulars[0].title, 'Annual Sports Day Notice');
});

// ─── SECTION 6: Pre-Verification / Pending Claim Denial ──────────────────────
console.log('\n--- 6. Pre-Verification Denial (PENDING_HM_APPROVAL Blocked) ---');

await runAsyncTest('Unverified PENDING_HM_APPROVAL claim is blocked from all BFF endpoints (403)', async () => {
  const pendingLinkId = new mongoose.Types.ObjectId();
  const mockPendingLink = {
    _id: pendingLinkId,
    parentId: parentA_Id,
    studentProfileId: student1_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
  };

  const originalLinkFind = ParentStudentLink.findOne;
  const originalAuditCreate = AuditLog.create;

  ParentStudentLink.findOne = () => ({ lean: () => Promise.resolve(mockPendingLink) });
  AuditLog.create = () => Promise.resolve({});

  const req = {
    user: mockParentAUser,
    params: { studentProfileId: String(student1_Id) },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockResponse();
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  await verifyParentWardLink(req, res, next);

  ParentStudentLink.findOne = originalLinkFind;
  AuditLog.create = originalAuditCreate;

  assert.equal(nextCalled, false, 'next() must NOT be called for pending link');
  assert.equal(res.statusCode, 403);
  assert.ok((res.body.message || '').includes('active, verified parental link'));
});

// ─── SECTION 7: Rejection & Revocation Lifecycle ─────────────────────────────
console.log('\n--- 7. Rejection & Revocation Lifecycle Guardrails ---');

await runAsyncTest('HM Reject schema strictly requires at least 10 characters', () => {
  const shortResult = hmRejectLinkSchema.safeParse({ rejectionReason: 'Too short' });
  assert.equal(shortResult.success, false, 'Under 10 characters must fail');

  const validResult = hmRejectLinkSchema.safeParse({
    rejectionReason: 'NADRA B-Form child name does not match admission file records.',
  });
  assert.equal(validResult.success, true, '>= 10 characters must pass');
});

await runAsyncTest('HM rejects claim: transitions to REJECTED with reason, audit and notification', async () => {
  const linkToRejectId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkToRejectId,
    parentId: { _id: parentA_Id },
    studentProfileId: { _id: student1_Id, studentFullName: 'Bilal Khan' },
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    save: function () { return Promise.resolve(this); },
  };

  const originalFindById = ParentStudentLink.findById;
  const originalAuditCreate = AuditLog.create;
  const originalNotifCreate = Notification.create;

  ParentStudentLink.findById = () => ({ populate: () => Promise.resolve(mockLink) });
  AuditLog.create = () => Promise.resolve({});
  Notification.create = () => Promise.resolve({});

  const req = {
    user: mockHmAUser,
    params: { linkId: String(linkToRejectId) },
    body: { rejectionReason: 'NADRA B-Form child name does not match admission file records.' },
  };
  const res = createMockResponse();

  await handleHmRejectParentLink(req, res);

  ParentStudentLink.findById = originalFindById;
  AuditLog.create = originalAuditCreate;
  Notification.create = originalNotifCreate;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.REJECTED);
  assert.equal(String(mockLink.rejectedBy), String(hmA_Id));
  assert.equal(mockLink.rejectionReason, 'NADRA B-Form child name does not match admission file records.');
});

await runAsyncTest('HM cannot reject already VERIFIED link (must use revoke)', async () => {
  const mockLink = {
    _id: approvedLinkId,
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
  };

  const originalFindById = ParentStudentLink.findById;
  ParentStudentLink.findById = () => ({ populate: () => Promise.resolve(mockLink) });

  const req = {
    user: mockHmAUser,
    params: { linkId: String(approvedLinkId) },
    body: { rejectionReason: 'Attempting to reject an active verified link directly.' },
  };
  const res = createMockResponse();

  await handleHmRejectParentLink(req, res);

  ParentStudentLink.findById = originalFindById;

  assert.equal(res.statusCode, 400);
  assert.ok((res.body.message || '').includes('Active verified link must be revoked, not rejected'));
});

await runAsyncTest('HM revokes VERIFIED link: immediately revokes and terminates BFF access', async () => {
  const mockLink = {
    _id: approvedLinkId,
    parentId: { _id: parentA_Id },
    studentProfileId: { _id: student1_Id, studentFullName: 'Bilal Khan' },
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
    save: function () { return Promise.resolve(this); },
  };

  const originalFindById = ParentStudentLink.findById;
  const originalAuditCreate = AuditLog.create;
  const originalNotifCreate = Notification.create;

  ParentStudentLink.findById = () => ({ populate: () => Promise.resolve(mockLink) });
  AuditLog.create = () => Promise.resolve({});
  Notification.create = () => Promise.resolve({});

  const req = {
    user: mockHmAUser,
    params: { linkId: String(approvedLinkId) },
    body: { revocationReason: 'Custody modification decree provided by family court.' },
  };
  const res = createMockResponse();

  await handleHmRevokeParentLink(req, res);

  ParentStudentLink.findById = originalFindById;
  AuditLog.create = originalAuditCreate;
  Notification.create = originalNotifCreate;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.REVOKED);
  assert.equal(mockLink.revocationReason, 'Custody modification decree provided by family court.');

  // Now verify that revoked link cannot access BFF
  const originalLinkFind = ParentStudentLink.findOne;
  ParentStudentLink.findOne = () => ({ lean: () => Promise.resolve(mockLink) });

  const bffReq = {
    user: mockParentAUser,
    params: { studentProfileId: String(student1_Id) },
    ip: '127.0.0.1',
    headers: {},
  };
  const bffRes = createMockResponse();
  let bffNextCalled = false;

  await verifyParentWardLink(bffReq, bffRes, () => { bffNextCalled = true; });

  ParentStudentLink.findOne = originalLinkFind;

  assert.equal(bffNextCalled, false, 'Revoked link must NOT be permitted through BFF');
  assert.equal(bffRes.statusCode, 403);
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} HM VERIFICATION BRIDGE TESTS PASSED!`);
console.log('======================================================================\n');
