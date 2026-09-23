/**
 * 🏛️ STUDENT WORKSPACE TEST SUITE (PHASE 1 BACKEND SECURITY & ENDPOINTS)
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Comprehensive verification of the Student Workspace security contract:
 *  - Group 1: Student Profile Self-Access & BOLA Defense (Tests 1-5)
 *  - Group 2: Student Examination Results Self-Access & Publication Gate (Tests 6-10)
 *  - Group 3: Official Marksheet Streaming & IDOR Defense (Tests 11-16)
 *  - Group 4: Attendance Analytics IDOR Defense (Tests 17-19)
 *  - Group 5: Section Student Roster Privacy Boundary (Tests 20-21)
 *  - Group 6: Cohort Results & Tabulation Sheet Isolation (Tests 22-25)
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  handleGetMyStudentProfile,
  handleGetSectionStudents,
} from '../src/controllers/studentController.js';
import {
  handleGetMyExamResults,
  handleGetExamResults,
  handleDownloadStudentMarksheet,
  handleDownloadClassTabulationPdf,
  handleGetClassTabulationData,
} from '../src/controllers/examController.js';
import {
  handleGetStudentAttendanceAnalytics,
} from '../src/controllers/attendanceAnalyticsController.js';
import User from '../src/models/User.js';
import StudentProfile from '../src/models/StudentProfile.js';
import Exam from '../src/models/Exam.js';
import Result from '../src/models/Result.js';
import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import AuditLog from '../src/models/AuditLog.js';
import AttendanceSummary from '../src/models/AttendanceSummary.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import { ROLES, USER_STATUS, STUDENT_STATUS } from '../config/constants.js';

let totalTests = 0;
let passedTests = 0;

async function runAsyncTest(testName, testFunction) {
  totalTests++;
  try {
    await testFunction();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    chunks: [],
    setHeader(headerName, headerValue) {
      this.headers[headerName.toLowerCase()] = headerValue;
      return this;
    },
    status(httpStatusCode) {
      this.statusCode = httpStatusCode;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(chunk);
      this.isEnded = true;
      return this;
    },
    pipe(destinationStream) {
      return destinationStream;
    },
    on(event, handler) {
      if (event === 'finish' && this.isEnded) {
        handler();
      }
      return this;
    },
    once(event, handler) {
      return this.on(event, handler);
    },
    emit() {},
  };
  return response;
}

function makeChainableQuery(resolvedData) {
  return {
    _data: resolvedData,
    session() { return this; },
    populate() { return this; },
    sort() { return this; },
    select() { return this; },
    lean() { return Promise.resolve(this._data); },
    then(onFulfilled, onRejected) {
      return Promise.resolve(this._data).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve(this._data).catch(onRejected);
    },
  };
}

// ─── Test Fixtures & Deterministic Identifiers ───────────────────────────────
const schoolA_Id = new mongoose.Types.ObjectId().toString();
const schoolB_Id = new mongoose.Types.ObjectId().toString();

const classA_Id = new mongoose.Types.ObjectId().toString();
const sectionA_Id = new mongoose.Types.ObjectId().toString();

const studentA_UserId = new mongoose.Types.ObjectId().toString();
const studentA_ProfileId = new mongoose.Types.ObjectId().toString();

const studentB_UserId = new mongoose.Types.ObjectId().toString();
const studentB_ProfileId = new mongoose.Types.ObjectId().toString();

const teacherA_UserId = new mongoose.Types.ObjectId().toString();
const hmA_UserId = new mongoose.Types.ObjectId().toString();

const examA_Id = new mongoose.Types.ObjectId().toString();
const examB_Id = new mongoose.Types.ObjectId().toString(); // foreign school exam

const authenticatedStudentA = {
  _id: studentA_UserId,
  userId: studentA_UserId,
  fullName: 'Muhammad Bilal Khan',
  email: 'bilal.khan@student.dmc.edu.pk',
  role: ROLES.STUDENT,
  status: USER_STATUS.ACTIVE,
  schoolId: schoolA_Id,
  permissions: ['exams.view', 'attendance.view', 'documents.view', 'homework.view'],
};

const authenticatedStudentB = {
  _id: studentB_UserId,
  userId: studentB_UserId,
  fullName: 'Tariq Mehmood',
  email: 'tariq.mehmood@student.dmc.edu.pk',
  role: ROLES.STUDENT,
  status: USER_STATUS.ACTIVE,
  schoolId: schoolA_Id,
  permissions: ['exams.view', 'attendance.view', 'documents.view', 'homework.view'],
};

const authenticatedTeacherA = {
  _id: teacherA_UserId,
  userId: teacherA_UserId,
  fullName: 'Sir Sajid Ali',
  email: 'sajid.ali@dmc.edu.pk',
  role: ROLES.TEACHER,
  status: USER_STATUS.ACTIVE,
  schoolId: schoolA_Id,
  permissions: ['exams.view', 'exams.enter_marks'],
};

const authenticatedHmA = {
  _id: hmA_UserId,
  userId: hmA_UserId,
  fullName: 'Head Master Saeed Akhtar',
  email: 'saeed.akhtar@dmc.edu.pk',
  role: ROLES.HM,
  status: USER_STATUS.ACTIVE,
  schoolId: schoolA_Id,
  permissions: ['exams.view', 'exams.verify'],
};

const mockStudentProfileA = {
  _id: studentA_ProfileId,
  userId: {
    _id: studentA_UserId,
    fullName: 'Muhammad Bilal Khan',
    email: 'bilal.khan@student.dmc.edu.pk',
    phoneNumber: '03001234567',
    status: USER_STATUS.ACTIVE,
  },
  schoolId: {
    _id: schoolA_Id,
    name: 'Government Boys Secondary School Liaquatabad No 1',
    code: 'LTC001',
    address: 'Block 4, Liaquatabad, Karachi',
  },
  classId: {
    _id: classA_Id,
    name: 'Class VIII',
    numericGrade: 8,
    code: 'VIII',
  },
  sectionId: {
    _id: sectionA_Id,
    name: 'A',
    roomNumber: 'Room-12',
    capacity: 40,
  },
  grNumber: 1045,
  rollNumber: '24',
  admissionRegisterNumber: 'LTC001-2024-1045',
  globalStudentId: 'LTC001-1045',
  admissionType: 'NEW_ADMISSION',
  dateOfBirth: new Date('2011-04-15'),
  dateOfBirthInWords: 'Fifteenth April Two Thousand Eleven',
  gender: 'MALE',
  religion: 'ISLAM',
  placeOfBirth: 'Karachi',
  studentPhotoUrl: 'https://res.cloudinary.com/dmc/image/upload/v1/students/bilal.jpg',
  bFormNumber: '42101-1234567-1',
  fatherFullName: 'Tariq Mehmood Khan',
  guardianCellNumber: '03009876543',
  relationshipWithStudent: 'FATHER',
  admissionDate: new Date('2024-04-01'),
  lifecycleStatus: STUDENT_STATUS.ACTIVE,
};

const mockExamA = {
  _id: examA_Id,
  schoolId: schoolA_Id,
  academicYear: '2025-2026',
  title: 'Annual Board Examination 2026',
  term: 'ANNUAL',
  session: '2025-2026',
  examType: 'ANNUAL',
  startDate: new Date('2026-03-01'),
  endDate: new Date('2026-03-15'),
  publicationDate: new Date('2026-03-25'),
  isPublished: true,
};

const mockPublishedResultStudentA = {
  _id: new mongoose.Types.ObjectId().toString(),
  examId: mockExamA,
  schoolId: { _id: schoolA_Id, name: 'GBSS Liaquatabad No 1', code: 'LTC001' },
  studentId: studentA_UserId,
  classId: { _id: classA_Id, name: 'Class VIII', numericGrade: 8, code: 'VIII' },
  sectionId: { _id: sectionA_Id, name: 'A', roomNumber: 'Room-12' },
  subjectMarks: [
    {
      subjectId: { _id: new mongoose.Types.ObjectId().toString(), name: 'ISLAMIAT', code: 'ISL' },
      subjectName: 'ISLAMIAT',
      subComponents: { nazra: 18, written: 68 },
      obtainedMarks: 86,
      maxMarks: 100,
      isGradedOnly: false,
      letterGrade: '',
      isPassed: true,
    },
    {
      subjectId: { _id: new mongoose.Types.ObjectId().toString(), name: 'ENGLISH', code: 'ENG' },
      subjectName: 'ENGLISH',
      obtainedMarks: 78,
      maxMarks: 100,
      isGradedOnly: false,
      letterGrade: '',
      isPassed: true,
    },
    {
      subjectId: { _id: new mongoose.Types.ObjectId().toString(), name: 'MATHEMATICS', code: 'MTH' },
      subjectName: 'MATHEMATICS',
      obtainedMarks: 92,
      maxMarks: 100,
      isGradedOnly: false,
      letterGrade: '',
      isPassed: true,
    },
    {
      subjectId: { _id: new mongoose.Types.ObjectId().toString(), name: 'DRAWING', code: 'DRW' },
      subjectName: 'DRAWING',
      obtainedMarks: 0,
      maxMarks: 0,
      isGradedOnly: true,
      letterGrade: 'A',
      isPassed: true,
    },
  ],
  totalObtainedMarks: 580,
  totalMaxMarks: 700,
  percentage: 82.85,
  grade: 'A-1',
  position: 2,
  rank: 2,
  rankFormatted: '2nd',
  resultStatus: 'PASSED',
  remarks: 'Excellent academic performance across all disciplines.',
  status: 'PUBLISHED',
  createdAt: new Date('2026-03-24'),
  updatedAt: new Date('2026-03-25'),
};

const mockDraftResultStudentA = {
  ...mockPublishedResultStudentA,
  _id: new mongoose.Types.ObjectId().toString(),
  status: 'DRAFT',
};

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────
async function runAllTests() {
  console.log('\n================================================================');
  console.log('🏛️ STUDENT WORKSPACE TEST SUITE (PHASE 1 SECURITY & CONTRACTS)');
  console.log('   Education Department Liaquatabad Town Centre (DMC Karachi)');
  console.log('================================================================\n');

  // Preserve original methods for isolation
  const originalStudentProfileFindOne = StudentProfile.findOne;
  const originalStudentProfileFind = StudentProfile.find;
  const originalUserFindById = User.findById;
  const originalExamFindById = Exam.findById;
  const originalResultFind = Result.find;
  const originalResultFindOne = Result.findOne;
  const originalSchoolFindById = School.findById;
  const originalClassFindById = Class.findById;
  const originalSectionFindById = Section.findById;
  const originalAuditLogCreate = AuditLog.create;
  const originalTeachingAssignmentIsTeacherAssigned = TeachingAssignment.isTeacherAssigned;
  const originalAttendanceSummaryFind = AttendanceSummary.find;

  // Global safe stub for analytics queries
  AttendanceSummary.find = () => makeChainableQuery([]);

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // GROUP 1: STUDENT PROFILE SELF-ACCESS & BOLA DEFENSE
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- Group 1: Student Profile Self-Access & BOLA Defense ---');

    await runAsyncTest('1.1 Active student successfully fetches own profile with sanitized particulars', async () => {
      StudentProfile.findOne = () => makeChainableQuery(mockStudentProfileA);

      const mockRequest = {
        user: authenticatedStudentA,
        query: { studentId: studentB_UserId }, // Attempt to manipulate query param
      };
      const mockResponse = createMockResponse();

      await handleGetMyStudentProfile(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(mockResponse.body.data.profile.grNumber, 1045);
      assert.strictEqual(mockResponse.body.data.profile.studentFullName, 'Muhammad Bilal Khan');
      assert.strictEqual(mockResponse.body.data.profile.school.code, 'LTC001');
      assert.strictEqual(mockResponse.body.data.profile.class.numericGrade, 8);
      assert.strictEqual(mockResponse.body.data.profile.section.name, 'A');
      assert.strictEqual(mockResponse.body.data.profile.guardian.relationship, 'FATHER');
    });

    await runAsyncTest('1.2 Profile response strictly excludes passwordHash, tokens, and uninvented bloodGroup', async () => {
      StudentProfile.findOne = () => makeChainableQuery(mockStudentProfileA);

      const mockRequest = { user: authenticatedStudentA };
      const mockResponse = createMockResponse();

      await handleGetMyStudentProfile(mockRequest, mockResponse);

      const profileData = mockResponse.body.data.profile;
      assert.strictEqual(profileData.passwordHash, undefined, 'passwordHash must never be exposed');
      assert.strictEqual(profileData.refreshToken, undefined, 'refreshTokens must never be exposed');
      assert.strictEqual(profileData.bloodGroup, undefined, 'bloodGroup must not be invented');
    });

    await runAsyncTest('1.3 Non-student role attempting to access student profile endpoint rejected with 403', async () => {
      const mockRequest = { user: authenticatedTeacherA };
      const mockResponse = createMockResponse();

      await handleGetMyStudentProfile(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /Only registered students/i);
    });

    await runAsyncTest('1.4 Missing student profile returns 404 with guidance message', async () => {
      StudentProfile.findOne = () => makeChainableQuery(null);

      const mockRequest = { user: authenticatedStudentA };
      const mockResponse = createMockResponse();

      await handleGetMyStudentProfile(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 404);
      assert.match(mockResponse.body.message, /profile record not found/i);
    });

    await runAsyncTest('1.5 Inactive / suspended student profile rejected with 403 Forbidden', async () => {
      const inactiveProfile = { ...mockStudentProfileA, lifecycleStatus: 'SUSPENDED' };
      StudentProfile.findOne = () => makeChainableQuery(inactiveProfile);

      const mockRequest = { user: authenticatedStudentA };
      const mockResponse = createMockResponse();

      await handleGetMyStudentProfile(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /SUSPENDED/i);
    });

    // ═════════════════════════════════════════════════════════════════════════
    // GROUP 2: STUDENT EXAMINATION RESULTS SELF-ACCESS & PUBLICATION GATE
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- Group 2: Student Exam Results Self-Access & Publication Gate ---');

    await runAsyncTest('2.1 Student receives own PUBLISHED results with authentic academic metrics', async () => {
      Result.find = (filter) => {
        assert.strictEqual(filter.studentId, studentA_UserId, 'Filter must lock to request.user._id');
        assert.strictEqual(filter.status, 'PUBLISHED', 'Filter must strictly enforce PUBLISHED status');
        return makeChainableQuery([mockPublishedResultStudentA]);
      };

      const mockRequest = {
        user: authenticatedStudentA,
        query: {},
      };
      const mockResponse = createMockResponse();

      await handleGetMyExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.data.totalCount, 1);
      const studentResult = mockResponse.body.data.results[0];
      assert.strictEqual(studentResult.totalObtainedMarks, 580);
      assert.strictEqual(studentResult.totalMaxMarks, 700);
      assert.strictEqual(studentResult.grade, 'A-1');
      assert.strictEqual(studentResult.rankFormatted, '2nd');
      assert.strictEqual(studentResult.status, 'PUBLISHED');
      // Subcomponent split verification
      const islamiatSubject = studentResult.subjectMarks.find((s) => s.subjectName === 'ISLAMIAT');
      assert.strictEqual(islamiatSubject.subComponents.nazra, 18);
      assert.strictEqual(islamiatSubject.subComponents.written, 68);
      // Graded only Drawing verification
      const drawingSubject = studentResult.subjectMarks.find((s) => s.subjectName === 'DRAWING');
      assert.strictEqual(drawingSubject.isGradedOnly, true);
      assert.strictEqual(drawingSubject.letterGrade, 'A');
    });

    await runAsyncTest('2.2 Student receives zero unpublished results (DRAFT results hidden)', async () => {
      Result.find = (filter) => {
        // Even if database has DRAFT result, the query filter { status: 'PUBLISHED' } excludes it
        if (filter.status === 'PUBLISHED') {
          return makeChainableQuery([]);
        }
        return makeChainableQuery([mockDraftResultStudentA]);
      };

      const mockRequest = { user: authenticatedStudentA, query: {} };
      const mockResponse = createMockResponse();

      await handleGetMyExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.data.totalCount, 0);
      assert.deepStrictEqual(mockResponse.body.data.results, []);
    });

    await runAsyncTest('2.3 Manipulated ?studentId= or ?userId= query param completely ignored', async () => {
      let executedFilter = null;
      Result.find = (filter) => {
        executedFilter = filter;
        return makeChainableQuery([]);
      };

      const mockRequest = {
        user: authenticatedStudentA,
        query: { studentId: studentB_UserId, userId: studentB_UserId },
      };
      const mockResponse = createMockResponse();

      await handleGetMyExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(executedFilter.studentId, studentA_UserId, 'Must strictly derive studentId from request.user._id');
      assert.strictEqual(executedFilter.status, 'PUBLISHED');
    });

    await runAsyncTest('2.4 Non-student role attempting to access /my-results rejected with 403', async () => {
      const mockRequest = { user: authenticatedHmA, query: {} };
      const mockResponse = createMockResponse();

      await handleGetMyExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /Only registered students/i);
    });

    await runAsyncTest('2.5 Invalid examId format returns 400 Bad Request', async () => {
      const mockRequest = { user: authenticatedStudentA, query: { examId: 'invalid-id' } };
      const mockResponse = createMockResponse();

      await handleGetMyExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.match(mockResponse.body.message, /Invalid examId format/i);
    });

    // ═════════════════════════════════════════════════════════════════════════
    // GROUP 3: OFFICIAL MARKSHEET STREAMING & IDOR DEFENSE
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- Group 3: Official Marksheet Streaming & IDOR Defense ---');

    await runAsyncTest('3.1 Student can stream own published official marksheet PDF', async () => {
      Exam.findById = () => makeChainableQuery(mockExamA);
      Result.findOne = () => makeChainableQuery(mockPublishedResultStudentA);
      User.findById = () => makeChainableQuery(authenticatedStudentA);
      StudentProfile.findOne = () => makeChainableQuery(mockStudentProfileA);
      School.findById = () => makeChainableQuery({ _id: schoolA_Id, name: 'GBSS Liaquatabad No 1' });
      Class.findById = () => makeChainableQuery({ _id: classA_Id, name: 'Class VIII' });
      Section.findById = () => makeChainableQuery({ _id: sectionA_Id, name: 'A' });

      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id, studentId: studentA_UserId },
      };
      const mockResponse = createMockResponse();

      await handleDownloadStudentMarksheet(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.headers['content-type'], 'application/pdf');
      assert.match(mockResponse.headers['content-disposition'], /inline; filename=Marksheet_1045_Muhammad_Bilal_Khan\.pdf/i);
    });

    await runAsyncTest('3.2 Student attempting to download another student\'s marksheet rejected with 403 and logged', async () => {
      let loggedAuditPayload = null;
      AuditLog.create = (entry) => {
        loggedAuditPayload = entry;
        return Promise.resolve({ _id: 'audit_event_1' });
      };

      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id, studentId: studentB_UserId }, // IDOR attempt
        originalUrl: `/api/v1/exams/${examA_Id}/results/${studentB_UserId}/marksheet`,
        ip: '192.168.1.100',
        headers: { 'user-agent': 'AttackerBrowser/1.0' },
      };
      const mockResponse = createMockResponse();

      await handleDownloadStudentMarksheet(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /only download your own official marksheet/i);
      assert.ok(loggedAuditPayload, 'AuditLog must be recorded');
      assert.strictEqual(loggedAuditPayload.action, 'STUDENT_CROSS_USER_MARKSHEET_BLOCKED');
      assert.strictEqual(loggedAuditPayload.result, 'DENIED');
      assert.strictEqual(loggedAuditPayload.previousState.attemptedStudentId, studentB_UserId);
    });

    await runAsyncTest('3.3 Student attempting to download UNPUBLISHED marksheet (VERIFIED_BY_HM) rejected with 403', async () => {
      let loggedAuditPayload = null;
      AuditLog.create = (entry) => {
        loggedAuditPayload = entry;
        return Promise.resolve({ _id: 'audit_event_2' });
      };

      Exam.findById = () => makeChainableQuery(mockExamA);
      Result.findOne = () => makeChainableQuery({
        ...mockPublishedResultStudentA,
        status: 'VERIFIED_BY_HM', // verified by HM but not yet published
      });

      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id, studentId: studentA_UserId },
        originalUrl: `/api/v1/exams/${examA_Id}/results/${studentA_UserId}/marksheet`,
        ip: '192.168.1.100',
        headers: { 'user-agent': 'StudentBrowser/1.0' },
      };
      const mockResponse = createMockResponse();

      await handleDownloadStudentMarksheet(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /not available until examination results are formally published/i);
      assert.ok(loggedAuditPayload, 'AuditLog must be recorded');
      assert.strictEqual(loggedAuditPayload.action, 'STUDENT_UNPUBLISHED_MARKSHEET_BLOCKED');
    });

    await runAsyncTest('3.4 Student attempting to download marksheet for foreign school exam rejected with 403', async () => {
      Exam.findById = () => makeChainableQuery({
        _id: examB_Id,
        schoolId: schoolB_Id, // Belongs to School B
      });

      const mockRequest = {
        user: authenticatedStudentA, // Linked to School A
        params: { id: examB_Id, studentId: studentA_UserId },
      };
      const mockResponse = createMockResponse();

      await handleDownloadStudentMarksheet(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /another school/i);
    });

    await runAsyncTest('3.5 Missing exam result returns 404 Not Found', async () => {
      Exam.findById = () => makeChainableQuery(mockExamA);
      Result.findOne = () => makeChainableQuery(null);

      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id, studentId: studentA_UserId },
      };
      const mockResponse = createMockResponse();

      await handleDownloadStudentMarksheet(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 404);
      assert.match(mockResponse.body.message, /result not found/i);
    });

    await runAsyncTest('3.6 Authorized HM can download marksheet for students in their school without regression', async () => {
      Exam.findById = () => makeChainableQuery(mockExamA);
      Result.findOne = () => makeChainableQuery(mockPublishedResultStudentA);
      User.findById = () => makeChainableQuery(authenticatedStudentA);
      StudentProfile.findOne = () => makeChainableQuery(mockStudentProfileA);
      School.findById = () => makeChainableQuery({ _id: schoolA_Id, name: 'GBSS Liaquatabad No 1' });
      Class.findById = () => makeChainableQuery({ _id: classA_Id, name: 'Class VIII' });
      Section.findById = () => makeChainableQuery({ _id: sectionA_Id, name: 'A' });

      const mockRequest = {
        user: authenticatedHmA, // HM can download Student A's marksheet
        params: { id: examA_Id, studentId: studentA_UserId },
      };
      const mockResponse = createMockResponse();

      await handleDownloadStudentMarksheet(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.headers['content-type'], 'application/pdf');
    });

    // ═════════════════════════════════════════════════════════════════════════
    // GROUP 4: ATTENDANCE ANALYTICS IDOR DEFENSE
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- Group 4: Attendance Analytics IDOR Defense ---');

    await runAsyncTest('4.1 Student requesting own attendance analytics with no userId resolves correctly', async () => {
      StudentProfile.findOne = () => makeChainableQuery(mockStudentProfileA);

      const mockRequest = {
        user: authenticatedStudentA,
        params: {},
        query: {},
      };
      const mockResponse = createMockResponse();

      await handleGetStudentAttendanceAnalytics(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
    });

    await runAsyncTest('4.2 Student requesting attendance analytics with own userId resolves correctly', async () => {
      StudentProfile.findOne = () => makeChainableQuery(mockStudentProfileA);

      const mockRequest = {
        user: authenticatedStudentA,
        params: { userId: studentA_UserId },
        query: {},
      };
      const mockResponse = createMockResponse();

      await handleGetStudentAttendanceAnalytics(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
    });

    await runAsyncTest('4.3 Student passing another student\'s userId rejected with 403 and logged', async () => {
      let loggedAuditPayload = null;
      AuditLog.create = (entry) => {
        loggedAuditPayload = entry;
        return Promise.resolve({ _id: 'audit_event_3' });
      };

      const mockRequest = {
        user: authenticatedStudentA,
        params: {},
        query: { userId: studentB_UserId }, // IDOR attempt
        originalUrl: `/api/v1/attendance/analytics/student?userId=${studentB_UserId}`,
        ip: '192.168.1.100',
        headers: { 'user-agent': 'AttackerBrowser/1.0' },
      };
      const mockResponse = createMockResponse();

      await handleGetStudentAttendanceAnalytics(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /another student/i);
      assert.ok(loggedAuditPayload, 'AuditLog must be recorded');
      assert.strictEqual(loggedAuditPayload.action, 'STUDENT_ATTENDANCE_SPOOF_BLOCKED');
      assert.strictEqual(loggedAuditPayload.result, 'DENIED');
      assert.strictEqual(loggedAuditPayload.previousState.attemptedUserId, studentB_UserId);
    });

    // ═════════════════════════════════════════════════════════════════════════
    // GROUP 5: SECTION STUDENT ROSTER PRIVACY BOUNDARY
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- Group 5: Section Student Roster Privacy Boundary ---');

    await runAsyncTest('5.1 Student attempting to access section student roster rejected with 403 and logged', async () => {
      let loggedAuditPayload = null;
      AuditLog.create = (entry) => {
        loggedAuditPayload = entry;
        return Promise.resolve({ _id: 'audit_event_4' });
      };

      Section.findById = () => makeChainableQuery({
        _id: sectionA_Id,
        schoolId: schoolA_Id,
        name: 'A',
      });

      const mockRequest = {
        user: authenticatedStudentA,
        params: { sectionId: sectionA_Id },
        originalUrl: `/api/v1/students/section/${sectionA_Id}`,
        ip: '192.168.1.100',
        headers: { 'user-agent': 'StudentBrowser/1.0' },
      };
      const mockResponse = createMockResponse();

      await handleGetSectionStudents(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /Students are not authorized to view class section rosters/i);
      assert.ok(loggedAuditPayload, 'AuditLog must be recorded');
      assert.strictEqual(loggedAuditPayload.action, 'STUDENT_ROSTER_ACCESS_BLOCKED');
      assert.strictEqual(loggedAuditPayload.result, 'DENIED');
    });

    await runAsyncTest('5.2 Authorized Class Teacher can view section roster without regression', async () => {
      Section.findById = () => makeChainableQuery({
        _id: sectionA_Id,
        schoolId: schoolA_Id,
        name: 'A',
        classTeacherId: { _id: teacherA_UserId, fullName: 'Sir Sajid Ali' },
      });
      StudentProfile.find = () => makeChainableQuery([mockStudentProfileA]);

      const mockRequest = {
        user: authenticatedTeacherA,
        params: { sectionId: sectionA_Id },
      };
      const mockResponse = createMockResponse();

      await handleGetSectionStudents(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(mockResponse.body.data.totalCount, 1);
    });

    // ═════════════════════════════════════════════════════════════════════════
    // GROUP 6: COHORT RESULTS & TABULATION SHEET ISOLATION
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n--- Group 6: Cohort Results & Tabulation Sheet Isolation ---');

    await runAsyncTest('6.1 Student attempting to view cohort exam gazette rejected with 403 and logged', async () => {
      let loggedAuditPayload = null;
      AuditLog.create = (entry) => {
        loggedAuditPayload = entry;
        return Promise.resolve({ _id: 'audit_event_5' });
      };

      Exam.findById = () => makeChainableQuery(mockExamA);

      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id },
        query: {},
        originalUrl: `/api/v1/exams/${examA_Id}/results`,
        ip: '192.168.1.100',
        headers: { 'user-agent': 'StudentBrowser/1.0' },
      };
      const mockResponse = createMockResponse();

      await handleGetExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /cohort examination gazettes/i);
      assert.ok(loggedAuditPayload, 'AuditLog must be recorded');
      assert.strictEqual(loggedAuditPayload.action, 'COHORT_RESULTS_ACCESS_BLOCKED');
      assert.strictEqual(loggedAuditPayload.result, 'DENIED');
    });

    await runAsyncTest('6.2 Student attempting to download class tabulation PDF rejected with 403', async () => {
      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id },
        query: { classId: classA_Id },
      };
      const mockResponse = createMockResponse();

      await handleDownloadClassTabulationPdf(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /class tabulation sheets/i);
    });

    await runAsyncTest('6.3 Student attempting to view class tabulation grid data rejected with 403', async () => {
      const mockRequest = {
        user: authenticatedStudentA,
        params: { id: examA_Id },
        query: { classId: classA_Id },
      };
      const mockResponse = createMockResponse();

      await handleGetClassTabulationData(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 403);
      assert.match(mockResponse.body.message, /class tabulation data/i);
    });

    await runAsyncTest('6.4 Authorized HM can view cohort exam results without regression', async () => {
      Exam.findById = () => makeChainableQuery(mockExamA);
      Result.find = () => makeChainableQuery([mockPublishedResultStudentA]);

      const mockRequest = {
        user: authenticatedHmA,
        params: { id: examA_Id },
        query: {},
      };
      const mockResponse = createMockResponse();

      await handleGetExamResults(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(mockResponse.body.data.totalCount, 1);
    });

  } finally {
    // Restore all original functions to preserve runtime integrity
    StudentProfile.findOne = originalStudentProfileFindOne;
    StudentProfile.find = originalStudentProfileFind;
    User.findById = originalUserFindById;
    Exam.findById = originalExamFindById;
    Result.find = originalResultFind;
    Result.findOne = originalResultFindOne;
    School.findById = originalSchoolFindById;
    Class.findById = originalClassFindById;
    Section.findById = originalSectionFindById;
    AuditLog.create = originalAuditLogCreate;
    TeachingAssignment.isTeacherAssigned = originalTeachingAssignmentIsTeacherAssigned;
    AttendanceSummary.find = originalAttendanceSummaryFind;
  }

  console.log('\n======================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} STUDENT WORKSPACE TESTS PASSED!`);
  console.log('======================================================================\n');
}

runAllTests().catch((error) => {
  console.error('Test Suite Crashed:', error);
  process.exit(1);
});
