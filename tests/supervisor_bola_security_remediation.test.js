/**
 * 🏛️ SUPERVISOR BOLA / IDOR SECURITY REMEDIATION TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Dedicated security verification for:
 *   - SEC-CRIT-03: authorizeScope.js empty-array silent bypass for Supervisors
 *   - SEC-HIGH-04: handleGetSchoolById unassigned school access in schoolController.js
 *   - SEC-HIGH-05: handleExportStudentsCsv unscoped student directory export in exportController.js
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { authorizeScope } from '../src/middlewares/authorizeScope.js';
import { handleGetSchoolById } from '../src/controllers/schoolController.js';
import { handleExportStudentsCsv } from '../src/controllers/exportController.js';
import School from '../src/models/School.js';
import User from '../src/models/User.js';
import StudentProfile from '../src/models/StudentProfile.js';
import AuditLog from '../src/models/AuditLog.js';
import { ROLES, SCOPES, STUDENT_STATUS } from '../config/constants.js';

let totalTestsExecuted = 0;
let totalTestsPassed = 0;

async function runAsyncTest(testDescription, testExecutionFunction) {
  totalTestsExecuted++;
  try {
    await testExecutionFunction();
    totalTestsPassed++;
    console.log(`  ✅ PASS [${totalTestsExecuted}]: ${testDescription}`);
  } catch (executionError) {
    console.error(`  ❌ FAIL [${totalTestsExecuted}]: ${testDescription}`);
    console.error(executionError);
    process.exit(1);
  }
}

function createMockResponse() {
  const mockResponseObject = {
    statusCode: 200,
    headers: {},
    responseData: null,
    isEnded: false,
    writtenChunks: [],
    status(statusCodeValue) {
      this.statusCode = statusCodeValue;
      return this;
    },
    json(payloadData) {
      this.responseData = payloadData;
      this.isEnded = true;
      return this;
    },
    setHeader(headerName, headerValue) {
      this.headers[headerName] = headerValue;
      return this;
    },
    write(chunkData) {
      this.writtenChunks.push(chunkData);
      return true;
    },
    end() {
      this.isEnded = true;
      return this;
    },
  };
  return mockResponseObject;
}

function makeChainableQuery(resolvedPayload) {
  return {
    _payload: resolvedPayload,
    session() { return this; },
    populate() { return this; },
    sort() { return this; },
    select() { return this; },
    lean() { return Promise.resolve(this._payload); },
    then(onFulfilled, onRejected) {
      return Promise.resolve(this._payload).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve(this._payload).catch(onRejected);
    },
  };
}

// ─── Test Fixtures ────────────────────────────────────────────────────────────
const assignedSchoolA_Id = new mongoose.Types.ObjectId().toString();
const assignedSchoolB_Id = new mongoose.Types.ObjectId().toString();
const unassignedSchoolC_Id = new mongoose.Types.ObjectId().toString();

const supervisorWithClusterActor = {
  _id: new mongoose.Types.ObjectId().toString(),
  role: ROLES.SUPERVISOR,
  scope: SCOPES.ASSIGNED_SCHOOLS,
  assignedSchools: [assignedSchoolA_Id, assignedSchoolB_Id],
  fullName: 'Supervisor Tariq Mahmood',
};

const supervisorWithEmptyClusterActor = {
  _id: new mongoose.Types.ObjectId().toString(),
  role: ROLES.SUPERVISOR,
  scope: SCOPES.ASSIGNED_SCHOOLS,
  assignedSchools: [],
  fullName: 'Supervisor Without Assigned Cluster',
};

const headMasterSchoolA_Actor = {
  _id: new mongoose.Types.ObjectId().toString(),
  role: ROLES.HM,
  scope: SCOPES.SCHOOL,
  schoolId: assignedSchoolA_Id,
  fullName: 'Head Master Aslam Khan',
};

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('🏛️  SUPERVISOR BOLA / IDOR SECURITY REMEDIATION TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════════');

async function executeTestSuite() {
  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 1: SEC-CRIT-03: authorizeScope.js Empty-Array Fail-Closed Invariant
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 1: SEC-CRIT-03 authorizeScope.js Empty Array Fail-Closed ---');

  await runAsyncTest('SEC-CRIT-03.1: Supervisor with empty assignedSchools [] accessing target school is rejected with 403', async () => {
    const mockRequest = {
      user: supervisorWithEmptyClusterActor,
      params: { schoolId: assignedSchoolA_Id },
      query: {},
      body: {},
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();
    let nextCalled = false;

    // Mock AuditLog.create
    const originalAuditCreate = AuditLog.create;
    AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    try {
      await authorizeScope(mockRequest, mockResponse, () => { nextCalled = true; });
      assert.equal(nextCalled, false, 'nextFunction must not be called for unassigned supervisor');
      assert.equal(mockResponse.statusCode, 403, 'Must return 403 Forbidden');
      assert.match(mockResponse.responseData?.message, /not assigned to your supervisory roster/i);
    } finally {
      AuditLog.create = originalAuditCreate;
    }
  });

  await runAsyncTest('SEC-CRIT-03.2: Supervisor accessing unassigned school is rejected with 403', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      params: { schoolId: unassignedSchoolC_Id },
      query: {},
      body: {},
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();
    let nextCalled = false;

    const originalAuditCreate = AuditLog.create;
    AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    try {
      await authorizeScope(mockRequest, mockResponse, () => { nextCalled = true; });
      assert.equal(nextCalled, false, 'nextFunction must not be called');
      assert.equal(mockResponse.statusCode, 403, 'Must return 403 Forbidden');
    } finally {
      AuditLog.create = originalAuditCreate;
    }
  });

  await runAsyncTest('SEC-CRIT-03.3: Supervisor accessing legitimately assigned school is granted access (calls next)', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      params: { schoolId: assignedSchoolA_Id },
      query: {},
      body: {},
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();
    let nextCalled = false;

    await authorizeScope(mockRequest, mockResponse, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'nextFunction must be called for legitimately assigned school');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 2: SEC-HIGH-04: handleGetSchoolById Scope Check & Audit Trail
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 2: SEC-HIGH-04 handleGetSchoolById Scoping & Audit Trail ---');

  await runAsyncTest('SEC-HIGH-04.1: Supervisor accessing unassigned school via handleGetSchoolById receives 403', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      params: { id: unassignedSchoolC_Id },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalFindById = School.findById;
    const originalAuditCreate = AuditLog.create;
    let auditLogged = false;

    School.findById = () => makeChainableQuery({
      _id: unassignedSchoolC_Id,
      name: 'Unassigned Model School C',
      townId: { _id: 'town123', name: 'Liaquatabad' },
    });

    AuditLog.create = async (auditPayload) => {
      if (auditPayload.action === 'SUPERVISOR_CROSS_SCHOOL_VIEW_BLOCKED') {
        auditLogged = true;
      }
      return { _id: new mongoose.Types.ObjectId() };
    };

    try {
      await handleGetSchoolById(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 403, 'Must return 403 Forbidden');
      assert.match(mockResponse.responseData?.message, /supervisory jurisdiction/i);
      assert.equal(auditLogged, true, 'Must write SUPERVISOR_CROSS_SCHOOL_VIEW_BLOCKED audit entry');
    } finally {
      School.findById = originalFindById;
      AuditLog.create = originalAuditCreate;
    }
  });

  await runAsyncTest('SEC-HIGH-04.2: Supervisor accessing assigned school via handleGetSchoolById receives 200 and faculty roster', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      params: { id: assignedSchoolA_Id },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalFindById = School.findById;
    const originalUserFind = User.find;
    const originalUserFindOne = User.findOne;

    School.findById = () => makeChainableQuery({
      _id: assignedSchoolA_Id,
      name: 'Assigned Model Primary School A',
      schoolCode: 'AMPSA',
      townId: { _id: 'town123', name: 'Liaquatabad' },
    });

    User.find = () => makeChainableQuery([
      { _id: 'teacher1', fullName: 'Teacher Fatima', role: ROLES.TEACHER },
      { _id: 'teacher2', fullName: 'Teacher Bilal', role: ROLES.TEACHER },
    ]);

    User.findOne = () => makeChainableQuery({
      _id: 'hm1',
      fullName: 'Head Master Aslam Khan',
      role: ROLES.HM,
    });

    try {
      await handleGetSchoolById(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 200, 'Must return 200 OK');
      assert.equal(mockResponse.responseData?.data?.school?.name, 'Assigned Model Primary School A');
      assert.equal(mockResponse.responseData?.data?.school?.facultyTotal, 2);
    } finally {
      School.findById = originalFindById;
      User.find = originalUserFind;
      User.findOne = originalUserFindOne;
    }
  });

  await runAsyncTest('SEC-HIGH-04.3: HM accessing a foreign school via handleGetSchoolById receives 403', async () => {
    const mockRequest = {
      user: headMasterSchoolA_Actor,
      params: { id: unassignedSchoolC_Id },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalFindById = School.findById;
    School.findById = () => makeChainableQuery({
      _id: unassignedSchoolC_Id,
      name: 'Foreign School C',
      townId: { _id: 'town123', name: 'Liaquatabad' },
    });

    try {
      await handleGetSchoolById(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 403, 'Must return 403 Forbidden for cross-school HM inspection');
      assert.match(mockResponse.responseData?.message, /only inspect your own assigned school/i);
    } finally {
      School.findById = originalFindById;
    }
  });

  await runAsyncTest('SEC-HIGH-04.4: Malformed schoolId format in handleGetSchoolById is rejected with 400', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      params: { id: 'invalid-id-not-24-hex' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    await handleGetSchoolById(mockRequest, mockResponse);
    assert.equal(mockResponse.statusCode, 400, 'Must return 400 Bad Request');
    assert.match(mockResponse.responseData?.message, /invalid school id format/i);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 3: SEC-HIGH-05: handleExportStudentsCsv Scoping
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 3: SEC-HIGH-05 handleExportStudentsCsv Jurisdictional Scoping ---');

  await runAsyncTest('SEC-HIGH-05.1: HM attempting to export students from another school receives 403', async () => {
    const mockRequest = {
      user: headMasterSchoolA_Actor,
      query: { schoolId: unassignedSchoolC_Id },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    await handleExportStudentsCsv(mockRequest, mockResponse);
    assert.equal(mockResponse.statusCode, 403, 'Must reject HM requesting another school with 403');
    assert.match(mockResponse.responseData?.message, /belonging to your assigned school/i);
  });

  await runAsyncTest('SEC-HIGH-05.2: HM exporting students without schoolId param auto-scopes to own school', async () => {
    const mockRequest = {
      user: headMasterSchoolA_Actor,
      query: {},
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalProfileFind = StudentProfile.find;
    const originalAuditCreate = AuditLog.create;
    let capturedFilter = null;

    StudentProfile.find = (filterCriteria) => {
      capturedFilter = filterCriteria;
      return makeChainableQuery([
        {
          userId: { fullName: 'Student Ali', email: 'ali@school.edu.pk' },
          grNumber: 101,
          globalStudentId: 'MMHA-0101',
          schoolId: { name: 'Assigned Model Primary School A', schoolCode: 'AMPSA' },
        },
      ]);
    };

    AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    try {
      await handleExportStudentsCsv(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 200, 'Must return 200 OK');
      assert.equal(capturedFilter.schoolId, assignedSchoolA_Id, 'Must auto-scope query to HM schoolId');
    } finally {
      StudentProfile.find = originalProfileFind;
      AuditLog.create = originalAuditCreate;
    }
  });

  await runAsyncTest('SEC-HIGH-05.3: Supervisor with empty assignedSchools [] attempting export receives 403', async () => {
    const mockRequest = {
      user: supervisorWithEmptyClusterActor,
      query: {},
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    await handleExportStudentsCsv(mockRequest, mockResponse);
    assert.equal(mockResponse.statusCode, 403, 'Must reject Supervisor with empty cluster with 403');
    assert.match(mockResponse.responseData?.message, /no municipal schools assigned/i);
  });

  await runAsyncTest('SEC-HIGH-05.4: Supervisor attempting to export foreign school students receives 403', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      query: { schoolId: unassignedSchoolC_Id },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    await handleExportStudentsCsv(mockRequest, mockResponse);
    assert.equal(mockResponse.statusCode, 403, 'Must reject Supervisor requesting foreign school with 403');
    assert.match(mockResponse.responseData?.message, /outside your supervisory cluster/i);
  });

  await runAsyncTest('SEC-HIGH-05.5: Supervisor exporting students without schoolId param auto-scopes to assigned cluster', async () => {
    const mockRequest = {
      user: supervisorWithClusterActor,
      query: {},
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalProfileFind = StudentProfile.find;
    const originalAuditCreate = AuditLog.create;
    let capturedFilter = null;

    StudentProfile.find = (filterCriteria) => {
      capturedFilter = filterCriteria;
      return makeChainableQuery([
        {
          userId: { fullName: 'Student Zainab', email: 'zainab@school.edu.pk' },
          grNumber: 202,
          globalStudentId: 'AMPS-0202',
          schoolId: { name: 'Assigned Model Primary School A', schoolCode: 'AMPSA' },
        },
      ]);
    };

    AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    try {
      await handleExportStudentsCsv(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 200, 'Must return 200 OK');
      assert.deepEqual(
        capturedFilter.schoolId,
        { $in: [assignedSchoolA_Id, assignedSchoolB_Id] },
        'Must scope query strictly to Supervisor assignedSchools cluster'
      );
    } finally {
      StudentProfile.find = originalProfileFind;
      AuditLog.create = originalAuditCreate;
    }
  });

  console.log('\n===========================================================================');
  console.log(`ALL ${totalTestsPassed} / ${totalTestsExecuted} TESTS PASSED`);
  console.log('===========================================================================');
}

executeTestSuite().catch((unhandledError) => {
  console.error('Fatal Test Execution Error:', unhandledError);
  process.exit(1);
});
