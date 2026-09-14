import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import School from '../models/School.js';
import TransferRequest from '../models/TransferRequest.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import TeacherProfile from '../models/TeacherProfile.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, TRANSFER_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';

/**
 * POST /api/v1/transfers
 *
 * Initiates a teacher transfer within a fully atomic MongoDB transaction.
 *
 * TRANSACTION OPERATIONS (all-or-nothing):
 *   1. Validate transfer eligibility
 *   2. Create TransferRequest record
 *   3. Update User.schoolId → targetSchoolId
 *   4. Expire ALL old school ACTIVE TeachingAssignments → TRANSFERRED
 *   5. Update TeacherProfile.currentSchoolId + append transferHistory
 *   6. Write immutable AuditLog event
 *   COMMIT — or ROLLBACK everything on any failure
 *
 * IMPORTANT: New school teaching assignments are NOT auto-created.
 * The destination HM/authorized authority must assign the teacher to
 * their new classes, sections, and subjects after joining.
 */
export const handleInitiateTransfer = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const teacherUserId = request.body.teacherUserId || request.body.teacherId;
  const targetSchoolId = request.body.targetSchoolId || request.body.destinationSchoolId;
  const {
    reason,
    isEmergencyOverride,
    overrideJustification,
    officialOrderNumber,
  } = request.body;

  // ── Input validation ─────────────────────────────────────────────────────
  if (!teacherUserId || !/^[0-9a-fA-F]{24}$/.test(teacherUserId)) {
    return sendError(response, 400, 'A valid teacherUserId is required.');
  }
  if (!targetSchoolId || !/^[0-9a-fA-F]{24}$/.test(targetSchoolId)) {
    return sendError(response, 400, 'A valid targetSchoolId is required.');
  }
  if (!reason || reason.trim().length < 5) {
    return sendError(response, 400, 'A transfer reason of at least 5 characters is required.');
  }

  // ── Pre-transaction validation (read-only, no writes) ───────────────────
  const [targetTeacher, targetSchool] = await Promise.all([
    User.findById(teacherUserId).populate('schoolId', 'name townId _id'),
    School.findById(targetSchoolId).lean(),
  ]);

  if (!targetTeacher) {
    return sendError(response, 404, 'Teacher not found in personnel registry.');
  }
  if (targetTeacher.role !== ROLES.TEACHER) {
    return sendError(response, 400, `Only TEACHER role personnel can be transferred. Target role: ${targetTeacher.role}.`);
  }

  const sourceSchoolId = targetTeacher.schoolId?._id;
  if (!sourceSchoolId) {
    return sendError(response, 400, 'Teacher does not have a current school assignment. Assign a school first.');
  }
  if (String(sourceSchoolId) === String(targetSchoolId)) {
    return sendError(response, 400, 'Source and target school cannot be the same.');
  }
  if (!targetSchool) {
    return sendError(response, 404, 'Target school not found in municipal registry.');
  }

  // ── Jurisdictional check for ADMIN actors ─────────────────────────────
  if (requestingActor.role === ROLES.ADMIN) {
    const targetTownId = String(targetSchool.townId);
    const sourceTownId = String(targetTeacher.schoolId.townId);
    const actorTownId  = String(requestingActor.townId);

    if (targetTownId !== actorTownId || sourceTownId !== actorTownId) {
      await AuditLog.create({
        actorId:    requestingActor._id || requestingActor.userId,
        actorRole:  requestingActor.role,
        actorName:  requestingActor.fullName || '',
        action:     'ADMIN_CROSS_TOWN_TRANSFER_BLOCKED',
        targetModel: 'TransferRequest',
        targetId:   targetTeacher._id,
        targetName: targetTeacher.fullName,
        townId:     requestingActor.townId,
        previousState: { sourceTownId, targetTownId },
        result:     'DENIED',
        reason:     `ADMIN attempted cross-town transfer: source=${sourceTownId}, target=${targetTownId}, actor=${actorTownId}`,
        ipAddress:  request.ip || '',
        userAgent:  request.headers['user-agent'] || '',
        requestId:  '',
      });
      return sendError(response, 403, 'Access denied. ADMIN actors can only transfer teachers within their own town jurisdiction.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ATOMIC TRANSACTION — all-or-nothing
  // If any operation fails, everything is rolled back.
  // This prevents the dangerous partial state:
  //   User.schoolId = New School ✅  but  TeachingAssignments = Old School ❌
  // ═══════════════════════════════════════════════════════════════════════
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Create TransferRequest record
    const [transferRecord] = await TransferRequest.create(
      [{
        teacherUserId,
        fromSchoolId:         sourceSchoolId,
        toSchoolId:           targetSchoolId,
        initiatedBy:          requestingActor._id || requestingActor.userId,
        initiatorRole:        requestingActor.role,
        isEmergencyOverride:  isEmergencyOverride || false,
        overrideJustification: overrideJustification || '',
        reason:               reason.trim(),
        officialOrderNumber:  officialOrderNumber || '',
        status:               TRANSFER_STATUS.INITIATED,
      }],
      { session }
    );

    // 2. Update teacher's schoolId
    await User.findByIdAndUpdate(
      teacherUserId,
      { $set: { schoolId: targetSchoolId } },
      { session }
    );

    // 3. Expire ALL ACTIVE teaching assignments at the old school → TRANSFERRED
    //    Historical records are preserved; only status + effectiveTo change.
    //    New school assignments must be created by destination HM after joining.
    const expiredAssignmentsResult = await TeachingAssignment.updateMany(
      {
        teacherId: teacherUserId,
        schoolId:  sourceSchoolId,
        status:    TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      },
      {
        $set: {
          status:      TEACHING_ASSIGNMENT_STATUS.TRANSFERRED,
          effectiveTo: new Date(),
          remarks:     `Auto-expired on approved transfer to ${targetSchool.name}. Transfer ID: ${transferRecord._id}`,
        },
      },
      { session }
    );

    // 4. Sync TeacherProfile: update currentSchoolId + append transferHistory
    await TeacherProfile.findOneAndUpdate(
      { userId: teacherUserId },
      {
        $set: { currentSchoolId: targetSchoolId },
        $push: {
          transferHistory: {
            fromSchoolId:      sourceSchoolId,
            toSchoolId:        targetSchoolId,
            transferRequestId: transferRecord._id,
            relievedDate:      new Date(),
          },
        },
      },
      { session }
    );

    // 5. Write immutable audit log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           'TEACHER_TRANSFER_INITIATED',
        targetModel:      'User',
        targetId:         targetTeacher._id,
        targetName:       targetTeacher.fullName,
        townId:           requestingActor.townId || null,
        schoolId:         targetSchoolId,
        previousState: {
          schoolId:   String(sourceSchoolId),
          schoolName: targetTeacher.schoolId?.name || 'Previous School',
        },
        newState: {
          schoolId:              targetSchoolId,
          schoolName:            targetSchool.name,
          transferRequestId:     String(transferRecord._id),
          expiredAssignments:    expiredAssignmentsResult.modifiedCount,
        },
        result:    'SUCCESS',
        reason:    reason.trim(),
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        requestId: request.headers['x-request-id'] || '',
      }],
      { session }
    );

    // Commit all operations atomically
    await session.commitTransaction();
    session.endSession();

    // Dispatch notification to transferred teacher (governance event)
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: 'Faculty Transfer Order Issued',
      message: `You have been officially transferred to ${targetSchool.name}. Please report to your new institution.`,
      actionLink: '/transfers',
      rawMetadata: {
        transferRequestId: String(transferRecord._id),
        teacherName: targetTeacher.fullName,
        fromSchool: targetTeacher.schoolId?.name || String(sourceSchoolId),
        toSchool: targetSchool.name,
        orderNumber: officialOrderNumber || '',
      },
      recipientUserIds: [String(teacherUserId)],
    });

    return sendSuccess(
      response,
      201,
      `Teacher "${targetTeacher.fullName}" transferred to "${targetSchool.name}" successfully. ` +
      `${expiredAssignmentsResult.modifiedCount} teaching assignment(s) archived. ` +
      `Destination HM must assign new classes/sections/subjects.`,
      {
        transferRequest: {
          _id:                  transferRecord._id,
          status:               transferRecord.status,
          teacherName:          targetTeacher.fullName,
          fromSchool:           targetTeacher.schoolId?.name || String(sourceSchoolId),
          toSchool:             targetSchool.name,
          reason:               transferRecord.reason,
          expiredAssignments:   expiredAssignmentsResult.modifiedCount,
          createdAt:            transferRecord.createdAt,
        },
      }
    );

  } catch (transactionError) {
    // Rollback everything — no partial state persists
    await session.abortTransaction();
    session.endSession();

    // Log the failed attempt for audit trail
    await AuditLog.create({
      actorId:    requestingActor._id || requestingActor.userId,
      actorRole:  requestingActor.role,
      actorName:  requestingActor.fullName || '',
      action:     'TEACHER_TRANSFER_FAILED',
      targetModel: 'User',
      targetId:   targetTeacher._id,
      targetName: targetTeacher.fullName,
      result:     'FAILURE',
      reason:     `Transaction failed and was fully rolled back. Error: ${transactionError.message}`,
      ipAddress:  request.ip || '',
      userAgent:  request.headers['user-agent'] || '',
      requestId:  request.headers['x-request-id'] || '',
    }).catch(() => {}); // best-effort — don't mask original error

    return sendError(
      response,
      500,
      'Transfer failed. All database changes have been rolled back. No partial state was written. Please try again.'
    );
  }
});

/**
 * GET /api/v1/transfers
 * List transfer requests with filters: teacherUserId, status, schoolId, limit, skip
 */
export const handleGetTransfers = asyncHandler(async (request, response) => {
  const { teacherUserId, status, fromSchoolId, toSchoolId, limit = 50, skip = 0 } = request.query;

  const queryFilter = {};
  if (teacherUserId && /^[0-9a-fA-F]{24}$/.test(teacherUserId)) queryFilter.teacherUserId = teacherUserId;
  if (status)       queryFilter.status = status;
  if (fromSchoolId && /^[0-9a-fA-F]{24}$/.test(fromSchoolId)) queryFilter.fromSchoolId = fromSchoolId;
  if (toSchoolId   && /^[0-9a-fA-F]{24}$/.test(toSchoolId))   queryFilter.toSchoolId   = toSchoolId;

  const transfers = await TransferRequest.find(queryFilter)
    .populate('teacherUserId', 'fullName email designation')
    .populate('fromSchoolId',  'name schoolCode')
    .populate('toSchoolId',    'name schoolCode')
    .populate('initiatedBy',   'fullName role')
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .skip(Number(skip))
    .lean();

  const totalCount = await TransferRequest.countDocuments(queryFilter);

  return sendSuccess(response, 200, 'Transfer records retrieved successfully.', {
    transfers,
    total: totalCount,
  });
});

