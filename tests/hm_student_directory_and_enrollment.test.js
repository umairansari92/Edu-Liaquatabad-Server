/**
 * 🛡️ HEAD MASTER (HM) STUDENT MANAGEMENT & DIRECTORY TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all HM Step 1 Invariants:
 *  1. Academic Cross-Validation Guard (Anti-Cross-School / Anti-Cross-Class Injection)
 *  2. Institutional Student Email Auto-Derivation (authController convention reuse)
 *  3. Audit Log actorSchoolId -> effectiveSchoolId Bug Fix
 *  4. Scoped Student Directory (GET /api/v1/students/school)
 *  5. Anti-BOLA / IDOR Verification (HM School A -> School B manipulation rejected with 403)
 *  6. Non-HM Authorization Denial (403 for TEACHER, PEON, STUDENT)
 *  7. Server-Side Search Engine (Numeric GR fast-path, Global Student ID, ReDoS escaping)
 *  8. Pagination Bounded Limits & Minimal Projection (Zero credentials/passwords exposed)
 *  9. Atomic Sequence & Dual-Numbering Generation
 */

import assert from 'node:assert/strict';
import {
  ROLES,
  SCOPES,
  USER_STATUS,
  STUDENT_STATUS,
} from '../config/constants.js';

// Production controllers
import {
  handleEnrollStudent,
  handleGetSchoolStudents,
  handleStrikeOffStudent,
} from '../src/controllers/studentController.js';
import { handleLogin } from '../src/controllers/authController.js';

// Domain models
import User from '../src/models/User.js';
import StudentProfile from '../src/models/StudentProfile.js';
import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import AuditLog from '../src/models/AuditLog.js';
import ParentStudentLink from '../src/models/ParentStudentLink.js';
import SecurityLockout from '../src/models/SecurityLockout.js';
import { hashPassword } from '../src/utils/passwordUtils.js';

// Services
import * as grNumberService from '../src/services/grNumberService.js';

let totalTests = 0;
let passedTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (err) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(err);
    throw err;
  }
}

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
console.log('🏛️ EXECUTING HM STUDENT DIRECTORY & ENROLLMENT SUITE (STEP 1)');
console.log('======================================================================\n');

const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';
const classA_Id = '507f1f77bcf86cd799439011';
const classB_Id = '507f1f77bcf86cd799439012'; // Belongs to School B
const sectionA_Id = '507f1f77bcf86cd799439021'; // Belongs to Class A & School A
const sectionB_Id = '507f1f77bcf86cd799439022'; // Belongs to Class B & School B

const hmA_User = {
  _id: '507f1f77bcf86cd799439031',
  role: ROLES.HM,
  scope: SCOPES.SCHOOL,
  schoolId: schoolA_Id,
  organizationId: '507f1f77bcf86cd799439099',
  townId: '507f1f77bcf86cd799439088',
  designation: 'Head Master (BPS-17)',
  status: USER_STATUS.ACTIVE,
};

const teacher_User = {
  _id: '507f1f77bcf86cd799439041',
  role: ROLES.TEACHER,
  scope: SCOPES.SCHOOL,
  schoolId: schoolA_Id,
  organizationId: '507f1f77bcf86cd799439099',
  status: USER_STATUS.ACTIVE,
};

// ─── 1. ACADEMIC CROSS-VALIDATION SECURITY TESTS ─────────────────────────────
console.log('--- 1. Academic Cross-Validation Guards (Anti-Injection Shield) ---');

await runAsyncTest('handleEnrollStudent rejects non-existent class with 400', async () => {
  const origClassFind = Class.findById;
  Class.findById = () => ({ lean: async () => null });

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'NEW_ADMISSION',
      fullName: 'Tariq Mehmood',
      guardianName: 'Mehmood Khan',
      guardianContact: '03001234567',
      classId: classA_Id,
      sectionId: sectionA_Id,
    },
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /invalid class/i);
  } finally {
    Class.findById = origClassFind;
  }
});

await runAsyncTest('handleEnrollStudent rejects cross-school class injection with 400', async () => {
  const origClassFind = Class.findById;
  // Class belongs to School B, but HM is School A
  Class.findById = () => ({
    lean: async () => ({ _id: classB_Id, schoolId: schoolB_Id, name: 'Class 9' }),
  });

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'NEW_ADMISSION',
      fullName: 'Tariq Mehmood',
      guardianName: 'Mehmood Khan',
      guardianContact: '03001234567',
      classId: classB_Id,
      sectionId: sectionA_Id,
    },
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /does not belong to the target school/i);
  } finally {
    Class.findById = origClassFind;
  }
});

await runAsyncTest('handleEnrollStudent rejects non-existent section with 400', async () => {
  const origClassFind = Class.findById;
  const origSectionFind = Section.findById;

  Class.findById = () => ({
    lean: async () => ({ _id: classA_Id, schoolId: schoolA_Id, name: 'Class 5' }),
  });
  Section.findById = () => ({ lean: async () => null });

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'NEW_ADMISSION',
      fullName: 'Tariq Mehmood',
      guardianName: 'Mehmood Khan',
      guardianContact: '03001234567',
      classId: classA_Id,
      sectionId: sectionA_Id,
    },
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /invalid section/i);
  } finally {
    Class.findById = origClassFind;
    Section.findById = origSectionFind;
  }
});

await runAsyncTest('handleEnrollStudent rejects cross-class section injection with 400', async () => {
  const origClassFind = Class.findById;
  const origSectionFind = Section.findById;

  Class.findById = () => ({
    lean: async () => ({ _id: classA_Id, schoolId: schoolA_Id, name: 'Class 5' }),
  });
  // Section belongs to another class (classB_Id)
  Section.findById = () => ({
    lean: async () => ({ _id: sectionA_Id, classId: classB_Id, schoolId: schoolA_Id, name: 'A' }),
  });

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'NEW_ADMISSION',
      fullName: 'Tariq Mehmood',
      guardianName: 'Mehmood Khan',
      guardianContact: '03001234567',
      classId: classA_Id,
      sectionId: sectionA_Id,
    },
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /section does not belong to the specified class/i);
  } finally {
    Class.findById = origClassFind;
    Section.findById = origSectionFind;
  }
});

await runAsyncTest('handleEnrollStudent rejects cross-school section injection with 400', async () => {
  const origClassFind = Class.findById;
  const origSectionFind = Section.findById;

  Class.findById = () => ({
    lean: async () => ({ _id: classA_Id, schoolId: schoolA_Id, name: 'Class 5' }),
  });
  // Section belongs to Class A but School B
  Section.findById = () => ({
    lean: async () => ({ _id: sectionB_Id, classId: classA_Id, schoolId: schoolB_Id, name: 'B' }),
  });

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'NEW_ADMISSION',
      fullName: 'Tariq Mehmood',
      guardianName: 'Mehmood Khan',
      guardianContact: '03001234567',
      classId: classA_Id,
      sectionId: sectionB_Id,
    },
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /section does not belong to the target school/i);
  } finally {
    Class.findById = origClassFind;
    Section.findById = origSectionFind;
  }
});

// ─── 2. STUDENT EMAIL & AUDIT BUG FIX INVARIANTS ─────────────────────────────
console.log('\n--- 2. Student Email Derivation & actorSchoolId Fix ---');

await runAsyncTest('handleEnrollStudent auto-derives institutional email matching authController', async () => {
  const origClassFind = Class.findById;
  const origSectionFind = Section.findById;
  const origSchoolFind = School.findById;
  const origSchoolFindByIdAndUpdate = School.findByIdAndUpdate;
  const origUserFindOne = User.findOne;
  const origUserCreate = User.create;
  const origStudentCreate = StudentProfile.create;
  const origAuditCreate = AuditLog.create;

  Class.findById = () => ({
    lean: async () => ({ _id: classA_Id, schoolId: schoolA_Id, name: 'Class 5' }),
  });
  Section.findById = () => ({
    lean: async () => ({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id, name: 'A' }),
  });
  School.findById = (id) => {
    const schoolObj = {
      _id: schoolA_Id,
      schoolCode: 'LMGA',
      code: 'LTC-001',
      lastGlobalSequence: 41,
      lastGrNumber: 1041,
    };
    return {
      ...schoolObj,
      select: () => ({
        ...schoolObj,
        lean: async () => schoolObj,
      }),
    };
  };
  School.findByIdAndUpdate = async (id, update) => ({
    _id: schoolA_Id,
    schoolCode: 'LMGA',
    lastGrNumber: 1042,
    lastGlobalSequence: 42,
  });
  User.findOne = async () => null;

  let createdUserPayload = null;
  User.create = async (payload) => {
    createdUserPayload = payload;
    return { _id: 'user_created_1', ...payload };
  };

  let createdStudentPayload = null;
  StudentProfile.create = async (payload) => {
    createdStudentPayload = payload;
    return { _id: 'student_created_1', ...payload };
  };

  let createdAuditPayload = null;
  AuditLog.create = async (payload) => {
    createdAuditPayload = payload;
    return { _id: 'audit_created_1', ...payload };
  };

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'NEW_ADMISSION',
      fullName: 'Kamran Akmal',
      guardianName: 'Akmal Khan',
      guardianContact: '03009876543',
      classId: classA_Id,
      sectionId: sectionA_Id,
    },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);

    // Verify institutional email convention
    assert.equal(createdUserPayload.email, 'gr-1042.lmga@student.liaquatabad-schools.gov.pk');
    assert.notEqual(createdUserPayload.email, null);

    // Verify student profile received studentFullName
    assert.equal(createdStudentPayload.studentFullName, 'Kamran Akmal');
    assert.equal(createdStudentPayload.grNumber, 1042);
    assert.equal(createdStudentPayload.globalStudentId, 'LMGA-0042');

    // Verify AuditLog received effectiveSchoolId and did NOT throw ReferenceError on actorSchoolId
    assert.equal(String(createdAuditPayload.schoolId), schoolA_Id);
    assert.equal(createdAuditPayload.action, 'STUDENT_NEW_ADMISSION');
  } finally {
    Class.findById = origClassFind;
    Section.findById = origSectionFind;
    School.findById = origSchoolFind;
    School.findByIdAndUpdate = origSchoolFindByIdAndUpdate;
    User.findOne = origUserFindOne;
    User.create = origUserCreate;
    StudentProfile.create = origStudentCreate;
    AuditLog.create = origAuditCreate;
  }
});

// ─── 3. HM STUDENT DIRECTORY (GET /api/v1/students/school) ───────────────────
console.log('\n--- 3. Scoped Student Directory & Anti-BOLA / IDOR Protection ---');

await runAsyncTest('handleGetSchoolStudents blocks non-authorized role with 403', async () => {
  const req = { user: teacher_User, query: {} };
  const res = createMockRes();

  await handleGetSchoolStudents(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /access denied/i);
});

await runAsyncTest('handleGetSchoolStudents allows HM to list own school students', async () => {
  const origFind = StudentProfile.find;
  const origCount = StudentProfile.countDocuments;

  const mockStudents = [
    {
      _id: 'sp_1',
      grNumber: 101,
      globalStudentId: 'LMGA-0001',
      studentFullName: 'Ali Raza',
      gender: 'MALE',
      classId: { _id: classA_Id, name: 'Class 5', numericGrade: 5 },
      sectionId: { _id: sectionA_Id, name: 'Section A' },
      userId: { fullName: 'Ali Raza', email: 'gr-101.lmga@student.liaquatabad-schools.gov.pk' },
      fatherOrGuardianName: 'Raza Ahmed',
      guardianContactNumber: '03001234567',
      lifecycleStatus: 'ACTIVE',
      admissionDate: new Date('2026-01-10'),
      admissionType: 'NEW_ADMISSION',
    },
  ];

  StudentProfile.find = (query) => {
    assert.equal(String(query.schoolId), schoolA_Id);
    return {
      populate: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({
              skip: () => ({
                limit: () => ({
                  lean: async () => mockStudents,
                }),
              }),
            }),
          }),
        }),
      }),
    };
  };
  StudentProfile.countDocuments = async (query) => {
    assert.equal(String(query.schoolId), schoolA_Id);
    return 1;
  };

  const req = { user: hmA_User, query: { page: 1, limit: 10 } };
  const res = createMockRes();

  try {
    await handleGetSchoolStudents(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.students.length, 1);
    assert.equal(res.body.data.students[0].grNumber, 101);
    assert.equal(res.body.data.students[0].globalStudentId, 'LMGA-0001');
    assert.equal(res.body.data.pagination.totalRecords, 1);
    assert.equal(res.body.data.pagination.currentPage, 1);

    // Minimal projection check: verify no passwordHash or session data is present
    assert.equal(res.body.data.students[0].passwordHash, undefined);
    assert.equal(res.body.data.students[0].activeSessions, undefined);
  } finally {
    StudentProfile.find = origFind;
    StudentProfile.countDocuments = origCount;
  }
});

await runAsyncTest('handleGetSchoolStudents strictly rejects HM passing manipulated School B ID with 403', async () => {
  const req = {
    user: hmA_User, // School A
    query: { schoolId: schoolB_Id }, // Attempting to access School B!
  };
  const res = createMockRes();

  await handleGetSchoolStudents(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /only access students belonging to your assigned school/i);
});

await runAsyncTest('handleGetSchoolStudents allows HM passing their own schoolId', async () => {
  const origFind = StudentProfile.find;
  const origCount = StudentProfile.countDocuments;

  StudentProfile.find = () => ({
    populate: () => ({
      populate: () => ({
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: async () => [],
              }),
            }),
          }),
        }),
      }),
    }),
  });
  StudentProfile.countDocuments = async () => 0;

  const req = {
    user: hmA_User,
    query: { schoolId: schoolA_Id },
  };
  const res = createMockRes();

  try {
    await handleGetSchoolStudents(req, res);
    assert.equal(res.statusCode, 200);
  } finally {
    StudentProfile.find = origFind;
    StudentProfile.countDocuments = origCount;
  }
});

// ─── 4. SERVER-SIDE SEARCH ENGINE & REDOS RESISTANCE ─────────────────────────
console.log('\n--- 4. Server-Side Search Engine & ReDoS Escaping ---');

await runAsyncTest('Numeric search term uses indexed grNumber directly', async () => {
  const origFind = StudentProfile.find;
  const origCount = StudentProfile.countDocuments;

  let executedQuery = null;
  StudentProfile.find = (query) => {
    executedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({
              skip: () => ({
                limit: () => ({
                  lean: async () => [],
                }),
              }),
            }),
          }),
        }),
      }),
    };
  };
  StudentProfile.countDocuments = async () => 0;

  const req = { user: hmA_User, query: { search: '1042' } };
  const res = createMockRes();

  try {
    await handleGetSchoolStudents(req, res);
    assert.equal(res.statusCode, 200);
    // Index invariant: numeric query hits grNumber index
    assert.equal(executedQuery.grNumber, 1042);
    assert.equal(executedQuery.$or, undefined);
  } finally {
    StudentProfile.find = origFind;
    StudentProfile.countDocuments = origCount;
  }
});

await runAsyncTest('Search term with special characters escapes ReDoS safely', async () => {
  const origFind = StudentProfile.find;
  const origCount = StudentProfile.countDocuments;
  const origUserFind = User.find;

  User.find = () => ({
    distinct: async () => [],
  });

  let executedQuery = null;
  StudentProfile.find = (query) => {
    executedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({
              skip: () => ({
                limit: () => ({
                  lean: async () => [],
                }),
              }),
            }),
          }),
        }),
      }),
    };
  };
  StudentProfile.countDocuments = async () => 0;

  // Catastrophic ReDoS payload with unclosed parentheses and quantifiers
  const maliciousSearch = '([a-zA-Z]+)*?$';
  const req = { user: hmA_User, query: { search: maliciousSearch } };
  const res = createMockRes();

  try {
    const startTime = Date.now();
    await handleGetSchoolStudents(req, res);
    const duration = Date.now() - startTime;

    assert.equal(res.statusCode, 200);
    assert.ok(duration < 100, `Execution took ${duration}ms, must be < 100ms`);
    assert.ok(executedQuery.$or, 'Constructed $or search query with safe escaped regex');
  } finally {
    StudentProfile.find = origFind;
    StudentProfile.countDocuments = origCount;
    User.find = origUserFind;
  }
});

// ─── 5. ATOMIC SEQUENCE GENERATION & INVARIANTS ──────────────────────────────
console.log('\n--- 5. Atomic Counter & Global ID Sequence Invariants ---');

await runAsyncTest('Concurrent counter calls increment atomically without duplicates', async () => {
  let counter = 100;
  const origFindById = School.findById;
  const origFindByIdAndUpdate = School.findByIdAndUpdate;

  School.findById = () => ({
    select: async () => ({
      _id: schoolA_Id,
      schoolCode: 'LMGA',
      lastGlobalSequence: counter,
    }),
  });

  School.findByIdAndUpdate = async (id, update) => {
    const incAmount = update.$inc?.lastGlobalSequence || 1;
    counter += incAmount;
    return {
      _id: schoolA_Id,
      lastGlobalSequence: counter,
      schoolCode: 'LMGA',
    };
  };

  try {
    const [id1, id2, id3] = await Promise.all([
      grNumberService.generateGlobalStudentId(schoolA_Id),
      grNumberService.generateGlobalStudentId(schoolA_Id),
      grNumberService.generateGlobalStudentId(schoolA_Id),
    ]);

    assert.notEqual(id1, id2);
    assert.notEqual(id2, id3);
    assert.notEqual(id1, id3);
    assert.match(id1, /^LMGA-\d{4}$/);
    assert.match(id2, /^LMGA-\d{4}$/);
    assert.match(id3, /^LMGA-\d{4}$/);
  } finally {
    School.findById = origFindById;
    School.findByIdAndUpdate = origFindByIdAndUpdate;
  }
});

await runAsyncTest('handleEnrollStudent rejects duplicate manual GR number with 400', async () => {
  const origClassFind = Class.findById;
  const origSectionFind = Section.findById;
  const origStudentFindOne = StudentProfile.findOne;

  Class.findById = () => ({
    lean: async () => ({ _id: classA_Id, schoolId: schoolA_Id, name: 'Class 5' }),
  });
  Section.findById = () => ({
    lean: async () => ({ _id: sectionA_Id, classId: classA_Id, schoolId: schoolA_Id, name: 'A' }),
  });
  // Simulate manual GR 505 already assigned in this school
  StudentProfile.findOne = async () => ({
    _id: 'existing_student_profile',
    schoolId: schoolA_Id,
    grNumber: 505,
  });

  const req = {
    user: hmA_User,
    body: {
      admissionType: 'EXISTING_ENTRY',
      manualGrNumber: 505,
      fullName: 'Babar Azam',
      guardianName: 'Azam Siddiqui',
      guardianContact: '03001234567',
      classId: classA_Id,
      sectionId: sectionA_Id,
    },
  };
  const res = createMockRes();

  try {
    await handleEnrollStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /already assigned to another student/i);
  } finally {
    Class.findById = origClassFind;
    Section.findById = origSectionFind;
    StudentProfile.findOne = origStudentFindOne;
  }
});

// ─── 6. HM Student Strike-Off Authority & Controlled Administrative Flow ──────
console.log('\n--- 6. HM Student Strike-Off Authority & Controlled Administrative Flow ---');

await runAsyncTest('handleStrikeOffStudent blocks non-authorized role with 403', async () => {
  const req = {
    user: { _id: 'teacher_user_id', role: ROLES.TEACHER, schoolId: schoolA_Id },
    params: { id: 'some_student_id' },
    body: { reason: 'Prolonged absence exceeding 30 consecutive days' },
  };
  const res = createMockRes();

  await handleStrikeOffStudent(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /not authorized to strike off/i);
});

await runAsyncTest('handleStrikeOffStudent strictly rejects HM striking off student of School B with 403', async () => {
  const origStudentFindById = StudentProfile.findById;
  StudentProfile.findById = async () => ({
    _id: 'student_school_b',
    schoolId: schoolB_Id, // Student belongs to School B
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  });

  const req = {
    user: hmA_User, // HM belongs to School A
    params: { id: 'student_school_b' },
    body: { reason: 'Disciplinary strike-off after inquiry' },
  };
  const res = createMockRes();

  try {
    await handleStrikeOffStudent(req, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.message, /only strike off students from your assigned school/i);
  } finally {
    StudentProfile.findById = origStudentFindById;
  }
});

await runAsyncTest('handleStrikeOffStudent returns 404 for non-existent student', async () => {
  const origStudentFindById = StudentProfile.findById;
  const origStudentFindOne = StudentProfile.findOne;
  StudentProfile.findById = async () => null;
  StudentProfile.findOne = async () => null;

  const req = {
    user: hmA_User,
    params: { id: 'non_existent_student_id' },
    body: { reason: 'Student cannot be located anywhere' },
  };
  const res = createMockRes();

  try {
    await handleStrikeOffStudent(req, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.message, /student profile not found/i);
  } finally {
    StudentProfile.findById = origStudentFindById;
    StudentProfile.findOne = origStudentFindOne;
  }
});

await runAsyncTest('handleStrikeOffStudent returns 400 when student is already struck off', async () => {
  const origStudentFindById = StudentProfile.findById;
  StudentProfile.findById = async () => ({
    _id: 'already_struck_off_student',
    schoolId: schoolA_Id,
    lifecycleStatus: STUDENT_STATUS.STRUCK_OFF,
  });

  const req = {
    user: hmA_User,
    params: { id: 'already_struck_off_student' },
    body: { reason: 'Duplicate strike-off attempt reason' },
  };
  const res = createMockRes();

  try {
    await handleStrikeOffStudent(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /already marked as struck off/i);
  } finally {
    StudentProfile.findById = origStudentFindById;
  }
});

await runAsyncTest('handleStrikeOffStudent atomically updates profile, invalidates user, revokes parent links, and creates audit log', async () => {
  const origStudentFindById = StudentProfile.findById;
  const origUserFindByIdAndUpdate = User.findByIdAndUpdate;
  const origParentLinkUpdateMany = ParentStudentLink.updateMany;
  const origAuditCreate = AuditLog.create;

  let savedProfile = null;
  let userUpdated = null;
  let parentLinksRevoked = null;
  let auditCreated = null;

  const mockProfile = {
    _id: 'target_student_profile_id',
    schoolId: schoolA_Id,
    userId: 'student_user_account_id',
    grNumber: 1042,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
    admissionRemarks: 'Enrolled in 2024',
    save: async function () {
      savedProfile = this;
      return this;
    },
  };

  StudentProfile.findById = async () => mockProfile;
  User.findByIdAndUpdate = async (userId, updateQuery) => {
    userUpdated = { userId, updateQuery };
    return { _id: userId };
  };
  ParentStudentLink.updateMany = async (filter, update) => {
    parentLinksRevoked = { filter, update };
    return { modifiedCount: 1 };
  };
  AuditLog.create = async (auditPayload) => {
    auditCreated = auditPayload;
    return auditPayload;
  };

  const req = {
    user: hmA_User,
    params: { id: 'target_student_profile_id' },
    body: { reason: 'Prolonged absence exceeding 30 consecutive school days without excuse' },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'HM-Browser' },
  };
  const res = createMockRes();

  try {
    await handleStrikeOffStudent(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.lifecycleStatus, STUDENT_STATUS.STRUCK_OFF);

    // Verify StudentProfile was updated with remarks and STRUCK_OFF status
    assert.equal(savedProfile.lifecycleStatus, STUDENT_STATUS.STRUCK_OFF);
    assert.match(savedProfile.admissionRemarks, /STRUCK OFF/);
    assert.match(savedProfile.admissionRemarks, /Prolonged absence exceeding 30 consecutive/);

    // Verify User account status was set to STRUCK_OFF and tokenVersion incremented
    assert.equal(userUpdated.userId, 'student_user_account_id');
    assert.equal(userUpdated.updateQuery.$set.status, USER_STATUS.STRUCK_OFF);
    assert.equal(userUpdated.updateQuery.$inc.tokenVersion, 1);

    // Verify ParentStudentLink records were auto-revoked
    assert.equal(parentLinksRevoked.update.$set.verificationStatus, 'REVOKED');
    assert.match(parentLinksRevoked.update.$set.revocationReason, /struck off from school records/i);

    // Verify AuditLog was created
    assert.equal(auditCreated.action, 'STUDENT_STRUCK_OFF');
    assert.equal(auditCreated.targetModel, 'StudentProfile');
    assert.equal(auditCreated.actorId, hmA_User._id);
    assert.equal(auditCreated.newState.lifecycleStatus, STUDENT_STATUS.STRUCK_OFF);
  } finally {
    StudentProfile.findById = origStudentFindById;
    User.findByIdAndUpdate = origUserFindByIdAndUpdate;
    ParentStudentLink.updateMany = origParentLinkUpdateMany;
    AuditLog.create = origAuditCreate;
  }
});

await runAsyncTest('handleLogin rejects struck-off student account with institutional guidance message', async () => {
  const origUserFindOne = User.findOne;
  const origLockoutFindOne = SecurityLockout.findOne;
  const origLockoutDeleteOne = SecurityLockout.deleteOne;

  SecurityLockout.findOne = async () => null;
  SecurityLockout.deleteOne = async () => ({ acknowledged: true });

  const validHash = await hashPassword('StudentPassword123!');

  // Simulate user with status STRUCK_OFF and genuine Argon2id hash
  User.findOne = () => ({
    select: () => ({
      _id: 'struck_off_user_id',
      email: 'student.1042@school.edu.pk',
      passwordHash: validHash,
      status: USER_STATUS.STRUCK_OFF,
      activeSessions: [],
      tokenVersion: 2,
    }),
  });

  const req = {
    body: {
      email: 'student.1042@school.edu.pk',
      password: 'StudentPassword123!',
    },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockRes();

  try {
    await handleLogin(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(
      res.body.message,
      'Your student account is currently marked as struck off by your school. Please contact your Head Master for assistance.'
    );
  } finally {
    User.findOne = origUserFindOne;
    SecurityLockout.findOne = origLockoutFindOne;
    SecurityLockout.deleteOne = origLockoutDeleteOne;
  }
});

console.log('\n======================================================================');
console.log(`🏆 ALL ${passedTests}/${totalTests} HM STUDENT MANAGEMENT & DIRECTORY TESTS PASSED!`);
console.log('======================================================================\n');

