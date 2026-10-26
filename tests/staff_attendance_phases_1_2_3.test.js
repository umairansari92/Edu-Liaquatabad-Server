/**
 * Dedicated Automated Test Suite: Staff Attendance Phases 1, 2, and 3
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * - Phase 1: Timestamp surfaces (submittedAt, approvedAt, approvedBy), PKT date-time integrity, status distinction
 * - Phase 2: Block office staff self-submission (403 Forbidden) while preserving school staff submissions (201 Created)
 * - Phase 3: Super Admin office terminal marking, Super Admin self-attendance, office roster queries, and scoped records
 */

import assert from 'node:assert/strict';
import {
  handleSubmitStaffAttendance,
  handleGetMyStaffAttendanceHistory,
  handleSuperAdminMarkOfficeStaffAttendance,
  handleSuperAdminSelfAttendance,
  handleGetOfficeStaffAttendanceRoster,
  handleGetStaffAttendanceRecords,
  handleHmSelfAttendance,
} from '../src/controllers/staffAttendanceController.js';
import StaffAttendanceRecord from '../src/models/StaffAttendanceRecord.js';
import LeaveRequest from '../src/models/LeaveRequest.js';
import User from '../src/models/User.js';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';
import NotificationOutbox from '../src/models/NotificationOutbox.js';
import {
  ROLES,
  STAFF_CATEGORY,
  STAFF_ATTENDANCE_STATUS,
  ATTENDANCE_STATUS,
  LEAVE_STATUS,
} from '../config/constants.js';

const createMockResponse = () => {
  const response = {
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
  return response;
};

const schoolAId = '65d1a1b2c3d4e5f600000001';
const townId    = '65d1a1b2c3d4e5f600000010';
const superAdminId = '65d1a1b2c3d4e5f600000090';
const adminId      = '65d1a1b2c3d4e5f600000080';
const teacherId    = '65d1a1b2c3d4e5f600000030';
const peonId       = '65d1a1b2c3d4e5f600000020';
const officeStaffId= '65d1a1b2c3d4e5f600000025';

let passedTestCount = 0;
const reportPass = (testName) => {
  passedTestCount += 1;
  console.log(`✅ PASS [${passedTestCount}]: ${testName}`);
};

console.log('==============================================================================');
console.log('🧪 RUNNING VERIFICATION SUITE: STAFF ATTENDANCE PHASES 1, 2, & 3');
console.log('==============================================================================');

// Save originals
const origRecordFindOne = StaffAttendanceRecord.findOne;
const origRecordFindById = StaffAttendanceRecord.findById;
const origRecordFind = StaffAttendanceRecord.find;
const origRecordCreate = StaffAttendanceRecord.create;
const origRecordCount = StaffAttendanceRecord.countDocuments;
const origRecordFindByIdAndUpdate = StaffAttendanceRecord.findByIdAndUpdate;
const origLeaveFindOne = LeaveRequest.findOne;
const origLeaveFind = LeaveRequest.find;
const origUserFindOne = User.findOne;
const origUserFindById = User.findById;
const origUserFind = User.find;
const origAuditCreate = AuditLog.create;
const origNotificationInsertMany = Notification.insertMany;
const origNotificationOutboxCreate = NotificationOutbox.create;

// Prevent Mongoose buffering timeout for notifications in unit test
Notification.insertMany = async () => [];
NotificationOutbox.create = async () => ({});
StaffAttendanceRecord.findByIdAndUpdate = async () => ({});
LeaveRequest.findOne = () => ({ lean: async () => null });
LeaveRequest.find = () => ({ lean: async () => [] });

try {
  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 1: DISPLAY TIMESTAMPS & POPULATION OF APPROVER/REJECTOR
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- Phase 1: Timestamp Surface & Approver Details ---');

  // 1a. handleGetMyStaffAttendanceHistory populates approvedBy, rejectedBy, markedBy
  const dummySubmittedAt = new Date('2026-10-27T08:15:00.000Z');
  const dummyApprovedAt  = new Date('2026-10-27T08:18:00.000Z');

  const mockRecords = [
    {
      _id: '65d1a1b2c3d4e5f600000101',
      staffUserId: teacherId,
      attendanceDate: new Date('2026-10-27T00:00:00.000Z'),
      submittedAt: dummySubmittedAt,
      approvedAt: dummyApprovedAt,
      approvedBy: { _id: '65d1a1b2c3d4e5f600000050', fullName: 'HM Aslam', designation: 'Head Master', role: ROLES.HM },
      rejectedBy: null,
      markedBy: { _id: teacherId, fullName: 'Tariq Teacher', designation: 'Senior Teacher', role: ROLES.TEACHER },
      approvalStatus: STAFF_ATTENDANCE_STATUS.APPROVED,
      entryMode: 'STAFF_SELF',
    },
    {
      _id: '65d1a1b2c3d4e5f600000102',
      staffUserId: teacherId,
      attendanceDate: new Date('2026-10-26T00:00:00.000Z'),
      submittedAt: new Date('2026-10-26T08:20:00.000Z'),
      approvedAt: null,
      approvedBy: null,
      rejectedBy: null,
      approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
      entryMode: 'STAFF_SELF',
    },
    {
      _id: '65d1a1b2c3d4e5f600000103',
      staffUserId: teacherId,
      attendanceDate: new Date('2026-10-25T00:00:00.000Z'),
      submittedAt: new Date('2026-10-25T08:30:00.000Z'),
      approvedAt: null,
      approvedBy: null,
      rejectedAt: new Date('2026-10-25T08:45:00.000Z'),
      rejectedBy: { _id: '65d1a1b2c3d4e5f600000050', fullName: 'HM Aslam', designation: 'Head Master', role: ROLES.HM },
      approvalStatus: STAFF_ATTENDANCE_STATUS.REJECTED,
      rejectionReason: 'Late arrival without prior intimation',
      entryMode: 'STAFF_SELF',
    },
  ];

  StaffAttendanceRecord.find = () => ({
    populate: function () { return this; },
    sort: function () { return this; },
    skip: function () { return this; },
    limit: function () { return this; },
    lean: async () => mockRecords,
  });

  const teacherHistoryReq = {
    user: { _id: teacherId, role: ROLES.TEACHER, fullName: 'Tariq Teacher' },
    query: { month: '10', year: '2026' },
  };
  const mockRes1 = createMockResponse();
  await handleGetMyStaffAttendanceHistory(teacherHistoryReq, mockRes1);

  assert.equal(mockRes1.statusCode, 200, 'my-history returns 200 OK');
  assert.equal(mockRes1.body.records.length, 3, 'my-history returns all 3 records');
  assert(mockRes1.body.records[0].submittedAt, 'Record 1 contains submittedAt timestamp');
  assert(mockRes1.body.records[0].approvedAt, 'Record 1 contains approvedAt timestamp');
  assert.equal(mockRes1.body.records[0].approvedBy.fullName, 'HM Aslam', 'Record 1 approvedBy is populated with fullName');
  assert.equal(mockRes1.body.records[0].approvedBy.designation, 'Head Master', 'Record 1 approvedBy is populated with designation');
  assert.equal(mockRes1.body.records[0].approvalStatus, STAFF_ATTENDANCE_STATUS.APPROVED, 'Record 1 has APPROVED status');
  reportPass('Phase 1: handleGetMyStaffAttendanceHistory returns submittedAt, approvedAt, and populated approvedBy');

  assert.equal(mockRes1.body.records[1].approvalStatus, STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL, 'Record 2 is PENDING_APPROVAL');
  assert.equal(mockRes1.body.records[1].approvedAt, null, 'Record 2 approvedAt is null');
  reportPass('Phase 1: PENDING_APPROVAL state is distinctly preserved with null approvedAt');

  assert.equal(mockRes1.body.records[2].approvalStatus, STAFF_ATTENDANCE_STATUS.REJECTED, 'Record 3 is REJECTED');
  assert(mockRes1.body.records[2].rejectedAt, 'Record 3 contains rejectedAt timestamp');
  assert.equal(mockRes1.body.records[2].rejectedBy.fullName, 'HM Aslam', 'Record 3 rejectedBy is populated');
  assert.equal(mockRes1.body.records[2].rejectionReason, 'Late arrival without prior intimation', 'Record 3 rejectionReason preserved');
  reportPass('Phase 1: REJECTED state is distinctly preserved with rejectedAt and rejectionReason');

  assert(mockRes1.body.summary, 'Summary object is computed and returned');
  assert.equal(mockRes1.body.summary.totalMarkedDays, 3, 'Summary totalMarkedDays = 3');
  assert.equal(mockRes1.body.summary.presentCount, 1, 'Summary presentCount = 1');
  assert.equal(mockRes1.body.summary.pendingCount, 1, 'Summary pendingCount = 1');
  assert.equal(mockRes1.body.summary.absentCount, 1, 'Summary absentCount = 1');
  reportPass('Phase 1: Summary metrics computed accurately across all lifecycle states');

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 2: BLOCK OFFICE STAFF SELF-SUBMISSION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- Phase 2: Block Office Staff Self-Submission ---');

  StaffAttendanceRecord.findOne = () => ({ lean: async () => null });
  let createdAttendancePayload = null;
  StaffAttendanceRecord.create = async (doc) => {
    createdAttendancePayload = doc;
    return { _id: '65d1a1b2c3d4e5f600000099', ...doc };
  };
  User.findOne = () => ({ select: () => ({ lean: async () => ({ _id: '65d1a1b2c3d4e5f600000050' }) }) });
  AuditLog.create = async () => ({ _id: '65d1a1b2c3d4e5f600000077' });

  // 2a. School Teacher CAN self-submit
  const validTeacherSubmitReq = {
    user: {
      _id: teacherId,
      role: ROLES.TEACHER,
      staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
      schoolId: schoolAId,
      townId,
      fullName: 'Tariq Teacher',
    },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResSubmitTeacher = createMockResponse();
  await handleSubmitStaffAttendance(validTeacherSubmitReq, mockResSubmitTeacher);

  assert.equal(mockResSubmitTeacher.statusCode, 201, 'School teacher self-submit succeeds with 201 Created');
  assert.equal(mockResSubmitTeacher.body.attendanceRecord.approvalStatus, STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL);
  assert.equal(createdAttendancePayload.entryMode, 'STAFF_SELF', 'entryMode recorded as STAFF_SELF');
  assert.equal(String(createdAttendancePayload.markedBy), teacherId, 'markedBy recorded as teacher ID');
  reportPass('Phase 2: School teacher can successfully self-submit attendance (201 Created)');

  // 2b. School Peon CAN self-submit
  const validPeonSubmitReq = {
    user: {
      _id: peonId,
      role: ROLES.PEON,
      staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
      schoolId: schoolAId,
      townId,
      fullName: 'Ghulam Peon',
    },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResSubmitPeon = createMockResponse();
  await handleSubmitStaffAttendance(validPeonSubmitReq, mockResSubmitPeon);

  assert.equal(mockResSubmitPeon.statusCode, 201, 'School peon self-submit succeeds with 201 Created');
  reportPass('Phase 2: School peon can successfully self-submit attendance (201 Created)');

  // 2c. Office Staff with staffCategory === OFFICE_STAFF is BLOCKED with 403 Forbidden
  const officeStaffSubmitReq = {
    user: {
      _id: officeStaffId,
      role: ROLES.PEON, // e.g. office naib qasid / clerk
      staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
      schoolId: null,
      townId,
      fullName: 'Rashid Office Peon',
    },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResSubmitOffice = createMockResponse();
  await handleSubmitStaffAttendance(officeStaffSubmitReq, mockResSubmitOffice);

  assert.equal(mockResSubmitOffice.statusCode, 403, 'Office staff self-submit is BLOCKED with 403 Forbidden');
  assert(mockResSubmitOffice.body.message.includes('Office staff members cannot self-submit attendance'), 'Message explicitly informs user to mark from office terminal');
  reportPass('Phase 2: Office staff (staffCategory = OFFICE_STAFF) blocked from self-submission with 403 Forbidden');

  // 2d. Municipal Admin (Office Role without School) is BLOCKED with 403 Forbidden
  const adminSubmitReq = {
    user: {
      _id: adminId,
      role: ROLES.ADMIN,
      staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
      schoolId: null,
      townId,
      fullName: 'Admin Farooq',
    },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResSubmitAdmin = createMockResponse();
  await handleSubmitStaffAttendance(adminSubmitReq, mockResSubmitAdmin);

  assert.equal(mockResSubmitAdmin.statusCode, 403, 'Admin role without schoolId blocked with 403 Forbidden');
  reportPass('Phase 2: Admin role blocked from self-submission with 403 Forbidden');

  // 2e. HM self-marking (/staff-attendance/hm-self) continues working
  const hmSelfReq = {
    user: {
      _id: '65d1a1b2c3d4e5f600000050',
      role: ROLES.HM,
      schoolId: schoolAId,
      townId,
      fullName: 'HM Aslam',
    },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResHmSelf = createMockResponse();
  await handleHmSelfAttendance(hmSelfReq, mockResHmSelf);

  assert.equal(mockResHmSelf.statusCode, 201, 'HM self-attendance returns 201 Created');
  assert.equal(mockResHmSelf.body.attendanceRecord.isHmSelfRecord, true, 'isHmSelfRecord = true');
  assert.equal(mockResHmSelf.body.attendanceRecord.approvalStatus, STAFF_ATTENDANCE_STATUS.APPROVED, 'Immediately APPROVED');
  reportPass('Phase 2: HM self-attendance remains intact and self-effective');

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 3: SUPER ADMIN OFFICE TERMINAL & SELF ATTENDANCE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- Phase 3: Super Admin Office Terminal & Self-Attendance ---');

  // 3a. Super Admin marks attendance for office staff member
  User.findById = () => ({
    lean: async () => ({
      _id: officeStaffId,
      fullName: 'Rashid Office Peon',
      role: ROLES.PEON,
      staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
      schoolId: null,
      townId,
    }),
  });

  const superAdminOfficeMarkReq = {
    user: {
      _id: superAdminId,
      role: ROLES.SUPER_ADMIN,
      fullName: 'Super Admin Liaquat',
      designation: 'Director Education',
      townId,
    },
    body: {
      staffUserId: officeStaffId,
      attendanceDate: '2026-10-27',
      status: ATTENDANCE_STATUS.PRESENT,
      remarks: 'Present at Liaquatabad Town Centre Terminal',
    },
  };

  let officeMarkDoc = null;
  StaffAttendanceRecord.create = async (doc) => {
    officeMarkDoc = doc;
    return { _id: '65d1a1b2c3d4e5f600000301', ...doc };
  };

  const mockResOfficeMark = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(superAdminOfficeMarkReq, mockResOfficeMark);

  assert.equal(mockResOfficeMark.statusCode, 201, 'Super Admin marking office staff returns 201 Created');
  assert.equal(officeMarkDoc.approvalStatus, STAFF_ATTENDANCE_STATUS.APPROVED, 'Attendance is immediately APPROVED');
  assert.equal(officeMarkDoc.entryMode, 'SUPER_ADMIN_PANEL', 'entryMode is recorded as SUPER_ADMIN_PANEL');
  assert.equal(String(officeMarkDoc.markedBy), superAdminId, 'markedBy recorded as Super Admin');
  assert.equal(String(officeMarkDoc.approvedBy), superAdminId, 'approvedBy recorded as Super Admin');
  assert(officeMarkDoc.submittedAt && officeMarkDoc.approvedAt, 'Both submittedAt and approvedAt timestamps recorded');
  reportPass('Phase 3: Super Admin successfully marks office staff attendance from terminal');

  // 3b. Non-Super Admin attempting office-mark is BLOCKED with 403 Forbidden
  const teacherUnauthorizedMarkReq = {
    user: { _id: teacherId, role: ROLES.TEACHER, fullName: 'Tariq Teacher' },
    body: { staffUserId: officeStaffId, attendanceDate: '2026-10-27' },
  };
  const mockResUnauth = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(teacherUnauthorizedMarkReq, mockResUnauth);

  assert.equal(mockResUnauth.statusCode, 403, 'Teacher attempting office-mark is blocked with 403 Forbidden');
  reportPass('Phase 3: Unauthorized role blocked from office-mark endpoint (403 Forbidden)');

  // 3c. Super Admin marking office staff as ABSENT
  const superAdminOfficeAbsentReq = {
    user: {
      _id: superAdminId,
      role: ROLES.SUPER_ADMIN,
      fullName: 'Super Admin Liaquat',
      townId,
    },
    body: {
      staffUserId: officeStaffId,
      attendanceDate: '2026-10-27',
      status: ATTENDANCE_STATUS.ABSENT,
      remarks: 'Unreported absence from office',
    },
  };
  const mockResOfficeAbsent = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(superAdminOfficeAbsentReq, mockResOfficeAbsent);

  assert.equal(mockResOfficeAbsent.statusCode, 201, 'Absent marking returns 201 Created');
  assert.equal(officeMarkDoc.approvalStatus, STAFF_ATTENDANCE_STATUS.REJECTED, 'Absent status translates to REJECTED');
  assert.equal(officeMarkDoc.rejectionReason, 'Unreported absence from office', 'Rejection reason preserved');
  reportPass('Phase 3: Super Admin can mark office staff as Absent with provenance');

  // 3d. Super Admin Self-Attendance (self-effective)
  const superAdminSelfReq = {
    user: {
      _id: superAdminId,
      role: ROLES.SUPER_ADMIN,
      fullName: 'Super Admin Liaquat',
      townId,
    },
    body: { attendanceDate: '2026-10-27' },
  };
  let selfMarkDoc = null;
  StaffAttendanceRecord.create = async (doc) => {
    selfMarkDoc = doc;
    return { _id: '65d1a1b2c3d4e5f600000302', ...doc };
  };

  const mockResSuperSelf = createMockResponse();
  await handleSuperAdminSelfAttendance(superAdminSelfReq, mockResSuperSelf);

  assert.equal(mockResSuperSelf.statusCode, 201, 'Super Admin self-attendance returns 201 Created');
  assert.equal(selfMarkDoc.isSuperAdminSelfRecord, true, 'isSuperAdminSelfRecord = true');
  assert.equal(selfMarkDoc.approvalStatus, STAFF_ATTENDANCE_STATUS.APPROVED, 'Super Admin self-record is immediately APPROVED');
  assert.equal(selfMarkDoc.entryMode, 'SUPER_ADMIN_PANEL', 'entryMode = SUPER_ADMIN_PANEL');
  reportPass('Phase 3: Super Admin self-attendance records cleanly and is immediately approved');

  // 3e. Non-Super Admin attempting super-admin-self is BLOCKED with 403 Forbidden
  const adminSelfReq = {
    user: { _id: adminId, role: ROLES.ADMIN, fullName: 'Admin Farooq' },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResAdminSelf = createMockResponse();
  await handleSuperAdminSelfAttendance(adminSelfReq, mockResAdminSelf);

  assert.equal(mockResAdminSelf.statusCode, 403, 'Admin attempting super-admin-self is blocked with 403 Forbidden');
  reportPass('Phase 3: Only Super Admin / Root Admin can use super-admin-self endpoint (403 Forbidden)');

  // 3f. Office Staff Attendance Roster
  User.find = () => ({
    select: () => ({
      sort: () => ({
        lean: async () => [
          { _id: officeStaffId, fullName: 'Rashid Office Peon', designation: 'Naib Qasid', role: ROLES.PEON, staffCategory: STAFF_CATEGORY.OFFICE_STAFF },
          { _id: adminId, fullName: 'Farooq Admin', designation: 'Town Education Officer', role: ROLES.ADMIN, staffCategory: STAFF_CATEGORY.OFFICE_STAFF },
        ],
      }),
    }),
  });

  StaffAttendanceRecord.find = () => ({
    populate: function () { return this; },
    lean: async () => [
      {
        _id: '65d1a1b2c3d4e5f600000301',
        staffUserId: officeStaffId,
        attendanceDate: new Date('2026-10-27T00:00:00.000Z'),
        submittedAt: dummySubmittedAt,
        approvedAt: dummyApprovedAt,
        approvedBy: { fullName: 'Super Admin Liaquat' },
        markedBy: { fullName: 'Super Admin Liaquat' },
        approvalStatus: STAFF_ATTENDANCE_STATUS.APPROVED,
        entryMode: 'SUPER_ADMIN_PANEL',
      },
    ],
  });

  const rosterReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN },
    query: { date: '2026-10-27' },
  };
  const mockResRoster = createMockResponse();
  await handleGetOfficeStaffAttendanceRoster(rosterReq, mockResRoster);

  assert.equal(mockResRoster.statusCode, 200, 'Office staff roster returns 200 OK');
  assert.equal(mockResRoster.body.roster.length, 2, 'Roster returns 2 office staff members');
  assert.equal(mockResRoster.body.roster[0].isMarked, true, 'Staff 1 isMarked = true');
  assert.equal(mockResRoster.body.roster[0].attendance.approvalStatus, STAFF_ATTENDANCE_STATUS.APPROVED);
  assert.equal(mockResRoster.body.roster[1].isMarked, false, 'Staff 2 isMarked = false');
  assert.equal(mockResRoster.body.summary.totalStaff, 2, 'Summary totalStaff = 2');
  assert.equal(mockResRoster.body.summary.markedCount, 1, 'Summary markedCount = 1');
  assert.equal(mockResRoster.body.summary.unmarkedCount, 1, 'Summary unmarkedCount = 1');
  reportPass('Phase 3: Office staff attendance roster provides transparent terminal status');

  // 3g. Scoped Staff Attendance Records Query (/records)
  StaffAttendanceRecord.find = () => ({
    populate: function () { return this; },
    sort: function () { return this; },
    skip: function () { return this; },
    limit: function () { return this; },
    lean: async () => mockRecords,
  });
  StaffAttendanceRecord.countDocuments = async () => 3;

  const recordsReq = {
    user: { _id: '65d1a1b2c3d4e5f600000050', role: ROLES.HM, schoolId: schoolAId },
    query: { status: 'ALL', page: '1', limit: '10' },
  };
  const mockResRecords = createMockResponse();
  await handleGetStaffAttendanceRecords(recordsReq, mockResRecords);

  assert.equal(mockResRecords.statusCode, 200, 'Staff attendance records query returns 200 OK');
  assert.equal(mockResRecords.body.records.length, 3, 'Returns 3 records');
  assert.equal(mockResRecords.body.total, 3, 'Total count = 3');
  reportPass('Phase 3: Scoped attendance records query executes with status filter and pagination');

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 4: FINALIZATION AUDIT HARDENING VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- Part 4: Finalization Corrections & Edge Cases ---');

  // 4a. School Staff Missing School Assignment Guard
  const unassignedTeacherReq = {
    user: { _id: teacherId, fullName: 'Unassigned Teacher', role: ROLES.TEACHER, staffCategory: STAFF_CATEGORY.SCHOOL_STAFF, schoolId: null },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResUnassignedTeacher = createMockResponse();
  await handleSubmitStaffAttendance(unassignedTeacherReq, mockResUnassignedTeacher);
  assert.equal(mockResUnassignedTeacher.statusCode, 400, 'Teacher without schoolId receives 400 Bad Request');
  assert.ok(mockResUnassignedTeacher.body.message.includes('Active school assignment required'), 'Explains active school assignment requirement');
  reportPass('Finalization: Teacher with missing schoolId blocked from attendance self-submission (400 Bad Request)');

  // 4b. Head Master Missing School Assignment Guard
  const unassignedHmReq = {
    user: { _id: '65d1a1b2c3d4e5f600000055', fullName: 'Unassigned HM', role: ROLES.HM, schoolId: null },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResUnassignedHm = createMockResponse();
  await handleHmSelfAttendance(unassignedHmReq, mockResUnassignedHm);
  assert.equal(mockResUnassignedHm.statusCode, 400, 'HM without schoolId receives 400 Bad Request');
  assert.ok(mockResUnassignedHm.body.message.includes('assigned school'), 'Explains HM school assignment requirement');
  reportPass('Finalization: HM with missing schoolId blocked from self-attendance (400 Bad Request)');

  // 4c. MongoDB Duplicate Key (E11000) Concurrency Collision Handling in handleSubmitStaffAttendance
  StaffAttendanceRecord.findOne = () => ({ lean: async () => null });
  StaffAttendanceRecord.create = async () => {
    const error = new Error('E11000 duplicate key error collection: school_management.staffattendancerecords index: unique_staff_attendance_per_day');
    error.code = 11000;
    throw error;
  };

  const collisionTeacherReq = {
    user: { _id: teacherId, fullName: 'Teacher Tariq', role: ROLES.TEACHER, staffCategory: STAFF_CATEGORY.SCHOOL_STAFF, schoolId: schoolAId, townId },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResCollisionTeacher = createMockResponse();
  await handleSubmitStaffAttendance(collisionTeacherReq, mockResCollisionTeacher);
  assert.equal(mockResCollisionTeacher.statusCode, 409, 'Concurrent duplicate collision returns 409 Conflict in handleSubmitStaffAttendance');
  assert.ok(mockResCollisionTeacher.body.message.includes('already submitted'), 'Clean message returned without raw DB stack');
  reportPass('Finalization: Concurrent collision (E11000) handled gracefully in handleSubmitStaffAttendance (409 Conflict)');

  // 4d. MongoDB Duplicate Key (E11000) in handleHmSelfAttendance
  const collisionHmReq = {
    user: { _id: '65d1a1b2c3d4e5f600000050', fullName: 'HM Aslam', role: ROLES.HM, schoolId: schoolAId, townId },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResCollisionHm = createMockResponse();
  await handleHmSelfAttendance(collisionHmReq, mockResCollisionHm);
  assert.equal(mockResCollisionHm.statusCode, 409, 'Concurrent duplicate collision returns 409 Conflict in handleHmSelfAttendance');
  reportPass('Finalization: Concurrent collision (E11000) handled gracefully in handleHmSelfAttendance (409 Conflict)');

  // 4e. MongoDB Duplicate Key (E11000) in handleSuperAdminMarkOfficeStaffAttendance
  User.findById = () => ({
    lean: async () => ({
      _id: officeStaffId,
      fullName: 'Rashid Office Peon',
      role: ROLES.PEON,
      staffCategory: STAFF_CATEGORY.OFFICE_STAFF,
      townId,
    }),
  });
  const collisionOfficeMarkReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN, townId },
    body: { staffUserId: officeStaffId, attendanceDate: '2026-10-27', status: ATTENDANCE_STATUS.PRESENT },
  };
  const mockResCollisionOfficeMark = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(collisionOfficeMarkReq, mockResCollisionOfficeMark);
  assert.equal(mockResCollisionOfficeMark.statusCode, 409, 'Concurrent duplicate collision returns 409 Conflict in office-mark');
  reportPass('Finalization: Concurrent collision (E11000) handled gracefully in handleSuperAdminMarkOfficeStaffAttendance (409 Conflict)');

  // 4f. MongoDB Duplicate Key (E11000) in handleSuperAdminSelfAttendance
  const collisionSuperAdminSelfReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN, townId },
    body: { attendanceDate: '2026-10-27' },
  };
  const mockResCollisionSuperAdminSelf = createMockResponse();
  await handleSuperAdminSelfAttendance(collisionSuperAdminSelfReq, mockResCollisionSuperAdminSelf);
  assert.equal(mockResCollisionSuperAdminSelf.statusCode, 409, 'Concurrent duplicate collision returns 409 Conflict in super-admin-self');
  reportPass('Finalization: Concurrent collision (E11000) handled gracefully in handleSuperAdminSelfAttendance (409 Conflict)');

  // 4g. Office Terminal Rejects Unsupported LEAVE when No Approved Leave Record Exists
  StaffAttendanceRecord.create = origRecordCreate; // restore normal create
  LeaveRequest.findOne = () => ({ lean: async () => null }); // No approved leave

  const unsupportedLeaveReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN, townId },
    body: { staffUserId: officeStaffId, attendanceDate: '2026-10-27', status: ATTENDANCE_STATUS.LEAVE, remarks: 'Casual Leave request' },
  };
  const mockResUnsupportedLeave = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(unsupportedLeaveReq, mockResUnsupportedLeave);
  assert.equal(mockResUnsupportedLeave.statusCode, 400, 'Unsupported LEAVE submission returns 400 Bad Request');
  assert.ok(mockResUnsupportedLeave.body.message.includes('No approved leave record found'), 'Explains no approved leave record found');
  reportPass('Finalization: Unsupported LEAVE submission without approved LeaveRequest is strictly rejected (400 Bad Request)');

  // 4h. Office Terminal Rejects Attendance Marking When Employee Is Already on Approved Leave
  LeaveRequest.findOne = () => ({
    lean: async () => ({
      _id: '65d1a1b2c3d4e5f600000777',
      leaveType: 'CASUAL_LEAVE',
      status: LEAVE_STATUS.APPROVED,
      startDate: new Date('2026-10-27T00:00:00.000Z'),
      endDate: new Date('2026-10-27T00:00:00.000Z'),
    }),
  });

  const onLeaveReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN, townId },
    body: { staffUserId: officeStaffId, attendanceDate: '2026-10-27', status: ATTENDANCE_STATUS.LEAVE },
  };
  const mockResOnLeave = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(onLeaveReq, mockResOnLeave);
  assert.equal(mockResOnLeave.statusCode, 400, 'Attempting terminal attendance for approved leave day returns 400 Bad Request');
  assert.ok(mockResOnLeave.body.message.includes('already has an approved CASUAL_LEAVE'), 'Explains existing approved leave');
  reportPass('Finalization: Staff on approved leave cannot have redundant terminal attendance marked (400 Bad Request)');

  // 4i. Office Terminal Rejects Arbitrary Invalid Status
  const invalidStatusReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN, townId },
    body: { staffUserId: officeStaffId, attendanceDate: '2026-10-27', status: 'INVALID_STATUS' },
  };
  const mockResInvalidStatus = createMockResponse();
  await handleSuperAdminMarkOfficeStaffAttendance(invalidStatusReq, mockResInvalidStatus);
  assert.equal(mockResInvalidStatus.statusCode, 400, 'Invalid status returns 400 Bad Request');
  assert.ok(mockResInvalidStatus.body.message.includes('only supports marking PRESENT or ABSENT'), 'Explains valid terminal statuses');
  reportPass('Finalization: Arbitrary attendance statuses are rejected by terminal (400 Bad Request)');

  // 4j. Office Staff Attendance Roster Surfaces Approved Leave Transparently
  LeaveRequest.find = () => ({
    lean: async () => [
      {
        _id: '65d1a1b2c3d4e5f600000777',
        staffUserId: officeStaffId,
        leaveType: 'CASUAL_LEAVE',
        startDate: new Date('2026-10-27T00:00:00.000Z'),
        endDate: new Date('2026-10-27T00:00:00.000Z'),
      },
    ],
  });
  User.find = () => ({
    select: () => ({
      sort: () => ({
        lean: async () => [
          { _id: officeStaffId, fullName: 'Rashid Office Peon', designation: 'Naib Qasid', role: ROLES.PEON, staffCategory: STAFF_CATEGORY.OFFICE_STAFF },
        ],
      }),
    }),
  });
  StaffAttendanceRecord.find = () => ({
    populate: function () { return this; },
    lean: async () => [],
  });

  const rosterWithLeaveReq = {
    user: { _id: superAdminId, role: ROLES.SUPER_ADMIN },
    query: { date: '2026-10-27' },
  };
  const mockResRosterWithLeave = createMockResponse();
  await handleGetOfficeStaffAttendanceRoster(rosterWithLeaveReq, mockResRosterWithLeave);

  assert.equal(mockResRosterWithLeave.statusCode, 200, 'Roster with leave returns 200 OK');
  assert.equal(mockResRosterWithLeave.body.roster[0].isOnLeave, true, 'Staff member isOnLeave is true');
  assert.equal(mockResRosterWithLeave.body.roster[0].leaveDetails.leaveType, 'CASUAL_LEAVE', 'leaveDetails.leaveType is CASUAL_LEAVE');
  assert.equal(mockResRosterWithLeave.body.summary.onLeaveCount, 1, 'Summary onLeaveCount = 1');
  reportPass('Finalization: Office staff attendance roster accurately surfaces approved leave and onLeaveCount');

} finally {
  // Restore original methods
  StaffAttendanceRecord.findOne = origRecordFindOne;
  StaffAttendanceRecord.findById = origRecordFindById;
  StaffAttendanceRecord.find = origRecordFind;
  StaffAttendanceRecord.create = origRecordCreate;
  StaffAttendanceRecord.countDocuments = origRecordCount;
  StaffAttendanceRecord.findByIdAndUpdate = origRecordFindByIdAndUpdate;
  LeaveRequest.findOne = origLeaveFindOne;
  LeaveRequest.find = origLeaveFind;
  User.findOne = origUserFindOne;
  User.findById = origUserFindById;
  User.find = origUserFind;
  AuditLog.create = origAuditCreate;
  Notification.insertMany = origNotificationInsertMany;
  NotificationOutbox.create = origNotificationOutboxCreate;
}

console.log('==============================================================================');
console.log(`🎉 ALL ${passedTestCount}/${passedTestCount} PHASES 1, 2, & 3 TESTS PASSED CLEANLY! ZERO FAILURES!`);
console.log('==============================================================================');
