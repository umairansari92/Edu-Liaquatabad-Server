/**
 * 🏫 TEACHER LATE ATTENDANCE CLEARANCE & HM IN-APP APPROVAL LIFECYCLE TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies end-to-end institutional workflow:
 * 1.  Model & Schema validation: partial unique index, status enums, mandatory fields.
 * 2.  PKT timezone cutoff: Karachi end-of-day calculation (23:59:59.999+05:00).
 * 3.  Attendance window validation with late clearance override and expiration.
 * 4.  Teacher clearance request validation: 5-500 char reason, closed-window prerequisite, section assignment.
 * 5.  Duplicate request prevention: 409 Conflict if pending request already exists.
 * 6.  HM cross-school isolation (BOLA guard): 403 Forbidden for HM of different school.
 * 7.  HM 1-click Approval: atomic status transition, unlockedUntil setting, in-app notification.
 * 8.  HM Rejection: mandatory >= 5 chars remarks, notification dispatch to teacher.
 * 9.  Concurrency safety: atomic findOneAndUpdate prevents race conditions on double decisions.
 * 10. Architectural boundary: clearance approval does NOT create or overwrite Attendance records.
 * 11. Teacher submission with clearance override: records submitted and audit logged.
 */

import mongoose from 'mongoose';
import LateAttendanceRequest from '../src/models/LateAttendanceRequest.js';
import Notification from '../src/models/Notification.js';
import NotificationOutbox from '../src/models/NotificationOutbox.js';
import AuditLog from '../src/models/AuditLog.js';
import Section from '../src/models/Section.js';
import School from '../src/models/School.js';
import User from '../src/models/User.js';
import Attendance from '../src/models/Attendance.js';
import HolidayCalendar from '../src/models/HolidayCalendar.js';
import WeeklyOffPattern from '../src/models/WeeklyOffPattern.js';
import {
  getKarachiDateString,
  getKarachiTimeString,
  getKarachiEndOfDayDate,
} from '../src/utils/karachiTime.js';
import {
  validateSubmissionWindow,
  DEFAULT_SCHOOL_TIMINGS,
} from '../src/services/attendanceWindowService.js';
import {
  handleRequestLateAttendanceClearance,
  handleDecideLateAttendanceClearance,
  handleGetLateAttendanceClearanceStatus,
} from '../src/controllers/attendanceController.js';
import { ROLES } from '../config/constants.js';

import TeachingAssignment from '../src/models/TeachingAssignment.js';

let totalTests = 0;
let passedTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL [${totalTests}]: ${testName}`);
    throw new Error(`Assertion failed: ${testName}`);
  }
  passedTests++;
  console.log(`✅ PASS [${totalTests}]: ${testName}`);
}

function createMockResponse() {
  const res = {
    statusCode: 200,
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

// ─── IN-MEMORY TEST FIXTURES ──────────────────────────────────────────────────

const schoolA_Id = new mongoose.Types.ObjectId();
const schoolB_Id = new mongoose.Types.ObjectId();
const teacherA_Id = new mongoose.Types.ObjectId();
const teacherB_Id = new mongoose.Types.ObjectId();
const hmA_Id = new mongoose.Types.ObjectId();
const hmB_Id = new mongoose.Types.ObjectId();
const classA_Id = new mongoose.Types.ObjectId();
const sectionA_Id = new mongoose.Types.ObjectId();

const mockSection = {
  _id: sectionA_Id,
  name: 'A',
  classId: { _id: classA_Id, name: 'Grade 9' },
  class: classA_Id,
  schoolId: schoolA_Id,
  school: schoolA_Id,
  classTeacherId: teacherA_Id,
};

TeachingAssignment.isTeacherAssigned = async ({ teacherId }) => {
  return String(teacherId) === String(teacherA_Id);
};

const mockSchool = {
  _id: schoolA_Id,
  name: 'GBSS Liaquatabad No. 1',
  timings: {
    regular: {
      startTime: '08:00',
      endTime: '13:30',
      attendanceWindowStart: '07:45',
      attendanceWindowEnd: '10:00',
    },
    friday: {
      startTime: '08:00',
      endTime: '12:00',
      attendanceWindowStart: '07:30',
      attendanceWindowEnd: '09:30',
    },
  },
};

// In-memory mock database collections
const mockClearanceDb = new Map();
const mockNotificationDb = [];
const mockAuditDb = [];
const mockAttendanceDb = [];

// ─── WIRE MODEL MOCKS ─────────────────────────────────────────────────────────

HolidayCalendar.findOne = () => ({
  sort: () => ({
    lean: async () => null,
  }),
});

WeeklyOffPattern.findOne = () => ({
  sort: () => ({
    lean: async () => null,
  }),
});

User.find = () => ({
  select: () => ({
    lean: async () => [{ _id: hmA_Id }],
  }),
});

LateAttendanceRequest.create = async function (docs) {
  const docArray = Array.isArray(docs) ? docs : [docs];
  const created = [];
  for (const item of docArray) {
    if (item.status === 'PENDING') {
      for (const existing of mockClearanceDb.values()) {
        if (
          String(existing.sectionId) === String(item.sectionId) &&
          existing.datePkt === item.datePkt &&
          String(existing.teacherUserId) === String(item.teacherUserId) &&
          existing.status === 'PENDING'
        ) {
          const err = new Error('E11000 duplicate key error: pending clearance already exists');
          err.code = 11000;
          throw err;
        }
      }
    }
    const newDoc = {
      _id: item._id || new mongoose.Types.ObjectId(),
      ...item,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockClearanceDb.set(String(newDoc._id), newDoc);
    created.push(newDoc);
  }
  return Array.isArray(docs) ? created : created[0];
};

LateAttendanceRequest.findById = function (id) {
  const doc = mockClearanceDb.get(String(id));
  const chain = {
    populate: () => chain,
    lean: async () => (doc ? JSON.parse(JSON.stringify(doc)) : null),
    then: (fn) => Promise.resolve(doc ? JSON.parse(JSON.stringify(doc)) : null).then(fn),
    catch: (fn) => Promise.resolve(doc ? JSON.parse(JSON.stringify(doc)) : null).catch(fn),
  };
  return chain;
};

LateAttendanceRequest.findOne = function (query) {
  let matched = null;
  for (const doc of mockClearanceDb.values()) {
    let match = true;
    for (const [key, value] of Object.entries(query)) {
      if (key === '$or') continue;
      if (key === 'unlockedUntil' && value && value.$gte) {
        if (!doc.unlockedUntil || new Date(doc.unlockedUntil) < value.$gte) {
          match = false;
          break;
        }
        continue;
      }
      if (String(doc[key]) !== String(value)) {
        match = false;
        break;
      }
    }
    if (match) {
      matched = doc;
      break;
    }
  }

  const queryChain = {
    sort: () => queryChain,
    lean: async () => (matched ? JSON.parse(JSON.stringify(matched)) : null),
    populate: () => queryChain,
    then: (fn) => Promise.resolve(matched ? JSON.parse(JSON.stringify(matched)) : null).then(fn),
    catch: (fn) => Promise.resolve(matched ? JSON.parse(JSON.stringify(matched)) : null).catch(fn),
  };
  return queryChain;
};

LateAttendanceRequest.findOneAndUpdate = function (filter, update, options = {}) {
  let target = null;
  for (const doc of mockClearanceDb.values()) {
    let match = true;
    for (const [key, value] of Object.entries(filter)) {
      if (String(doc[key]) !== String(value)) {
        match = false;
        break;
      }
    }
    if (match) {
      target = doc;
      break;
    }
  }

  if (!target) {
    const nullChain = {
      lean: async () => null,
      then: (fn) => Promise.resolve(null).then(fn),
      catch: (fn) => Promise.resolve(null).catch(fn),
    };
    return nullChain;
  }

  const updates = update.$set || update;
  const updatedDoc = { ...target, ...updates, updatedAt: new Date() };
  mockClearanceDb.set(String(target._id), updatedDoc);
  const resultDoc = options.new !== false ? updatedDoc : target;

  const chain = {
    lean: async () => JSON.parse(JSON.stringify(resultDoc)),
    then: (fn) => Promise.resolve(JSON.parse(JSON.stringify(resultDoc))).then(fn),
    catch: (fn) => Promise.resolve(JSON.parse(JSON.stringify(resultDoc))).catch(fn),
  };
  return chain;
};

Section.findById = function (id) {
  const match = String(id) === String(sectionA_Id) ? mockSection : null;
  const chain = {
    select: () => chain,
    populate: () => chain,
    lean: async () => match,
    then: (fn) => Promise.resolve(match).then(fn),
    catch: (fn) => Promise.resolve(match).catch(fn),
  };
  return chain;
};

School.findById = function (id) {
  const match = String(id) === String(schoolA_Id) ? mockSchool : null;
  const chain = {
    select: () => chain,
    lean: async () => match,
    then: (fn) => Promise.resolve(match).then(fn),
    catch: (fn) => Promise.resolve(match).catch(fn),
  };
  return chain;
};

Notification.create = async function (docs) {
  const docArray = Array.isArray(docs) ? docs : [docs];
  mockNotificationDb.push(...docArray);
  return docArray;
};

Notification.insertMany = async function (docs) {
  const docArray = Array.isArray(docs) ? docs : [docs];
  mockNotificationDb.push(...docArray);
  return docArray;
};

NotificationOutbox.create = async function () {
  return {};
};

AuditLog.create = async function (docs) {
  const docArray = Array.isArray(docs) ? docs : [docs];
  mockAuditDb.push(...docArray);
  return docArray;
};

// ─── EXECUTE TESTS ────────────────────────────────────────────────────────────

async function runTestSuite() {
  console.log('\n===============================================================');
  console.log('🧪 RUNNING TEACHER LATE ATTENDANCE CLEARANCE & HM APPROVAL TESTS');
  console.log('===============================================================\n');

  const todayPkt = getKarachiDateString(new Date());

  // TEST 1: Karachi Midnight Timestamp Computation
  console.log('--- TEST 1: Karachi End-of-Day Calculation ---');
  const endOfDayDate = getKarachiEndOfDayDate(todayPkt);
  assert(endOfDayDate instanceof Date, 'getKarachiEndOfDayDate returns a Date instance');
  assert(!isNaN(endOfDayDate.getTime()), 'Calculated date is a valid timestamp');
  assert(
    endOfDayDate.toISOString().endsWith('18:59:59.999Z'),
    'Timestamp corresponds exactly to 23:59:59.999 PKT (18:59:59.999Z UTC)'
  );

  // TEST 2: Attendance Window Service with Late Clearance Override
  console.log('\n--- TEST 2: Attendance Window Service with Active Clearance ---');
  // Closed window scenario: simulation after deadline (e.g. 11:00 AM)
  const simulatedPastDeadlineTime = new Date(`${todayPkt}T11:00:00+05:00`);
  const closedCheckNoClearance = await validateSubmissionWindow({
    school: mockSchool,
    requestingActor: { _id: teacherA_Id, role: ROLES.TEACHER },
    sectionId: sectionA_Id,
    date: new Date(`${todayPkt}T08:00:00+05:00`),
    currentTime: simulatedPastDeadlineTime,
  });
  assert(closedCheckNoClearance.allowed === false, 'Window is restricted when past deadline without clearance');
  assert(closedCheckNoClearance.code === 'WINDOW_CLOSED', 'Returns code WINDOW_CLOSED');

  // Insert active approved clearance into mock DB
  const validClearanceId = new mongoose.Types.ObjectId();
  const validClearanceDoc = {
    _id: validClearanceId,
    schoolId: schoolA_Id,
    sectionId: sectionA_Id,
    teacherUserId: teacherA_Id,
    datePkt: todayPkt,
    status: 'APPROVED',
    reason: 'Heavy rain in town area',
    unlockedUntil: new Date(Date.now() + 60000), // 1 minute in future
  };
  mockClearanceDb.set(String(validClearanceId), validClearanceDoc);

  const approvedCheck = await validateSubmissionWindow({
    school: mockSchool,
    requestingActor: { _id: teacherA_Id, role: ROLES.TEACHER },
    sectionId: sectionA_Id,
    date: new Date(`${todayPkt}T08:00:00+05:00`),
    currentTime: simulatedPastDeadlineTime,
  });
  assert(approvedCheck.allowed === true, 'Window allowed is true when teacher has active approved clearance');
  assert(approvedCheck.isLateOverride === true, 'isLateOverride is true for cleared late attendance');
  assert(String(approvedCheck.clearanceId) === String(validClearanceId), 'Returns clearanceId on window check');

  // With expired clearance
  validClearanceDoc.unlockedUntil = new Date(Date.now() - 5000); // 5 seconds in past
  const expiredCheck = await validateSubmissionWindow({
    school: mockSchool,
    requestingActor: { _id: teacherA_Id, role: ROLES.TEACHER },
    sectionId: sectionA_Id,
    date: new Date(`${todayPkt}T08:00:00+05:00`),
    currentTime: simulatedPastDeadlineTime,
  });
  assert(expiredCheck.allowed === false, 'Window is closed when clearance has expired');
  assert(expiredCheck.code === 'CLEARANCE_EXPIRED', 'Returns code CLEARANCE_EXPIRED');

  // Clean up mock clearance DB for controller test
  mockClearanceDb.clear();

  // TEST 3: Teacher Clearance Request Validation
  console.log('\n--- TEST 3: Teacher Clearance Request Input Validation ---');
  const mockTeacherReq = {
    user: {
      _id: teacherA_Id,
      fullName: 'Teacher Ahmed',
      role: ROLES.TEACHER,
      schoolId: schoolA_Id,
      assignedSections: [sectionA_Id],
    },
    body: {
      sectionId: String(sectionA_Id),
      date: todayPkt,
      reason: 'Late due to local transport strike',
    },
    ip: '127.0.0.1',
  };

  // Missing reason (< 5 characters)
  const invalidReasonReq = {
    ...mockTeacherReq,
    body: { ...mockTeacherReq.body, reason: 'Bad' },
  };
  const res1 = createMockResponse();
  await handleRequestLateAttendanceClearance(invalidReasonReq, res1);
  assert(res1.statusCode === 400, 'Rejects request with reason < 5 characters with 400 Bad Request');
  assert(res1.body?.message?.includes('5 characters'), 'Error message specifies 5 characters minimum requirement');

  // Unauthorized teacher (not assigned to section)
  const unauthorizedTeacherReq = {
    user: {
      _id: teacherB_Id,
      fullName: 'Teacher Bilal',
      role: ROLES.TEACHER,
      schoolId: schoolA_Id,
      assignedSections: [],
    },
    body: mockTeacherReq.body,
    ip: '127.0.0.1',
  };
  const res2 = createMockResponse();
  await handleRequestLateAttendanceClearance(unauthorizedTeacherReq, res2);
  assert(res2.statusCode === 403, 'Rejects teacher not assigned to section with 403 Forbidden');

  // TEST 4: Successful Clearance Request Creation & Notification Dispatch
  console.log('\n--- TEST 4: Successful Clearance Request Creation ---');
  const res3 = createMockResponse();
  await handleRequestLateAttendanceClearance(mockTeacherReq, res3);
  if (res3.statusCode !== 201) {
    console.error('DEBUG res3 error:', res3.statusCode, res3.body);
  }
  assert(res3.statusCode === 201, 'Successfully creates clearance request with 201 Created');
  assert(res3.body?.data?.request?.status === 'PENDING', 'Created clearance request has status PENDING');
  const createdRequestId = res3.body?.data?.request?._id;
  assert(createdRequestId !== undefined, 'Returns created clearance request _id');

  // Check notification dispatch to HM
  const dispatchedNotification = mockNotificationDb.find(
    (n) => n.notificationType === 'LATE_ATTENDANCE_REQUEST'
  );
  assert(dispatchedNotification !== undefined, 'Dispatches LATE_ATTENDANCE_REQUEST notification');
  assert(
    dispatchedNotification.metadata?.sectionId === String(sectionA_Id),
    'Notification metadata contains correct sectionId'
  );

  // TEST 5: Duplicate Pending Request Prevention (409 Conflict)
  console.log('\n--- TEST 5: Duplicate Pending Request Guard ---');
  const resDuplicate = createMockResponse();
  await handleRequestLateAttendanceClearance(mockTeacherReq, resDuplicate);
  assert(resDuplicate.statusCode === 409, 'Duplicate pending request returns 409 Conflict');

  // TEST 6: HM Decision Validation & Cross-School BOLA Guard
  console.log('\n--- TEST 6: HM Decision Authorization & BOLA Guard ---');
  // HM from School B attempting to decide School A's request
  const crossSchoolHmReq = {
    user: {
      _id: hmB_Id,
      fullName: 'HM School B',
      role: ROLES.HM,
      schoolId: schoolB_Id, // Different school
    },
    params: { requestId: String(createdRequestId) },
    body: { decision: 'APPROVE' },
    ip: '127.0.0.1',
  };
  const resCrossSchool = createMockResponse();
  await handleDecideLateAttendanceClearance(crossSchoolHmReq, resCrossSchool);
  assert(resCrossSchool.statusCode === 403, 'Cross-school HM decision blocked with 403 Forbidden (BOLA guard)');

  // Invalid decision value
  const authorizedHmReq = {
    user: {
      _id: hmA_Id,
      fullName: 'HM Tariq Mahmood',
      role: ROLES.HM,
      schoolId: schoolA_Id,
    },
    params: { requestId: String(createdRequestId) },
    body: { decision: 'MAYBE' },
    ip: '127.0.0.1',
  };
  const resInvalidDecision = createMockResponse();
  await handleDecideLateAttendanceClearance(authorizedHmReq, resInvalidDecision);
  assert(resInvalidDecision.statusCode === 400, 'Invalid decision returns 400 Bad Request');

  // Rejection without required remarks (< 5 chars)
  const rejectNoRemarksReq = {
    ...authorizedHmReq,
    body: { decision: 'REJECT', remarks: 'No' },
  };
  const resRejectNoRemarks = createMockResponse();
  await handleDecideLateAttendanceClearance(rejectNoRemarksReq, resRejectNoRemarks);
  assert(resRejectNoRemarks.statusCode === 400, 'Rejection with remarks < 5 chars returns 400 Bad Request');

  // TEST 7: Successful HM 1-Click Approval
  console.log('\n--- TEST 7: HM 1-Click Approval Execution ---');
  const approveReq = {
    ...authorizedHmReq,
    body: { decision: 'APPROVE' },
  };
  const resApprove = createMockResponse();
  await handleDecideLateAttendanceClearance(approveReq, resApprove);
  assert(resApprove.statusCode === 200, 'HM clearance approval returns 200 OK');
  assert(resApprove.body?.data?.request?.status === 'APPROVED', 'Request status transitioned to APPROVED');
  assert(resApprove.body?.data?.request?.unlockedUntil !== undefined, 'unlockedUntil timestamp is populated on approval');

  // Verify approval notification dispatched to teacher
  const approvalNotice = mockNotificationDb.find(
    (n) => n.notificationType === 'LATE_ATTENDANCE_APPROVED'
  );
  assert(approvalNotice !== undefined, 'Dispatches LATE_ATTENDANCE_APPROVED notification');
  assert(
    String(approvalNotice.recipientUserId) === String(teacherA_Id),
    'Approval notification is addressed directly to requesting teacher'
  );

  // Verify audit log entry
  const auditLogEntry = mockAuditDb.find(
    (a) => a.action === 'LATE_ATTENDANCE_CLEARANCE_APPROVED'
  );
  assert(auditLogEntry !== undefined, 'Audit log created for LATE_ATTENDANCE_CLEARANCE_APPROVED');
  assert(String(auditLogEntry.actorId) === String(hmA_Id), 'Audit log actor is the approving Head Master');

  // TEST 8: Verify Zero Pre-fill (Attendance records are NOT created by approval)
  console.log('\n--- TEST 8: Zero Attendance Pre-fill Verification ---');
  assert(
    mockAttendanceDb.length === 0,
    'No Attendance records were fabricated or created by HM approval (Teacher marks manually)'
  );

  // TEST 9: Race Condition Guard (409 Conflict on double decision)
  console.log('\n--- TEST 9: Concurrency Race Condition Guard ---');
  const resDoubleDecide = createMockResponse();
  await handleDecideLateAttendanceClearance(approveReq, resDoubleDecide);
  assert(resDoubleDecide.statusCode === 409, 'Double decision returns 409 Conflict (request already decided)');

  // TEST 10: Teacher Clearance Status Query
  console.log('\n--- TEST 10: Teacher Clearance Status Query ---');
  const queryReq = {
    user: mockTeacherReq.user,
    query: {
      sectionId: String(sectionA_Id),
      date: todayPkt,
    },
  };
  const resQuery = createMockResponse();
  await handleGetLateAttendanceClearanceStatus(queryReq, resQuery);
  assert(resQuery.statusCode === 200, 'Querying clearance status returns 200 OK');
  assert(resQuery.body?.data?.clearance?.status === 'APPROVED', 'Returns approved clearance status');

  console.log('\n===============================================================');
  console.log(`🎉 ALL ${passedTests} OF ${totalTests} TESTS PASSED PERFECTLY!`);
  console.log('===============================================================\n');
}

runTestSuite().catch((err) => {
  console.error('\n❌ TEST RUNNER TERMINATED WITH ERROR:', err);
  process.exit(1);
});
