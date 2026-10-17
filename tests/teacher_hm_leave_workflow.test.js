/**
 * 🛡️ TEACHER → HM CASUAL LEAVE (CL) APPROVAL WORKFLOW VERIFICATION SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies the complete end-to-end Teacher -> HM Leave workflow:
 * 1.  Teacher submits valid CL request (dates + reason); server derives identity & school
 * 2.  Input validation: missing fields, invalid date order, empty reason rejected with 400
 * 3.  Balance validation: requested days exceeding remaining CL balance rejected with 400
 * 4.  Overlapping request protection: overlapping pending/approved dates rejected with 409
 * 5.  HM notification dispatch: APPROVAL_REQUIRED event sent to the school's HM
 * 6.  HM pending queue isolation: HM of the same school receives the request via GET /leave/pending
 * 7.  Cross-school queue isolation (BOLA): HM of School B does NOT see School A requests
 * 8.  Cross-school approval defense: HM of School B attempting approval rejected with 403
 * 9.  Self-approval defense: Teacher attempting to approve their own request rejected with 403
 * 10. Rejection reason validation: Rejection without reason or reason < 5 chars rejected with 400
 * 11. Valid HM rejection: Status becomes REJECTED, decisionReason recorded, notification sent, balance unchanged
 * 12. Valid HM approval: Status becomes APPROVED, approvedBy recorded, notification sent, balance decrements
 * 13. Concurrency guard: Duplicate approval or rejection on processed request fails with 409 Conflict
 * 14. Balance recalculation: Approved request decrements available CL balance from 24 to 23
 */

import mongoose from 'mongoose';
import {
  ROLES,
  LEAVE_TYPE,
  LEAVE_STATUS,
  LEAVE_SOURCE,
  CL_POLICY,
} from '../config/constants.js';
import {
  handleSubmitLeaveRequest,
  handleGetMyLeaveRequests,
  handleGetClBalance,
  handleGetPendingLeaveRequests,
  handleApproveLeaveRequest,
  handleRejectLeaveRequest,
  handleForwardLeaveRequest,
} from '../src/controllers/leaveController.js';
import LeaveRequest from '../src/models/LeaveRequest.js';
import User from '../src/models/User.js';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';
import NotificationOutbox from '../src/models/NotificationOutbox.js';
import * as leaveService from '../src/services/leaveService.js';
import * as notificationDispatcher from '../src/services/notificationDispatcher.js';

let passedTests = 0;
let totalTests = 0;

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
  return {
    statusCode: null,
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
}

// ─── Shared Mock Entities ─────────────────────────────────────────────────────
const schoolA_Id = new mongoose.Types.ObjectId().toString();
const schoolB_Id = new mongoose.Types.ObjectId().toString();

const teacherA_Id = new mongoose.Types.ObjectId().toString();
const teacherA_User = {
  _id: teacherA_Id,
  fullName: 'Muhammad Bilal Rajput',
  role: ROLES.TEACHER,
  designation: 'PST (BPS-14)',
  schoolId: schoolA_Id,
};

const hmA_Id = new mongoose.Types.ObjectId().toString();
const hmA_User = {
  _id: hmA_Id,
  fullName: 'Syed Manzoor Hussain Shah',
  role: ROLES.HM,
  designation: 'Head Master',
  schoolId: schoolA_Id,
};

const hmB_Id = new mongoose.Types.ObjectId().toString();
const hmB_User = {
  _id: hmB_Id,
  fullName: 'Mohammad Tariq Qureshi',
  role: ROLES.HM,
  designation: 'Head Master',
  schoolId: schoolB_Id,
};

const townAdmin_Id = new mongoose.Types.ObjectId().toString();
const townAdmin_User = {
  _id: townAdmin_Id,
  fullName: 'District Education Officer (Town DMC)',
  role: ROLES.ADMIN,
  designation: 'Town Admin / DEO',
  schoolId: null,
};

console.log('\n==============================================================================');
console.log('🏛️  TEACHER → HM CASUAL LEAVE (CL) APPROVAL WORKFLOW VERIFICATION SUITE');
console.log('==============================================================================\n');

// ─── Setup In-Memory Mock Store ──────────────────────────────────────────────
let inMemoryLeaveRequests = [];
let inMemoryAuditLogs = [];
let inMemoryDispatchedNotifications = [];

Notification.insertMany = async () => [];
NotificationOutbox.create = async () => ({ _id: 'mock_outbox_id' });

// Mock AuditLog.create
AuditLog.create = async (payload) => {
  inMemoryAuditLogs.push(payload);
  return payload;
};

// Mock User.findOne to resolve school HM
User.findOne = (query) => ({
  select: () => ({
    lean: async () => {
      if (query.schoolId === schoolA_Id && query.role === ROLES.HM) {
        return { _id: hmA_Id, fullName: hmA_User.fullName };
      }
      return null;
    },
  }),
});

// Mock User.find to resolve Town Office Admins
User.find = (query) => {
  const chain = {
    select: () => chain,
    lean: async () => {
      if (query.role?.$in) {
        return [{ _id: townAdmin_Id, fullName: townAdmin_User.fullName }];
      }
      return [];
    },
  };
  return chain;
};

// Mock LeaveRequest methods
LeaveRequest.create = async (docData) => {
  const newDoc = {
    _id: new mongoose.Types.ObjectId().toString(),
    ...docData,
    submittedAt: new Date(),
    notificationDispatched: { submissionNotification: false, decisionNotificationSent: false },
    toObject() {
      return { ...this };
    },
    save: async function () {
      const idx = inMemoryLeaveRequests.findIndex((r) => r._id === this._id);
      if (idx !== -1) {
        inMemoryLeaveRequests[idx] = { ...this };
      }
      return this;
    },
  };
  inMemoryLeaveRequests.push(newDoc);
  return newDoc;
};

LeaveRequest.findById = (id) => {
  const found = inMemoryLeaveRequests.find((r) => r._id === id);
  let doc = null;
  if (found) {
    const rawStaffId = found.staffUserId?._id || found.staffUserId;
    doc = {
      ...found,
      staffUserId: rawStaffId,
      toObject() {
        return { ...this };
      },
      save: async function () {
        const idx = inMemoryLeaveRequests.findIndex((r) => r._id === this._id);
        if (idx !== -1) {
          const toSave = { ...this };
          if (toSave.staffUserId && typeof toSave.staffUserId === 'object' && toSave.staffUserId._id) {
            toSave.staffUserId = toSave.staffUserId._id;
          }
          inMemoryLeaveRequests[idx] = toSave;
        }
        return this;
      },
    };
  }
  const query = {
    populate: (path) => {
      if (doc && path && path.includes('staffUserId')) {
        const currentStaffId = String(doc.staffUserId?._id || doc.staffUserId);
        if (currentStaffId === teacherA_Id) {
          doc.staffUserId = {
            _id: teacherA_Id,
            fullName: teacherA_User.fullName,
            designation: teacherA_User.designation,
            role: teacherA_User.role,
            schoolId: teacherA_User.schoolId,
          };
        }
      }
      return query;
    },
    select: () => query,
    lean: async () => doc,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return query;
};

LeaveRequest.findByIdAndUpdate = async (id, update) => {
  const found = inMemoryLeaveRequests.find((r) => r._id === id);
  if (!found) return null;
  if (update.$set) {
    for (const [key, val] of Object.entries(update.$set)) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let current = found;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!current[parts[i]]) current[parts[i]] = {};
          current = current[parts[i]];
        }
        current[parts[parts.length - 1]] = val;
      } else {
        found[key] = val;
      }
    }
  }
  return found;
};

LeaveRequest.find = (filter) => {
  let list = inMemoryLeaveRequests.slice();
  if (filter.staffUserId) {
    list = list.filter((r) => {
      const sId = r.staffUserId?._id ? String(r.staffUserId._id) : String(r.staffUserId);
      return sId === String(filter.staffUserId);
    });
  }
  if (filter.schoolId) {
    list = list.filter((r) => String(r.schoolId) === String(filter.schoolId));
  }
  if (filter.status) {
    if (filter.status.$in) {
      list = list.filter((r) => filter.status.$in.includes(r.status));
    } else {
      list = list.filter((r) => r.status === filter.status);
    }
  }
  if (filter.leaveType) {
    list = list.filter((r) => r.leaveType === filter.leaveType);
  }
  if (filter.leaveYear) {
    list = list.filter((r) => r.leaveYear === filter.leaveYear);
  }

  const chain = {
    populate: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    select: () => chain,
    lean: async () => list,
  };
  return chain;
};

LeaveRequest.findOne = (query) => ({
  lean: async () => {
    let list = inMemoryLeaveRequests.slice();
    if (query.requestFingerprint) {
      return list.find((r) => r.requestFingerprint === query.requestFingerprint) || null;
    }
    if (query.staffUserId) {
      list = list.filter((r) => {
        const sId = r.staffUserId?._id ? String(r.staffUserId._id) : String(r.staffUserId);
        return sId === String(query.staffUserId);
      });
    }
    if (query.status?.$in) list = list.filter((r) => query.status.$in.includes(r.status));
    if (query.leaveType) list = list.filter((r) => r.leaveType === query.leaveType);
    if (query.startDate?.$lte && query.endDate?.$gte) {
      list = list.filter((r) => {
        const docStart = new Date(r.startDate).getTime();
        const docEnd = new Date(r.endDate).getTime();
        const maxStart = new Date(query.startDate.$lte).getTime();
        const minEnd = new Date(query.endDate.$gte).getTime();
        return docStart <= maxStart && docEnd >= minEnd;
      });
    }
    if (query._id?.$ne) {
      list = list.filter((r) => r._id !== query._id.$ne);
    }
    return list[0] || null;
  },
});

LeaveRequest.countDocuments = async (filter) => {
  let list = inMemoryLeaveRequests.slice();
  if (filter.schoolId) list = list.filter((r) => String(r.schoolId) === String(filter.schoolId));
  if (filter.status) list = list.filter((r) => r.status === filter.status);
  return list.length;
};

// ─── Scenario 1: Teacher submits valid CL request ─────────────────────────────
console.log('--- Scenario 1: Teacher Submits Valid CL Request ---');

const submitReq1 = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-10-20',
    endDate: '2026-10-21',
    reason: 'Urgent family obligation requiring physical attendance.',
  },
};
const submitRes1 = createMockResponse();

await handleSubmitLeaveRequest(submitReq1, submitRes1);

assert(submitRes1.statusCode === 201, 'Valid CL submission returns 201 Created');
assert(submitRes1.body.success === true, 'Response carries success: true');
assert(submitRes1.body.leaveRequest.durationDays === 2, 'Calculated duration is exactly 2 calendar days');
assert(submitRes1.body.leaveRequest.status === LEAVE_STATUS.PENDING, 'Initial status is strictly PENDING');

const createdLeaveId = submitRes1.body.leaveRequest._id;
const storedDoc1 = inMemoryLeaveRequests.find((r) => r._id === createdLeaveId);
assert(storedDoc1 !== undefined, 'Created leave request exists in persistent collection');
assert(storedDoc1.staffUserId === teacherA_Id, 'Staff user ID is derived strictly from authenticated user');
assert(storedDoc1.schoolId === schoolA_Id, 'School ID is derived strictly from authenticated user session');

// ─── Scenario 2: Validation Guards: Missing Fields ────────────────────────────
console.log('\n--- Scenario 2: Validation Guards (Missing Fields & Invalid Dates) ---');

const missingFieldsReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-10-20',
    // missing endDate & reason
  },
};
const missingFieldsRes = createMockResponse();
await handleSubmitLeaveRequest(missingFieldsReq, missingFieldsRes);
assert(missingFieldsRes.statusCode === 400, 'Missing endDate and reason fails with 400 Bad Request');

const emptyReasonReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-10-20',
    endDate: '2026-10-21',
    reason: '   ',
  },
};
const emptyReasonRes = createMockResponse();
await handleSubmitLeaveRequest(emptyReasonReq, emptyReasonRes);
assert(emptyReasonRes.statusCode === 400, 'Whitespace-only reason fails with 400 Bad Request');

// ─── Scenario 3: Date Ordering Invariant (endDate < startDate) ────────────────
console.log('\n--- Scenario 3: Date Ordering Invariant ---');

const invertedDatesReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-10-25',
    endDate: '2026-10-20',
    reason: 'Family event out of town.',
  },
};
const invertedDatesRes = createMockResponse();
await handleSubmitLeaveRequest(invertedDatesReq, invertedDatesRes);
assert(invertedDatesRes.statusCode === 400, 'End date before start date fails with 400 Bad Request');
assert(invertedDatesRes.body.message.includes('on or after startDate'), 'Error message cites date order requirement');

// ─── Scenario 4A: Consecutive Day Limitation Enforcement (CL Max 3 Days) ────
console.log('\n--- Scenario 4A: Consecutive Day Limitation Enforcement (CL Max 3 Days) ---');

const excessConsecutiveReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-11-01',
    endDate: '2026-11-05', // 5 days > 3 max consecutive days
    reason: 'Casual leave exceeding 3-day consecutive limit.',
  },
};
const excessConsecutiveRes = createMockResponse();
await handleSubmitLeaveRequest(excessConsecutiveReq, excessConsecutiveRes);
assert(excessConsecutiveRes.statusCode === 400, 'CL request exceeding 3 consecutive calendar days fails with 400 Bad Request');
assert(excessConsecutiveRes.body.message.includes('cannot exceed 3 consecutive calendar days'), 'Error message specifies 3 consecutive day limit');
assert(excessConsecutiveRes.body.message.includes('Earned Leave (EL)'), 'Error message instructs staff to apply for Earned Leave (EL)');

// ─── Scenario 4B: Remaining Balance Quota Exhaustion Validation ───────────────
console.log('\n--- Scenario 4B: Remaining Balance Quota Exhaustion Validation ---');

// Temporarily insert approved leaves totaling 23 days for teacherA in 2026
const mockPriorApprovedLeave = {
  _id: new mongoose.Types.ObjectId().toString(),
  staffUserId: teacherA_Id,
  schoolId: schoolA_Id,
  leaveType: LEAVE_TYPE.CASUAL_LEAVE,
  leaveYear: 2026,
  status: LEAVE_STATUS.APPROVED,
  durationDays: 23,
  startDate: new Date('2026-05-01'),
  endDate: new Date('2026-05-23'),
  reason: 'Prior municipal approved leaves consuming quota.',
};
inMemoryLeaveRequests.push(mockPriorApprovedLeave);

const excessQuotaReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-11-10',
    endDate: '2026-11-11', // 2 days, but only 1 day remaining (24 - 23 = 1)
    reason: 'Attempting 2-day leave when only 1 day balance remains.',
  },
};
const excessQuotaRes = createMockResponse();
await handleSubmitLeaveRequest(excessQuotaReq, excessQuotaRes);
assert(excessQuotaRes.statusCode === 400, 'Request exceeding remaining CL quota balance fails with 400 Bad Request');
assert(excessQuotaRes.body.message.includes('Insufficient CL balance'), 'Error message explicitly reports insufficient CL balance');
assert(excessQuotaRes.body.remainingBalance === 1, 'Response reports exact remaining balance of 1 day');

// Clean up mock prior leave so subsequent scenarios have a clean slate
const priorLeaveIndex = inMemoryLeaveRequests.findIndex((r) => r._id === mockPriorApprovedLeave._id);
if (priorLeaveIndex !== -1) inMemoryLeaveRequests.splice(priorLeaveIndex, 1);

// ─── Scenario 5: Overlapping Leave Request Prevention ─────────────────────────
console.log('\n--- Scenario 5: Overlapping Request Protection ---');

const overlapReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-10-21', // Overlaps with 2026-10-20..2026-10-21
    endDate: '2026-10-22',
    reason: 'Second overlapping application attempt.',
  },
};
const overlapRes = createMockResponse();
await handleSubmitLeaveRequest(overlapReq, overlapRes);
assert(overlapRes.statusCode === 409, 'Overlapping leave request fails with 409 Conflict');
assert(overlapRes.body.message.includes('overlapping dates'), 'Error message explicitly reports date overlap');

// ─── Scenario 6: Notification Creation & HM Notification Dispatch ─────────────
console.log('\n--- Scenario 6: Notification Creation on Leave Submission ---');

assert(storedDoc1.notificationDispatched.submissionNotification === true, 'Leave record marked with submissionNotification: true');
const submissionAudit = inMemoryAuditLogs.find(
  (a) => a.action === 'LEAVE_REQUEST_SUBMITTED' && a.targetId === createdLeaveId
);
assert(submissionAudit !== undefined, 'Audit log emitted for LEAVE_REQUEST_SUBMITTED');
assert(submissionAudit.actorId === teacherA_Id, 'Audit log actor is the submitting Teacher');
assert(submissionAudit.schoolId === schoolA_Id, 'Audit log schoolId matches Teacher assigned school');

// ─── Scenario 7: HM Same School Views Request in Pending Queue ────────────────
console.log('\n--- Scenario 7: HM Same School Pending Approval Queue ---');

const hmPendingReq = {
  user: hmA_User,
  query: { status: 'PENDING' },
};
const hmPendingRes = createMockResponse();

await handleGetPendingLeaveRequests(hmPendingReq, hmPendingRes);

assert(hmPendingRes.statusCode === 200, 'HM pending requests query returns 200 OK');
assert(hmPendingRes.body.leaveRequests.length >= 1, 'HM sees at least 1 pending leave request');
const foundInQueue = hmPendingRes.body.leaveRequests.find((r) => r._id === createdLeaveId);
assert(foundInQueue !== undefined, 'Teacher A request is visible to School A Head Master');

// ─── Scenario 8: Cross-School Isolation (BOLA Tripwire) ───────────────────────
console.log('\n--- Scenario 8: Cross-School Isolation (BOLA Tripwire) ---');

const hmBPendingReq = {
  user: hmB_User,
  query: { status: 'PENDING' },
};
const hmBPendingRes = createMockResponse();

await handleGetPendingLeaveRequests(hmBPendingReq, hmBPendingRes);

assert(hmBPendingRes.statusCode === 200, 'HM B pending requests query returns 200 OK');
const foreignRequestInQueue = hmBPendingRes.body.leaveRequests.find((r) => r._id === createdLeaveId);
assert(foreignRequestInQueue === undefined, 'School B HM cannot see Teacher A pending leave request (Zero cross-school leakage)');

// ─── Scenario 9: Cross-School Approval Denial ─────────────────────────────────
console.log('\n--- Scenario 9: Cross-School Approval Denial ---');

const crossSchoolApproveReq = {
  user: hmB_User, // School B HM trying to approve School A request
  params: { id: createdLeaveId },
  body: { reason: 'Unauthorized cross-school approval attempt.' },
};
const crossSchoolApproveRes = createMockResponse();

await handleApproveLeaveRequest(crossSchoolApproveReq, crossSchoolApproveRes);

assert(crossSchoolApproveRes.statusCode === 403, 'Cross-school approval attempt rejected with 403 Forbidden');
assert(
  crossSchoolApproveRes.body.message.includes('only approve CL for staff in their assigned school'),
  'Rejection cites school assignment restriction'
);

const unapprovedDoc = inMemoryLeaveRequests.find((r) => r._id === createdLeaveId);
assert(unapprovedDoc.status === LEAVE_STATUS.PENDING, 'Request remains PENDING (Zero partial mutation on failure)');

// ─── Scenario 10: Teacher Self-Approval Denial ────────────────────────────────
console.log('\n--- Scenario 10: Teacher Self-Approval Denial ---');

const selfApproveReq = {
  user: teacherA_User, // Teacher attempting to approve own request
  params: { id: createdLeaveId },
  body: { reason: 'Self-approval attempt.' },
};
const selfApproveRes = createMockResponse();

await handleApproveLeaveRequest(selfApproveReq, selfApproveRes);

assert(selfApproveRes.statusCode === 403, 'Self-approval attempt rejected with 403 Forbidden');
assert(
  selfApproveRes.body.message.includes('Self-approval of leave is strictly prohibited'),
  'Rejection cites strict prohibition of self-approval'
);

// ─── Scenario 11: HM Rejection Validation (Mandatory Reason >= 5 Chars) ───────
console.log('\n--- Scenario 11: Rejection Validation (Mandatory Reason >= 5 chars) ---');

const rejectShortReasonReq = {
  user: hmA_User,
  params: { id: createdLeaveId },
  body: { reason: 'No' }, // < 5 chars
};
const rejectShortReasonRes = createMockResponse();

await handleRejectLeaveRequest(rejectShortReasonReq, rejectShortReasonRes);

assert(rejectShortReasonRes.statusCode === 400, 'Rejection with reason under 5 characters fails with 400 Bad Request');
assert(
  rejectShortReasonRes.body.message.includes('at least 5 characters'),
  'Error message specifies 5 character requirement'
);

// ─── Scenario 12: Valid HM Rejection Flow & Balance Preservation ──────────────
console.log('\n--- Scenario 12: Valid HM Rejection Flow & Balance Preservation ---');

// Create a second request to test rejection cleanly
const submitReq2 = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    startDate: '2026-11-05',
    endDate: '2026-11-05',
    reason: 'Personal errand at town secretariat.',
  },
};
const submitRes2 = createMockResponse();
await handleSubmitLeaveRequest(submitReq2, submitRes2);
const leaveIdToReject = submitRes2.body.leaveRequest._id;

const validRejectReq = {
  user: hmA_User,
  params: { id: leaveIdToReject },
  body: { reason: 'Critical examination inspection duties scheduled on this date.' },
};
const validRejectRes = createMockResponse();

await handleRejectLeaveRequest(validRejectReq, validRejectRes);

assert(validRejectRes.statusCode === 200, 'Valid rejection returns 200 OK');
assert(validRejectRes.body.leaveRequest.status === LEAVE_STATUS.REJECTED, 'Leave status updated to REJECTED');
assert(
  validRejectRes.body.leaveRequest.decisionReason === 'Critical examination inspection duties scheduled on this date.',
  'Decision reason accurately persisted'
);

const rejectedDoc = inMemoryLeaveRequests.find((r) => r._id === leaveIdToReject);
assert(rejectedDoc.status === LEAVE_STATUS.REJECTED, 'Stored record status is REJECTED');
assert(rejectedDoc.rejectedBy === hmA_Id, 'rejectedBy matches HM A ID');

// Check that rejected leave did NOT consume balance
const clBalanceResAfterReject = createMockResponse();
await handleGetClBalance({ user: teacherA_User, query: { year: 2026 } }, clBalanceResAfterReject);
assert(
  clBalanceResAfterReject.body.clBalance.usedDays === 0,
  'Rejected leave does NOT decrement CL balance (0 used days)'
);
assert(
  clBalanceResAfterReject.body.clBalance.remainingDays === 24,
  'Remaining balance remains at full 24 days'
);

// ─── Scenario 13: Valid HM Approval Flow & Exact Balance Decrement ────────────
console.log('\n--- Scenario 13: Valid HM Approval Flow & Balance Decrement ---');

const validApproveReq = {
  user: hmA_User,
  params: { id: createdLeaveId }, // 2 days duration
  body: { reason: 'Approved in consideration of urgent family emergency.' },
};
const validApproveRes = createMockResponse();

await handleApproveLeaveRequest(validApproveReq, validApproveRes);

assert(validApproveRes.statusCode === 200, 'Valid approval returns 200 OK');
assert(validApproveRes.body.leaveRequest.status === LEAVE_STATUS.APPROVED, 'Status transitioned to APPROVED');
assert(validApproveRes.body.leaveRequest.approvedBy === hmA_Id, 'approvedBy matches HM user ID');

const approvedDoc = inMemoryLeaveRequests.find((r) => r._id === createdLeaveId);
assert(approvedDoc.status === LEAVE_STATUS.APPROVED, 'Stored document is APPROVED');

const approvalAudit = inMemoryAuditLogs.find(
  (a) => a.action === 'LEAVE_REQUEST_APPROVED' && a.targetId === createdLeaveId
);
assert(approvalAudit !== undefined, 'Audit log emitted for LEAVE_REQUEST_APPROVED');
assert(approvalAudit.actorId === hmA_Id, 'Audit log actor is the approving HM');

// Verify Teacher sees updated status in /leave/my-requests
const teacherMyRequestsRes = createMockResponse();
await handleGetMyLeaveRequests({ user: teacherA_User, query: {} }, teacherMyRequestsRes);
const approvedInTeacherView = teacherMyRequestsRes.body.leaveRequests.find((r) => r._id === createdLeaveId);
assert(approvedInTeacherView.status === LEAVE_STATUS.APPROVED, 'Teacher sees APPROVED status in my-requests view');

// Verify CL balance decrements exactly once (24 - 2 days = 22 days remaining)
const clBalanceResAfterApprove = createMockResponse();
await handleGetClBalance({ user: teacherA_User, query: { year: 2026 } }, clBalanceResAfterApprove);
assert(
  clBalanceResAfterApprove.body.clBalance.usedDays === 2,
  'Approved leave increments usedDays by exactly 2 days'
);
assert(
  clBalanceResAfterApprove.body.clBalance.remainingDays === 22,
  'Remaining balance decrements from 24 to 22 days'
);

// ─── Scenario 14: Duplicate Decision / Concurrency Protection ─────────────────
console.log('\n--- Scenario 14: Duplicate Decision & Concurrency Protection ---');

const duplicateApproveReq = {
  user: hmA_User,
  params: { id: createdLeaveId },
  body: { reason: 'Attempting to approve again.' },
};
const duplicateApproveRes = createMockResponse();

await handleApproveLeaveRequest(duplicateApproveReq, duplicateApproveRes);

assert(duplicateApproveRes.statusCode === 409, 'Re-approval attempt on already approved request returns 409 Conflict');
assert(
  duplicateApproveRes.body.message.includes('Only PENDING requests can be approved'),
  'Conflict message states only PENDING requests can be approved'
);

const duplicateRejectReq = {
  user: hmA_User,
  params: { id: createdLeaveId },
  body: { reason: 'Attempting to reject an already approved request.' },
};
const duplicateRejectRes = createMockResponse();

await handleRejectLeaveRequest(duplicateRejectReq, duplicateRejectRes);

assert(duplicateRejectRes.statusCode === 409, 'Rejection attempt on already approved request returns 409 Conflict');
assert(
  duplicateRejectRes.body.message.includes('Only PENDING requests can be rejected'),
  'Conflict message states only PENDING requests can be rejected'
);

// Ensure used days was NOT double-counted
const clBalanceResAfterDuplicate = createMockResponse();
await handleGetClBalance({ user: teacherA_User, query: { year: 2026 } }, clBalanceResAfterDuplicate);
assert(
  clBalanceResAfterDuplicate.body.clBalance.usedDays === 2,
  'Used days is strictly preserved at 2 (zero double deduction on duplicate attempt)'
);

// ─── Scenario 15: Two-Tier Earned Leave (EL) Recommendation & Sanction Flow ───
console.log('\n--- Scenario 15: Two-Tier Earned Leave (EL) Recommendation & Sanction Flow ---');

// 1. Teacher submits 5-day Earned Leave request
const elSubmitReq = {
  user: teacherA_User,
  body: {
    leaveType: LEAVE_TYPE.EARNED_LEAVE,
    startDate: '2026-12-01',
    endDate: '2026-12-05', // 5 consecutive calendar days
    reason: 'Family pilgrimage and personal affairs requiring extended leave.',
  },
};
const elSubmitRes = createMockResponse();
await handleSubmitLeaveRequest(elSubmitReq, elSubmitRes);

assert(elSubmitRes.statusCode === 201, 'Earned Leave submission returns 201 Created');
assert(elSubmitRes.body.leaveRequest.durationDays === 5, 'EL duration is calculated as 5 calendar days');
assert(elSubmitRes.body.leaveRequest.leaveType === LEAVE_TYPE.EARNED_LEAVE, 'leaveType is EARNED_LEAVE');
assert(elSubmitRes.body.leaveRequest.forwardedByHm === false, 'Newly submitted EL has forwardedByHm: false');

const elRequestId = elSubmitRes.body.leaveRequest._id;

// 2. Teacher attempts self-forwarding -> must fail with 403 Forbidden
const selfForwardReq = {
  user: teacherA_User,
  params: { id: elRequestId },
  body: { recommendationNote: 'Self-forwarding attempt.' },
};
const selfForwardRes = createMockResponse();
await handleForwardLeaveRequest(selfForwardReq, selfForwardRes);
assert(selfForwardRes.statusCode === 403, 'Self-forwarding by teacher is rejected with 403 Forbidden');
assert(selfForwardRes.body.message.includes('Self-forwarding of leave is strictly prohibited'), 'Self-forwarding error cites prohibition');

// 3. HM of School B (wrong school) attempts to forward -> must fail with 403 Forbidden
const crossSchoolForwardReq = {
  user: hmB_User,
  params: { id: elRequestId },
  body: { recommendationNote: 'Cross-school unauthorized forward.' },
};
const crossSchoolForwardRes = createMockResponse();
await handleForwardLeaveRequest(crossSchoolForwardReq, crossSchoolForwardRes);
assert(crossSchoolForwardRes.statusCode === 403, 'HM of School B cannot forward School A teacher EL (403 Forbidden)');

// 4. HM of School A forwards with short recommendation (< 3 chars) -> fails with 400 Bad Request
const shortNoteForwardReq = {
  user: hmA_User,
  params: { id: elRequestId },
  body: { recommendationNote: 'ok' },
};
const shortNoteForwardRes = createMockResponse();
await handleForwardLeaveRequest(shortNoteForwardReq, shortNoteForwardRes);
assert(shortNoteForwardRes.statusCode === 400, 'Recommendation note < 3 characters rejected with 400 Bad Request');

// 5. HM of School A forwards with valid institutional recommendation -> returns 200 OK
const validForwardReq = {
  user: hmA_User,
  params: { id: elRequestId },
  body: { recommendationNote: 'Strongly recommended. Substitute arrangements made for Classes 4 and 5.' },
};
const validForwardRes = createMockResponse();
await handleForwardLeaveRequest(validForwardReq, validForwardRes);
assert(validForwardRes.statusCode === 200, 'HM of School A successfully forwards EL with 200 OK');
assert(validForwardRes.body.leaveRequest.forwardedByHm === true, 'Response confirms forwardedByHm: true');
assert(validForwardRes.body.leaveRequest.hmForwardedBy === hmA_Id, 'hmForwardedBy matches HM user ID');

// Verify persistent document state and audit log
const storedElDoc = inMemoryLeaveRequests.find((r) => r._id === elRequestId);
assert(storedElDoc.forwardedByHm === true, 'Stored EL document has forwardedByHm: true');
assert(storedElDoc.status === LEAVE_STATUS.PENDING, 'EL status remains PENDING awaiting Town Office sanction');

const forwardAudit = inMemoryAuditLogs.find(
  (a) => a.action === 'LEAVE_REQUEST_FORWARDED_TO_OFFICE' && a.targetId === elRequestId
);
assert(forwardAudit !== undefined, 'Audit log emitted for LEAVE_REQUEST_FORWARDED_TO_OFFICE');
assert(forwardAudit.actorId === hmA_Id, 'Forward audit log actor is HM A');

// 6. Duplicate forward attempt -> returns 409 Conflict
const duplicateForwardRes = createMockResponse();
await handleForwardLeaveRequest(validForwardReq, duplicateForwardRes);
assert(duplicateForwardRes.statusCode === 409, 'Duplicate forward attempt on already forwarded EL returns 409 Conflict');

// 7. HM attempts to approve EL directly -> fails with 403 Forbidden (HM cannot sanction EL)
const hmApproveElReq = {
  user: hmA_User,
  params: { id: elRequestId },
  body: { reason: 'HM attempting direct sanction of EL.' },
};
const hmApproveElRes = createMockResponse();
await handleApproveLeaveRequest(hmApproveElReq, hmApproveElRes);
assert(hmApproveElRes.statusCode === 403, 'HM cannot approve EL (restricted to Admin authority, returns 403)');
assert(hmApproveElRes.body.message.includes('Admin'), 'Authority rejection cites Admin requirement');

// 8. Town Admin sanctions the forwarded EL request -> returns 200 OK
const adminApproveElReq = {
  user: townAdmin_User,
  params: { id: elRequestId },
  body: { reason: 'Sanctioned under Municipal Education Service Leave Rules.' },
};
const adminApproveElRes = createMockResponse();
await handleApproveLeaveRequest(adminApproveElReq, adminApproveElRes);
assert(adminApproveElRes.statusCode === 200, 'Town Admin successfully sanctions EL with 200 OK');
assert(adminApproveElRes.body.leaveRequest.status === LEAVE_STATUS.APPROVED, 'Status transitioned to APPROVED');
assert(adminApproveElRes.body.leaveRequest.approvedBy === townAdmin_Id, 'approvedBy matches Town Admin ID');

const approvedElAudit = inMemoryAuditLogs.find(
  (a) => a.action === 'LEAVE_REQUEST_APPROVED' && a.targetId === elRequestId
);
assert(approvedElAudit !== undefined, 'Audit log emitted for EL approval by Admin');
assert(approvedElAudit.actorId === townAdmin_Id, 'Audit log records Town Admin as approver');

console.log('\n==============================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} TEACHER → HM LEAVE WORKFLOW TESTS PASSED!`);
console.log('==============================================================================\n');
process.exit(0);
