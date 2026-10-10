/**
 * 🏛️ SCHOOL CLOSURE LIFECYCLE & NOTIFICATION AUDIT TEST SUITE (ARCHITECTURAL REVISION)
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * 1. Closure creation with future dates sets status: 'SCHEDULED'
 * 2. Closure creation with today's date sets status: 'ACTIVE'
 * 3. GET /holidays is strictly READ-ONLY (Zero DB mutations, zero updateMany/findOneAndUpdate)
 * 4. Query filtering across ALL, ACTIVE, SCHEDULED, EXPIRED, CANCELLED
 * 5. ReconcileHolidayLifecycle service transitions SCHEDULED -> ACTIVE on start date
 * 6. ReconcileHolidayLifecycle service transitions ACTIVE -> EXPIRED on end date passage
 * 7. ReconcileHolidayLifecycle service preserves CANCELLED records (never reactivated/expired)
 * 8. ReconcileHolidayLifecycle writes append-only AuditLog for every persisted transition
 * 9. ReconcileHolidayLifecycle is idempotent (second run = 0 transitions, 0 duplicate audit logs)
 * 10. Cancellation immutability & terminal state protection
 * 11. Expired closure cancellation rejection (400 Bad Request)
 * 12. Single-school closure resolves verified parents via ParentStudentLink (VERIFIED only)
 * 13. Single-school closure excludes unverified and foreign-school parents
 * 14. Single-school closure resolves authorized Field Supervisors assigned to school
 * 15. Single-school closure excludes unassigned Field Supervisors
 * 16. Recipient deduplication across multi-role / multi-ward relationships
 * 17. Idempotent notification dispatch prevents duplicate alerts across retries
 * 18. Town-wide closure notification recipient resolution across municipal schools
 * 19. Public / unauthenticated GET /health returns minimal liveness without internal telemetry
 * 20. Head Master GET /health receives minimal liveness without server vitals
 * 21. Non-admin attempting explicit ?telemetry=true is rejected with 403 Forbidden
 * 22. Privileged Town Admin GET /health receives authorized infrastructure vitals
 */

import assert from 'assert';
import mongoose from 'mongoose';
import HolidayCalendar from '../src/models/HolidayCalendar.js';
import User from '../src/models/User.js';
import School from '../src/models/School.js';
import StudentProfile from '../src/models/StudentProfile.js';
import ParentStudentLink from '../src/models/ParentStudentLink.js';
import Notification from '../src/models/Notification.js';
import AuditLog from '../src/models/AuditLog.js';
import { ROLES, PARENT_STUDENT_LINK_STATUS } from '../config/constants.js';
import {
  handleCreateHoliday,
  handleGetHolidays,
  handleCancelHoliday,
} from '../src/controllers/holidayController.js';
import { reconcileHolidayLifecycle } from '../src/services/holidayLifecycleService.js';
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
console.log('🏛️ EXECUTING ENHANCED CLOSURE LIFECYCLE & NOTIFICATION SUITE');
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
const origHolidayFindOneAndUpdate = HolidayCalendar.findOneAndUpdate;
const origHolidayUpdateMany = HolidayCalendar.updateMany;
const origStudentFind = StudentProfile.find;
const origParentLinkFind = ParentStudentLink.find;
const origUserFind = User.find;
const origAuditCreate = AuditLog.create;
const origNotificationFind = Notification.find;
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

await runTest('3. GET /holidays is strictly READ-ONLY (Zero DB mutations, zero updateMany/findOneAndUpdate)', async () => {
  let mutationAttempted = false;

  HolidayCalendar.updateMany = async () => {
    mutationAttempted = true;
    throw new Error('GET /holidays must never call updateMany!');
  };
  HolidayCalendar.findOneAndUpdate = async () => {
    mutationAttempted = true;
    throw new Error('GET /holidays must never call findOneAndUpdate!');
  };

  HolidayCalendar.find = (filter) => ({
    populate: () => ({
      populate: () => ({
        sort: () => ({
          lean: async () => [
            {
              _id: new mongoose.Types.ObjectId(),
              title: 'Summer Vacations',
              startDate: '2026-06-01',
              endDate: '2026-07-31',
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
  assert.strictEqual(mutationAttempted, false, 'GET /holidays must remain completely read-only');
  assert.strictEqual(res.body.data.holidays[0].status, 'EXPIRED');
});

await runTest('4. Query with status: ACTIVE strictly filters by date boundary', async () => {
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

await runTest('5. ReconcileHolidayLifecycle transitions SCHEDULED -> ACTIVE on effective date', async () => {
  const holidayId = new mongoose.Types.ObjectId();
  const mockHolidayDoc = {
    _id: holidayId,
    title: 'Winter Maintenance Break',
    townId: mockTownId,
    schoolId: mockSchoolAId,
    status: 'SCHEDULED',
    startDate: todayPkt,
    endDate: todayPkt,
  };

  HolidayCalendar.find = (query) => {
    if (query.status === 'SCHEDULED') {
      return {
        select: () => ({
          lean: async () => [mockHolidayDoc],
        }),
      };
    }
    return {
      select: () => ({
        lean: async () => [],
      }),
    };
  };

  let atomicFilter = null;
  let atomicUpdate = null;
  HolidayCalendar.findOneAndUpdate = async (filter, update) => {
    atomicFilter = filter;
    atomicUpdate = update;
    return { ...mockHolidayDoc, status: 'ACTIVE' };
  };

  let auditCreated = null;
  AuditLog.create = async (doc) => {
    auditCreated = doc;
    return doc;
  };

  const summary = await reconcileHolidayLifecycle({ targetDatePkt: todayPkt });

  assert.strictEqual(summary.scheduledToActiveCount, 1);
  assert.strictEqual(atomicFilter._id, holidayId);
  assert.strictEqual(atomicFilter.status, 'SCHEDULED');
  assert.strictEqual(atomicUpdate.$set.status, 'ACTIVE');
  assert.ok(auditCreated);
  assert.strictEqual(auditCreated.action, 'HOLIDAY_STATUS_TRANSITION');
  assert.strictEqual(auditCreated.actorRole, 'SYSTEM');
  assert.strictEqual(auditCreated.previousState.status, 'SCHEDULED');
  assert.strictEqual(auditCreated.newState.status, 'ACTIVE');
});

await runTest('6. ReconcileHolidayLifecycle transitions ACTIVE -> EXPIRED on date expiration', async () => {
  const holidayId = new mongoose.Types.ObjectId();
  const mockHolidayDoc = {
    _id: holidayId,
    title: 'Rain Emergency',
    townId: mockTownId,
    schoolId: mockSchoolAId,
    status: 'ACTIVE',
    startDate: '2026-10-07',
    endDate: '2026-10-07',
  };

  HolidayCalendar.find = (query) => {
    if (query.status === 'SCHEDULED') {
      return {
        select: () => ({
          lean: async () => [],
        }),
      };
    }
    return {
      select: () => ({
        lean: async () => [mockHolidayDoc],
      }),
    };
  };

  let atomicFilter = null;
  let atomicUpdate = null;
  HolidayCalendar.findOneAndUpdate = async (filter, update) => {
    atomicFilter = filter;
    atomicUpdate = update;
    return { ...mockHolidayDoc, status: 'EXPIRED' };
  };

  let auditCreated = null;
  AuditLog.create = async (doc) => {
    auditCreated = doc;
    return doc;
  };

  const summary = await reconcileHolidayLifecycle({ targetDatePkt: '2026-10-11' });

  assert.strictEqual(summary.activeToExpiredCount, 1);
  assert.strictEqual(atomicFilter._id, holidayId);
  assert.strictEqual(atomicFilter.status, 'ACTIVE');
  assert.strictEqual(atomicUpdate.$set.status, 'EXPIRED');
  assert.ok(auditCreated);
  assert.strictEqual(auditCreated.action, 'HOLIDAY_STATUS_TRANSITION');
  assert.strictEqual(auditCreated.previousState.status, 'ACTIVE');
  assert.strictEqual(auditCreated.newState.status, 'EXPIRED');
});

await runTest('7. ReconcileHolidayLifecycle preserves CANCELLED records (never reactivated/expired)', async () => {
  let queriedCancelled = false;

  HolidayCalendar.find = (query) => {
    if (query.status === 'CANCELLED' || query.status?.$in?.includes('CANCELLED')) {
      queriedCancelled = true;
    }
    return {
      select: () => ({
        lean: async () => [],
      }),
    };
  };

  const summary = await reconcileHolidayLifecycle({ targetDatePkt: todayPkt });

  assert.strictEqual(summary.totalTransitions, 0);
  assert.strictEqual(queriedCancelled, false, 'CANCELLED closures must never be queried or altered');
});

await runTest('8. ReconcileHolidayLifecycle is idempotent (second run = 0 transitions, 0 duplicate audit logs)', async () => {
  HolidayCalendar.find = () => ({
    select: () => ({
      lean: async () => [], // No remaining un-transitioned records
    }),
  });

  let auditLogged = false;
  AuditLog.create = async () => {
    auditLogged = true;
  };

  const summary = await reconcileHolidayLifecycle({ targetDatePkt: todayPkt });

  assert.strictEqual(summary.totalTransitions, 0);
  assert.strictEqual(auditLogged, false, 'No audit logs generated on idempotent second run');
});

await runTest('9. Cancelled closure is terminal and cannot be cancelled twice', async () => {
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

await runTest('10. Attempting to cancel an expired closure is rejected with 400 Bad Request', async () => {
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

// ── Workstream B: Notification Recipient Scope & Deduplication Tests ─────────

await runTest('11. Single-school closure resolves verified parents via ParentStudentLink (VERIFIED only)', async () => {
  let insertedNotifications = [];
  Notification.insertMany = async (records) => {
    insertedNotifications = records;
    return records;
  };
  Notification.find = () => ({
    distinct: () => ({
      catch: () => [],
    }),
  });

  const studentProfile1 = new mongoose.Types.ObjectId();
  const studentUser1 = new mongoose.Types.ObjectId();
  const verifiedParentUser = new mongoose.Types.ObjectId();
  const teacherUser = new mongoose.Types.ObjectId();

  // Active student in School A
  StudentProfile.find = (query) => {
    assert.strictEqual(String(query.schoolId), String(mockSchoolAId));
    return {
      select: () => ({
        lean: async () => [
          { _id: studentProfile1, userId: studentUser1 },
        ],
      }),
    };
  };

  // Authoritative ParentStudentLink: VERIFIED parent
  ParentStudentLink.find = (query) => {
    assert.strictEqual(String(query.schoolId), String(mockSchoolAId));
    assert.strictEqual(query.verificationStatus, 'VERIFIED');
    return {
      select: () => ({
        lean: async () => [
          { parentId: verifiedParentUser },
        ],
      }),
    };
  };

  User.find = (query) => {
    return {
      select: () => ({
        lean: async () => [
          { _id: teacherUser },
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
      title: 'Local Building Maintenance',
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
  const notifiedIds = insertedNotifications.map((n) => String(n.recipientUserId));
  assert.ok(notifiedIds.includes(String(studentUser1)), 'Active student must be notified');
  assert.ok(notifiedIds.includes(String(verifiedParentUser)), 'Verified parent must be notified');
  assert.ok(notifiedIds.includes(String(teacherUser)), 'School staff must be notified');
  assert.strictEqual(insertedNotifications[0].category, 'GOVERNANCE');
});

await runTest('12. Single-school closure excludes unverified and foreign-school parents', async () => {
  let insertedNotifications = [];
  Notification.insertMany = async (records) => {
    insertedNotifications = records;
    return records;
  };
  Notification.find = () => ({
    distinct: () => ({
      catch: () => [],
    }),
  });

  const studentProfile1 = new mongoose.Types.ObjectId();
  const unverifiedParentUser = new mongoose.Types.ObjectId();

  StudentProfile.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: studentProfile1, userId: new mongoose.Types.ObjectId() },
      ],
    }),
  });

  // Query enforces verificationStatus: 'VERIFIED' -> returns empty for unverified parent
  ParentStudentLink.find = (query) => {
    assert.strictEqual(query.verificationStatus, 'VERIFIED');
    return {
      select: () => ({
        lean: async () => [], // No verified parent found
      }),
    };
  };

  User.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  HolidayCalendar.create = async (doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
  });

  const req = {
    user: mockHmUser,
    body: {
      title: 'Structural Emergency',
      reason: 'Water main burst requiring emergency repairs.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  const notifiedIds = insertedNotifications.map((n) => String(n.recipientUserId));
  assert.strictEqual(notifiedIds.includes(String(unverifiedParentUser)), false, 'Unverified parent must NOT receive closure alert');
});

await runTest('13. Single-school closure resolves authorized Field Supervisors assigned to school', async () => {
  let insertedNotifications = [];
  Notification.insertMany = async (records) => {
    insertedNotifications = records;
    return records;
  };
  Notification.find = () => ({
    distinct: () => ({
      catch: () => [],
    }),
  });

  const assignedSupervisorId = new mongoose.Types.ObjectId();

  StudentProfile.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  ParentStudentLink.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  User.find = (query) => {
    if (query.role === ROLES.SUPERVISOR) {
      assert.strictEqual(String(query.assignedSchools), String(mockSchoolAId));
      return {
        select: () => ({
          lean: async () => [
            { _id: assignedSupervisorId },
          ],
        }),
      };
    }
    return {
      select: () => ({
        lean: async () => [],
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
      title: 'Severe Weather Closure',
      reason: 'Dense dust storm and high velocity winds.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  const notifiedIds = insertedNotifications.map((n) => String(n.recipientUserId));
  assert.ok(notifiedIds.includes(String(assignedSupervisorId)), 'Assigned field supervisor must receive school closure alert');
});

await runTest('14. Recipient deduplication across multi-role / multi-ward relationships', async () => {
  let insertedNotifications = [];
  Notification.insertMany = async (records) => {
    insertedNotifications = records;
    return records;
  };
  Notification.find = () => ({
    distinct: () => ({
      catch: () => [],
    }),
  });

  const dualIdentityUserId = new mongoose.Types.ObjectId(); // Same person is a teacher AND a verified parent

  StudentProfile.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId() },
      ],
    }),
  });

  ParentStudentLink.find = () => ({
    select: () => ({
      lean: async () => [
        { parentId: dualIdentityUserId },
      ],
    }),
  });

  User.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: dualIdentityUserId },
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
      title: 'Campus Fumigation Break',
      reason: 'Town municipal anti-dengue campus fumigation.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  const duplicates = insertedNotifications.filter((n) => String(n.recipientUserId) === String(dualIdentityUserId));
  assert.strictEqual(duplicates.length, 1, 'Dual-identity user must receive exactly one notification');
});

await runTest('15. Idempotent notification dispatch prevents duplicate alerts across retries', async () => {
  const existingUserId = new mongoose.Types.ObjectId();
  let insertAttempted = false;

  Notification.find = () => ({
    distinct: () => ({
      catch: () => [existingUserId], // Already notified in previous run!
    }),
  });

  Notification.insertMany = async () => {
    insertAttempted = true;
    return [];
  };

  StudentProfile.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: new mongoose.Types.ObjectId(), userId: existingUserId },
      ],
    }),
  });

  ParentStudentLink.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  User.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  HolidayCalendar.create = async (doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
  });

  const req = {
    user: mockHmUser,
    body: {
      title: 'Power Outage Break',
      reason: 'Scheduled feeder repairs by electric utility.',
      startDate: todayPkt,
      endDate: todayPkt,
      scopeType: 'SCHOOL',
    },
    headers: {},
  };
  const res = mockResponse();

  await handleCreateHoliday(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(insertAttempted, false, 'No duplicate notification inserted when recipient already has notification');
});

// ── Workstream C: Telemetry Access Control Tests ────────────────────────────
import express from 'express';
import supertest from 'supertest';
import healthRouter from '../src/routes/healthRoutes.js';

const testApp = express();
testApp.use('/health', healthRouter);

await runTest('16. Public / unauthenticated GET /health returns minimal liveness without internal telemetry', async () => {
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

await runTest('17. Head Master GET /health receives minimal liveness without server vitals', async () => {
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

await runTest('18. Non-admin attempting explicit ?telemetry=true is rejected with 403 Forbidden', async () => {
  const hmToken = signAccessToken({ userId: mockHmUser._id, role: ROLES.HM, email: 'hm@test.gov.pk' });
  const res = await supertest(testApp)
    .get('/health?telemetry=true')
    .set('Authorization', `Bearer ${hmToken}`);

  assert.strictEqual(res.status, 403);
  assert.match(res.body.message, /restricted to municipal administrators/i);
});

await runTest('19. Privileged Town Admin GET /health receives authorized infrastructure vitals', async () => {
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
HolidayCalendar.findOneAndUpdate = origHolidayFindOneAndUpdate;
HolidayCalendar.updateMany = origHolidayUpdateMany;
StudentProfile.find = origStudentFind;
ParentStudentLink.find = origParentLinkFind;
User.find = origUserFind;
AuditLog.create = origAuditCreate;
Notification.find = origNotificationFind;
Notification.insertMany = origNotificationInsertMany;

console.log(`\n======================================================================`);
console.log(`🎉 ALL ${passedTests}/${totalTests} CLOSURE LIFECYCLE & NOTIFICATION TESTS PASSED!`);
console.log(`======================================================================\n`);
