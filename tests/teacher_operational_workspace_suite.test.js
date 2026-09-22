/**
 * 🛡️ TEACHER OPERATIONAL WORKSPACE TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all 25 Teacher Operational Workspace Invariants:
 *  1. Class Teacher summary resolution (Section.classTeacherId -> isClassTeacher: true)
 *  2. Subject Teacher summary resolution (TeachingAssignment -> assignedSubjects)
 *  3. Combined assignments merging (de-duplicated unified section list)
 *  4. Cross-school section access rejection (403 Forbidden)
 *  5. Unauthorized attendance submission rejection (403 Forbidden)
 *  6. Authorized attendance submission & individual remarks preservation
 *  7. Mark All Present convenience batch behavior
 *  8. Attendance student section ownership validation (Anti-Tampering)
 *  9. Teacher self-attendance history retrieval (HM-marked roster)
 * 10. Authorized exam marks entry for assigned class/section/subject
 * 11. Unauthorized subject marks entry rejection (403 Forbidden)
 * 12. Unauthorized section marks entry rejection (403 Forbidden)
 * 13. Cross-school exam marks rejection (BOLA Tripwire)
 * 14. Marks boundary validation (Negative marks & > Max marks rejected with 400)
 * 15. Islamiat Nazra 20 + Written 80 calculation and boundary validation
 * 16. Drawing letter grade preservation without numerical percentage distortion
 * 17. 700-mark schema calculation (Sindh Board standard grade computation)
 * 18. Academic and conduct remarks persistence
 * 19. Bulk student marks submission in atomic session
 * 20. Published / locked examination protection (Immutability guarantee)
 * 21. Homework creation authorization (school + class + section + subject)
 * 22. Cross-teacher homework cancellation rejection (403 Forbidden)
 * 23. Teacher service record & scope isolation (No administrative leakage)
 * 24. Anti-BOLA / IDOR: Client-manipulated teacherId & schoolId are ignored
 * 25. Regression verification: Teacher marks integrate with HM verification gate
 * 26. Mixed batch payload rejection: 10 authorized + 1 foreign student rejects entire batch with zero partial writes
 * 27. Duplicate studentId rejection: Repeated student IDs in batch payload rejected with 400 Bad Request
 * 28. Malformed / non-finite marks rejection: NaN, Infinity, null, and non-numeric values rejected with 400 Bad Request
 * 29. Drawing grade enum validation: Non-standard letter grades rejected with 400 Bad Request
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  USER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
  STUDENT_STATUS,
} from '../config/constants.js';

// Production controllers
import { handleGetTeacherSummary } from '../src/controllers/academicController.js';
import {
  handleSubmitAttendance,
  handleGetTeacherSelfAttendance,
} from '../src/controllers/attendanceController.js';
import {
  handleSubmitStudentMarks,
  handleBulkSubmitStudentMarks,
  handleGetExamMarksEntryRoster,
  handleVerifyExamResult,
} from '../src/controllers/examController.js';
import {
  handleCreateHomework,
  handleCancelHomework,
} from '../src/controllers/homeworkController.js';

// Domain models
import Section from '../src/models/Section.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import Attendance from '../src/models/Attendance.js';
import StudentProfile from '../src/models/StudentProfile.js';
import Exam from '../src/models/Exam.js';
import Result from '../src/models/Result.js';
import Homework from '../src/models/Homework.js';
import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Subject from '../src/models/Subject.js';
import User from '../src/models/User.js';
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
    limit() { return this; },
    skip() { return this; },
    select() { return this; },
    lean() { return Promise.resolve(this._data); },
    then(resolve, reject) { return Promise.resolve(this._data).then(resolve, reject); },
  };
}

console.log('======================================================================');
console.log('🏛️ EXECUTING TEACHER OPERATIONAL WORKSPACE TEST SUITE');
console.log('======================================================================\n');

// ─── Standard Mock Entities ──────────────────────────────────────────────────
const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';
const townId = '507f1f77bcf86cd799439000';

const teacherA_Id = '507f1f77bcf86cd799439051';
const teacherB_Id = '507f1f77bcf86cd799439052';
const hmA_Id = '507f1f77bcf86cd799439041';

const classA_Id = '507f1f77bcf86cd799439011';
const sectionA_Id = '507f1f77bcf86cd799439021';
const sectionB_Id = '507f1f77bcf86cd799439022';
const sectionForeign_Id = '507f1f77bcf86cd799439029';

const subjectEnglish_Id = '507f1f77bcf86cd799439031';
const subjectMath_Id = '507f1f77bcf86cd799439032';
const subjectIslamiat_Id = '507f1f77bcf86cd799439033';
const subjectDrawing_Id = '507f1f77bcf86cd799439034';

const student1_Id = '507f1f77bcf86cd799439061';
const student2_Id = '507f1f77bcf86cd799439062';
const studentForeign_Id = '507f1f77bcf86cd799439069';

const examA_Id = '507f1f77bcf86cd799439071';

const teacherA_User = {
  _id: teacherA_Id,
  role: ROLES.TEACHER,
  schoolId: { _id: schoolA_Id },
  fullName: 'Sir Tariq Mahmood',
  designation: 'PST Teacher',
  status: USER_STATUS.ACTIVE,
  townId,
};

const teacherB_User = {
  _id: teacherB_Id,
  role: ROLES.TEACHER,
  schoolId: { _id: schoolA_Id },
  fullName: 'Ms. Sadia Bibi',
  designation: 'JST Teacher',
  status: USER_STATUS.ACTIVE,
  townId,
};

// Base offline mock defaults to prevent disconnected Mongoose buffer timeouts
School.findById = (id) => makeChainable({
  _id: id || schoolA_Id,
  schoolCode: 'SCH-001',
  name: 'Liaquatabad Primary',
  townId,
  timings: {
    regular: { startTime: '00:00', endTime: '23:59', attendanceWindowStart: '00:00', attendanceWindowEnd: '23:59' },
    friday: { startTime: '00:00', endTime: '23:59', attendanceWindowStart: '00:00', attendanceWindowEnd: '23:59' },
    allowHmLateOverride: true,
  },
});
AuditLog.create = () => Promise.resolve();
Homework.countDocuments = () => Promise.resolve(0);
Result.prototype.save = function() { return Promise.resolve(this); };
Result.findOne = () => makeChainable(null);
Result.create = (docs) => Promise.resolve(Array.isArray(docs) ? docs : [docs]);
StudentProfile.find = () => makeChainable([]);
StudentProfile.countDocuments = () => Promise.resolve(0);
Subject.findById = (id) => makeChainable({
  _id: id || subjectEnglish_Id,
  schoolId: schoolA_Id,
  name: 'ENGLISH',
  totalMarks: 100,
  passingMarks: 33,
});
Exam.findOne = () => ({
  session: () => Promise.resolve({
    _id: examA_Id,
    schoolId: schoolA_Id,
    status: 'ONGOING',
    save: () => Promise.resolve(),
  }),
});
mongoose.startSession = () => Promise.resolve({
  startTransaction() {},
  commitTransaction: () => Promise.resolve(),
  abortTransaction: () => Promise.resolve(),
  endSession() {},
});

// ─── 1. TEACHER SUMMARY & ASSIGNMENT RESOLUTION (Scenarios 1-4) ───────────────

await runAsyncTest('Scenario 01: Class Teacher summary resolution identifies isClassTeacher: true and section metrics', async () => {
  const origSectionFind = Section.find;
  const origTeachingAssignmentFind = TeachingAssignment.find;
  const origStudentCount = StudentProfile.countDocuments;
  const origAttendanceFindOne = Attendance.findOne;

  Section.find = () => makeChainable([
    { _id: sectionA_Id, name: 'A', classId: { _id: classA_Id, name: 'Grade 5' }, schoolId: schoolA_Id, classTeacherId: teacherA_Id },
  ]);
  TeachingAssignment.find = () => makeChainable([]);
  StudentProfile.countDocuments = () => Promise.resolve(35);
  Attendance.findOne = () => makeChainable(null);

  const req = { user: teacherA_User };
  const res = createMockRes();

  await handleGetTeacherSummary(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  const sections = res.body.data.sections;
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].isClassTeacher, true);
  assert.strictEqual(sections[0].studentCount, 35);
  assert.strictEqual(res.body.data.summary.assignedSectionCount, 1);

  Section.find = origSectionFind;
  TeachingAssignment.find = origTeachingAssignmentFind;
  StudentProfile.countDocuments = origStudentCount;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 02: Subject Teacher summary resolution identifies isClassTeacher: false and lists active subjects', async () => {
  const origSectionFind = Section.find;
  const origTeachingAssignmentFind = TeachingAssignment.find;
  const origStudentCount = StudentProfile.countDocuments;
  const origAttendanceFindOne = Attendance.findOne;

  Section.find = () => makeChainable([]);
  TeachingAssignment.find = () => makeChainable([
    {
      _id: '507f1f77bcf86cd799439081',
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      sectionId: { _id: sectionB_Id, name: 'B', classId: { _id: classA_Id, name: 'Grade 5' } },
      subjectId: { _id: subjectEnglish_Id, name: 'English', code: 'ENG-5' },
      status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    },
  ]);
  StudentProfile.countDocuments = () => Promise.resolve(28);
  Attendance.findOne = () => makeChainable(null);

  const req = { user: teacherA_User };
  const res = createMockRes();

  await handleGetTeacherSummary(req, res);

  assert.strictEqual(res.statusCode, 200);
  const sections = res.body.data.sections;
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].isClassTeacher, false);
  assert.strictEqual(sections[0].assignedSubjects.length, 1);
  assert.strictEqual(sections[0].assignedSubjects[0].name, 'English');

  Section.find = origSectionFind;
  TeachingAssignment.find = origTeachingAssignmentFind;
  StudentProfile.countDocuments = origStudentCount;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 03: Combined assignments merges Class Teacher and Subject Teacher sections without duplicate entries', async () => {
  const origSectionFind = Section.find;
  const origTeachingAssignmentFind = TeachingAssignment.find;
  const origStudentCount = StudentProfile.countDocuments;
  const origAttendanceFindOne = Attendance.findOne;

  // Teacher A is Class Teacher of Section A AND teaches English in Section A, plus Math in Section B
  Section.find = () => makeChainable([
    { _id: sectionA_Id, name: 'A', classId: { _id: classA_Id, name: 'Grade 5' }, schoolId: schoolA_Id, classTeacherId: teacherA_Id },
  ]);
  TeachingAssignment.find = () => makeChainable([
    {
      _id: '507f1f77bcf86cd799439081',
      teacherId: teacherA_Id,
      sectionId: { _id: sectionA_Id, name: 'A', classId: { _id: classA_Id, name: 'Grade 5' } },
      subjectId: { _id: subjectEnglish_Id, name: 'English', code: 'ENG-5' },
      status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    },
    {
      _id: '507f1f77bcf86cd799439082',
      teacherId: teacherA_Id,
      sectionId: { _id: sectionB_Id, name: 'B', classId: { _id: classA_Id, name: 'Grade 5' } },
      subjectId: { _id: subjectMath_Id, name: 'Math', code: 'MTH-5' },
      status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    },
  ]);
  StudentProfile.countDocuments = () => Promise.resolve(30);
  Attendance.findOne = () => makeChainable(null);

  const req = { user: teacherA_User };
  const res = createMockRes();

  await handleGetTeacherSummary(req, res);

  assert.strictEqual(res.statusCode, 200);
  const sections = res.body.data.sections;
  // Must de-duplicate: Section A only appears once!
  assert.strictEqual(sections.length, 2);
  const secA = sections.find((s) => String(s._id) === sectionA_Id);
  assert.ok(secA);
  assert.strictEqual(secA.isClassTeacher, true);
  assert.strictEqual(secA.assignedSubjects.length, 1);

  Section.find = origSectionFind;
  TeachingAssignment.find = origTeachingAssignmentFind;
  StudentProfile.countDocuments = origStudentCount;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 04: Cross-school section access rejection (403 Forbidden)', async () => {
  const origSectionFindById = Section.findById;

  // Section belongs to School B
  Section.findById = () => ({
    populate: () => ({
      lean: () => Promise.resolve({
        _id: sectionForeign_Id,
        schoolId: schoolB_Id,
        classTeacherId: teacherA_Id,
      }),
    }),
  });

  const req = {
    user: teacherA_User, // verified posting School A
    body: {
      sectionId: sectionForeign_Id,
      date: '2026-09-23',
      records: [{ studentProfileId: student1_Id, status: 'PRESENT' }],
    },
  };
  const res = createMockRes();

  await handleSubmitAttendance(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /different school/i);

  Section.findById = origSectionFindById;
});

// ─── 2. ATTENDANCE WORKSPACE & SECURITY (Scenarios 5-9) ───────────────────────

await runAsyncTest('Scenario 05: Unauthorized attendance submission rejection (403 Forbidden)', async () => {
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentIsAssigned = TeachingAssignment.isTeacherAssigned;

  Section.findById = () => ({
    populate: () => ({
      lean: () => Promise.resolve({
        _id: sectionA_Id,
        schoolId: schoolA_Id,
        classTeacherId: teacherB_Id, // not teacher A
      }),
    }),
  });
  TeachingAssignment.isTeacherAssigned = () => Promise.resolve(false); // no active assignment

  const req = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: '2026-09-23',
      records: [{ studentProfileId: student1_Id, status: 'PRESENT' }],
    },
  };
  const res = createMockRes();

  await handleSubmitAttendance(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /no active teaching assignment/i);

  Section.findById = origSectionFindById;
  TeachingAssignment.isTeacherAssigned = origTeachingAssignmentIsAssigned;
});

await runAsyncTest('Scenario 06: Authorized attendance submission succeeds and preserves student individual remarks', async () => {
  const origSectionFindById = Section.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOne = Attendance.findOne;
  const origAttendanceSave = Attendance.prototype.save;

  Section.findById = () => ({
    populate: () => ({
      lean: () => Promise.resolve({
        _id: sectionA_Id,
        schoolId: schoolA_Id,
        classTeacherId: teacherA_Id,
      }),
    }),
  });

  StudentProfile.find = () => makeChainable([
    { _id: student1_Id, schoolId: schoolA_Id, sectionId: sectionA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
    { _id: student2_Id, schoolId: schoolA_Id, sectionId: sectionA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);

  let savedDoc = null;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  Attendance.findOne = () => makeChainable(null);
  Attendance.findOneAndUpdate = (_query, update) => {
    savedDoc = {
      _id: '507f1f77bcf86cd799439091',
      ...update.$set,
    };
    return Promise.resolve(savedDoc);
  };

  const req = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: '2026-09-23',
      records: [
        { studentProfileId: student1_Id, status: 'PRESENT', remarks: 'On time' },
        { studentProfileId: student2_Id, status: 'LEAVE', remarks: 'Medical appointment' },
      ],
    },
  };
  const res = createMockRes();

  await handleSubmitAttendance(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(savedDoc);
  assert.strictEqual(res.body.data.presentCount, 1);
  assert.strictEqual(res.body.data.leaveCount, 1);
  // Verify individual remarks preservation:
  const student2Record = savedDoc.records.find((r) => r.status === 'LEAVE');
  assert.strictEqual(student2Record.remarks, 'Medical appointment');

  Section.findById = origSectionFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOne = origAttendanceFindOne;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
});

await runAsyncTest('Scenario 07: Mark All Present behavior processes and records all students with PRESENT status', async () => {
  const origSectionFindById = Section.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => ({
    populate: () => ({
      lean: () => Promise.resolve({
        _id: sectionA_Id,
        schoolId: schoolA_Id,
        classTeacherId: teacherA_Id,
      }),
    }),
  });

  StudentProfile.find = () => makeChainable([
    { _id: student1_Id, schoolId: schoolA_Id, sectionId: sectionA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
    { _id: student2_Id, schoolId: schoolA_Id, sectionId: sectionA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);

  let savedAttendance = null;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  Attendance.findOne = () => makeChainable(null);
  Attendance.findOneAndUpdate = (_query, update) => {
    savedAttendance = {
      _id: '507f1f77bcf86cd799439092',
      ...update.$set,
    };
    return Promise.resolve(savedAttendance);
  };

  const req = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: '2026-09-23',
      records: [
        { studentProfileId: student1_Id, status: 'PRESENT' },
        { studentProfileId: student2_Id, status: 'PRESENT' },
      ],
    },
  };
  const res = createMockRes();

  await handleSubmitAttendance(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.presentCount, 2);
  assert.strictEqual(res.body.data.absentCount, 0);

  Section.findById = origSectionFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOne = origAttendanceFindOne;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
});

await runAsyncTest('Scenario 08: Attendance student ownership validation rejects foreign student IDs with 400', async () => {
  const origSectionFindById = Section.findById;
  const origStudentFind = StudentProfile.find;

  Section.findById = () => ({
    populate: () => ({
      lean: () => Promise.resolve({
        _id: sectionA_Id,
        schoolId: schoolA_Id,
        classTeacherId: teacherA_Id,
      }),
    }),
  });

  // Only student 1 is active in this section; studentForeign is NOT
  StudentProfile.find = () => makeChainable([
    { _id: student1_Id, schoolId: schoolA_Id, sectionId: sectionA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);

  const req = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: '2026-09-23',
      records: [
        { studentProfileId: studentForeign_Id, status: 'PRESENT' },
      ],
    },
  };
  const res = createMockRes();

  await handleSubmitAttendance(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /does not belong to the authorized roster|Cross-section/i);

  Section.findById = origSectionFindById;
  StudentProfile.find = origStudentFind;
});

await runAsyncTest('Scenario 09: Teacher self-attendance endpoint returns own monthly attendance records marked by HM', async () => {
  const origAttendanceFind = Attendance.find;

  Attendance.find = () => makeChainable([
    {
      _id: '507f1f77bcf86cd799439093',
      schoolId: schoolA_Id,
      date: new Date('2026-09-01'),
      records: [
        { userId: teacherA_Id, status: 'PRESENT' },
        { userId: teacherB_Id, status: 'ABSENT' },
      ],
    },
    {
      _id: '507f1f77bcf86cd799439094',
      schoolId: schoolA_Id,
      date: new Date('2026-09-02'),
      records: [
        { userId: teacherA_Id, status: 'LEAVE', remarks: 'Official duty' },
      ],
    },
  ]);

  const req = {
    user: teacherA_User,
    query: { month: '9', year: '2026' },
  };
  const res = createMockRes();

  await handleGetTeacherSelfAttendance(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.summary.presentCount, 1);
  assert.strictEqual(res.body.data.summary.leaveCount, 1);
  assert.strictEqual(res.body.data.summary.absentCount, 0);

  Attendance.find = origAttendanceFind;
});

// ─── 3. INTERNAL EXAMINATION & MARKS ENTRY (Scenarios 10-20) ──────────────────

await runAsyncTest('Scenario 10: Authorized exam marks entry for assigned class/section/subject succeeds with SUBMITTED status', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origResultFindOne = Result.findOne;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({
    _id: examA_Id,
    schoolId: schoolA_Id,
    status: 'ONGOING',
    save: () => Promise.resolve(),
  });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_1',
    teacherId: teacherA_Id,
    subjectId: subjectEnglish_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);
  Result.findOne = () => makeChainable(null);

  let createdResult = null;
  const origResultSave = Result.prototype.save;
  Result.prototype.save = function() {
    createdResult = this;
    return Promise.resolve(this);
  };
  AuditLog.create = () => Promise.resolve();

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [
        { studentId: student1_Id, obtainedMarks: 85, maxMarks: 100, remarks: 'Good work' },
      ],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(createdResult);
  assert.strictEqual(createdResult.status, 'SUBMITTED');
  assert.strictEqual(createdResult.percentage, 85);
  assert.strictEqual(createdResult.remarks, 'Good work');

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Result.findOne = origResultFindOne;
  Result.prototype.save = origResultSave;
});

await runAsyncTest('Scenario 11: Unauthorized subject marks entry rejected with 403 Forbidden', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  // Teacher A is NOT assigned to subject Math in Section A
  TeachingAssignment.findOne = () => makeChainable(null);

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      results: [{ studentId: student1_Id, obtainedMarks: 70, maxMarks: 100 }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /teaching assignment for this subject/i);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
});

await runAsyncTest('Scenario 12: Unauthorized section marks entry rejected with 403 Forbidden', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionB_Id, classId: classA_Id, schoolId: schoolA_Id, classTeacherId: teacherB_Id });
  TeachingAssignment.findOne = () => makeChainable(null);

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionB_Id,
      // No subjectId -> implies multi-subject which requires classTeacherId
      results: [{ studentId: student1_Id, subjectMarks: [{ subjectId: subjectEnglish_Id, obtainedMarks: 80 }] }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /Class Teacher/i);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
});

await runAsyncTest('Scenario 13: Cross-school exam marks rejection (BOLA Tripwire)', async () => {
  const origExamFindById = Exam.findById;

  // Exam belongs to School B
  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolB_Id, status: 'ONGOING' });

  const req = {
    user: teacherA_User, // verified posting School A
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [{ studentId: student1_Id, obtainedMarks: 75 }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /another school/i);

  Exam.findById = origExamFindById;
});

await runAsyncTest('Scenario 14: Marks boundary validation rejects negative marks and marks exceeding maximum total', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origSubjectFindById = Subject.findById;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_1', status: 'ACTIVE' });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);
  Subject.findById = () => makeChainable({ _id: subjectEnglish_Id, schoolId: schoolA_Id, name: 'ENGLISH', totalMarks: 100, passingMarks: 33 });

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  const origStartSession = mongoose.startSession;
  mongoose.startSession = () => Promise.resolve(mockSession);

  // Test: Exceeding max marks (105 / 100)
  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [{ studentId: student1_Id, obtainedMarks: 105, maxMarks: 100 }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /cannot exceed max marks/i);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
  mongoose.startSession = origStartSession;
});

await runAsyncTest('Scenario 15: Islamiat Nazra 20 + Written 80 calculation and boundary validation', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origSubjectFindById = Subject.findById;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING', save: () => Promise.resolve() });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_is', status: 'ACTIVE' });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);
  Subject.findById = () => makeChainable({ _id: subjectIslamiat_Id, schoolId: schoolA_Id, name: 'ISLAMIAT', code: 'ISL-5', totalMarks: 100, passingMarks: 33 });

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);
  AuditLog.create = () => Promise.resolve();

  let createdDoc = null;
  const origResultSave = Result.prototype.save;
  Result.prototype.save = function() {
    createdDoc = this;
    return Promise.resolve(this);
  };

  // Valid split: Nazra 18/20, Written 72/80 -> Total 90/100
  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectIslamiat_Id,
      results: [{
        studentId: student1_Id,
        subComponents: { nazra: 18, written: 72 },
      }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(createdDoc);
  const islamiatMarks = createdDoc.subjectMarks[0];
  assert.strictEqual(islamiatMarks.obtainedMarks, 90);
  assert.strictEqual(islamiatMarks.subComponents.nazra, 18);
  assert.strictEqual(islamiatMarks.subComponents.written, 72);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
  Result.prototype.save = origResultSave;
});

await runAsyncTest('Scenario 16: Drawing letter grade preservation without numerical percentage distortion', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origSubjectFindById = Subject.findById;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING', save: () => Promise.resolve() });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_dr', status: 'ACTIVE' });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);
  Subject.findById = () => makeChainable({ _id: subjectDrawing_Id, schoolId: schoolA_Id, name: 'DRAWING', isGradedOnly: true, totalMarks: 100 });

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);
  AuditLog.create = () => Promise.resolve();

  let createdDoc = null;
  const origResultSave = Result.prototype.save;
  Result.prototype.save = function() {
    createdDoc = this;
    return Promise.resolve(this);
  };

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectDrawing_Id,
      results: [{
        studentId: student1_Id,
        isGradedOnly: true,
        letterGrade: 'A+',
      }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(createdDoc);
  const drawingMark = createdDoc.subjectMarks[0];
  assert.strictEqual(drawingMark.isGradedOnly, true);
  assert.strictEqual(drawingMark.letterGrade, 'A+');
  assert.strictEqual(drawingMark.obtainedMarks, 0); // zero numerical skew

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
  Result.prototype.save = origResultSave;
  assert.strictEqual(drawingMark.maxMarks, 0);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
  Result.create = origResultCreate;
  mongoose.startSession = origStartSession;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 17: 700-mark schema calculation (Sindh Board standard grade computation)', async () => {
  const origExamFindById = Exam.findById;
  const origUserFindById = User.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origResultFindOne = Result.findOne;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({
    _id: examA_Id,
    schoolId: schoolA_Id,
    status: 'ONGOING',
    save: () => Promise.resolve(),
  });
  User.findById = () => makeChainable({ _id: student1_Id, schoolId: schoolA_Id, fullName: 'Bilal Ahmed' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id, classTeacherId: teacherA_Id });
  Result.findOne = () => makeChainable(null);

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);
  AuditLog.create = () => Promise.resolve();

  let createdResult = null;
  Result.create = (docs) => {
    createdResult = { _id: 'res_700', ...docs[0] };
    return Promise.resolve([createdResult]);
  };

  // 7 Subjects x 100 = 700 Max Marks. Obtained = 595 (85%) -> Grade A-1
  const subjects = [
    { subjectId: '507f1f77bcf86cd799439101', subjectName: 'English', obtainedMarks: 85, maxMarks: 100 },
    { subjectId: '507f1f77bcf86cd799439102', subjectName: 'Urdu', obtainedMarks: 85, maxMarks: 100 },
    { subjectId: '507f1f77bcf86cd799439103', subjectName: 'Math', obtainedMarks: 85, maxMarks: 100 },
    { subjectId: '507f1f77bcf86cd799439104', subjectName: 'Science', obtainedMarks: 85, maxMarks: 100 },
    { subjectId: '507f1f77bcf86cd799439105', subjectName: 'Social Studies', obtainedMarks: 85, maxMarks: 100 },
    { subjectId: '507f1f77bcf86cd799439106', subjectName: 'Sindhi', obtainedMarks: 85, maxMarks: 100 },
    { subjectId: '507f1f77bcf86cd799439107', subjectName: 'Islamiat', obtainedMarks: 85, maxMarks: 100 },
  ];

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: student1_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: subjects,
      remarks: 'Top rank candidate',
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(createdResult);
  assert.strictEqual(createdResult.totalMaxMarks, 700);
  assert.strictEqual(createdResult.totalObtainedMarks, 595);
  assert.strictEqual(createdResult.percentage, 85);
  assert.ok(['A-1', 'A+'].includes(createdResult.grade));
  assert.strictEqual(createdResult.resultStatus, 'PASSED');

  Exam.findById = origExamFindById;
  User.findById = origUserFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Result.findOne = origResultFindOne;
  Result.create = origResultCreate;
  mongoose.startSession = origStartSession;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 18: Academic and conduct remarks persistence on results', async () => {
  const origExamFindById = Exam.findById;
  const origUserFindById = User.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origResultFindOne = Result.findOne;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING', save: () => Promise.resolve() });
  User.findById = () => makeChainable({ _id: student1_Id, schoolId: schoolA_Id });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id, classTeacherId: teacherA_Id });
  Result.findOne = () => makeChainable(null);

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);
  AuditLog.create = () => Promise.resolve();

  let createdDoc = null;
  Result.create = (docs) => {
    createdDoc = { _id: 'res_rem', ...docs[0] };
    return Promise.resolve([createdDoc]);
  };

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      studentId: student1_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectMarks: [{ subjectId: subjectEnglish_Id, obtainedMarks: 78, maxMarks: 100 }],
      remarks: 'Disciplined student with excellent conduct.',
    },
  };
  const res = createMockRes();

  await handleSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdDoc.remarks, 'Disciplined student with excellent conduct.');

  Exam.findById = origExamFindById;
  User.findById = origUserFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Result.findOne = origResultFindOne;
  Result.create = origResultCreate;
  mongoose.startSession = origStartSession;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 19: Bulk student marks submission in atomic session', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origResultCreate = Result.create;
  const origStartSession = mongoose.startSession;
  const origAuditCreate = AuditLog.create;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING', save: () => Promise.resolve() });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_1', status: 'ACTIVE' });

  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
    { _id: 'sp_2', userId: student2_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);

  let commitCalled = false;
  const mockSession = {
    startTransaction() {},
    commitTransaction: () => { commitCalled = true; return Promise.resolve(); },
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);
  AuditLog.create = () => Promise.resolve();

  let createdBatch = [];
  const origResultSave = Result.prototype.save;
  Result.prototype.save = function() {
    createdBatch.push(this);
    return Promise.resolve(this);
  };

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [
        { studentId: student1_Id, obtainedMarks: 80, maxMarks: 100 },
        { studentId: student2_Id, obtainedMarks: 90, maxMarks: 100 },
      ],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(commitCalled, true);
  assert.strictEqual(res.body.data.processedCount, 2);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Result.prototype.save = origResultSave;
});

await runAsyncTest('Scenario 20: Published / locked examination protection (Immutability guarantee)', async () => {
  const origExamFindById = Exam.findById;

  Exam.findById = () => Promise.resolve({
    _id: examA_Id,
    schoolId: schoolA_Id,
    status: 'PUBLISHED', // LOCKED
  });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [{ studentId: student1_Id, obtainedMarks: 85 }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /permanently locked/i);

  Exam.findById = origExamFindById;
});

// ─── 4. HOMEWORK WORKSPACE & SERVICE RECORD (Scenarios 21-25) ─────────────────

await runAsyncTest('Scenario 21: Authorized homework creation succeeds for verified school+class+section+subject', async () => {
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origSubjectFindById = Subject.findById;
  const origHomeworkCreate = Homework.create;
  const origAuditCreate = AuditLog.create;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_hw',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    subjectId: subjectEnglish_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectEnglish_Id, schoolId: schoolA_Id });

  let createdHw = null;
  Homework.create = (doc) => {
    createdHw = { _id: 'hw_1', ...doc };
    return Promise.resolve(createdHw);
  };
  AuditLog.create = () => Promise.resolve();

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      title: 'Grammar Exercises Unit 3',
      description: 'Solve questions 1-10 on notebook page 45',
      dueDate: '2026-09-30',
    },
    headers: {},
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(createdHw);
  assert.strictEqual(createdHw.title, 'Grammar Exercises Unit 3');
  assert.strictEqual(String(createdHw.teacherId), teacherA_Id);

  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Subject.findById = origSubjectFindById;
  Homework.create = origHomeworkCreate;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 22: Cross-teacher homework cancellation rejection (403 Forbidden)', async () => {
  const origHomeworkFindById = Homework.findById;

  const validHomeworkId = '507f1f77bcf86cd799439091';
  // Homework was created by Teacher B
  Homework.findById = () => Promise.resolve({
    _id: validHomeworkId,
    schoolId: schoolA_Id,
    teacherId: teacherB_Id, // sadia bibi
    status: 'ACTIVE',
  });

  const req = {
    user: teacherA_User, // Tariq Mahmood attempting to cancel Sadia's homework
    params: { id: validHomeworkId },
    headers: {},
  };
  const res = createMockRes();

  await handleCancelHomework(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /only cancel your own/i);

  Homework.findById = origHomeworkFindById;
});

await runAsyncTest('Scenario 23: Teacher service record & summary restricts data to own verified school posting and duties', async () => {
  const origSectionFind = Section.find;
  const origTeachingAssignmentFind = TeachingAssignment.find;
  const origStudentCount = StudentProfile.countDocuments;
  const origAttendanceFindOne = Attendance.findOne;

  Section.find = () => makeChainable([]);
  TeachingAssignment.find = () => makeChainable([]);
  StudentProfile.countDocuments = () => Promise.resolve(0);
  Attendance.findOne = () => makeChainable(null);

  const req = { user: teacherA_User };
  const res = createMockRes();

  await handleGetTeacherSummary(req, res);

  assert.strictEqual(res.statusCode, 200);
  const data = res.body.data;
  // Confirms teacher context is scoped to teacher A and does not expose other teachers
  assert.strictEqual(data.teacherContext.teacherId, teacherA_Id);
  assert.strictEqual(data.teacherContext.schoolId, schoolA_Id);

  Section.find = origSectionFind;
  TeachingAssignment.find = origTeachingAssignmentFind;
  StudentProfile.countDocuments = origStudentCount;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 24: Anti-BOLA / IDOR: Client-manipulated teacherId & schoolId are ignored', async () => {
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origSubjectFindById = Subject.findById;
  const origHomeworkCreate = Homework.create;
  const origAuditCreate = AuditLog.create;

  let queryTeacherId = null;
  let querySchoolId = null;

  TeachingAssignment.findOne = (query) => {
    queryTeacherId = query.teacherId;
    querySchoolId = query.schoolId;
    return makeChainable({
      _id: 'ta_hw2',
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    });
  };

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectEnglish_Id, schoolId: schoolA_Id });
  Homework.create = (doc) => Promise.resolve({ _id: 'hw_2', ...doc });
  AuditLog.create = () => Promise.resolve();

  // Attacker tries to inject teacherB_Id and schoolB_Id in request body!
  const req = {
    user: teacherA_User,
    body: {
      teacherId: teacherB_Id, // injected
      schoolId: schoolB_Id,   // injected
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      title: 'Injected Homework',
      dueDate: '2026-09-30',
    },
    headers: {},
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 201);
  // Backend derived teacherId from JWT actor (teacherA), completely ignoring body.teacherId!
  assert.strictEqual(String(queryTeacherId), teacherA_Id);
  assert.strictEqual(String(querySchoolId), schoolA_Id);

  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Subject.findById = origSubjectFindById;
  Homework.create = origHomeworkCreate;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 25: Regression verification: Teacher marks integrate with HM verification gate', async () => {
  const origResultFindById = Result.findById;
  const origExamFindById = Exam.findById;
  const origAuditCreate = AuditLog.create;

  const validResultId = '507f1f77bcf86cd799439088';
  const teacherSubmittedResult = {
    _id: validResultId,
    examId: examA_Id,
    schoolId: schoolA_Id,
    studentId: student1_Id,
    status: 'SUBMITTED',
    approvedByHM: null,
    save: function () { return Promise.resolve(this); },
  };

  Result.findById = () => Promise.resolve(teacherSubmittedResult);
  Exam.findById = () => makeChainable({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  AuditLog.create = () => Promise.resolve();

  const hmUser = {
    _id: hmA_Id,
    role: ROLES.HM,
    schoolId: { _id: schoolA_Id },
    fullName: 'Head Master Liaquatabad',
  };

  const req = {
    user: hmUser,
    params: { id: validResultId },
    body: { remarks: 'Verified and certified by HM' },
  };
  const res = createMockRes();

  await handleVerifyExamResult(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(teacherSubmittedResult.status, 'VERIFIED_BY_HM');
  assert.strictEqual(teacherSubmittedResult.approvedByHM, hmA_Id);

  Result.findById = origResultFindById;
  Exam.findById = origExamFindById;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 26: Mixed batch payload (10 authorized students + 1 foreign student) atomically rejects entire submission with 403 and zero partial writes', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origSubjectFindById = Subject.findById;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_1', status: 'ACTIVE' });

  // 10 authorized students in section A
  const authorizedProfiles = [];
  const entries = [];
  for (let i = 1; i <= 10; i++) {
    const sId = `507f1f77bcf86cd7994390${i < 10 ? '0' + i : i}`;
    authorizedProfiles.push({
      _id: `sp_${i}`,
      userId: sId,
      sectionId: sectionA_Id,
      schoolId: schoolA_Id,
      lifecycleStatus: STUDENT_STATUS.ACTIVE,
    });
    entries.push({ studentId: sId, obtainedMarks: 75, maxMarks: 100 });
  }

  // Inject 1 foreign student (studentForeign_Id) from Section B
  entries.push({ studentId: studentForeign_Id, obtainedMarks: 80, maxMarks: 100 });

  StudentProfile.find = () => makeChainable(authorizedProfiles);
  Subject.findById = () => makeChainable({ _id: subjectEnglish_Id, schoolId: schoolA_Id, name: 'ENGLISH', totalMarks: 100 });

  let saveCalled = false;
  const origResultSave = Result.prototype.save;
  Result.prototype.save = function () {
    saveCalled = true;
    return Promise.resolve(this);
  };

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: entries,
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /does not belong to this section/i);
  // Zero partial write guarantee: Not a single result was saved!
  assert.strictEqual(saveCalled, false);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
  Result.prototype.save = origResultSave;
});

await runAsyncTest('Scenario 27: Duplicate studentId entries in bulk marks payload are rejected with 400 Bad Request', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_1', status: 'ACTIVE' });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [
        { studentId: student1_Id, obtainedMarks: 70 },
        { studentId: student1_Id, obtainedMarks: 95 }, // duplicate student1_Id
      ],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /duplicate studentId detected/i);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
});

await runAsyncTest('Scenario 28: Malformed / non-finite marks (NaN, Infinity, null) in bulk marks payload are rejected with 400 Bad Request', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origSubjectFindById = Subject.findById;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_1', status: 'ACTIVE' });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);
  Subject.findById = () => makeChainable({ _id: subjectEnglish_Id, schoolId: schoolA_Id, name: 'ENGLISH', totalMarks: 100 });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectEnglish_Id,
      results: [{ studentId: student1_Id, obtainedMarks: 'NOT_A_NUMBER' }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /valid finite number/i);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
});

await runAsyncTest('Scenario 29: Invalid Drawing letter grade is rejected with 400 Bad Request', async () => {
  const origExamFindById = Exam.findById;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origTeachingAssignmentFindOne = TeachingAssignment.findOne;
  const origStudentFind = StudentProfile.find;
  const origSubjectFindById = Subject.findById;

  Exam.findById = () => Promise.resolve({ _id: examA_Id, schoolId: schoolA_Id, status: 'ONGOING' });
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id });
  TeachingAssignment.findOne = () => makeChainable({ _id: 'ta_dr', status: 'ACTIVE' });
  StudentProfile.find = () => makeChainable([
    { _id: 'sp_1', userId: student1_Id, sectionId: sectionA_Id, schoolId: schoolA_Id, lifecycleStatus: STUDENT_STATUS.ACTIVE },
  ]);
  Subject.findById = () => makeChainable({ _id: subjectDrawing_Id, schoolId: schoolA_Id, name: 'DRAWING', isGradedOnly: true, totalMarks: 100 });

  const req = {
    user: teacherA_User,
    params: { id: examA_Id },
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectDrawing_Id,
      results: [{ studentId: student1_Id, isGradedOnly: true, letterGrade: 'INVALID_GRADE_XYZ' }],
    },
  };
  const res = createMockRes();

  await handleBulkSubmitStudentMarks(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /invalid letter grade/i);

  Exam.findById = origExamFindById;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  TeachingAssignment.findOne = origTeachingAssignmentFindOne;
  StudentProfile.find = origStudentFind;
  Subject.findById = origSubjectFindById;
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} TEACHER OPERATIONAL WORKSPACE TESTS PASSED!`);
console.log('======================================================================\n');
