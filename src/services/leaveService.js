/**
 * Leave Management Service
 * Education Department Liaquatabad Town Centre (DMC)
 */

import crypto from 'crypto';
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
} from '../../config/constants.js';
import logger from '../../config/logger.js';
import { dispatchNotificationEvent } from './notificationDispatcher.js';

const PKT_TIMEZONE = 'Asia/Karachi';

export const getCurrentPktDateString = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: PKT_TIMEZONE });

export const parsePktDateString = (dateString) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString))
    throw new Error(`Invalid date format: ${dateString}. Expected YYYY-MM-DD.`);
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const getPktYearFromDate = (utcDate) =>
  Number(utcDate.toLocaleDateString('en-CA', { timeZone: PKT_TIMEZONE }).split('-')[0]);

export const calculateInclusiveDurationDays = (startUtcDate, endUtcDate) => {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((endUtcDate - startUtcDate) / msPerDay) + 1;
};

export const calculateApprovedClDaysUsed = async (staffUserId, year) => {
  const approvedClRecords = await LeaveRequest.find({
    staffUserId,
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    leaveYear: year,
    status: LEAVE_STATUS.APPROVED,
  }).select('durationDays').lean();
  return approvedClRecords.reduce((total, record) => total + (record.durationDays || 0), 0);
};

export const getRemainingClBalance = async (staffUserId, year) => {
  const usedDays = await calculateApprovedClDaysUsed(staffUserId, year);
  return Math.max(0, CL_POLICY.ANNUAL_ENTITLEMENT_DAYS - usedDays);
};

export const findOverlappingLeaveRequest = async (
  staffUserId, leaveType, startDate, endDate, excludeRequestId = null
) => {
  const overlappingQuery = {
    staffUserId,
    leaveType,
    status: { $in: [LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  };
  if (excludeRequestId) overlappingQuery._id = { $ne: excludeRequestId };
  return LeaveRequest.findOne(overlappingQuery).lean();
};

export const validateEarnedLeaveDuration = (startDate, endDate) => {
  if (endDate < startDate)
    return { valid: false, durationDays: 0, error: 'EL end date must be on or after start date.' };
  const durationDays = calculateInclusiveDurationDays(startDate, endDate);
  if (durationDays < EL_POLICY.MINIMUM_DURATION_CALENDAR_DAYS) {
    return {
      valid: false,
      durationDays,
      error: `EL minimum duration is ${EL_POLICY.MINIMUM_DURATION_CALENDAR_DAYS} consecutive calendar days. Requested: ${durationDays} day(s).`,
    };
  }
  return { valid: true, durationDays };
};

export const generateLeaveRequestFingerprint = (staffUserId, leaveType, startDate, endDate) => {
  const fingerprintInput = `${staffUserId}|${leaveType}|${startDate.toISOString()}|${endDate.toISOString()}`;
  return crypto.createHash('sha256').update(fingerprintInput).digest('hex');
};

export const resolveLeaveApprovalAuthority = (requestingActor, leaveRecord, actionType = 'APPROVE') => {
  const actorRole = requestingActor.role;
  const actorSchoolId = String(requestingActor.schoolId || '');
  const leaveSchoolId = String(leaveRecord.schoolId || '');
  const leaveStaffRole = leaveRecord.staffRole;
  const leaveStaffUserId = leaveRecord.staffUserId
    ? String(leaveRecord.staffUserId._id || leaveRecord.staffUserId)
    : null;

  // Self-approval or self-rejection is strictly prohibited across all roles
  if (
    requestingActor._id &&
    leaveStaffUserId &&
    String(requestingActor._id) === leaveStaffUserId
  ) {
    return {
      authorized: false,
      reason: 'Self-approval of leave is strictly prohibited. An authorized superior authority must approve.',
    };
  }

  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actorRole)) return { authorized: true };

  if (leaveRecord.leaveType === LEAVE_TYPE.EARNED_LEAVE) {
    if (actorRole === ROLES.ADMIN) return { authorized: true };
    // HM may reject an EL request at the school gate before forwarding if staff cannot be spared
    if (actionType === 'REJECT' && actorRole === ROLES.HM) {
      if (actorSchoolId && actorSchoolId === leaveSchoolId) return { authorized: true };
      return { authorized: false, reason: 'HM can only reject EL for staff in their assigned school.' };
    }
    return { authorized: false, reason: 'EL approval requires Admin-level (or higher) authority. HM and Supervisor cannot approve EL.' };
  }

  if (leaveRecord.leaveType === LEAVE_TYPE.CASUAL_LEAVE) {
    if (actorRole === ROLES.ADMIN) return { authorized: true };

    if (leaveStaffRole === ROLES.HM) {
      if (actorRole === ROLES.SUPERVISOR) {
        const actorAssignedSchools = (requestingActor.assignedSchools || []).map(String);
        if (actorAssignedSchools.includes(leaveSchoolId)) return { authorized: true };
        return { authorized: false, reason: 'Supervisor can only approve CL for HMs in their assigned school cluster.' };
      }
      return { authorized: false, reason: `${actorRole} cannot approve HM Casual Leave. Only Supervisor or Admin-level authority can.` };
    }

    if (actorRole === ROLES.HM) {
      if (actorSchoolId && actorSchoolId === leaveSchoolId) return { authorized: true };
      return { authorized: false, reason: 'HM can only approve CL for staff in their assigned school.' };
    }

    return { authorized: false, reason: `${actorRole} does not have authority to approve Casual Leave.` };
  }

  return { authorized: false, reason: 'Unknown leave type.' };
};

export const resolveLeaveForwardAuthority = (requestingActor, leaveRecord) => {
  const actorRole = requestingActor.role;
  const actorSchoolId = String(requestingActor.schoolId || '');
  const leaveSchoolId = String(leaveRecord.schoolId || '');
  const leaveStaffUserId = leaveRecord.staffUserId
    ? String(leaveRecord.staffUserId._id || leaveRecord.staffUserId)
    : null;

  // Self-forwarding is strictly prohibited
  if (
    requestingActor._id &&
    leaveStaffUserId &&
    String(requestingActor._id) === leaveStaffUserId
  ) {
    return {
      authorized: false,
      reason: 'Self-forwarding of leave is strictly prohibited. An authorized Head Master must recommend and forward.',
    };
  }

  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(actorRole)) return { authorized: true };

  if (actorRole === ROLES.HM) {
    if (actorSchoolId && actorSchoolId === leaveSchoolId) return { authorized: true };
    return { authorized: false, reason: 'HM can only recommend and forward EL for staff in their assigned school.' };
  }

  if (actorRole === ROLES.SUPERVISOR) {
    const actorAssignedSchools = (requestingActor.assignedSchools || []).map(String);
    if (actorAssignedSchools.includes(leaveSchoolId)) return { authorized: true };
    return { authorized: false, reason: 'Supervisor can only forward EL for staff in their assigned school cluster.' };
  }

  return { authorized: false, reason: `${actorRole} does not have authority to recommend or forward Earned Leave.` };
};

export const performAnnualClReset = async (targetYear) => {
  const currentYear = getPktYearFromDate(new Date());
  if (targetYear !== currentYear)
    logger.warn(`[LeaveService] CL reset called with targetYear=${targetYear} but current PKT year=${currentYear}.`);

  const previousYearApprovedCount = await LeaveRequest.countDocuments({
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    leaveYear: targetYear - 1,
    status: LEAVE_STATUS.APPROVED,
  });

  logger.info(`[LeaveService] Annual CL reset executed for year ${targetYear}. Previous year (${targetYear - 1}) had ${previousYearApprovedCount} approved CL records (preserved).`);

  return {
    success: true,
    year: targetYear,
    previousYearApprovedRecordsPreserved: previousYearApprovedCount,
    message: `CL balance resets to ${CL_POLICY.ANNUAL_ENTITLEMENT_DAYS} days for calendar year ${targetYear}. All historical records preserved.`,
  };
};

export const processMidnightHmClTransition = async () => {
  // Compute yesterday's date authoritative in PKT
  const todayPktString = new Date().toLocaleDateString('en-CA', { timeZone: PKT_TIMEZONE });
  const todayStartUtc = parsePktDateString(todayPktString);
  const yesterdayStartUtc = new Date(todayStartUtc.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayPktString = yesterdayStartUtc.toLocaleDateString('en-CA', { timeZone: PKT_TIMEZONE });

  // Scan for any unapproved HM CL requests up to and including yesterday
  const pendingHmClRequests = await LeaveRequest.find({
    leaveType: LEAVE_TYPE.CASUAL_LEAVE,
    status: LEAVE_STATUS.PENDING,
    staffRole: ROLES.HM,
    startDate: { $lte: yesterdayStartUtc },
  }).lean();

  let processedCount = 0;
  let errorCount = 0;

  for (const pendingRequest of pendingHmClRequests) {
    try {
      const requestDatePkt = pendingRequest.startDate
        ? new Date(pendingRequest.startDate).toLocaleDateString('en-CA', { timeZone: PKT_TIMEZONE })
        : yesterdayPktString;

      // 1. Atomic transition concurrency lock: only ONE concurrent worker can acquire this request
      const transitionedRequest = await LeaveRequest.findOneAndUpdate(
        { _id: pendingRequest._id, status: LEAVE_STATUS.PENDING },
        {
          $set: {
            status: LEAVE_STATUS.SUPERSEDED,
            decisionReason: `Auto-superseded at midnight PKT: CL not approved before date rollover. HM attendance defaulted to ABSENT for ${requestDatePkt}.`,
          },
        },
        { new: true }
      );

      // If another concurrent worker already transitioned this request, skip cleanly
      if (!transitionedRequest) {
        continue;
      }

      // 2. Multi-day range expansion: process every elapsed day strictly on its own Asia/Karachi business date
      const startTimestamp = new Date(pendingRequest.startDate).getTime();
      const endBoundTimestamp = Math.min(
        new Date(pendingRequest.endDate || pendingRequest.startDate).getTime(),
        yesterdayStartUtc.getTime()
      );
      const oneDayMs = 24 * 60 * 60 * 1000;

      for (let currentMs = startTimestamp; currentMs <= endBoundTimestamp; currentMs += oneDayMs) {
        const currentDayUtc = new Date(currentMs);
        const currentDayPkt = currentDayUtc.toLocaleDateString('en-CA', { timeZone: PKT_TIMEZONE });

        // Upsert StaffAttendanceRecord with REJECTED / ABSENT state (idempotent, no duplicates)
        await StaffAttendanceRecord.findOneAndUpdate(
          {
            staffUserId: pendingRequest.staffUserId,
            attendanceDate: currentDayUtc,
          },
          {
            $setOnInsert: {
              schoolId: pendingRequest.schoolId,
              townId: pendingRequest.townId,
              staffUserId: pendingRequest.staffUserId,
              staffRole: pendingRequest.staffRole,
              staffCategory: pendingRequest.staffCategory || 'SCHOOL_STAFF',
              submittedAt: pendingRequest.submittedAt || new Date(),
              isHmSelfRecord: false,
            },
            $set: {
              approvalStatus: STAFF_ATTENDANCE_STATUS.REJECTED,
              rejectionReason: `Auto-defaulted to ABSENT at midnight PKT: Casual Leave was not approved by Supervisor/Admin before date rollover.`,
              rejectedAt: new Date(),
            },
            $push: {
              statusHistory: {
                event: 'AUTO_ABSENT_MIDNIGHT',
                previousStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
                newStatus: STAFF_ATTENDANCE_STATUS.REJECTED,
                changedBy: null,
                changedAt: new Date(),
                reason: `Auto-defaulted to ABSENT at midnight PKT for business date ${currentDayPkt}.`,
                snapshot: {
                  leaveRequestId: pendingRequest._id,
                  businessDate: currentDayPkt,
                },
              },
            },
          },
          { upsert: true, new: true }
        );
      }

      // 3. Emit immutable AuditLog for the automated system transition
      await AuditLog.create({
        actorRole: 'SYSTEM',
        actorName: 'System Scheduled Rollover',
        action: 'HM_CL_MIDNIGHT_SUPERSEDED_ABSENT',
        targetModel: 'LeaveRequest',
        targetId: pendingRequest._id,
        targetName: `HM CL Request - ${pendingRequest._id}`,
        schoolId: pendingRequest.schoolId,
        previousState: { status: LEAVE_STATUS.PENDING },
        newState: {
          status: LEAVE_STATUS.SUPERSEDED,
          attendanceResult: 'ABSENT',
          dateRollover: requestDatePkt,
        },
        result: 'SUCCESS',
        reason: `Auto-superseded at midnight PKT: unapproved HM CL defaulted to ABSENT for ${requestDatePkt}.`,
      });

      // Notify staff member that unapproved CL defaulted to absent per midnight policy
      try {
        await dispatchNotificationEvent({
          eventType: 'ATTENDANCE',
          category:  'ATTENDANCE',
          title:     'Attendance Recorded as Absent (Midnight Rollover)',
          message:   `Your unapproved CL for ${requestDatePkt} has transitioned to Absent per midnight cutoff policy. You may submit a late correction request if eligible.`,
          actionLink: '/leave/my-requests',
          rawMetadata: {
            staffId:        String(pendingRequest.staffUserId),
            staffName:      '',
            attendanceDate: requestDatePkt,
            status:         'ABSENT',
          },
          recipientUserIds: [String(pendingRequest.staffUserId)],
        });
      } catch (notificationError) {
        logger.warn(`[LeaveService Midnight] Notification dispatch failed: ${notificationError.message}`);
      }

      processedCount++;
      logger.info(`[LeaveService Midnight] HM CL ${pendingRequest._id} superseded for ${requestDatePkt} and ABSENT record(s) preserved.`);
    } catch (transitionError) {
      errorCount++;
      logger.error(`[LeaveService Midnight] Failed to supersede HM CL ${pendingRequest._id}: ${transitionError.message}`);
    }
  }

  return { processed: processedCount, errors: errorCount };
};
