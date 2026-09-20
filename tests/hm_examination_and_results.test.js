/**
 * 🛡️ HEAD MASTER (HM) EXAMINATION & RESULTS MANAGEMENT TEST SUITE (STEP 3)
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all 23 HM Step 3 Invariants:
 *  Group 1: Exam Scheduling & Multi-Tier Scope Invariants (Scenarios 1-7)
 *  Group 2: Marks Submission & Five-Point Cross-Entity Validation (Scenarios 8-12)
 *  Group 3: Gazette Queries & Data Minimization (Scenarios 13-15)
 *  Group 4: Verification & State Machine Invariants (Scenarios 16-19)
 *  Group 5: Publishing Gate, Post-Publish Immutability & Concurrency (Scenarios 20-23)
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  SCOPES,
  USER_STATUS,
} from '../config/constants.js';

// Production controllers
import {
  handleGetExams,
  handleCreateExam,
  handleGetExamResults,
  handleSubmitStudentMarks,
  handleVerifyExamResult,
  handleBatchVerifyExamResults,
  handlePublishExamResults,
} from '../src/controllers/examController.js';

// Domain models
import Exam from '../src/models/Exam.js';
import Result from '../src/models/Result.js';
import School from '../src/models/School.js';
import User from '../src/models/User.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import AuditLog from '../src/models/AuditLog.js';

let totalTests = 0;
let passedTests = 0;

async function runAsyncTest(testName, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (err) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(err);
    throw err;
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

function makeChainable(data) {
  return {
    _data: data,
    session() { return this; },
    populate() { return this; },
    sort() { return this; },
    lean() { return Promise.resolve(this._data); },
    then(resolve, reject) { return Promise.resolve(this._data).then(resolve, reject); },
  };
}

console.log('======================================================================');
console.log('🏛️ EXECUTING HM EXAMINATION & RESULTS MANAGEMENT SUITE (STEP 3)');
console.log('======================================================================\n');

// Standard Institutional Entities
const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';
const townId = '507f1f77bcf86cd799439000';

const classA_Id = '507f1f77bcf86cd799439011';
const classB_Id = '507f1f77bcf86cd799439012';
const sectionA_Id = '507f1f77bcf86cd799439021';
const sectionB_Id = '507f1f77bcf86cd799439022';
const subjectA_Id = '507f1f77bcf86cd799439031';

const hmA_User = {
  _id: '507f1f77bcf86cd799439041',
  role: ROLES.HM,
  schoolId: { _id: schoolA_Id },
  fullName: 'Head Master Liaquatabad Primary',
  townId,
};

const superAdminUser = {
  _id: '507f1f77bcf86cd799439099',
  role: ROLES.SUPER_ADMIN,
  fullName: 'Global System Administrator',
};

const teacherA_User = {
  _id: '507f1f77bcf86cd799439051',
  role: ROLES.TEACHER,
  schoolId: { _id: schoolA_Id },
  fullName: 'Senior Teacher School A',
  townId,
};

const studentA_Id = '507f1f77bcf86cd799439061';
const studentB_Id = '507f1f77bcf86cd799439062';

const examA_Id = '507f1f77bcf86cd799439071';
const examB_Id = '507f1f77bcf86cd799439072';

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: EXAM SCHEDULING & MULTI-TIER SCOPE INVARIANTS
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 01: HM creates exam scoped to own school -> 201 Created with UPCOMING and AuditLog', async () => {
  const origSchoolFindById = School.findById;
  const origExamCreate = Exam.create;
  const origAuditCreate = AuditLog.create;

  let auditCreated = false;
  School.findById = () => makeChainable({ _id: schoolA_Id, townId });
  Exam.create = (doc) => Promise.resolve({ _id: examA_Id, ...doc });
  AuditLog.create = (entry) => {
    auditCreated = true;
    assert.strictEqual(entry.action, 'EXAM_SCHEDULED');
    assert.strictEqual(String(entry.schoolId), schoolA_Id);
    return Promise.resolve(entry);
  };

  const req = {
    user: hmA_User,
    body: {
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      title: 'Mid-Term Examination 2025',
      examType: 'MID_TERM',
      startDate: '2025-10-01',
      endDate: '2025-10-15',
    },
  };
  const res = createMockRes();

  await handleCreateExam(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.data.exam.status, 'UPCOMING');
  assert.strictEqual(auditCreated, true);

  School.findById = origSchoolFindById;
  Exam.create = origExamCreate;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 02: HM creating exam with manipulated foreign schoolId -> 403 Forbidden (BOLA tripwire)', async () => {
  const req = {
    user: hmA_User,
    body: {
      schoolId: schoolB_Id, // foreign school
      academicYear: '2025-2026',
      title: 'Hacked Exam',
      examType: 'MID_TERM',
      startDate: '2025-10-01',
      endDate: '2025-10-15',
    },
  };
  const res = createMockRes();

  await handleCreateExam(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /Access denied/i);
});

await runAsyncTest('Scenario 03: Scheduling exam with endDate < startDate -> 400 Bad Request', async () => {
  const req = {
    user: hmA_User,
    body: {
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      title: 'Inverted Exam Dates',
      examType: 'MID_TERM',
      startDate: '2025-10-20',
      endDate: '2025-10-10', // precedes start date
    },
  };
  const res = createMockRes();

  await handleCreateExam(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /End date cannot precede start date/i);
});

await runAsyncTest('Scenario 04: Scheduling exam missing required fields -> 400 Bad Request', async () => {
  const req = {
    user: hmA_User,
    body: {
      schoolId: schoolA_Id,
      title: 'Incomplete Exam',
      // missing academicYear, examType, startDate, endDate
    },
  };
  const res = createMockRes();

  await handleCreateExam(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /required/i);
});

await runAsyncTest('Scenario 05: HM querying exams list with foreign ?schoolId param -> 403 Forbidden (BOLA tripwire)', async () => {
  const req = {
    user: hmA_User,
    query: { schoolId: schoolB_Id }, // attempted access to School B
  };
  const res = createMockRes();

  await handleGetExams(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /Access denied/i);
});

await runAsyncTest('Scenario 06: HM querying exams list without param -> returns only exams belonging to actor school', async () => {
  const origExamFind = Exam.find;
  let queriedSchoolId = null;

  Exam.find = (filter) => {
    queriedSchoolId = filter.schoolId;
    return makeChainable([
      { _id: examA_Id, schoolId: schoolA_Id, title: 'Mid-Term 2025', startDate: new Date('2025-10-01') },
    ]);
  };

  const req = {
    user: hmA_User,
    query: {},
  };
  const res = createMockRes();

  await handleGetExams(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(queriedSchoolId, schoolA_Id);
  assert.strictEqual(res.body.data.exams.length, 1);

  Exam.find = origExamFind;
});

await runAsyncTest('Scenario 07: Global Admin (SUPER_ADMIN) queries exams specifying schoolId -> 200 OK', async () => {
  const origExamFind = Exam.find;
  let queriedSchoolId = null;

  Exam.find = (filter) => {
    queriedSchoolId = filter.schoolId;
    return makeChainable([
      { _id: examB_Id, schoolId: schoolB_Id, title: 'School B Exam', startDate: new Date('2025-10-01') },
    ]);
  };

  const req = {
    user: superAdminUser,
    query: { schoolId: schoolB_Id },
  };
  const res = createMockRes();

  await handleGetExams(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(queriedSchoolId, schoolB_Id);
  assert.strictEqual(res.body.data.exams.length, 1);

  Exam.find = origExamFind;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: MARKS SUBMISSION & FIVE-POINT CROSS-ENTITY VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 08: Submitting marks for student in UPCOMING exam -> 400 Bad Request ("Exam has not commenced yet.")', async () => {
  const origExamFindById = Exam.findById;
  Exam.findById = () => Promise.resolve({
    _id: examA_Id,
    schoolId: schoolA_Id,
    status: 'UPCOMING',
  });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: studentA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: [{ subjectId: subjectA_Id, obtainedMarks: 85, maxMarks: 100 }],
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /Exam has not commenced yet/i);

  Exam.findById = origExamFindById;
});

await runAsyncTest('Scenario 09: Submitting student marks for ONGOING / COMPLETED exam -> 201 Created with status SUBMITTED', async () => {
  const origExamFindById = Exam.findById;
  const origUserFindById = User.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origResultFindOne = Result.findOne;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  const mockExamDoc = {
    _id: examA_Id,
    schoolId: schoolA_Id,
    academicYear: '2025-2026',
    status: 'ONGOING',
    resultsLastModifiedAt: null,
    save: function () { return Promise.resolve(this); },
  };

  Exam.findById = () => Promise.resolve(mockExamDoc);
  User.findById = () => makeChainable({ _id: studentA_Id, schoolId: schoolA_Id, fullName: 'Ahmed Khan' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id, name: 'Grade 5' });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id, name: 'A' });
  Result.findOne = () => makeChainable(null); // no duplicate

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  let createdResultDoc = null;
  Result.create = (docs) => {
    createdResultDoc = {
      _id: '507f1f77bcf86cd799439088',
      ...docs[0],
    };
    return Promise.resolve([createdResultDoc]);
  };

  Exam.findOne = () => ({
    session: () => Promise.resolve(mockExamDoc),
  });

  AuditLog.create = (entries) => Promise.resolve(entries);

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: studentA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: [
        { subjectId: subjectA_Id, obtainedMarks: 85, maxMarks: 100 },
      ],
      remarks: 'Excellent performance',
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdResultDoc.status, 'SUBMITTED');
  assert.strictEqual(createdResultDoc.percentage, 85);
  assert.strictEqual(createdResultDoc.grade, 'A+');
  assert.ok(mockExamDoc.resultsLastModifiedAt instanceof Date);

  Exam.findById = origExamFindById;
  User.findById = origUserFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Result.findOne = origResultFindOne;
  Result.create = origResultCreate;
  mongoose.startSession = origStartSession;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 10: Duplicate student result entry for same exam -> rejected with 409 Conflict', async () => {
  const origExamFindById = Exam.findById;
  const origUserFindById = User.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origResultFindOne = Result.findOne;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  User.findById = () => makeChainable({ _id: studentA_Id, schoolId: schoolA_Id });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Result.findOne = () => makeChainable({ _id: 'existing_result_id', examId: examA_Id, studentId: studentA_Id });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: studentA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: [{ subjectId: subjectA_Id, obtainedMarks: 75, maxMarks: 100 }],
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /Duplicate result/i);

  Exam.findById = origExamFindById;
  User.findById = origUserFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Result.findOne = origResultFindOne;
});

await runAsyncTest('Scenario 11: Cross-entity violation: Submitting student belonging to School B into School A exam -> 403 Forbidden', async () => {
  const origExamFindById = Exam.findById;
  const origUserFindById = User.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  User.findById = () => makeChainable({ _id: studentB_Id, schoolId: schoolB_Id }); // foreign student
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: studentB_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: [{ subjectId: subjectA_Id, obtainedMarks: 90, maxMarks: 100 }],
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /Student is not enrolled in this school/i);

  Exam.findById = origExamFindById;
  User.findById = origUserFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
});

await runAsyncTest('Scenario 12: Cross-entity violation: Submitting section that does not belong to specified class -> 400 Bad Request', async () => {
  const origExamFindById = Exam.findById;
  const origUserFindById = User.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  User.findById = () => makeChainable({ _id: studentA_Id, schoolId: schoolA_Id });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  // sectionB belongs to classB, not classA
  Section.findById = () => makeChainable({ _id: sectionB_Id, schoolId: schoolA_Id, classId: classB_Id });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: studentA_Id,
      classId: classA_Id,
      sectionId: sectionB_Id,
      subjectMarks: [{ subjectId: subjectA_Id, obtainedMarks: 90, maxMarks: 100 }],
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /Selected section does not belong to the selected class/i);

  Exam.findById = origExamFindById;
  User.findById = origUserFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: GAZETTE QUERIES & DATA MINIMIZATION
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 13: Querying exam results -> verifies fullName and rollNumber returned with ZERO email projection', async () => {
  const origExamFindById = Exam.findById;
  const origResultFind = Result.find;

  Exam.findById = () => makeChainable({ _id: examA_Id, schoolId: schoolA_Id, title: 'Mid-Term 2025' });

  let studentPopulateProjection = null;
  Result.find = () => ({
    populate(field, select) {
      if (field === 'studentId') {
        studentPopulateProjection = select;
      }
      return this;
    },
    sort() { return this; },
    lean() {
      return Promise.resolve([
        {
          _id: 'result_01',
          studentId: { fullName: 'Ali Raza', rollNumber: 101 }, // strictly NO email
          percentage: 88,
          grade: 'A+',
          status: 'SUBMITTED',
        },
      ]);
    },
  });

  const req = {
    user: hmA_User,
    params: { id: examA_Id },
    query: {},
  };
  const res = createMockRes();

  await handleGetExamResults(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(studentPopulateProjection, 'fullName rollNumber');
  assert.strictEqual(res.body.data.results[0].studentId.email, undefined);
  assert.strictEqual(res.body.data.results[0].studentId.fullName, 'Ali Raza');
  assert.strictEqual(res.body.data.results[0].studentId.rollNumber, 101);

  Exam.findById = origExamFindById;
  Result.find = origResultFind;
});

await runAsyncTest('Scenario 14: Querying exam results filtered by classId and sectionId -> returns matching section records', async () => {
  const origExamFindById = Exam.findById;
  const origResultFind = Result.find;

  Exam.findById = () => makeChainable({ _id: examA_Id, schoolId: schoolA_Id });

  let appliedFilter = null;
  Result.find = (filter) => {
    appliedFilter = filter;
    return makeChainable([
      { _id: 'result_01', classId: classA_Id, sectionId: sectionA_Id, percentage: 80 },
    ]);
  };

  const req = {
    user: hmA_User,
    params: { id: examA_Id },
    query: { classId: classA_Id, sectionId: sectionA_Id },
  };
  const res = createMockRes();

  await handleGetExamResults(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(appliedFilter.examId, examA_Id);
  assert.strictEqual(appliedFilter.classId, classA_Id);
  assert.strictEqual(appliedFilter.sectionId, sectionA_Id);

  Exam.findById = origExamFindById;
  Result.find = origResultFind;
});

await runAsyncTest('Scenario 15: HM querying results of foreign school exam -> 403 Forbidden (BOLA tripwire)', async () => {
  const origExamFindById = Exam.findById;
  Exam.findById = () => makeChainable({ _id: examB_Id, schoolId: schoolB_Id }); // foreign exam

  const req = {
    user: hmA_User,
    params: { id: examB_Id },
    query: {},
  };
  const res = createMockRes();

  await handleGetExamResults(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /Access denied/i);

  Exam.findById = origExamFindById;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: VERIFICATION & STATE MACHINE INVARIANTS
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 16: Illegal transition: Attempting to verify a DRAFT result without submission -> 400 Bad Request', async () => {
  const origResultFindById = Result.findById;
  const origExamFindById = Exam.findById;
  const resultId = '507f1f77bcf86cd799439081';

  Result.findById = () => Promise.resolve({
    _id: resultId,
    schoolId: schoolA_Id,
    examId: examA_Id,
    status: 'DRAFT', // unsubmitted
  });
  Exam.findById = () => makeChainable({ _id: examA_Id, status: 'ONGOING' });

  const req = {
    user: hmA_User,
    params: { id: resultId },
    body: { remarks: 'Trying to verify draft' },
  };
  const res = createMockRes();

  await handleVerifyExamResult(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /Cannot verify unsubmitted draft result/i);

  Result.findById = origResultFindById;
  Exam.findById = origExamFindById;
});

await runAsyncTest('Scenario 17: HM verifies single submitted result -> transitions SUBMITTED to VERIFIED_BY_HM and sets approvedByHM', async () => {
  const origResultFindById = Result.findById;
  const origExamFindById = Exam.findById;
  const origAuditCreate = AuditLog.create;
  const resultId = '507f1f77bcf86cd799439082';

  const mockResultDoc = {
    _id: resultId,
    schoolId: schoolA_Id,
    examId: examA_Id,
    status: 'SUBMITTED',
    approvedByHM: null,
    save: function () { return Promise.resolve(this); },
  };

  Result.findById = () => Promise.resolve(mockResultDoc);
  Exam.findById = () => makeChainable({ _id: examA_Id, status: 'ONGOING' });

  let auditLogged = false;
  AuditLog.create = (entry) => {
    auditLogged = true;
    assert.strictEqual(entry.action, 'RESULT_VERIFIED_BY_HM');
    return Promise.resolve(entry);
  };

  const req = {
    user: hmA_User,
    params: { id: resultId },
    body: { remarks: 'Verified by HM' },
  };
  const res = createMockRes();

  await handleVerifyExamResult(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(mockResultDoc.status, 'VERIFIED_BY_HM');
  assert.strictEqual(String(mockResultDoc.approvedByHM), hmA_User._id);
  assert.strictEqual(auditLogged, true);

  Result.findById = origResultFindById;
  Exam.findById = origExamFindById;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 18: HM batch-verifies submitted results -> transaction commits, matching results transition to VERIFIED_BY_HM, audit logged', async () => {
  const origExamFindById = Exam.findById;
  const origStartSession = mongoose.startSession;
  const origResultUpdateMany = Result.updateMany;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });

  let transactionCommitted = false;
  const mockSession = {
    startTransaction() {},
    commitTransaction: () => { transactionCommitted = true; return Promise.resolve(); },
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Result.updateMany = () => Promise.resolve({ modifiedCount: 15 });

  let auditLogged = false;
  AuditLog.create = (entries) => {
    auditLogged = true;
    assert.strictEqual(entries[0].action, 'RESULTS_BATCH_VERIFIED_BY_HM');
    assert.strictEqual(entries[0].newState.verifiedCount, 15);
    return Promise.resolve(entries);
  };

  const req = {
    user: hmA_User,
    params: { id: examA_Id },
    body: { classId: classA_Id },
  };
  const res = createMockRes();

  await handleBatchVerifyExamResults(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.verifiedCount, 15);
  assert.strictEqual(transactionCommitted, true);
  assert.strictEqual(auditLogged, true);

  Exam.findById = origExamFindById;
  mongoose.startSession = origStartSession;
  Result.updateMany = origResultUpdateMany;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 19: Batch-verify when 0 eligible results exist -> returns 200 OK (verifiedCount: 0) with ZERO audit log generated', async () => {
  const origExamFindById = Exam.findById;
  const origStartSession = mongoose.startSession;
  const origResultUpdateMany = Result.updateMany;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Result.updateMany = () => Promise.resolve({ modifiedCount: 0 }); // 0 matching

  let auditCreated = false;
  AuditLog.create = () => {
    auditCreated = true;
    return Promise.resolve({});
  };

  const req = {
    user: hmA_User,
    params: { id: examA_Id },
    body: {},
  };
  const res = createMockRes();

  await handleBatchVerifyExamResults(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.verifiedCount, 0);
  assert.strictEqual(auditCreated, false); // ZERO-AUDIT GUARANTEE

  Exam.findById = origExamFindById;
  mongoose.startSession = origStartSession;
  Result.updateMany = origResultUpdateMany;
  AuditLog.create = origAuditCreate;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: PUBLISHING GATE, POST-PUBLISH IMMUTABILITY & CONCURRENCY
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 20: Publishing gate: 0 results recorded -> rejected with 400 Bad Request', async () => {
  const origExamFindById = Exam.findById;
  const origStartSession = mongoose.startSession;
  const origExamFindOneAndUpdate = Exam.findOneAndUpdate;
  const origResultCountDocuments = Result.countDocuments;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'COMPLETED' });

  let transactionAborted = false;
  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => { transactionAborted = true; return Promise.resolve(); },
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Exam.findOneAndUpdate = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'PUBLISHED' });
  Result.countDocuments = () => ({
    session: () => Promise.resolve(0), // zero results recorded
  });

  const req = {
    user: hmA_User,
    params: { id: examA_Id },
  };
  const res = createMockRes();

  await handlePublishExamResults(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /No student results have been recorded/i);
  assert.strictEqual(transactionAborted, true);

  Exam.findById = origExamFindById;
  mongoose.startSession = origStartSession;
  Exam.findOneAndUpdate = origExamFindOneAndUpdate;
  Result.countDocuments = origResultCountDocuments;
});

await runAsyncTest('Scenario 21: Publishing gate: unverified SUBMITTED results remaining -> rejected with 400 Bad Request', async () => {
  const origExamFindById = Exam.findById;
  const origStartSession = mongoose.startSession;
  const origExamFindOneAndUpdate = Exam.findOneAndUpdate;
  const origResultCountDocuments = Result.countDocuments;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'COMPLETED' });

  let transactionAborted = false;
  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => { transactionAborted = true; return Promise.resolve(); },
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Exam.findOneAndUpdate = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'PUBLISHED' });

  let countCalls = 0;
  Result.countDocuments = () => ({
    session: () => {
      countCalls++;
      if (countCalls === 1) return Promise.resolve(20); // totalResultsCount
      return Promise.resolve(3); // unverifiedCount
    },
  });

  const req = {
    user: hmA_User,
    params: { id: examA_Id },
  };
  const res = createMockRes();

  await handlePublishExamResults(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /pending HM verification/i);
  assert.strictEqual(transactionAborted, true);

  Exam.findById = origExamFindById;
  mongoose.startSession = origStartSession;
  Exam.findOneAndUpdate = origExamFindOneAndUpdate;
  Result.countDocuments = origResultCountDocuments;
});

await runAsyncTest('Scenario 22 [CONCURRENCY 1]: Two simultaneous publish requests -> exactly one succeeds, one gets 409, exactly one audit log', async () => {
  const origExamFindById = Exam.findById;
  const origStartSession = mongoose.startSession;
  const origExamFindOneAndUpdate = Exam.findOneAndUpdate;
  const origResultCountDocuments = Result.countDocuments;
  const origResultUpdateMany = Result.updateMany;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'COMPLETED' });

  let lockAcquired = false;
  Exam.findOneAndUpdate = (query) => {
    // Atomic race simulation
    if (!lockAcquired) {
      lockAcquired = true;
      return Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'PUBLISHED' });
    }
    // Second request finds status is already PUBLISHED
    return Promise.resolve(null);
  };

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Result.countDocuments = () => ({
    session: (s) => Promise.resolve(countCallHelper()),
  });

  let callIndex = 0;
  function countCallHelper() {
    callIndex++;
    if (callIndex % 2 === 1) return 10; // totalCount
    return 0; // unverifiedCount === 0
  }

  Result.updateMany = () => Promise.resolve({ modifiedCount: 10 });

  let auditCount = 0;
  AuditLog.create = (entries) => {
    auditCount++;
    return Promise.resolve(entries);
  };

  const req1 = { user: hmA_User, params: { id: examA_Id } };
  const res1 = createMockRes();
  const req2 = { user: hmA_User, params: { id: examA_Id } };
  const res2 = createMockRes();

  // Execute concurrently
  await Promise.all([
    handlePublishExamResults(req1, res1),
    handlePublishExamResults(req2, res2),
  ]);

  const statusCodes = [res1.statusCode, res2.statusCode].sort();
  assert.deepStrictEqual(statusCodes, [200, 409]);
  assert.strictEqual(auditCount, 1); // Exactly one audit log produced

  Exam.findById = origExamFindById;
  mongoose.startSession = origStartSession;
  Exam.findOneAndUpdate = origExamFindOneAndUpdate;
  Result.countDocuments = origResultCountDocuments;
  Result.updateMany = origResultUpdateMany;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 23 [CONCURRENCY 2 & IMMUTABILITY]: Post-publish immutability lock blocks marks submission and re-verification', async () => {
  const origExamFindById = Exam.findById;
  const origResultFindById = Result.findById;

  // Published exam state
  Exam.findById = () => makeChainable({
    _id: examA_Id,
    schoolId: schoolA_Id,
    status: 'PUBLISHED',
  });

  // Attempt 1: Marks submission on published exam
  const marksReq = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: studentA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: [{ subjectId: subjectA_Id, obtainedMarks: 95, maxMarks: 100 }],
    },
  };
  const marksRes = createMockRes();
  await handleSubmitStudentMarks(marksReq, marksRes);

  assert.strictEqual(marksRes.statusCode, 400);
  assert.match(marksRes.body.message, /permanently locked/i);

  // Attempt 2: Re-verification on published result
  const publishedResultId = '507f1f77bcf86cd799439083';
  Result.findById = () => Promise.resolve({
    _id: publishedResultId,
    schoolId: schoolA_Id,
    examId: examA_Id,
    status: 'PUBLISHED',
  });

  const verifyReq = {
    user: hmA_User,
    params: { id: publishedResultId },
    body: { remarks: 'Illegal re-verify' },
  };
  const verifyRes = createMockRes();
  await handleVerifyExamResult(verifyReq, verifyRes);

  assert.strictEqual(verifyRes.statusCode, 400);
  assert.match(verifyRes.body.message, /permanently locked/i);

  Exam.findById = origExamFindById;
  Result.findById = origResultFindById;
});

console.log('\n======================================================================');
console.log(`🎉 COMPLETED: ${passedTests}/${totalTests} HM STEP 3 ASSERTIONS PASSED (100%)`);
console.log('======================================================================\n');
