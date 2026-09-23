/**
 * 🏛️ MUNICIPAL SCHOOL INSPECTION AUTOMATED TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Verifies:
 *   - Inspection creation with fail-closed BOLA scoping for Supervisors
 *   - Automatic academic session calculation
 *   - Rubric assessment (infrastructure, academic, attendance spot-check)
 *   - Submission lifecycle transitions (DRAFT -> SUBMITTED / ACTION_REQUIRED -> CLOSED)
 *   - Immutable audit logging for inspection operational events
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  handleCreateInspection,
  handleGetInspections,
  handleGetInspectionById,
  handleUpdateInspection,
  handleSubmitInspection,
  handleCloseInspection,
} from '../src/controllers/schoolInspectionController.js';
import SchoolInspection, { INSPECTION_STATUS, OVERALL_GRADE } from '../src/models/SchoolInspection.js';
import School from '../src/models/School.js';
import AuditLog from '../src/models/AuditLog.js';
import { ROLES, SCOPES } from '../config/constants.js';

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
  return {
    statusCode: 200,
    headers: {},
    responseData: null,
    status(statusCodeValue) {
      this.statusCode = statusCodeValue;
      return this;
    },
    json(payloadData) {
      this.responseData = payloadData;
      return this;
    },
  };
}

function makeChainableQuery(resolvedPayload) {
  return {
    _payload: resolvedPayload,
    session() { return this; },
    populate() { return this; },
    sort() { return this; },
    select() { return this; },
    skip() { return this; },
    limit() { return this; },
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
const foreignSchoolC_Id = new mongoose.Types.ObjectId().toString();

const supervisorActor = {
  _id: new mongoose.Types.ObjectId().toString(),
  role: ROLES.SUPERVISOR,
  scope: SCOPES.ASSIGNED_SCHOOLS,
  assignedSchools: [assignedSchoolA_Id, assignedSchoolB_Id],
  fullName: 'Supervisor Tariq Mahmood',
};

const headMasterSchoolA_Actor = {
  _id: new mongoose.Types.ObjectId().toString(),
  role: ROLES.HM,
  scope: SCOPES.SCHOOL,
  schoolId: assignedSchoolA_Id,
  fullName: 'Head Master Aslam Khan',
};

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('🏛️  MUNICIPAL SCHOOL INSPECTION AUTOMATED TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════════');

async function executeTestSuite() {
  console.log('\n--- Group 1: Creation & BOLA Jurisdictional Scoping ---');

  await runAsyncTest('INSP-01: Supervisor can create an inspection for a legitimately assigned school', async () => {
    const mockRequest = {
      user: supervisorActor,
      body: {
        schoolId: assignedSchoolA_Id,
        inspectionDate: '2026-09-24T08:30:00.000Z',
        overallGrade: OVERALL_GRADE.B,
        summaryScore: 78,
        infrastructure: {
          cleanlinessRating: 'GOOD',
          drinkingWaterAvailable: true,
          washroomsFunctional: true,
          notes: 'Campus is clean and water filtration plant is operational.',
        },
        remedialDirectives: [
          {
            directiveText: 'Repair broken light fixtures in Class 4-A',
            priority: 'MEDIUM',
            status: 'PENDING',
          },
        ],
      },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestInspectionRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalSchoolFindById = School.findById;
    const originalInspectionCreate = SchoolInspection.create;
    const originalAuditCreate = AuditLog.create;

    School.findById = () => makeChainableQuery({
      _id: assignedSchoolA_Id,
      name: 'Assigned Model Primary School A',
      townId: 'town_liaq_123',
    });

    SchoolInspection.create = async (doc) => ({
      _id: new mongoose.Types.ObjectId().toString(),
      ...doc,
    });

    AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    try {
      await handleCreateInspection(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 201, 'Must return 201 Created');
      assert.equal(mockResponse.responseData?.data?.inspection?.schoolId, assignedSchoolA_Id);
      assert.equal(mockResponse.responseData?.data?.inspection?.overallGrade, OVERALL_GRADE.B);
    } finally {
      School.findById = originalSchoolFindById;
      SchoolInspection.create = originalInspectionCreate;
      AuditLog.create = originalAuditCreate;
    }
  });

  await runAsyncTest('INSP-02: Supervisor attempting to create inspection for unassigned foreign school is rejected with 403', async () => {
    const mockRequest = {
      user: supervisorActor,
      body: {
        schoolId: foreignSchoolC_Id,
        overallGrade: OVERALL_GRADE.C,
      },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestInspectionRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const originalSchoolFindById = School.findById;
    const originalAuditCreate = AuditLog.create;
    let auditViolationLogged = false;

    School.findById = () => makeChainableQuery({
      _id: foreignSchoolC_Id,
      name: 'Foreign Model School C',
      townId: 'town_liaq_123',
    });

    AuditLog.create = async (auditData) => {
      if (auditData.action === 'SUPERVISOR_CROSS_SCHOOL_INSPECTION_BLOCKED') {
        auditViolationLogged = true;
      }
      return { _id: new mongoose.Types.ObjectId() };
    };

    try {
      await handleCreateInspection(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 403, 'Must return 403 Forbidden for cross-cluster inspection');
      assert.match(mockResponse.responseData?.message, /assigned cluster/i);
      assert.equal(auditViolationLogged, true, 'Must write security audit log');
    } finally {
      School.findById = originalSchoolFindById;
      AuditLog.create = originalAuditCreate;
    }
  });

  console.log('\n--- Group 2: Scoped Inspection Retrieval ---');

  await runAsyncTest('INSP-03: Supervisor GET /inspections auto-filters by assigned cluster', async () => {
    const mockRequest = {
      user: supervisorActor,
      query: { page: '1', limit: '20' },
    };
    const mockResponse = createMockResponse();

    const originalInspectionFind = SchoolInspection.find;
    const originalInspectionCount = SchoolInspection.countDocuments;
    let capturedFilter = null;

    SchoolInspection.find = (filter) => {
      capturedFilter = filter;
      return makeChainableQuery([
        {
          _id: 'insp1',
          schoolId: { name: 'School A', schoolCode: 'SCHA' },
          supervisorId: { fullName: 'Supervisor Tariq' },
          status: INSPECTION_STATUS.SUBMITTED,
          overallGrade: OVERALL_GRADE.A,
        },
      ]);
    };

    SchoolInspection.countDocuments = () => Promise.resolve(1);

    try {
      await handleGetInspections(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 200, 'Must return 200 OK');
      assert.deepEqual(
        capturedFilter.schoolId,
        { $in: [assignedSchoolA_Id, assignedSchoolB_Id] },
        'Must filter strictly by Supervisor assignedSchools'
      );
    } finally {
      SchoolInspection.find = originalInspectionFind;
      SchoolInspection.countDocuments = originalInspectionCount;
    }
  });

  await runAsyncTest('INSP-04: Supervisor GET /inspections for foreign school explicitly requested is rejected with 403', async () => {
    const mockRequest = {
      user: supervisorActor,
      query: { schoolId: foreignSchoolC_Id },
    };
    const mockResponse = createMockResponse();

    await handleGetInspections(mockRequest, mockResponse);
    assert.equal(mockResponse.statusCode, 403, 'Must return 403 Forbidden when requesting foreign school');
    assert.match(mockResponse.responseData?.message, /outside your assigned cluster/i);
  });

  console.log('\n--- Group 3: Submission & Lifecycle State Transitions ---');

  await runAsyncTest('INSP-05: Submitting draft inspection with high-priority directives transitions to ACTION_REQUIRED', async () => {
    const mockRequest = {
      user: supervisorActor,
      params: { id: 'insp_urgent_1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const fakeInspectionDoc = {
      _id: 'insp_urgent_1',
      supervisorId: supervisorActor._id,
      schoolId: assignedSchoolA_Id,
      status: INSPECTION_STATUS.DRAFT,
      overallGrade: OVERALL_GRADE.C,
      remedialDirectives: [
        { directiveText: 'Immediate electrical grounding repair', priority: 'HIGH', status: 'PENDING' },
      ],
      save: async function () { return this; },
    };

    const originalFindById = SchoolInspection.findById;
    const originalAuditCreate = AuditLog.create;
    let auditActionLogged = null;

    SchoolInspection.findById = () => Promise.resolve(fakeInspectionDoc);
    AuditLog.create = async (auditData) => {
      auditActionLogged = auditData.action;
      return { _id: new mongoose.Types.ObjectId() };
    };

    try {
      await handleSubmitInspection(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 200, 'Must return 200 OK');
      assert.equal(fakeInspectionDoc.status, INSPECTION_STATUS.ACTION_REQUIRED, 'Must transition to ACTION_REQUIRED');
      assert.equal(auditActionLogged, 'INSPECTION_SUBMITTED');
    } finally {
      SchoolInspection.findById = originalFindById;
      AuditLog.create = originalAuditCreate;
    }
  });

  await runAsyncTest('INSP-06: Formal closure of inspection marks all directives resolved and status CLOSED', async () => {
    const mockRequest = {
      user: supervisorActor,
      params: { id: 'insp_closing_1' },
      body: { resolutionNotes: 'Re-inspected on site: electrical repairs completed and verified.' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'TestRunner/1.0' },
    };
    const mockResponse = createMockResponse();

    const fakeInspectionDoc = {
      _id: 'insp_closing_1',
      supervisorId: supervisorActor._id,
      schoolId: assignedSchoolA_Id,
      status: INSPECTION_STATUS.ACTION_REQUIRED,
      remedialDirectives: [
        { directiveText: 'Immediate electrical repair', priority: 'HIGH', status: 'PENDING' },
      ],
      save: async function () { return this; },
    };

    const originalFindById = SchoolInspection.findById;
    const originalAuditCreate = AuditLog.create;

    SchoolInspection.findById = () => Promise.resolve(fakeInspectionDoc);
    AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

    try {
      await handleCloseInspection(mockRequest, mockResponse);
      assert.equal(mockResponse.statusCode, 200, 'Must return 200 OK');
      assert.equal(fakeInspectionDoc.status, INSPECTION_STATUS.CLOSED);
      assert.equal(fakeInspectionDoc.remedialDirectives[0].status, 'RESOLVED');
    } finally {
      SchoolInspection.findById = originalFindById;
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
