/**
 * 🏛️ SMART ATTENDANCE SYSTEM TEST SUITE (FEATURE 1)
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Core Principle Verification:
 * "Teacher does NOT manually mark Present students. System defaults all enrolled
 * active students to PRESENT. Teacher only marks exceptions: A (Absent) or L (Leave)."
 *
 * Scenarios Covered:
 * [Authorization]
 * 01. Authorized Class Teacher can submit attendance
 * 02. Authorized Subject Teacher with active TeachingAssignment can submit
 * 03. Unauthorized section rejected with 403 Forbidden
 * 04. Cross-school section rejected with 403 Forbidden
 * 05. Inactive / unauthorized teacher rejected with 403 Forbidden
 *
 * [Smart Default & Derivation]
 * 06. 40-student roster with zero exceptions produces 40 Present records
 * 07. 40 students + 2 Absent produces 38 Present + 2 Absent records
 * 08. 40 students + 2 Absent + 1 Leave produces 37 Present + 2 Absent + 1 Leave records
 * 09. Student omitted from exception payload automatically derives to PRESENT
 * 10. Inactive student profile rejected if submitted as exception
 *
 * [Tampering & Validation]
 * 11. Foreign student ID rejected with 400 Bad Request
 * 12. Cross-school student ID rejected with 400 Bad Request
 * 13. Duplicate student ID in exceptions rejected with 400 Bad Request
 * 14. Same student in both Absent and Leave rejected with 400 Bad Request
 * 15. Invalid attendance status in records rejected with 400 Bad Request
 * 16. Malformed / non-hex student ID rejected with 400 Bad Request
 *
 * [Business Rules & Compatibility]
 * 17. Future attendance date rejected with 400 Bad Request
 * 18. Duplicate submission handles idempotency with contentHash
 * 19. Full records array payload compatibility (legacy client payload) derives correctly
 * 20. Attendance window closure / holiday rules enforced
 * 21. Individual student remarks persistence alongside derived statuses
 * 22. AuditLog creation with detailed before/after counts
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  USER_STATUS,
  ATTENDANCE_STATUS,
  STUDENT_STATUS,
} from '../config/constants.js';

// Production Controller & Models
import { handleSubmitAttendance } from '../src/controllers/attendanceController.js';
import Section from '../src/models/Section.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import Attendance from '../src/models/Attendance.js';
import StudentProfile from '../src/models/StudentProfile.js';
import School from '../src/models/School.js';
import AuditLog from '../src/models/AuditLog.js';

let totalTests = 0;
let passedTests = 0;

async function runAsyncTest(testName, testExecutionFunction) {
  totalTests++;
  try {
    await testExecutionFunction();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (caughtError) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(caughtError);
    throw caughtError;
  }
}

function createMockResponse() {
  const mockResponse = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(responseData) {
      this.body = responseData;
      return this;
    },
  };
  return mockResponse;
}

function makeChainable(mockData) {
  return {
    _data: mockData,
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
console.log('🏛️ EXECUTING SMART ATTENDANCE SYSTEM TEST SUITE (FEATURE 1)');
console.log('======================================================================\n');

// ─── Standard Identifiers ────────────────────────────────────────────────────
const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';
const teacherA_Id = '507f1f77bcf86cd799439051';
const teacherB_Id = '507f1f77bcf86cd799439052';
const classA_Id = '507f1f77bcf86cd799439011';
const sectionA_Id = '507f1f77bcf86cd799439021';
const sectionB_Id = '507f1f77bcf86cd799439022';
const foreignStudentProfile_Id = '507f1f77bcf86cd799439099';

const teacherA_User = {
  _id: teacherA_Id,
  userId: teacherA_Id,
  role: ROLES.TEACHER,
  schoolId: schoolA_Id,
  status: USER_STATUS.ACTIVE,
  fullName: 'Teacher A',
  designation: 'PST Teacher',
};

// Generate 40 active student profiles for Section A
const mock40StudentProfiles = [];
for (let studentIndex = 1; studentIndex <= 40; studentIndex++) {
  const hexIndexString = studentIndex < 10 ? '0' + studentIndex : String(studentIndex);
  const studentProfileId = `607f1f77bcf86cd7994390${hexIndexString}`;
  const studentUserId = `507f1f77bcf86cd7994390${hexIndexString}`;
  mock40StudentProfiles.push({
    _id: studentProfileId,
    userId: { _id: studentUserId, fullName: `Student ${studentIndex}` },
    sectionId: sectionA_Id,
    schoolId: schoolA_Id,
    grNumber: 1000 + studentIndex,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  });
}

// Stub AuditLog.create
AuditLog.create = async () => ({ _id: 'mock_audit_log_id' });

// Mock school with full 24-hour attendance submission window for both regular and Friday schedules.
// Prevents time-of-day and day-of-week test flakiness regardless of when the test suite runs.
const createMockOpenSchool = (targetSchoolId = schoolA_Id) => ({
  _id: targetSchoolId,
  timings: {
    regular: {
      startTime: '08:00',
      endTime: '13:30',
      attendanceWindowStart: '00:00',
      attendanceWindowEnd: '23:59',
    },
    friday: {
      startTime: '07:30',
      endTime: '12:00',
      attendanceWindowStart: '00:00',
      attendanceWindowEnd: '23:59',
    },
  },
});

// ─── Tests Execution ─────────────────────────────────────────────────────────

await runAsyncTest('Scenario 01: Authorized Class Teacher can submit attendance', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id, // designated class teacher
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let savedRecord = null;
  Attendance.findOneAndUpdate = (query, update) => {
    savedRecord = update.$set;
    return Promise.resolve({ _id: 'att_123', ...savedRecord });
  };

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [mock40StudentProfiles[0]._id],
      leaveStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.strictEqual(savedRecord.records.length, 40);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 02: Authorized Subject Teacher with active TeachingAssignment can submit', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origTeachingAssignment = TeachingAssignment.isTeacherAssigned;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherB_Id, // someone else is Class Teacher
  });
  TeachingAssignment.isTeacherAssigned = async () => true; // Subject Teacher holds assignment
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);
  Attendance.findOneAndUpdate = (query, update) => Promise.resolve({ _id: 'att_st' });

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [],
      leaveStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  TeachingAssignment.isTeacherAssigned = origTeachingAssignment;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 03: Unauthorized section rejected with 403 Forbidden', async () => {
  const origSectionFindById = Section.findById;
  const origTeachingAssignment = TeachingAssignment.isTeacherAssigned;

  Section.findById = () => makeChainable({
    _id: sectionB_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherB_Id, // teacherB is CT
  });
  TeachingAssignment.isTeacherAssigned = async () => false; // teacherA is NOT assigned

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionB_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 403);
  assert.match(mockResponse.body.message, /no active teaching assignment or class teacher role/i);

  Section.findById = origSectionFindById;
  TeachingAssignment.isTeacherAssigned = origTeachingAssignment;
});

await runAsyncTest('Scenario 04: Cross-school section rejected with 403 Forbidden', async () => {
  const origSectionFindById = Section.findById;

  Section.findById = () => makeChainable({
    _id: '507f1f77bcf86cd799439033',
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolB_Id, // Section belongs to School B!
    classTeacherId: teacherA_Id,
  });

  const mockRequest = {
    user: teacherA_User, // Teacher posted at School A
    body: {
      sectionId: '507f1f77bcf86cd799439033',
      date: new Date().toISOString().split('T')[0],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 403);
  assert.match(mockResponse.body.message, /belongs to a different school/i);

  Section.findById = origSectionFindById;
});

await runAsyncTest('Scenario 05: Inactive / unauthorized teacher rejected with 403 Forbidden', async () => {
  const inactiveTeacher = {
    ...teacherA_User,
    status: USER_STATUS.SUSPENDED,
  };

  const mockRequest = {
    user: inactiveTeacher,
    body: { sectionId: sectionA_Id },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 403);
  assert.match(mockResponse.body.message, /not in an active state/i);
});

await runAsyncTest('Scenario 06: 40-student roster with zero exceptions produces 40 Present records', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let capturedRecords = null;
  Attendance.findOneAndUpdate = (query, update) => {
    capturedRecords = update.$set.records;
    return Promise.resolve({ _id: 'att_smart_0', records: capturedRecords });
  };

  // Zero exceptions submitted
  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [],
      leaveStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.strictEqual(capturedRecords.length, 40);
  const presentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;
  assert.strictEqual(presentCount, 40, 'All 40 students must automatically default to PRESENT');

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 07: 40 students + 2 Absent produces 38 Present + 2 Absent records', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let capturedRecords = null;
  Attendance.findOneAndUpdate = (query, update) => {
    capturedRecords = update.$set.records;
    return Promise.resolve({ _id: 'att_smart_2a', records: capturedRecords });
  };

  const absentIds = [mock40StudentProfiles[2]._id, mock40StudentProfiles[7]._id]; // Student 3 & 8

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: absentIds,
      leaveStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.strictEqual(capturedRecords.length, 40);
  const presentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length;
  assert.strictEqual(presentCount, 38, '38 students must be PRESENT');
  assert.strictEqual(absentCount, 2, '2 students must be ABSENT');

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 08: 40 students + 2 Absent + 1 Leave produces 37 Present + 2 Absent + 1 Leave records', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let capturedRecords = null;
  Attendance.findOneAndUpdate = (query, update) => {
    capturedRecords = update.$set.records;
    return Promise.resolve({ _id: 'att_smart_2a1l', records: capturedRecords });
  };

  const absentIds = [mock40StudentProfiles[0]._id, mock40StudentProfiles[1]._id];
  const leaveIds = [mock40StudentProfiles[2]._id];

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: absentIds,
      leaveStudentProfileIds: leaveIds,
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.strictEqual(capturedRecords.length, 40);
  const presentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.LEAVE).length;

  assert.strictEqual(presentCount, 37, '37 students must be PRESENT');
  assert.strictEqual(absentCount, 2, '2 students must be ABSENT');
  assert.strictEqual(leaveCount, 1, '1 student must be LEAVE');

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 09: Student omitted from exception payload automatically derives to PRESENT', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let capturedRecords = null;
  Attendance.findOneAndUpdate = (query, update) => {
    capturedRecords = update.$set.records;
    return Promise.resolve({ _id: 'att_smart_omitted', records: capturedRecords });
  };

  // Only Student 1 is marked Absent; Students 2..40 are completely omitted from the payload
  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [mock40StudentProfiles[0]._id],
      leaveStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  const student2Record = capturedRecords.find((r) => String(r.userId) === String(mock40StudentProfiles[1].userId._id));
  assert.strictEqual(student2Record.status, ATTENDANCE_STATUS.PRESENT, 'Omitted student must be PRESENT');

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 10: Inactive student profile rejected if submitted as exception', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  // Database only returns ACTIVE students for authoritative roster
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);

  const inactiveStudentProfileId = '607f1f77bcf86cd799439999';

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [inactiveStudentProfileId],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /does not belong to the authorized roster/i);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
});

await runAsyncTest('Scenario 11: Foreign student ID rejected with 400 Bad Request', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [foreignStudentProfile_Id],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /Cross-section or external student IDs are rejected/i);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
});

await runAsyncTest('Scenario 12: Cross-school student ID rejected with 400 Bad Request', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);

  const crossSchoolStudentId = '607f1f77bcf86cd799439098';

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      leaveStudentProfileIds: [crossSchoolStudentId],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /Cross-section or external student IDs are rejected/i);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
});

await runAsyncTest('Scenario 13: Duplicate student ID in exceptions rejected with 400 Bad Request', async () => {
  const origSectionFindById = Section.findById;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });

  const dupStudentId = mock40StudentProfiles[0]._id;

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [dupStudentId, dupStudentId], // duplicate ID!
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /duplicate studentProfileId detected/i);

  Section.findById = origSectionFindById;
});

await runAsyncTest('Scenario 14: Same student in both Absent and Leave rejected with 400 Bad Request', async () => {
  const origSectionFindById = Section.findById;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });

  const conflictingId = mock40StudentProfiles[0]._id;

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [conflictingId],
      leaveStudentProfileIds: [conflictingId], // overlap!
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /cannot be marked both Absent and Leave simultaneously/i);

  Section.findById = origSectionFindById;
});

await runAsyncTest('Scenario 15: Invalid attendance status in records rejected with 400 Bad Request', async () => {
  const origSectionFindById = Section.findById;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      records: [
        { studentProfileId: mock40StudentProfiles[0]._id, status: 'INVALID_STATUS_XYZ' },
      ],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /Invalid attendance status/i);

  Section.findById = origSectionFindById;
});

await runAsyncTest('Scenario 16: Malformed / non-hex student ID rejected with 400 Bad Request', async () => {
  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: ['not-a-valid-24-hex-id'],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /Invalid studentProfileId format/i);
});

await runAsyncTest('Scenario 17: Future attendance date rejected with 400 Bad Request', async () => {
  const origSectionFindById = Section.findById;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 5);

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: futureDate.toISOString().split('T')[0],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 400);
  assert.match(mockResponse.body.message, /cannot be submitted for a future date/i);

  Section.findById = origSectionFindById;
});

await runAsyncTest('Scenario 18: Duplicate submission handles idempotency with contentHash', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);

  let findOneAndUpdateCount = 0;
  Attendance.findOneAndUpdate = () => {
    findOneAndUpdateCount++;
    return Promise.resolve({ _id: 'att_idem' });
  };
  // Emulate existing record
  Attendance.findOne = () => makeChainable({ _id: 'existing_att', contentHash: 'some_hash' });

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.strictEqual(findOneAndUpdateCount, 1);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 19: Full records array payload compatibility (legacy client payload) derives correctly', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let capturedRecords = null;
  Attendance.findOneAndUpdate = (query, update) => {
    capturedRecords = update.$set.records;
    return Promise.resolve({ _id: 'att_legacy', records: capturedRecords });
  };

  // Legacy client sends 'records' array with 1 Absent and 1 Leave
  const legacyRecords = [
    { studentProfileId: mock40StudentProfiles[0]._id, status: ATTENDANCE_STATUS.ABSENT, remarks: 'Unwell' },
    { studentProfileId: mock40StudentProfiles[1]._id, status: ATTENDANCE_STATUS.LEAVE, remarks: 'Official leave' },
    { studentProfileId: mock40StudentProfiles[2]._id, status: ATTENDANCE_STATUS.PRESENT },
  ];

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      records: legacyRecords,
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.strictEqual(capturedRecords.length, 40);
  const absentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.LEAVE).length;
  const presentCount = capturedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;

  assert.strictEqual(absentCount, 1);
  assert.strictEqual(leaveCount, 1);
  assert.strictEqual(presentCount, 38);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 20: Attendance window closure / holiday rules enforced', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  // School marked permanently closed or window closed without late override
  School.findById = () => makeChainable({
    _id: schoolA_Id,
    timings: {
      regular: {
        startTime: '08:00',
        endTime: '13:30',
        attendanceWindowStart: '07:45',
        attendanceWindowEnd: '08:15',
      },
    },
  });

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: '2026-09-20', // Sunday (Weekly Off)
      absentStudentProfileIds: [],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 403);
  assert.match(mockResponse.body.message, /Weekly holiday|window/i);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
});

await runAsyncTest('Scenario 21: Individual student remarks persistence alongside derived statuses', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);

  let capturedRecords = null;
  Attendance.findOneAndUpdate = (query, update) => {
    capturedRecords = update.$set.records;
    return Promise.resolve({ _id: 'att_remarks', records: capturedRecords });
  };

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [mock40StudentProfiles[0]._id],
      records: [
        { studentProfileId: mock40StudentProfiles[0]._id, remarks: 'Severe viral fever' },
        { studentProfileId: mock40StudentProfiles[1]._id, remarks: 'Late arrival due to heavy rain' },
      ],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  const rec1 = capturedRecords.find((r) => String(r.userId) === String(mock40StudentProfiles[0].userId._id));
  const rec2 = capturedRecords.find((r) => String(r.userId) === String(mock40StudentProfiles[1].userId._id));

  assert.strictEqual(rec1.status, ATTENDANCE_STATUS.ABSENT);
  assert.strictEqual(rec1.remarks, 'Severe viral fever');
  assert.strictEqual(rec2.status, ATTENDANCE_STATUS.PRESENT);
  assert.strictEqual(rec2.remarks, 'Late arrival due to heavy rain');

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
});

await runAsyncTest('Scenario 22: AuditLog creation with detailed before/after counts', async () => {
  const origSectionFindById = Section.findById;
  const origSchoolFindById = School.findById;
  const origStudentFind = StudentProfile.find;
  const origAttendanceFindOneAndUpdate = Attendance.findOneAndUpdate;
  const origAttendanceFindOne = Attendance.findOne;
  const origAuditLogCreate = AuditLog.create;

  Section.findById = () => makeChainable({
    _id: sectionA_Id,
    classId: { _id: classA_Id, name: 'Class 5' },
    schoolId: schoolA_Id,
    classTeacherId: teacherA_Id,
  });
  School.findById = () => makeChainable(createMockOpenSchool(schoolA_Id));
  StudentProfile.find = () => makeChainable(mock40StudentProfiles);
  Attendance.findOne = () => makeChainable(null);
  Attendance.findOneAndUpdate = () => Promise.resolve({ _id: 'att_audit_test' });

  let auditPayload = null;
  AuditLog.create = (entry) => {
    auditPayload = entry;
    return Promise.resolve({ _id: 'audit_created_id' });
  };

  const mockRequest = {
    user: teacherA_User,
    body: {
      sectionId: sectionA_Id,
      date: new Date().toISOString().split('T')[0],
      absentStudentProfileIds: [mock40StudentProfiles[0]._id],
      leaveStudentProfileIds: [mock40StudentProfiles[1]._id],
    },
  };
  const mockResponse = createMockResponse();

  await handleSubmitAttendance(mockRequest, mockResponse);

  assert.strictEqual(mockResponse.statusCode, 200);
  assert.ok(auditPayload, 'AuditLog must be created');
  assert.strictEqual(auditPayload.action, 'ATTENDANCE_SUBMITTED');
  assert.strictEqual(auditPayload.targetModel, 'Attendance');
  assert.strictEqual(auditPayload.newState.totalRecords, 40);
  assert.strictEqual(auditPayload.newState.presentCount, 38);
  assert.strictEqual(auditPayload.newState.absentCount, 1);
  assert.strictEqual(auditPayload.newState.leaveCount, 1);

  Section.findById = origSectionFindById;
  School.findById = origSchoolFindById;
  StudentProfile.find = origStudentFind;
  Attendance.findOneAndUpdate = origAttendanceFindOneAndUpdate;
  Attendance.findOne = origAttendanceFindOne;
  AuditLog.create = origAuditLogCreate;
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} SMART ATTENDANCE SYSTEM TESTS PASSED!`);
console.log('======================================================================\n');
