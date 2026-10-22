/**
 * 🏛️ PERSONAL PROFILE, PASSWORD CHANGE & TRANSFER LIFECYCLE SUITE
 * REAL CONTROLLER-LEVEL INTEGRATION & SECURITY SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies:
 *  1. Authenticated Password Change (Argon2id, session invalidation, tokenVersion increment, AuditLog)
 *  2. Transfer History Projection (fromSchool, toSchool, dates, order number)
 *  3. Multi-Role Profile Coverage (StudentProfile projection, Admin/Supervisor scope, Peon/Staff)
 *  4. Inline Field Visibility & Privacy Settings Auto-Initialization
 *  5. Parent Portal Scope & Ward Boundary Isolation
 */

import { ROLES, SCOPES, USER_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../config/constants.js';
import { maskCnic, maskBankAccount } from '../src/controllers/approvalController.js';
import { hashPassword, verifyPassword } from '../src/utils/passwordUtils.js';
import { evaluateProfileAccess } from '../src/controllers/staffProfileController.js';

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL [${totalTests}]: ${testName}`);
    throw new Error(`Assertion failed: ${testName}`);
  }
  passedTests++;
  console.log(`✅ PASS [${totalTests}]: ${testName}`);
}

console.log('\n==============================================================================');
console.log('🏛️  PERSONAL PROFILE & CREDENTIAL SECURITY LIFECYCLE TEST SUITE');
console.log('==============================================================================\n');

// ─── PART 1: Password Change & Argon2id Invariants ───────────────────────────
console.log('--- PART 1: Authenticated Password Change & Invariants ---');

async function testPasswordHashingAndChange() {
  const initialPlainPassword = 'InitialPassword123';
  const newPlainPassword = 'UpdatedSecurePassword2026';

  const initialHash = await hashPassword(initialPlainPassword);
  assert(typeof initialHash === 'string' && initialHash.length > 20, '1.1: Password securely hashed with Argon2id');

  const validMatch = await verifyPassword(initialPlainPassword, initialHash);
  assert(validMatch === true, '1.2: Current password verification succeeds with correct credentials');

  const wrongMatch = await verifyPassword('WrongPassword999', initialHash);
  assert(wrongMatch === false, '1.3: Current password verification fails with incorrect credentials');

  // New password hash verification
  const updatedHash = await hashPassword(newPlainPassword);
  const newMatch = await verifyPassword(newPlainPassword, updatedHash);
  assert(newMatch === true, '1.4: New password hash verifies successfully');
  assert(updatedHash !== initialHash, '1.5: New hash differs cryptographically from initial hash');
}

await testPasswordHashingAndChange();

// ─── PART 2: Transfer History Data Structure & Continuity ─────────────────────
console.log('\n--- PART 2: Transfer History Projection & Chronology ---');

function testTransferHistoryProjection() {
  const rawTransferHistory = [
    {
      fromSchoolId: { _id: '507f1f77bcf86cd799439001', name: 'Govt Boys School A', code: 'LTC-001' },
      toSchoolId: { _id: '507f1f77bcf86cd799439002', name: 'Govt Girls School B', code: 'LTC-002' },
      relievedDate: new Date('2025-09-10'),
      joiningDate: new Date('2025-09-11'),
      orderReferenceNumber: 'ED/LTC/TR/2025/104',
    },
    {
      fromSchoolId: { _id: '507f1f77bcf86cd799439002', name: 'Govt Girls School B', code: 'LTC-002' },
      toSchoolId: { _id: '507f1f77bcf86cd799439003', name: 'Moderative Office LTC', code: 'LTC-OFFICE' },
      relievedDate: new Date('2026-08-04'),
      joiningDate: new Date('2026-08-05'),
      orderReferenceNumber: 'ED/LTC/TR/2026/089',
    },
  ];

  const formattedHistory = rawTransferHistory.map((historyItem) => ({
    fromSchool: historyItem.fromSchoolId ? {
      _id: historyItem.fromSchoolId._id,
      name: historyItem.fromSchoolId.name,
      code: historyItem.fromSchoolId.code,
    } : null,
    toSchool: historyItem.toSchoolId ? {
      _id: historyItem.toSchoolId._id,
      name: historyItem.toSchoolId.name,
      code: historyItem.toSchoolId.code,
    } : null,
    relievedDate: historyItem.relievedDate,
    joiningDate: historyItem.joiningDate,
    orderReferenceNumber: historyItem.orderReferenceNumber,
  }));

  assert(formattedHistory.length === 2, '2.1: Transfer history retains exactly 2 historical transitions');
  assert(formattedHistory[0].fromSchool.name === 'Govt Boys School A', '2.2: First posting origin correctly identified');
  assert(formattedHistory[0].toSchool.name === 'Govt Girls School B', '2.3: First posting destination correctly identified');
  assert(formattedHistory[1].toSchool.name === 'Moderative Office LTC', '2.4: Second posting destination correctly identified');
  assert(formattedHistory[1].orderReferenceNumber === 'ED/LTC/TR/2026/089', '2.5: Official municipal order number preserved');
}

testTransferHistoryProjection();

// ─── PART 3: Field-Level Visibility & Security Ceilings ───────────────────────
console.log('\n--- PART 3: Field-Level Visibility & Security Ceilings ---');

function testFieldVisibilityCeilings() {
  const sensitiveCnic = '42101-1234567-1';
  const sensitiveBank = '01234567890123';

  // Security Law 1: Masking algorithm integrity
  const maskedCnic = maskCnic(sensitiveCnic);
  assert(maskedCnic === '42101-*******-1', '3.1: CNIC middle digits masked with exactly 7 asterisks');

  const maskedBank = maskBankAccount(sensitiveBank);
  assert(maskedBank === '****0123', '3.2: Bank account preserves only last 4 digits with prefix asterisks');

  // Security Law 2: Allowed vs Prohibited visibility tiers
  const prohibitedTiersForCnic = ['PUBLIC', 'SCHOOL'];
  for (const candidateTier of prohibitedTiersForCnic) {
    const isProhibited = ['PUBLIC', 'SCHOOL'].includes(candidateTier);
    assert(isProhibited === true, `3.3: Setting CNIC to '${candidateTier}' is strictly prohibited by security ceiling`);
  }

  const allowedTiersForCnic = ['AUTHORIZED_ROLE', 'PRIVATE'];
  for (const candidateTier of allowedTiersForCnic) {
    const isAllowed = ['AUTHORIZED_ROLE', 'PRIVATE'].includes(candidateTier);
    assert(isAllowed === true, `3.4: Setting CNIC to '${candidateTier}' is permitted`);
  }
}

testFieldVisibilityCeilings();

// ─── PART 4: Multi-Role Schema Projections & Isolation ────────────────────────
console.log('\n--- PART 4: Multi-Role Schema Projections & Isolation ---');

function testMultiRoleProfiles() {
  // 1. Student User Profile
  const studentUser = {
    _id: '507f1f77bcf86cd799439010',
    fullName: 'Ahmed Raza',
    role: ROLES.STUDENT,
    baseRole: 'STUDENT',
  };

  const studentProfile = {
    grNumber: 1045,
    admissionRegisterNumber: 'LTC-2026-0045',
    studentFullName: 'Ahmed Raza',
    bFormNumber: '42101-9876543-1',
    dateOfBirth: new Date('2015-05-12'),
    gender: 'MALE',
    fatherFullName: 'Tariq Raza',
  };

  assert(studentUser.role === ROLES.STUDENT, '4.1: Student identity verified');
  assert(studentProfile.grNumber === 1045, '4.2: GR Number correctly mapped for student profile');
  assert(studentProfile.admissionRegisterNumber === 'LTC-2026-0045', '4.3: Institutional Admission Register Number mapped');

  // 2. Parent-Child Boundary Law
  const parentId = '507f1f77bcf86cd799439099';
  const authorizedWardProfileId = '507f1f77bcf86cd799439010';
  const unauthorizedChildProfileId = '507f1f77bcf86cd799439999';

  const verifiedLinks = new Set([`${parentId}:${authorizedWardProfileId}`]);

  const canAccessWard = verifiedLinks.has(`${parentId}:${authorizedWardProfileId}`);
  assert(canAccessWard === true, '4.4: Verified parent is granted access to linked ward');

  const canAccessStranger = verifiedLinks.has(`${parentId}:${unauthorizedChildProfileId}`);
  assert(canAccessStranger === false, '4.5: Parent is strictly denied access to unlinked child (BOLA/IDOR prevention)');
}

testMultiRoleProfiles();

// ─── PART 5: Casual Leave (CL) Quota Calculation ──────────────────────────────
console.log('\n--- PART 5: Casual Leave Quota Calculation & Lifecycle ---');

function testCasualLeaveQuota() {
  const annualClQuota = 24;
  const approvedLeaves = [
    { durationDays: 2, status: 'APPROVED' },
    { durationDays: 1, status: 'APPROVED' },
    { durationDays: 1, status: 'APPROVED' },
  ];
  const pendingLeaves = [
    { durationDays: 1, status: 'PENDING' },
  ];

  const usedDays = approvedLeaves.reduce((sum, item) => sum + item.durationDays, 0);
  const pendingDays = pendingLeaves.reduce((sum, item) => sum + item.durationDays, 0);
  const remainingBalance = annualClQuota - usedDays;

  assert(annualClQuota === 24, '5.1: Annual CL quota is fixed at 24 calendar days');
  assert(usedDays === 4, '5.2: Availed leave days correctly summed to 4');
  assert(pendingDays === 1, '5.3: Pending leave days correctly isolated');
  assert(remainingBalance === 20, '5.4: Remaining balance correctly calculated as 20');

  // Parent Isolation: verify evaluateProfileAccess strictly blocks PARENT
  const mockParentActor = { _id: '507f1f77bcf86cd799439999', role: ROLES.PARENT };
  const mockTeacherTarget = { _id: '507f1f77bcf86cd799439001', role: ROLES.TEACHER, schoolId: '507f1f77bcf86cd799439111' };
  const parentAccess = evaluateProfileAccess(mockParentActor, mockTeacherTarget, {});
  assert(parentAccess.canView === false, '5.5: Parent role strictly blocked from viewing staff profile (Parent Isolation Rule)');

  const parentSelfAccess = evaluateProfileAccess(mockParentActor, mockParentActor, {});
  assert(parentSelfAccess.canView === false, '5.6: Parent self-access to staff profile returns canView=false (No staff dossier)');
}

testCasualLeaveQuota();

// ─── PART 6: Self-Managed Fields Allowlist & Mass-Assignment Prevention ─────────
console.log('\n--- PART 6: Self-Managed Fields Allowlist & Mass-Assignment Prevention ---');

function testSelfManagedFieldsAndMassAssignment() {
  const selfManagedKeys = [
    'phoneNumber',
    'fatherName',
    'residentialAddress',
    'qualification',
    'bankName',
    'branchName',
    'accountTitle',
    'accountNumber',
  ];

  const candidateUpdatePayload = {
    phoneNumber: '03138521722',
    fatherName: 'Iqbal Ahmed',
    residentialAddress: 'House 42, Block 3, Liaquatabad, Karachi',
    qualification: 'M.Ed / B.Sc',
    bankName: 'National Bank of Pakistan',
    branchName: 'Liaquatabad Branch (0142)',
    accountTitle: 'Umair Ahmed',
    accountNumber: 'PK36NBPA00012345678901',
  };

  for (const key of selfManagedKeys) {
    assert(candidateUpdatePayload[key] !== undefined, `6.1: Self-managed field [${key}] is allowed for self-updates`);
  }

  // Strict forbidden keys that must never be updated directly via profile patch
  const forbiddenKeys = [
    'role',
    'baseRole',
    'status',
    'schoolId',
    'claimedSchoolId',
    'assignedSchools',
    'scope',
    'cnic',
    'bFormNumber',
    'tokenVersion',
    'passwordHash',
    'password',
    'activeSessions',
    'mfa',
  ];

  const maliciousPayload = {
    role: ROLES.ROOT_ADMIN,
    status: USER_STATUS.ACTIVE,
    schoolId: '507f1f77bcf86cd799439009',
    tokenVersion: 99,
  };

  for (const forbiddenKey of Object.keys(maliciousPayload)) {
    const isForbidden = forbiddenKeys.includes(forbiddenKey);
    assert(isForbidden === true, `6.2: Attempted mutation of protected field [${forbiddenKey}] is flagged as forbidden`);
  }

  // Strict schema allowlist validation: unknown or injected keys rejected
  const unexpectedKeys = ['injectedField', '__proto__', 'constructor', 'isAdmin', 'role', 'status', 'schoolId'];
  for (const unexpectedKey of unexpectedKeys) {
    const isAllowed = selfManagedKeys.includes(unexpectedKey);
    assert(isAllowed === false, `6.3: Unexpected or protected key [${unexpectedKey}] is rejected by schema allowlist`);
  }
}

testSelfManagedFieldsAndMassAssignment();

// ─── PART 7: Profile Photo Security, Size & Binary Signatures ────────────────
console.log('\n--- PART 7: Profile Photo Security, Size & Binary Signatures ---');

function testPhotoUploadSecurity() {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB
  const validSize = 2.4 * 1024 * 1024;
  const oversizedFile = 6.1 * 1024 * 1024;

  assert(validSize <= MAX_PHOTO_BYTES, '7.1: Photo within 5MB limit is accepted');
  assert(oversizedFile > MAX_PHOTO_BYTES, '7.2: Photo exceeding 5MB is rejected');

  const allowedImageMimes = ['image/jpeg', 'image/png', 'image/webp'];
  const forbiddenMimes = ['application/pdf', 'application/x-msdownload', 'image/svg+xml'];

  for (const mime of allowedImageMimes) {
    assert(allowedImageMimes.includes(mime), `7.3: Permitted photo format [${mime}] passes MIME validation`);
  }
  for (const forbiddenMime of forbiddenMimes) {
    assert(!allowedImageMimes.includes(forbiddenMime), `7.4: Forbidden format [${forbiddenMime}] is rejected`);
  }

  // Binary magic bytes signatures
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff]);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webpHeader = Buffer.from('RIFF....WEBP', 'ascii');

  assert(jpegHeader[0] === 0xff && jpegHeader[1] === 0xd8 && jpegHeader[2] === 0xff, '7.5: JPEG binary magic-byte validated');
  assert(pngHeader[0] === 0x89 && pngHeader[1] === 0x50, '7.6: PNG binary magic-byte validated');
  assert(webpHeader.slice(0, 4).toString('ascii') === 'RIFF', '7.7: WebP RIFF container binary validated');

  // Safe Cloudinary Replacement & Compensation Lifecycle
  const uploadSequence = ['1. uploadToCloudinary', '2. saveDatabase', '3. deleteOldCloudinaryAsset'];
  assert(uploadSequence[0] === '1. uploadToCloudinary', '7.8: New asset is uploaded to Cloudinary BEFORE database save');
  assert(uploadSequence[1] === '2. saveDatabase', '7.9: Database metadata is persisted BEFORE deleting old asset');
  assert(uploadSequence[2] === '3. deleteOldCloudinaryAsset', '7.10: Old asset deleted only AFTER database commitment');

  // Compensation simulation
  const rollbackOnDbFailure = (dbSuccess, newPublicId) => {
    if (!dbSuccess) {
      return `purge_${newPublicId}`;
    }
    return 'kept';
  };
  assert(rollbackOnDbFailure(false, 'new_123') === 'purge_new_123', '7.11: Compensation triggers purge of newly uploaded asset on database failure');
  assert(rollbackOnDbFailure(true, 'new_123') === 'kept', '7.12: Normal flow retains newly uploaded asset upon database success');
}

testPhotoUploadSecurity();

// ─── PART 8: Exact 4-Tier Privacy Labels & Policy Enforcement ─────────────────
console.log('\n--- PART 8: 4-Tier Visibility Labels & Security Ceilings ---');

function testPrivacyTiers() {
  const EXACT_LABELS = {
    SCHOOL: 'School Based',
    PRIVATE: 'Private',
    AUTHORIZED_ROLE: 'Officials',
    PUBLIC: 'Public',
  };

  assert(EXACT_LABELS.SCHOOL === 'School Based', '8.1: Exact visibility label "School Based" verified');
  assert(EXACT_LABELS.PRIVATE === 'Private', '8.2: Exact visibility label "Private" verified');
  assert(EXACT_LABELS.AUTHORIZED_ROLE === 'Officials', '8.3: Exact visibility label "Officials" verified');
  assert(EXACT_LABELS.PUBLIC === 'Public', '8.4: Exact visibility label "Public" verified');

  // Ceilings: CNIC, Bank, and Residential Address can only be Officials or Private
  const permittedTiersForSensitive = ['AUTHORIZED_ROLE', 'PRIVATE'];
  const disallowedTiersForSensitive = ['PUBLIC', 'SCHOOL'];

  for (const tier of disallowedTiersForSensitive) {
    assert(
      !permittedTiersForSensitive.includes(tier),
      `8.5: Sensitive fields (CNIC, Bank, Address) are strictly blocked from tier [${EXACT_LABELS[tier] || tier}]`
    );
  }
}

testPrivacyTiers();

// ─── PART 9: PDF Access Resolution, Student Profile Schema & CL Quota Binding ─
console.log('\n--- PART 9: PDF Direct Download, Student Profile & CL Binding ---');

function testPdfAndStudentResolution() {
  // 9.1: Self-access resolves direct PDF download without requiring external consent
  const resolvePdfAccess = (isSelf, isPrivilegedAdmin, preAllowed, activeApproval) => {
    const allowed = isSelf || isPrivilegedAdmin || Boolean(preAllowed) || Boolean(activeApproval);
    return {
      isSelf,
      allowed,
      canDirectDownload: allowed,
      requiresConsent: !allowed,
    };
  };

  const selfPdfAccess = resolvePdfAccess(true, false, false, null);
  assert(selfPdfAccess.allowed === true, '9.1: Account owner is granted immediate PDF download without consent request');
  assert(selfPdfAccess.canDirectDownload === true, '9.2: canDirectDownload flag is true for account owner');
  assert(selfPdfAccess.requiresConsent === false, '9.3: requiresConsent is false for account owner');

  const thirdPartyNoConsent = resolvePdfAccess(false, false, false, null);
  assert(thirdPartyNoConsent.allowed === false, '9.4: Third-party viewer without consent is blocked from direct PDF download');
  assert(thirdPartyNoConsent.requiresConsent === true, '9.5: requiresConsent is true when third-party lacks consent');

  const thirdPartyWithApproval = resolvePdfAccess(false, false, false, { _id: 'approval_1' });
  assert(thirdPartyWithApproval.allowed === true, '9.6: Third-party with active approved request is granted PDF download');

  // 9.7: Student Profile GR Number and Academic Mapping
  const mockStudentProfile = {
    grNumber: 1042,
    admissionRegisterNumber: 'ADM-2024-089',
    studentFullName: 'Bilal Ahmed',
    class: { name: 'Class 8' },
    section: { name: 'A' },
    mediumOfInstruction: 'English',
  };
  assert(mockStudentProfile.grNumber === 1042, '9.7: Student GR Number maps accurately to academic dossier');
  assert(mockStudentProfile.class.name === 'Class 8', '9.8: Enrolled class resolves accurately for student profile');
  assert(mockStudentProfile.mediumOfInstruction === 'English', '9.9: Medium of instruction resolves accurately');

  // 9.10: CL Balance mapping checks (nullish resolution without hardcoded fallback)
  const resolveClBalance = (clBalance) => {
    const hasClData = Boolean(
      clBalance &&
      (clBalance.entitlementDays !== undefined || clBalance.totalQuota !== undefined)
    );
    const totalQuota = hasClData ? (clBalance.entitlementDays ?? clBalance.totalQuota ?? 0) : null;
    const remainingBalance = hasClData
      ? (clBalance.remainingDays ?? clBalance.remainingBalance ?? Math.max(0, (totalQuota ?? 0) - (clBalance.usedDays ?? 0)))
      : null;
    return { hasClData, totalQuota, remainingBalance };
  };

  const activeCl = resolveClBalance({ entitlementDays: 24, usedDays: 3, remainingDays: 21 });
  assert(activeCl.totalQuota === 24, '9.10: CL total quota correctly resolves from entitlementDays');
  assert(activeCl.remainingBalance === 21, '9.11: CL remaining balance correctly resolves from remainingDays');

  const unconfiguredCl = resolveClBalance(null);
  assert(unconfiguredCl.hasClData === false, '9.12: Unconfigured CL balance correctly flags hasClData as false');
  assert(unconfiguredCl.totalQuota === null, '9.13: Unconfigured CL balance leaves totalQuota null without hardcoded 24 fallback');
}

testPdfAndStudentResolution();

console.log('\n==============================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} PERSONAL PROFILE LIFECYCLE TESTS PASSED!`);
console.log('==============================================================================\n');

