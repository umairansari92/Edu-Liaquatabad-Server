/**
 * 🛡️ HM NOTICES IDEMPOTENCY & RELIABILITY TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 *  1. Read-Only Safety: GET /api/v1/documents never creates records or triggers idempotency locks.
 *  2. Multipart Accurate Fingerprinting: Document title, type, audience, and file attachment hash.
 *  3. Initial Document Creation: 201 Created and registers PENDING -> RESOLVED idempotency lifecycle.
 *  4. Transparent Replay: Exact duplicate request with identical key returns cached 201 response.
 *  5. Key-Reuse Attack Detection: Same key with differing title or audience rejected with 409 IDEMPOTENCY_KEY_REUSE.
 *  6. Audit Logging: IDEMPOTENCY_KEY_REUSE security audit record written on key reuse attempt.
 *  7. Concurrent In-Flight Lock: Simultaneous request while PENDING within lease window returns 409 MUTATION_IN_FLIGHT.
 *  8. Lease Recovery: Abandoned PENDING mutation (>60s) safely reclaims lease and executes retry.
 *  9. Non-Caching of Collisions: 409 status code is recorded as FAILED rather than permanently RESOLVED.
 * 10. School Boundary Isolation: HM cannot publish or access documents for a foreign school.
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { idempotencyGuard, computeRequestFingerprint, IN_FLIGHT_LEASE_MILLISECONDS } from '../src/middlewares/idempotency.js';
import IdempotencyRecord from '../src/models/IdempotencyRecord.js';
import AuditLog from '../src/models/AuditLog.js';
import Document from '../src/models/Document.js';
import Organization from '../src/models/Organization.js';
import { ROLES, DOCUMENT_TYPES, AUDIENCE_TYPES } from '../config/constants.js';
import { handleGetDocuments, handleCreateDocument } from '../src/controllers/documentController.js';

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const cyan = (text) => `\x1b[36m${text}\x1b[0m`;
const bold = (text) => `\x1b[1m${text}\x1b[0m`;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

const runTest = async (testName, testFunction) => {
  totalTests++;
  try {
    await testFunction();
    passedTests++;
    console.log(`  ✓ ${green(testName)}`);
  } catch (error) {
    failedTests++;
    console.error(`  ✗ ${red(testName)}`);
    console.error(`    ${red(error.message)}`);
    if (error.stack) {
      console.error(`    ${error.stack.split('\n').slice(1, 3).join('\n')}`);
    }
  }
};

const createMockResponse = () => {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, val) { this.headers[name] = val; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; },
  };
  return response;
};

const runAllTests = async () => {
  console.log(`\n${bold(cyan('═══════════════════════════════════════════════════════════════════════════════'))}`);
  console.log(`${bold(cyan('  HM NOTICES IDEMPOTENCY & RELIABILITY TEST SUITE'))}`);
  console.log(`${cyan('  Education Department Liaquatabad Town Centre (DMC)')}`);
  console.log(`${bold(cyan('═══════════════════════════════════════════════════════════════════════════════'))}\n`);

  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGODB_URI_TEST ||
    process.env.MONGO_URI ||
    'mongodb://127.0.0.1:27017/school_management_test';

  await mongoose.connect(mongoUri);
  console.log(`  ${green('Database connected successfully for testing.')}\n`);

  const hmUserId = new mongoose.Types.ObjectId();
  const schoolA_Id = new mongoose.Types.ObjectId();
  const schoolB_Id = new mongoose.Types.ObjectId();
  const townId = new mongoose.Types.ObjectId();
  const organizationId = new mongoose.Types.ObjectId();

  const authorizedHmActor = {
    _id: hmUserId,
    role: ROLES.HM,
    schoolId: schoolA_Id,
    townId: townId,
    organizationId: organizationId,
    fullName: 'Mohammad Tariq Qureshi',
  };

  try {
    // Clean up test data before run
    await IdempotencyRecord.deleteMany({ userId: hmUserId });
    await Document.deleteMany({ publishedBy: hmUserId });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Read-Only Safety: GET /documents never generates mutations or locks
    // ─────────────────────────────────────────────────────────────────────────
    await runTest('1. Read-Only Safety: GET /api/v1/documents never touches idempotency records', async () => {
      const initialRecordCount = await IdempotencyRecord.countDocuments({ userId: hmUserId });

      const request = {
        method: 'GET',
        headers: {},
        query: { scopeCategory: 'school' },
        user: authorizedHmActor,
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, true, 'idempotencyGuard must immediately pass through GET requests');
      const finalRecordCount = await IdempotencyRecord.countDocuments({ userId: hmUserId });
      assert.strictEqual(finalRecordCount, initialRecordCount, 'GET request must never insert idempotency records');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Multipart Fingerprint: Distinct fingerprints for distinct payloads
    // ─────────────────────────────────────────────────────────────────────────
    await runTest('2. Multipart Fingerprinting: Computes unique fingerprints for parsed payloads and files', () => {
      const payloadA = {
        body: { title: 'Annual Sports Day 2026', documentType: 'CIRCULAR', priority: 'NORMAL' },
        file: { originalname: 'schedule.pdf', size: 104857, mimetype: 'application/pdf' },
      };
      const payloadB = {
        body: { title: 'Midterm Examination Schedule', documentType: 'CIRCULAR', priority: 'NORMAL' },
        file: { originalname: 'schedule.pdf', size: 104857, mimetype: 'application/pdf' },
      };

      const fingerprintA = computeRequestFingerprint(payloadA);
      const fingerprintB = computeRequestFingerprint(payloadB);

      assert.notStrictEqual(fingerprintA, fingerprintB, 'Fingerprints must differ when titles differ');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Initial Mutation: Creates PENDING record and resolves to 201 Created
    // ─────────────────────────────────────────────────────────────────────────
    const noticeKey1 = '01JHM_NOTICE_STABLE_KEY_001';
    const noticePayload1 = {
      title: 'Monsoon Contingency Preparedness Notice',
      documentType: 'CIRCULAR',
      priority: 'NORMAL',
      targetAudience: [AUDIENCE_TYPES.TEACHERS],
    };

    await runTest('3. Initial Document Creation: Executes mutation and resolves IdempotencyRecord', async () => {
      const request = {
        headers: { 'idempotency-key': noticeKey1 },
        method: 'POST',
        originalUrl: '/api/v1/documents',
        user: authorizedHmActor,
        body: noticePayload1,
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });
      assert.strictEqual(nextCalled, true, 'Next must be called on first execution');

      // Simulate successful controller response
      const controllerData = {
        success: true,
        statusCode: 201,
        message: 'School circular published successfully.',
        data: { documentId: new mongoose.Types.ObjectId(), title: noticePayload1.title },
      };
      response.status(201).json(controllerData);

      await new Promise((resolve) => setTimeout(resolve, 60));

      const savedRecord = await IdempotencyRecord.findOne({ userId: hmUserId, idempotencyKey: noticeKey1 });
      assert.ok(savedRecord, 'IdempotencyRecord must exist');
      assert.strictEqual(savedRecord.status, 'RESOLVED');
      assert.strictEqual(savedRecord.responseStatusCode, 201);
      assert.deepStrictEqual(savedRecord.responseBody, controllerData);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Transparent Replay: Identical key and payload replays cached result
    // ─────────────────────────────────────────────────────────────────────────
    await runTest('4. Transparent Replay: Exact duplicate request returns cached 201 with X-Idempotent-Replay', async () => {
      const request = {
        headers: { 'idempotency-key': noticeKey1 },
        method: 'POST',
        originalUrl: '/api/v1/documents',
        user: authorizedHmActor,
        body: noticePayload1,
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false, 'Controller must NOT be called on idempotent replay');
      assert.strictEqual(response.headers['X-Idempotent-Replay'], 'true');
      assert.strictEqual(response.statusCode, 201);
      assert.strictEqual(response.data.success, true);
      assert.strictEqual(response.data.data.title, noticePayload1.title);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Key-Reuse Detection: Tampered payload rejected with 409 IDEMPOTENCY_KEY_REUSE
    // ─────────────────────────────────────────────────────────────────────────
    await runTest('5. Key-Reuse Attack Detection: Tampered payload with same key rejected with 409', async () => {
      const tamperedPayload = {
        title: 'Tampered Unauthorized Announcement',
        documentType: 'CIRCULAR',
        priority: 'NORMAL',
        targetAudience: [AUDIENCE_TYPES.PARENTS],
      };

      const request = {
        headers: { 'idempotency-key': noticeKey1 },
        method: 'POST',
        originalUrl: '/api/v1/documents',
        user: authorizedHmActor,
        body: tamperedPayload,
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false, 'Controller must not be called on tampered payload');
      assert.strictEqual(response.statusCode, 409);
      assert.strictEqual(response.data.errorCode, 'IDEMPOTENCY_KEY_REUSE');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Security Audit Trail on Key Reuse Attempt
    // ─────────────────────────────────────────────────────────────────────────
    await runTest('6. Audit Logging: Emits security audit trail when key reuse attack is detected', async () => {
      const auditLogRecord = await AuditLog.findOne({
        actorId: hmUserId,
        action: 'IDEMPOTENCY_KEY_REUSE',
      });
      assert.ok(auditLogRecord, 'AuditLog record must be created');
      assert.strictEqual(auditLogRecord.result, 'DENIED');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Concurrent In-Flight Lock: 409 MUTATION_IN_FLIGHT within active lease
    // ─────────────────────────────────────────────────────────────────────────
    const concurrentKey = '01JHM_CONCURRENT_NOTICE_KEY';
    await runTest('7. Concurrent Lock: Simultaneous request during active lease returns 409 MUTATION_IN_FLIGHT', async () => {
      // Seed an active PENDING record
      await IdempotencyRecord.create({
        userId: hmUserId,
        idempotencyKey: concurrentKey,
        requestFingerprint: 'active_in_flight_fingerprint',
        endpoint: 'POST /api/v1/documents',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const request = {
        headers: { 'idempotency-key': concurrentKey },
        method: 'POST',
        originalUrl: '/api/v1/documents',
        user: authorizedHmActor,
        body: { title: 'Some Notice' },
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(response.statusCode, 409);
      assert.strictEqual(response.data.errorCode, 'MUTATION_IN_FLIGHT');
      assert.strictEqual(response.data.retryable, true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Lease Recovery: Abandoned PENDING mutation (>60s) reclaims lease
    // ─────────────────────────────────────────────────────────────────────────
    const abandonedKey = '01JHM_ABANDONED_NOTICE_KEY';
    const abandonedPayload = { title: 'Emergency Cold Weather Advisory', documentType: 'CIRCULAR' };
    const matchingFingerprint = computeRequestFingerprint({ body: abandonedPayload });

    await runTest('8. Lease Recovery: Abandoned PENDING mutation (>60s) safely reclaims lease and executes', async () => {
      // Seed a record abandoned 90 seconds ago
      await IdempotencyRecord.create({
        userId: hmUserId,
        idempotencyKey: abandonedKey,
        requestFingerprint: matchingFingerprint,
        endpoint: 'POST /api/v1/documents',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(Date.now() - 90000),
        updatedAt: new Date(Date.now() - 90000),
      });

      const request = {
        headers: { 'idempotency-key': abandonedKey },
        method: 'POST',
        originalUrl: '/api/v1/documents',
        user: authorizedHmActor,
        body: abandonedPayload,
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, true, 'Must execute retry when lease has expired');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Non-Caching of Transient 409: Marks FAILED to prevent indefinite lock
    // ─────────────────────────────────────────────────────────────────────────
    const transientErrorKey = '01JHM_TRANSIENT_COLLISION_KEY';
    await runTest('9. Non-Caching: Transient 409 is saved as FAILED so client can retry without cached lock', async () => {
      const request = {
        headers: { 'idempotency-key': transientErrorKey },
        method: 'POST',
        originalUrl: '/api/v1/documents',
        user: authorizedHmActor,
        body: { title: 'Transient Test Notice' },
      };
      const response = createMockResponse();

      let nextCalled = false;
      await idempotencyGuard(request, response, () => { nextCalled = true; });
      assert.strictEqual(nextCalled, true);

      // Simulate 409 conflict emitted during pipeline
      response.status(409).json({ success: false, statusCode: 409, errorCode: 'COLLISION' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const record = await IdempotencyRecord.findOne({ userId: hmUserId, idempotencyKey: transientErrorKey });
      assert.strictEqual(record.status, 'FAILED', 'Transient 409 must NOT be stored as RESOLVED');
      assert.strictEqual(record.responseBody, null);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 10. School Boundary Isolation: Anti-BOLA Tripwire on foreign school
    // ─────────────────────────────────────────────────────────────────────────
    await runTest('10. School Boundary Isolation: HM publishing for another school rejected with 403', async () => {
      const foreignSchoolRequest = {
        user: authorizedHmActor,
        body: {
          title: 'Illegitimate Foreign School Notice',
          documentType: DOCUMENT_TYPES.CIRCULAR,
          schoolId: schoolB_Id, // Foreign school!
          targetAudience: [AUDIENCE_TYPES.TEACHERS],
        },
      };
      const response = createMockResponse();

      await handleCreateDocument(foreignSchoolRequest, response);
      assert.strictEqual(response.statusCode, 403, 'Must reject foreign school document publish with 403 Forbidden');
    });

  } finally {
    // Clean up test data
    await IdempotencyRecord.deleteMany({ userId: hmUserId });
    await Document.deleteMany({ publishedBy: hmUserId });
    await mongoose.disconnect();
  }

  console.log(`\n${bold(cyan('═══════════════════════════════════════════════════════════════════════════════'))}`);
  console.log(`  RESULTS: ${green(`${passedTests} passed`)}, ${failedTests > 0 ? red(`${failedTests} failed`) : '0 failed'} (${totalTests} total)`);
  console.log(`${bold(cyan('═══════════════════════════════════════════════════════════════════════════════'))}\n`);

  if (failedTests > 0) {
    process.exit(1);
  }
};

runAllTests().catch((error) => {
  console.error('Fatal test failure:', error);
  process.exit(1);
});
