/**
 * 🏛️ INSTITUTIONAL TIMETABLE ENGINE TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Verifies:
 *   1. Model & Zod validation (period slots, time format, day enum, required fields)
 *   2. Server-side conflict engine (teacher clash, section clash, cross-school, TeachingAssignment)
 *   3. Optimistic concurrency control (version matching, 409 Conflict)
 *   4. Zero-timer deterministic live period calculations (Karachi timezone)
 *   5. Scoped and anti-BOLA API access (HM, Supervisor, Teacher, Student, Parent)
 *   6. Immutable audit logging on timetable lifecycle events
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  handleGetSchoolTimetable,
  handleManageTimetable,
  handleGetTownLiveMonitor,
  handleGetMySchedule,
} from '../src/controllers/timetableController.js';
import {
  calculateLivePeriod,
  validateTimetableConflicts,
  TimetableValidationError,
} from '../src/services/timetableConflictService.js';
import {
  manageTimetableSchema,
  periodSlotSchema,
  scheduleEntrySchema,
} from '../src/validations/timetableSchemas.js';
import Timetable from '../src/models/Timetable.js';
import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import Subject from '../src/models/Subject.js';
import User from '../src/models/User.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import StudentProfile from '../src/models/StudentProfile.js';
import ParentStudentLink from '../src/models/ParentStudentLink.js';
import AuditLog from '../src/models/AuditLog.js';
import {
  ROLES,
  SCOPES,
  TIMETABLE_SLOT_TYPE,
  TIMETABLE_STATUS,
  PARENT_STUDENT_LINK_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from '../config/constants.js';

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
  const response = {
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
    setHeader(key, value) {
      this.headers[key] = value;
    },
  };
  return response;
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
console.log('🏛️ RUNNING INSTITUTIONAL TIMETABLE ENGINE TEST SUITE');
console.log('======================================================================\n');

// ─── Test Identities ─────────────────────────────────────────────────────────
const schoolA_Id = new mongoose.Types.ObjectId();
const schoolB_Id = new mongoose.Types.ObjectId();

const townA_Id = new mongoose.Types.ObjectId();
const townB_Id = new mongoose.Types.ObjectId();

const hmA_Id = new mongoose.Types.ObjectId();
const hmB_Id = new mongoose.Types.ObjectId();

const supervisor_Id = new mongoose.Types.ObjectId();
const teacher1_Id = new mongoose.Types.ObjectId();
const teacher2_Id = new mongoose.Types.ObjectId();
const student_Id = new mongoose.Types.ObjectId();
const parent_Id = new mongoose.Types.ObjectId();

const class1_Id = new mongoose.Types.ObjectId();
const section1_Id = new mongoose.Types.ObjectId();
const subject1_Id = new mongoose.Types.ObjectId();

const standardPeriodSlots = [
  {
    periodNumber: 0,
    slotType: TIMETABLE_SLOT_TYPE.ASSEMBLY,
    label: 'Morning Assembly',
    startTime: '08:00',
    endTime: '08:20',
  },
  {
    periodNumber: 1,
    slotType: TIMETABLE_SLOT_TYPE.TEACHING,
    label: 'Period 1',
    startTime: '08:20',
    endTime: '09:05',
  },
  {
    periodNumber: 2,
    slotType: TIMETABLE_SLOT_TYPE.TEACHING,
    label: 'Period 2',
    startTime: '09:05',
    endTime: '09:50',
  },
  {
    periodNumber: 3,
    slotType: TIMETABLE_SLOT_TYPE.RECESS,
    label: 'Recess Interval',
    startTime: '10:30',
    endTime: '11:00',
  },
  {
    periodNumber: 4,
    slotType: TIMETABLE_SLOT_TYPE.TEACHING,
    label: 'Period 4',
    startTime: '11:00',
    endTime: '11:45',
  },
];

async function executeTestSuite() {
  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 1: Zod Schema & Format Validations
  // ───────────────────────────────────────────────────────────────────────────

  await runAsyncTest('Test 1: Valid periodSlotSchema parses clean slot', () => {
    const result = periodSlotSchema.safeParse({
      periodNumber: 1,
      slotType: 'TEACHING',
      label: 'Mathematics',
      startTime: '08:00',
      endTime: '08:45',
    });
    assert.strictEqual(result.success, true);
  });

  await runAsyncTest('Test 2: Invalid HH:mm format rejected by periodSlotSchema', () => {
    const result = periodSlotSchema.safeParse({
      periodNumber: 1,
      slotType: 'TEACHING',
      label: 'Math',
      startTime: '8:00 AM', // Invalid
      endTime: '08:45',
    });
    assert.strictEqual(result.success, false);
  });

  await runAsyncTest('Test 3: Slot endTime <= startTime rejected by periodSlotSchema', () => {
    const result = periodSlotSchema.safeParse({
      periodNumber: 1,
      slotType: 'TEACHING',
      label: 'Math',
      startTime: '09:00',
      endTime: '08:30', // Inverted
    });
    assert.strictEqual(result.success, false);
  });

  await runAsyncTest('Test 4: Overlapping period slots rejected by manageTimetableSchema', () => {
    const result = manageTimetableSchema.safeParse({
      schoolId: schoolA_Id.toString(),
      academicYear: '2025-2026',
      periodSlots: [
        { periodNumber: 1, slotType: 'TEACHING', label: 'Period 1', startTime: '08:00', endTime: '08:50' },
        { periodNumber: 2, slotType: 'TEACHING', label: 'Period 2', startTime: '08:40', endTime: '09:30' }, // Overlaps by 10 mins
      ],
      schedule: [],
    });
    assert.strictEqual(result.success, false);
  });

  await runAsyncTest('Test 5: Duplicate periodNumber in periodSlots rejected', () => {
    const result = manageTimetableSchema.safeParse({
      schoolId: schoolA_Id.toString(),
      academicYear: '2025-2026',
      periodSlots: [
        { periodNumber: 1, slotType: 'TEACHING', label: 'Period 1', startTime: '08:00', endTime: '08:45' },
        { periodNumber: 1, slotType: 'TEACHING', label: 'Period 1 Dup', startTime: '08:50', endTime: '09:35' }, // Duplicate period 1
      ],
      schedule: [],
    });
    assert.strictEqual(result.success, false);
  });

  await runAsyncTest('Test 6: Invalid dayOfWeek rejected by scheduleEntrySchema', () => {
    const result = scheduleEntrySchema.safeParse({
      dayOfWeek: 'FUNDAY', // Invalid
      periodNumber: 1,
      classId: class1_Id.toString(),
      sectionId: section1_Id.toString(),
    });
    assert.strictEqual(result.success, false);
  });

  await runAsyncTest('Test 7: Schedule entry referencing non-existent periodNumber rejected', () => {
    const result = manageTimetableSchema.safeParse({
      schoolId: schoolA_Id.toString(),
      academicYear: '2025-2026',
      periodSlots: [
        { periodNumber: 1, slotType: 'TEACHING', label: 'Period 1', startTime: '08:00', endTime: '08:45' },
      ],
      schedule: [
        {
          dayOfWeek: 'MONDAY',
          periodNumber: 9, // Period 9 does not exist in periodSlots
          classId: class1_Id.toString(),
          sectionId: section1_Id.toString(),
        },
      ],
    });
    assert.strictEqual(result.success, false);
  });

  await runAsyncTest('Test 8: Schedule entry targeting ASSEMBLY/RECESS slot rejected', () => {
    const result = manageTimetableSchema.safeParse({
      schoolId: schoolA_Id.toString(),
      academicYear: '2025-2026',
      periodSlots: [
        { periodNumber: 0, slotType: 'ASSEMBLY', label: 'Assembly', startTime: '08:00', endTime: '08:20' },
        { periodNumber: 1, slotType: 'TEACHING', label: 'Period 1', startTime: '08:20', endTime: '09:05' },
      ],
      schedule: [
        {
          dayOfWeek: 'MONDAY',
          periodNumber: 0, // Cannot schedule teaching class in Assembly slot
          classId: class1_Id.toString(),
          sectionId: section1_Id.toString(),
        },
      ],
    });
    assert.strictEqual(result.success, false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 2: Server-Side Conflict Detection Engine
  // ───────────────────────────────────────────────────────────────────────────

  // Setup Mock Data
  const mockSchoolA = { _id: schoolA_Id, name: 'Liaquatabad Primary School', status: 'ACTIVE', townId: townA_Id };
  const mockClass1 = { _id: class1_Id, schoolId: schoolA_Id, name: 'Class 5', status: 'ACTIVE' };
  const mockSection1 = { _id: section1_Id, classId: class1_Id, schoolId: schoolA_Id, name: 'Section A', status: 'ACTIVE' };
  const mockSubject1 = { _id: subject1_Id, schoolId: schoolA_Id, name: 'General Science', status: 'ACTIVE' };
  const mockTeacher1 = { _id: teacher1_Id, schoolId: schoolA_Id, fullName: 'Sir Naveed', role: ROLES.TEACHER, status: 'ACTIVE' };
  const mockTeacher2 = { _id: teacher2_Id, schoolId: schoolA_Id, fullName: 'Miss Farzana', role: ROLES.TEACHER, status: 'ACTIVE' };

  School.findById = (id) => ({
    select: () => ({
      lean: async () => (String(id) === String(schoolA_Id) ? mockSchoolA : null),
    }),
  });

  Class.find = () => ({
    select: () => ({
      lean: async () => [mockClass1],
    }),
  });

  Section.find = () => ({
    select: () => ({
      lean: async () => [mockSection1],
    }),
  });

  Subject.find = () => ({
    select: () => ({
      lean: async () => [mockSubject1],
    }),
  });

  User.find = () => ({
    select: () => ({
      lean: async () => [mockTeacher1, mockTeacher2],
    }),
  });

  await runAsyncTest('Test 9: Teacher double-booking (same teacher, same day, same period) rejected with 409', async () => {
    const conflictingSchedule = [
      {
        dayOfWeek: 'MONDAY',
        periodNumber: 1,
        classId: class1_Id,
        sectionId: section1_Id,
        subjectId: subject1_Id,
        teacherId: teacher1_Id,
      },
      {
        dayOfWeek: 'MONDAY',
        periodNumber: 1,
        classId: class1_Id,
        sectionId: new mongoose.Types.ObjectId(), // Different section
        subjectId: subject1_Id,
        teacherId: teacher1_Id, // Same teacher!
      },
    ];

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: conflictingSchedule,
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 409);
        assert.strictEqual(error.errorType, 'TEACHER_PERIOD_CLASH');
        return true;
      }
    );
  });

  await runAsyncTest('Test 10: Section double-booking (same section, same day, same period) rejected with 409', async () => {
    const conflictingSchedule = [
      {
        dayOfWeek: 'MONDAY',
        periodNumber: 1,
        classId: class1_Id,
        sectionId: section1_Id,
        subjectId: subject1_Id,
        teacherId: teacher1_Id,
      },
      {
        dayOfWeek: 'MONDAY',
        periodNumber: 1,
        classId: class1_Id,
        sectionId: section1_Id, // Exact same section!
        subjectId: new mongoose.Types.ObjectId(),
        teacherId: teacher2_Id,
      },
    ];

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: conflictingSchedule,
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 409);
        assert.strictEqual(error.errorType, 'SECTION_PERIOD_CLASH');
        return true;
      }
    );
  });

  await runAsyncTest('Test 11: Cross-school Class reference rejected with 403 BOLA', async () => {
    Class.find = () => ({
      select: () => ({
        lean: async () => [{ _id: class1_Id, schoolId: schoolB_Id, name: 'Foreign Class', status: 'ACTIVE' }],
      }),
    });

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: [
            {
              dayOfWeek: 'MONDAY',
              periodNumber: 1,
              classId: class1_Id,
              sectionId: section1_Id,
              subjectId: subject1_Id,
              teacherId: teacher1_Id,
            },
          ],
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 403);
        assert.strictEqual(error.errorType, 'CROSS_SCHOOL_CLASS_VIOLATION');
        return true;
      }
    );

    // Restore
    Class.find = () => ({ select: () => ({ lean: async () => [mockClass1] }) });
  });

  await runAsyncTest('Test 12: Cross-school Section reference rejected with 403 BOLA', async () => {
    Section.find = () => ({
      select: () => ({
        lean: async () => [{ _id: section1_Id, classId: class1_Id, schoolId: schoolB_Id, name: 'Foreign Section', status: 'ACTIVE' }],
      }),
    });

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: [
            {
              dayOfWeek: 'MONDAY',
              periodNumber: 1,
              classId: class1_Id,
              sectionId: section1_Id,
              subjectId: subject1_Id,
              teacherId: teacher1_Id,
            },
          ],
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 403);
        assert.strictEqual(error.errorType, 'CROSS_SCHOOL_SECTION_VIOLATION');
        return true;
      }
    );

    // Restore
    Section.find = () => ({ select: () => ({ lean: async () => [mockSection1] }) });
  });

  await runAsyncTest('Test 13: Section/Class mismatch rejected with 422', async () => {
    const wrongClassId = new mongoose.Types.ObjectId();
    Section.find = () => ({
      select: () => ({
        lean: async () => [{ _id: section1_Id, classId: wrongClassId, schoolId: schoolA_Id, name: 'Section A', status: 'ACTIVE' }],
      }),
    });

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: [
            {
              dayOfWeek: 'MONDAY',
              periodNumber: 1,
              classId: class1_Id, // Mismatch with wrongClassId
              sectionId: section1_Id,
              subjectId: subject1_Id,
              teacherId: teacher1_Id,
            },
          ],
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 422);
        assert.strictEqual(error.errorType, 'SECTION_CLASS_MISMATCH');
        return true;
      }
    );

    // Restore
    Section.find = () => ({ select: () => ({ lean: async () => [mockSection1] }) });
  });

  await runAsyncTest('Test 14: Cross-school Subject rejected with 403 BOLA', async () => {
    Subject.find = () => ({
      select: () => ({
        lean: async () => [{ _id: subject1_Id, schoolId: schoolB_Id, name: 'Foreign Subject', status: 'ACTIVE' }],
      }),
    });

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: [
            {
              dayOfWeek: 'MONDAY',
              periodNumber: 1,
              classId: class1_Id,
              sectionId: section1_Id,
              subjectId: subject1_Id,
              teacherId: teacher1_Id,
            },
          ],
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 403);
        assert.strictEqual(error.errorType, 'CROSS_SCHOOL_SUBJECT_VIOLATION');
        return true;
      }
    );

    // Restore
    Subject.find = () => ({ select: () => ({ lean: async () => [mockSubject1] }) });
  });

  await runAsyncTest('Test 15: Inactive Teacher rejected with 422', async () => {
    User.find = () => ({
      select: () => ({
        lean: async () => [{ _id: teacher1_Id, schoolId: schoolA_Id, fullName: 'Sir Suspended', role: ROLES.TEACHER, status: 'SUSPENDED' }],
      }),
    });

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: [
            {
              dayOfWeek: 'MONDAY',
              periodNumber: 1,
              classId: class1_Id,
              sectionId: section1_Id,
              subjectId: subject1_Id,
              teacherId: teacher1_Id,
            },
          ],
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 422);
        assert.strictEqual(error.errorType, 'TEACHER_INACTIVE');
        return true;
      }
    );

    // Restore
    User.find = () => ({ select: () => ({ lean: async () => [mockTeacher1] }) });
  });

  await runAsyncTest('Test 16: Mandatory TeachingAssignment check rejects timetable save when assignment missing', async () => {
    // TeachingAssignment returns null (teacher not assigned to this subject/section in official register)
    TeachingAssignment.findOne = () => ({
      lean: async () => null,
    });

    await assert.rejects(
      async () => {
        await validateTimetableConflicts({
          schoolId: schoolA_Id,
          academicYear: '2025-2026',
          periodSlots: standardPeriodSlots,
          schedule: [
            {
              dayOfWeek: 'MONDAY',
              periodNumber: 1,
              classId: class1_Id,
              sectionId: section1_Id,
              subjectId: subject1_Id,
              teacherId: teacher1_Id,
            },
          ],
        });
      },
      (error) => {
        assert(error instanceof TimetableValidationError);
        assert.strictEqual(error.statusCode, 422);
        assert.strictEqual(error.errorType, 'TEACHING_ASSIGNMENT_NOT_FOUND');
        return true;
      }
    );
  });

  await runAsyncTest('Test 17: Valid TeachingAssignment confirms conflict check passes', async () => {
    // Active TeachingAssignment exists
    TeachingAssignment.findOne = () => ({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        teacherId: teacher1_Id,
        schoolId: schoolA_Id,
        classId: class1_Id,
        sectionId: section1_Id,
        subjectId: subject1_Id,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      }),
    });

    const result = await validateTimetableConflicts({
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      periodSlots: standardPeriodSlots,
      schedule: [
        {
          dayOfWeek: 'MONDAY',
          periodNumber: 1,
          classId: class1_Id,
          sectionId: section1_Id,
          subjectId: subject1_Id,
          teacherId: teacher1_Id,
        },
      ],
    });

    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.targetSchool.name, 'Liaquatabad Primary School');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 3: Deterministic Live Period Computation (No Timers)
  // ───────────────────────────────────────────────────────────────────────────

  await runAsyncTest('Test 18: Live period: BEFORE_SCHOOL before 08:00', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '07:45', 1); // Monday 07:45
    assert.strictEqual(liveStatus.status, 'BEFORE_SCHOOL');
    assert.strictEqual(liveStatus.nextSlot.label, 'Morning Assembly');
  });

  await runAsyncTest('Test 19: Live period: ASSEMBLY during 08:00-08:20', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '08:10', 1); // Monday 08:10
    assert.strictEqual(liveStatus.status, 'ASSEMBLY');
    assert.strictEqual(liveStatus.activeSlot.label, 'Morning Assembly');
  });

  await runAsyncTest('Test 20: Live period: ACTIVE_TEACHING during period 1 (08:20-09:05)', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '08:35', 1); // Monday 08:35
    assert.strictEqual(liveStatus.status, 'ACTIVE_TEACHING');
    assert.strictEqual(liveStatus.activeSlot.periodNumber, 1);
  });

  await runAsyncTest('Test 21: Live period: RECESS during 10:30-11:00', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '10:45', 2); // Tuesday 10:45
    assert.strictEqual(liveStatus.status, 'RECESS');
    assert.strictEqual(liveStatus.activeSlot.label, 'Recess Interval');
  });

  await runAsyncTest('Test 22: Live period: INTERVAL between period 2 (ends 09:50) and recess (starts 10:30)', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '10:05', 3); // Wednesday 10:05
    assert.strictEqual(liveStatus.status, 'INTERVAL');
    assert.strictEqual(liveStatus.nextSlot.label, 'Recess Interval');
  });

  await runAsyncTest('Test 23: Live period: AFTER_SCHOOL after 11:45', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '13:00', 4); // Thursday 13:00
    assert.strictEqual(liveStatus.status, 'AFTER_SCHOOL');
    assert.strictEqual(liveStatus.activeSlot, null);
  });

  await runAsyncTest('Test 24: Live period: OFF_DAY on Sunday', () => {
    const liveStatus = calculateLivePeriod(standardPeriodSlots, '09:00', 0); // Sunday
    assert.strictEqual(liveStatus.status, 'OFF_DAY');
    assert.strictEqual(liveStatus.currentDay, 'SUNDAY');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 4: Controller Access, Scoping, Concurrency & Audit Verification
  // ───────────────────────────────────────────────────────────────────────────

  let auditEntriesCreated = [];
  AuditLog.create = async (auditPayload) => {
    auditEntriesCreated.push(auditPayload);
    return { _id: new mongoose.Types.ObjectId(), ...auditPayload };
  };

  await runAsyncTest('Test 25: Cross-school HM BOLA mutation blocked with 403 and logged to AuditLog', async () => {
    const req = {
      user: {
        _id: hmA_Id,
        role: ROLES.HM,
        schoolId: schoolA_Id, // Assigned to School A
        fullName: 'HM Asif',
      },
      body: {
        schoolId: schoolB_Id.toString(), // Attacking School B
        academicYear: '2025-2026',
        periodSlots: standardPeriodSlots,
        schedule: [],
      },
      ip: '192.168.1.100',
      headers: { 'user-agent': 'TestAgent', 'x-request-id': 'req-bola-1' },
    };
    const res = createMockResponse();

    await handleManageTimetable(req, res);

    assert.strictEqual(res.statusCode, 403);
    assert(res.body.message.includes('own school'));

    // Verify Denied Audit Log was written
    const lastAudit = auditEntriesCreated[auditEntriesCreated.length - 1];
    assert.strictEqual(lastAudit.action, 'HM_CROSS_SCHOOL_TIMETABLE_VIOLATION');
    assert.strictEqual(lastAudit.result, 'DENIED');
  });

  await runAsyncTest('Test 26: Valid Timetable Creation writes TIMETABLE_CREATED audit log and returns 201', async () => {
    Timetable.findOne = () => makeChainable(null); // No existing timetable
    Timetable.create = async (doc) => ({
      _id: new mongoose.Types.ObjectId(),
      ...doc,
      version: 1,
    });

    const req = {
      user: {
        _id: hmA_Id,
        role: ROLES.HM,
        schoolId: schoolA_Id,
        fullName: 'HM Asif',
      },
      body: {
        schoolId: schoolA_Id.toString(),
        academicYear: '2025-2026',
        periodSlots: standardPeriodSlots,
        schedule: [
          {
            dayOfWeek: 'MONDAY',
            periodNumber: 1,
            classId: class1_Id,
            sectionId: section1_Id,
            subjectId: subject1_Id,
            teacherId: teacher1_Id,
          },
        ],
      },
      ip: '192.168.1.100',
      headers: {},
    };
    const res = createMockResponse();

    await handleManageTimetable(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.success, true);

    const audit = auditEntriesCreated[auditEntriesCreated.length - 1];
    assert.strictEqual(audit.action, 'TIMETABLE_CREATED');
    assert.strictEqual(audit.result, 'SUCCESS');
  });

  await runAsyncTest('Test 27: Concurrency Control: Version mismatch returns 409 Conflict', async () => {
    const existingDoc = {
      _id: new mongoose.Types.ObjectId(),
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      version: 3, // Database has moved to version 3
      periodSlots: standardPeriodSlots,
      schedule: [],
    };
    Timetable.findOne = () => makeChainable(existingDoc);

    const req = {
      user: {
        _id: hmA_Id,
        role: ROLES.HM,
        schoolId: schoolA_Id,
        fullName: 'HM Asif',
      },
      body: {
        schoolId: schoolA_Id.toString(),
        academicYear: '2025-2026',
        version: 1, // Client expects version 1 (Stale client edit!)
        periodSlots: standardPeriodSlots,
        schedule: [],
      },
      ip: '192.168.1.100',
      headers: {},
    };
    const res = createMockResponse();

    await handleManageTimetable(req, res);

    assert.strictEqual(res.statusCode, 409);
    assert(res.body.message.includes('Conflict: Timetable was updated by another administrator'));
  });

  await runAsyncTest('Test 28: Valid Timetable Update increments version and writes TIMETABLE_UPDATED audit log', async () => {
    let savedVersion = 1;
    const existingDoc = {
      _id: new mongoose.Types.ObjectId(),
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      version: 1,
      periodSlots: standardPeriodSlots,
      schedule: [],
      save: async function () {
        savedVersion = this.version;
        return this;
      },
    };
    Timetable.findOne = () => makeChainable(existingDoc);

    const req = {
      user: {
        _id: hmA_Id,
        role: ROLES.HM,
        schoolId: schoolA_Id,
        fullName: 'HM Asif',
      },
      body: {
        schoolId: schoolA_Id.toString(),
        academicYear: '2025-2026',
        version: 1,
        periodSlots: standardPeriodSlots,
        schedule: [],
      },
      ip: '192.168.1.100',
      headers: {},
    };
    const res = createMockResponse();

    await handleManageTimetable(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(savedVersion, 2);

    const audit = auditEntriesCreated[auditEntriesCreated.length - 1];
    assert.strictEqual(audit.action, 'TIMETABLE_UPDATED');
    assert.strictEqual(audit.result, 'SUCCESS');
  });

  await runAsyncTest('Test 29: handleGetSchoolTimetable populates schedule and attaches liveStatus', async () => {
    const mockDbTimetable = {
      _id: new mongoose.Types.ObjectId(),
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      periodSlots: standardPeriodSlots,
      schedule: [
        {
          dayOfWeek: 'MONDAY',
          periodNumber: 1,
          classId: { _id: class1_Id, name: 'Class 5', numericGrade: 5 },
          sectionId: { _id: section1_Id, name: 'Section A', roomNumber: '12' },
          subjectId: { _id: subject1_Id, name: 'Science' },
          teacherId: { _id: teacher1_Id, fullName: 'Sir Naveed' },
        },
      ],
    };
    Timetable.findOne = () => makeChainable(mockDbTimetable);

    const req = {
      params: { schoolId: schoolA_Id.toString() },
      query: {},
    };
    const res = createMockResponse();

    await handleGetSchoolTimetable(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert(res.body.data.liveStatus !== undefined);
  });

  await runAsyncTest('Test 30: Supervisor town-live-monitor restricts results to assignedSchools', async () => {
    School.find = (filter) => {
      // Must query with $in: assignedSchools
      assert(filter._id && filter._id.$in);
      assert.strictEqual(filter._id.$in.length, 1);
      return makeChainable([mockSchoolA]);
    };

    const req = {
      user: {
        _id: supervisor_Id,
        role: ROLES.SUPERVISOR,
        assignedSchools: [schoolA_Id], // Only School A assigned
      },
    };
    const res = createMockResponse();

    await handleGetTownLiveMonitor(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.length, 1);
    assert.strictEqual(res.body.data[0].schoolName, 'Liaquatabad Primary School');
  });

  await runAsyncTest('Test 31: Teacher in /my-schedule receives only their personal teaching allocations', async () => {
    const teacherScheduleEntry = {
      dayOfWeek: 'MONDAY',
      periodNumber: 1,
      teacherId: teacher1_Id,
      classId: { _id: class1_Id, name: 'Class 5' },
      sectionId: { _id: section1_Id, name: 'Section A' },
      subjectId: { _id: subject1_Id, name: 'Science' },
    };
    const otherTeacherEntry = {
      dayOfWeek: 'MONDAY',
      periodNumber: 2,
      teacherId: teacher2_Id, // Different teacher
      classId: { _id: class1_Id, name: 'Class 5' },
      sectionId: { _id: section1_Id, name: 'Section A' },
      subjectId: { _id: subject1_Id, name: 'English' },
    };

    Timetable.findOne = () => makeChainable({
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      periodSlots: standardPeriodSlots,
      schedule: [teacherScheduleEntry, otherTeacherEntry],
    });

    const req = {
      user: {
        _id: teacher1_Id,
        role: ROLES.TEACHER,
        schoolId: schoolA_Id,
      },
      query: {},
    };
    const res = createMockResponse();

    await handleGetMySchedule(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.mySchedule.length, 1);
    assert.strictEqual(String(res.body.data.mySchedule[0].teacherId), String(teacher1_Id));
  });

  await runAsyncTest('Test 32: Student in /my-schedule receives only their class/section allocations', async () => {
    StudentProfile.findOne = () => makeChainable({
      userId: student_Id,
      schoolId: schoolA_Id,
      classId: class1_Id,
      sectionId: section1_Id,
    });

    const mySectionEntry = {
      dayOfWeek: 'MONDAY',
      periodNumber: 1,
      classId: { _id: class1_Id },
      sectionId: { _id: section1_Id },
      subjectId: { _id: subject1_Id, name: 'Science' },
    };
    const otherSectionEntry = {
      dayOfWeek: 'MONDAY',
      periodNumber: 1,
      classId: { _id: class1_Id },
      sectionId: { _id: new mongoose.Types.ObjectId() }, // Section B
      subjectId: { _id: subject1_Id, name: 'Science' },
    };

    Timetable.findOne = () => makeChainable({
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      periodSlots: standardPeriodSlots,
      schedule: [mySectionEntry, otherSectionEntry],
    });

    const req = {
      user: {
        _id: student_Id,
        role: ROLES.STUDENT,
      },
      query: {},
    };
    const res = createMockResponse();

    await handleGetMySchedule(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.mySchedule.length, 1);
    assert.strictEqual(String(res.body.data.mySchedule[0].sectionId._id), String(section1_Id));
  });

  await runAsyncTest('Test 33: Parent CHILD scope: Unverified parent link denied access with 403', async () => {
    ParentStudentLink.findOne = () => makeChainable(null); // No verified parent link

    const req = {
      user: {
        _id: parent_Id,
        role: ROLES.PARENT,
      },
      query: { studentId: student_Id.toString() },
    };
    const res = createMockResponse();

    await handleGetMySchedule(req, res);

    assert.strictEqual(res.statusCode, 403);
    assert(res.body.message.includes('verified parental link'));
  });

  await runAsyncTest('Test 34: Parent CHILD scope: Verified parent receives linked ward timetable', async () => {
    ParentStudentLink.findOne = () => makeChainable({
      parentId: parent_Id,
      studentId: student_Id,
      status: PARENT_STUDENT_LINK_STATUS.VERIFIED,
    });

    StudentProfile.findOne = () => makeChainable({
      _id: student_Id,
      userId: student_Id,
      schoolId: schoolA_Id,
      classId: class1_Id,
      sectionId: section1_Id,
    });

    Timetable.findOne = () => makeChainable({
      schoolId: schoolA_Id,
      academicYear: '2025-2026',
      periodSlots: standardPeriodSlots,
      schedule: [
        {
          dayOfWeek: 'MONDAY',
          periodNumber: 1,
          classId: { _id: class1_Id },
          sectionId: { _id: section1_Id },
          subjectId: { _id: subject1_Id, name: 'Mathematics' },
        },
      ],
    });

    const req = {
      user: {
        _id: parent_Id,
        role: ROLES.PARENT,
      },
      query: { studentId: student_Id.toString() },
    };
    const res = createMockResponse();

    await handleGetMySchedule(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.wardSchedule.length, 1);
  });

  await runAsyncTest('Test 35: Malformed payload / invalid ObjectId in timetable parameters returns 400', async () => {
    const req = {
      params: { schoolId: 'not-an-objectid-123' },
      query: {},
    };
    const res = createMockResponse();

    await handleGetSchoolTimetable(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.message, 'Invalid school ID format.');
  });

  console.log('\n======================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} TIMETABLE ENGINE ASSERTIONS PASSED (100%)`);
  console.log('======================================================================\n');
}

executeTestSuite().catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
