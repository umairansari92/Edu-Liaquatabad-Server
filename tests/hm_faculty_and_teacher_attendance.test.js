/**
 * 🛡️ HEAD MASTER (HM) FACULTY & TEACHER ATTENDANCE TEST SUITE (STEP 2)
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all HM Step 2 Invariants:
 *  1. Scoped Faculty Roster (GET /api/v1/staff/school)
 *  2. Anti-BOLA / IDOR Cross-School Faculty Isolation (HM School A -> School B query returns 403)
 *  3. Sensitive PII Masking (CNIC masked using authoritative maskCnic helper)
 *  4. Authoritative Daily Teacher Attendance Roster (GET /api/v1/attendance/teachers/daily)
 *  5. Daily Teacher Attendance Submission & Upsert (POST /api/v1/attendance/teachers/daily)
 *  6. Single Authoritative Writer & Unique Document Guarantee ({ schoolId, TEACHER, date, sectionId: null })
 *  7. Cross-School Teacher ID Injection Rejection (403 Forbidden)
 *  8. Non-Teacher User ID Rejection (403 Integrity Violation)
 *  9. Future Date Attendance Rejection (400 Bad Request)
 * 10. Duplicate Teacher Record in Submission Rejection (400 Bad Request)
 * 11. Teaching Assignment Allocation via Faculty Selection (POST /api/v1/assignments)
 * 12. Duplicate Active Teaching Assignment Prevention (409 Conflict)
 * 13. Non-Teaching Staff Assignment Rejection (400 Bad Request)
 * 14. Teaching Assignment Termination with Preserved History (PATCH /api/v1/assignments/:id/end)
 */

import assert from 'node:assert/strict';
import {
  ROLES,
  SCOPES,
  USER_STATUS,
  TEACHER_STATUS,
  ATTENDANCE_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from '../config/constants.js';

// Production controllers
import { handleGetSchoolFaculty } from '../src/controllers/staffProfileController.js';
import {
  handleGetTeacherDailyAttendance,
  handleSaveTeacherDailyAttendance,
} from '../src/controllers/attendanceController.js';
import {
  handleAddTeachingAssignment,
  handleEndTeachingAssignment,
} from '../src/controllers/teachingAssignmentController.js';

// Domain models
import User from '../src/models/User.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import Attendance from '../src/models/Attendance.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import Subject from '../src/models/Subject.js';
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

console.log('======================================================================');
console.log('🏛️ EXECUTING HM FACULTY & TEACHER ATTENDANCE SUITE (STEP 2)');
console.log('======================================================================\n');

const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';
const classA_Id = '507f1f77bcf86cd799439011';
const sectionA_Id = '507f1f77bcf86cd799439021';
const subjectA_Id = '507f1f77bcf86cd799439031';

const hmA_User = {
  _id: '507f1f77bcf86cd799439041',
  role: ROLES.HM,
  schoolId: { _id: schoolA_Id },
  fullName: 'Head Master Liaquatabad Primary',
  designation: 'Head Master',
};

const teacherA_Id = '507f1f77bcf86cd799439051';
const teacherB_Id = '507f1f77bcf86cd799439052'; // Belongs to School B
const peonA_Id = '507f1f77bcf86cd799439053'; // Support staff

const mockTeachersDb = [
  {
    _id: teacherA_Id,
    fullName: 'Mohammad Tariq',
    email: 'tariq.teacher@dmcliaquatabad.edu.pk',
    phoneNumber: '03001234567',
    designation: 'Senior Teacher',
    role: ROLES.TEACHER,
    schoolId: schoolA_Id,
    status: USER_STATUS.ACTIVE,
    createdAt: new Date('2022-01-15'),
  },
  {
    _id: teacherB_Id,
    fullName: 'Saeed Anwar',
    email: 'saeed.teacher@dmcliaquatabad.edu.pk',
    phoneNumber: '03007654321',
    designation: 'Junior Teacher',
    role: ROLES.TEACHER,
    schoolId: schoolB_Id,
    status: USER_STATUS.ACTIVE,
    createdAt: new Date('2023-03-10'),
  },
  {
    _id: peonA_Id,
    fullName: 'Abdul Ghaffar',
    email: 'ghaffar.peon@dmcliaquatabad.edu.pk',
    phoneNumber: '03009998888',
    designation: 'Peon',
    role: ROLES.PEON,
    schoolId: schoolA_Id,
    status: USER_STATUS.ACTIVE,
    createdAt: new Date('2021-05-20'),
  },
];

const mockTeacherProfilesDb = [
  {
    userId: teacherA_Id,
    currentSchoolId: schoolA_Id,
    employeeId: 'EMP-2022-0045',
    bpsScale: 'BPS-16',
    qualification: 'M.Sc Mathematics, B.Ed',
    cnic: '42101-1234567-1',
    isTeachingStaff: true,
    specializationSubjects: ['Mathematics', 'General Science'],
  },
  {
    userId: teacherB_Id,
    currentSchoolId: schoolB_Id,
    employeeId: 'EMP-2023-0102',
    bpsScale: 'BPS-14',
    qualification: 'B.A, B.Ed',
    cnic: '42101-7654321-9',
    isTeachingStaff: true,
    specializationSubjects: ['Urdu', 'Islamiat'],
  },
  {
    userId: peonA_Id,
    currentSchoolId: schoolA_Id,
    employeeId: 'SUP-2021-0008',
    bpsScale: 'BPS-02',
    qualification: 'Matric',
    cnic: '42101-9998887-3',
    isTeachingStaff: false,
    specializationSubjects: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: HM retrieves school faculty roster (scoped to HM's school)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 01: HM retrieves school faculty roster scoped to own school', async () => {
  const origCount = User.countDocuments;
  const origFind = User.find;
  const origProfileFind = TeacherProfile.find;
  const origAssignFind = TeachingAssignment.find;

  User.countDocuments = (filter) => {
    assert.strictEqual(String(filter.schoolId), schoolA_Id);
    assert.strictEqual(filter.role, ROLES.TEACHER);
    return Promise.resolve(1);
  };

  User.find = (filter) => {
    assert.strictEqual(String(filter.schoolId), schoolA_Id);
    assert.strictEqual(filter.role, ROLES.TEACHER);
    return {
      select: () => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              lean: () => Promise.resolve([mockTeachersDb[0]]),
            }),
          }),
        }),
      }),
    };
  };

  TeacherProfile.find = () => ({
    lean: () => Promise.resolve([mockTeacherProfilesDb[0]]),
  });

  TeachingAssignment.find = () => ({
    populate: () => ({
      populate: () => ({
        populate: () => ({
          lean: () => Promise.resolve([]),
        }),
      }),
    }),
  });

  const req = {
    user: hmA_User,
    query: {},
  };
  const res = createMockRes();

  await handleGetSchoolFaculty(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.faculty.length, 1);
  assert.strictEqual(res.body.data.faculty[0].fullName, 'Mohammad Tariq');
  assert.strictEqual(res.body.data.faculty[0].employeeId, 'EMP-2022-0045');

  User.countDocuments = origCount;
  User.find = origFind;
  TeacherProfile.find = origProfileFind;
  TeachingAssignment.find = origAssignFind;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: BOLA / Anti-Cross-School Isolation: HM cannot query School B
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 02: HM querying another school faculty is blocked with 403 (BOLA tripwire)', async () => {
  const req = {
    user: hmA_User,
    query: { schoolId: schoolB_Id }, // Malicious attempt to inspect School B
  };
  const res = createMockRes();

  await handleGetSchoolFaculty(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.message, /Access denied/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Sensitive PII Masking: CNIC masked using authoritative maskCnic
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 03: CNIC is masked using authoritative maskCnic utility', async () => {
  const origCount = User.countDocuments;
  const origFind = User.find;
  const origProfileFind = TeacherProfile.find;
  const origAssignFind = TeachingAssignment.find;

  User.countDocuments = () => Promise.resolve(1);
  User.find = () => ({
    select: () => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            lean: () => Promise.resolve([mockTeachersDb[0]]),
          }),
        }),
      }),
    }),
  });
  TeacherProfile.find = () => ({
    lean: () => Promise.resolve([mockTeacherProfilesDb[0]]),
  });
  TeachingAssignment.find = () => ({
    populate: () => ({
      populate: () => ({
        populate: () => ({
          lean: () => Promise.resolve([]),
        }),
      }),
    }),
  });

  const req = { user: hmA_User, query: {} };
  const res = createMockRes();

  await handleGetSchoolFaculty(req, res);

  assert.strictEqual(res.statusCode, 200);
  // Authoritative mask format: 42101-*******-1
  assert.strictEqual(res.body.data.faculty[0].cnicMasked, '42101-*******-1');

  User.countDocuments = origCount;
  User.find = origFind;
  TeacherProfile.find = origProfileFind;
  TeachingAssignment.find = origAssignFind;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: HM retrieves authoritative daily teacher attendance roster
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 04: HM retrieves daily teacher attendance roster for today', async () => {
  const origUserFind = User.find;
  const origProfileFind = TeacherProfile.find;
  const origAttendanceFind = Attendance.findOne;

  User.find = () => ({
    select: () => ({
      sort: () => ({
        lean: () => Promise.resolve([mockTeachersDb[0]]),
      }),
    }),
  });

  TeacherProfile.find = () => ({
    lean: () => Promise.resolve([mockTeacherProfilesDb[0]]),
  });

  Attendance.findOne = () => ({
    lean: () => Promise.resolve(null), // Unsubmitted for today
  });

  const req = {
    user: hmA_User,
    query: { date: '2026-09-20' },
  };
  const res = createMockRes();

  await handleGetTeacherDailyAttendance(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.alreadySubmitted, false);
  assert.strictEqual(res.body.data.roster.length, 1);
  assert.strictEqual(res.body.data.roster[0].status, ATTENDANCE_STATUS.PRESENT);
  assert.strictEqual(res.body.data.summary.totalFaculty, 1);
  assert.strictEqual(res.body.data.summary.presentCount, 1);

  User.find = origUserFind;
  TeacherProfile.find = origProfileFind;
  Attendance.findOne = origAttendanceFind;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: HM records daily teacher attendance successfully
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 05: HM submits daily teacher attendance and creates Attendance document', async () => {
  const origUserFind = User.find;
  const origAttendanceUpsert = Attendance.findOneAndUpdate;
  const origAuditCreate = AuditLog.create;

  User.find = () => ({
    select: () => ({
      lean: () => Promise.resolve([mockTeachersDb[0]]),
    }),
  });

  let upsertedDoc = null;
  Attendance.findOneAndUpdate = (query, update) => {
    assert.strictEqual(String(query.schoolId), schoolA_Id);
    assert.strictEqual(query.attendanceType, 'TEACHER');
    assert.strictEqual(query.sectionId, null);
    upsertedDoc = {
      _id: '507f1f77bcf86cd799439099',
      ...update.$set,
    };
    return Promise.resolve(upsertedDoc);
  };

  let auditEntry = null;
  AuditLog.create = (log) => {
    auditEntry = log;
    return Promise.resolve(log);
  };

  const req = {
    user: hmA_User,
    body: {
      date: '2026-09-20',
      records: [
        {
          userId: teacherA_Id,
          status: ATTENDANCE_STATUS.PRESENT,
          remarks: 'Present on morning assembly duty',
        },
      ],
    },
  };
  const res = createMockRes();

  await handleSaveTeacherDailyAttendance(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(upsertedDoc.attendanceType, 'TEACHER');
  assert.strictEqual(upsertedDoc.verificationStatus, 'VERIFIED');
  assert.strictEqual(auditEntry.action, 'TEACHER_ATTENDANCE_RECORDED');
  assert.strictEqual(String(auditEntry.schoolId), schoolA_Id);

  User.find = origUserFind;
  Attendance.findOneAndUpdate = origAttendanceUpsert;
  AuditLog.create = origAuditCreate;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Single Authoritative Writer: Key is { schoolId, TEACHER, date, sectionId: null }
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 06: Unique key enforcement guarantees single daily document per school', async () => {
  const origUserFind = User.find;
  const origAttendanceUpsert = Attendance.findOneAndUpdate;
  const origAuditCreate = AuditLog.create;

  User.find = () => ({
    select: () => ({
      lean: () => Promise.resolve([mockTeachersDb[0]]),
    }),
  });

  let capturedQuery = null;
  Attendance.findOneAndUpdate = (query) => {
    capturedQuery = query;
    return Promise.resolve({ _id: 'doc123' });
  };
  AuditLog.create = () => Promise.resolve({});

  const req = {
    user: hmA_User,
    body: {
      date: '2026-09-20',
      records: [{ userId: teacherA_Id, status: ATTENDANCE_STATUS.PRESENT }],
    },
  };
  const res = createMockRes();

  await handleSaveTeacherDailyAttendance(req, res);

  assert.strictEqual(capturedQuery.attendanceType, 'TEACHER');
  assert.strictEqual(capturedQuery.sectionId, null);
  assert.strictEqual(String(capturedQuery.schoolId), schoolA_Id);

  User.find = origUserFind;
  Attendance.findOneAndUpdate = origAttendanceUpsert;
  AuditLog.create = origAuditCreate;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Cross-School Teacher Injection Rejection (403)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 07: Submitting attendance for a teacher belonging to another school is rejected with 403', async () => {
  const origUserFind = User.find;

  // Returning only authorized teachers of School A (does NOT include teacherB_Id)
  User.find = () => ({
    select: () => ({
      lean: () => Promise.resolve([mockTeachersDb[0]]),
    }),
  });

  const req = {
    user: hmA_User,
    body: {
      date: '2026-09-20',
      records: [
        { userId: teacherA_Id, status: ATTENDANCE_STATUS.PRESENT },
        { userId: teacherB_Id, status: ATTENDANCE_STATUS.PRESENT }, // Foreign school teacher
      ],
    },
  };
  const res = createMockRes();

  await handleSaveTeacherDailyAttendance(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.message, /Integrity violation/);

  User.find = origUserFind;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Non-Teacher User ID Rejection (403)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 08: Submitting non-teacher user ID in teacher attendance is rejected', async () => {
  const origUserFind = User.find;

  // DB search queries role: ROLES.TEACHER so peon is omitted
  User.find = (filter) => {
    assert.strictEqual(filter.role, ROLES.TEACHER);
    return {
      select: () => ({
        lean: () => Promise.resolve([]),
      }),
    };
  };

  const req = {
    user: hmA_User,
    body: {
      date: '2026-09-20',
      records: [{ userId: peonA_Id, status: ATTENDANCE_STATUS.PRESENT }],
    },
  };
  const res = createMockRes();

  await handleSaveTeacherDailyAttendance(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.success, false);

  User.find = origUserFind;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Future Date Attendance Rejection (400)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 09: Attendance cannot be submitted for a future date (400 Bad Request)', async () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 10);

  const req = {
    user: hmA_User,
    body: {
      date: futureDate.toISOString().split('T')[0],
      records: [{ userId: teacherA_Id, status: ATTENDANCE_STATUS.PRESENT }],
    },
  };
  const res = createMockRes();

  await handleSaveTeacherDailyAttendance(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.message, /future date/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Duplicate Teacher Record Rejection (400)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 10: Duplicate teacher entry in records payload is rejected with 400', async () => {
  const req = {
    user: hmA_User,
    body: {
      date: '2026-09-20',
      records: [
        { userId: teacherA_Id, status: ATTENDANCE_STATUS.PRESENT },
        { userId: teacherA_Id, status: ATTENDANCE_STATUS.ABSENT }, // Duplicate
      ],
    },
  };
  const res = createMockRes();

  await handleSaveTeacherDailyAttendance(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.message, /Duplicate teacher entry/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: Teaching assignment creation using teacher select succeeds
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 11: HM assigns teaching duty using selected teacher ID', async () => {
  const origUserFindById = User.findById;
  const origProfileFindOne = TeacherProfile.findOne;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origSubjectFindById = Subject.findById;
  const origAssignmentFindOne = TeachingAssignment.findOne;
  const origAssignmentCreate = TeachingAssignment.create;
  const origAuditCreate = AuditLog.create;

  User.findById = () => Promise.resolve({ _id: teacherA_Id, fullName: 'Mohammad Tariq', schoolId: schoolA_Id });
  TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: true });
  Class.findById = () => ({ lean: () => Promise.resolve({ _id: classA_Id, schoolId: schoolA_Id }) });
  Section.findById = () => ({ lean: () => Promise.resolve({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id }) });
  Subject.findById = () => ({ lean: () => Promise.resolve({ _id: subjectA_Id, schoolId: schoolA_Id }) });
  TeachingAssignment.findOne = () => Promise.resolve(null); // No active conflict

  let createdAssignment = null;
  TeachingAssignment.create = (doc) => {
    createdAssignment = { _id: '507f1f77bcf86cd799439088', ...doc };
    return Promise.resolve(createdAssignment);
  };
  AuditLog.create = () => Promise.resolve({});

  const req = {
    user: hmA_User,
    body: {
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectA_Id,
      academicSession: '2025-2026',
    },
  };
  const res = createMockRes();

  await handleAddTeachingAssignment(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(String(createdAssignment.teacherId), teacherA_Id);
  assert.strictEqual(createdAssignment.status, TEACHING_ASSIGNMENT_STATUS.ACTIVE);

  User.findById = origUserFindById;
  TeacherProfile.findOne = origProfileFindOne;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Subject.findById = origSubjectFindById;
  TeachingAssignment.findOne = origAssignmentFindOne;
  TeachingAssignment.create = origAssignmentCreate;
  AuditLog.create = origAuditCreate;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: Duplicate Active Teaching Assignment Prevention (409 Conflict)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 12: Assigning duplicate active duty returns 409 Conflict', async () => {
  const origUserFindById = User.findById;
  const origProfileFindOne = TeacherProfile.findOne;
  const origClassFindById = Class.findById;
  const origSectionFindById = Section.findById;
  const origSubjectFindById = Subject.findById;
  const origAssignmentFindOne = TeachingAssignment.findOne;

  User.findById = () => Promise.resolve({ _id: teacherA_Id, fullName: 'Mohammad Tariq', schoolId: schoolA_Id });
  TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: true });
  Class.findById = () => ({ lean: () => Promise.resolve({ _id: classA_Id, schoolId: schoolA_Id }) });
  Section.findById = () => ({ lean: () => Promise.resolve({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id }) });
  Subject.findById = () => ({ lean: () => Promise.resolve({ _id: subjectA_Id, schoolId: schoolA_Id }) });
  TeachingAssignment.findOne = () => Promise.resolve({ _id: 'conflict_123', status: TEACHING_ASSIGNMENT_STATUS.ACTIVE });

  const req = {
    user: hmA_User,
    body: {
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectA_Id,
      academicSession: '2025-2026',
    },
  };
  const res = createMockRes();

  await handleAddTeachingAssignment(req, res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.message, /active teaching assignment already exists/i);

  User.findById = origUserFindById;
  TeacherProfile.findOne = origProfileFindOne;
  Class.findById = origClassFindById;
  Section.findById = origSectionFindById;
  Subject.findById = origSubjectFindById;
  TeachingAssignment.findOne = origAssignmentFindOne;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13: Non-Teaching Staff Assignment Rejection (400 Bad Request)
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 13: Non-teaching staff (isTeachingStaff: false) cannot be assigned teaching duties', async () => {
  const origUserFindById = User.findById;
  const origProfileFindOne = TeacherProfile.findOne;

  User.findById = () => Promise.resolve({ _id: peonA_Id, fullName: 'Abdul Ghaffar', schoolId: schoolA_Id });
  TeacherProfile.findOne = () => Promise.resolve({ isTeachingStaff: false });

  const req = {
    user: hmA_User,
    body: {
      teacherId: peonA_Id,
      schoolId: schoolA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectA_Id,
      academicSession: '2025-2026',
    },
  };
  const res = createMockRes();

  await handleAddTeachingAssignment(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.message, /Non-teaching staff/i);

  User.findById = origUserFindById;
  TeacherProfile.findOne = origProfileFindOne;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 14: Ending Teaching Assignment Preserves History
// ─────────────────────────────────────────────────────────────────────────────
await runAsyncTest('Scenario 14: Ending teaching duty sets status to COMPLETED and records effectiveTo', async () => {
  const origAssignmentFindById = TeachingAssignment.findById;
  const origAuditCreate = AuditLog.create;

  const mockAssignment = {
    _id: '507f1f77bcf86cd799439088',
    schoolId: schoolA_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    remarks: 'Initial assignment',
    effectiveTo: null,
    save: function () {
      return Promise.resolve(this);
    },
  };

  TeachingAssignment.findById = () => Promise.resolve(mockAssignment);
  AuditLog.create = () => Promise.resolve({});

  const req = {
    user: hmA_User,
    params: { id: '507f1f77bcf86cd799439088' },
    body: { reason: 'Teacher transferred to secondary wing' },
  };
  const res = createMockRes();

  await handleEndTeachingAssignment(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(mockAssignment.status, TEACHING_ASSIGNMENT_STATUS.COMPLETED);
  assert.ok(mockAssignment.effectiveTo instanceof Date);
  assert.match(mockAssignment.remarks, /Ended: Teacher transferred/);

  TeachingAssignment.findById = origAssignmentFindById;
  AuditLog.create = origAuditCreate;
});

console.log('\n======================================================================');
console.log(`🎉 COMPLETED: ${passedTests}/${totalTests} HM STEP 2 ASSERTIONS PASSED (100%)`);
console.log('======================================================================\n');
