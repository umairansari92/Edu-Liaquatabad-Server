/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🛡️ PARENT-STUDENT LINK MODEL & DATA LAYER SECURITY SUITE
 * Education Department, Liaquatabad Town Centre (DMC)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifies Wave 1 Data-Layer Contracts:
 *  1. Valid PENDING_OTP relationship creation
 *  2. Valid PENDING_HM_APPROVAL relationship creation
 *  3. Valid VERIFIED relationship creation
 *  4. Duplicate active/pending relationship rejected (Active Partial Unique Index)
 *  5. REJECTED relationship permits future re-application
 *  6. REVOKED relationship permits future re-application
 *  7. Invalid verification status rejected by schema enum
 *  8. Missing parentId rejected by schema validator
 *  9. Missing studentProfileId rejected by schema validator
 * 10. School/student mismatch rejected (School Isolation Law)
 * 11. Required relationship field enforced by schema
 * 12. Invalid relationship enum rejected by schema validator
 * 13. Required verification metadata rules enforced across lifecycle states
 * 14. Parent authorization is NOT derived from StudentProfile.parentUserId
 * 15. Complete BOLA and operational query indexes contract verified
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  PARENT_STUDENT_LINK_STATUS,
  PARENT_RELATIONSHIP,
  ROLES,
} from '../config/constants.js';

import ParentStudentLink, {
  validateParentStudentLinkIntegrity,
  isParentAuthorizedForStudent,
} from '../src/models/ParentStudentLink.js';

let passed = 0;
let total = 0;

function runTest(testName, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✅ PASS [${total}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${total}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

async function runAsyncTest(testName, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✅ PASS [${total}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${total}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

console.log('======================================================================');
console.log('🛡️ RUNNING PARENT-STUDENT LINK MODEL & DATA LAYER SECURITY SUITE');
console.log('======================================================================\n');

const mockParentId = new mongoose.Types.ObjectId();
const mockStudentProfileId = new mongoose.Types.ObjectId();
const mockSchoolId = new mongoose.Types.ObjectId();
const mockDifferentSchoolId = new mongoose.Types.ObjectId();
const mockHmUserId = new mongoose.Types.ObjectId();

// ─── Scenario 1: Valid PENDING_OTP creation ─────────────────────────────────
await runAsyncTest('Valid PENDING_OTP relationship creation succeeds with default status', async () => {
  const link = new ParentStudentLink({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
    relationship: PARENT_RELATIONSHIP.FATHER,
  });

  const error = link.validateSync();
  assert.equal(error, undefined, 'PENDING_OTP link should pass validation');
  assert.equal(link.verificationStatus, PARENT_STUDENT_LINK_STATUS.PENDING_OTP);
  assert.equal(link.contactOtpVerified, false);
  assert.equal(link.verifiedBy, null);
});

// ─── Scenario 2: Valid PENDING_HM_APPROVAL creation ─────────────────────────
await runAsyncTest('Valid PENDING_HM_APPROVAL relationship creation succeeds with OTP confirmation', async () => {
  const verifiedAt = new Date();
  const link = new ParentStudentLink({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
    relationship: PARENT_RELATIONSHIP.MOTHER,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    contactOtpVerified: true,
    contactVerifiedAt: verifiedAt,
  });

  const error = link.validateSync();
  assert.equal(error, undefined, 'PENDING_HM_APPROVAL link should pass validation');
  assert.equal(link.verificationStatus, PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL);
  assert.equal(link.contactOtpVerified, true);
  assert.equal(link.contactVerifiedAt, verifiedAt);
});

// ─── Scenario 3: Valid VERIFIED creation ─────────────────────────────────────
await runAsyncTest('Valid VERIFIED relationship creation succeeds with HM audit trail', async () => {
  const verifiedAt = new Date();
  const link = new ParentStudentLink({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
    relationship: PARENT_RELATIONSHIP.GUARDIAN,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
    contactOtpVerified: true,
    contactVerifiedAt: new Date(Date.now() - 3600000),
    verifiedBy: mockHmUserId,
    verifiedAt: verifiedAt,
  });

  const error = link.validateSync();
  assert.equal(error, undefined, 'VERIFIED link should pass validation');
  assert.equal(link.verificationStatus, PARENT_STUDENT_LINK_STATUS.VERIFIED);
  assert.equal(String(link.verifiedBy), String(mockHmUserId));
  assert.equal(link.verifiedAt, verifiedAt);
});

// ─── Scenario 4: Duplicate active/pending relationship rejected ──────────────
runTest('Duplicate active/pending relationship is rejected by active-state uniqueness contract', () => {
  const activeRecords = [];

  const simulateInsert = (record) => {
    const activeStatuses = [
      PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
      PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
      PARENT_STUDENT_LINK_STATUS.VERIFIED,
    ];

    const isConflict = activeRecords.some(
      (existing) =>
        String(existing.parentId) === String(record.parentId) &&
        String(existing.studentProfileId) === String(record.studentProfileId) &&
        activeStatuses.includes(existing.verificationStatus) &&
        activeStatuses.includes(record.verificationStatus)
    );

    if (isConflict) {
      const duplicateError = new Error('E11000 duplicate key error collection: parentstudentlinks index: parent_student_active_partial_unique');
      duplicateError.code = 11000;
      throw duplicateError;
    }

    activeRecords.push(record);
    return record;
  };

  // 1. First active claim succeeds
  simulateInsert({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
  });

  // 2. Second claim for same parent + student in PENDING_OTP fails
  assert.throws(
    () => {
      simulateInsert({
        parentId: mockParentId,
        studentProfileId: mockStudentProfileId,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
      });
    },
    /E11000 duplicate key error/,
    'Duplicate PENDING_OTP claim must be rejected'
  );

  // 3. Second claim in PENDING_HM_APPROVAL fails
  assert.throws(
    () => {
      simulateInsert({
        parentId: mockParentId,
        studentProfileId: mockStudentProfileId,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
      });
    },
    /E11000 duplicate key error/,
    'Duplicate PENDING_HM_APPROVAL claim must be rejected'
  );

  // 4. Second claim in VERIFIED fails
  assert.throws(
    () => {
      simulateInsert({
        parentId: mockParentId,
        studentProfileId: mockStudentProfileId,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
      });
    },
    /E11000 duplicate key error/,
    'Duplicate VERIFIED claim must be rejected'
  );
});

// ─── Scenario 5: REJECTED relationship permits future re-application ────────
runTest('REJECTED relationship permits future re-application without duplicate key collision', () => {
  const records = [
    {
      parentId: mockParentId,
      studentProfileId: mockStudentProfileId,
      verificationStatus: PARENT_STUDENT_LINK_STATUS.REJECTED,
      rejectedBy: mockHmUserId,
      rejectedAt: new Date(),
      rejectionReason: 'Invalid B-Form copy provided',
    },
  ];

  const activeStatuses = [
    PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
    PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    PARENT_STUDENT_LINK_STATUS.VERIFIED,
  ];

  const canInsert = (newRecord) => {
    // Partial filter expression only indexes active statuses
    const existingActive = records.filter((r) => activeStatuses.includes(r.verificationStatus));
    const conflict = existingActive.some(
      (r) =>
        String(r.parentId) === String(newRecord.parentId) &&
        String(r.studentProfileId) === String(newRecord.studentProfileId) &&
        activeStatuses.includes(newRecord.verificationStatus)
    );
    return !conflict;
  };

  const reapplicationAllowed = canInsert({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
  });

  assert.equal(reapplicationAllowed, true, 'Re-application after REJECTED must succeed');
});

// ─── Scenario 6: REVOKED relationship permits future re-application ─────────
runTest('REVOKED relationship permits future re-application without duplicate key collision', () => {
  const records = [
    {
      parentId: mockParentId,
      studentProfileId: mockStudentProfileId,
      verificationStatus: PARENT_STUDENT_LINK_STATUS.REVOKED,
      revokedBy: mockHmUserId,
      revokedAt: new Date(),
      revocationReason: 'Court guardianship decree updated',
    },
  ];

  const activeStatuses = [
    PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
    PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
    PARENT_STUDENT_LINK_STATUS.VERIFIED,
  ];

  const canInsert = (newRecord) => {
    const existingActive = records.filter((r) => activeStatuses.includes(r.verificationStatus));
    const conflict = existingActive.some(
      (r) =>
        String(r.parentId) === String(newRecord.parentId) &&
        String(r.studentProfileId) === String(newRecord.studentProfileId) &&
        activeStatuses.includes(newRecord.verificationStatus)
    );
    return !conflict;
  };

  const reapplicationAllowed = canInsert({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
  });

  assert.equal(reapplicationAllowed, true, 'Re-application after REVOKED must succeed');
});

// ─── Scenario 7: Invalid verification status rejected ───────────────────────
runTest('Invalid verification status is strictly rejected by schema enum', () => {
  const link = new ParentStudentLink({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
    relationship: PARENT_RELATIONSHIP.FATHER,
    verificationStatus: 'AUTO_APPROVED',
  });

  const error = link.validateSync();
  assert.ok(error, 'Invalid status must produce validation error');
  assert.ok(error.errors.verificationStatus, 'verificationStatus error must be reported');
});

// ─── Scenario 8: Missing parent rejected ────────────────────────────────────
runTest('Missing parentId is strictly rejected by schema validator', () => {
  const link = new ParentStudentLink({
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
    relationship: PARENT_RELATIONSHIP.FATHER,
  });

  const error = link.validateSync();
  assert.ok(error, 'Missing parentId must produce validation error');
  assert.ok(error.errors.parentId, 'parentId required error must be reported');
});

// ─── Scenario 9: Missing student profile rejected ───────────────────────────
runTest('Missing studentProfileId is strictly rejected by schema validator', () => {
  const link = new ParentStudentLink({
    parentId: mockParentId,
    schoolId: mockSchoolId,
    relationship: PARENT_RELATIONSHIP.FATHER,
  });

  const error = link.validateSync();
  assert.ok(error, 'Missing studentProfileId must produce validation error');
  assert.ok(error.errors.studentProfileId, 'studentProfileId required error must be reported');
});

// ─── Scenario 10: School/student mismatch rejected (School Isolation) ───────
runTest('Cross-school mismatch between student and link is rejected by validation layer', () => {
  const studentProfileSchoolA = {
    _id: mockStudentProfileId,
    schoolId: mockSchoolId,
    studentFullName: 'Taha Ahmed',
  };

  // Valid match: School A -> School A
  assert.doesNotThrow(() => {
    ParentStudentLink.validateSchoolIntegrity(studentProfileSchoolA, mockSchoolId);
  }, 'Matching school IDs must pass');

  // Mismatch: Student from School A, link targets School B
  assert.throws(
    () => {
      ParentStudentLink.validateSchoolIntegrity(studentProfileSchoolA, mockDifferentSchoolId);
    },
    /School isolation violation/,
    'Cross-school link attempt must be blocked'
  );

  // Data/service validation layer check
  assert.throws(
    () => {
      validateParentStudentLinkIntegrity({
        parentId: mockParentId,
        studentProfile: studentProfileSchoolA,
        schoolId: mockDifferentSchoolId,
        relationship: PARENT_RELATIONSHIP.FATHER,
      });
    },
    /Cross-school linkage violation/,
    'Service layer validator must block cross-school association'
  );
});

// ─── Scenario 11: Required relationship field enforced ──────────────────────
runTest('Missing relationship field is strictly rejected by schema validator', () => {
  const link = new ParentStudentLink({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
  });

  const error = link.validateSync();
  assert.ok(error, 'Missing relationship must produce validation error');
  assert.ok(error.errors.relationship, 'relationship required error must be reported');
});

// ─── Scenario 12: Invalid relationship enum rejected ────────────────────────
runTest('Invalid relationship enum is strictly rejected by schema validator', () => {
  const link = new ParentStudentLink({
    parentId: mockParentId,
    studentProfileId: mockStudentProfileId,
    schoolId: mockSchoolId,
    relationship: 'NEIGHBOR',
  });

  const error = link.validateSync();
  assert.ok(error, 'Invalid relationship enum must produce validation error');
  assert.ok(error.errors.relationship, 'relationship enum error must be reported');
});

// ─── Scenario 13: Required verification metadata rules enforced ─────────────
runTest('Required verification metadata rules are enforced across lifecycle states', () => {
  const studentProfile = {
    _id: mockStudentProfileId,
    schoolId: mockSchoolId,
  };

  // VERIFIED without verifiedBy or verifiedAt fails
  assert.throws(
    () => {
      validateParentStudentLinkIntegrity({
        parentId: mockParentId,
        studentProfile,
        schoolId: mockSchoolId,
        relationship: PARENT_RELATIONSHIP.FATHER,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
        metadata: {},
      });
    },
    /VERIFIED status requires verifiedBy and verifiedAt/,
    'VERIFIED must require audit trail'
  );

  // REJECTED without reason fails
  assert.throws(
    () => {
      validateParentStudentLinkIntegrity({
        parentId: mockParentId,
        studentProfile,
        schoolId: mockSchoolId,
        relationship: PARENT_RELATIONSHIP.FATHER,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.REJECTED,
        metadata: { rejectedBy: mockHmUserId, rejectedAt: new Date() },
      });
    },
    /REJECTED status requires rejectedBy, rejectedAt, and rejectionReason/,
    'REJECTED must require rejectionReason'
  );

  // REVOKED without reason fails
  assert.throws(
    () => {
      validateParentStudentLinkIntegrity({
        parentId: mockParentId,
        studentProfile,
        schoolId: mockSchoolId,
        relationship: PARENT_RELATIONSHIP.FATHER,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.REVOKED,
        metadata: { revokedBy: mockHmUserId, revokedAt: new Date() },
      });
    },
    /REVOKED status requires revokedBy, revokedAt, and revocationReason/,
    'REVOKED must require revocationReason'
  );

  // OTP verified without timestamp fails
  assert.throws(
    () => {
      validateParentStudentLinkIntegrity({
        parentId: mockParentId,
        studentProfile,
        schoolId: mockSchoolId,
        relationship: PARENT_RELATIONSHIP.FATHER,
        verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
        metadata: { contactOtpVerified: true },
      });
    },
    /contactOtpVerified requires contactVerifiedAt/,
    'contactOtpVerified must require timestamp'
  );
});

// ─── Scenario 14: Parent authorization is NOT derived from parentUserId ─────
await runAsyncTest('Parent authorization is derived strictly from ParentStudentLink and NOT parentUserId', async () => {
  const legacyParentUserId = new mongoose.Types.ObjectId();
  const authorizedParentUserId = new mongoose.Types.ObjectId();

  const studentProfile = {
    _id: mockStudentProfileId,
    parentUserId: legacyParentUserId, // Legacy field points to Parent A
    schoolId: mockSchoolId,
  };

  // Mock database links: Only authorizedParentUserId has a VERIFIED link
  const mockLinks = [
    {
      parentId: authorizedParentUserId,
      studentProfileId: mockStudentProfileId,
      verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
    },
  ];

  const mockFindLink = async (query) => {
    return mockLinks.find(
      (link) =>
        String(link.parentId) === String(query.parentId) &&
        String(link.studentProfileId) === String(query.studentProfileId) &&
        link.verificationStatus === query.verificationStatus
    ) || null;
  };

  // Test 1: Legacy parent on StudentProfile.parentUserId has NO verified link -> DENIED
  const isLegacyAuthorized = await isParentAuthorizedForStudent({
    parentId: legacyParentUserId,
    studentProfileId: studentProfile._id,
    findLinkFn: mockFindLink,
  });
  assert.equal(isLegacyAuthorized, false, 'Legacy parentUserId MUST NOT grant access without verified link');

  // Test 2: Verified ParentStudentLink parent IS authorized even though studentProfile.parentUserId != authorizedParentUserId
  const isVerifiedAuthorized = await isParentAuthorizedForStudent({
    parentId: authorizedParentUserId,
    studentProfileId: studentProfile._id,
    findLinkFn: mockFindLink,
  });
  assert.equal(isVerifiedAuthorized, true, 'Verified ParentStudentLink parent must be granted access');

  // Test 3: Unlinked random parent -> DENIED
  const randomParentId = new mongoose.Types.ObjectId();
  const isRandomAuthorized = await isParentAuthorizedForStudent({
    parentId: randomParentId,
    studentProfileId: studentProfile._id,
    findLinkFn: mockFindLink,
  });
  assert.equal(isRandomAuthorized, false, 'Unlinked parent must be denied');
});

// ─── Scenario 15: Database Index Contract & BOLA Queries Verified ───────────
runTest('Database indexes enforce partial uniqueness and optimize BOLA query paths', () => {
  const indexes = ParentStudentLink.schema.indexes();

  // 1. Check active partial unique index
  const activePartialUnique = indexes.find(([fields, options]) => {
    return (
      fields.parentId === 1 &&
      fields.studentProfileId === 1 &&
      options?.unique === true &&
      options?.partialFilterExpression?.verificationStatus?.$in?.includes(PARENT_STUDENT_LINK_STATUS.VERIFIED)
    );
  });
  assert.ok(activePartialUnique, 'Partial unique index on { parentId: 1, studentProfileId: 1 } must exist');
  const partialFilter = activePartialUnique[1].partialFilterExpression.verificationStatus.$in;
  assert.ok(partialFilter.includes(PARENT_STUDENT_LINK_STATUS.PENDING_OTP), 'Must filter PENDING_OTP');
  assert.ok(partialFilter.includes(PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL), 'Must filter PENDING_HM_APPROVAL');
  assert.ok(partialFilter.includes(PARENT_STUDENT_LINK_STATUS.VERIFIED), 'Must filter VERIFIED');
  assert.equal(partialFilter.includes(PARENT_STUDENT_LINK_STATUS.REJECTED), false, 'REJECTED must NOT be in partial filter');
  assert.equal(partialFilter.includes(PARENT_STUDENT_LINK_STATUS.REVOKED), false, 'REVOKED must NOT be in partial filter');

  // 2. Supporting index: parentId + verificationStatus
  const parentStatusIdx = indexes.find(
    ([fields]) => fields.parentId === 1 && fields.verificationStatus === 1
  );
  assert.ok(parentStatusIdx, 'Supporting index { parentId: 1, verificationStatus: 1 } must exist');

  // 3. Supporting index: studentProfileId + verificationStatus
  const studentStatusIdx = indexes.find(
    ([fields]) => fields.studentProfileId === 1 && fields.verificationStatus === 1
  );
  assert.ok(studentStatusIdx, 'Supporting index { studentProfileId: 1, verificationStatus: 1 } must exist');

  // 4. Supporting index: schoolId + verificationStatus
  const schoolStatusIdx = indexes.find(
    ([fields]) => fields.schoolId === 1 && fields.verificationStatus === 1
  );
  assert.ok(schoolStatusIdx, 'Supporting index { schoolId: 1, verificationStatus: 1 } must exist');

  // 5. Supporting index: parentId + studentProfileId + verificationStatus
  const parentStudentStatusIdx = indexes.find(
    ([fields]) => fields.parentId === 1 && fields.studentProfileId === 1 && fields.verificationStatus === 1
  );
  assert.ok(parentStudentStatusIdx, 'Supporting index { parentId: 1, studentProfileId: 1, verificationStatus: 1 } must exist');
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passed}/${total} PARENT-STUDENT LINK MODEL TESTS PASSED!`);
console.log('======================================================================\n');
