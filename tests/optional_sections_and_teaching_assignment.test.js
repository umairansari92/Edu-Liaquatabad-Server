/**
 * 🏛️ OPTIONAL SECTIONS & TEACHING ASSIGNMENTS TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies that in DMC Liaquatabad municipal schools:
 * 1. Sections are 100% OPTIONAL across frontend and backend.
 * 2. Head Masters can assign teachers to classes directly without specifying a section.
 * 3. TeachingAssignment model supports sectionId: null and partial unique conflict detection.
 * 4. Teacher summary correctly aggregates whole-class assignments.
 * 5. Student enrollment works with or without sectionId.
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  TEACHING_ASSIGNMENT_STATUS,
  STUDENT_STATUS,
  USER_STATUS,
} from '../config/constants.js';

import {
  handleAddTeachingAssignment,
  handleGetTeacherAssignments,
} from '../src/controllers/teachingAssignmentController.js';
import { handleGetTeacherSummary } from '../src/controllers/academicController.js';
import { handleEnrollStudent } from '../src/controllers/studentController.js';

import TeachingAssignment from '../src/models/TeachingAssignment.js';
import User from '../src/models/User.js';
import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import Subject from '../src/models/Subject.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import StudentProfile from '../src/models/StudentProfile.js';
import AuditLog from '../src/models/AuditLog.js';

let totalTests = 0;
let passedTests = 0;

async function runAsyncTest(testName, testFunction) {
  totalTests++;
  try {
    await testFunction();
    passedTests++;
    console.log(`  ✅ PASS [${passedTests}]: ${testName}`);
  } catch (testError) {
    console.error(`  ✗ ${testName}`);
    console.error(testError);
  }
}

function createMockResponse() {
  const mockResponse = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return mockResponse;
}

async function runAllTests() {
  console.log('\n===========================================================================');
  console.log('🏛️ RUNNING OPTIONAL SECTIONS & TEACHING ASSIGNMENT TEST SUITE');
  console.log('===========================================================================\n');

  const schoolId = new mongoose.Types.ObjectId();
  const hmUserId = new mongoose.Types.ObjectId();
  const teacherUserId = new mongoose.Types.ObjectId();
  const classId = new mongoose.Types.ObjectId();
  const sectionId = new mongoose.Types.ObjectId();
  const subjectId = new mongoose.Types.ObjectId();

  const mockActorHM = {
    _id: hmUserId,
    userId: hmUserId,
    role: ROLES.HM,
    schoolId,
    designation: 'Head Master',
    fullName: 'HM Test Master',
  };

  const mockTargetTeacher = {
    _id: teacherUserId,
    userId: teacherUserId,
    role: ROLES.TEACHER,
    schoolId,
    status: USER_STATUS.ACTIVE,
    fullName: 'Sir Umair Ahmed',
  };

  const mockClass = {
    _id: classId,
    schoolId,
    name: 'Class 6',
    numericGrade: 6,
  };

  const mockSection = {
    _id: sectionId,
    schoolId,
    classId,
    name: 'A',
  };

  const mockSubject = {
    _id: subjectId,
    schoolId,
    name: 'English',
    code: 'ENG',
  };

  // ── TEST 1: Allocate Teaching Duty WITHOUT Section ────────────────────────
  await runAsyncTest('HM allocates teaching assignment without sectionId (Whole Class default)', async () => {
    const originalFindById = User.findById;
    const originalProfileFindOne = TeacherProfile.findOne;
    const originalClassFindById = Class.findById;
    const originalSubjectFindById = Subject.findById;
    const originalAssignmentFindOne = TeachingAssignment.findOne;
    const originalAssignmentCreate = TeachingAssignment.create;
    const originalAuditLogCreate = AuditLog.create;

    let createdAssignmentData = null;

    try {
      User.findById = (id) => ({
        lean: () => Promise.resolve(mockTargetTeacher),
        then: (resolve) => resolve(mockTargetTeacher),
      });
      TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: true });
      Class.findById = () => ({ lean: () => Promise.resolve(mockClass) });
      Subject.findById = () => ({ lean: () => Promise.resolve(mockSubject) });
      TeachingAssignment.findOne = () => Promise.resolve(null);
      TeachingAssignment.create = (data) => {
        createdAssignmentData = data;
        return Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...data });
      };
      AuditLog.create = () => Promise.resolve({});

      const mockRequest = {
        user: mockActorHM,
        body: {
          teacherId: teacherUserId,
          schoolId,
          classId,
          // sectionId is intentionally omitted!
          subjectId,
          academicSession: '2025-2026',
        },
      };
      const mockResponse = createMockResponse();

      await handleAddTeachingAssignment(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 201);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(createdAssignmentData.sectionId, null, 'sectionId should default to null');
      assert.strictEqual(createdAssignmentData.classId, classId);
      assert.strictEqual(createdAssignmentData.subjectId, subjectId);
    } finally {
      User.findById = originalFindById;
      TeacherProfile.findOne = originalProfileFindOne;
      Class.findById = originalClassFindById;
      Subject.findById = originalSubjectFindById;
      TeachingAssignment.findOne = originalAssignmentFindOne;
      TeachingAssignment.create = originalAssignmentCreate;
      AuditLog.create = originalAuditLogCreate;
    }
  });

  // ── TEST 2: Allocate Teaching Duty WITH Section ───────────────────────────
  await runAsyncTest('HM allocates teaching assignment with explicit sectionId', async () => {
    const originalFindById = User.findById;
    const originalProfileFindOne = TeacherProfile.findOne;
    const originalClassFindById = Class.findById;
    const originalSectionFindById = Section.findById;
    const originalSubjectFindById = Subject.findById;
    const originalAssignmentFindOne = TeachingAssignment.findOne;
    const originalAssignmentCreate = TeachingAssignment.create;
    const originalAuditLogCreate = AuditLog.create;

    let createdAssignmentData = null;

    try {
      User.findById = (id) => ({
        lean: () => Promise.resolve(mockTargetTeacher),
        then: (resolve) => resolve(mockTargetTeacher),
      });
      TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: true });
      Class.findById = () => ({ lean: () => Promise.resolve(mockClass) });
      Section.findById = () => ({ lean: () => Promise.resolve(mockSection) });
      Subject.findById = () => ({ lean: () => Promise.resolve(mockSubject) });
      TeachingAssignment.findOne = () => Promise.resolve(null);
      TeachingAssignment.create = (data) => {
        createdAssignmentData = data;
        return Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...data });
      };
      AuditLog.create = () => Promise.resolve({});

      const mockRequest = {
        user: mockActorHM,
        body: {
          teacherId: teacherUserId,
          schoolId,
          classId,
          sectionId,
          subjectId,
          academicSession: '2025-2026',
        },
      };
      const mockResponse = createMockResponse();

      await handleAddTeachingAssignment(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 201);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(String(createdAssignmentData.sectionId), String(sectionId));
    } finally {
      User.findById = originalFindById;
      TeacherProfile.findOne = originalProfileFindOne;
      Class.findById = originalClassFindById;
      Section.findById = originalSectionFindById;
      Subject.findById = originalSubjectFindById;
      TeachingAssignment.findOne = originalAssignmentFindOne;
      TeachingAssignment.create = originalAssignmentCreate;
      AuditLog.create = originalAuditLogCreate;
    }
  });

  // ── TEST 3: Duplicate Whole-Class Assignment Detected (HTTP 409) ─────────
  await runAsyncTest('Blocks duplicate active whole-class assignment with HTTP 409', async () => {
    const originalFindById = User.findById;
    const originalProfileFindOne = TeacherProfile.findOne;
    const originalClassFindById = Class.findById;
    const originalSubjectFindById = Subject.findById;
    const originalAssignmentFindOne = TeachingAssignment.findOne;

    try {
      User.findById = (id) => ({
        lean: () => Promise.resolve(mockTargetTeacher),
        then: (resolve) => resolve(mockTargetTeacher),
      });
      TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: true });
      Class.findById = () => ({ lean: () => Promise.resolve(mockClass) });
      Subject.findById = () => ({ lean: () => Promise.resolve(mockSubject) });
      TeachingAssignment.findOne = () => Promise.resolve({
        _id: new mongoose.Types.ObjectId(),
        teacherId: teacherUserId,
        classId,
        subjectId,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      });

      const mockRequest = {
        user: mockActorHM,
        body: {
          teacherId: teacherUserId,
          schoolId,
          classId,
          subjectId,
          academicSession: '2025-2026',
        },
      };
      const mockResponse = createMockResponse();

      await handleAddTeachingAssignment(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 409);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /already exists/i);
    } finally {
      User.findById = originalFindById;
      TeacherProfile.findOne = originalProfileFindOne;
      Class.findById = originalClassFindById;
      Subject.findById = originalSubjectFindById;
      TeachingAssignment.findOne = originalAssignmentFindOne;
    }
  });

  // ── TEST 4: Non-Teaching Staff Blocked from Teaching Assignment ───────────
  await runAsyncTest('Non-teaching staff (peon/clerk) cannot receive teaching assignments', async () => {
    const originalFindById = User.findById;
    const originalProfileFindOne = TeacherProfile.findOne;

    try {
      User.findById = (id) => ({
        lean: () => Promise.resolve(mockTargetTeacher),
        then: (resolve) => resolve(mockTargetTeacher),
      });
      TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: false });

      const mockRequest = {
        user: mockActorHM,
        body: {
          teacherId: teacherUserId,
          schoolId,
          classId,
          subjectId,
          academicSession: '2025-2026',
        },
      };
      const mockResponse = createMockResponse();

      await handleAddTeachingAssignment(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.match(mockResponse.body.message, /Non-teaching staff/i);
    } finally {
      User.findById = originalFindById;
      TeacherProfile.findOne = originalProfileFindOne;
    }
  });

  // ── TEST 5: Teacher Summary aggregates Whole Class assignments ───────────
  await runAsyncTest('Teacher Summary aggregates whole-class assignments with sectionId: null', async () => {
    const originalSectionFind = Section.find;
    const originalAssignmentFind = TeachingAssignment.find;
    const originalStudentCount = StudentProfile.countDocuments;
    const originalAttendanceFindOne = mongoose.models.Attendance?.findOne;

    try {
      Section.find = () => ({
        populate: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      TeachingAssignment.find = () => ({
        populate: () => ({
          populate: () => ({
            populate: () => ({
              lean: () => Promise.resolve([
                {
                  _id: new mongoose.Types.ObjectId(),
                  teacherId: teacherUserId,
                  schoolId,
                  classId: mockClass,
                  sectionId: null, // No section!
                  subjectId: mockSubject,
                  status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
                },
              ]),
            }),
          }),
        }),
      });

      StudentProfile.countDocuments = () => Promise.resolve(45);
      if (mongoose.models.Attendance) {
        mongoose.models.Attendance.findOne = () => ({ lean: () => Promise.resolve(null) });
      }

      const mockRequest = {
        user: mockTargetTeacher,
      };
      const mockResponse = createMockResponse();

      await handleGetTeacherSummary(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
      const sections = mockResponse.body.data.sections;
      assert.strictEqual(sections.length, 1);
      assert.strictEqual(sections[0].name, 'Whole Class');
      assert.strictEqual(sections[0].assignedSubjects.length, 1);
      assert.strictEqual(sections[0].assignedSubjects[0].name, 'English');
    } finally {
      Section.find = originalSectionFind;
      TeachingAssignment.find = originalAssignmentFind;
      StudentProfile.countDocuments = originalStudentCount;
      if (mongoose.models.Attendance && originalAttendanceFindOne) {
        mongoose.models.Attendance.findOne = originalAttendanceFindOne;
      }
    }
  });

  // ── TEST 6: Student Enrollment without Section ─────────────────────────────
  await runAsyncTest('Enroll student succeeds when sectionId is omitted', async () => {
    const originalClassFindById = Class.findById;
    const originalSectionFindOne = Section.findOne;
    const originalSchoolFindOne = School.findOne;
    const originalUserCreate = User.create;
    const originalStudentProfileCreate = StudentProfile.create;
    const originalAuditLogCreate = AuditLog.create;

    let createdStudentProfileData = null;

    try {
      Class.findById = () => ({ lean: () => Promise.resolve(mockClass) });
      Section.findOne = () => ({ lean: () => Promise.resolve(null) });
      School.findOne = () => ({
        select: () => ({
          lean: () => Promise.resolve({ schoolCode: 'TEST' }),
        }),
      });
      School.findByIdAndUpdate = () => Promise.resolve({ lastGrNumber: 101 });
      User.findOne = () => Promise.resolve(null);
      User.create = (data) => Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...data });
      StudentProfile.create = (data) => {
        createdStudentProfileData = data;
        return Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...data });
      };
      AuditLog.create = () => Promise.resolve({});

      const mockRequest = {
        user: mockActorHM,
        body: {
          admissionType: 'NEW_ADMISSION',
          fullName: 'Taha Ahmed',
          guardianName: 'Ahmed Khan',
          guardianContact: '03001234567',
          classId: classId.toString(),
          // sectionId is omitted!
          mediumOfInstruction: 'URDU',
        },
      };
      const mockResponse = createMockResponse();

      await handleEnrollStudent(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 201);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(createdStudentProfileData.sectionId, undefined, 'sectionId should be undefined when no section provided');
    } finally {
      Class.findById = originalClassFindById;
      Section.findOne = originalSectionFindOne;
      User.create = originalUserCreate;
      StudentProfile.create = originalStudentProfileCreate;
      AuditLog.create = originalAuditLogCreate;
    }
  });

  // ── TEST 7: isTeacherAssigned handles Whole-Class assignments ──────────────
  await runAsyncTest('TeachingAssignment.isTeacherAssigned recognizes whole-class assignments', async () => {
    const originalFindOne = TeachingAssignment.findOne;

    try {
      TeachingAssignment.findOne = (query) => {
        // Query has status: ACTIVE and teacherId
        assert.strictEqual(query.teacherId, teacherUserId);
        assert.strictEqual(query.status, TEACHING_ASSIGNMENT_STATUS.ACTIVE);
        return Promise.resolve({
          _id: new mongoose.Types.ObjectId(),
          teacherId: teacherUserId,
          sectionId: null,
          status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
        });
      };

      const result = await TeachingAssignment.isTeacherAssigned({
        teacherId: teacherUserId,
        schoolId,
        sectionId,
        subjectId,
      });

      assert.strictEqual(result, true);
    } finally {
      TeachingAssignment.findOne = originalFindOne;
    }
  });

  console.log('\n===========================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED!`);
  console.log('===========================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test execution fatal error:', err);
  process.exit(1);
});
