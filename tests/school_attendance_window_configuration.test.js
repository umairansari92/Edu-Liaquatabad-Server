/**
 * 🏛️ SCHOOL ATTENDANCE WINDOW CONFIGURATION, ROLE GOVERNANCE & AUDIT TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all 13 core requirements:
 * 1.  Authorized Admin can configure school attendance windows (create & update).
 * 2.  Unauthorized roles cannot create or change timing settings (Teacher, Supervisor, etc.).
 * 3.  HM can update settings for their own authorized school only (with valid reason >= 5 chars).
 * 4.  HM cannot modify another school's timing by changing request IDs or payloads (BOLA guard).
 * 5.  HM changes without a valid reason (< 5 chars, empty, missing) are strictly rejected.
 * 6.  A failed update does not partially modify the stored configuration (immutability).
 * 7.  Audit entries contain correct actor, target school, before/after snapshots, reason, timestamp.
 * 8.  Invalid times and end time earlier than or equal to start time are rejected.
 * 9.  Regular-day and Friday configurations are selected correctly using Asia/Karachi (PKT).
 * 10. Before-open, in-window, and after-close checks behave correctly.
 * 11. Missing or legacy school settings follow documented institutional fallback policy.
 * 12. State transitions preserve audit history without silent data loss.
 * 13. Existing attendance workflows and unrelated school attributes remain unaffected.
 */

import { ROLES } from '../config/constants.js';
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_PERMISSION_CEILING,
  validatePermissionCeiling,
  getEffectivePermissions,
} from '../src/config/permissions.js';
import {
  resolveSchoolSchedule,
  validateSubmissionWindow,
  DEFAULT_SCHOOL_TIMINGS,
} from '../src/services/attendanceWindowService.js';
import {
  validateAndNormalizeTimings,
  handleUpdateSchoolTimings,
  handleCreateSchool,
  handleUpdateSchool,
} from '../src/controllers/schoolController.js';
import { authorizeScope } from '../src/middlewares/authorizeScope.js';
import {
  getKarachiTimeString,
  getKarachiDateString,
  getKarachiDayOfWeek,
} from '../src/utils/karachiTime.js';
import School from '../src/models/School.js';
import AuditLog from '../src/models/AuditLog.js';

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

function createMockRes() {
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

// In-memory mock storage for School and AuditLog models during unit tests
const mockSchoolsDb = new Map();
const mockAuditLogsDb = [];

School.findById = (id) => {
  const idStr = String(id);
  const found = mockSchoolsDb.get(idStr);
  if (!found) {
    const emptyChain = {
      select: () => emptyChain,
      lean: () => Promise.resolve(null),
      then: (fn) => Promise.resolve(null).then(fn),
      catch: (fn) => Promise.resolve(null).catch(fn),
    };
    return emptyChain;
  }

  // Return a document-like object with save() and chainable select/lean
  const doc = {
    ...JSON.parse(JSON.stringify(found)),
    save: async function () {
      mockSchoolsDb.set(idStr, JSON.parse(JSON.stringify(this)));
      return this;
    },
  };

  const chain = {
    ...doc,
    select: () => chain,
    lean: () => Promise.resolve(JSON.parse(JSON.stringify(found))),
    then: (fn) => Promise.resolve(doc).then(fn),
    catch: (fn) => Promise.resolve(doc).catch(fn),
  };
  return chain;
};

AuditLog.create = async (auditEntry) => {
  const record = {
    ...auditEntry,
    _id: `audit_${Date.now()}_${Math.random()}`,
    createdAt: new Date(),
  };
  mockAuditLogsDb.push(record);
  return record;
};

async function runTestSuite() {
  console.log('\n==============================================================================');
  console.log('🏛️  SCHOOL ATTENDANCE WINDOW CONFIGURATION & RBAC AUDIT SUITE');
  console.log('==============================================================================\n');

  // Setup sample schools
  const townLiaquatabadId = '66d000000000000000000001';
  const townNazimabadId = '66d000000000000000000002';
  const schoolA_Id = '66d111111111111111111111';
  const schoolB_Id = '66d222222222222222222222';

  const initialTimings = {
    regular: {
      startTime: '08:00',
      endTime: '13:30',
      attendanceWindowStart: '07:45',
      attendanceWindowEnd: '14:00',
    },
    friday: {
      startTime: '07:30',
      endTime: '12:00',
      attendanceWindowStart: '07:15',
      attendanceWindowEnd: '12:30',
    },
    allowHmLateOverride: true,
  };

  mockSchoolsDb.set(schoolA_Id, {
    _id: schoolA_Id,
    name: 'Baba-e-Urdu Government Boys Secondary School',
    schoolCode: 'BEU-001',
    emisCode: '408010001',
    townId: townLiaquatabadId,
    status: 'ACTIVE',
    timings: JSON.parse(JSON.stringify(initialTimings)),
  });

  mockSchoolsDb.set(schoolB_Id, {
    _id: schoolB_Id,
    name: 'Sir Syed Municipal Girls Primary School',
    schoolCode: 'SSM-002',
    emisCode: '408010002',
    townId: townNazimabadId,
    status: 'ACTIVE',
    timings: JSON.parse(JSON.stringify(initialTimings)),
  });

  // ─── 1. TIMING VALIDATION & REJECTION RULES (Requirement 8) ────────────────
  console.log('--- 1. Timing Validation & Boundary Enforcement ---');
  {
    const validConfig = {
      regular: {
        startTime: '08:00',
        endTime: '13:30',
        attendanceWindowStart: '07:45',
        attendanceWindowEnd: '14:00',
      },
      friday: {
        startTime: '07:30',
        endTime: '12:00',
        attendanceWindowStart: '07:15',
        attendanceWindowEnd: '12:30',
      },
      allowHmLateOverride: true,
    };
    const res = validateAndNormalizeTimings(validConfig);
    assert(res.valid === true, 'Test 01: Valid 24-hr time schedule passes validation');
  }

  {
    // End before or equal to start in regular attendance window
    const invalidWindow = {
      regular: {
        startTime: '08:00',
        endTime: '13:30',
        attendanceWindowStart: '14:00',
        attendanceWindowEnd: '07:45',
      },
    };
    const res = validateAndNormalizeTimings(invalidWindow);
    assert(res.valid === false, 'Test 02: Attendance window end earlier than start is rejected');
    assert(res.error.includes('must be later than start time'), 'Test 03: Descriptive error message returned for inverted window');
  }

  {
    // Equal start and end
    const equalTimes = {
      regular: {
        startTime: '08:00',
        endTime: '08:00',
        attendanceWindowStart: '08:00',
        attendanceWindowEnd: '08:00',
      },
    };
    const res = validateAndNormalizeTimings(equalTimes);
    assert(res.valid === false, 'Test 04: Equal start and end times are rejected');
  }

  {
    // Invalid time string (e.g. 25:00 or malformed)
    const malformedTime = {
      regular: {
        startTime: '25:99',
        endTime: '13:30',
        attendanceWindowStart: '07:45',
        attendanceWindowEnd: '14:00',
      },
    };
    const res = validateAndNormalizeTimings(malformedTime);
    assert(res.valid === false, 'Test 05: Malformed HH:mm time string is rejected');
  }

  // ─── 2. RBAC & PERMISSION CEILING CHECKS (Requirements 1 & 2) ───────────────
  console.log('\n--- 2. RBAC & Privilege Ceiling Checks ---');
  {
    assert(
      PERMISSIONS.SCHOOLS_TIMINGS_UPDATE === 'schools.timings_update',
      'Test 06: Atomic permission SCHOOLS_TIMINGS_UPDATE exists'
    );
    assert(
      ROLE_DEFAULT_PERMISSIONS[ROLES.ADMIN].includes(PERMISSIONS.SCHOOLS_TIMINGS_UPDATE),
      'Test 07: ADMIN role is granted SCHOOLS_TIMINGS_UPDATE by default'
    );
    assert(
      ROLE_DEFAULT_PERMISSIONS[ROLES.HM].includes(PERMISSIONS.SCHOOLS_TIMINGS_UPDATE),
      'Test 08: HM role is granted SCHOOLS_TIMINGS_UPDATE by default'
    );
    assert(
      ROLE_PERMISSION_CEILING[ROLES.TEACHER].includes(PERMISSIONS.SCHOOLS_TIMINGS_UPDATE) === true,
      'Test 09: TEACHER permission ceiling strictly forbids SCHOOLS_TIMINGS_UPDATE'
    );
    assert(
      ROLE_PERMISSION_CEILING[ROLES.SUPERVISOR].includes(PERMISSIONS.SCHOOLS_TIMINGS_UPDATE) === true,
      'Test 10: SUPERVISOR permission ceiling strictly forbids SCHOOLS_TIMINGS_UPDATE'
    );

    // Verify privilege escalation attempt via customPermissions is stripped
    const teacherWithForgedPermission = getEffectivePermissions({
      role: ROLES.TEACHER,
      customPermissions: [PERMISSIONS.SCHOOLS_TIMINGS_UPDATE],
    });
    assert(
      !teacherWithForgedPermission.includes(PERMISSIONS.SCHOOLS_TIMINGS_UPDATE),
      'Test 10b: Injected SCHOOLS_TIMINGS_UPDATE is stripped by ceiling for Teacher'
    );
  }

  // ─── 3. UNAUTHORIZED ROLE ATTEMPTS (Requirement 2) ──────────────────────────
  console.log('\n--- 3. Unauthorized Actor Rejection ---');
  {
    const teacherActor = {
      _id: '66d000000000000000000099',
      role: ROLES.TEACHER,
      schoolId: schoolA_Id,
    };
    const req = {
      user: teacherActor,
      params: { id: schoolA_Id },
      body: {
        timings: initialTimings,
        reason: 'Teacher attempting to modify timings',
      },
      headers: {},
    };
    const res = createMockRes();
    await handleUpdateSchoolTimings(req, res);
    assert(res.statusCode === 403, 'Test 11: Teacher attempting to update timings is blocked (403 Forbidden)');
  }

  {
    const supervisorActor = {
      _id: '66d000000000000000000098',
      role: ROLES.SUPERVISOR,
      assignedSchools: [schoolA_Id],
    };
    const req = {
      user: supervisorActor,
      params: { id: schoolA_Id },
      body: {
        timings: initialTimings,
        reason: 'Supervisor attempting to modify timings',
      },
      headers: {},
    };
    const res = createMockRes();
    await handleUpdateSchoolTimings(req, res);
    assert(res.statusCode === 403, 'Test 12: Supervisor attempting to update timings is blocked (403 Forbidden)');
  }

  // ─── 4. HM REASON VALIDATION (Requirement 5) ────────────────────────────────
  console.log('\n--- 4. HM Mandatory Reason Validation ---');
  {
    const hmActor = {
      _id: '66d000000000000000000010',
      role: ROLES.HM,
      schoolId: schoolA_Id,
      fullName: 'Head Master Liaquatabad',
      designation: 'Head Master BPS-17',
    };

    // Missing reason
    const reqNoReason = {
      user: hmActor,
      params: { id: schoolA_Id },
      body: { timings: initialTimings },
      headers: {},
    };
    const resNoReason = createMockRes();
    await handleUpdateSchoolTimings(reqNoReason, resNoReason);
    assert(resNoReason.statusCode === 400, 'Test 13: HM timing update without reason is rejected (400 Bad Request)');

    // Short reason (< 5 chars)
    const reqShortReason = {
      user: hmActor,
      params: { id: schoolA_Id },
      body: { timings: initialTimings, reason: 'Late' },
      headers: {},
    };
    const resShortReason = createMockRes();
    await handleUpdateSchoolTimings(reqShortReason, resShortReason);
    assert(resShortReason.statusCode === 400, 'Test 14: HM timing update with short reason (< 5 chars) is rejected (400)');
    assert(
      resShortReason.body?.message?.includes('minimum 5 characters'),
      'Test 15: Error specifies minimum 5 character reason requirement'
    );
  }

  // ─── 5. HM CROSS-SCHOOL BOLA GUARD (Requirement 4) ──────────────────────────
  console.log('\n--- 5. HM Cross-School BOLA Security Guard ---');
  {
    const hmActorSchoolA = {
      _id: '66d000000000000000000010',
      role: ROLES.HM,
      schoolId: schoolA_Id,
      fullName: 'Head Master School A',
    };

    // HM from School A targets School B in URL
    const reqBola = {
      user: hmActorSchoolA,
      params: { id: schoolB_Id },
      body: {
        timings: initialTimings,
        reason: 'Malicious attempt to alter another school timings',
      },
      headers: {},
    };
    const resBola = createMockRes();
    await handleUpdateSchoolTimings(reqBola, resBola);
    assert(resBola.statusCode === 403, 'Test 16: HM targeting foreign school ID is strictly blocked (403 Forbidden)');
  }

  // ─── 6. HM AUTHORIZED TIMING ADJUSTMENT & AUDIT LOGGING (Requirements 3 & 7)
  console.log('\n--- 6. HM Authorized Self-School Update & Audit Integrity ---');
  {
    const hmActorSchoolA = {
      _id: '66d000000000000000000010',
      role: ROLES.HM,
      schoolId: schoolA_Id,
      fullName: 'Head Master School A',
      designation: 'Head Master BPS-17',
    };

    const newTimingsForA = {
      regular: {
        startTime: '08:15',
        endTime: '13:45',
        attendanceWindowStart: '08:00',
        attendanceWindowEnd: '14:15',
      },
      friday: {
        startTime: '07:45',
        endTime: '12:15',
        attendanceWindowStart: '07:30',
        attendanceWindowEnd: '12:45',
      },
      allowHmLateOverride: true,
    };

    const auditCountBefore = mockAuditLogsDb.length;

    const reqValidHm = {
      user: hmActorSchoolA,
      params: { id: schoolA_Id },
      body: {
        timings: newTimingsForA,
        reason: 'Winter fog delay approved by Town Education Office directive',
      },
      headers: {
        'x-request-id': 'req_hm_test_001',
        'user-agent': 'AutomatedTestRunner/1.0',
      },
      ip: '192.168.10.50',
    };
    const resValidHm = createMockRes();
    await handleUpdateSchoolTimings(reqValidHm, resValidHm);

    assert(resValidHm.statusCode === 200, 'Test 17: HM successfully updates timings for own school (200 OK)');

    // Verify stored configuration was updated
    const updatedSchool = mockSchoolsDb.get(schoolA_Id);
    assert(
      updatedSchool.timings.regular.attendanceWindowStart === '08:00',
      'Test 18: School A regular attendanceWindowStart updated in database'
    );
    assert(
      updatedSchool.timings.friday.attendanceWindowEnd === '12:45',
      'Test 19: School A Friday attendanceWindowEnd updated in database'
    );

    // Verify AuditLog entry
    assert(mockAuditLogsDb.length === auditCountBefore + 1, 'Test 20: Exactly one audit log was created');
    const latestAudit = mockAuditLogsDb[mockAuditLogsDb.length - 1];
    assert(
      latestAudit.action === 'HM_SCHOOL_ATTENDANCE_WINDOW_UPDATED',
      'Test 21: Audit action is distinctly HM_SCHOOL_ATTENDANCE_WINDOW_UPDATED'
    );
    assert(
      String(latestAudit.schoolId || latestAudit.targetId) === schoolA_Id,
      'Test 22: Target school ID matches modified school'
    );
    assert(
      latestAudit.previousState?.timings?.regular?.attendanceWindowStart === '07:45',
      'Test 23: Audit log accurately captured previous state'
    );
    assert(
      latestAudit.newState?.timings?.regular?.attendanceWindowStart === '08:00',
      'Test 24: Audit log accurately captured new state'
    );
    assert(
      latestAudit.reason === 'Winter fog delay approved by Town Education Office directive',
      'Test 25: Audit log preserved exact mandatory justification reason'
    );
  }

  // ─── 7. ADMIN AUTHORIZED TIMING ADJUSTMENT (Requirement 1 & 7) ─────────────
  console.log('\n--- 7. Admin Timing Update & Audit Distinction ---');
  {
    const adminActor = {
      _id: '66d000000000000000000005',
      role: ROLES.ADMIN,
      townId: townLiaquatabadId,
      fullName: 'Town Education Officer Liaquatabad',
    };

    const adminTimings = {
      regular: {
        startTime: '08:00',
        endTime: '13:30',
        attendanceWindowStart: '07:45',
        attendanceWindowEnd: '14:00',
      },
      friday: {
        startTime: '07:30',
        endTime: '12:00',
        attendanceWindowStart: '07:15',
        attendanceWindowEnd: '12:30',
      },
      allowHmLateOverride: true,
    };

    const reqAdmin = {
      user: adminActor,
      params: { id: schoolA_Id },
      body: {
        timings: adminTimings,
        reason: 'Restoring standard spring operational timetable',
      },
      headers: {},
      ip: '127.0.0.1',
    };
    const resAdmin = createMockRes();
    await handleUpdateSchoolTimings(reqAdmin, resAdmin);

    assert(resAdmin.statusCode === 200, 'Test 26: Town Admin successfully updates school timings in their town');
    const latestAudit = mockAuditLogsDb[mockAuditLogsDb.length - 1];
    assert(
      latestAudit.action === 'SCHOOL_TIMINGS_UPDATED',
      'Test 27: Admin audit action is SCHOOL_TIMINGS_UPDATED (distinct from HM override)'
    );

    // Cross-town Admin restriction
    const reqAdminCrossTown = {
      user: adminActor,
      params: { id: schoolB_Id }, // School B is in Nazimabad
      body: { timings: adminTimings },
      headers: {},
    };
    const resAdminCrossTown = createMockRes();
    await handleUpdateSchoolTimings(reqAdminCrossTown, resAdminCrossTown);
    assert(
      resAdminCrossTown.statusCode === 403,
      'Test 28: Admin cannot modify school timings in another town (Cross-town BOLA blocked)'
    );
  }

  // ─── 8. FAILED UPDATE IMMUTABILITY (Requirement 6) ──────────────────────────
  console.log('\n--- 8. Immutability on Failed Update ---');
  {
    const beforeState = JSON.parse(JSON.stringify(mockSchoolsDb.get(schoolA_Id).timings));

    const hmActor = {
      _id: '66d000000000000000000010',
      role: ROLES.HM,
      schoolId: schoolA_Id,
    };

    // Submitting with invalid time
    const reqFail = {
      user: hmActor,
      params: { id: schoolA_Id },
      body: {
        timings: {
          regular: {
            startTime: '08:00',
            endTime: '07:00', // invalid: end before start
            attendanceWindowStart: '07:45',
            attendanceWindowEnd: '14:00',
          },
        },
        reason: 'Valid justification reason',
      },
      headers: {},
    };
    const resFail = createMockRes();
    await handleUpdateSchoolTimings(reqFail, resFail);

    assert(resFail.statusCode === 400, 'Test 29: Invalid update failed');
    const afterState = JSON.parse(JSON.stringify(mockSchoolsDb.get(schoolA_Id).timings));
    assert(
      JSON.stringify(beforeState) === JSON.stringify(afterState),
      'Test 30: Stored configuration is completely unchanged on failure (no partial write)'
    );
  }

  // ─── 9. SCHEDULE RESOLUTION & ASIA/KARACHI PKT LOGIC (Requirements 9 & 11) ─
  console.log('\n--- 9. Dynamic Schedule Resolution & Legacy Fallback ---');
  {
    const configuredSchool = {
      timings: {
        regular: {
          startTime: '08:30',
          endTime: '14:00',
          attendanceWindowStart: '08:15',
          attendanceWindowEnd: '14:30',
        },
        friday: {
          startTime: '07:45',
          endTime: '12:15',
          attendanceWindowStart: '07:30',
          attendanceWindowEnd: '12:45',
        },
        allowHmLateOverride: false,
      },
    };

    // Test non-Friday resolution
    const regularSchedule = resolveSchoolSchedule(configuredSchool, false);
    assert(regularSchedule.windowStart === '08:15', 'Test 31: Regular schedule resolves windowStart 08:15');
    assert(regularSchedule.windowEnd === '14:30', 'Test 32: Regular schedule resolves windowEnd 14:30');
    assert(regularSchedule.allowHmLateOverride === false, 'Test 33: allowHmLateOverride flag preserved');

    // Test Friday resolution
    const fridaySchedule = resolveSchoolSchedule(configuredSchool, true);
    assert(fridaySchedule.windowStart === '07:30', 'Test 34: Friday schedule resolves windowStart 07:30');
    assert(fridaySchedule.windowEnd === '12:45', 'Test 35: Friday schedule resolves windowEnd 12:45');

    // Legacy school with missing / null timings object
    const legacySchool = { name: 'Legacy Municipal School without timings' };
    const legacySchedule = resolveSchoolSchedule(legacySchool, false);
    assert(
      legacySchedule.windowStart === DEFAULT_SCHOOL_TIMINGS.regular.attendanceWindowStart,
      'Test 36: Legacy school cleanly defaults to DEFAULT_SCHOOL_TIMINGS regular start (07:45)'
    );
    assert(
      legacySchedule.windowEnd === DEFAULT_SCHOOL_TIMINGS.regular.attendanceWindowEnd,
      'Test 37: Legacy school cleanly defaults to DEFAULT_SCHOOL_TIMINGS regular end (14:00)'
    );

    const legacyFridaySchedule = resolveSchoolSchedule(legacySchool, true);
    assert(
      legacyFridaySchedule.windowStart === DEFAULT_SCHOOL_TIMINGS.friday.attendanceWindowStart,
      'Test 38: Legacy school cleanly defaults to DEFAULT_SCHOOL_TIMINGS Friday start (07:15)'
    );
  }

  // ─── 10. ATTENDANCE GATE ENFORCEMENT (Requirement 10) ───────────────────────
  console.log('\n--- 10. Attendance Window Gate Enforcement ---');
  {
    const schoolWithCustomHours = {
      _id: schoolA_Id,
      timings: {
        regular: {
          startTime: '08:30',
          endTime: '14:00',
          attendanceWindowStart: '08:15',
          attendanceWindowEnd: '14:30',
        },
        friday: {
          startTime: '07:45',
          endTime: '12:15',
          attendanceWindowStart: '07:30',
          attendanceWindowEnd: '12:45',
        },
        allowHmLateOverride: true,
      },
    };

    // Case A: Before Window Opens (08:00 PKT on a regular day, window opens 08:15)
    // 08:00 PKT is 03:00 UTC
    const dateBeforeOpen = new Date('2026-09-14T03:00:00.000Z'); // Monday 08:00 PKT
    const resBefore = await validateSubmissionWindow({
      school: schoolWithCustomHours,
      requestingActor: { role: ROLES.TEACHER },
      date: dateBeforeOpen,
    });
    assert(resBefore.allowed === false, 'Test 39: Submission before 08:15 is blocked');
    assert(resBefore.code === 'WINDOW_NOT_OPENED', 'Test 40: Returns WINDOW_NOT_OPENED code');

    // Case B: In Window (09:00 PKT on a regular day)
    // 09:00 PKT is 04:00 UTC
    const dateInWindow = new Date('2026-09-14T04:00:00.000Z'); // Monday 09:00 PKT
    const resIn = await validateSubmissionWindow({
      school: schoolWithCustomHours,
      requestingActor: { role: ROLES.TEACHER },
      date: dateInWindow,
    });
    assert(resIn.allowed === true, 'Test 41: Submission within window (09:00 PKT) is allowed');

    // Case C: After Window Closes (15:00 PKT on a regular day, window closed 14:30)
    // 15:00 PKT is 10:00 UTC
    const dateAfterClose = new Date('2026-09-14T10:00:00.000Z'); // Monday 15:00 PKT
    const resAfter = await validateSubmissionWindow({
      school: schoolWithCustomHours,
      requestingActor: { role: ROLES.TEACHER },
      date: dateAfterClose,
    });
    assert(resAfter.allowed === false, 'Test 42: Submission after window closes (15:00 PKT) is blocked');
    assert(resAfter.code === 'WINDOW_CLOSED', 'Test 43: Returns WINDOW_CLOSED code');

    // Case D: Same-day HM late override with valid justification
    const schoolClosedToday = {
      _id: schoolA_Id,
      timings: {
        regular: {
          startTime: '00:01',
          endTime: '00:30',
          attendanceWindowStart: '00:01',
          attendanceWindowEnd: '00:30',
        },
        friday: {
          startTime: '00:01',
          endTime: '00:30',
          attendanceWindowStart: '00:01',
          attendanceWindowEnd: '00:30',
        },
        allowHmLateOverride: true,
      },
    };
    const nowPkt = new Date();
    const simulatedLateClock = new Date(nowPkt);
    simulatedLateClock.setUTCHours(23, 59, 0, 0);
    const resLateCleared = await validateSubmissionWindow({
      school: schoolClosedToday,
      requestingActor: { role: ROLES.HM },
      date: nowPkt,
      currentTime: simulatedLateClock,
      isLateOverride: true,
      lateReason: 'Power disruption delayed local register data entry',
    });
    assert(resLateCleared.allowed === true, 'Test 44: Same-day HM late clearance is permitted');
    assert(resLateCleared.isLateOverride === true, 'Test 45: Late override flagged as isLateOverride: true for audit');

    // Case E: Retrospective backdating override for past date is blocked
    const yesterdayAfternoon = new Date('2026-10-16T11:00:00.000Z'); // Friday 16:00 PKT (after window close)
    const resPastOverride = await validateSubmissionWindow({
      school: schoolWithCustomHours,
      requestingActor: { role: ROLES.HM },
      date: yesterdayAfternoon,
      isLateOverride: true,
      lateReason: 'Attempting override for yesterday',
    });
    assert(resPastOverride.allowed === false, 'Test 46: Past date backdating is strictly blocked');
    assert(resPastOverride.code === 'BACKDATING_BLOCKED', 'Test 47: Returns BACKDATING_BLOCKED code');
  }

  // ─── 11. UNRELATED ATTRIBUTES PRESERVATION (Requirement 13) ─────────────────
  console.log('\n--- 11. Attribute Preservation & Side-Effect Freedom ---');
  {
    const school = mockSchoolsDb.get(schoolA_Id);
    assert(school.name === 'Baba-e-Urdu Government Boys Secondary School', 'Test 48: School name preserved');
    assert(school.emisCode === '408010001', 'Test 49: EMIS code preserved');
    assert(school.status === 'ACTIVE', 'Test 50: Lifecycle status preserved');
  }

  // ─── 12. HM & SUPERVISOR SCHOOL MUTATION PROHIBITION (Priority 1) ───────────
  console.log('\n--- 12. HM & Supervisor School Mutation Prohibition & Ceilings ---');
  {
    // Ceilings Verification
    assert(
      ROLE_PERMISSION_CEILING[ROLES.HM].includes(PERMISSIONS.SCHOOLS_CREATE),
      'Test 51: ROLE_PERMISSION_CEILING[ROLES.HM] contains SCHOOLS_CREATE (strictly forbidden)'
    );
    assert(
      ROLE_PERMISSION_CEILING[ROLES.HM].includes(PERMISSIONS.SCHOOLS_UPDATE),
      'Test 52: ROLE_PERMISSION_CEILING[ROLES.HM] contains SCHOOLS_UPDATE (strictly forbidden)'
    );

    const ceilingCheckCreate = validatePermissionCeiling(ROLES.HM, [PERMISSIONS.SCHOOLS_CREATE]);
    assert(
      ceilingCheckCreate.valid === false && ceilingCheckCreate.forbiddenPermissions.includes(PERMISSIONS.SCHOOLS_CREATE),
      'Test 53: validatePermissionCeiling flags SCHOOLS_CREATE as illegal for HM'
    );

    const ceilingCheckUpdate = validatePermissionCeiling(ROLES.HM, [PERMISSIONS.SCHOOLS_UPDATE]);
    assert(
      ceilingCheckUpdate.valid === false && ceilingCheckUpdate.forbiddenPermissions.includes(PERMISSIONS.SCHOOLS_UPDATE),
      'Test 54: validatePermissionCeiling flags SCHOOLS_UPDATE as illegal for HM'
    );

    // Stripping via getEffectivePermissions
    const effectivePerms = getEffectivePermissions({
      role: ROLES.HM,
      customPermissions: [
        PERMISSIONS.SCHOOLS_CREATE,
        PERMISSIONS.SCHOOLS_UPDATE,
        PERMISSIONS.SCHOOLS_TIMINGS_UPDATE,
      ],
    });
    assert(
      !effectivePerms.includes(PERMISSIONS.SCHOOLS_CREATE),
      'Test 55: getEffectivePermissions strips SCHOOLS_CREATE ceiling violation'
    );
    assert(
      !effectivePerms.includes(PERMISSIONS.SCHOOLS_UPDATE),
      'Test 56: getEffectivePermissions strips SCHOOLS_UPDATE ceiling violation'
    );
    assert(
      effectivePerms.includes(PERMISSIONS.SCHOOLS_TIMINGS_UPDATE),
      'Test 57: getEffectivePermissions retains legitimate SCHOOLS_TIMINGS_UPDATE'
    );

    // Controller Direct Invocation Rejections (Defense-in-Depth)
    const resHmCreate = createMockRes();
    await handleCreateSchool(
      { user: { role: ROLES.HM, schoolId: schoolA_Id }, body: { name: 'Unauthorized HM School' } },
      resHmCreate
    );
    assert(resHmCreate.statusCode === 403, 'Test 58: handleCreateSchool rejects HM direct call with 403');

    const resSupervisorCreate = createMockRes();
    await handleCreateSchool(
      { user: { role: ROLES.SUPERVISOR, assignedSchools: [schoolA_Id] }, body: { name: 'Unauthorized Supervisor School' } },
      resSupervisorCreate
    );
    assert(resSupervisorCreate.statusCode === 403, 'Test 59: handleCreateSchool rejects Supervisor direct call with 403');

    const resHmUpdate = createMockRes();
    await handleUpdateSchool(
      {
        user: { role: ROLES.HM, schoolId: schoolA_Id },
        params: { id: schoolA_Id },
        body: { name: 'HM Tampered Name' },
      },
      resHmUpdate
    );
    assert(resHmUpdate.statusCode === 403, 'Test 60: handleUpdateSchool rejects HM direct call with 403');

    const resSupervisorUpdate = createMockRes();
    await handleUpdateSchool(
      {
        user: { role: ROLES.SUPERVISOR, assignedSchools: [schoolA_Id] },
        params: { id: schoolA_Id },
        body: { name: 'Supervisor Tampered Name' },
      },
      resSupervisorUpdate
    );
    assert(resSupervisorUpdate.statusCode === 403, 'Test 61: handleUpdateSchool rejects Supervisor direct call with 403');

    // authorizeScope Route Differentiation & Jurisdictional Enforcement
    // HM attempting general mutation on own school: blocked by authorizeScope
    let nextCalledHmGeneral = false;
    const resScopeHmGeneral = createMockRes();
    await authorizeScope(
      {
        method: 'PATCH',
        baseUrl: '/api/v1/schools',
        originalUrl: `/api/v1/schools/${schoolA_Id}`,
        params: { id: schoolA_Id },
        route: { path: '/:id' },
        user: { _id: 'hm_user_1', role: ROLES.HM, schoolId: schoolA_Id },
        headers: {},
        ip: '127.0.0.1',
      },
      resScopeHmGeneral,
      () => { nextCalledHmGeneral = true; }
    );
    assert(nextCalledHmGeneral === false && resScopeHmGeneral.statusCode === 403, 'Test 62: authorizeScope blocks HM on general PATCH /:id (403)');
    assert(
      resScopeHmGeneral.body.message.includes('Head Masters cannot modify general municipal school registration'),
      'Test 63: Returns clear message that HM cannot modify school identity'
    );

    // HM updating timings on own school: permitted by authorizeScope
    let nextCalledHmTimings = false;
    const resScopeHmTimings = createMockRes();
    await authorizeScope(
      {
        method: 'PATCH',
        baseUrl: '/api/v1/schools',
        originalUrl: `/api/v1/schools/${schoolA_Id}/timings`,
        params: { id: schoolA_Id },
        route: { path: '/:id/timings' },
        user: { _id: 'hm_user_1', role: ROLES.HM, schoolId: schoolA_Id },
        headers: {},
        ip: '127.0.0.1',
      },
      resScopeHmTimings,
      () => { nextCalledHmTimings = true; }
    );
    assert(nextCalledHmTimings === true, 'Test 64: authorizeScope permits HM on PATCH /:id/timings for own school');

    // HM updating timings on another school (BOLA): blocked by authorizeScope
    let nextCalledHmBola = false;
    const resScopeHmBola = createMockRes();
    await authorizeScope(
      {
        method: 'PATCH',
        baseUrl: '/api/v1/schools',
        originalUrl: `/api/v1/schools/${schoolB_Id}/timings`,
        params: { id: schoolB_Id },
        route: { path: '/:id/timings' },
        user: { _id: 'hm_user_1', role: ROLES.HM, schoolId: schoolA_Id },
        headers: {},
        ip: '127.0.0.1',
      },
      resScopeHmBola,
      () => { nextCalledHmBola = true; }
    );
    assert(nextCalledHmBola === false && resScopeHmBola.statusCode === 403, 'Test 65: authorizeScope blocks cross-school timing modification by HM (BOLA 403)');
    assert(
      resScopeHmBola.body.message.includes("own school's record"),
      'Test 66: Returns own school boundary error message'
    );

    // Supervisor attempting school mutation: blocked by authorizeScope
    let nextCalledSupervisor = false;
    const resScopeSupervisor = createMockRes();
    await authorizeScope(
      {
        method: 'PATCH',
        baseUrl: '/api/v1/schools',
        originalUrl: `/api/v1/schools/${schoolA_Id}/timings`,
        params: { id: schoolA_Id },
        route: { path: '/:id/timings' },
        user: { _id: 'supervisor_1', role: ROLES.SUPERVISOR, assignedSchools: [schoolA_Id] },
        headers: {},
        ip: '127.0.0.1',
      },
      resScopeSupervisor,
      () => { nextCalledSupervisor = true; }
    );
    assert(nextCalledSupervisor === false && resScopeSupervisor.statusCode === 403, 'Test 67: authorizeScope blocks Supervisor school mutation (403)');
  }

  // ─── 13. AUDIT PROVENANCE & IMMUTABLE HISTORY RECONSTRUCTION (Priority 2) ──
  console.log('\n--- 13. Audit Provenance Reconstruction & Immutability ---');
  {
    // Query audit logs recorded for schoolA_Id
    const schoolAAuditLogs = mockAuditLogsDb.filter(
      (log) => String(log.targetId) === String(schoolA_Id) || String(log.schoolId) === String(schoolA_Id)
    );

    assert(schoolAAuditLogs.length >= 2, 'Test 68: School A has complete audit history trail recorded');

    // Chronological reconstruction of provenance:
    // Event 1: Admin timing configuration
    const adminConfigLog = schoolAAuditLogs.find((l) => l.action === 'SCHOOL_TIMINGS_UPDATED');
    assert(adminConfigLog !== undefined, 'Test 69: Admin initial timing update event is present');
    assert(adminConfigLog.actorRole === ROLES.ADMIN, 'Test 70: Admin action correctly attributes actorRole ADMIN');
    assert(adminConfigLog.createdAt instanceof Date, 'Test 71: Admin action has immutable server timestamp');
    assert(adminConfigLog.newState?.timings?.regular?.startTime === '08:00', 'Test 72: Admin timing state captured in audit snapshot');

    // Event 2: HM seasonal adjustment with justification
    const hmAdjustmentLog = schoolAAuditLogs.find((l) => l.action === 'HM_SCHOOL_ATTENDANCE_WINDOW_UPDATED');
    assert(hmAdjustmentLog !== undefined, 'Test 73: HM seasonal adjustment event is present');
    assert(hmAdjustmentLog.actorRole === ROLES.HM, 'Test 74: HM action correctly attributes actorRole HM');
    assert(hmAdjustmentLog.reason === 'Winter fog delay approved by Town Education Office directive', 'Test 75: Mandatory reason preserved in audit');
    assert(hmAdjustmentLog.previousState?.timings?.regular?.startTime === '08:00', 'Test 76: Previous state preserved in audit snapshot');
    assert(hmAdjustmentLog.newState?.timings?.regular?.startTime === '08:15', 'Test 77: New state preserved in audit snapshot');
    assert(hmAdjustmentLog.result === 'SUCCESS', 'Test 78: Audit result records SUCCESS');

    // Immutability: Verify rejected calls did NOT mutate school record
    // In Test 18-20, an HM change with reason < 5 chars was rejected.
    // In Test 29, an invalid schedule (window inverted) was rejected.
    // Ensure schoolA timings reflect only successful updates (08:00 from Test 26)
    const storedSchoolA = mockSchoolsDb.get(schoolA_Id);
    assert(
      storedSchoolA.timings.regular.startTime === '08:00',
      'Test 79: Stored school reflects only successful mutation (no partial mutation from failed requests)'
    );
  }

  console.log(`\n🎉 ALL ${passedTests}/${totalTests} SCHOOL ATTENDANCE WINDOW TESTS PASSED SUCCESSFULLY!`);
}

runTestSuite().catch((err) => {
  console.error('\n❌ Test Suite Aborted with Error:', err);
  process.exit(1);
});
