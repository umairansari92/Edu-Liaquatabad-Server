import mongoose from 'mongoose';
import { PARENT_STUDENT_LINK_STATUS, PARENT_RELATIONSHIP } from '../../config/constants.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ParentStudentLink Model — Authoritative Relationship & Verification Layer
 * Education Department, Liaquatabad Town Centre (DMC)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NON-NEGOTIABLE AUTHORIZATION LAW:
 * Parent authorization is NEVER derived from `StudentProfile.parentUserId`.
 * Access to child records strictly requires an authoritative `ParentStudentLink`
 * with `verificationStatus === 'VERIFIED'`.
 *
 * RELATIONSHIP LIFECYCLE:
 * 1. PENDING_OTP: Parent registered claim, awaiting phone OTP confirmation.
 * 2. PENDING_HM_APPROVAL: OTP confirmed, awaiting HM verification against physical register.
 * 3. VERIFIED: HM confirmed parent relationship; read access granted to ward records.
 * 4. REJECTED: HM rejected claim with justification; parent may re-apply.
 * 5. REVOKED: Previously verified link terminated (e.g. custody change); parent may re-apply.
 */

const ParentStudentLinkSchema = new mongoose.Schema(
  {
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Parent User ID is required'],
      index: true,
    },
    studentProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StudentProfile',
      required: [true, 'StudentProfile ID is required'],
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School ID is required'],
      index: true,
    },
    relationship: {
      type: String,
      enum: {
        values: Object.values(PARENT_RELATIONSHIP),
        message: '{VALUE} is not a valid parent relationship (Must be FATHER, MOTHER, or GUARDIAN)',
      },
      required: [true, 'Relationship is required'],
    },
    verificationStatus: {
      type: String,
      enum: {
        values: Object.values(PARENT_STUDENT_LINK_STATUS),
        message: '{VALUE} is not a valid verification status',
      },
      default: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
      required: true,
      index: true,
    },

    // ─── Contact Verification Metadata ──────────────────────────────────────
    contactOtpVerified: {
      type: Boolean,
      default: false,
    },
    contactVerifiedAt: {
      type: Date,
      default: null,
    },

    // ─── HM Verification Metadata ───────────────────────────────────────────
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },

    // ─── Rejection Metadata ─────────────────────────────────────────────────
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: null,
    },

    // ─── Revocation Metadata ────────────────────────────────────────────────
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revocationReason: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

// ─── PARTIAL UNIQUE INDEX (Active Claim Race & Uniqueness Guard) ─────────────
/**
 * Active-State Partial Unique Index:
 * Enforces that no duplicate ACTIVE claim (PENDING_OTP, PENDING_HM_APPROVAL, VERIFIED)
 * can exist simultaneously for the same parentId + studentProfileId.
 *
 * If a link is REJECTED or REVOKED, it is excluded from this partial index,
 * strictly permitting future re-application without violating unique constraints.
 */
ParentStudentLinkSchema.index(
  { parentId: 1, studentProfileId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      verificationStatus: {
        $in: [
          PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
          PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
          PARENT_STUDENT_LINK_STATUS.VERIFIED,
        ],
      },
    },
    name: 'parent_student_active_partial_unique',
  }
);

// ─── BOLA & OPERATIONAL SUPPORTING QUERY INDEXES ─────────────────────────────
/**
 * 1. { parentId: 1, verificationStatus: 1 }
 * Supports: Fetching all verified children/wards for authenticated parent in Parent Portal.
 * BOLA Use: Quick filtering of authorized wards. Non-unique, non-partial.
 */
ParentStudentLinkSchema.index(
  { parentId: 1, verificationStatus: 1 },
  { name: 'parent_status_query_idx' }
);

/**
 * 2. { studentProfileId: 1, verificationStatus: 1 }
 * Supports: Looking up verified parents for a student (emergency contacts, notification dispatch).
 * BOLA Use: Prevents notifications or disclosures to unverified claimants. Non-unique, non-partial.
 */
ParentStudentLinkSchema.index(
  { studentProfileId: 1, verificationStatus: 1 },
  { name: 'student_status_query_idx' }
);

/**
 * 3. { schoolId: 1, verificationStatus: 1 }
 * Supports: HM verification queue queries filtered by school and status (e.g. PENDING_HM_APPROVAL).
 * BOLA Use: Enforces strict school-boundary isolation on the pending queue. Non-unique, non-partial.
 */
ParentStudentLinkSchema.index(
  { schoolId: 1, verificationStatus: 1 },
  { name: 'school_status_queue_idx' }
);

/**
 * 4. { parentId: 1, studentProfileId: 1, verificationStatus: 1 }
 * Supports: O(1) point-lookups for Parent authorization guards across all student-scoped endpoints.
 * BOLA Use: Verifies parent ownership of requested student resource. Non-unique, non-partial.
 */
ParentStudentLinkSchema.index(
  { parentId: 1, studentProfileId: 1, verificationStatus: 1 },
  { name: 'parent_student_status_bola_idx' }
);

// ─── DOMAIN VALIDATION HELPERS (DATA / SERVICE LAYER) ────────────────────────

/**
 * Validates that the link's schoolId matches the authoritative schoolId of the StudentProfile.
 * Prevents cross-school association attacks (Student A of School A linked to School B).
 *
 * @param {Object} studentProfile - Authoritative StudentProfile document or object with schoolId
 * @param {string|mongoose.Types.ObjectId} linkSchoolId - School ID specified for the link
 * @returns {boolean}
 * @throws {Error} if mismatch or invalid
 */
ParentStudentLinkSchema.statics.validateSchoolIntegrity = function (studentProfile, linkSchoolId) {
  if (!studentProfile || !studentProfile.schoolId) {
    throw new Error('StudentProfile must have an authoritative schoolId');
  }
  if (!linkSchoolId) {
    throw new Error('School ID is required for ParentStudentLink');
  }

  const profileSchoolIdStr = String(studentProfile.schoolId._id || studentProfile.schoolId);
  const linkSchoolIdStr = String(linkSchoolId._id || linkSchoolId);

  if (profileSchoolIdStr !== linkSchoolIdStr) {
    throw new Error(
      `School isolation violation: StudentProfile school (${profileSchoolIdStr}) does not match link school (${linkSchoolIdStr})`
    );
  }

  return true;
};

/**
 * Pure data/service layer validator ensuring relational and school integrity
 * before persistence or transition.
 *
 * @param {Object} payload
 * @param {string|mongoose.Types.ObjectId} payload.parentId
 * @param {Object} payload.studentProfile
 * @param {string|mongoose.Types.ObjectId} payload.schoolId
 * @param {string} payload.relationship
 * @param {string} [payload.verificationStatus]
 * @param {Object} [payload.metadata]
 * @returns {boolean}
 */
export const validateParentStudentLinkIntegrity = ({
  parentId,
  studentProfile,
  schoolId,
  relationship,
  verificationStatus = PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
  metadata = {},
}) => {
  if (!parentId) {
    throw new Error('Parent user ID is required');
  }
  if (!studentProfile || !studentProfile._id) {
    throw new Error('Authoritative StudentProfile is required');
  }
  if (!schoolId) {
    throw new Error('School ID is required');
  }

  if (!relationship || !Object.values(PARENT_RELATIONSHIP).includes(relationship)) {
    throw new Error(`Invalid relationship '${relationship}'. Must be one of: ${Object.values(PARENT_RELATIONSHIP).join(', ')}`);
  }

  if (!Object.values(PARENT_STUDENT_LINK_STATUS).includes(verificationStatus)) {
    throw new Error(`Invalid verification status '${verificationStatus}'`);
  }

  // School Isolation Law
  const profileSchoolIdStr = String(studentProfile.schoolId?._id || studentProfile.schoolId);
  const linkSchoolIdStr = String(schoolId?._id || schoolId);

  if (profileSchoolIdStr !== linkSchoolIdStr) {
    throw new Error(
      `Cross-school linkage violation: Student belongs to school ${profileSchoolIdStr}, but link targeted school ${linkSchoolIdStr}`
    );
  }

  // Verification Audit Metadata Rules
  if (verificationStatus === PARENT_STUDENT_LINK_STATUS.VERIFIED) {
    if (!metadata.verifiedBy || !metadata.verifiedAt) {
      throw new Error('VERIFIED status requires verifiedBy and verifiedAt audit metadata');
    }
  }

  if (verificationStatus === PARENT_STUDENT_LINK_STATUS.REJECTED) {
    if (!metadata.rejectedBy || !metadata.rejectedAt || !metadata.rejectionReason) {
      throw new Error('REJECTED status requires rejectedBy, rejectedAt, and rejectionReason');
    }
  }

  if (verificationStatus === PARENT_STUDENT_LINK_STATUS.REVOKED) {
    if (!metadata.revokedBy || !metadata.revokedAt || !metadata.revocationReason) {
      throw new Error('REVOKED status requires revokedBy, revokedAt, and revocationReason');
    }
  }

  if (metadata.contactOtpVerified === true && !metadata.contactVerifiedAt) {
    throw new Error('contactOtpVerified requires contactVerifiedAt timestamp');
  }

  return true;
};

/**
 * Pure authorization check demonstrating that parent access is derived
 * EXCLUSIVELY from an active VERIFIED link, and NEVER from StudentProfile.parentUserId.
 *
 * @param {Object} params
 * @param {string} params.parentId
 * @param {string} params.studentProfileId
 * @param {Function} [params.findLinkFn] - Injectable query function
 * @returns {Promise<boolean>}
 */
export const isParentAuthorizedForStudent = async ({
  parentId,
  studentProfileId,
  findLinkFn,
}) => {
  if (!parentId || !studentProfileId) return false;

  const queryRunner =
    findLinkFn ||
    ((query) =>
      mongoose.models.ParentStudentLink.findOne(query).lean());

  const activeLink = await queryRunner({
    parentId,
    studentProfileId,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
  });

  return Boolean(activeLink);
};

const ParentStudentLink =
  mongoose.models.ParentStudentLink ||
  mongoose.model('ParentStudentLink', ParentStudentLinkSchema);

export default ParentStudentLink;
