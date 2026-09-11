/**
 * Stealth ROOT_ADMIN & Emergency Outage Kill Switch Test Suite
 * Education Department Liaquatabad Town Centre (DMC)
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { getSystemStatus, setSystemStatus } from '../src/services/systemControlService.js';
import { systemOutageGuard } from '../src/middlewares/systemOutageGuard.js';
import { signAccessToken } from '../src/utils/tokenUtils.js';
import { ROLES } from '../config/constants.js';

let passed = 0;
let total = 0;

function assert(condition, testName) {
  total++;
  if (!condition) {
    console.error(`❌ FAIL: ${testName}`);
    throw new Error(`Assertion failed: ${testName}`);
  }
  passed++;
  console.log(`✅ PASS: ${testName}`);
}

async function runSuite() {
  console.log('\n======================================================');
  console.log('🔒 STEALTH ROOT_ADMIN & EMERGENCY OUTAGE TEST SUITE');
  console.log('======================================================\n');

  // Test 1: System status defaults
  const initialStatus = getSystemStatus();
  assert(typeof initialStatus.isSuspended === 'boolean', 'Initial status returns boolean isSuspended');

  // Test 2: Toggle killswitch ON (in-memory test)
  const testMessage = 'Database connection pool exhausted: Connection timed out (0x80040154_DB_FAIL).';
  // Simulate setting state
  await setSystemStatus(true, testMessage);
  const activeStatus = getSystemStatus();
  assert(activeStatus.isSuspended === true, 'Kill switch is now active (isSuspended: true)');
  assert(activeStatus.errorMessage === testMessage, 'Kill switch active with custom realistic cluster error');

  // Test 3: systemOutageGuard blocks unauthenticated traffic with 503
  let sentStatusCode = null;
  let sentJson = null;
  let nextCalled = false;

  const fakeReqUnauth = {
    originalUrl: '/api/v1/schools',
    headers: {},
  };
  const fakeResUnauth = {
    status: (code) => {
      sentStatusCode = code;
      return {
        json: (data) => {
          sentJson = data;
        },
      };
    },
  };

  systemOutageGuard(fakeReqUnauth, fakeResUnauth, () => {
    nextCalled = true;
  });

  assert(sentStatusCode === 503, 'systemOutageGuard blocks incoming request with HTTP 503');
  assert(sentJson?.code === 'ERR_DB_CLUSTER_FAIL', 'Error code indicates cluster failure');
  assert(sentJson?.message === testMessage, 'Error message is the simulated cluster failure');
  assert(!nextCalled, 'next() was not called for unauthenticated request');

  // Test 4: systemOutageGuard blocks regular user (e.g. TEACHER or SUPER_ADMIN)
  const teacherToken = signAccessToken({
    userId: '507f1f77bcf86cd799439011',
    role: ROLES.TEACHER,
  });

  sentStatusCode = null;
  sentJson = null;
  nextCalled = false;

  const fakeReqTeacher = {
    originalUrl: '/api/v1/schools',
    headers: {
      authorization: `Bearer ${teacherToken}`,
    },
  };

  systemOutageGuard(fakeReqTeacher, fakeResUnauth, () => {
    nextCalled = true;
  });

  assert(sentStatusCode === 503, 'systemOutageGuard blocks TEACHER with HTTP 503');
  assert(!nextCalled, 'next() was not called for TEACHER token');

  // Test 5: systemOutageGuard allows ROOT_ADMIN through even during outage
  const rootToken = signAccessToken({
    userId: '507f1f77bcf86cd799439099',
    role: ROLES.ROOT_ADMIN,
  });

  sentStatusCode = null;
  nextCalled = false;

  const fakeReqRoot = {
    originalUrl: '/api/v1/schools',
    headers: {
      authorization: `Bearer ${rootToken}`,
    },
  };

  systemOutageGuard(fakeReqRoot, fakeResUnauth, () => {
    nextCalled = true;
  });

  assert(nextCalled === true, 'systemOutageGuard allows ROOT_ADMIN to proceed normally');
  assert(sentStatusCode === null, 'No 503 error sent to ROOT_ADMIN');

  // Test 6: systemOutageGuard allows /auth/login so ROOT_ADMIN can log in
  nextCalled = false;
  sentStatusCode = null;
  const fakeReqLogin = {
    originalUrl: '/api/v1/auth/login',
    headers: {},
  };

  systemOutageGuard(fakeReqLogin, fakeResUnauth, () => {
    nextCalled = true;
  });
  assert(nextCalled === true, 'systemOutageGuard allows /auth/login for authentication gate');

  // Test 7: systemOutageGuard allows /system-control so ROOT_ADMIN can manage kill switch
  nextCalled = false;
  sentStatusCode = null;
  const fakeReqSysControl = {
    originalUrl: '/api/v1/system-control/status',
    headers: {},
  };

  systemOutageGuard(fakeReqSysControl, fakeResUnauth, () => {
    nextCalled = true;
  });
  assert(nextCalled === true, 'systemOutageGuard allows /system-control route through');

  // Test 8: Restore system to operational
  await setSystemStatus(false);
  const restoredStatus = getSystemStatus();
  assert(restoredStatus.isSuspended === false, 'System status restored to normal operational');

  nextCalled = false;
  sentStatusCode = null;
  systemOutageGuard(fakeReqUnauth, fakeResUnauth, () => {
    nextCalled = true;
  });
  assert(nextCalled === true, 'When operational, all requests pass through smoothly');

  console.log(`\n🎉 ALL ${passed} OF ${total} STEALTH & OUTAGE TESTS PASSED!\n`);
}

runSuite().catch((err) => {
  console.error('Fatal test runner failure:', err);
  process.exit(1);
});
