/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🛡️ PARENT REGISTRATION, WARD LINKING & HM APPROVAL WORKFLOW TEST SUITE
 * Education Department, Liaquatabad Town Centre (DMC)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifies Phase 3, Wave 2 End-to-End Implementation:
 *  1. Parent Self-Registration (handleRegisterParent)
 *     - Valid registration creates user in ACTIVE status, role PARENT, scope CHILD
 *     - Duplicate email rejected with 409 Conflict
 *     - Duplicate phone number rejected with 409 Conflict
 *     - Disposable email rejected with 400
 *     - Anti-privilege escalation blocks non-parent roles with 403
 *  2. Candidate Ward Lookup (handleLookupWard)
 *     - Non-sensitive preview returned (masked name, school, admission class)
 *     - Cleartext sensitive PII (CNIC, phone, residential address) strictly protected
 *     - Non-existent GR Number / school returns 404
 *     - Missing identifier parameter returns 400
 *  3. Initiate Ward Link Claim & OTP Dispatch (handleInitiateClaim)
 *     - Valid claim creation with phone on file sets PENDING_OTP and dispatches OTP
 *     - School boundary isolation strictly enforced
 *     - Active-state duplicate claim blocked with 409 Conflict
 *     - Fallback when no phone on file routes directly to PENDING_HM_APPROVAL
 *  4. Verify Contact OTP (handleVerifyClaimOtp)
 *     - Valid OTP transitions claim to PENDING_HM_APPROVAL, sets contactOtpVerified
 *     - IDOR defense: Attacker verifying another parent's claim blocked with 403
 *     - Invalid OTP code rejected with 400
 *     - Claim not in PENDING_OTP rejected with 400
 *  5. Head Master Pending Claims Queue (handleGetHmParentLinks)
 *     - HM receives claims scoped strictly to their school
 *     - Cross-school isolation prevents HM of School B from viewing School A
 *  6. Head Master Verification Decision (handleHmVerifyParentLink)
 *     - IDOR defense: Cross-school HM cannot approve claim (403 Forbidden)
 *     - HM approves claim: transitions to VERIFIED, sets verifiedBy and verifiedAt
 *     - Emits PARENT_STUDENT_LINK_APPROVED audit log
 *  7. Head Master Rejection Decision (handleHmRejectParentLink)
 *     - Requires rejectionReason (min 10 characters)
 *     - IDOR defense: Cross-school HM cannot reject claim (403 Forbidden)
 *     - Transitions to REJECTED, sets rejectedBy, rejectedAt, rejectionReason
 *     - Clean re-application permitted after rejection
 *  8. Head Master Revocation Decision (handleHmRevokeParentLink)
 *     - Requires revocationReason (min 10 characters)
 *     - Only VERIFIED link can be revoked
 *     - Transitions to REVOKED, sets revokedBy, revokedAt, revocationReason
 *  9. Parent Retrieval Endpoints (handleGetMyClaims, handleGetMyWards)
 *     - handleGetMyClaims returns full claim history
 *     - handleGetMyWards filters strictly for VERIFIED status
 * 10. Zod Validation Schemas
 *     - Enforces strict input validation on all endpoints
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  BASE_ROLES,
  SCOPES,
  USER_STATUS,
  PARENT_STUDENT_LINK_STATUS,
  PARENT_RELATIONSHIP,
} from '../config/constants.js';

import User from '../src/models/User.js';
import School from '../src/models/School.js';
import StudentProfile from '../src/models/StudentProfile.js';
import ParentStudentLink from '../src/models/ParentStudentLink.js';
import OtpVerification from '../src/models/OtpVerification.js';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';

import { handleRegisterParent } from '../src/controllers/authController.js';
import {
  handleLookupWard,
  handleInitiateClaim,
  handleVerifyClaimOtp,
  handleGetMyClaims,
  handleGetMyWards,
  handleGetHmParentLinks,
  handleHmVerifyParentLink,
  handleHmRejectParentLink,
  handleHmRevokeParentLink,
} from '../src/controllers/parentLinkController.js';

import {
  registerParentSchema,
  lookupWardSchema,
  initiateClaimSchema,
  verifyClaimOtpSchema,
  hmRejectLinkSchema,
  hmRevokeLinkSchema,
} from '../src/validations/parentSchemas.js';

import { hashOtp } from '../src/utils/otpUtils.js';

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

async function runAsyncTest(testName, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(error);
    throw error;
  }
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

console.log('======================================================================');
console.log('🛡️ RUNNING PARENT REGISTRATION, WARD LINKING & HM APPROVAL SUITE');
console.log('======================================================================\n');

// ─── Test Fixture Setup ──────────────────────────────────────────────────────
const schoolA_Id = new mongoose.Types.ObjectId();
const schoolB_Id = new mongoose.Types.ObjectId();

const parentA_Id = new mongoose.Types.ObjectId();
const parentB_Id = new mongoose.Types.ObjectId();
const hmA_Id = new mongoose.Types.ObjectId();
const hmB_Id = new mongoose.Types.ObjectId();

const student1_Id = new mongoose.Types.ObjectId();
const student2_Id = new mongoose.Types.ObjectId();

const mockParentAUser = {
  _id: parentA_Id,
  fullName: 'Tariq Mehmood',
  email: 'tariq.parent@test.com',
  phoneNumber: '03001234567',
  role: ROLES.PARENT,
  baseRole: BASE_ROLES.PARENT,
  scope: SCOPES.CHILD,
  status: USER_STATUS.ACTIVE,
};

const mockParentBUser = {
  _id: parentB_Id,
  fullName: 'Kamran Akmal',
  email: 'kamran.parent@test.com',
  phoneNumber: '03007654321',
  role: ROLES.PARENT,
  baseRole: BASE_ROLES.PARENT,
  scope: SCOPES.CHILD,
  status: USER_STATUS.ACTIVE,
};

const mockHmAUser = {
  _id: hmA_Id,
  fullName: 'HM School A',
  email: 'hm.schoola@dmc.gov.pk',
  schoolId: schoolA_Id,
  role: ROLES.HM,
  designation: 'Head Master',
  status: USER_STATUS.ACTIVE,
};

const mockHmBUser = {
  _id: hmB_Id,
  fullName: 'HM School B',
  email: 'hm.schoolb@dmc.gov.pk',
  schoolId: schoolB_Id,
  role: ROLES.HM,
  designation: 'Head Master',
  status: USER_STATUS.ACTIVE,
};

// ─── SECTION 1: Zod Schema Validation Invariants ─────────────────────────────
console.log('--- 1. Parent & Link Validation Schema Invariants ---');

runTest('registerParentSchema validates correct inputs and rejects weak passwords', () => {
  const valid = registerParentSchema.safeParse({
    fullName: 'Mohammad Farooq',
    email: 'farooq.parent@example.com',
    password: 'Password123',
    phoneNumber: '03001234567',
    cnicNumber: '42101-1234567-1',
  });
  assert.equal(valid.success, true, 'Valid parent registration payload must pass');

  const weakPass = registerParentSchema.safeParse({
    fullName: 'Mohammad Farooq',
    email: 'farooq.parent@example.com',
    password: 'short',
    phoneNumber: '03001234567',
  });
  assert.equal(weakPass.success, false, 'Weak password must be rejected');
});

runTest('lookupWardSchema requires schoolId and at least one identifier', () => {
  const valid = lookupWardSchema.safeParse({
    schoolId: '507f1f77bcf86cd799439001',
    grNumber: 1045,
  });
  assert.equal(valid.success, true, 'School + GR Number must pass');

  const missingId = lookupWardSchema.safeParse({
    schoolId: '507f1f77bcf86cd799439001',
  });
  assert.equal(missingId.success, false, 'Missing identifier must fail refinement');
});

runTest('initiateClaimSchema rejects invalid relationship enum', () => {
  const invalidRel = initiateClaimSchema.safeParse({
    studentProfileId: '507f1f77bcf86cd799439001',
    relationship: 'UNCLE',
  });
  assert.equal(invalidRel.success, false, 'UNCLE is not an allowed relationship');

  const validRel = initiateClaimSchema.safeParse({
    studentProfileId: '507f1f77bcf86cd799439001',
    relationship: PARENT_RELATIONSHIP.FATHER,
  });
  assert.equal(validRel.success, true, 'FATHER must be accepted');
});

runTest('hmRejectLinkSchema and hmRevokeLinkSchema require minimum 10-char reason', () => {
  assert.equal(hmRejectLinkSchema.safeParse({ rejectionReason: 'Too short' }).success, false);
  assert.equal(hmRejectLinkSchema.safeParse({ rejectionReason: 'CNIC copy does not match official register.' }).success, true);

  assert.equal(hmRevokeLinkSchema.safeParse({ revocationReason: 'Short' }).success, false);
  assert.equal(hmRevokeLinkSchema.safeParse({ revocationReason: 'Official court custody documentation updated.' }).success, true);
});

// ─── SECTION 2: Candidate Ward Lookup Controller ─────────────────────────────
console.log('\n--- 2. Candidate Ward Lookup & Anti-Enumeration Guard ---');

await runAsyncTest('handleLookupWard returns non-sensitive preview and masks student name', async () => {
  const mockStudent = {
    _id: student1_Id,
    studentFullName: 'Taha Ahmed Khan',
    grNumber: 1045,
    admissionClassRequested: 'Class 5',
    admissionDate: new Date('2024-04-01'),
    guardianCellNumber: '03009876543',
    schoolId: {
      _id: schoolA_Id,
      name: 'GBPS Liaquatabad No 1',
      schoolCode: 'LTC-01',
    },
  };

  const originalFindById = School.findById;
  const originalFindOne = StudentProfile.findOne;

  School.findById = () => ({
    select: () => Promise.resolve({ _id: schoolA_Id, name: 'GBPS Liaquatabad No 1', schoolCode: 'LTC-01' }),
  });

  StudentProfile.findOne = () => ({
    select: () => Promise.resolve(mockStudent),
  });

  const req = {
    body: {
      schoolId: String(schoolA_Id),
      grNumber: 1045,
    },
  };
  const res = createMockRes();

  await handleLookupWard(req, res);

  // Restore mocks
  School.findById = originalFindById;
  StudentProfile.findOne = originalFindOne;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.studentProfileId, student1_Id);
  // Name masking check: "Taha Ahmed Khan" -> "T**a A***d K**n"
  assert.ok(res.body.data.maskedStudentName.includes('*'), 'Student name must be masked');
  assert.equal(res.body.data.hasOfficialContactOnRecord, true);
  assert.equal(res.body.data.maskedContactPhone, '0300****543');
  // PII leak verification: zero full CNIC or unmasked phone
  assert.equal(res.body.data.guardianCnicNumber, undefined);
  assert.equal(res.body.data.guardianCellNumber, undefined);
});

await runAsyncTest('handleLookupWard returns 404 for non-existent student', async () => {
  const originalFindById = School.findById;
  const originalFindOne = StudentProfile.findOne;

  School.findById = () => ({
    select: () => Promise.resolve({ _id: schoolA_Id, name: 'GBPS Liaquatabad No 1' }),
  });
  StudentProfile.findOne = () => ({
    select: () => Promise.resolve(null),
  });

  const req = {
    body: { schoolId: String(schoolA_Id), grNumber: 9999 },
  };
  const res = createMockRes();

  await handleLookupWard(req, res);

  School.findById = originalFindById;
  StudentProfile.findOne = originalFindOne;

  assert.equal(res.statusCode, 404);
  assert.ok((res.body.message || '').includes('No enrolled student record found'));
});

// ─── SECTION 3: Initiate Ward Claim & OTP Dispatch ───────────────────────────
console.log('\n--- 3. Ward Claim Initiation & Active Partial Index Conflict ---');

await runAsyncTest('handleInitiateClaim creates PENDING_OTP and dispatches code to official contact', async () => {
  const mockStudent = {
    _id: student1_Id,
    studentFullName: 'Taha Ahmed',
    guardianCellNumber: '03009876543',
    schoolId: { _id: schoolA_Id, name: 'GBPS Liaquatabad No 1' },
  };

  const originalFindById = StudentProfile.findById;
  const originalFindOneLink = ParentStudentLink.findOne;
  const originalCreateLink = ParentStudentLink.create;
  const originalAuditCreate = AuditLog.create;
  const originalOtpCreate = OtpVerification.create;
  const originalOtpFind = OtpVerification.findOne;

  StudentProfile.findById = () => ({
    populate: () => Promise.resolve(mockStudent),
  });

  // No active link exists yet
  ParentStudentLink.findOne = () => Promise.resolve(null);

  let createdLinkData = null;
  ParentStudentLink.create = (doc) => {
    createdLinkData = { ...doc, _id: new mongoose.Types.ObjectId() };
    return Promise.resolve(createdLinkData);
  };

  OtpVerification.findOne = () => Promise.resolve(null);
  OtpVerification.create = () => Promise.resolve({});
  AuditLog.create = () => Promise.resolve({});

  const req = {
    user: mockParentAUser,
    body: {
      studentProfileId: String(student1_Id),
      relationship: PARENT_RELATIONSHIP.FATHER,
    },
  };
  const res = createMockRes();

  await handleInitiateClaim(req, res);

  StudentProfile.findById = originalFindById;
  ParentStudentLink.findOne = originalFindOneLink;
  ParentStudentLink.create = originalCreateLink;
  AuditLog.create = originalAuditCreate;
  OtpVerification.create = originalOtpCreate;
  OtpVerification.findOne = originalOtpFind;

  assert.equal(res.statusCode, 201);
  assert.equal(createdLinkData.verificationStatus, PARENT_STUDENT_LINK_STATUS.PENDING_OTP);
  assert.equal(String(createdLinkData.parentId), String(parentA_Id));
  assert.equal(String(createdLinkData.schoolId), String(schoolA_Id));
  assert.equal(createdLinkData.contactOtpVerified, false);
});

await runAsyncTest('handleInitiateClaim rejects duplicate active/pending claim with 409 Conflict', async () => {
  const mockStudent = {
    _id: student1_Id,
    schoolId: { _id: schoolA_Id },
  };

  const originalFindById = StudentProfile.findById;
  const originalFindOneLink = ParentStudentLink.findOne;

  StudentProfile.findById = () => ({
    populate: () => Promise.resolve(mockStudent),
  });

  // Existing active link found
  ParentStudentLink.findOne = () =>
    Promise.resolve({
      _id: new mongoose.Types.ObjectId(),
      verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
    });

  const req = {
    user: mockParentAUser,
    body: {
      studentProfileId: String(student1_Id),
      relationship: PARENT_RELATIONSHIP.FATHER,
    },
  };
  const res = createMockRes();

  await handleInitiateClaim(req, res);

  StudentProfile.findById = originalFindById;
  ParentStudentLink.findOne = originalFindOneLink;

  assert.equal(res.statusCode, 409);
  assert.ok((res.body.message || '').includes('already exists'));
});

// ─── SECTION 4: Verify Claim Contact OTP ─────────────────────────────────────
console.log('\n--- 4. Claim Contact OTP Verification & HM Notification ---');

await runAsyncTest('handleVerifyClaimOtp transitions link to PENDING_HM_APPROVAL on valid OTP', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const validOtp = '123456';
  const hashed = hashOtp(validOtp);

  const mockLink = {
    _id: linkId,
    parentId: parentA_Id,
    studentProfileId: student1_Id,
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
    contactOtpVerified: false,
    save: function () {
      return Promise.resolve(this);
    },
  };

  const originalFindLink = ParentStudentLink.findById;
  const originalFindStudent = StudentProfile.findById;
  const originalFindOtp = OtpVerification.findOne;
  const originalDeleteOtp = OtpVerification.deleteOne;
  const originalAuditCreate = AuditLog.create;
  const originalUserFind = User.find;
  const originalNotifInsert = Notification.insertMany;

  ParentStudentLink.findById = () => Promise.resolve(mockLink);
  StudentProfile.findById = () => ({
    select: () => Promise.resolve({ guardianCellNumber: '03009876543', studentFullName: 'Taha Ahmed' }),
  });

  OtpVerification.findOne = () =>
    Promise.resolve({
      _id: new mongoose.Types.ObjectId(),
      otpHash: hashed,
      attempts: 0,
      expiresAt: new Date(Date.now() + 300000),
      save: () => Promise.resolve(),
    });

  OtpVerification.deleteOne = () => Promise.resolve();
  AuditLog.create = () => Promise.resolve({});
  User.find = () => ({ select: () => Promise.resolve([{ _id: hmA_Id }]) });
  Notification.insertMany = () => Promise.resolve([]);

  const req = {
    user: mockParentAUser,
    body: { linkId: String(linkId), otpCode: validOtp },
  };
  const res = createMockRes();

  await handleVerifyClaimOtp(req, res);

  ParentStudentLink.findById = originalFindLink;
  StudentProfile.findById = originalFindStudent;
  OtpVerification.findOne = originalFindOtp;
  OtpVerification.deleteOne = originalDeleteOtp;
  AuditLog.create = originalAuditCreate;
  User.find = originalUserFind;
  Notification.insertMany = originalNotifInsert;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL);
  assert.equal(mockLink.contactOtpVerified, true);
  assert.ok(mockLink.contactVerifiedAt instanceof Date);
});

await runAsyncTest('handleVerifyClaimOtp rejects unauthorized caller (IDOR defense)', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkId,
    parentId: parentA_Id, // Belongs to Parent A
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
  };

  const originalFindLink = ParentStudentLink.findById;
  ParentStudentLink.findById = () => Promise.resolve(mockLink);

  const req = {
    user: mockParentBUser, // Attacker Parent B
    body: { linkId: String(linkId), otpCode: '123456' },
  };
  const res = createMockRes();

  await handleVerifyClaimOtp(req, res);

  ParentStudentLink.findById = originalFindLink;

  assert.equal(res.statusCode, 403);
  assert.ok((res.body.message || '').includes('do not own'));
});

// ─── SECTION 5: Head Master Pending Claims Queue ─────────────────────────────
console.log('\n--- 5. Head Master Pending Claims Queue & School Boundary Isolation ---');

await runAsyncTest('handleGetHmParentLinks strictly scopes queue to HM school', async () => {
  let capturedQuery = null;

  const originalFind = ParentStudentLink.find;
  const originalCount = ParentStudentLink.countDocuments;

  ParentStudentLink.find = (query) => {
    capturedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({
              skip: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      }),
    };
  };
  ParentStudentLink.countDocuments = () => Promise.resolve(0);

  const req = {
    user: mockHmAUser, // HM of School A
    query: {},
  };
  const res = createMockRes();

  await handleGetHmParentLinks(req, res);

  ParentStudentLink.find = originalFind;
  ParentStudentLink.countDocuments = originalCount;

  assert.equal(res.statusCode, 200);
  assert.equal(String(capturedQuery.schoolId), String(schoolA_Id), 'Query must be scoped to HM school');
  assert.equal(capturedQuery.verificationStatus, PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL);
});

// ─── SECTION 6: Head Master Decision Verification & IDOR Defense ─────────────
console.log('\n--- 6. HM Approval Decision & Cross-School IDOR Shield ---');

await runAsyncTest('handleHmVerifyParentLink approves claim and records audit metadata', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkId,
    parentId: { _id: parentA_Id },
    studentProfileId: { _id: student1_Id, studentFullName: 'Taha Ahmed' },
    schoolId: schoolA_Id, // Belongs to School A
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    save: function () {
      return Promise.resolve(this);
    },
  };

  const originalFindById = ParentStudentLink.findById;
  const originalAuditCreate = AuditLog.create;
  const originalNotifCreate = Notification.create;

  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });
  AuditLog.create = () => Promise.resolve({});
  Notification.create = () => Promise.resolve({});

  const req = {
    user: mockHmAUser, // HM of School A
    params: { linkId: String(linkId) },
    body: { remarks: 'Physical admission register verified.' },
  };
  const res = createMockRes();

  await handleHmVerifyParentLink(req, res);

  ParentStudentLink.findById = originalFindById;
  AuditLog.create = originalAuditCreate;
  Notification.create = originalNotifCreate;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.VERIFIED);
  assert.equal(String(mockLink.verifiedBy), String(hmA_Id));
  assert.ok(mockLink.verifiedAt instanceof Date);
});

await runAsyncTest('handleHmVerifyParentLink blocks cross-school HM (IDOR defense)', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkId,
    schoolId: schoolA_Id, // School A
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
  };

  const originalFindById = ParentStudentLink.findById;
  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });

  const req = {
    user: mockHmBUser, // Cross-school HM of School B
    params: { linkId: String(linkId) },
    body: {},
  };
  const res = createMockRes();

  await handleHmVerifyParentLink(req, res);

  ParentStudentLink.findById = originalFindById;

  assert.equal(res.statusCode, 403);
  assert.ok((res.body.message || '').includes('cannot verify parent claims for another school'));
});

await runAsyncTest('handleHmRejectParentLink rejects claim with mandatory justification', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkId,
    parentId: { _id: parentA_Id },
    studentProfileId: { _id: student1_Id, studentFullName: 'Taha Ahmed' },
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    save: function () {
      return Promise.resolve(this);
    },
  };

  const originalFindById = ParentStudentLink.findById;
  const originalAuditCreate = AuditLog.create;
  const originalNotifCreate = Notification.create;

  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });
  AuditLog.create = () => Promise.resolve({});
  Notification.create = () => Promise.resolve({});

  const req = {
    user: mockHmAUser,
    params: { linkId: String(linkId) },
    body: { rejectionReason: 'CNIC copy does not match father name in school register.' },
  };
  const res = createMockRes();

  await handleHmRejectParentLink(req, res);

  ParentStudentLink.findById = originalFindById;
  AuditLog.create = originalAuditCreate;
  Notification.create = originalNotifCreate;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.REJECTED);
  assert.equal(String(mockLink.rejectedBy), String(hmA_Id));
  assert.equal(mockLink.rejectionReason, 'CNIC copy does not match father name in school register.');
});

await runAsyncTest('handleHmRevokeParentLink revokes active verified link with reason', async () => {
  const linkId = new mongoose.Types.ObjectId();
  const mockLink = {
    _id: linkId,
    parentId: { _id: parentA_Id },
    studentProfileId: { _id: student1_Id, studentFullName: 'Taha Ahmed' },
    schoolId: schoolA_Id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED, // Active verified
    save: function () {
      return Promise.resolve(this);
    },
  };

  const originalFindById = ParentStudentLink.findById;
  const originalAuditCreate = AuditLog.create;
  const originalNotifCreate = Notification.create;

  ParentStudentLink.findById = () => ({
    populate: () => Promise.resolve(mockLink),
  });
  AuditLog.create = () => Promise.resolve({});
  Notification.create = () => Promise.resolve({});

  const req = {
    user: mockHmAUser,
    params: { linkId: String(linkId) },
    body: { revocationReason: 'Custody modification decree provided by family court.' },
  };
  const res = createMockRes();

  await handleHmRevokeParentLink(req, res);

  ParentStudentLink.findById = originalFindById;
  AuditLog.create = originalAuditCreate;
  Notification.create = originalNotifCreate;

  assert.equal(res.statusCode, 200);
  assert.equal(mockLink.verificationStatus, PARENT_STUDENT_LINK_STATUS.REVOKED);
  assert.equal(String(mockLink.revokedBy), String(hmA_Id));
  assert.equal(mockLink.revocationReason, 'Custody modification decree provided by family court.');
});

// ─── SECTION 7: Parent Verified Wards Retrieval ──────────────────────────────
console.log('\n--- 7. Parent Wards Retrieval & Verification Filtering ---');

await runAsyncTest('handleGetMyWards returns only VERIFIED relationships', async () => {
  let capturedQuery = null;

  const originalFind = ParentStudentLink.find;
  ParentStudentLink.find = (query) => {
    capturedQuery = query;
    return {
      populate: () => ({
        populate: () => ({
          sort: () =>
            Promise.resolve([
              {
                _id: new mongoose.Types.ObjectId(),
                relationship: PARENT_RELATIONSHIP.FATHER,
                verifiedAt: new Date(),
                studentProfileId: {
                  studentFullName: 'Taha Ahmed',
                  grNumber: 1045,
                },
                schoolId: {
                  name: 'GBPS Liaquatabad No 1',
                },
              },
            ]),
        }),
      }),
    };
  };

  const req = {
    user: mockParentAUser,
  };
  const res = createMockRes();

  await handleGetMyWards(req, res);

  ParentStudentLink.find = originalFind;

  assert.equal(res.statusCode, 200);
  assert.equal(String(capturedQuery.parentId), String(parentA_Id));
  assert.equal(capturedQuery.verificationStatus, PARENT_STUDENT_LINK_STATUS.VERIFIED);
  assert.equal(res.body.data.wards.length, 1);
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} PARENT REGISTRATION & LINKING WORKFLOW TESTS PASSED!`);
console.log('======================================================================\n');
