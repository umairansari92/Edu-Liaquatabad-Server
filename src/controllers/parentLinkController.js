import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import ParentStudentLink, {
  validateParentStudentLinkIntegrity,
} from '../models/ParentStudentLink.js';
import StudentProfile from '../models/StudentProfile.js';
import School from '../models/School.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import Notification from '../models/Notification.js';
import { requestOtp, verifyOtp } from '../services/otpService.js';
import {
  ROLES,
  PARENT_STUDENT_LINK_STATUS,
  PARENT_RELATIONSHIP,
  USER_STATUS,
} from '../../config/constants.js';

/**
 * Mask student full name for anti-enumeration search preview
 * e.g., "Muhammad Ali Khan" -> "M******d A*i K**n"
 */
const maskName = (fullName = '') => {
  if (!fullName || typeof fullName !== 'string') return 'Student';
  return fullName
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 2) return word[0] + '*';
      return word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
    })
    .join(' ');
};

/**
 * Mask contact phone number (e.g. 03001234567 -> 0300****567)
 */
const maskPhone = (phone = '') => {
  const clean = String(phone).trim();
  if (clean.length < 8) return '****';
  return `${clean.slice(0, 4)}****${clean.slice(-3)}`;
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. PARENT WARD LOOKUP & ONBOARDING CONTROLLERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Candidate Ward Lookup (Anti-Enumeration PII Shield)
 * POST /api/v1/parent/lookup-ward
 */
export const handleLookupWard = asyncHandler(async (request, response) => {
  const { schoolId, grNumber, admissionRegisterNumber, globalStudentId } = request.body;

  if (!schoolId) {
    return sendError(response, 400, 'Target school ID is required for student lookup.');
  }

  const school = await School.findById(schoolId).select('name schoolCode emisCode');
  if (!school) {
    return sendError(response, 404, 'Specified school does not exist.');
  }

  // Construct search query
  const query = { schoolId: school._id };

  if (globalStudentId) {
    query.globalStudentId = String(globalStudentId).trim().toUpperCase();
  } else if (admissionRegisterNumber) {
    query.admissionRegisterNumber = String(admissionRegisterNumber).trim().toUpperCase();
  } else if (grNumber !== undefined && grNumber !== null && String(grNumber).trim() !== '') {
    const parsedGr = parseInt(String(grNumber).replace(/\D/g, ''), 10);
    if (isNaN(parsedGr)) {
      return sendError(response, 400, 'Invalid GR Number format.');
    }
    query.grNumber = parsedGr;
  } else {
    return sendError(response, 400, 'Either GR Number, Admission Register Number, or Global Student ID is required.');
  }

  const studentProfile = await StudentProfile.findOne(query).select(
    'studentFullName grNumber admissionRegisterNumber globalStudentId admissionClassRequested admissionDate guardianCellNumber guardianContactNumber schoolId'
  );

  if (!studentProfile) {
    return sendError(response, 404, 'No enrolled student record found matching the provided institutional details.');
  }

  const rawPhone = (studentProfile.guardianCellNumber || studentProfile.guardianContactNumber || '').trim();
  const hasOfficialContactOnRecord = Boolean(rawPhone && rawPhone.length >= 10);

  return sendSuccess(response, 200, 'Candidate student record located.', {
    studentProfileId: studentProfile._id,
    maskedStudentName: maskName(studentProfile.studentFullName),
    schoolId: school._id,
    schoolName: school.name,
    schoolCode: school.schoolCode,
    admissionClass: studentProfile.admissionClassRequested || 'Primary',
    admissionYear: studentProfile.admissionDate ? new Date(studentProfile.admissionDate).getFullYear() : 2026,
    hasOfficialContactOnRecord,
    maskedContactPhone: hasOfficialContactOnRecord ? maskPhone(rawPhone) : null,
  });
});

/**
 * Initiate Ward Link Claim & OTP Dispatch
 * POST /api/v1/parent/initiate-claim
 */
export const handleInitiateClaim = asyncHandler(async (request, response) => {
  const { studentProfileId, relationship } = request.body;

  if (!studentProfileId) {
    return sendError(response, 400, 'Student Profile ID is required.');
  }

  if (!relationship || !Object.values(PARENT_RELATIONSHIP).includes(relationship)) {
    return sendError(response, 400, 'Valid relationship (FATHER, MOTHER, or GUARDIAN) is required.');
  }

  const studentProfile = await StudentProfile.findById(studentProfileId).populate('schoolId', 'name schoolCode');
  if (!studentProfile) {
    return sendError(response, 404, 'Authoritative student profile not found.');
  }

  // 1. Enforce active-state partial unique rule at application layer
  const activeExistingLink = await ParentStudentLink.findOne({
    parentId: request.user._id,
    studentProfileId: studentProfile._id,
    verificationStatus: {
      $in: [
        PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
        PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
        PARENT_STUDENT_LINK_STATUS.VERIFIED,
      ],
    },
  });

  if (activeExistingLink) {
    return sendError(
      response,
      409,
      `An active or pending claim (${activeExistingLink.verificationStatus}) already exists for this student.`
    );
  }

  // 2. Validate school isolation
  ParentStudentLink.validateSchoolIntegrity(studentProfile, studentProfile.schoolId._id || studentProfile.schoolId);

  // 3. Inspect official contact on file
  const officialPhone = (studentProfile.guardianCellNumber || studentProfile.guardianContactNumber || '').trim();

  let link;
  let otpResult = null;

  if (officialPhone && officialPhone.length >= 10) {
    // Standard 3-Layer Path: Dispatch OTP to official phone on file
    try {
      otpResult = await requestOtp(officialPhone, 'PARENT_WARD_CLAIM');
    } catch (otpError) {
      return sendError(response, 429, otpError.message);
    }

    link = await ParentStudentLink.create({
      parentId: request.user._id,
      studentProfileId: studentProfile._id,
      schoolId: studentProfile.schoolId._id || studentProfile.schoolId,
      relationship,
      verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_OTP,
      contactOtpVerified: false,
    });
  } else {
    // Fallback: No phone on paper record -> route directly to HM physical verification
    link = await ParentStudentLink.create({
      parentId: request.user._id,
      studentProfileId: studentProfile._id,
      schoolId: studentProfile.schoolId._id || studentProfile.schoolId,
      relationship,
      verificationStatus: PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL,
      contactOtpVerified: false,
    });
  }

  // 4. Audit Log
  await AuditLog.create({
    actorId: request.user._id,
    actorRole: request.user.role,
    actorDesignation: request.user.designation || 'Parent',
    actorName: request.user.fullName,
    action: 'PARENT_WARD_CLAIM_INITIATED',
    targetModel: 'ParentStudentLink',
    targetId: link._id,
    targetName: studentProfile.studentFullName || 'Student',
    schoolId: studentProfile.schoolId._id || studentProfile.schoolId,
    newState: {
      linkId: link._id,
      verificationStatus: link.verificationStatus,
      relationship: link.relationship,
      contactOtpVerified: link.contactOtpVerified,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  if (link.verificationStatus === PARENT_STUDENT_LINK_STATUS.PENDING_OTP) {
    return sendSuccess(
      response,
      201,
      `Verification code dispatched to official guardian contact on file (${maskPhone(officialPhone)}).`,
      {
        linkId: link._id,
        verificationStatus: link.verificationStatus,
        maskedPhone: maskPhone(officialPhone),
        expiresInSeconds: otpResult?.expiresInSeconds || 300,
        cooldownSeconds: otpResult?.cooldownSeconds || 60,
        ...(otpResult?.devOtp ? { devOtp: otpResult.devOtp } : {}),
      }
    );
  }

  return sendSuccess(
    response,
    201,
    'No guardian contact on file. Your claim has been routed directly to the Head Master for physical document verification.',
    {
      linkId: link._id,
      verificationStatus: link.verificationStatus,
      requiresPhysicalVerification: true,
    }
  );
});

/**
 * Verify Claim Contact OTP
 * POST /api/v1/parent/verify-claim-otp
 */
export const handleVerifyClaimOtp = asyncHandler(async (request, response) => {
  const { linkId, otpCode } = request.body;

  if (!linkId || !otpCode) {
    return sendError(response, 400, 'Link ID and 6-digit verification code are required.');
  }

  const link = await ParentStudentLink.findById(linkId);
  if (!link) {
    return sendError(response, 404, 'Specified relationship claim not found.');
  }

  // BOLA Ownership Guard: Only the claiming parent can verify OTP
  if (String(link.parentId) !== String(request.user._id)) {
    return sendError(response, 403, 'Forbidden: You do not own this relationship claim.');
  }

  if (link.verificationStatus !== PARENT_STUDENT_LINK_STATUS.PENDING_OTP) {
    return sendError(
      response,
      400,
      `Claim is not awaiting OTP verification. Current status: ${link.verificationStatus}`
    );
  }

  const studentProfile = await StudentProfile.findById(link.studentProfileId).select(
    'guardianCellNumber guardianContactNumber studentFullName'
  );
  if (!studentProfile) {
    return sendError(response, 404, 'Associated student profile not found.');
  }

  const officialPhone = (studentProfile.guardianCellNumber || studentProfile.guardianContactNumber || '').trim();
  if (!officialPhone) {
    return sendError(response, 400, 'No official contact on record to verify against.');
  }

  // Verify OTP
  try {
    await verifyOtp(officialPhone, otpCode, 'PARENT_WARD_CLAIM');
  } catch (error) {
    return sendError(response, 400, error.message);
  }

  // Transition state to PENDING_HM_APPROVAL
  link.verificationStatus = PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL;
  link.contactOtpVerified = true;
  link.contactVerifiedAt = new Date();
  await link.save();

  // Notify Head Master of new pending parent claim
  try {
    const hmUsers = await User.find({
      schoolId: link.schoolId,
      role: ROLES.HM,
      status: USER_STATUS.ACTIVE,
    }).select('_id');

    if (hmUsers.length > 0) {
      const notifications = hmUsers.map((hmUser) => ({
        recipientUserId: hmUser._id,
        title: 'New Parent Verification Claim Pending',
        message: `${request.user.fullName} has completed phone OTP verification for student ${studentProfile.studentFullName || 'Student'}. Verification required against physical register.`,
        notificationType: 'APPROVAL_REQUIRED',
        category: 'GOVERNANCE',
        actionLink: '/hm/parent-links',
      }));
      await Notification.insertMany(notifications);
    }
  } catch (notificationError) {
    console.error('[Notification Routing Error]', notificationError.message);
  }

  // Audit Log
  await AuditLog.create({
    actorId: request.user._id,
    actorRole: request.user.role,
    actorDesignation: request.user.designation || 'Parent',
    actorName: request.user.fullName,
    action: 'PARENT_CLAIM_OTP_VERIFIED',
    targetModel: 'ParentStudentLink',
    targetId: link._id,
    targetName: studentProfile.studentFullName || 'Student',
    schoolId: link.schoolId,
    newState: {
      verificationStatus: link.verificationStatus,
      contactOtpVerified: link.contactOtpVerified,
      contactVerifiedAt: link.contactVerifiedAt,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  return sendSuccess(
    response,
    200,
    'Contact verified successfully. Your claim is now pending Head Master (HM) institutional approval.',
    {
      linkId: link._id,
      verificationStatus: link.verificationStatus,
      contactOtpVerified: link.contactOtpVerified,
    }
  );
});

/**
 * Get Parent's Link Claims (All lifecycle states)
 * GET /api/v1/parent/my-claims
 */
export const handleGetMyClaims = asyncHandler(async (request, response) => {
  const claims = await ParentStudentLink.find({ parentId: request.user._id })
    .populate({
      path: 'studentProfileId',
      select: 'studentFullName grNumber admissionRegisterNumber globalStudentId admissionClassRequested',
    })
    .populate({
      path: 'schoolId',
      select: 'name schoolCode',
    })
    .sort({ createdAt: -1 });

  return sendSuccess(response, 200, 'Parent relationship claims retrieved.', { claims });
});

/**
 * Get Parent's Authoritative Verified Wards
 * GET /api/v1/parent/my-wards
 */
export const handleGetMyWards = asyncHandler(async (request, response) => {
  const verifiedLinks = await ParentStudentLink.find({
    parentId: request.user._id,
    verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
  })
    .populate({
      path: 'studentProfileId',
      select: 'studentFullName grNumber admissionRegisterNumber globalStudentId classId sectionId schoolId admissionDate',
      populate: [
        { path: 'classId', select: 'name gradeLevel' },
        { path: 'sectionId', select: 'name' },
        { path: 'schoolId', select: 'name schoolCode emisCode' },
      ],
    })
    .populate({
      path: 'schoolId',
      select: 'name schoolCode emisCode',
    })
    .sort({ updatedAt: -1 });

  const wards = verifiedLinks
    .filter((link) => Boolean(link.studentProfileId))
    .map((link) => ({
      linkId: link._id,
      relationship: link.relationship,
      verifiedAt: link.verifiedAt,
      studentProfile: link.studentProfileId,
      school: link.schoolId,
    }));

  return sendSuccess(response, 200, 'Verified wards retrieved successfully.', { wards });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. HEAD MASTER (HM) VERIFICATION QUEUE & DECISION CONTROLLERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Head Master Pending Parent Claims Queue
 * GET /api/v1/hm/parent-links
 */
export const handleGetHmParentLinks = asyncHandler(async (request, response) => {
  const user = request.user;
  const statusFilter = request.query.status || PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL;

  // Resolve target school scope
  let targetSchoolId = user.schoolId;
  if ([ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN, ROLES.ADMIN].includes(user.role) && request.query.schoolId) {
    targetSchoolId = request.query.schoolId;
  }

  if (!targetSchoolId) {
    return sendError(response, 400, 'School context is required to inspect parent verification queue.');
  }

  const query = { schoolId: targetSchoolId };
  if (statusFilter !== 'ALL') {
    query.verificationStatus = statusFilter;
  }

  const page = Math.max(1, parseInt(request.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(request.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const [links, totalCount] = await Promise.all([
    ParentStudentLink.find(query)
      .populate({
        path: 'parentId',
        select: 'fullName email phoneNumber',
      })
      .populate({
        path: 'studentProfileId',
        select: 'studentFullName grNumber admissionRegisterNumber globalStudentId guardianCnicNumber fatherFullName motherFullName admissionClassRequested classId sectionId',
        populate: [
          { path: 'classId', select: 'name' },
          { path: 'sectionId', select: 'name' },
        ],
      })
      .populate({
        path: 'verifiedBy rejectedBy revokedBy',
        select: 'fullName designation',
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    ParentStudentLink.countDocuments(query),
  ]);

  return sendSuccess(response, 200, 'Parent verification queue retrieved successfully.', {
    claims: links,
    pagination: {
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit) || 1,
    },
  });
});

/**
 * Head Master Verifies Parent-Student Link
 * POST /api/v1/hm/parent-links/:linkId/verify
 */
export const handleHmVerifyParentLink = asyncHandler(async (request, response) => {
  const { linkId } = request.params;
  const { remarks = '' } = request.body;
  const user = request.user;

  const link = await ParentStudentLink.findById(linkId).populate('studentProfileId parentId');
  if (!link) {
    return sendError(response, 404, 'Parent-student link claim not found.');
  }

  // Cross-School BOLA Protection: HM can only approve claims for their own school
  if (user.role === ROLES.HM && String(link.schoolId) !== String(user.schoolId)) {
    return sendError(response, 403, 'Forbidden: You cannot verify parent claims for another school.');
  }

  // Lifecycle check: Can verify from PENDING_HM_APPROVAL (or PENDING_OTP if HM physically verifies)
  if (![PARENT_STUDENT_LINK_STATUS.PENDING_HM_APPROVAL, PARENT_STUDENT_LINK_STATUS.PENDING_OTP].includes(link.verificationStatus)) {
    return sendError(
      response,
      400,
      `Cannot verify claim with status '${link.verificationStatus}'. Must be in a pending state.`
    );
  }

  link.verificationStatus = PARENT_STUDENT_LINK_STATUS.VERIFIED;
  link.verifiedBy = user._id;
  link.verifiedAt = new Date();
  await link.save();

  // Notify Parent
  try {
    await Notification.create({
      recipientUserId: link.parentId._id,
      title: 'Parent-Student Relationship Verified',
      message: `Your relationship to student ${link.studentProfileId?.studentFullName || 'Student'} has been verified by the Head Master. You now have full portal access to their records.`,
      notificationType: 'ONBOARDING',
      category: 'GOVERNANCE',
      actionLink: '/parent/dashboard',
    });
  } catch (notificationError) {
    console.error('[Notification Routing Error]', notificationError.message);
  }

  // Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || 'Head Master',
    actorName: user.fullName,
    action: 'PARENT_STUDENT_LINK_APPROVED',
    targetModel: 'ParentStudentLink',
    targetId: link._id,
    targetName: link.studentProfileId?.studentFullName || 'Student',
    schoolId: link.schoolId,
    newState: {
      verificationStatus: link.verificationStatus,
      verifiedBy: user._id,
      verifiedAt: link.verifiedAt,
      remarks,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Parent-student link verified and approved successfully.', {
    linkId: link._id,
    verificationStatus: link.verificationStatus,
    verifiedAt: link.verifiedAt,
  });
});

/**
 * Head Master Rejects Parent-Student Link
 * POST /api/v1/hm/parent-links/:linkId/reject
 */
export const handleHmRejectParentLink = asyncHandler(async (request, response) => {
  const { linkId } = request.params;
  const { rejectionReason } = request.body;
  const user = request.user;

  if (!rejectionReason || rejectionReason.trim().length < 10) {
    return sendError(response, 400, 'Rejection reason must be at least 10 characters.');
  }

  const link = await ParentStudentLink.findById(linkId).populate('studentProfileId parentId');
  if (!link) {
    return sendError(response, 404, 'Parent-student link claim not found.');
  }

  // Cross-School BOLA Protection
  if (user.role === ROLES.HM && String(link.schoolId) !== String(user.schoolId)) {
    return sendError(response, 403, 'Forbidden: You cannot reject parent claims for another school.');
  }

  if (link.verificationStatus === PARENT_STUDENT_LINK_STATUS.VERIFIED) {
    return sendError(response, 400, 'Active verified link must be revoked, not rejected.');
  }

  link.verificationStatus = PARENT_STUDENT_LINK_STATUS.REJECTED;
  link.rejectedBy = user._id;
  link.rejectedAt = new Date();
  link.rejectionReason = rejectionReason.trim();
  await link.save();

  // Notify Parent with rejection reason
  try {
    await Notification.create({
      recipientUserId: link.parentId._id,
      title: 'Parent-Student Claim Rejected',
      message: `Your claim for student ${link.studentProfileId?.studentFullName || 'Student'} was rejected by the Head Master. Reason: ${rejectionReason.trim()}`,
      notificationType: 'ONBOARDING',
      category: 'GOVERNANCE',
      actionLink: '/parent/dashboard',
    });
  } catch (notificationError) {
    console.error('[Notification Routing Error]', notificationError.message);
  }

  // Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || 'Head Master',
    actorName: user.fullName,
    action: 'PARENT_STUDENT_LINK_REJECTED',
    targetModel: 'ParentStudentLink',
    targetId: link._id,
    targetName: link.studentProfileId?.studentFullName || 'Student',
    schoolId: link.schoolId,
    newState: {
      verificationStatus: link.verificationStatus,
      rejectedBy: user._id,
      rejectedAt: link.rejectedAt,
      rejectionReason: link.rejectionReason,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Parent-student link rejected.', {
    linkId: link._id,
    verificationStatus: link.verificationStatus,
    rejectedAt: link.rejectedAt,
    rejectionReason: link.rejectionReason,
  });
});

/**
 * Head Master Revokes Previously Verified Parent-Student Link
 * POST /api/v1/hm/parent-links/:linkId/revoke
 */
export const handleHmRevokeParentLink = asyncHandler(async (request, response) => {
  const { linkId } = request.params;
  const { revocationReason } = request.body;
  const user = request.user;

  if (!revocationReason || revocationReason.trim().length < 10) {
    return sendError(response, 400, 'Revocation reason must be at least 10 characters.');
  }

  const link = await ParentStudentLink.findById(linkId).populate('studentProfileId parentId');
  if (!link) {
    return sendError(response, 404, 'Parent-student link not found.');
  }

  // Cross-School BOLA Protection
  if (user.role === ROLES.HM && String(link.schoolId) !== String(user.schoolId)) {
    return sendError(response, 403, 'Forbidden: You cannot revoke links for another school.');
  }

  if (link.verificationStatus !== PARENT_STUDENT_LINK_STATUS.VERIFIED) {
    return sendError(response, 400, 'Only VERIFIED links can be revoked.');
  }

  link.verificationStatus = PARENT_STUDENT_LINK_STATUS.REVOKED;
  link.revokedBy = user._id;
  link.revokedAt = new Date();
  link.revocationReason = revocationReason.trim();
  await link.save();

  // Notify Parent
  try {
    await Notification.create({
      recipientUserId: link.parentId._id,
      title: 'Parent-Student Relationship Revoked',
      message: `Your access to student ${link.studentProfileId?.studentFullName || 'Student'} records has been revoked by the Head Master. Reason: ${revocationReason.trim()}`,
      notificationType: 'SECURITY_ALERT',
      category: 'GOVERNANCE',
      actionLink: '/parent/dashboard',
    });
  } catch (notificationError) {
    console.error('[Notification Routing Error]', notificationError.message);
  }

  // Audit Log
  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: user.designation || 'Head Master',
    actorName: user.fullName,
    action: 'PARENT_STUDENT_LINK_REVOKED',
    targetModel: 'ParentStudentLink',
    targetId: link._id,
    targetName: link.studentProfileId?.studentFullName || 'Student',
    schoolId: link.schoolId,
    newState: {
      verificationStatus: link.verificationStatus,
      revokedBy: user._id,
      revokedAt: link.revokedAt,
      revocationReason: link.revocationReason,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Parent-student link revoked.', {
    linkId: link._id,
    verificationStatus: link.verificationStatus,
    revokedAt: link.revokedAt,
    revocationReason: link.revocationReason,
  });
});
