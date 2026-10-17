/**
 * Leave Management Controller
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Handles all CL/EL request lifecycle:
 *   POST   /api/v1/leave/submit           - Teacher/staff submits own CL or EL request
 *   GET    /api/v1/leave/my-requests      - Staff views their own leave history
 *   GET    /api/v1/leave/pending          - HM/Admin views pending leave requests for approval
 *   POST   /api/v1/leave/:id/approve      - HM/Admin approves a leave request
 *   POST   /api/v1/leave/:id/reject       - HM/Admin rejects a leave request
 *   POST   /api/v1/leave/hm-initiate      - HM records CL or Absent on behalf of absent teacher
 *   GET    /api/v1/leave/cl-balance       - Staff views their CL balance for current year
 *
 * ALL authorization checks are derived from authenticated server-side principal.
 * Client cannot supply, override, or inject approver identity, role, or school scope.
 */

import mongoose from 'mongoose';
import LeaveRequest from '../models/LeaveRequest.js';
import StaffAttendanceRecord from '../models/StaffAttendanceRecord.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import {
  LEAVE_TYPE,
  LEAVE_STATUS,
  LEAVE_SOURCE,
  STAFF_ATTENDANCE_STATUS,
  CL_POLICY,
  EL_POLICY,
  ROLES,
  APPROVAL_RELAXATION_WINDOW_MS,
} from '../../config/constants.js';
import {
  parsePktDateString,
  getPktYearFromDate,
  calculateInclusiveDurationDays,
  findOverlappingLeaveRequest,
  validateEarnedLeaveDuration,
  calculateApprovedClDaysUsed,
  getRemainingClBalance,
  generateLeaveRequestFingerprint,
  resolveLeaveApprovalAuthority,
  resolveLeaveForwardAuthority,
} from '../services/leaveService.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';
import logger from '../../config/logger.js';

// ─── Helper: Emit AuditLog ────────────────────────────────────────────────────
const emitLeaveAuditLog = async ({
  actorUser,
  action,
  targetLeaveRequest,
  previousState,
  newState,
  reason = '',
  request,
}) => {
  try {
    await AuditLog.create({
      actorId:          actorUser._id,
      actorRole:        actorUser.role,
      actorDesignation: actorUser.designation || '',
      actorName:        actorUser.fullName || '',
      action,
      targetModel:      'LeaveRequest',
      targetId:         targetLeaveRequest._id,
      targetName:       `Leave-${targetLeaveRequest.leaveType}-${targetLeaveRequest._id}`,
      schoolId:         targetLeaveRequest.schoolId,
      previousState,
      newState,
      result:           'SUCCESS',
      reason,
      ipAddress:        request?.ip || '',
      userAgent:        request?.get?.('user-agent') || '',
    });
  } catch (auditError) {
    logger.error(`[LeaveController] Audit log write failed for action ${action}: ${auditError.message}`);
    // Fail-open: do not block the primary operation if audit write fails
  }
};

// ─── POST /api/v1/leave/submit ────────────────────────────────────────────────
/**
 * Staff submits their own CL or EL request.
 * Authorization: LEAVE_SUBMIT permission (TEACHER, PEON roles)
 */
export const handleSubmitLeaveRequest = async (request, response) => {
  const requestingActor = request.user;
  const { leaveType, startDate: startDateString, endDate: endDateString, reason } = request.body;

  // Validate required fields
  if (!leaveType || !startDateString || !endDateString || !reason?.trim()) {
    return response.status(400).json({
      success: false,
      message: 'leaveType, startDate, endDate, and reason are required.',
    });
  }

  if (!Object.values(LEAVE_TYPE).includes(leaveType)) {
    return response.status(400).json({
      success: false,
      message: `Invalid leaveType. Must be one of: ${Object.values(LEAVE_TYPE).join(', ')}.`,
    });
  }

  // Parse and validate dates
  let startDate, endDate;
  try {
    startDate = parsePktDateString(startDateString);
    endDate   = parsePktDateString(endDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  if (endDate < startDate) {
    return response.status(400).json({
      success: false,
      message: 'endDate must be on or after startDate.',
    });
  }

  // EL-specific duration validation
  let durationDays;
  if (leaveType === LEAVE_TYPE.EARNED_LEAVE) {
    const elValidation = validateEarnedLeaveDuration(startDate, endDate);
    if (!elValidation.valid) {
      return response.status(400).json({ success: false, message: elValidation.error });
    }
    durationDays = elValidation.durationDays;
  } else {
    durationDays = calculateInclusiveDurationDays(startDate, endDate);
  }

  const leaveYear = getPktYearFromDate(startDate);

  // CL balance and consecutive days checks
  if (leaveType === LEAVE_TYPE.CASUAL_LEAVE) {
    if (durationDays > CL_POLICY.MAX_CONSECUTIVE_DAYS) {
      return response.status(400).json({
        success: false,
        message: `Casual Leave (CL) cannot exceed ${CL_POLICY.MAX_CONSECUTIVE_DAYS} consecutive calendar days per application under municipal regulations. For leaves exceeding 3 days, please apply for Earned Leave (EL).`,
        requestedDays: durationDays,
        maxAllowedDays: CL_POLICY.MAX_CONSECUTIVE_DAYS,
      });
    }

    const remainingBalance = await getRemainingClBalance(requestingActor._id, leaveYear);
    if (durationDays > remainingBalance) {
      return response.status(400).json({
        success: false,
        message: `Insufficient CL balance. Requested: ${durationDays} day(s). Remaining balance for ${leaveYear}: ${remainingBalance} day(s).`,
        remainingBalance,
        requestedDays: durationDays,
      });
    }
  }

  // Overlap detection
  const overlappingRequest = await findOverlappingLeaveRequest(
    requestingActor._id, leaveType, startDate, endDate
  );
  if (overlappingRequest) {
    return response.status(409).json({
      success: false,
      message: `A ${leaveType.replace('_', ' ')} request already exists for overlapping dates (${overlappingRequest.startDate?.toISOString().split('T')[0]} to ${overlappingRequest.endDate?.toISOString().split('T')[0]}). Status: ${overlappingRequest.status}.`,
    });
  }

  // Idempotency fingerprint
  const requestFingerprint = generateLeaveRequestFingerprint(
    requestingActor._id, leaveType, startDate, endDate
  );
  const existingByFingerprint = await LeaveRequest.findOne({ requestFingerprint }).lean();
  if (existingByFingerprint) {
    return response.status(409).json({
      success: false,
      message: 'An identical leave request was already submitted. Please check your pending requests.',
    });
  }

  // Resolve HM to notify (for school staff)
  let hmToNotifyId = null;
  if (requestingActor.schoolId) {
    const schoolHm = await User.findOne({
      schoolId: requestingActor.schoolId,
      role: ROLES.HM,
      status: 'ACTIVE',
    }).select('_id').lean();
    if (schoolHm) hmToNotifyId = schoolHm._id;
  }

  // Create the leave request
  const newLeaveRequest = await LeaveRequest.create({
    schoolId:         requestingActor.schoolId,
    townId:           requestingActor.townId,
    staffUserId:      requestingActor._id,
    staffRole:        requestingActor.role,
    staffCategory:    requestingActor.staffCategory || null,
    leaveType,
    startDate,
    endDate,
    durationDays,
    reason:           reason.trim(),
    leaveYear,
    source:           LEAVE_SOURCE.TEACHER_INITIATED,
    status:           LEAVE_STATUS.PENDING,
    submittedAt:      new Date(),
    requestFingerprint,
  });

  // Dispatch notification to HM
  if (hmToNotifyId) {
    try {
      await dispatchNotificationEvent({
        eventType: 'APPROVAL_REQUIRED',
        category:  'ATTENDANCE',
        title:     `${leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'CL' : 'EL'} Request — ${requestingActor.fullName}`,
        message:   `${requestingActor.fullName} has submitted a ${leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'Casual Leave' : 'Earned Leave'} request for ${startDateString} to ${endDateString} (${durationDays} day(s)).`,
        actionLink: '/leave/pending',
        rawMetadata: {
          staffId:    String(requestingActor._id),
          staffName:  requestingActor.fullName,
          designation: requestingActor.designation || '',
          schoolName:  requestingActor.schoolId ? String(requestingActor.schoolId) : '',
        },
        recipientUserIds: [String(hmToNotifyId)],
      });
      await LeaveRequest.findByIdAndUpdate(newLeaveRequest._id, {
        $set: { 'notificationDispatched.submissionNotification': true },
      });
    } catch (notificationError) {
      logger.warn(`[LeaveController] Notification dispatch failed for leave ${newLeaveRequest._id}: ${notificationError.message}`);
    }
  }

  // Emit audit log
  await emitLeaveAuditLog({
    actorUser:         requestingActor,
    action:            'LEAVE_REQUEST_SUBMITTED',
    targetLeaveRequest: newLeaveRequest,
    previousState:     null,
    newState:          { leaveType, startDate: startDateString, endDate: endDateString, durationDays, status: LEAVE_STATUS.PENDING, source: LEAVE_SOURCE.TEACHER_INITIATED },
    reason:            reason.trim(),
    request,
  });

  return response.status(201).json({
    success: true,
    message: `${leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'Casual Leave' : 'Earned Leave'} request submitted successfully. Pending approval.`,
    leaveRequest: {
      _id:           newLeaveRequest._id,
      leaveType:     newLeaveRequest.leaveType,
      startDate:     startDateString,
      endDate:       endDateString,
      durationDays:  newLeaveRequest.durationDays,
      status:        newLeaveRequest.status,
      source:        newLeaveRequest.source,
      submittedAt:   newLeaveRequest.submittedAt,
      forwardedByHm: newLeaveRequest.forwardedByHm || false,
    },
  });
};

// ─── GET /api/v1/leave/my-requests ───────────────────────────────────────────
/**
 * Staff views their own leave history.
 */
export const handleGetMyLeaveRequests = async (request, response) => {
  const requestingActor = request.user;
  const { leaveType, status: statusFilter, year } = request.query;

  const queryFilter = { staffUserId: requestingActor._id };
  if (leaveType)     queryFilter.leaveType = leaveType;
  if (statusFilter)  queryFilter.status = statusFilter;
  if (year)          queryFilter.leaveYear = Number(year);

  const leaveRequests = await LeaveRequest.find(queryFilter)
    .sort({ startDate: -1 })
    .limit(100)
    .lean();

  return response.status(200).json({
    success: true,
    count:   leaveRequests.length,
    leaveRequests,
  });
};

// ─── GET /api/v1/leave/cl-balance ─────────────────────────────────────────────
/**
 * Staff views their CL balance summary for the current or specified year.
 */
export const handleGetClBalance = async (request, response) => {
  const requestingActor = request.user;
  const year = request.query.year
    ? Number(request.query.year)
    : getPktYearFromDate(new Date());

  const usedDays       = await calculateApprovedClDaysUsed(requestingActor._id, year);
  const remainingDays  = Math.max(0, CL_POLICY.ANNUAL_ENTITLEMENT_DAYS - usedDays);

  return response.status(200).json({
    success: true,
    clBalance: {
      year,
      entitlementDays:   CL_POLICY.ANNUAL_ENTITLEMENT_DAYS,
      usedDays,
      remainingDays,
      carryForwardAllowed: CL_POLICY.CARRY_FORWARD_ALLOWED,
    },
  });
};

// ─── GET /api/v1/leave/pending ────────────────────────────────────────────────
/**
 * HM views pending leave requests for their school.
 * Admin views pending leave requests for all schools in their scope.
 */
export const handleGetPendingLeaveRequests = async (request, response) => {
  const requestingActor = request.user;
  const { leaveType, status, page = 1, limit = 20 } = request.query;

  const queryFilter = {};
  if (status) {
    if (status.includes(',')) {
      queryFilter.status = { $in: status.split(',').map((item) => item.trim()) };
    } else {
      queryFilter.status = status.trim();
    }
  } else {
    queryFilter.status = LEAVE_STATUS.PENDING;
  }
  if (leaveType) queryFilter.leaveType = leaveType;

  // Scope enforcement
  if (requestingActor.role === ROLES.HM) {
    if (!requestingActor.schoolId) {
      return response.status(403).json({ success: false, message: 'HM must have an assigned school.' });
    }
    queryFilter.schoolId = requestingActor.schoolId;
  }
  // ADMIN, SUPER_ADMIN, ROOT_ADMIN see all pending (or optionally filtered by townId)
  // SUPERVISOR sees requests for assigned schools
  if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map(String);
    if (assignedSchoolIds.length === 0) {
      return response.status(200).json({ success: true, count: 0, leaveRequests: [] });
    }
    queryFilter.schoolId = { $in: assignedSchoolIds };
  }

  const pageNumber  = Math.max(1, Number(page));
  const limitNumber = Math.min(50, Math.max(1, Number(limit)));

  const [leaveRequests, totalCount] = await Promise.all([
    LeaveRequest.find(queryFilter)
      .populate('staffUserId', 'fullName designation role staffCategory')
      .populate('hmForwardedBy', 'fullName designation role')
      .populate('schoolId', 'name schoolCode')
      .sort({ submittedAt: 1 })
      .skip((pageNumber - 1) * limitNumber)
      .limit(limitNumber)
      .lean(),
    LeaveRequest.countDocuments(queryFilter),
  ]);

  return response.status(200).json({
    success: true,
    count:   leaveRequests.length,
    total:   totalCount,
    page:    pageNumber,
    leaveRequests,
  });
};

// ─── POST /api/v1/leave/:id/approve ──────────────────────────────────────────
/**
 * Authorized approver approves a pending leave request.
 * For EL: only Admin-level (80+) can approve.
 * For CL: HM (school staff), Supervisor (HM CL), Admin (any CL).
 */
export const handleApproveLeaveRequest = async (request, response) => {
  const requestingActor = request.user;
  const { id: leaveRequestId } = request.params;
  const approvalReason = request.body.reason || request.body.approvalReason || request.body.remarks || '';

  if (!mongoose.Types.ObjectId.isValid(leaveRequestId)) {
    return response.status(400).json({ success: false, message: 'Invalid leave request ID.' });
  }

  const existingLeaveRequest = await LeaveRequest.findById(leaveRequestId);
  if (!existingLeaveRequest) {
    return response.status(404).json({ success: false, message: 'Leave request not found.' });
  }

  if (existingLeaveRequest.status !== LEAVE_STATUS.PENDING) {
    return response.status(409).json({
      success: false,
      message: `Leave request is already ${existingLeaveRequest.status}. Only PENDING requests can be approved.`,
    });
  }

  // Authorization check (backend enforced — not from client)
  const authorityCheck = resolveLeaveApprovalAuthority(requestingActor, existingLeaveRequest);
  if (!authorityCheck.authorized) {
    await AuditLog.create({
      actorId:       requestingActor._id,
      actorRole:     requestingActor.role,
      actorName:     requestingActor.fullName || '',
      action:        'LEAVE_APPROVE_UNAUTHORIZED_ATTEMPT',
      targetModel:   'LeaveRequest',
      targetId:      existingLeaveRequest._id,
      schoolId:      existingLeaveRequest.schoolId,
      result:        'DENIED',
      reason:        authorityCheck.reason,
      ipAddress:     request.ip || '',
      userAgent:     request.get?.('user-agent') || '',
    });
    return response.status(403).json({ success: false, message: authorityCheck.reason });
  }

  // For EL, double-check Admin-level restriction is enforced
  if (
    existingLeaveRequest.leaveType === LEAVE_TYPE.EARNED_LEAVE &&
    ![ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role)
  ) {
    return response.status(403).json({
      success: false,
      message: 'EL approval is restricted to Admin-level (Level 80) and above. HM and Supervisor are not authorized.',
    });
  }

  // Duplicate approval concurrency guard
  const refreshedLeaveRequest = await LeaveRequest.findById(leaveRequestId);
  if (refreshedLeaveRequest.status !== LEAVE_STATUS.PENDING) {
    return response.status(409).json({
      success: false,
      message: 'Concurrent operation detected: leave request was already processed. Please refresh.',
    });
  }

  // CL balance re-validation at approval time (prevent double-deduction races)
  if (existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE) {
    const remainingBalance = await getRemainingClBalance(
      existingLeaveRequest.staffUserId,
      existingLeaveRequest.leaveYear
    );
    if (existingLeaveRequest.durationDays > remainingBalance) {
      return response.status(400).json({
        success: false,
        message: `Cannot approve: insufficient CL balance. Requested: ${existingLeaveRequest.durationDays} day(s). Available: ${remainingBalance} day(s).`,
      });
    }
  }

  const previousStateSnapshot = existingLeaveRequest.toObject();
  const nowTimestamp = new Date();

  // Update to APPROVED
  existingLeaveRequest.status     = LEAVE_STATUS.APPROVED;
  existingLeaveRequest.approvedBy = requestingActor._id;
  existingLeaveRequest.approvedAt = nowTimestamp;
  if (approvalReason?.trim()) {
    existingLeaveRequest.decisionReason = approvalReason.trim();
  }
  await existingLeaveRequest.save();

  // Notify requester
  try {
    await dispatchNotificationEvent({
      eventType: 'APPROVAL_REQUIRED',
      category:  'ATTENDANCE',
      title:     `${existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'CL' : 'EL'} Approved`,
      message:   `Your ${existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'Casual Leave' : 'Earned Leave'} request has been approved by ${requestingActor.fullName}.`,
      actionLink: '/leave/my-requests',
      rawMetadata: {
        staffId:   String(existingLeaveRequest.staffUserId),
        staffName: requestingActor.fullName,
        designation: requestingActor.designation || '',
        schoolName:  '',
      },
      recipientUserIds: [String(existingLeaveRequest.staffUserId)],
    });
    await LeaveRequest.findByIdAndUpdate(leaveRequestId, {
      $set: { 'notificationDispatched.decisionNotificationSent': true },
    });
  } catch (notificationError) {
    logger.warn(`[LeaveController] Decision notification failed: ${notificationError.message}`);
  }

  await emitLeaveAuditLog({
    actorUser:         requestingActor,
    action:            'LEAVE_REQUEST_APPROVED',
    targetLeaveRequest: existingLeaveRequest,
    previousState:     previousStateSnapshot,
    newState:          { status: LEAVE_STATUS.APPROVED, approvedBy: requestingActor._id, approvedAt: nowTimestamp },
    reason:            approvalReason?.trim() || '',
    request,
  });

  return response.status(200).json({
    success: true,
    message: 'Leave request approved successfully.',
    leaveRequest: {
      _id:         existingLeaveRequest._id,
      status:      existingLeaveRequest.status,
      approvedBy:  requestingActor._id,
      approvedAt:  nowTimestamp,
    },
  });
};

// ─── POST /api/v1/leave/:id/reject ───────────────────────────────────────────
/**
 * Authorized approver rejects a pending leave request.
 * Mandatory: free-text rejection reason.
 */
export const handleRejectLeaveRequest = async (request, response) => {
  const requestingActor = request.user;
  const { id: leaveRequestId } = request.params;
  const rejectionReason = request.body.reason || request.body.rejectionReason;

  if (!mongoose.Types.ObjectId.isValid(leaveRequestId)) {
    return response.status(400).json({ success: false, message: 'Invalid leave request ID.' });
  }

  if (!rejectionReason?.trim() || rejectionReason.trim().length < 5) {
    return response.status(400).json({
      success: false,
      message: 'Rejection reason is mandatory and must be at least 5 characters.',
    });
  }

  const existingLeaveRequest = await LeaveRequest.findById(leaveRequestId);
  if (!existingLeaveRequest) {
    return response.status(404).json({ success: false, message: 'Leave request not found.' });
  }

  if (existingLeaveRequest.status !== LEAVE_STATUS.PENDING) {
    return response.status(409).json({
      success: false,
      message: `Leave request is already ${existingLeaveRequest.status}. Only PENDING requests can be rejected.`,
    });
  }

  const authorityCheck = resolveLeaveApprovalAuthority(requestingActor, existingLeaveRequest, 'REJECT');
  if (!authorityCheck.authorized) {
    await AuditLog.create({
      actorId:     requestingActor._id,
      actorRole:   requestingActor.role,
      actorName:   requestingActor.fullName || '',
      action:      'LEAVE_REJECT_UNAUTHORIZED_ATTEMPT',
      targetModel: 'LeaveRequest',
      targetId:    existingLeaveRequest._id,
      schoolId:    existingLeaveRequest.schoolId,
      result:      'DENIED',
      reason:      authorityCheck.reason,
      ipAddress:   request.ip || '',
      userAgent:   request.get?.('user-agent') || '',
    });
    return response.status(403).json({ success: false, message: authorityCheck.reason });
  }

  const previousStateSnapshot = existingLeaveRequest.toObject();
  const nowTimestamp = new Date();

  existingLeaveRequest.status     = LEAVE_STATUS.REJECTED;
  existingLeaveRequest.rejectedBy = requestingActor._id;
  existingLeaveRequest.rejectedAt = nowTimestamp;
  existingLeaveRequest.decisionReason = rejectionReason.trim();
  await existingLeaveRequest.save();

  // Notify requester of rejection
  try {
    await dispatchNotificationEvent({
      eventType: 'APPROVAL_REQUIRED',
      category:  'ATTENDANCE',
      title:     `${existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'CL' : 'EL'} Rejected`,
      message:   `Your ${existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'Casual Leave' : 'Earned Leave'} request has been rejected by ${requestingActor.fullName}. Reason: ${rejectionReason.trim()}`,
      actionLink: '/leave/my-requests',
      rawMetadata: {
        staffId:    String(existingLeaveRequest.staffUserId),
        staffName:  requestingActor.fullName,
        designation: requestingActor.designation || '',
        schoolName:  '',
      },
      recipientUserIds: [String(existingLeaveRequest.staffUserId)],
    });
  } catch (notificationError) {
    logger.warn(`[LeaveController] Rejection notification failed: ${notificationError.message}`);
  }

  await emitLeaveAuditLog({
    actorUser:         requestingActor,
    action:            'LEAVE_REQUEST_REJECTED',
    targetLeaveRequest: existingLeaveRequest,
    previousState:     previousStateSnapshot,
    newState:          { status: LEAVE_STATUS.REJECTED, rejectedBy: requestingActor._id, rejectedAt: nowTimestamp, decisionReason: rejectionReason.trim() },
    reason:            rejectionReason.trim(),
    request,
  });

  return response.status(200).json({
    success: true,
    message: 'Leave request rejected.',
    leaveRequest: {
      _id:            existingLeaveRequest._id,
      status:         existingLeaveRequest.status,
      rejectedBy:     requestingActor._id,
      rejectedAt:     nowTimestamp,
      decisionReason: rejectionReason.trim(),
    },
  });
};

// ─── POST /api/v1/leave/:id/forward ──────────────────────────────────────────
/**
 * Head Master (or Supervisor/Admin) reviews an Earned Leave (EL) request
 * from school staff and forwards it with official recommendation remarks to Town Office.
 */
export const handleForwardLeaveRequest = async (request, response) => {
  const requestingActor = request.user;
  const { id: leaveRequestId } = request.params;
  const recommendationNote = request.body.recommendationNote || request.body.reason || '';

  if (!mongoose.Types.ObjectId.isValid(leaveRequestId)) {
    return response.status(400).json({ success: false, message: 'Invalid leave request ID.' });
  }

  const existingLeaveRequest = await LeaveRequest.findById(leaveRequestId).populate('staffUserId', 'fullName designation role schoolId');
  if (!existingLeaveRequest) {
    return response.status(404).json({ success: false, message: 'Leave request not found.' });
  }

  if (existingLeaveRequest.status !== LEAVE_STATUS.PENDING) {
    return response.status(409).json({
      success: false,
      message: `Leave request is ${existingLeaveRequest.status}. Only PENDING requests can be forwarded.`,
    });
  }

  if (existingLeaveRequest.leaveType !== LEAVE_TYPE.EARNED_LEAVE) {
    return response.status(400).json({
      success: false,
      message: 'Only Earned Leave (EL) requests require Head Master recommendation and forwarding to Town Office. Casual Leave is approved directly by Head Master.',
    });
  }

  if (existingLeaveRequest.forwardedByHm) {
    return response.status(409).json({
      success: false,
      message: 'This Earned Leave request has already been recommended and forwarded to Town Office.',
    });
  }

  const forwardAuthority = resolveLeaveForwardAuthority(requestingActor, existingLeaveRequest);
  if (!forwardAuthority.authorized) {
    await AuditLog.create({
      actorId:     requestingActor._id,
      actorRole:   requestingActor.role,
      actorName:   requestingActor.fullName || '',
      action:      'LEAVE_FORWARD_UNAUTHORIZED_ATTEMPT',
      targetModel: 'LeaveRequest',
      targetId:    existingLeaveRequest._id,
      schoolId:    existingLeaveRequest.schoolId,
      result:      'DENIED',
      reason:      forwardAuthority.reason,
      ipAddress:   request.ip || '',
      userAgent:   request.get?.('user-agent') || '',
    });
    return response.status(403).json({ success: false, message: forwardAuthority.reason });
  }

  if (!recommendationNote.trim() || recommendationNote.trim().length < 3) {
    return response.status(400).json({
      success: false,
      message: 'Recommendation note or institutional justification is required (minimum 3 characters).',
    });
  }

  const previousStateSnapshot = existingLeaveRequest.toObject();
  const nowTimestamp = new Date();

  existingLeaveRequest.forwardedByHm        = true;
  existingLeaveRequest.hmForwardedBy        = requestingActor._id;
  existingLeaveRequest.hmForwardedAt        = nowTimestamp;
  existingLeaveRequest.hmRecommendationNote = recommendationNote.trim();

  await existingLeaveRequest.save();

  // Audit Log
  await emitLeaveAuditLog({
    actorUser:          requestingActor,
    action:             'LEAVE_REQUEST_FORWARDED_TO_OFFICE',
    targetLeaveRequest: existingLeaveRequest,
    previousState:      previousStateSnapshot,
    newState: {
      forwardedByHm:        true,
      hmForwardedBy:        requestingActor._id,
      hmForwardedAt:        nowTimestamp,
      hmRecommendationNote: recommendationNote.trim(),
    },
    reason:  recommendationNote.trim(),
    request,
  });

  // Notify Admins
  try {
    const adminUsers = await User.find({
      role: { $in: [ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN] },
      status: 'ACTIVE',
    }).select('_id').lean();

    if (adminUsers.length > 0) {
      await dispatchNotificationEvent({
        eventType: 'APPROVAL_REQUIRED',
        category:  'ATTENDANCE',
        title:     `EL Forwarded for Sanction — ${existingLeaveRequest.staffUserId?.fullName || 'Teacher'}`,
        message:   `HM ${requestingActor.fullName} has recommended and forwarded an Earned Leave request (${existingLeaveRequest.durationDays} day(s)) to Town Office for final sanction.`,
        actionLink: '/approvals',
        rawMetadata: {
          leaveRequestId: String(existingLeaveRequest._id),
          staffName:      existingLeaveRequest.staffUserId?.fullName || '',
          hmName:         requestingActor.fullName,
          durationDays:   existingLeaveRequest.durationDays,
        },
        recipientUserIds: adminUsers.map((u) => String(u._id)),
      });
    }
  } catch (notifyErr) {
    logger.warn(`[LeaveController] Notification dispatch failed on forward: ${notifyErr.message}`);
  }

  return response.status(200).json({
    success: true,
    message: 'Earned Leave request recommended and forwarded to Town Education Office successfully.',
    leaveRequest: {
      _id:                  existingLeaveRequest._id,
      status:               existingLeaveRequest.status,
      forwardedByHm:        existingLeaveRequest.forwardedByHm,
      hmForwardedBy:        requestingActor._id,
      hmForwardedAt:        nowTimestamp,
      hmRecommendationNote: existingLeaveRequest.hmRecommendationNote,
    },
  });
};

// ─── POST /api/v1/leave/hm-initiate ──────────────────────────────────────────
/**
 * HM records CL or Absent on behalf of a teacher who was absent without submitting a request.
 *
 * Option A: hmInitiatedAbsentInstead = false  -> Records CL for the absent teacher
 * Option B: hmInitiatedAbsentInstead = true   -> Records ABSENT attendance for the teacher
 *
 * Authorization: LEAVE_INITIATE_HM permission (HM only)
 * School scope: HM can only initiate for teachers in their school.
 */
export const handleHmInitiateLeaveOrAbsent = async (request, response) => {
  const requestingActor = request.user;
  const {
    targetTeacherUserId,
    attendanceDate: attendanceDateString,
    hmInitiatedReason,
    hmInitiatedAbsentInstead = false,
  } = request.body;

  // Validate required fields
  if (!targetTeacherUserId || !attendanceDateString || !hmInitiatedReason?.trim()) {
    return response.status(400).json({
      success: false,
      message: 'targetTeacherUserId, attendanceDate, and hmInitiatedReason are required.',
    });
  }

  if (hmInitiatedReason.trim().length < 3) {
    return response.status(400).json({
      success: false,
      message: 'HM-initiated reason must be at least 3 characters.',
    });
  }

  if (!mongoose.Types.ObjectId.isValid(targetTeacherUserId)) {
    return response.status(400).json({ success: false, message: 'Invalid targetTeacherUserId.' });
  }

  // School scope enforcement: target teacher must belong to HM's school
  const targetTeacher = await User.findOne({
    _id:      targetTeacherUserId,
    schoolId: requestingActor.schoolId,
    status:   'ACTIVE',
  }).select('_id fullName designation role staffCategory schoolId').lean();

  if (!targetTeacher) {
    return response.status(403).json({
      success: false,
      message: 'Target teacher not found in your school. Cross-school HM initiation is prohibited.',
    });
  }

  // Parse date
  let attendanceDate;
  try {
    attendanceDate = parsePktDateString(attendanceDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  const leaveYear = getPktYearFromDate(attendanceDate);

  // Check for existing conflicting records on this date
  const existingConflict = await findOverlappingLeaveRequest(
    targetTeacher._id,
    LEAVE_TYPE.CASUAL_LEAVE,
    attendanceDate,
    attendanceDate
  );

  if (existingConflict && !hmInitiatedAbsentInstead) {
    return response.status(409).json({
      success: false,
      message: `A leave record already exists for ${targetTeacher.fullName} on ${attendanceDateString}. Status: ${existingConflict.status}.`,
      existingRecordId: existingConflict._id,
    });
  }

  // CL balance check (only if recording CL, not Absent)
  if (!hmInitiatedAbsentInstead) {
    const remainingBalance = await getRemainingClBalance(targetTeacher._id, leaveYear);
    if (remainingBalance < 1) {
      return response.status(400).json({
        success: false,
        message: `${targetTeacher.fullName} has no remaining CL balance for ${leaveYear}. Consider marking ABSENT instead.`,
        remainingBalance,
      });
    }
  }

  const actionDescription = hmInitiatedAbsentInstead
    ? `HM marked ABSENT (not CL) for ${targetTeacher.fullName} on ${attendanceDateString}`
    : `HM initiated CL on behalf of ${targetTeacher.fullName} for ${attendanceDateString}`;

  // Create the HM-initiated leave record
  const newLeaveRequest = await LeaveRequest.create({
    schoolId:                 requestingActor.schoolId,
    townId:                   requestingActor.townId,
    staffUserId:              targetTeacher._id,
    staffRole:                targetTeacher.role,
    staffCategory:            targetTeacher.staffCategory || null,
    leaveType:                LEAVE_TYPE.CASUAL_LEAVE,
    startDate:                attendanceDate,
    endDate:                  attendanceDate,
    durationDays:             1,
    reason:                   hmInitiatedReason.trim(),
    leaveYear,
    source:                   LEAVE_SOURCE.HM_INITIATED,
    status:                   hmInitiatedAbsentInstead ? LEAVE_STATUS.APPROVED : LEAVE_STATUS.APPROVED,
    // HM-initiated records are immediately APPROVED (HM has authority)
    // For ABSENT, this creates the record; the daily attendance record reflects ABSENT
    submittedAt:              new Date(),
    hmInitiatedActorId:       requestingActor._id,
    hmInitiatedReason:        hmInitiatedReason.trim(),
    hmInitiatedAbsentInstead: Boolean(hmInitiatedAbsentInstead),
    approvedBy:               requestingActor._id,
    approvedAt:               new Date(),
    requestFingerprint:       generateLeaveRequestFingerprint(
      targetTeacher._id, LEAVE_TYPE.CASUAL_LEAVE, attendanceDate, attendanceDate
    ),
  });

  // Emit audit log
  await emitLeaveAuditLog({
    actorUser:         requestingActor,
    action:            hmInitiatedAbsentInstead ? 'LEAVE_HM_MARKED_ABSENT' : 'LEAVE_HM_INITIATED_CL',
    targetLeaveRequest: newLeaveRequest,
    previousState:     null,
    newState: {
      source: LEAVE_SOURCE.HM_INITIATED,
      targetTeacher: String(targetTeacher._id),
      targetTeacherName: targetTeacher.fullName,
      attendanceDate: attendanceDateString,
      hmInitiatedAbsentInstead: Boolean(hmInitiatedAbsentInstead),
      hmInitiatedReason: hmInitiatedReason.trim(),
    },
    reason: hmInitiatedReason.trim(),
    request,
  });

  return response.status(201).json({
    success: true,
    message: actionDescription,
    leaveRequest: {
      _id:                      newLeaveRequest._id,
      targetTeacher:            { _id: targetTeacher._id, fullName: targetTeacher.fullName },
      leaveType:                LEAVE_TYPE.CASUAL_LEAVE,
      attendanceDate:           attendanceDateString,
      source:                   LEAVE_SOURCE.HM_INITIATED,
      status:                   newLeaveRequest.status,
      hmInitiatedAbsentInstead: Boolean(hmInitiatedAbsentInstead),
      hmInitiatedReason:        hmInitiatedReason.trim(),
    },
  });
};

// ─── GET /api/v1/leave/school-summary ────────────────────────────────────────
/**
 * HM views a leave summary for all staff in their school.
 */
export const handleGetSchoolLeaveSummary = async (request, response) => {
  const requestingActor = request.user;
  const { year } = request.query;

  const targetYear = year ? Number(year) : getPktYearFromDate(new Date());

  if (requestingActor.role === ROLES.HM && !requestingActor.schoolId) {
    return response.status(403).json({ success: false, message: 'HM must have an assigned school.' });
  }

  const schoolFilter = requestingActor.role === ROLES.HM
    ? { schoolId: requestingActor.schoolId }
    : {};

  const summaryRecords = await LeaveRequest.aggregate([
    {
      $match: {
        ...schoolFilter,
        leaveYear: targetYear,
        leaveType: LEAVE_TYPE.CASUAL_LEAVE,
        status:    LEAVE_STATUS.APPROVED,
      },
    },
    {
      $group: {
        _id:           '$staffUserId',
        totalClDaysUsed: { $sum: '$durationDays' },
        requestCount:   { $sum: 1 },
      },
    },
  ]);

  const summaryWithBalance = summaryRecords.map((summaryRecord) => ({
    staffUserId:      summaryRecord._id,
    clDaysUsed:       summaryRecord.totalClDaysUsed,
    clDaysRemaining:  Math.max(0, CL_POLICY.ANNUAL_ENTITLEMENT_DAYS - summaryRecord.totalClDaysUsed),
    clEntitlement:    CL_POLICY.ANNUAL_ENTITLEMENT_DAYS,
    approvedRequests: summaryRecord.requestCount,
    year:             targetYear,
  }));

  return response.status(200).json({
    success: true,
    year:    targetYear,
    summary: summaryWithBalance,
  });
};

// ─── POST /api/v1/leave/:id/correct ──────────────────────────────────────────
/**
 * Authorized approver performs a late correction on a SUPERSEDED or REJECTED leave request.
 * Required:
 *   - correctionReason (min 5 characters)
 * Invariants:
 *   - Cannot correct if already APPROVED
 *   - Authority strictly verified (Supervisor/Admin for HM, HM for School Staff, Admin+ for EL)
 *   - Self-correction is strictly forbidden
 *   - Appends full state snapshot to correctionHistory
 *   - Updates status to APPROVED
 *   - Updates linked StaffAttendanceRecord to APPROVED without erasing original Absent history
 *   - Emits immutable AuditLog
 */
export const handleLateCorrectionLeaveRequest = async (request, response) => {
  const requestingActor = request.user;
  const { id: leaveRequestId } = request.params;
  const correctionReason = request.body.correctionReason || request.body.reason;

  if (!mongoose.Types.ObjectId.isValid(leaveRequestId)) {
    return response.status(400).json({ success: false, message: 'Invalid leave request ID.' });
  }

  if (!correctionReason?.trim() || correctionReason.trim().length < 5) {
    return response.status(400).json({
      success: false,
      message: 'Correction reason is mandatory and must be at least 5 characters.',
    });
  }

  const existingLeaveRequest = await LeaveRequest.findById(leaveRequestId);
  if (!existingLeaveRequest) {
    return response.status(404).json({ success: false, message: 'Leave request not found.' });
  }

  if (existingLeaveRequest.status === LEAVE_STATUS.APPROVED) {
    return response.status(409).json({
      success: false,
      message: 'Leave request is already approved. Late correction only applies to SUPERSEDED or REJECTED requests.',
    });
  }

  if (![LEAVE_STATUS.SUPERSEDED, LEAVE_STATUS.REJECTED].includes(existingLeaveRequest.status)) {
    return response.status(400).json({
      success: false,
      message: `Cannot correct leave request with status '${existingLeaveRequest.status}'. Only SUPERSEDED or REJECTED requests can be corrected.`,
    });
  }

  const authorityCheck = resolveLeaveApprovalAuthority(requestingActor, existingLeaveRequest);
  if (!authorityCheck.authorized) {
    await AuditLog.create({
      actorId:     requestingActor._id,
      actorRole:   requestingActor.role,
      actorName:   requestingActor.fullName || '',
      action:      'LEAVE_CORRECT_UNAUTHORIZED_ATTEMPT',
      targetModel: 'LeaveRequest',
      targetId:    existingLeaveRequest._id,
      schoolId:    existingLeaveRequest.schoolId,
      result:      'DENIED',
      reason:      authorityCheck.reason,
      ipAddress:   request.ip || '',
      userAgent:   request.get?.('user-agent') || '',
    });
    return response.status(403).json({ success: false, message: authorityCheck.reason });
  }

  // Admin-level restriction for EL
  if (
    existingLeaveRequest.leaveType === LEAVE_TYPE.EARNED_LEAVE &&
    ![ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role)
  ) {
    return response.status(403).json({
      success: false,
      message: 'EL approval/correction is restricted to Admin-level and above.',
    });
  }

  // Check CL balance before approving late correction
  if (existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE) {
    const remainingBalance = await getRemainingClBalance(
      existingLeaveRequest.staffUserId,
      existingLeaveRequest.leaveYear
    );
    if (existingLeaveRequest.durationDays > remainingBalance) {
      return response.status(400).json({
        success: false,
        message: `Cannot correct and approve: insufficient CL balance. Requested: ${existingLeaveRequest.durationDays} day(s). Available: ${remainingBalance} day(s).`,
      });
    }
  }

  const previousStateSnapshot = existingLeaveRequest.toObject();
  const nowTimestamp = new Date();

  // Push to correctionHistory
  existingLeaveRequest.correctionHistory.push({
    correctedBy: requestingActor._id,
    correctedAt: nowTimestamp,
    previousStatus: existingLeaveRequest.status,
    newStatus: LEAVE_STATUS.APPROVED,
    correctionReason: correctionReason.trim(),
    previousState: {
      status: existingLeaveRequest.status,
      decisionReason: existingLeaveRequest.decisionReason,
      approvedBy: existingLeaveRequest.approvedBy,
      rejectedBy: existingLeaveRequest.rejectedBy,
    },
  });

  const previousStatus = existingLeaveRequest.status;
  existingLeaveRequest.status = LEAVE_STATUS.APPROVED;
  existingLeaveRequest.approvedBy = requestingActor._id;
  existingLeaveRequest.approvedAt = nowTimestamp;
  existingLeaveRequest.decisionReason = `Late correction approved: ${correctionReason.trim()} (Previously: ${existingLeaveRequest.decisionReason || previousStatus})`;

  await existingLeaveRequest.save();

  // Update linked StaffAttendanceRecord(s) across the entire leave date range
  // Ensure the original Absent record is NOT silently erased and statusHistory is immutably appended
  let attendanceUpdated = false;
  let attendanceUpdatedCount = 0;
  const linkedAttendanceRecords = await StaffAttendanceRecord.find({
    staffUserId: existingLeaveRequest.staffUserId,
    attendanceDate: {
      $gte: existingLeaveRequest.startDate,
      $lte: existingLeaveRequest.endDate,
    },
  });

  for (const linkedRecord of linkedAttendanceRecords) {
    const priorAttendanceStatus = linkedRecord.approvalStatus;
    const priorAbsentReason = linkedRecord.rejectionReason || 'No prior reason recorded';

    linkedRecord.statusHistory.push({
      event: 'LATE_CORRECTION_APPROVED',
      previousStatus: priorAttendanceStatus,
      newStatus: STAFF_ATTENDANCE_STATUS.APPROVED,
      changedBy: requestingActor._id,
      changedAt: nowTimestamp,
      reason: correctionReason.trim(),
      snapshot: {
        priorAttendanceStatus,
        priorRejectionReason: linkedRecord.rejectionReason,
        priorLateApprovalReason: linkedRecord.lateApprovalReason,
        priorApprovedBy: linkedRecord.approvedBy,
        priorRejectedBy: linkedRecord.rejectedBy,
        leaveRequestId: existingLeaveRequest._id,
        attendanceDate: linkedRecord.attendanceDate,
      },
    });

    linkedRecord.approvalStatus = STAFF_ATTENDANCE_STATUS.APPROVED;
    linkedRecord.approvedBy = requestingActor._id;
    linkedRecord.approvedAt = nowTimestamp;
    linkedRecord.lateApprovalReason = `[CORRECTED from ${priorAttendanceStatus}] Approved by ${requestingActor.fullName}: ${correctionReason.trim()}. Original Absent record preserved: "${priorAbsentReason}".`;
    await linkedRecord.save();
    attendanceUpdated = true;
    attendanceUpdatedCount++;
  }

  // Audit Log
  await emitLeaveAuditLog({
    actorUser: requestingActor,
    action: 'LEAVE_REQUEST_LATE_CORRECTION',
    targetLeaveRequest: existingLeaveRequest,
    previousState: previousStateSnapshot,
    newState: {
      status: LEAVE_STATUS.APPROVED,
      correctedBy: requestingActor._id,
      correctedAt: nowTimestamp,
      correctionReason: correctionReason.trim(),
      attendanceUpdated,
    },
    reason: correctionReason.trim(),
    request,
  });

  // Notify staff member
  try {
    await dispatchNotificationEvent({
      eventType: 'APPROVAL_REQUIRED',
      category: 'ATTENDANCE',
      title: `${existingLeaveRequest.leaveType === LEAVE_TYPE.CASUAL_LEAVE ? 'CL' : 'EL'} Late Correction Approved`,
      message: `Your leave request for ${existingLeaveRequest.startDatePkt} has been corrected and approved by ${requestingActor.fullName}. Reason: ${correctionReason.trim()}`,
      actionLink: '/leave/my-requests',
      rawMetadata: {
        staffId: String(existingLeaveRequest.staffUserId),
        staffName: requestingActor.fullName,
        designation: requestingActor.designation || '',
        schoolName: '',
      },
      recipientUserIds: [String(existingLeaveRequest.staffUserId)],
    });
  } catch (notificationError) {
    logger.warn(`[LeaveController] Late correction notification failed: ${notificationError.message}`);
  }

  return response.status(200).json({
    success: true,
    message: 'Leave request successfully corrected and approved.',
    leaveRequest: {
      _id: existingLeaveRequest._id,
      status: existingLeaveRequest.status,
      correctionHistory: existingLeaveRequest.correctionHistory,
      approvedBy: requestingActor._id,
      approvedAt: nowTimestamp,
      attendanceUpdated,
    },
  });
};

