/**
 * 🛡️ HEAD MASTER (HM) FACULTY TRANSFER LIFECYCLE & SECURITY TEST SUITE (STEP 5)
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Exhaustive Verification of:
 *  Group 1: Canonical Municipal State Machine & Transitions (Scenarios 1-5)
 *  Group 2: Behavioral Authorization & Duty Expiry Enforcement (Scenarios 6-9)
 *  Group 3: Source HM & Destination HM Scope, IDOR & Anti-BOLA (Scenarios 10-14)
 *  Group 4: Concurrency, In-Flight Guards & Orphan Cleanup (Scenarios 15-18)
 *  Group 5: Rejection, Admin Review & Cancellation Workflows (Scenarios 19-23)
 *  Group 6: Audit Trail Completeness & Record Immutability (Scenarios 24-25)
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  TRANSFER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
  USER_STATUS,
} from '../config/constants.js';

// Production controllers
import {
  handleInitiateTransfer,
  handleGetTransfers,
  handleGetTransferById,
  handleRelieveTeacher,
  handleApproveJoining,
  handleRejectJoining,
  handleAdminReview,
  handleCancelTransfer,
} from '../src/controllers/transferController.js';

// Domain models
import TransferRequest from '../src/models/TransferRequest.js';
import User from '../src/models/User.js';
import School from '../src/models/School.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import Section from '../src/models/Section.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import AuditLog from '../src/models/AuditLog.js';

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
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  return response;
}

function createMockQueryChain(result) {
  const chain = {
    populate: () => chain,
    sort: () => chain,
    limit: () => chain,
    skip: () => chain,
    select: () => chain,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

// Default mock for AuditLog.create to prevent Mongoose connection buffering timeouts
AuditLog.create = async (entries) => {
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((entry, index) => ({ _id: `audit_mock_${Date.now()}_${index}`, ...entry }));
};

// ── Test Identity Fixtures ────────────────────────────────────────────────────
const townNorthId = '65b123456789abcdef000001';
const townSouthId = '65b123456789abcdef000002';

const schoolSourceId = '65b123456789abcdef000010';
const schoolTargetId = '65b123456789abcdef000020';
const schoolForeignId = '65b123456789abcdef000099';

const sourceHM = {
  _id: '65b123456789abcdef000101',
  role: ROLES.HM,
  schoolId: schoolSourceId,
  fullName: 'HM Source Liaquatabad School',
  townId: townNorthId,
};

const destinationHM = {
  _id: '65b123456789abcdef000102',
  role: ROLES.HM,
  schoolId: schoolTargetId,
  fullName: 'HM Target Secondary School',
  townId: townNorthId,
};

const foreignHM = {
  _id: '65b123456789abcdef000103',
  role: ROLES.HM,
  schoolId: schoolForeignId,
  fullName: 'HM Foreign School',
  townId: townNorthId,
};

const townAdmin = {
  _id: '65b123456789abcdef000201',
  role: ROLES.ADMIN,
  fullName: 'Town Education Officer Admin',
  townId: townNorthId,
};

const teacherUser = {
  _id: '65b123456789abcdef000301',
  role: ROLES.TEACHER,
  fullName: 'Sir Zafar Iqbal',
  schoolId: { _id: schoolSourceId, name: 'GBSS Liaquatabad 1', townId: townNorthId },
  status: USER_STATUS.ACTIVE,
};

const sourceSchoolDoc = {
  _id: schoolSourceId,
  name: 'GBSS Liaquatabad 1',
  code: 'LIAQ-01',
  townId: townNorthId,
};

const targetSchoolDoc = {
  _id: schoolTargetId,
  name: 'GGSS Liaquatabad 2',
  code: 'LIAQ-02',
  townId: townNorthId,
};

const sectionSourceDoc = {
  _id: '65b123456789abcdef000401',
  schoolId: schoolSourceId,
  name: 'Section A',
  classTeacherId: teacherUser._id,
};

console.log('🧪 Starting HM Step 5: Faculty Transfer Lifecycle & Security Suite...\n');

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 1: CANONICAL MUNICIPAL STATE MACHINE & TRANSITIONS (Scenarios 1-5)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('--- Group 1: Canonical Municipal State Machine & Lifecycle Transitions ---');

await runAsyncTest('Scenario 1: Initiation sets canonical APPROVED status when official order is promulgated', async () => {
  const origFindById = User.findById;
  const origSchoolFindById = School.findById;
  const origTransferFindOne = TransferRequest.findOne;
  const origTransferCreate = TransferRequest.create;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  let sessionCommitted = false;
  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => { sessionCommitted = true; },
    abortTransaction: async () => {},
    endSession: () => {},
  });

  User.findById = () => ({
    populate: () => Promise.resolve(teacherUser),
  });
  School.findById = () => ({
    lean: () => Promise.resolve(targetSchoolDoc),
  });
  TransferRequest.findOne = () => ({
    lean: () => Promise.resolve(null), // No active transfer
  });

  let createdTransfer = null;
  TransferRequest.create = async ([doc]) => {
    createdTransfer = { ...doc, _id: '507f1f77bcf86cd799439011', createdAt: new Date() };
    return [createdTransfer];
  };
  AuditLog.create = async () => [{ _id: 'audit_01' }];

  const req = {
    user: townAdmin,
    body: {
      teacherUserId: teacherUser._id,
      targetSchoolId: schoolTargetId,
      reason: 'Administrative faculty rebalancing per municipal quota',
      officialOrderNumber: 'DMC/EDU/TR/2026/089',
    },
  };
  const res = createMockResponse();

  try {
    await handleInitiateTransfer(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(createdTransfer.status, TRANSFER_STATUS.APPROVED);
    assert.equal(createdTransfer.officialOrderNumber, 'DMC/EDU/TR/2026/089');
    assert.equal(sessionCommitted, true);
  } finally {
    User.findById = origFindById;
    School.findById = origSchoolFindById;
    TransferRequest.findOne = origTransferFindOne;
    TransferRequest.create = origTransferCreate;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 2: Source HM formally relieves faculty, transitioning to canonical RELIEVED state', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origTeachingUpdateMany = TeachingAssignment.updateMany;
  const origSectionUpdateMany = Section.updateMany;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  let sessionCommitted = false;
  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => { sessionCommitted = true; },
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.APPROVED,
          fromSchoolId: { _id: schoolSourceId, name: 'GBSS Liaquatabad 1' },
          toSchoolId: { _id: schoolTargetId, name: 'GGSS Liaquatabad 2' },
          teacherUserId: { _id: teacherUser._id, fullName: 'Sir Zafar Iqbal' },
          officialOrderNumber: 'DMC/EDU/TR/2026/089',
        }),
      }),
    }),
  });

  let transitionedStatus = null;
  TransferRequest.findOneAndUpdate = async (filter, update) => {
    transitionedStatus = update.$set.status;
    return {
      _id: '507f1f77bcf86cd799439011',
      status: update.$set.status,
      relievingDetails: update.$set.relievingDetails,
    };
  };

  let expiredCount = 0;
  TeachingAssignment.updateMany = async () => {
    expiredCount = 2;
    return { modifiedCount: 2 };
  };

  let clearedSectionCount = 0;
  Section.updateMany = async () => {
    clearedSectionCount = 1;
    return { modifiedCount: 1 };
  };

  AuditLog.create = async () => [{ _id: 'audit_02' }];

  const req = {
    user: sourceHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: {
      clearanceCertified: true,
      relievingOrderNumber: 'REL/2026/012',
      relievingRemarks: 'Clearance verified, all registers handed over.',
    },
  };
  const res = createMockResponse();

  try {
    await handleRelieveTeacher(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(transitionedStatus, TRANSFER_STATUS.RELIEVED);
    assert.equal(res.body.data.expiredAssignments, 2);
    assert.equal(res.body.data.clearedClassTeacherSections, 1);
    assert.equal(sessionCommitted, true);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    TeachingAssignment.updateMany = origTeachingUpdateMany;
    Section.updateMany = origSectionUpdateMany;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 3: Destination HM certifies arrival, transitioning to canonical JOINED state', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origUserUpdate = User.findByIdAndUpdate;
  const origTeachingUpdateMany = TeachingAssignment.updateMany;
  const origSectionUpdateMany = Section.updateMany;
  const origProfileUpdate = TeacherProfile.findOneAndUpdate;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  let sessionCommitted = false;
  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => { sessionCommitted = true; },
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.RELIEVED,
          fromSchoolId: { _id: schoolSourceId, name: 'GBSS Liaquatabad 1' },
          toSchoolId: { _id: schoolTargetId, name: 'GGSS Liaquatabad 2' },
          teacherUserId: { _id: teacherUser._id, fullName: 'Sir Zafar Iqbal' },
          officialOrderNumber: 'DMC/EDU/TR/2026/089',
        }),
      }),
    }),
  });

  let joinedStatus = null;
  TransferRequest.findOneAndUpdate = async (filter, update) => {
    joinedStatus = update.$set.status;
    return {
      _id: '507f1f77bcf86cd799439011',
      status: update.$set.status,
      destinationHMReview: update.$set.destinationHMReview,
    };
  };

  let userNewSchool = null;
  User.findByIdAndUpdate = async (id, update) => {
    userNewSchool = update.$set.schoolId;
    return { _id: id, schoolId: userNewSchool };
  };

  TeachingAssignment.updateMany = async () => ({ modifiedCount: 0 });
  Section.updateMany = async () => ({ modifiedCount: 0 });
  TeacherProfile.findOneAndUpdate = async () => ({ _id: 'prof_01' });
  AuditLog.create = async () => [{ _id: 'audit_03' }];

  const req = {
    user: destinationHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: {
      joiningDate: '2026-09-22',
      remarks: 'Physical report accepted and verified.',
    },
  };
  const res = createMockResponse();

  try {
    await handleApproveJoining(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(joinedStatus, TRANSFER_STATUS.JOINED);
    assert.equal(String(userNewSchool), String(schoolTargetId));
    assert.equal(sessionCommitted, true);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    User.findByIdAndUpdate = origUserUpdate;
    TeachingAssignment.updateMany = origTeachingUpdateMany;
    Section.updateMany = origSectionUpdateMany;
    TeacherProfile.findOneAndUpdate = origProfileUpdate;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 4: Premature joining approval before relieving is rejected with 400 Bad Request', async () => {
  const origFindById = TransferRequest.findById;
  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.APPROVED, // Not yet relieved!
          fromSchoolId: { _id: schoolSourceId, name: 'GBSS Liaquatabad 1' },
          toSchoolId: { _id: schoolTargetId, name: 'GGSS Liaquatabad 2' },
          teacherUserId: { _id: teacherUser._id, fullName: 'Sir Zafar Iqbal' },
        }),
      }),
    }),
  });

  const req = {
    user: destinationHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { joiningDate: '2026-09-22', remarks: 'Trying to join prematurely' },
  };
  const res = createMockResponse();

  try {
    await handleApproveJoining(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message.includes('formally relieved by the Source School Head Master first'), true);
  } finally {
    TransferRequest.findById = origFindById;
  }
});

await runAsyncTest('Scenario 5: Attempting to relieve an already relieved or joined transfer is rejected with 400', async () => {
  const origFindById = TransferRequest.findById;
  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.RELIEVED, // Already relieved!
          fromSchoolId: { _id: schoolSourceId, name: 'GBSS Liaquatabad 1' },
          toSchoolId: { _id: schoolTargetId, name: 'GGSS Liaquatabad 2' },
          teacherUserId: { _id: teacherUser._id, fullName: 'Sir Zafar Iqbal' },
        }),
      }),
    }),
  });

  const req = {
    user: sourceHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { clearanceCertified: true },
  };
  const res = createMockResponse();

  try {
    await handleRelieveTeacher(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message.includes('Transfer cannot be relieved'), true);
  } finally {
    TransferRequest.findById = origFindById;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 2: BEHAVIORAL AUTHORIZATION & DUTY EXPIRY ENFORCEMENT (Scenarios 6-9)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n--- Group 2: Behavioral Authorization & Duty Expiry Enforcement ---');

await runAsyncTest('Scenario 6: Pre-relieving behavioral check: Teacher possesses active teaching assignment', async () => {
  const origFindOne = TeachingAssignment.findOne;

  // Active assignment at source school
  TeachingAssignment.findOne = async (query) => {
    if (query.teacherId === teacherUser._id && query.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE) {
      return { _id: 'ta_active', teacherId: teacherUser._id, status: TEACHING_ASSIGNMENT_STATUS.ACTIVE };
    }
    return null;
  };

  try {
    const isAssigned = await TeachingAssignment.isTeacherAssigned({
      teacherId: teacherUser._id,
      schoolId: schoolSourceId,
      sectionId: sectionSourceDoc._id,
    });
    assert.equal(isAssigned, true, 'Teacher must have active authorization before relieving');
  } finally {
    TeachingAssignment.findOne = origFindOne;
  }
});

await runAsyncTest('Scenario 7: Post-relieving adversarial test: Teacher is relieved -> Old school teaching assignment check returns false (403)', async () => {
  const origFindOne = TeachingAssignment.findOne;

  // Assignments were expired to TRANSFERRED during relieving
  TeachingAssignment.findOne = async (query) => {
    // Only ACTIVE queries succeed per TeachingAssignmentSchema.statics.isTeacherAssigned
    if (query.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE) {
      return null; // Expired to TRANSFERRED!
    }
    return { _id: 'ta_transferred', status: TEACHING_ASSIGNMENT_STATUS.TRANSFERRED };
  };

  try {
    const isAssigned = await TeachingAssignment.isTeacherAssigned({
      teacherId: teacherUser._id,
      schoolId: schoolSourceId,
      sectionId: sectionSourceDoc._id,
    });
    assert.equal(isAssigned, false, 'Relieved teacher MUST NOT have active teaching assignment at old school');
  } finally {
    TeachingAssignment.findOne = origFindOne;
  }
});

await runAsyncTest('Scenario 8: Relieved teacher en-route adversarial test: Target school assignments check returns false', async () => {
  const origFindOne = TeachingAssignment.findOne;

  // At destination school, teacher has not yet joined and assignments are NOT auto-created
  TeachingAssignment.findOne = async (query) => {
    if (query.schoolId === schoolTargetId) {
      return null;
    }
    return null;
  };

  try {
    const isAssignedAtTarget = await TeachingAssignment.isTeacherAssigned({
      teacherId: teacherUser._id,
      schoolId: schoolTargetId,
      sectionId: 'target_section_99',
    });
    assert.equal(isAssignedAtTarget, false, 'Relieved teacher in-transit MUST NOT have pre-assigned target school access');
  } finally {
    TeachingAssignment.findOne = origFindOne;
  }
});

await runAsyncTest('Scenario 9: Post-joining authorization check: Old school access is strictly blocked, new school activated', async () => {
  const origFindOne = TeachingAssignment.findOne;

  TeachingAssignment.findOne = async (query) => {
    if (query.schoolId === schoolSourceId) return null; // Old school blocked permanently
    if (query.schoolId === schoolTargetId && query.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE) {
      return { _id: 'ta_new', schoolId: schoolTargetId, status: TEACHING_ASSIGNMENT_STATUS.ACTIVE };
    }
    return null;
  };

  try {
    const oldSchoolAccess = await TeachingAssignment.isTeacherAssigned({
      teacherId: teacherUser._id,
      schoolId: schoolSourceId,
      sectionId: sectionSourceDoc._id,
    });
    const newSchoolAccess = await TeachingAssignment.isTeacherAssigned({
      teacherId: teacherUser._id,
      schoolId: schoolTargetId,
      sectionId: 'target_sec_01',
    });

    assert.equal(oldSchoolAccess, false, 'Old school access must remain 100% blocked');
    assert.equal(newSchoolAccess, true, 'New school assignment must succeed once assigned');
  } finally {
    TeachingAssignment.findOne = origFindOne;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 3: SOURCE HM & DESTINATION HM SCOPE, IDOR & ANTI-BOLA (Scenarios 10-14)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n--- Group 3: Scope, IDOR & Anti-BOLA Enforcements ---');

await runAsyncTest('Scenario 10: Source HM can query outgoing transfers (direction=outgoing)', async () => {
  const origFind = TransferRequest.find;
  const origCount = TransferRequest.countDocuments;

  let appliedFilter = null;
  TransferRequest.find = (filter) => {
    appliedFilter = filter;
    return createMockQueryChain([{ _id: 'tr_out_01', fromSchoolId: schoolSourceId }]);
  };
  TransferRequest.countDocuments = async () => 1;

  const req = { user: sourceHM, query: { direction: 'outgoing' } };
  const res = createMockResponse();

  try {
    await handleGetTransfers(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(appliedFilter.fromSchoolId, schoolSourceId);
  } finally {
    TransferRequest.find = origFind;
    TransferRequest.countDocuments = origCount;
  }
});

await runAsyncTest('Scenario 11: Destination HM can query incoming transfers (direction=incoming)', async () => {
  const origFind = TransferRequest.find;
  const origCount = TransferRequest.countDocuments;

  let appliedFilter = null;
  TransferRequest.find = (filter) => {
    appliedFilter = filter;
    return createMockQueryChain([{ _id: 'tr_in_01', toSchoolId: schoolTargetId }]);
  };
  TransferRequest.countDocuments = async () => 1;

  const req = { user: destinationHM, query: { direction: 'incoming' } };
  const res = createMockResponse();

  try {
    await handleGetTransfers(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(appliedFilter.toSchoolId, schoolTargetId);
  } finally {
    TransferRequest.find = origFind;
    TransferRequest.countDocuments = origCount;
  }
});

await runAsyncTest('Scenario 12: Scope guard (BOLA): HM attempting to query foreign school transfers receives 403', async () => {
  const req = {
    user: sourceHM,
    query: { fromSchoolId: schoolForeignId }, // Foreign school requested
  };
  const res = createMockResponse();

  await handleGetTransfers(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message.includes('Head Masters can only query transfer records involving their own school'), true);
});

await runAsyncTest('Scenario 13: Single transfer IDOR: GET /transfers/:id rejects foreign HM with 403 Forbidden', async () => {
  const origFindById = TransferRequest.findById;
  TransferRequest.findById = () =>
    createMockQueryChain({
      _id: '507f1f77bcf86cd799439099',
      fromSchoolId: { _id: schoolSourceId },
      toSchoolId: { _id: schoolTargetId },
    });

  // Foreign HM attempts to inspect transfer between School Source and School Target
  const req = { user: foreignHM, params: { id: '507f1f77bcf86cd799439099' } };
  const res = createMockResponse();

  try {
    await handleGetTransferById(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message.includes('You can only view transfer records involving your assigned school'), true);
  } finally {
    TransferRequest.findById = origFindById;
  }
});

await runAsyncTest('Scenario 14: Cross-town Admin transfer is rejected with 403 Forbidden', async () => {
  const origFindById = User.findById;
  const origSchoolFindById = School.findById;
  const origTransferFindOne = TransferRequest.findOne;

  User.findById = () => ({
    populate: () => Promise.resolve({
      ...teacherUser,
      schoolId: { _id: schoolSourceId, townId: townNorthId },
    }),
  });
  School.findById = () => ({
    lean: () => Promise.resolve({ _id: schoolForeignId, townId: townSouthId }), // Different town!
  });
  TransferRequest.findOne = () => ({
    lean: () => Promise.resolve(null),
  });

  const req = {
    user: townAdmin, // Admin belongs to townNorthId
    body: {
      teacherUserId: teacherUser._id,
      targetSchoolId: schoolForeignId, // Located in townSouthId
      reason: 'Attempted cross-town transfer',
    },
  };
  const res = createMockResponse();

  try {
    await handleInitiateTransfer(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message.includes('ADMIN actors can only transfer teachers within their own town jurisdiction'), true);
  } finally {
    User.findById = origFindById;
    School.findById = origSchoolFindById;
    TransferRequest.findOne = origTransferFindOne;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 4: CONCURRENCY, IN-FLIGHT GUARDS & ORPHAN CLEANUP (Scenarios 15-18)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n--- Group 4: Concurrency, In-Flight Guards & Orphan Cleanup ---');

await runAsyncTest('Scenario 15: Duplicate in-flight transfer initiation for same teacher is rejected with 400', async () => {
  const origFindById = User.findById;
  const origSchoolFindById = School.findById;
  const origTransferFindOne = TransferRequest.findOne;

  User.findById = () => ({
    populate: () => Promise.resolve(teacherUser),
  });
  School.findById = () => ({
    lean: () => Promise.resolve(targetSchoolDoc),
  });
  // Active transfer already found in database
  TransferRequest.findOne = () => ({
    lean: () => Promise.resolve({
      _id: 'existing_transfer_01',
      status: TRANSFER_STATUS.APPROVED,
    }),
  });

  const req = {
    user: townAdmin,
    body: {
      teacherUserId: teacherUser._id,
      targetSchoolId: schoolTargetId,
      reason: 'Attempting duplicate overlapping transfer',
    },
  };
  const res = createMockResponse();

  try {
    await handleInitiateTransfer(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message.includes('Teacher already has an active transfer directive in progress'), true);
  } finally {
    User.findById = origFindById;
    School.findById = origSchoolFindById;
    TransferRequest.findOne = origTransferFindOne;
  }
});

await runAsyncTest('Scenario 16: Concurrency race condition on relieving: duplicate call handled with 409 Conflict', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origStartSession = mongoose.startSession;

  let sessionAborted = false;
  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => { sessionAborted = true; },
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.APPROVED,
          fromSchoolId: { _id: schoolSourceId },
          toSchoolId: { _id: schoolTargetId },
          teacherUserId: { _id: teacherUser._id },
        }),
      }),
    }),
  });

  // Concurrent request already transitioned the record -> returns null
  TransferRequest.findOneAndUpdate = async () => null;

  const req = {
    user: sourceHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { clearanceCertified: true },
  };
  const res = createMockResponse();

  try {
    await handleRelieveTeacher(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message.includes('Concurrent modification conflict'), true);
    assert.equal(sessionAborted, true);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 17: Concurrency race condition on joining: duplicate call handled with 409 Conflict', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origStartSession = mongoose.startSession;

  let sessionAborted = false;
  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => { sessionAborted = true; },
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.RELIEVED,
          fromSchoolId: { _id: schoolSourceId },
          toSchoolId: { _id: schoolTargetId },
          teacherUserId: { _id: teacherUser._id },
        }),
      }),
    }),
  });

  TransferRequest.findOneAndUpdate = async () => null;

  const req = {
    user: destinationHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { joiningDate: '2026-09-22', remarks: 'Duplicate click' },
  };
  const res = createMockResponse();

  try {
    await handleApproveJoining(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message.includes('Concurrent modification conflict'), true);
    assert.equal(sessionAborted, true);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 18: Orphan class teacher cleanup: Section.classTeacherId set to null on relieving', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origTeachingUpdateMany = TeachingAssignment.updateMany;
  const origSectionUpdateMany = Section.updateMany;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.APPROVED,
          fromSchoolId: { _id: schoolSourceId },
          toSchoolId: { _id: schoolTargetId },
          teacherUserId: { _id: teacherUser._id },
        }),
      }),
    }),
  });

  TransferRequest.findOneAndUpdate = async (filter, update) => ({
    _id: '507f1f77bcf86cd799439011',
    status: update.$set.status,
  });

  TeachingAssignment.updateMany = async () => ({ modifiedCount: 1 });

  let sectionUpdateFilter = null;
  let sectionUpdateOperation = null;
  Section.updateMany = async (filter, update) => {
    sectionUpdateFilter = filter;
    sectionUpdateOperation = update;
    return { modifiedCount: 1 };
  };

  AuditLog.create = async () => [{ _id: 'audit_18' }];

  const req = {
    user: sourceHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { clearanceCertified: true },
  };
  const res = createMockResponse();

  try {
    await handleRelieveTeacher(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(sectionUpdateFilter.schoolId, schoolSourceId);
    assert.equal(sectionUpdateFilter.classTeacherId, teacherUser._id);
    assert.equal(sectionUpdateOperation.$set.classTeacherId, null, 'classTeacherId MUST be unset to null');
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    TeachingAssignment.updateMany = origTeachingUpdateMany;
    Section.updateMany = origSectionUpdateMany;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 5: REJECTION, ADMIN REVIEW & CANCELLATION (Scenarios 19-23)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n--- Group 5: Rejection, Admin Review & Cancellation Workflows ---');

await runAsyncTest('Scenario 19: Destination HM rejects arrival -> transitions to REJECTED_BY_HM', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.RELIEVED,
          toSchoolId: { _id: schoolTargetId },
          fromSchoolId: { _id: schoolSourceId },
          teacherUserId: { _id: teacherUser._id, fullName: 'Sir Zafar' },
        }),
      }),
    }),
  });

  let newStatus = null;
  TransferRequest.findOneAndUpdate = async (filter, update) => {
    newStatus = update.$set.status;
    return { _id: '507f1f77bcf86cd799439011', status: newStatus };
  };

  AuditLog.create = async () => [{ _id: 'audit_19' }];

  const req = {
    user: destinationHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { rejectionReason: 'Subject quota discrepancy in officially presented order' },
  };
  const res = createMockResponse();

  try {
    await handleRejectJoining(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(newStatus, TRANSFER_STATUS.REJECTED_BY_HM);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 20: Rejected transfer cannot directly be approved for joining without admin review', async () => {
  const origFindById = TransferRequest.findById;
  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.REJECTED_BY_HM, // Under rejection!
          toSchoolId: { _id: schoolTargetId },
          fromSchoolId: { _id: schoolSourceId },
          teacherUserId: { _id: teacherUser._id },
        }),
      }),
    }),
  });

  const req = {
    user: destinationHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { joiningDate: '2026-09-22', remarks: 'Attempting to bypass rejection' },
  };
  const res = createMockResponse();

  try {
    await handleApproveJoining(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message.includes('required status is [RELIEVED, AWAITING_DESTINATION_HM]'), true);
  } finally {
    TransferRequest.findById = origFindById;
  }
});

await runAsyncTest('Scenario 21: Town Admin performs administrative review on rejected transfer (APPROVE decision)', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = async () => ({
    _id: '507f1f77bcf86cd799439011',
    status: TRANSFER_STATUS.REJECTED_BY_HM,
  });

  let reviewedStatus = null;
  TransferRequest.findOneAndUpdate = async (filter, update) => {
    reviewedStatus = update.$set.status;
    return { _id: '507f1f77bcf86cd799439011', status: reviewedStatus };
  };

  AuditLog.create = async () => [{ _id: 'audit_21' }];

  const req = {
    user: townAdmin,
    params: { id: '507f1f77bcf86cd799439011' },
    body: {
      decision: 'APPROVE',
      adminRemarks: 'Subject quota discrepancy investigated and approved by Deputy Director Education.',
      officialOrderNumber: 'DMC/CONFIRM/2026/102',
    },
  };
  const res = createMockResponse();

  try {
    await handleAdminReview(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(reviewedStatus, TRANSFER_STATUS.APPROVED);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 22: Administrative cancellation before relieving transitions to CANCELLED', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = async () => ({
    _id: '507f1f77bcf86cd799439011',
    status: TRANSFER_STATUS.APPROVED, // Not yet relieved
  });

  let cancelledStatus = null;
  TransferRequest.findOneAndUpdate = async (filter, update) => {
    cancelledStatus = update.$set.status;
    return { _id: '507f1f77bcf86cd799439011', status: cancelledStatus };
  };

  AuditLog.create = async () => [{ _id: 'audit_22' }];

  const req = {
    user: townAdmin,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { cancellationReason: 'Posting cancelled due to administrative seat freeze' },
  };
  const res = createMockResponse();

  try {
    await handleCancelTransfer(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(cancelledStatus, TRANSFER_STATUS.CANCELLED);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 23: Post-relieving cancellation is strictly blocked with 400 Bad Request', async () => {
  const origFindById = TransferRequest.findById;
  TransferRequest.findById = async () => ({
    _id: '507f1f77bcf86cd799439011',
    status: TRANSFER_STATUS.RELIEVED, // Already relieved!
  });

  const req = {
    user: townAdmin,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { cancellationReason: 'Late cancellation attempt' },
  };
  const res = createMockResponse();

  try {
    await handleCancelTransfer(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message.includes('Cannot cancel transfer after faculty has already been relieved'), true);
  } finally {
    TransferRequest.findById = origFindById;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 6: AUDIT TRAIL COMPLETENESS & RECORD IMMUTABILITY (Scenarios 24-25)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n--- Group 6: Audit Trail Completeness & Record Immutability ---');

await runAsyncTest('Scenario 24: Comprehensive audit log event generated with verified previousState and newState', async () => {
  const origFindById = TransferRequest.findById;
  const origFindOneAndUpdate = TransferRequest.findOneAndUpdate;
  const origTeachingUpdate = TeachingAssignment.updateMany;
  const origSectionUpdate = Section.updateMany;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
  });

  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.APPROVED,
          fromSchoolId: { _id: schoolSourceId },
          toSchoolId: { _id: schoolTargetId },
          teacherUserId: { _id: teacherUser._id, fullName: 'Sir Zafar Iqbal' },
        }),
      }),
    }),
  });

  TransferRequest.findOneAndUpdate = async (filter, update) => ({
    _id: '507f1f77bcf86cd799439011',
    status: update.$set.status,
  });

  TeachingAssignment.updateMany = async () => ({ modifiedCount: 3 });
  Section.updateMany = async () => ({ modifiedCount: 1 });

  let auditEntry = null;
  AuditLog.create = async ([entry]) => {
    auditEntry = entry;
    return [entry];
  };

  const req = {
    user: sourceHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: {
      clearanceCertified: true,
      relievingOrderNumber: 'REL/ORDER/099',
      relievingRemarks: 'Clearance verified and documented',
    },
    ip: '192.168.1.50',
    headers: { 'user-agent': 'Mozilla/5.0 HM Console' },
  };
  const res = createMockResponse();

  try {
    await handleRelieveTeacher(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(auditEntry.action, 'TEACHER_TRANSFER_RELIEVED');
    assert.equal(auditEntry.previousState.status, TRANSFER_STATUS.APPROVED);
    assert.equal(auditEntry.newState.status, TRANSFER_STATUS.RELIEVED);
    assert.equal(auditEntry.newState.expiredAssignments, 3);
    assert.equal(auditEntry.newState.clearedClassTeacherSections, 1);
    assert.equal(auditEntry.actorId, sourceHM._id);
  } finally {
    TransferRequest.findById = origFindById;
    TransferRequest.findOneAndUpdate = origFindOneAndUpdate;
    TeachingAssignment.updateMany = origTeachingUpdate;
    Section.updateMany = origSectionUpdate;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
  }
});

await runAsyncTest('Scenario 25: Terminal state immutability: Completed JOINED transfer rejects all mutations', async () => {
  const origFindById = TransferRequest.findById;
  TransferRequest.findById = () => ({
    populate: () => ({
      populate: () => ({
        populate: async () => ({
          _id: '507f1f77bcf86cd799439011',
          status: TRANSFER_STATUS.JOINED, // Terminal!
          fromSchoolId: { _id: schoolSourceId },
          toSchoolId: { _id: schoolTargetId },
          teacherUserId: { _id: teacherUser._id },
        }),
      }),
    }),
  });

  const reqRelieve = {
    user: sourceHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { clearanceCertified: true },
  };
  const resRelieve = createMockResponse();

  const reqJoin = {
    user: destinationHM,
    params: { id: '507f1f77bcf86cd799439011' },
    body: { joiningDate: '2026-09-22', remarks: 'Re-joining' },
  };
  const resJoin = createMockResponse();

  try {
    await handleRelieveTeacher(reqRelieve, resRelieve);
    assert.equal(resRelieve.statusCode, 400);

    await handleApproveJoining(reqJoin, resJoin);
    assert.equal(resJoin.statusCode, 400);
  } finally {
    TransferRequest.findById = origFindById;
  }
});

console.log(`\n======================================================`);
console.log(`🏁 HM STEP 5 TEST SUITE COMPLETED: ${passedTests}/${totalTests} TESTS PASSED`);
console.log(`======================================================\n`);
