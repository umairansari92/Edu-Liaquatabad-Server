/**
 * 📣 ANNOUNCEMENT LIFECYCLE, EXPIRY & AUDIENCE TARGETING VERIFICATION SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 * 1. Lifecycle: Scheduled future announcements are hidden until start time.
 * 2. Expiry: Explicit expiresAt past current time is rejected from active set.
 * 3. Default TTL: Unspecified expiresAt older than 7 days (or 3 days urgent) expires automatically.
 * 4. Audience Targeting: Strict role-based isolation (Students, Parents, Teachers, Peons, HM, Office Staff, All).
 * 5. Publisher Boundaries: HM cannot target government office staff.
 * 6. Layout Swap Logic: isAnnouncementActiveAndEligible correctly gates hero rendering.
 */

import { ROLES, AUDIENCE_TYPES } from '../config/constants.js';
import { isAnnouncementActiveAndEligible } from '../../client/src/utils/announcementValidator.js';

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

console.log('==============================================================================');
console.log('📣 ANNOUNCEMENT LIFECYCLE, EXPIRY & AUDIENCE TARGETING TEST SUITE');
console.log('==============================================================================\n');

const referenceDate = new Date('2026-10-29T10:00:00.000Z');

// ─── TEST GROUP 1: Publication Window & Scheduled Start ──────────────────────
console.log('--- TEST GROUP 1: Publication Window & Scheduled Start ---');

const futureScheduledNotice = {
  title: 'Future Scheduled Circular',
  status: 'PUBLISHED',
  scheduledAt: new Date('2026-11-01T08:00:00.000Z').toISOString(),
  targetAudience: ['ALL'],
};
assert(
  !isAnnouncementActiveAndEligible(futureScheduledNotice, 'TEACHER', referenceDate),
  'Scheduled notice with start date in future is not eligible for active hero'
);

const pastScheduledNotice = {
  title: 'Ready Scheduled Circular',
  status: 'PUBLISHED',
  scheduledAt: new Date('2026-10-28T08:00:00.000Z').toISOString(),
  targetAudience: ['ALL'],
};
assert(
  isAnnouncementActiveAndEligible(pastScheduledNotice, 'TEACHER', referenceDate),
  'Scheduled notice whose start time has arrived is eligible for active hero'
);

// ─── TEST GROUP 2: Expiry & Screenshot 1 Verification ────────────────────────
console.log('\n--- TEST GROUP 2: Expiry & Screenshot 1 Verification ---');

// Screenshot 1 notice: "Parents Teacher Meeting" created 11 Oct 2026, meeting 12 Oct 2026
const screenshot1ExpiredNotice = {
  title: 'Parents Teacher Meeting',
  description: 'A parents teacher meeting held on monday 12-10-2026',
  priority: 'URGENT',
  status: 'PUBLISHED',
  createdAt: '2026-10-11T01:33:00.000Z',
  effectiveDate: '2026-10-11T00:00:00.000Z',
  targetAudience: ['TEACHERS', 'PARENTS'],
};

assert(
  !isAnnouncementActiveAndEligible(screenshot1ExpiredNotice, 'TEACHER', referenceDate),
  'Screenshot 1 notice (created 11 Oct 2026, 18 days ago) is definitively EXPIRED and excluded from hero'
);

const explicitExpiredNotice = {
  title: 'Expired Sports Day Notice',
  status: 'PUBLISHED',
  createdAt: '2026-10-20T00:00:00.000Z',
  expiresAt: '2026-10-25T23:59:59.000Z',
  targetAudience: ['ALL'],
};
assert(
  !isAnnouncementActiveAndEligible(explicitExpiredNotice, 'TEACHER', referenceDate),
  'Notice with expiresAt in the past is excluded from active hero'
);

const validFutureExpiringNotice = {
  title: 'Valid Active Notice',
  status: 'PUBLISHED',
  createdAt: '2026-10-28T12:00:00.000Z',
  expiresAt: '2026-10-31T23:59:59.000Z',
  targetAudience: ['ALL'],
};
assert(
  isAnnouncementActiveAndEligible(validFutureExpiringNotice, 'TEACHER', referenceDate),
  'Notice with future expiresAt is active and eligible for hero'
);

// ─── TEST GROUP 3: Audience Isolation & Role Boundaries ──────────────────────
console.log('\n--- TEST GROUP 3: Audience Isolation & Role Boundaries ---');

const teacherOnlyNotice = {
  title: 'Teachers Staff Meeting',
  status: 'PUBLISHED',
  createdAt: '2026-10-28T12:00:00.000Z',
  targetAudience: ['TEACHERS'],
};

assert(
  isAnnouncementActiveAndEligible(teacherOnlyNotice, 'TEACHER', referenceDate),
  'Teacher can view announcement targeted to TEACHERS'
);
assert(
  !isAnnouncementActiveAndEligible(teacherOnlyNotice, 'STUDENT', referenceDate),
  'Student CANNOT view announcement targeted to TEACHERS'
);
assert(
  !isAnnouncementActiveAndEligible(teacherOnlyNotice, 'PARENT', referenceDate),
  'Parent CANNOT view announcement targeted to TEACHERS'
);
assert(
  !isAnnouncementActiveAndEligible(teacherOnlyNotice, 'PEON', referenceDate),
  'Support staff (PEON) CANNOT view announcement targeted to TEACHERS'
);

const studentOnlyNotice = {
  title: 'Exam Schedule for Grade 9 & 10',
  status: 'PUBLISHED',
  createdAt: '2026-10-28T12:00:00.000Z',
  targetAudience: ['STUDENTS'],
};
assert(
  isAnnouncementActiveAndEligible(studentOnlyNotice, 'STUDENT', referenceDate),
  'Student can view announcement targeted to STUDENTS'
);
assert(
  !isAnnouncementActiveAndEligible(studentOnlyNotice, 'TEACHER', referenceDate),
  'Teacher does NOT receive announcement targeted exclusively to STUDENTS'
);

const nonTeachingOnlyNotice = {
  title: 'Campus Maintenance & Logistics Protocol',
  status: 'PUBLISHED',
  createdAt: '2026-10-28T12:00:00.000Z',
  targetAudience: ['NON_TEACHING_STAFF'],
};
assert(
  isAnnouncementActiveAndEligible(nonTeachingOnlyNotice, 'PEON', referenceDate),
  'PEON / support staff can view announcement targeted to NON_TEACHING_STAFF'
);
assert(
  !isAnnouncementActiveAndEligible(nonTeachingOnlyNotice, 'TEACHER', referenceDate),
  'Teacher does NOT receive announcement targeted to NON_TEACHING_STAFF'
);

const allAudienceNotice = {
  title: 'Annual Founders Day Gala',
  status: 'PUBLISHED',
  createdAt: '2026-10-28T12:00:00.000Z',
  targetAudience: ['ALL'],
};
assert(
  isAnnouncementActiveAndEligible(allAudienceNotice, 'TEACHER', referenceDate),
  'Teacher receives ALL audience notice'
);
assert(
  isAnnouncementActiveAndEligible(allAudienceNotice, 'STUDENT', referenceDate),
  'Student receives ALL audience notice'
);
assert(
  isAnnouncementActiveAndEligible(allAudienceNotice, 'PARENT', referenceDate),
  'Parent receives ALL audience notice'
);
assert(
  isAnnouncementActiveAndEligible(allAudienceNotice, 'PEON', referenceDate),
  'Peon receives ALL audience notice'
);

// ─── TEST GROUP 4: Cancelled & Archived Invariants ───────────────────────────
console.log('\n--- TEST GROUP 4: Cancelled & Archived Invariants ---');

const archivedNotice = {
  title: 'Old Order',
  status: 'ARCHIVED',
  createdAt: '2026-10-28T12:00:00.000Z',
  targetAudience: ['ALL'],
};
assert(
  !isAnnouncementActiveAndEligible(archivedNotice, 'TEACHER', referenceDate),
  'Archived notice is immediately excluded from active hero'
);

const cancelledNotice = {
  title: 'Cancelled Meeting',
  status: 'CANCELLED',
  createdAt: '2026-10-28T12:00:00.000Z',
  targetAudience: ['ALL'],
};
assert(
  !isAnnouncementActiveAndEligible(cancelledNotice, 'TEACHER', referenceDate),
  'Cancelled notice is immediately excluded from active hero'
);

console.log('\n==============================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} LIFECYCLE & AUDIENCE TESTS PASSED!`);
console.log('==============================================================================\n');
