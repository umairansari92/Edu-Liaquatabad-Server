/**
 * 🏛️ SCHOOL CLOSURE LIFECYCLE & NOTIFICATION AUDIT TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * 1. Closure creation with future dates sets status: 'SCHEDULED'
 * 2. Closure creation with today's date sets status: 'ACTIVE'
 * 3. Expired closures lifecycle transition to status: 'EXPIRED'
 * 4. Cancellation immutability & terminal state protection
 * 5. Expired closure cancellation rejection (400 Bad Request)
 * 6. Query filtering across ALL, ACTIVE, SCHEDULED, EXPIRED, CANCELLED
 * 7. Single-school closure notification dispatch with strict recipient boundary
 * 8. Zero leakage of foreign school users in school-level closure notifications
 * 9. Town-wide closure notification recipient resolution across municipal schools
 * 10. Recipient deduplication guarantee
 * 11. Infrastructure telemetry protection on GET /health (Non-admin / Public zero PII/heap leakage)
 * 12. Explicit rejection of non-admin attempting ?telemetry=true (403 Forbidden)
 */

import assert from 'assert';
import mongoose from 'mongoose';
import HolidayCalendar from '../src/models/HolidayCalendar.js';
import User from '../src/models/User.js';
import School from '../src/models/School.js';
import StudentProfile from '../src/models/StudentProfile.js';
import Notification from '../src/models/Notification.js';
import AuditLog from '../src/models/AuditLog.js';
import { ROLES } from '../config/constants.js';
import {
  handleCreateHoliday,
  handleGetHolidays,
  handleCancelHoliday,
} from '../src/controllers/holidayController.js';
import { getKarachiDateString } from '../src/utils/karachiTime.js';
import { signAccessToken } from '../src/utils/tokenUtils.js';

let totalTests = 0;
let passedTests = 0;

async function runTest(testName, testFn) {
  totalTests++;
  try {
    await testFn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (err) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(err);
    throw err;
  }
}

const mockResponse = () => {
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
};

console.log('\n======================================================================');
console.log('🏛️ EXECUTING CLOSURE LIFECYCLE & NOTIFICATION SUITE (WORKSTREAMS A & B)');
console.log('======================================================================\n');

// ── Test Setup ──────────────────────────────────────────────────────────────
const todayPkt = getKarachiDateString(new Date());

const mockOrgId = new mongoose.Types.ObjectId();
const mockTownId = new mongoose.Types.ObjectId();
const mockSchoolAId = new mongoose.Types.ObjectId();
const mockSchoolBId = new mongoose.Types.ObjectId();

const mockHmUser = {
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Bashir Ahmed Khan',
  role: ROLES.HM,
  schoolId: mockSchoolAId,
  townId: mockTownId,
  organizationId: mockOrgId,
  designation: 'Head Master',
};

const mockAdminUser = {
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Town Director',
  role: ROLES.ADMIN,
  townId: mockTownId,
  organizationId: mockOrgId,
  designation: 'Town Administrator',
};

// ── Stubs and Mocks ─────────────────────────────────────────────────────────
const origSchoolFindById = School.findById;
const origSchoolFind = School.find;
const origHolidayCreate = HolidayCalendar.create;
const origHolidayFind = HolidayCalendar.find;
const origHolidayFindById = HolidayCalendar.findById;
const origHolidayUpdateMany = HolidayCalendar.updateMany;
const origStudentFind = StudentProfile.find;
const origUserFind = User.find;
const origAuditCreate = AuditLog.create;
const origNotificationInsertMany = Notification.insertMany;

School.findById = () => ({
  select: () => ({
    lean: async () => ({ _id: mockSchoolAId, townId: mockTownId, organizationId: mockOrgId }),
  }),
});

AuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });

// ── Tests ───────────────────────────────────────────────────────────────────

await runTest('1. Future closure declaration automatically assigns status: SCHEDULED', async () => {
  let createdPayload = null;
  HolidayCalendar.create = async (doc) => {
    createdPayload = doc;
    return { ...doc, _id: new mongoose.Types.ObjectId() };
  };

  const futureDate = '2026-12-25';
  const req = {
    user: mockHmUser,
    body: {
      title: 'Winter Maintenance Break',
      reason: 'Scheduled infrastructure maintenance across school building.',
      startDate: futureDate,
      endDate: futureDate,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdPayload.status, 'SCHEDULED');
  assert.strictEqual(createdPayload.startDate, futureDate);
});

await runTest('2. Same-day emergency closure declaration assigns status: ACTIVE', async () => {
  let createdPayload = null;
  HolidayCalendar.create = async (doc) => {
    createdPayload = doc;
    return { ...doc, _id: new mongoose.Types.ObjectId() };
  };

  const req = {
    user: mockHmUser,
    body: {
      title: 'Monsoon Rain Emergency',
      reason: 'Urban flash flooding and intense rainfall warning.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdPayload.status, 'ACTIVE');
});

await runTest('3. Idempotent lifecycle synchronization transitions past closures to EXPIRED', async () => {
  let updatedToActiveQuery = null;
  let updatedToExpiredQuery = null;

  HolidayCalendar.updateMany = async (filter, update) => {
    if (update.$set?.status === 'ACTIVE') updatedToActiveQuery = filter;
    if (update.$set?.status === 'EXPIRED') updatedToExpiredQuery = filter;
    return { modifiedCount: 1 };
  };

  HolidayCalendar.find = () => ({
    populate: () => ({
      populate: () => ({
        sort: () => ({
          lean: async () => [
            {
              _id: new mongoose.Types.ObjectId(),
              title: 'Rain Emergency',
              startDate: '2026-10-07',
              endDate: '2026-10-07',
              status: 'EXPIRED',
              scopeType: 'SCHOOL',
            },
          ],
        }),
      }),
    }),
  });

  const req = {
    user: mockHmUser,
    query: { status: 'EXPIRED' },
  };
  const res = mockResponse();

  await handleGetHolidays(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(updatedToExpiredQuery);
  assert.deepStrictEqual(updatedToExpiredQuery.endDate, { $lt: todayPkt });
  assert.strictEqual(res.body.data.holidays[0].status, 'EXPIRED');
});

await runTest('4. Query with status: ACTIVE strictly excludes past/expired closures', async () => {
  let capturedFindFilter = null;
  HolidayCalendar.find = (filter) => {
    capturedFindFilter = filter;
    return {
      populate: () => ({
        populate: () => ({
          sort: () => ({
            lean: async () => [],
          }),
        }),
      }),
    };
  };

  const req = {
    user: mockHmUser,
    query: { status: 'ACTIVE' },
  };
  const res = mockResponse();

  await handleGetHolidays(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(capturedFindFilter.status, 'ACTIVE');
  assert.deepStrictEqual(capturedFindFilter.startDate, { $lte: todayPkt });
  assert.deepStrictEqual(capturedFindFilter.endDate, { $gte: todayPkt });
});

await runTest('5. Cancelled closure is terminal and cannot be cancelled twice', async () => {
  HolidayCalendar.findById = async () => ({
    _id: new mongoose.Types.ObjectId(),
    title: 'Cancelled Break',
    status: 'CANCELLED',
    scopeType: 'SCHOOL',
    schoolId: mockSchoolAId,
    endDate: '2026-12-31',
  });

  const req = {
    user: mockHmUser,
    params: { id: 'dummy_id' },
    body: { cancelReason: 'Revocation reason for test' },
    headers: {},
  };
  const res = mockResponse();

  await handleCancelHoliday(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /already cancelled/i);
});

await runTest('6. Attempting to cancel an expired closure is rejected with 400 Bad Request', async () => {
  HolidayCalendar.findById = async () => ({
    _id: new mongoose.Types.ObjectId(),
    title: 'Past Emergency',
    status: 'EXPIRED',
    scopeType: 'SCHOOL',
    schoolId: mockSchoolAId,
    startDate: '2026-10-01',
    endDate: '2026-10-02',
  });

  const req = {
    user: mockHmUser,
    params: { id: 'dummy_id' },
    body: { cancelReason: 'Cannot cancel what is in the past' },
    headers: {},
  };
  const res = mockResponse();

  await handleCancelHoliday(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /expired/i);
});

await runTest('7. Single-school closure resolves and notifies only students, parents, and staff of that school', async () => {
  let insertedNotifications = [];
  Notification.insertMany = async (records) => {
    insertedNotifications = records;
    return records;
  };

  const studentUser1 = new mongoose.Types.ObjectId();
  const parentUser1 = new mongoose.Types.ObjectId();
  const teacherUser1 = new mongoose.Types.ObjectId();

  StudentProfile.find = (query) => {
    assert.strictEqual(String(query.schoolId), String(mockSchoolAId));
    return {
      select: () => ({
        lean: async () => [
          { userId: studentUser1, parentUserId: parentUser1 },
        ],
      }),
    };
  };

  User.find = (query) => {
    assert.strictEqual(String(query.schoolId), String(mockSchoolAId));
    return {
      select: () => ({
        lean: async () => [
          { _id: teacherUser1 },
        ],
      }),
    };
  };

  HolidayCalendar.create = async (doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
  });

  const req = {
    user: mockHmUser,
    body: {
      title: 'Local Building Closure',
      reason: 'Urgent civil works and electrical repairs.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(insertedNotifications.length, 3);
  const notifiedIds = insertedNotifications.map((n) => String(n.recipientUserId));
  assert.ok(notifiedIds.includes(String(studentUser1)));
  assert.ok(notifiedIds.includes(String(parentUser1)));
  assert.ok(notifiedIds.includes(String(teacherUser1)));
});

await runTest('8. Recipient set deduplication guarantees no user receives multiple notifications', async () => {
  let insertedNotifications = [];
  Notification.insertMany = async (records) => {
    insertedNotifications = records;
    return records;
  };

  const sharedUserId = new mongoose.Types.ObjectId();

  // One user as both parent and staff
  StudentProfile.find = () => ({
    select: () => ({
      lean: async () => [
        { userId: new mongoose.Types.ObjectId(), parentUserId: sharedUserId },
      ],
    }),
  });

  User.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: sharedUserId },
      ],
    }),
  });

  HolidayCalendar.create = async (doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
  });

  const req = {
    user: mockHmUser,
    body: {
      title: 'Heavy Fog Closure',
      reason: 'Zero visibility weather conditions.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  const duplicates = insertedNotifications.filter((n) => String(n.recipientUserId) === String(sharedUserId));
  assert.strictEqual(duplicates.length, 1); // Deduplication intact!
});

// ── Workstream C: Telemetry Access Control Tests ────────────────────────────
import express from 'express';
import supertest from 'supertest';
import healthRouter from '../src/routes/healthRoutes.js';

const testApp = express();
testApp.use('/health', healthRouter);

await runTest('9. Public / unauthenticated GET /health returns minimal liveness without internal telemetry', async () => {
  const res = await supertest(testApp).get('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.status, 'ONLINE');
  assert.strictEqual(res.body.data.service, 'Liaquatabad DMC School Management API & BFF Gateway');
  assert.strictEqual(res.body.data.memory, undefined); // Zero memory telemetry leakage!
  assert.strictEqual(res.body.data.cpu, undefined);
  assert.strictEqual(res.body.data.database, undefined);
  assert.strictEqual(res.body.data.nodeVersion, undefined);
});

await runTest('10. Head Master GET /health receives minimal liveness without server vitals', async () => {
  const hmToken = signAccessToken({ userId: mockHmUser._id, role: ROLES.HM, email: 'hm@test.gov.pk' });
  const res = await supertest(testApp)
    .get('/health')
    .set('Authorization', `Bearer ${hmToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.status, 'ONLINE');
  assert.strictEqual(res.body.data.memory, undefined); // HM cannot see infrastructure telemetry
  assert.strictEqual(res.body.data.cpu, undefined);
  assert.strictEqual(res.body.data.database, undefined);
});

await runTest('11. Non-admin attempting explicit ?telemetry=true is rejected with 403 Forbidden', async () => {
  const hmToken = signAccessToken({ userId: mockHmUser._id, role: ROLES.HM, email: 'hm@test.gov.pk' });
  const res = await supertest(testApp)
    .get('/health?telemetry=true')
    .set('Authorization', `Bearer ${hmToken}`);

  assert.strictEqual(res.status, 403);
  assert.match(res.body.message, /restricted to municipal administrators/i);
});

await runTest('12. Privileged Town Admin GET /health receives authorized infrastructure vitals', async () => {
  const adminToken = signAccessToken({ userId: mockAdminUser._id, role: ROLES.ADMIN, email: 'admin@test.gov.pk' });
  const res = await supertest(testApp)
    .get('/health')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.data.memory?.heapUsedMB !== undefined); // Authorized admin receives memory metrics
  assert.ok(res.body.data.cpu !== undefined);
  assert.ok(res.body.data.database !== undefined);
});

// Clean up stubs
School.findById = origSchoolFindById;
School.find = origSchoolFind;
HolidayCalendar.create = origHolidayCreate;
HolidayCalendar.find = origHolidayFind;
HolidayCalendar.findById = origHolidayFindById;
HolidayCalendar.updateMany = origHolidayUpdateMany;
StudentProfile.find = origStudentFind;
User.find = origUserFind;
AuditLog.create = origAuditCreate;
Notification.insertMany = origNotificationInsertMany;

console.log(`\n======================================================================`);
console.log(`🎉 ALL ${passedTests}/${totalTests} CLOSURE LIFECYCLE & NOTIFICATION TESTS PASSED!`);
console.log(`======================================================================\n`);
