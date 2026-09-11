import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import TeacherProfile from '../models/TeacherProfile.js';
import StudentProfile from '../models/StudentProfile.js';
import School from '../models/School.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import Notification from '../models/Notification.js';
import AuditLog from '../models/AuditLog.js';
import {
  ROLES,
  SCOPES,
  USER_STATUS,
  TEACHER_STATUS,
  STUDENT_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from '../../config/constants.js';

// Sensitive data masking helpers
export const maskCnic = (cnic) => {
  if (!cnic || typeof cnic !== 'string') return '';
  const clean = cnic.trim();
  if (/^\d{5}-\d{7}-\d{1}$/.test(clean)) {
    return `${clean.slice(0, 5)}-*******-${clean.slice(-1)}`;
  }
  return '*****-*******-*';
};

export const maskBankAccount = (accountNumber) => {
  if (!accountNumber || typeof accountNumber !== 'string') return '';
  const clean = accountNumber.trim();
  if (clean.length <= 4) return '****';
  return `****${clean.slice(-4)}`;
};

/**
 * Authoritative Scoped Approver Authorization Check
 * Enforces the institutional jurisdictional boundary matrix.
 * Note: Civil designation has ZERO authorization power.
 */
export const isAuthorizedApprover = (actor, targetUser, targetProfile) => {
  if (!actor || !actor.role) return false;

  const targetSchoolId = targetUser.claimedSchoolId || targetProfile?.claimedSchoolId || targetUser.schoolId;

  switch (actor.role) {
    case ROLES.ROOT_ADMIN:
      return true;

    case ROLES.SUPER_ADMIN:
      if (actor.scope === SCOPES.GLOBAL) return true;
      if (actor.townId && targetUser.townId && String(actor.townId) === String(targetUser.townId)) {
        return true;
      }
      return false;

    case ROLES.ADMIN:
      if (actor.townId && targetUser.townId && String(actor.townId) === String(targetUser.townId)) {
        return true;
      }
      return false;

    case ROLES.SUPERVISOR:
      if (!targetSchoolId) return false;
      const assigned = (actor.assignedSchools || []).map((s) => String(s._id || s));
      return assigned.includes(String(targetSchoolId));

    case ROLES.HM:
      // STRICT SCHOOL BOUNDARY: HM can ONLY approve staff claiming their exact assigned school
      if (!actor.schoolId || !targetSchoolId) return false;
      return String(actor.schoolId._id || actor.schoolId) === String(targetSchoolId);

    default:
      return false;
  }
};

/**
 * GET /api/v1/approvals/pending
 * Retrieves pending staff and student registrations within approver's jurisdiction
 * Returns MASKED sensitive fields to prevent bulk data leakage.
 */
export const handleGetPendingApprovals = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { type = 'staff' } = request.query;

  let query = {
    status: USER_STATUS.PENDING_APPROVAL,
  };

  // Scope filtering based on approver authority
  if (actor.role === ROLES.HM) {
    if (!actor.schoolId) {
      return sendSuccess(response, 200, 'Pending approvals list.', { items: [] });
    }
    query.claimedSchoolId = actor.schoolId;
  } else if (actor.role === ROLES.SUPERVISOR) {
    query.claimedSchoolId = { $in: actor.assignedSchools || [] };
  } else if (actor.role === ROLES.ADMIN) {
    if (actor.townId) query.townId = actor.townId;
  }

  // Type filter: staff vs student
  if (type === 'student') {
    query.role = ROLES.STUDENT;
  } else {
    query.role = { $in: [ROLES.TEACHER, ROLES.PEON] };
  }

  const pendingUsers = await User.find(query)
    .populate('claimedSchoolId', 'name code district')
    .sort({ createdAt: -1 })
    .lean();

  const userIds = pendingUsers.map((u) => u._id);
  const profiles = await TeacherProfile.find({ userId: { $in: userIds } }).lean();
  const profileMap = new Map(profiles.map((p) => [String(p.userId), p]));

  // Build sanitized, masked response items
  const items = pendingUsers.map((user) => {
    const profile = profileMap.get(String(user._id)) || {};
    return {
      userId: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      designation: user.designation,
      baseRole: user.baseRole,
      role: user.role,
      status: user.status,
      claimedSchool: user.claimedSchoolId
        ? { id: user.claimedSchoolId._id, name: user.claimedSchoolId.name, code: user.claimedSchoolId.code }
        : null,
      employeeId: profile.employeeId || '',
      appointmentDate: profile.appointmentDate || null,
      qualification: profile.qualification || '',
      isTeachingStaff: profile.isTeachingStaff ?? (user.role === ROLES.TEACHER),
      cnicMasked: maskCnic(profile.cnic),
      bankAccountMasked: maskBankAccount(profile.accountNumber),
      bankName: profile.bankName || '',
      branchName: profile.branchName || '',
      submittedAt: user.createdAt,
    };
  });

  return sendSuccess(response, 200, 'Pending registrations retrieved successfully.', {
    count: items.length,
    items,
  });
});

/**
 * GET /api/v1/approvals/:userId/detail
 * Complete profile inspection for an authorized approver prior to making an approval decision
 */
export const handleGetApprovalDetail = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { userId } = request.params;

  const targetUser = await User.findById(userId).populate('claimedSchoolId', 'name code address').lean();
  if (!targetUser) {
    return sendError(response, 404, 'Registration applicant not found.');
  }

  const targetProfile = await TeacherProfile.findOne({ userId }).lean();
  if (!isAuthorizedApprover(actor, targetUser, targetProfile)) {
    return sendError(response, 403, 'Access denied. Applicant is outside your institutional approval scope.');
  }

  // Fetch proposed teaching assignments if teacher
  let proposedAssignments = [];
  if (targetProfile?.isTeachingStaff) {
    proposedAssignments = await TeachingAssignment.find({ teacherId: userId })
      .populate('classId', 'name numericGrade')
      .populate('sectionId', 'name')
      .populate('subjectId', 'name code')
      .lean();
  }

  return sendSuccess(response, 200, 'Applicant registration details retrieved.', {
    user: {
      userId: targetUser._id,
      fullName: targetUser.fullName,
      email: targetUser.email,
      phoneNumber: targetUser.phoneNumber,
      designation: targetUser.designation,
      baseRole: targetUser.baseRole,
      role: targetUser.role,
      status: targetUser.status,
      claimedSchool: targetUser.claimedSchoolId,
      submittedAt: targetUser.createdAt,
    },
    profile: targetProfile
      ? {
          fatherName: targetProfile.fatherName,
          dateOfBirth: targetProfile.dateOfBirth,
          cnic: targetProfile.cnic, // Plaintext authorized inspection for reviewing officer
          employeeId: targetProfile.employeeId,
          appointmentDate: targetProfile.appointmentDate,
          qualification: targetProfile.qualification,
          isTeachingStaff: targetProfile.isTeachingStaff,
          bankName: targetProfile.bankName,
          branchName: targetProfile.branchName,
          accountNumber: targetProfile.accountNumber,
          accountTitle: targetProfile.accountTitle,
          correctionRemarks: targetProfile.correctionRemarks,
          rejectionReason: targetProfile.rejectionReason,
          approvalHistory: targetProfile.approvalHistory || [],
        }
      : null,
    proposedAssignments,
  });
});

/**
 * POST /api/v1/approvals/:userId/decision
 * Handles APPROVE, REQUEST_CORRECTION, or REJECT decisions
 */
export const handleProcessApprovalDecision = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { userId } = request.params;
  const { decision, reason = '' } = request.body;

  if (!['APPROVE', 'REQUEST_CORRECTION', 'REJECT'].includes(decision)) {
    return sendError(response, 400, 'Invalid decision. Must be APPROVE, REQUEST_CORRECTION, or REJECT.');
  }

  const targetUser = await User.findById(userId);
  if (!targetUser) {
    return sendError(response, 404, 'Registration applicant not found.');
  }

  // Idempotency & Lifecycle guards
  if (targetUser.status === USER_STATUS.ACTIVE) {
    return sendError(response, 409, 'User account is already active and approved.');
  }

  if (![USER_STATUS.PENDING_APPROVAL, USER_STATUS.REQUIRES_CORRECTION].includes(targetUser.status)) {
    return sendError(response, 400, `Cannot perform approval action on account in '${targetUser.status}' status.`);
  }

  const targetProfile = await TeacherProfile.findOne({ userId });
  if (!isAuthorizedApprover(actor, targetUser, targetProfile)) {
    return sendError(response, 403, 'Cross-institution violation: You are not authorized to approve staff for this school.');
  }

  const confirmedSchoolId = targetUser.claimedSchoolId;
  const decisionTimestamp = new Date();

  // ─── 1. APPROVE Branch ──────────────────────────────────────────────────────
  if (decision === 'APPROVE') {
    // Confirm school relationship
    targetUser.schoolId = confirmedSchoolId;
    targetUser.status = USER_STATUS.ACTIVE;
    targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1; // Revoke old unapproved sessions
    targetUser.approvalDetails = {
      approvedBy: actor._id,
      approvedAt: decisionTimestamp,
      correctionRemarks: '',
      rejectionReason: '',
    };

    if (targetProfile) {
      targetProfile.currentSchoolId = confirmedSchoolId;
      targetProfile.lifecycleStatus = TEACHER_STATUS.ACTIVE;
      targetProfile.approvalHistory.push({
        action: 'APPROVED',
        actorId: actor._id,
        actorRole: actor.role,
        actorName: actor.fullName,
        decision: 'APPROVE',
        reason: reason.trim() || 'Verified and approved by institutional authority.',
        timestamp: decisionTimestamp,
      });
      await targetProfile.save();
    }

    // Activate any pending teaching assignments
    await TeachingAssignment.updateMany(
      { teacherId: targetUser._id, schoolId: confirmedSchoolId, status: TEACHING_ASSIGNMENT_STATUS.INACTIVE },
      { $set: { status: TEACHING_ASSIGNMENT_STATUS.ACTIVE, effectiveFrom: decisionTimestamp } }
    );

    await targetUser.save();

    // Applicant Notification
    await Notification.create({
      recipientUserId: targetUser._id,
      title: 'Institutional Account Approved',
      message: `Your staff profile for ${actor.designation || 'Administration'} has been verified and approved. You now have active access.`,
      notificationType: 'ONBOARDING',
      actionLink: '/dashboard',
    });

    // Immutable Audit Log (ZERO sensitive fields)
    await AuditLog.create({
      actorId: actor._id,
      actorRole: actor.role,
      actorDesignation: actor.designation,
      actorName: actor.fullName,
      action: 'STAFF_ONBOARDING_APPROVED',
      targetModel: 'User',
      targetId: targetUser._id,
      targetName: targetUser.fullName,
      townId: targetUser.townId,
      schoolId: confirmedSchoolId,
      newState: { status: USER_STATUS.ACTIVE, schoolId: confirmedSchoolId, verifiedBy: actor.role },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });

    return sendSuccess(response, 200, 'Staff registration approved and activated successfully.', {
      userId: targetUser._id,
      status: targetUser.status,
      schoolId: targetUser.schoolId,
    });
  }

  // ─── 2. REQUEST_CORRECTION Branch ───────────────────────────────────────────
  if (decision === 'REQUEST_CORRECTION') {
    if (!reason || reason.trim().length < 5) {
      return sendError(response, 400, 'Mandatory remarks (minimum 5 characters) explaining required corrections are required.');
    }

    targetUser.status = USER_STATUS.REQUIRES_CORRECTION;
    targetUser.approvalDetails = {
      approvedBy: actor._id,
      approvedAt: decisionTimestamp,
      correctionRemarks: reason.trim(),
    };

    if (targetProfile) {
      targetProfile.lifecycleStatus = TEACHER_STATUS.REQUIRES_CORRECTION;
      targetProfile.correctionRemarks = reason.trim();
      targetProfile.approvalHistory.push({
        action: 'CORRECTION_REQUESTED',
        actorId: actor._id,
        actorRole: actor.role,
        actorName: actor.fullName,
        decision: 'REQUEST_CORRECTION',
        reason: reason.trim(),
        timestamp: decisionTimestamp,
      });
      await targetProfile.save();
    }

    await targetUser.save();

    await Notification.create({
      recipientUserId: targetUser._id,
      title: 'Profile Correction Requested',
      message: `Your registration requires corrections: ${reason.trim()}. Please resubmit your profile.`,
      notificationType: 'ONBOARDING',
      actionLink: '/resubmit-correction',
    });

    await AuditLog.create({
      actorId: actor._id,
      actorRole: actor.role,
      actorDesignation: actor.designation,
      actorName: actor.fullName,
      action: 'STAFF_CORRECTION_REQUESTED',
      targetModel: 'User',
      targetId: targetUser._id,
      targetName: targetUser.fullName,
      townId: targetUser.townId,
      newState: { status: USER_STATUS.REQUIRES_CORRECTION, remarks: reason.trim() },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });

    return sendSuccess(response, 200, 'Correction request issued to applicant.', {
      userId: targetUser._id,
      status: targetUser.status,
    });
  }

  // ─── 3. REJECT Branch ───────────────────────────────────────────────────────
  if (decision === 'REJECT') {
    if (!reason || reason.trim().length < 5) {
      return sendError(response, 400, 'Mandatory reason (minimum 5 characters) is required to reject registration.');
    }

    // Explicit REJECTED lifecycle state
    targetUser.status = USER_STATUS.REJECTED;
    targetUser.approvalDetails = {
      approvedBy: actor._id,
      approvedAt: decisionTimestamp,
      rejectionReason: reason.trim(),
    };

    if (targetProfile) {
      targetProfile.lifecycleStatus = TEACHER_STATUS.REJECTED;
      targetProfile.rejectionReason = reason.trim();
      targetProfile.approvalHistory.push({
        action: 'REJECTED',
        actorId: actor._id,
        actorRole: actor.role,
        actorName: actor.fullName,
        decision: 'REJECT',
        reason: reason.trim(),
        timestamp: decisionTimestamp,
      });
      await targetProfile.save();
    }

    // Cancel any inactive assignments
    await TeachingAssignment.updateMany(
      { teacherId: targetUser._id, status: TEACHING_ASSIGNMENT_STATUS.INACTIVE },
      { $set: { status: TEACHING_ASSIGNMENT_STATUS.INACTIVE, remarks: 'Registration rejected' } }
    );

    await targetUser.save();

    await Notification.create({
      recipientUserId: targetUser._id,
      title: 'Registration Rejected',
      message: `Your staff registration was rejected. Reason: ${reason.trim()}.`,
      notificationType: 'ONBOARDING',
      actionLink: '',
    });

    await AuditLog.create({
      actorId: actor._id,
      actorRole: actor.role,
      actorDesignation: actor.designation,
      actorName: actor.fullName,
      action: 'STAFF_ONBOARDING_REJECTED',
      targetModel: 'User',
      targetId: targetUser._id,
      targetName: targetUser.fullName,
      townId: targetUser.townId,
      newState: { status: USER_STATUS.REJECTED, reason: reason.trim() },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });

    return sendSuccess(response, 200, 'Staff registration rejected and archived.', {
      userId: targetUser._id,
      status: targetUser.status,
    });
  }
});
