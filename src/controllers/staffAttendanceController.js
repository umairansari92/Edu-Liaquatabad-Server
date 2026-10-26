/**
 * Staff Attendance Controller
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Handles the staff self-submission attendance workflow with approval queue.
 * Separate from student attendance (attendanceController.js) and teacher daily muster.
 *
 * ENDPOINTS:
 *   POST  /api/v1/staff-attendance/submit       - Staff submits own daily attendance
 *   GET   /api/v1/staff-attendance/pending       - HM/Admin views pending staff attendance
 *   POST  /api/v1/staff-attendance/:id/approve   - HM/Admin approves with optional/required reason
 *   POST  /api/v1/staff-attendance/:id/reject    - HM/Admin rejects with mandatory reason
 *   GET   /api/v1/staff-attendance/my-history    - Staff views own attendance history
 *   POST  /api/v1/staff-attendance/hm-self       - HM marks their own attendance (self-effective)
 *
 * 5-MINUTE RELAXATION RULE (backend-enforced):
 *   If (approvalTimestamp - submittedAt) <= 5 minutes: reason optional
 *   If (approvalTimestamp - submittedAt) > 5 minutes:  reason MANDATORY, rejection without reason = 400
 *
 * APPROVAL AUTHORITY:
 *   School staff (TEACHER, PEON) -> HM of same school
 *   Office staff                 -> Admin
 *   HM self-record               -> No approval required (self-effective)
 */

import mongoose from 'mongoose';
import StaffAttendanceRecord from '../models/StaffAttendanceRecord.js';
import LeaveRequest from '../models/LeaveRequest.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import {
  STAFF_ATTENDANCE_STATUS,
  ATTENDANCE_STATUS,
  LEAVE_STATUS,
  STAFF_CATEGORY,
  APPROVAL_RELAXATION_WINDOW_MS,
  ROLES,
} from '../../config/constants.js';
import { parsePktDateString } from '../services/leaveService.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';
import logger from '../../config/logger.js';

const FIVE_MINUTES_MS = APPROVAL_RELAXATION_WINDOW_MS; // 5 * 60 * 1000

// ─── POST /api/v1/staff-attendance/hm-self ───────────────────────────────────
/**
 * HM marks their own daily attendance — no external approval required.
 * Record is immediately APPROVED (HM authority = self-effective).
 */
export const handleHmSelfAttendance = async (request, response) => {
  const requestingActor = request.user;

  if (requestingActor.role !== ROLES.HM) {
    return response.status(403).json({
      success: false,
      message: 'Only Head Masters can use the self-attendance endpoint.',
    });
  }

  // School assignment guard: HM must have an assigned school
  if (!requestingActor.schoolId) {
    return response.status(400).json({
      success: false,
      message: 'Head Master must have an assigned school to record attendance.',
    });
  }

  const { attendanceDate: attendanceDateString } = request.body;
  if (!attendanceDateString) {
    return response.status(400).json({
      success: false,
      message: 'attendanceDate is required (YYYY-MM-DD).',
    });
  }

  let attendanceDate;
  try {
    attendanceDate = parsePktDateString(attendanceDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  // Idempotency: prevent duplicate record for same HM + date
  const existingRecord = await StaffAttendanceRecord.findOne({
    staffUserId:    requestingActor._id,
    attendanceDate,
  }).lean();

  if (existingRecord) {
    return response.status(409).json({
      success: false,
      message: `Attendance already recorded for ${attendanceDateString}.`,
      existingRecord: { _id: existingRecord._id, approvalStatus: existingRecord.approvalStatus },
    });
  }

  const nowTimestamp = new Date();
  let newAttendanceRecord;
  try {
    newAttendanceRecord = await StaffAttendanceRecord.create({
      schoolId:       requestingActor.schoolId,
      townId:         requestingActor.townId,
      staffUserId:    requestingActor._id,
      staffRole:      requestingActor.role,
      staffCategory:  requestingActor.staffCategory || null,
      attendanceDate,
      submittedAt:    nowTimestamp,
      isHmSelfRecord: true,
      approvalStatus: STAFF_ATTENDANCE_STATUS.APPROVED,
      approvedBy:     requestingActor._id,
      approvedAt:     nowTimestamp,
    });
  } catch (createError) {
    if (createError.code === 11000 || createError.message?.includes('E11000')) {
      return response.status(409).json({
        success: false,
        message: `Attendance already recorded for ${attendanceDateString}.`,
      });
    }
    throw createError;
  }

  await AuditLog.create({
    actorId:          requestingActor._id,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'HM_SELF_ATTENDANCE_MARKED',
    targetModel:      'StaffAttendanceRecord',
    targetId:         newAttendanceRecord._id,
    targetName:       `HM Self Attendance - ${attendanceDateString}`,
    schoolId:         requestingActor.schoolId,
    previousState:    null,
    newState:         { attendanceDate: attendanceDateString, status: STAFF_ATTENDANCE_STATUS.APPROVED, isHmSelfRecord: true },
    result:           'SUCCESS',
    ipAddress:        request.ip || '',
    userAgent:        request.get?.('user-agent') || '',
  });

  return response.status(201).json({
    success: true,
    message: 'HM attendance recorded and self-approved.',
    attendanceRecord: {
      _id:            newAttendanceRecord._id,
      attendanceDate: attendanceDateString,
      approvalStatus: STAFF_ATTENDANCE_STATUS.APPROVED,
      isHmSelfRecord: true,
      submittedAt:    nowTimestamp,
    },
  });
};

// ─── POST /api/v1/staff-attendance/submit ────────────────────────────────────
/**
 * Staff member submits their own daily attendance for approval.
 * Status becomes PENDING_APPROVAL until HM/Admin acts.
 */
export const handleSubmitStaffAttendance = async (request, response) => {
  const requestingActor = request.user;
  const { attendanceDate: attendanceDateString } = request.body;

  if (!attendanceDateString) {
    return response.status(400).json({
      success: false,
      message: 'attendanceDate is required (YYYY-MM-DD).',
    });
  }

  // ─── Phase 2 Rule: Block Office Staff Self-Submission ─────────────────────────
  // Office staff cannot self-submit attendance. In accordance with departmental
  // anti-fraud and transparency standards, office staff attendance must be recorded
  // from the administrative terminal by Super Admin.
  const isOfficeStaff =
    requestingActor.staffCategory === STAFF_CATEGORY.OFFICE_STAFF ||
    (!requestingActor.schoolId && [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role));

  if (isOfficeStaff) {
    return response.status(403).json({
      success: false,
      message: 'Office staff members cannot self-submit attendance. Attendance must be marked from the administrative office terminal.',
    });
  }

  // ─── School Staff School Assignment Guard ────────────────────────────────────
  // School staff (teachers, peons, school-based roles) MUST have an authoritative assigned school
  // to self-submit attendance. Staff without a valid school assignment cannot submit attendance.
  if (!requestingActor.schoolId) {
    return response.status(400).json({
      success: false,
      message: 'Active school assignment required. Staff without a valid school assignment cannot submit school attendance.',
    });
  }

  let attendanceDate;
  try {
    attendanceDate = parsePktDateString(attendanceDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  // Duplicate guard
  const existingRecord = await StaffAttendanceRecord.findOne({
    staffUserId: requestingActor._id,
    attendanceDate,
  }).lean();

  if (existingRecord) {
    return response.status(409).json({
      success: false,
      message: `Attendance already submitted for ${attendanceDateString}. Status: ${existingRecord.approvalStatus}.`,
      existingRecord: { _id: existingRecord._id, approvalStatus: existingRecord.approvalStatus },
    });
  }

  const nowTimestamp = new Date();

  // Resolve approver
  let approverToNotifyId = null;
  const staffCategory = requestingActor.staffCategory;

  if (staffCategory === STAFF_CATEGORY.SCHOOL_STAFF && requestingActor.schoolId) {
    const schoolHm = await User.findOne({
      schoolId: requestingActor.schoolId,
      role:     ROLES.HM,
      status:   'ACTIVE',
    }).select('_id').lean();
    if (schoolHm) approverToNotifyId = schoolHm._id;
  } else if (staffCategory === STAFF_CATEGORY.OFFICE_STAFF && requestingActor.townId) {
    const townAdmin = await User.findOne({
      townId: requestingActor.townId,
      role:   ROLES.ADMIN,
      status: 'ACTIVE',
    }).select('_id').lean();
    if (townAdmin) approverToNotifyId = townAdmin._id;
  }

  let newAttendanceRecord;
  try {
    newAttendanceRecord = await StaffAttendanceRecord.create({
      schoolId:       requestingActor.schoolId,
      townId:         requestingActor.townId,
      staffUserId:    requestingActor._id,
      staffRole:      requestingActor.role,
      staffCategory:  staffCategory || null,
      attendanceDate,
      submittedAt:    nowTimestamp,
      isHmSelfRecord: false,
      approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
      entryMode:      'STAFF_SELF',
      markedBy:       requestingActor._id,
    });
  } catch (createError) {
    if (createError.code === 11000 || createError.message?.includes('E11000')) {
      return response.status(409).json({
        success: false,
        message: `Attendance already submitted for ${attendanceDateString}.`,
      });
    }
    throw createError;
  }

  // Notify approver
  if (approverToNotifyId) {
    try {
      await dispatchNotificationEvent({
        eventType: 'APPROVAL_REQUIRED',
        category:  'ATTENDANCE',
        title:     `Staff Attendance Pending — ${requestingActor.fullName}`,
        message:   `${requestingActor.fullName} has submitted their attendance for ${attendanceDateString}. Awaiting your approval.`,
        actionLink: '/staff-attendance/pending',
        rawMetadata: {
          staffId:    String(requestingActor._id),
          staffName:  requestingActor.fullName,
          designation: requestingActor.designation || '',
          schoolName:  '',
        },
        recipientUserIds: [String(approverToNotifyId)],
      });
      await StaffAttendanceRecord.findByIdAndUpdate(newAttendanceRecord._id, {
        $set: { notificationDispatched: true, notificationDispatchedAt: nowTimestamp },
      });
    } catch (notificationError) {
      logger.warn(`[StaffAttendanceController] Notification failed: ${notificationError.message}`);
    }
  }

  await AuditLog.create({
    actorId:          requestingActor._id,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'STAFF_ATTENDANCE_SUBMITTED',
    targetModel:      'StaffAttendanceRecord',
    targetId:         newAttendanceRecord._id,
    targetName:       `Staff Attendance - ${attendanceDateString}`,
    schoolId:         requestingActor.schoolId,
    previousState:    null,
    newState:         { attendanceDate: attendanceDateString, approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL, submittedAt: nowTimestamp },
    result:           'SUCCESS',
    ipAddress:        request.ip || '',
    userAgent:        request.get?.('user-agent') || '',
  });

  return response.status(201).json({
    success: true,
    message: 'Attendance submitted successfully. Awaiting approval.',
    attendanceRecord: {
      _id:            newAttendanceRecord._id,
      attendanceDate: attendanceDateString,
      approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
      submittedAt:    nowTimestamp,
    },
  });
};

// ─── POST /api/v1/staff-attendance/:id/approve ───────────────────────────────
/**
 * HM or Admin approves a pending staff attendance record.
 *
 * 5-MINUTE RULE (backend-enforced):
 *   - approvalDelayMs = (now - submittedAt) in milliseconds
 *   - If delay <= FIVE_MINUTES_MS: reason not required
 *   - If delay > FIVE_MINUTES_MS: lateApprovalReason mandatory (min 5 chars)
 */
export const handleApproveStaffAttendance = async (request, response) => {
  const requestingActor = request.user;
  const { id: recordId } = request.params;
  const lateApprovalReason = request.body.lateApprovalReason || request.body.reason;

  if (!mongoose.Types.ObjectId.isValid(recordId)) {
    return response.status(400).json({ success: false, message: 'Invalid attendance record ID.' });
  }

  const existingRecord = await StaffAttendanceRecord.findById(recordId)
    .populate('staffUserId', 'fullName role staffCategory schoolId townId');

  if (!existingRecord) {
    return response.status(404).json({ success: false, message: 'Staff attendance record not found.' });
  }

  if (existingRecord.approvalStatus !== STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL) {
    return response.status(409).json({
      success: false,
      message: `Record is already ${existingRecord.approvalStatus}. Only PENDING_APPROVAL records can be approved.`,
    });
  }

  // Authorization: school staff -> HM of same school | office staff -> Admin | Admin -> Super Admin
  const targetStaff         = existingRecord.staffUserId;
  const targetStaffId       = String(targetStaff?._id || existingRecord.staffUserId);
  const targetStaffCategory = existingRecord.staffCategory;
  const targetStaffRole     = existingRecord.staffRole || targetStaff?.role;
  const actorRole           = requestingActor.role;
  const actorSchoolId       = String(requestingActor.schoolId || '');
  const recordSchoolId      = String(existingRecord.schoolId || '');

  // Self-approval is strictly prohibited for regular staff attendance submissions
  if (String(requestingActor._id) === targetStaffId) {
    return response.status(403).json({
      success: false,
      message: 'Self-approval of staff attendance is prohibited. Approval must be granted by an authorized authority.',
    });
  }

  let approvalAuthorized = false;

  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actorRole)) {
    approvalAuthorized = true;
  } else if (actorRole === ROLES.ADMIN) {
    // Admin can approve office and school staff, but cannot approve another Admin's attendance
    if (targetStaffRole !== ROLES.ADMIN) {
      approvalAuthorized = true;
    }
  } else if (actorRole === ROLES.HM) {
    // HM can approve school staff attendance in their school
    if (targetStaffCategory === STAFF_CATEGORY.SCHOOL_STAFF && actorSchoolId === recordSchoolId && targetStaffRole !== ROLES.ADMIN) {
      approvalAuthorized = true;
    }
  }

  if (!approvalAuthorized) {
    await AuditLog.create({
      actorId:     requestingActor._id,
      actorRole:   requestingActor.role,
      actorName:   requestingActor.fullName || '',
      action:      'STAFF_ATTENDANCE_APPROVE_UNAUTHORIZED',
      targetModel: 'StaffAttendanceRecord',
      targetId:    existingRecord._id,
      schoolId:    existingRecord.schoolId,
      result:      'DENIED',
      reason:      `${actorRole} not authorized to approve this staff attendance record.`,
      ipAddress:   request.ip || '',
      userAgent:   request.get?.('user-agent') || '',
    });
    return response.status(403).json({
      success: false,
      message: 'You are not authorized to approve this attendance record.',
    });
  }

  // Calculate server-side delay — client cannot supply or override this
  const nowTimestamp = new Date();
  const approvalDelayMs = nowTimestamp - existingRecord.submittedAt;
  const isLateApproval  = approvalDelayMs > FIVE_MINUTES_MS;

  // 5-minute rule enforcement
  if (isLateApproval && (!lateApprovalReason?.trim() || lateApprovalReason.trim().length < 5)) {
    return response.status(400).json({
      success: false,
      message: `Late approval detected: ${Math.round(approvalDelayMs / 60000)} minutes after submission. A free-text explanation (min 5 characters) is mandatory. Examples: "Notification received late", "System was not accessible".`,
      approvalDelayMs,
      approvalDelayMinutes: Math.round(approvalDelayMs / 60000),
      requiresReason: true,
    });
  }

  const previousStateSnapshot = {
    approvalStatus: existingRecord.approvalStatus,
    approvedBy:     existingRecord.approvedBy,
    approvedAt:     existingRecord.approvedAt,
  };

  existingRecord.approvalStatus     = STAFF_ATTENDANCE_STATUS.APPROVED;
  existingRecord.approvedBy         = requestingActor._id;
  existingRecord.approvedAt         = nowTimestamp;
  existingRecord.approvalDelayMs    = approvalDelayMs;
  if (isLateApproval && lateApprovalReason?.trim()) {
    existingRecord.lateApprovalReason = lateApprovalReason.trim();
  }
  await existingRecord.save();

  await AuditLog.create({
    actorId:          requestingActor._id,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           isLateApproval ? 'STAFF_ATTENDANCE_LATE_APPROVED' : 'STAFF_ATTENDANCE_APPROVED',
    targetModel:      'StaffAttendanceRecord',
    targetId:         existingRecord._id,
    targetName:       `Staff Attendance Approved`,
    schoolId:         existingRecord.schoolId,
    previousState:    previousStateSnapshot,
    newState: {
      approvalStatus:     STAFF_ATTENDANCE_STATUS.APPROVED,
      approvedBy:         requestingActor._id,
      approvedAt:         nowTimestamp,
      approvalDelayMs,
      approvalDelayMinutes: Math.round(approvalDelayMs / 60000),
      isLateApproval,
      lateApprovalReason: isLateApproval ? (lateApprovalReason?.trim() || '') : undefined,
    },
    result:     'SUCCESS',
    reason:     isLateApproval ? (lateApprovalReason?.trim() || '') : 'Within 5-minute relaxation window',
    ipAddress:  request.ip || '',
    userAgent:  request.get?.('user-agent') || '',
  });

  // Notify staff member of attendance approval
  try {
    const attendanceDateStr = existingRecord.attendanceDate
      ? new Date(existingRecord.attendanceDate).toISOString().split('T')[0]
      : 'today';

    await dispatchNotificationEvent({
      eventType: 'STAFF_ATTENDANCE_APPROVED',
      category:  'ATTENDANCE',
      title:     'Staff Attendance Approved',
      message:   `Your attendance for ${attendanceDateStr} has been approved by ${requestingActor.fullName}.`,
      actionLink: '/staff-attendance/my-record',
      rawMetadata: {
        staffId:        String(existingRecord.staffUserId),
        staffName:      requestingActor.fullName,
        designation:    requestingActor.designation || '',
        schoolName:     '',
        attendanceDate: attendanceDateStr,
        recordId:       String(existingRecord._id),
        status:         STAFF_ATTENDANCE_STATUS.APPROVED,
      },
      recipientUserIds: [String(existingRecord.staffUserId)],
    });
  } catch (notificationError) {
    logger.warn(`[StaffAttendanceController] Approval notification failed: ${notificationError.message}`);
  }

  return response.status(200).json({
    success: true,
    message: isLateApproval
      ? `Staff attendance approved (${Math.round(approvalDelayMs / 60000)} minute delay recorded).`
      : 'Staff attendance approved.',
    attendanceRecord: {
      _id:              existingRecord._id,
      approvalStatus:   STAFF_ATTENDANCE_STATUS.APPROVED,
      approvedBy:       requestingActor._id,
      approvedAt:       nowTimestamp,
      approvalDelayMs,
      approvalDelayMinutes: Math.round(approvalDelayMs / 60000),
      isLateApproval,
    },
  });
};

// ─── POST /api/v1/staff-attendance/:id/reject ────────────────────────────────
/**
 * HM or Admin rejects a pending staff attendance record.
 * Rejection reason is ALWAYS mandatory (regardless of time elapsed).
 */
export const handleRejectStaffAttendance = async (request, response) => {
  const requestingActor = request.user;
  const { id: recordId } = request.params;
  const rejectionReason = request.body.rejectionReason || request.body.reason;

  if (!mongoose.Types.ObjectId.isValid(recordId)) {
    return response.status(400).json({ success: false, message: 'Invalid attendance record ID.' });
  }

  if (!rejectionReason?.trim() || rejectionReason.trim().length < 5) {
    return response.status(400).json({
      success: false,
      message: 'Rejection reason is mandatory and must be at least 5 characters.',
    });
  }

  const existingRecord = await StaffAttendanceRecord.findById(recordId);
  if (!existingRecord) {
    return response.status(404).json({ success: false, message: 'Staff attendance record not found.' });
  }

  if (existingRecord.approvalStatus !== STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL) {
    return response.status(409).json({
      success: false,
      message: `Record is already ${existingRecord.approvalStatus}.`,
    });
  }

  // Authorization (same rules as approve)
  const targetStaffId   = String(existingRecord.staffUserId);
  const targetStaffRole = existingRecord.staffRole;
  const actorRole       = requestingActor.role;
  const actorSchoolId   = String(requestingActor.schoolId || '');
  const recordSchoolId  = String(existingRecord.schoolId || '');

  // Self-action is prohibited
  if (String(requestingActor._id) === targetStaffId) {
    return response.status(403).json({
      success: false,
      message: 'Self-rejection of staff attendance is prohibited. Decision must be made by an authorized authority.',
    });
  }

  let rejectionAuthorized = false;

  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actorRole)) {
    rejectionAuthorized = true;
  } else if (actorRole === ROLES.ADMIN) {
    if (targetStaffRole !== ROLES.ADMIN) {
      rejectionAuthorized = true;
    }
  } else if (actorRole === ROLES.HM) {
    if (existingRecord.staffCategory === STAFF_CATEGORY.SCHOOL_STAFF && actorSchoolId === recordSchoolId && targetStaffRole !== ROLES.ADMIN) {
      rejectionAuthorized = true;
    }
  }

  if (!rejectionAuthorized) {
    return response.status(403).json({
      success: false,
      message: 'You are not authorized to reject this attendance record.',
    });
  }

  const previousStateSnapshot = { approvalStatus: existingRecord.approvalStatus };
  const nowTimestamp = new Date();

  existingRecord.approvalStatus   = STAFF_ATTENDANCE_STATUS.REJECTED;
  existingRecord.rejectedBy       = requestingActor._id;
  existingRecord.rejectedAt       = nowTimestamp;
  existingRecord.rejectionReason  = rejectionReason.trim();
  await existingRecord.save();

  await AuditLog.create({
    actorId:          requestingActor._id,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'STAFF_ATTENDANCE_REJECTED',
    targetModel:      'StaffAttendanceRecord',
    targetId:         existingRecord._id,
    schoolId:         existingRecord.schoolId,
    previousState:    previousStateSnapshot,
    newState:         { approvalStatus: STAFF_ATTENDANCE_STATUS.REJECTED, rejectedBy: requestingActor._id, rejectedAt: nowTimestamp, rejectionReason: rejectionReason.trim() },
    result:           'SUCCESS',
    reason:           rejectionReason.trim(),
    ipAddress:        request.ip || '',
    userAgent:        request.get?.('user-agent') || '',
  });

  // Notify staff member of attendance rejection
  try {
    const attendanceDateStr = existingRecord.attendanceDate
      ? new Date(existingRecord.attendanceDate).toISOString().split('T')[0]
      : 'today';

    await dispatchNotificationEvent({
      eventType: 'STAFF_ATTENDANCE_REJECTED',
      category:  'ATTENDANCE',
      title:     'Staff Attendance Rejected',
      message:   `Your attendance for ${attendanceDateStr} was rejected by ${requestingActor.fullName}. Reason: ${rejectionReason.trim()}`,
      actionLink: '/staff-attendance/my-record',
      rawMetadata: {
        staffId:         String(existingRecord.staffUserId),
        staffName:       requestingActor.fullName,
        designation:     requestingActor.designation || '',
        schoolName:      '',
        attendanceDate:  attendanceDateStr,
        recordId:        String(existingRecord._id),
        status:          STAFF_ATTENDANCE_STATUS.REJECTED,
        rejectionReason: rejectionReason.trim(),
      },
      recipientUserIds: [String(existingRecord.staffUserId)],
    });
  } catch (notificationError) {
    logger.warn(`[StaffAttendanceController] Rejection notification failed: ${notificationError.message}`);
  }

  return response.status(200).json({
    success: true,
    message: 'Staff attendance rejected.',
    attendanceRecord: {
      _id:             existingRecord._id,
      approvalStatus:  STAFF_ATTENDANCE_STATUS.REJECTED,
      rejectedAt:      nowTimestamp,
      rejectionReason: rejectionReason.trim(),
    },
  });
};

// ─── GET /api/v1/staff-attendance/pending ────────────────────────────────────
export const handleGetPendingStaffAttendance = async (request, response) => {
  const requestingActor = request.user;
  const { date, page = 1, limit = 20 } = request.query;

  const queryFilter = { approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL };

  if (requestingActor.role === ROLES.HM) {
    if (!requestingActor.schoolId) {
      return response.status(403).json({ success: false, message: 'HM must have an assigned school.' });
    }
    queryFilter.schoolId      = requestingActor.schoolId;
    queryFilter.staffCategory = STAFF_CATEGORY.SCHOOL_STAFF;
  }

  if (date) {
    try {
      queryFilter.attendanceDate = parsePktDateString(date);
    } catch (_) {
      return response.status(400).json({ success: false, message: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  const pageNumber  = Math.max(1, Number(page));
  const limitNumber = Math.min(50, Math.max(1, Number(limit)));
  const nowMs = Date.now();

  const [records, totalCount] = await Promise.all([
    StaffAttendanceRecord.find(queryFilter)
      .populate('staffUserId', 'fullName designation role staffCategory')
      .sort({ submittedAt: 1 })
      .skip((pageNumber - 1) * limitNumber)
      .limit(limitNumber)
      .lean(),
    StaffAttendanceRecord.countDocuments(queryFilter),
  ]);

  // Annotate each record with pending duration and whether late approval reason is now required
  const annotatedRecords = records.map((record) => {
    const pendingDurationMs = nowMs - new Date(record.submittedAt).getTime();
    return {
      ...record,
      pendingDurationMs,
      pendingDurationMinutes:  Math.round(pendingDurationMs / 60000),
      lateApprovalReasonRequired: pendingDurationMs > FIVE_MINUTES_MS,
    };
  });

  return response.status(200).json({
    success: true,
    count:   annotatedRecords.length,
    total:   totalCount,
    page:    pageNumber,
    records: annotatedRecords,
  });
};

// ─── GET /api/v1/staff-attendance/my-history ─────────────────────────────────
export const handleGetMyStaffAttendanceHistory = async (request, response) => {
  const requestingActor = request.user;
  const { month, year, page = 1, limit = 31 } = request.query;

  const queryFilter = { staffUserId: requestingActor._id };
  if (month && year) {
    const startOfMonth = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    const endOfMonth   = new Date(Date.UTC(Number(year), Number(month), 0));
    queryFilter.attendanceDate = { $gte: startOfMonth, $lte: endOfMonth };
  }

  const pageNumber  = Math.max(1, Number(page));
  const limitNumber = Math.min(62, Math.max(1, Number(limit)));

  const records = await StaffAttendanceRecord.find(queryFilter)
    .populate('approvedBy', 'fullName designation role')
    .populate('rejectedBy', 'fullName designation role')
    .populate('markedBy', 'fullName designation role')
    .sort({ attendanceDate: -1 })
    .skip((pageNumber - 1) * limitNumber)
    .limit(limitNumber)
    .lean();

  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let pendingCount = 0;

  for (const record of records) {
    if (record.approvalStatus === STAFF_ATTENDANCE_STATUS.APPROVED) {
      if (record.approvalDelayMs && record.approvalDelayMs > FIVE_MINUTES_MS) {
        lateCount += 1;
      }
      presentCount += 1;
    } else if (record.approvalStatus === STAFF_ATTENDANCE_STATUS.REJECTED) {
      absentCount += 1;
    } else if (record.approvalStatus === STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL) {
      pendingCount += 1;
    }
  }

  const totalMarkedDays = records.length;
  const attendancePercentage = totalMarkedDays > 0
    ? Number(((presentCount / totalMarkedDays) * 100).toFixed(1))
    : 0;

  return response.status(200).json({
    success: true,
    count:   records.length,
    records,
    summary: {
      totalMarkedDays,
      presentCount,
      lateCount,
      absentCount,
      pendingCount,
      attendancePercentage,
    },
  });
};

// ─── POST /api/v1/staff-attendance/office-mark ───────────────────────────────
/**
 * Super Admin (or Root Admin) marks attendance for office staff members from the administrative PC.
 * Fulfills transparency requirement: office staff cannot self-submit from home/mobile.
 */
export const handleSuperAdminMarkOfficeStaffAttendance = async (request, response) => {
  const requestingActor = request.user;

  if (![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role)) {
    return response.status(403).json({
      success: false,
      message: 'Only Super Admin or Root Admin can mark office staff attendance.',
    });
  }

  const { staffUserId, attendanceDate: attendanceDateString, status = ATTENDANCE_STATUS.PRESENT, remarks = '' } = request.body;

  if (!staffUserId || !mongoose.Types.ObjectId.isValid(staffUserId)) {
    return response.status(400).json({ success: false, message: 'A valid staffUserId is required.' });
  }

  if (!attendanceDateString) {
    return response.status(400).json({ success: false, message: 'attendanceDate is required (YYYY-MM-DD).' });
  }

  let attendanceDate;
  try {
    attendanceDate = parsePktDateString(attendanceDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  const targetStaffUser = await User.findById(staffUserId).lean();
  if (!targetStaffUser) {
    return response.status(404).json({ success: false, message: 'Staff user not found.' });
  }

  // Ensure target is office staff (cannot use office terminal to mark school teachers)
  const isOfficeStaff = targetStaffUser.staffCategory === STAFF_CATEGORY.OFFICE_STAFF ||
    (!targetStaffUser.schoolId && [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(targetStaffUser.role));

  if (!isOfficeStaff && targetStaffUser.role === ROLES.TEACHER) {
    return response.status(400).json({
      success: false,
      message: 'School teachers must mark attendance at their assigned school, not the office terminal.',
    });
  }

  // ─── LEAVE & Status Validation ─────────────────────────────────────────────
  // Only PRESENT and ABSENT are permissible terminal-marked statuses.
  // LEAVE cannot be arbitrarily marked on the terminal without an approved leave record.
  if (status === ATTENDANCE_STATUS.LEAVE || status === 'LEAVE') {
    const approvedLeave = await LeaveRequest.findOne({
      staffUserId: targetStaffUser._id,
      status: LEAVE_STATUS.APPROVED,
      startDate: { $lte: attendanceDate },
      endDate: { $gte: attendanceDate },
    }).lean();

    if (!approvedLeave) {
      return response.status(400).json({
        success: false,
        message: `Cannot mark LEAVE from terminal: No approved leave record found for ${targetStaffUser.fullName} on ${attendanceDateString}. Leave must be applied and approved through official leave channels.`,
      });
    }

    return response.status(400).json({
      success: false,
      message: `Employee ${targetStaffUser.fullName} already has an approved ${approvedLeave.leaveType} for ${attendanceDateString}. Terminal attendance cannot be marked for approved leave days.`,
    });
  }

  const allowedStatuses = [ATTENDANCE_STATUS.PRESENT, ATTENDANCE_STATUS.ABSENT];
  if (!allowedStatuses.includes(status)) {
    return response.status(400).json({
      success: false,
      message: `Invalid attendance status "${status}". The office terminal only supports marking PRESENT or ABSENT.`,
    });
  }

  // Duplicate guard
  const existingRecord = await StaffAttendanceRecord.findOne({
    staffUserId: targetStaffUser._id,
    attendanceDate,
  }).lean();

  if (existingRecord) {
    return response.status(409).json({
      success: false,
      message: `Attendance already recorded for ${targetStaffUser.fullName} on ${attendanceDateString}. Status: ${existingRecord.approvalStatus}.`,
      existingRecord: { _id: existingRecord._id, approvalStatus: existingRecord.approvalStatus },
    });
  }

  const nowTimestamp = new Date();
  const isAbsent = status === ATTENDANCE_STATUS.ABSENT;
  const approvalStatus = isAbsent ? STAFF_ATTENDANCE_STATUS.REJECTED : STAFF_ATTENDANCE_STATUS.APPROVED;

  let newRecord;
  try {
    newRecord = await StaffAttendanceRecord.create({
      schoolId:               null,
      townId:                 targetStaffUser.townId || requestingActor.townId,
      staffUserId:            targetStaffUser._id,
      staffRole:              targetStaffUser.role,
      staffCategory:          STAFF_CATEGORY.OFFICE_STAFF,
      attendanceDate,
      submittedAt:            nowTimestamp,
      approvedAt:             nowTimestamp,
      approvedBy:             requestingActor._id,
      rejectedAt:             isAbsent ? nowTimestamp : undefined,
      rejectedBy:             isAbsent ? requestingActor._id : undefined,
      rejectionReason:        isAbsent ? (remarks.trim() || 'Marked Absent by Super Admin') : undefined,
      approvalStatus,
      isHmSelfRecord:         false,
      isSuperAdminSelfRecord: false,
      entryMode:              'SUPER_ADMIN_PANEL',
      markedBy:               requestingActor._id,
      remarks:                remarks.trim(),
    });
  } catch (createError) {
    if (createError.code === 11000 || createError.message?.includes('E11000')) {
      return response.status(409).json({
        success: false,
        message: `Attendance already recorded for ${targetStaffUser.fullName} on ${attendanceDateString}.`,
      });
    }
    throw createError;
  }

  await AuditLog.create({
    actorId:          requestingActor._id,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'OFFICE_STAFF_ATTENDANCE_MARKED',
    targetModel:      'StaffAttendanceRecord',
    targetId:         newRecord._id,
    targetName:       `Office Attendance - ${targetStaffUser.fullName} (${attendanceDateString})`,
    townId:           targetStaffUser.townId || requestingActor.townId,
    previousState:    null,
    newState: {
      staffUserId:    targetStaffUser._id,
      staffName:      targetStaffUser.fullName,
      attendanceDate: attendanceDateString,
      approvalStatus,
      status,
      markedBy:       requestingActor._id,
      entryMode:      'SUPER_ADMIN_PANEL',
    },
    result:    'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.get?.('user-agent') || '',
  });

  try {
    await dispatchNotificationEvent({
      eventType: isAbsent ? 'STAFF_ATTENDANCE_REJECTED' : 'STAFF_ATTENDANCE_APPROVED',
      category:  'ATTENDANCE',
      title:     `Office Attendance Recorded — ${status}`,
      message:   `Your attendance for ${attendanceDateString} was marked as ${status} by Super Admin (${requestingActor.fullName}).`,
      actionLink: '/staff-attendance/my-record',
      rawMetadata: {
        staffId:        String(targetStaffUser._id),
        markedBy:       requestingActor.fullName,
        attendanceDate: attendanceDateString,
        status,
      },
      recipientUserIds: [String(targetStaffUser._id)],
    });
  } catch (notificationError) {
    logger.warn(`[StaffAttendanceController] Notification failed: ${notificationError.message}`);
  }

  return response.status(201).json({
    success: true,
    message: `Office staff attendance recorded for ${targetStaffUser.fullName} as ${status}.`,
    attendanceRecord: {
      _id:            newRecord._id,
      staffUserId:    targetStaffUser._id,
      staffName:      targetStaffUser.fullName,
      attendanceDate: attendanceDateString,
      approvalStatus,
      submittedAt:    nowTimestamp,
      approvedAt:     nowTimestamp,
      markedBy:       requestingActor._id,
      entryMode:      'SUPER_ADMIN_PANEL',
    },
  });
};

// ─── POST /api/v1/staff-attendance/super-admin-self ──────────────────────────
/**
 * Super Admin marks their own daily attendance directly (self-effective).
 */
export const handleSuperAdminSelfAttendance = async (request, response) => {
  const requestingActor = request.user;

  if (![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role)) {
    return response.status(403).json({
      success: false,
      message: 'Only Super Admin or Root Admin can use the super-admin self-attendance endpoint.',
    });
  }

  const { attendanceDate: attendanceDateString } = request.body;
  if (!attendanceDateString) {
    return response.status(400).json({
      success: false,
      message: 'attendanceDate is required (YYYY-MM-DD).',
    });
  }

  let attendanceDate;
  try {
    attendanceDate = parsePktDateString(attendanceDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  const existingRecord = await StaffAttendanceRecord.findOne({
    staffUserId: requestingActor._id,
    attendanceDate,
  }).lean();

  if (existingRecord) {
    return response.status(409).json({
      success: false,
      message: `Attendance already recorded for ${attendanceDateString}.`,
      existingRecord: { _id: existingRecord._id, approvalStatus: existingRecord.approvalStatus },
    });
  }

  const nowTimestamp = new Date();
  let newRecord;
  try {
    newRecord = await StaffAttendanceRecord.create({
      schoolId:               null,
      townId:                 requestingActor.townId,
      staffUserId:            requestingActor._id,
      staffRole:              requestingActor.role,
      staffCategory:          STAFF_CATEGORY.OFFICE_STAFF,
      attendanceDate,
      submittedAt:            nowTimestamp,
      approvedAt:             nowTimestamp,
      approvedBy:             requestingActor._id,
      approvalStatus:         STAFF_ATTENDANCE_STATUS.APPROVED,
      isHmSelfRecord:         false,
      isSuperAdminSelfRecord: true,
      entryMode:              'SUPER_ADMIN_PANEL',
      markedBy:               requestingActor._id,
    });
  } catch (createError) {
    if (createError.code === 11000 || createError.message?.includes('E11000')) {
      return response.status(409).json({
        success: false,
        message: `Attendance already recorded for ${attendanceDateString}.`,
      });
    }
    throw createError;
  }

  await AuditLog.create({
    actorId:          requestingActor._id,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName:        requestingActor.fullName || '',
    action:           'SUPER_ADMIN_SELF_ATTENDANCE_MARKED',
    targetModel:      'StaffAttendanceRecord',
    targetId:         newRecord._id,
    targetName:       `Super Admin Self Attendance - ${attendanceDateString}`,
    townId:           requestingActor.townId,
    previousState:    null,
    newState:         { attendanceDate: attendanceDateString, status: STAFF_ATTENDANCE_STATUS.APPROVED, isSuperAdminSelfRecord: true },
    result:           'SUCCESS',
    ipAddress:        request.ip || '',
    userAgent:        request.get?.('user-agent') || '',
  });

  return response.status(201).json({
    success: true,
    message: 'Super Admin attendance recorded and self-approved.',
    attendanceRecord: {
      _id:                    newRecord._id,
      attendanceDate:         attendanceDateString,
      approvalStatus:         STAFF_ATTENDANCE_STATUS.APPROVED,
      isSuperAdminSelfRecord: true,
      submittedAt:            nowTimestamp,
      approvedAt:             nowTimestamp,
    },
  });
};

// ─── GET /api/v1/staff-attendance/office-roster ──────────────────────────────
/**
 * Roster of all active office staff members with their attendance state for a given date.
 */
export const handleGetOfficeStaffAttendanceRoster = async (request, response) => {
  const requestingActor = request.user;

  if (![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(requestingActor.role)) {
    return response.status(403).json({
      success: false,
      message: 'You are not authorized to view the office staff attendance roster.',
    });
  }

  const { date } = request.query;
  const targetDateString = date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

  let targetDate;
  try {
    targetDate = parsePktDateString(targetDateString);
  } catch (dateParseError) {
    return response.status(400).json({ success: false, message: dateParseError.message });
  }

  // Active office staff
  const userQueryFilter = {
    status: 'ACTIVE',
    $or: [
      { staffCategory: STAFF_CATEGORY.OFFICE_STAFF },
      { schoolId: null, role: { $in: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN] } },
    ],
  };

  if (requestingActor.role === ROLES.ADMIN && requestingActor.townId) {
    userQueryFilter.townId = requestingActor.townId;
  }

  const officeStaffUsers = await User.find(userQueryFilter)
    .select('_id fullName email phoneNumber designation role staffCategory townId')
    .sort({ fullName: 1 })
    .lean();

  const staffUserIds = officeStaffUsers.map((userItem) => userItem._id);

  const [existingRecords, approvedLeaves] = await Promise.all([
    StaffAttendanceRecord.find({
      staffUserId:    { $in: staffUserIds },
      attendanceDate: targetDate,
    })
      .populate('approvedBy', 'fullName designation role')
      .populate('markedBy', 'fullName designation role')
      .lean(),
    LeaveRequest.find({
      staffUserId: { $in: staffUserIds },
      status:      LEAVE_STATUS.APPROVED,
      startDate:   { $lte: targetDate },
      endDate:     { $gte: targetDate },
    }).lean(),
  ]);

  const recordsByUserIdMap = new Map();
  for (const recordItem of existingRecords) {
    recordsByUserIdMap.set(String(recordItem.staffUserId), recordItem);
  }

  const approvedLeavesByUserIdMap = new Map();
  for (const leaveItem of approvedLeaves) {
    approvedLeavesByUserIdMap.set(String(leaveItem.staffUserId), leaveItem);
  }

  let markedCount = 0;
  let presentCount = 0;
  let absentCount = 0;

  const roster = officeStaffUsers.map((staffUser) => {
    const staffUserIdString = String(staffUser._id);
    const attendanceRecord = recordsByUserIdMap.get(staffUserIdString);
    const approvedLeave = approvedLeavesByUserIdMap.get(staffUserIdString);

    if (attendanceRecord) {
      markedCount += 1;
      if (attendanceRecord.approvalStatus === STAFF_ATTENDANCE_STATUS.APPROVED) {
        presentCount += 1;
      } else if (attendanceRecord.approvalStatus === STAFF_ATTENDANCE_STATUS.REJECTED) {
        absentCount += 1;
      }
    }

    return {
      _id:            staffUser._id,
      fullName:       staffUser.fullName,
      email:          staffUser.email,
      phoneNumber:    staffUser.phoneNumber || '',
      designation:    staffUser.designation || 'Office Staff',
      role:           staffUser.role,
      staffCategory:  staffUser.staffCategory || STAFF_CATEGORY.OFFICE_STAFF,
      isMarked:       Boolean(attendanceRecord),
      isOnLeave:      Boolean(approvedLeave),
      leaveDetails:   approvedLeave ? {
        leaveType: approvedLeave.leaveType,
        startDate: approvedLeave.startDate,
        endDate: approvedLeave.endDate,
      } : null,
      attendance:     attendanceRecord ? {
        _id:            attendanceRecord._id,
        approvalStatus: attendanceRecord.approvalStatus,
        submittedAt:    attendanceRecord.submittedAt,
        approvedAt:     attendanceRecord.approvedAt,
        approvedBy:     attendanceRecord.approvedBy,
        markedBy:       attendanceRecord.markedBy,
        entryMode:      attendanceRecord.entryMode,
        remarks:        attendanceRecord.remarks || attendanceRecord.rejectionReason || '',
      } : null,
    };
  });

  return response.status(200).json({
    success: true,
    date:    targetDateString,
    summary: {
      totalStaff:    roster.length,
      markedCount,
      presentCount,
      absentCount,
      onLeaveCount:  approvedLeaves.length,
      unmarkedCount: roster.length - markedCount,
    },
    roster,
  });
};

// ─── GET /api/v1/staff-attendance/records ────────────────────────────────────
/**
 * Scoped query endpoint for staff attendance records with status, date, and pagination filters.
 */
export const handleGetStaffAttendanceRecords = async (request, response) => {
  const requestingActor = request.user;
  const { date, status, staffCategory, page = 1, limit = 25, schoolId } = request.query;

  const queryFilter = {};

  if (requestingActor.role === ROLES.HM) {
    if (!requestingActor.schoolId) {
      return response.status(403).json({ success: false, message: 'HM must have an assigned school.' });
    }
    queryFilter.schoolId = requestingActor.schoolId;
    queryFilter.staffCategory = STAFF_CATEGORY.SCHOOL_STAFF;
  } else if (requestingActor.role === ROLES.ADMIN) {
    if (requestingActor.townId) {
      queryFilter.townId = requestingActor.townId;
    }
    if (schoolId) {
      queryFilter.schoolId = schoolId;
    }
  } else if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role)) {
    if (schoolId) queryFilter.schoolId = schoolId;
  } else {
    return response.status(403).json({ success: false, message: 'You are not authorized to view staff attendance records.' });
  }

  if (status && status !== 'ALL') {
    queryFilter.approvalStatus = status;
  }

  if (staffCategory) {
    queryFilter.staffCategory = staffCategory;
  }

  if (date) {
    try {
      queryFilter.attendanceDate = parsePktDateString(date);
    } catch (_) {
      return response.status(400).json({ success: false, message: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  const pageNumber  = Math.max(1, Number(page));
  const limitNumber = Math.min(100, Math.max(1, Number(limit)));

  const [records, totalCount] = await Promise.all([
    StaffAttendanceRecord.find(queryFilter)
      .populate('staffUserId', 'fullName designation role staffCategory email')
      .populate('approvedBy', 'fullName designation role')
      .populate('rejectedBy', 'fullName designation role')
      .populate('markedBy', 'fullName designation role')
      .sort({ attendanceDate: -1, submittedAt: -1 })
      .skip((pageNumber - 1) * limitNumber)
      .limit(limitNumber)
      .lean(),
    StaffAttendanceRecord.countDocuments(queryFilter),
  ]);

  return response.status(200).json({
    success: true,
    count:   records.length,
    total:   totalCount,
    page:    pageNumber,
    records,
  });
};

