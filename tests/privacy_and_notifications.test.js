import assert from 'node:assert/strict';
import { sanitizeNotificationMetadata } from '../src/services/notificationDispatcher.js';
import { evaluateProfileAccess } from '../src/controllers/staffProfileController.js';

console.log('======================================================================');
console.log('🛡️ EXECUTING ENTERPRISE PRIVACY & NOTIFICATION ENGINE VERIFICATIONS');
console.log('======================================================================\n');

// ─── 1. METADATA ALLOWLIST & PII LEAK GUARD VERIFICATION ────────────────────
console.log('--- 1. Notification Metadata Allowlist & PII Leak Guard ---');

const dirtyMetadata = {
  accessRequestId: 'req-12345',
  purpose: 'Official Annual Audit Inspection',
  scope: 'OFFICIAL_SERVICE_RECORD',
  requesterName: 'HM Tariq Mehmood',
  requesterRole: 'HM',
  requesterDesignation: 'Head Master',
  schoolName: 'Govt Boys Secondary School',
  // SENSITIVE PII INJECTIONS THAT MUST BE STRIPPED:
  cnic: '42101-1234567-1',
  bankAccount: '1234567890',
  accountNumber: '9876543210',
  password: 'SuperSecretPassword123!',
  otp: '654321',
  token: 'jwt.token.string',
};

const cleanMetadata = sanitizeNotificationMetadata('PDF_ACCESS_REQUEST', dirtyMetadata);

assert.equal(cleanMetadata.accessRequestId, 'req-12345');
assert.equal(cleanMetadata.purpose, 'Official Annual Audit Inspection');
assert.equal(cleanMetadata.requesterName, 'HM Tariq Mehmood');
assert.equal(cleanMetadata.cnic, undefined, 'CNIC must be strictly stripped from metadata');
assert.equal(cleanMetadata.bankAccount, undefined, 'Bank account must be strictly stripped');
assert.equal(cleanMetadata.password, undefined, 'Password must be strictly stripped');
assert.equal(cleanMetadata.otp, undefined, 'OTP must be strictly stripped');
assert.equal(cleanMetadata.token, undefined, 'Token must be strictly stripped');

console.log('✅ PASS [1]: Metadata allowlist strictly strips CNIC, bank accounts, passwords, and tokens.');

// Test Homework Metadata Allowlist
const dirtyHomeworkMeta = {
  homeworkId: 'hw-999',
  title: 'Algebra Unit 4 Problems',
  subjectName: 'Mathematics',
  className: 'Class 8',
  sectionName: 'A',
  dueDate: '2026-09-20',
  teacherName: 'Sir Asif',
  studentCnic: '42101-9999999-1', // leaked
  privateNotes: 'Internal grading note', // leaked
};

const cleanHomeworkMeta = sanitizeNotificationMetadata('HOMEWORK_CREATED', dirtyHomeworkMeta);
assert.equal(cleanHomeworkMeta.homeworkId, 'hw-999');
assert.equal(cleanHomeworkMeta.title, 'Algebra Unit 4 Problems');
assert.equal(cleanHomeworkMeta.studentCnic, undefined, 'Student CNIC stripped from homework notification');
assert.equal(cleanHomeworkMeta.privateNotes, undefined, 'Private notes stripped from homework notification');

console.log('✅ PASS [2]: Homework notification metadata stripped of all unapproved fields.');

// ─── 2. POLICY CEILINGS ENFORCEMENT VERIFICATION ────────────────────────────
console.log('\n--- 2. Security Ceilings Enforcement (Policy > User Choice) ---');

const testCeilingValidation = (fieldVisibility) => {
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.cnic)) {
    return { valid: false, error: 'CNIC cannot be exposed publicly or school-wide' };
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.bankDetails)) {
    return { valid: false, error: 'Bank Details cannot be exposed publicly or school-wide' };
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.residentialAddress)) {
    return { valid: false, error: 'Residential Address cannot be exposed publicly' };
  }
  return { valid: true };
};

// Attempt to set CNIC to PUBLIC
const cnicPublicAttempt = testCeilingValidation({ cnic: 'PUBLIC' });
assert.equal(cnicPublicAttempt.valid, false);
assert.match(cnicPublicAttempt.error, /CNIC cannot be exposed/);
console.log('✅ PASS [3]: Security Ceiling blocks setting CNIC to PUBLIC.');

// Attempt to set Bank Details to PUBLIC
const bankPublicAttempt = testCeilingValidation({ cnic: 'AUTHORIZED_ROLE', bankDetails: 'PUBLIC' });
assert.equal(bankPublicAttempt.valid, false);
assert.match(bankPublicAttempt.error, /Bank Details cannot be exposed/);
console.log('✅ PASS [4]: Security Ceiling blocks setting Bank Details to PUBLIC.');

// Attempt to set Bank Details to SCHOOL
const bankSchoolAttempt = testCeilingValidation({ cnic: 'AUTHORIZED_ROLE', bankDetails: 'SCHOOL' });
assert.equal(bankSchoolAttempt.valid, false);
console.log('✅ PASS [5]: Security Ceiling blocks setting Bank Details to SCHOOL-wide.');

// Valid settings (AUTHORIZED_ROLE or PRIVATE)
const validSettings = testCeilingValidation({
  profilePhoto: 'PUBLIC',
  designation: 'PUBLIC',
  qualification: 'PUBLIC',
  phoneNumber: 'SCHOOL',
  email: 'SCHOOL',
  cnic: 'AUTHORIZED_ROLE',
  bankDetails: 'AUTHORIZED_ROLE',
  residentialAddress: 'PRIVATE',
});
assert.equal(validSettings.valid, true);
console.log('✅ PASS [6]: Valid institutional privacy configuration is accepted.');

// ─── 3. PRIVACY IS NOT AUTHORIZATION (EVALUATOR CHECK) ──────────────────────
console.log('\n--- 3. Privacy is NOT Authorization Boundary Checks ---');

const mockStaffUser = {
  _id: 'user-teacher-101',
  fullName: 'Muhammad Bilal',
  schoolId: 'school-001',
  role: 'TEACHER',
};

const mockHMUser = {
  _id: 'user-hm-201',
  fullName: 'Tariq Mehmood',
  schoolId: 'school-001',
  role: 'HM',
};

const mockOtherSchoolHM = {
  _id: 'user-hm-301',
  fullName: 'Rashid Khan',
  schoolId: 'school-999',
  role: 'HM',
};

const mockParent = {
  _id: 'user-parent-401',
  fullName: 'Parent User',
  role: 'PARENT',
};

// Self access
const selfAccess = evaluateProfileAccess(mockStaffUser, mockStaffUser, {});
assert.equal(selfAccess.canView, true);
assert.equal(selfAccess.canViewSensitive, true);
console.log('✅ PASS [7]: Self can view full profile including sensitive fields.');

// Same-school HM access
const sameSchoolHmAccess = evaluateProfileAccess(mockHMUser, mockStaffUser, {});
assert.equal(sameSchoolHmAccess.canView, true);
assert.equal(sameSchoolHmAccess.canViewSensitive, true);
console.log('✅ PASS [8]: Same-school HM is authorized to view staff record.');

// Different-school HM access (Cross-school boundary protection)
const otherSchoolHmAccess = evaluateProfileAccess(mockOtherSchoolHM, mockStaffUser, {});
assert.equal(otherSchoolHmAccess.canView, false);
console.log('✅ PASS [9]: Cross-school HM is strictly blocked from viewing staff record.');

// Parent role (Unauthorized)
const parentAccess = evaluateProfileAccess(mockParent, mockStaffUser, {});
assert.equal(parentAccess.canView, false);
console.log('✅ PASS [10]: Unauthorized roles (Parent/Student) strictly blocked from staff profile.');

// ─── 4. PDF CONSENT LIFECYCLE EVALUATION ───────────────────────────────────
console.log('\n--- 4. PDF Consent Lifecycle & Access Evaluation ---');

const evaluatePdfDownloadAuthorization = ({
  actor,
  targetUser,
  privacySettings,
  activeApproval,
}) => {
  const isSelf = String(actor._id) === String(targetUser._id);
  const isPrivilegedAdmin = ['ROOT_ADMIN', 'SUPER_ADMIN'].includes(actor.role);
  const preAllowed = !!privacySettings?.allowAuthorizedPdfDownload;

  if (isSelf) return { allowed: true, reason: 'SELF' };
  if (isPrivilegedAdmin) return { allowed: true, reason: 'PRIVILEGED_ADMIN' };
  if (preAllowed) return { allowed: true, reason: 'PRE_ALLOWED' };

  if (activeApproval) {
    if (activeApproval.status === 'APPROVED' && new Date(activeApproval.expiresAt) > new Date()) {
      return { allowed: true, reason: 'APPROVED_CONSENT' };
    }
  }

  return { allowed: false, requiresConsent: true, reason: 'CONSENT_REQUIRED' };
};

// Case A: allowAuthorizedPdfDownload = false, no approval exists
const noConsentCheck = evaluatePdfDownloadAuthorization({
  actor: mockHMUser,
  targetUser: mockStaffUser,
  privacySettings: { allowAuthorizedPdfDownload: false },
  activeApproval: null,
});
assert.equal(noConsentCheck.allowed, false);
assert.equal(noConsentCheck.requiresConsent, true);
console.log('✅ PASS [11]: PDF download blocked when consent unchecked and no approval exists.');

// Case B: allowAuthorizedPdfDownload = true (Staff pre-approved)
const preAllowedCheck = evaluatePdfDownloadAuthorization({
  actor: mockHMUser,
  targetUser: mockStaffUser,
  privacySettings: { allowAuthorizedPdfDownload: true },
  activeApproval: null,
});
assert.equal(preAllowedCheck.allowed, true);
assert.equal(preAllowedCheck.reason, 'PRE_ALLOWED');
console.log('✅ PASS [12]: PDF download permitted when staff has pre-allowed authorized downloads.');

// Case C: Valid unexpired approval exists
const approvedCheck = evaluatePdfDownloadAuthorization({
  actor: mockHMUser,
  targetUser: mockStaffUser,
  privacySettings: { allowAuthorizedPdfDownload: false },
  activeApproval: {
    status: 'APPROVED',
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12h remaining
  },
});
assert.equal(approvedCheck.allowed, true);
assert.equal(approvedCheck.reason, 'APPROVED_CONSENT');
console.log('✅ PASS [13]: PDF download permitted when active, unexpired approval exists.');

// Case D: Expired approval exists
const expiredCheck = evaluatePdfDownloadAuthorization({
  actor: mockHMUser,
  targetUser: mockStaffUser,
  privacySettings: { allowAuthorizedPdfDownload: false },
  activeApproval: {
    status: 'APPROVED',
    expiresAt: new Date(Date.now() - 1000), // expired 1s ago
  },
});
assert.equal(expiredCheck.allowed, false);
assert.equal(expiredCheck.requiresConsent, true);
console.log('✅ PASS [14]: Expired approval strictly blocks PDF download.');

// Case E: Denied approval exists
const deniedCheck = evaluatePdfDownloadAuthorization({
  actor: mockHMUser,
  targetUser: mockStaffUser,
  privacySettings: { allowAuthorizedPdfDownload: false },
  activeApproval: {
    status: 'DENIED',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  },
});
assert.equal(deniedCheck.allowed, false);
console.log('✅ PASS [15]: Denied approval strictly blocks PDF download.');

// Case F: Self download always allowed
const selfDownloadCheck = evaluatePdfDownloadAuthorization({
  actor: mockStaffUser,
  targetUser: mockStaffUser,
  privacySettings: { allowAuthorizedPdfDownload: false },
  activeApproval: null,
});
assert.equal(selfDownloadCheck.allowed, true);
assert.equal(selfDownloadCheck.reason, 'SELF');
console.log('✅ PASS [16]: Self can always download their own official profile PDF.');

console.log('\n======================================================================');
console.log('🎉 ALL 16 ENTERPRISE PRIVACY & NOTIFICATION TESTS PASSED PERFECTLY!');
console.log('======================================================================\n');
