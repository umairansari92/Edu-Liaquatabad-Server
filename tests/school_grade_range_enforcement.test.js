/**
 * 🏛️ SCHOOL GRADE RANGE ENFORCEMENT & ADVERSARIAL API BYPASS SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Mandate:
 * 1. Server-side validation of School gradeRange (lowestGrade to highestGrade).
 * 2. Complete rejection of malicious/adversarial API bypass requests attempting
 *    to create classes outside a school's designated grade boundary.
 * 3. Primary School (1-5) strictly accepts Class 1 to Class 5; rejects Class 6, 7, 8, etc.
 * 4. Secondary School (6-10) strictly accepts Class 6 to Class 10; rejects Class 1-5, 11+.
 * 5. Update operations are equally validated against school boundaries.
 * 6. Edge cases: minimum grade, maximum grade, duplicate grade, invalid types, fallback bounds.
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { ROLES } from '../config/constants.js';
import {
  handleCreateClass,
  handleUpdateClass,
} from '../src/controllers/academicController.js';
import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
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
    console.error(`  ✗ FAIL: ${testName}`);
    console.error(testError);
    throw testError;
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
    json(data) {
      this.body = data;
      return this;
    },
  };
  return mockResponse;
}

async function runSuite() {
  console.log('===========================================================================');
  console.log('🏛️ RUNNING SCHOOL GRADE RANGE ENFORCEMENT & API BYPASS TEST SUITE');
  console.log('===========================================================================');

  // Connect to database if not already connected
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  const primarySchoolId = new mongoose.Types.ObjectId();
  const secondarySchoolId = new mongoose.Types.ObjectId();
  const townId = new mongoose.Types.ObjectId();
  const organizationId = new mongoose.Types.ObjectId();
  const adminActor = {
    _id: new mongoose.Types.ObjectId(),
    fullName: 'Town Academic Administrator',
    role: ROLES.ADMIN,
  };

  try {
    // Setup Mock Schools in Database
    await School.create([
      {
        _id: primarySchoolId,
        organizationId,
        townId,
        name: 'Govt. Primary School Liaquatabad (Grade Range 1-5)',
        schoolCode: 'GPSL1',
        schoolType: 'PRIMARY',
        genderType: 'CO_EDUCATION',
        address: 'Block 2, Liaquatabad',
        gradeRange: { lowestGrade: '1', highestGrade: '5' },
        status: 'ACTIVE',
      },
      {
        _id: secondarySchoolId,
        organizationId,
        townId,
        name: 'Govt. Boys Secondary School Liaquatabad (Grade Range 6-10)',
        schoolCode: 'GBSS1',
        schoolType: 'SECONDARY',
        genderType: 'BOYS',
        address: 'Block 5, Liaquatabad',
        gradeRange: { lowestGrade: '6', highestGrade: '10' },
        status: 'ACTIVE',
      },
    ]);

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PRIMARY SCHOOL: Valid Minimum Boundary (Grade 1)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Create Class at minimum boundary (Grade 1 in Primary School 1-5) -> 201 Created', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: primarySchoolId.toString(),
          name: 'Class 1',
          code: 'CL-01',
          numericGrade: 1,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 201);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(mockResponse.body.data.class.numericGrade, 1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. PRIMARY SCHOOL: Valid Maximum Boundary (Grade 5)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Create Class at maximum boundary (Grade 5 in Primary School 1-5) -> 201 Created', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: primarySchoolId.toString(),
          name: 'Class 5',
          code: 'CL-05',
          numericGrade: 5,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 201);
      assert.strictEqual(mockResponse.body.success, true);
      assert.strictEqual(mockResponse.body.data.class.numericGrade, 5);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. ADVERSARIAL API BYPASS: Out-of-bounds Class (Grade 8 in Primary School)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Adversarial API Bypass: Direct POST with Grade 8 for Primary School -> Rejected HTTP 400', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: primarySchoolId.toString(),
          name: 'Class 8 Malicious Insertion',
          code: 'CL-08',
          numericGrade: 8,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /outside the allowed grade range/i);

      // Verify no record was created in MongoDB
      const insertedClass = await Class.findOne({ schoolId: primarySchoolId, numericGrade: 8 });
      assert.strictEqual(insertedClass, null);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. BOUNDARY CHECK: Below Minimum (Grade 0)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Boundary Check: Grade 0 (below minimum 1) -> Rejected HTTP 400', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: primarySchoolId.toString(),
          name: 'Class 0 Invalid',
          code: 'CL-00',
          numericGrade: 0,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /outside the allowed grade range/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. BOUNDARY CHECK: Just Above Maximum (Grade 6 in Primary School)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Boundary Check: Grade 6 (one above max 5) in Primary School -> Rejected HTTP 400', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: primarySchoolId.toString(),
          name: 'Class 6 Invalid',
          code: 'CL-06',
          numericGrade: 6,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /outside the allowed grade range/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. SECONDARY SCHOOL: Valid Minimum Boundary (Grade 6)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Secondary School: Valid minimum Grade 6 -> 201 Created', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: secondarySchoolId.toString(),
          name: 'Class 6 Secondary',
          code: 'CL-SEC-06',
          numericGrade: 6,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 201);
      assert.strictEqual(mockResponse.body.success, true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. SECONDARY SCHOOL: Adversarial API Attempt (Grade 4 in Secondary School)
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Secondary School: Adversarial attempt to create Grade 4 -> Rejected HTTP 400', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: secondarySchoolId.toString(),
          name: 'Class 4 Secondary Malicious',
          code: 'CL-SEC-04',
          numericGrade: 4,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /outside the allowed grade range/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. DUPLICATE CLASS PREVENTION
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Duplicate Class Prevention: Re-creating Grade 1 in Primary School -> 409 Conflict', async () => {
      const mockRequest = {
        user: adminActor,
        body: {
          schoolId: primarySchoolId.toString(),
          name: 'Class 1 Duplicate',
          code: 'CL-01-DUP',
          numericGrade: 1,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleCreateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 409);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /already exists in this school/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. CLASS UPDATE: Valid Grade within School Range
    // ─────────────────────────────────────────────────────────────────────────
    let createdClassRecord = null;
    await runAsyncTest('Class Update: Updating class to valid grade (Grade 2 within 1-5) -> 200 OK', async () => {
      createdClassRecord = await Class.create({
        schoolId: primarySchoolId,
        name: 'Class Temp',
        code: 'CL-TEMP',
        numericGrade: 3,
        status: 'ACTIVE',
      });

      const mockRequest = {
        user: adminActor,
        params: { id: createdClassRecord._id.toString() },
        body: {
          name: 'Class 2 Updated',
          numericGrade: 2,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleUpdateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 200);
      assert.strictEqual(mockResponse.body.success, true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 10. CLASS UPDATE ADVERSARIAL: Attempting to update grade outside boundary
    // ─────────────────────────────────────────────────────────────────────────
    await runAsyncTest('Class Update Adversarial: Attempting to update numericGrade to 9 for Primary School -> 400 Bad Request', async () => {
      const mockRequest = {
        user: adminActor,
        params: { id: createdClassRecord._id.toString() },
        body: {
          name: 'Class 9 Illegitimate Update',
          numericGrade: 9,
        },
        ip: '127.0.0.1',
        headers: {},
      };
      const mockResponse = createMockResponse();
      await handleUpdateClass(mockRequest, mockResponse);

      assert.strictEqual(mockResponse.statusCode, 400);
      assert.strictEqual(mockResponse.body.success, false);
      assert.match(mockResponse.body.message, /outside the allowed grade range/i);

      // Verify DB record numericGrade was NOT mutated
      const freshClass = await Class.findById(createdClassRecord._id);
      assert.strictEqual(freshClass.numericGrade, 2);
    });

  } finally {
    // Clean up mock schools and test classes (AuditLog is strictly append-only and cannot be deleted)
    await School.deleteMany({ _id: { $in: [primarySchoolId, secondarySchoolId] } });
    await Class.deleteMany({ schoolId: { $in: [primarySchoolId, secondarySchoolId] } });
    await mongoose.disconnect();
  }

  console.log('===========================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} GRADE RANGE ENFORCEMENT TESTS PASSED!`);
  console.log('===========================================================================');
}

runSuite().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
