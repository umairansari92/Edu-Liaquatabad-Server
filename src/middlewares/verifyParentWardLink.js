import mongoose from 'mongoose';
import ParentStudentLink from '../models/ParentStudentLink.js';
import StudentProfile from '../models/StudentProfile.js';
import AuditLog from '../models/AuditLog.js';
import { sendError } from '../utils/apiResponse.js';
import { ROLES, PARENT_STUDENT_LINK_STATUS, STUDENT_STATUS } from '../../config/constants.js';

/**
 * 🛡️ Parent-Ward Link Verification Middleware (Parent BFF Security Invariant)
 *
 * Core Security Invariant:
 * Authenticated Parent → VERIFIED ParentStudentLink → exact studentProfileId match → allow, otherwise 403.
 *
 * Enforces:
 *  1. Authenticated actor role must be PARENT.
 *  2. studentProfileId parameter must be a valid 24-character hex MongoDB ObjectId.
 *  3. ParentStudentLink must exist for (parentId === actor._id) AND (studentProfileId === params.studentProfileId).
 *  4. verificationStatus must strictly be VERIFIED (blocks PENDING_OTP, PENDING_HM_APPROVAL, REJECTED, REVOKED).
 *  5. Violations are intercepted and immutably audited as PARENT_CROSS_WARD_ACCESS_BLOCKED with DENIED status.
 *  6. On success, attaches req.parentWardLink and req.wardProfile to the request object.
 */
export const verifyParentWardLink = async (request, response, nextFunction) => {
  const requestingActor = request.user;
  const { studentProfileId } = request.params;

  // 1. Authentication & Role Sanity Guard
  if (!requestingActor || requestingActor.role !== ROLES.PARENT) {
    return sendError(response, 403, 'Access denied. Parent authority required for ward operations.');
  }

  // 2. ObjectId Format Validation
  if (!studentProfileId || !mongoose.Types.ObjectId.isValid(studentProfileId) || !/^[0-9a-fA-F]{24}$/.test(studentProfileId)) {
    return sendError(response, 400, 'Invalid student profile identifier format.');
  }

  const parentId = requestingActor._id || requestingActor.userId;

  try {
    // 3. Query authoritative ParentStudentLink with exact match on parentId + studentProfileId
    const activeLink = await ParentStudentLink.findOne({
      parentId,
      studentProfileId,
    }).lean();

    // 4. Strict Verification Status Check (Only VERIFIED allowed)
    if (!activeLink || activeLink.verificationStatus !== PARENT_STUDENT_LINK_STATUS.VERIFIED) {
      const linkStatus = activeLink ? activeLink.verificationStatus : 'NO_LINK_FOUND';

      // Record immutable security audit log for blocked unauthorized ward access attempt
      try {
        await AuditLog.create({
          actorId: parentId,
          actorRole: ROLES.PARENT,
          actorName: requestingActor.fullName || 'Parent',
          action: 'PARENT_CROSS_WARD_ACCESS_BLOCKED',
          targetModel: 'StudentProfile',
          targetId: studentProfileId,
          targetName: request.originalUrl,
          schoolId: activeLink?.schoolId || null,
          previousState: {
            attemptedStudentProfileId: studentProfileId,
            authenticatedParentId: parentId,
            linkStatus,
          },
          result: 'DENIED',
          reason: `BOLA/IDOR intercepted: Parent attempted to access ward data without an active VERIFIED link (Current status: ${linkStatus}).`,
          ipAddress: request.ip || '',
          userAgent: request.headers?.['user-agent'] || '',
          requestId: request.headers?.['x-request-id'] || '',
        });
      } catch {
        // Safe logging degradation in offline / stubbed test context
      }

      return sendError(
        response,
        403,
        'Access denied. You do not hold an active, verified parental link for this student.'
      );
    }

    // 5. Retrieve student profile particulars
    const wardProfile = await StudentProfile.findById(studentProfileId)
      .populate('schoolId', 'name code emisCode address timings townId')
      .populate('classId', 'name numericGrade')
      .populate('sectionId', 'name')
      .populate('userId', 'fullName email phoneNumber')
      .lean();

    if (!wardProfile) {
      return sendError(response, 404, 'Student profile record not found.');
    }

    if (wardProfile.lifecycleStatus !== STUDENT_STATUS.ACTIVE) {
      return sendError(
        response,
        403,
        `Access denied. Student record is currently in ${wardProfile.lifecycleStatus} status.`
      );
    }

    // 6. Attach verified link and student profile context to request
    request.parentWardLink = activeLink;
    request.wardProfile = wardProfile;

    return nextFunction();
  } catch (error) {
    return nextFunction(error);
  }
};
