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
    const initialStatus = isEmergencyOverride
      ? TRANSFER_STATUS.OVERRIDDEN_AND_TRANSFERRED
      : TRANSFER_STATUS.AWAITING_DESTINATION_HM;

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
        status:               initialStatus,
      }],
      { session }
    );

    let expiredAssignmentsCount = 0;

    // If emergency override, execute atomic reassignment immediately
    if (isEmergencyOverride) {
      // 2. Update teacher's schoolId
      await User.findByIdAndUpdate(
        teacherUserId,
        { $set: { schoolId: targetSchoolId } },
        { session }
      );

      // 3. Expire ALL ACTIVE teaching assignments at the old school → TRANSFERRED
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
            remarks:     `Auto-expired on emergency transfer to ${targetSchool.name}. Transfer ID: ${transferRecord._id}`,
          },
        },
        { session }
      );
      expiredAssignmentsCount = expiredAssignmentsResult.modifiedCount;

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
    }

    // 5. Write immutable audit log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           isEmergencyOverride ? 'TEACHER_TRANSFER_EMERGENCY_OVERRIDDEN' : 'TEACHER_TRANSFER_INITIATED',
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
          status:                initialStatus,
          expiredAssignments:    expiredAssignmentsCount,
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
      title: isEmergencyOverride ? 'Emergency Faculty Transfer Executed' : 'Faculty Transfer Order Issued',
      message: isEmergencyOverride
        ? `You have been immediately transferred to ${targetSchool.name} under administrative emergency override.`
        : `A transfer order to ${targetSchool.name} has been initiated. Awaiting Destination HM physical joining approval.`,
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
      isEmergencyOverride
        ? `Teacher "${targetTeacher.fullName}" transferred immediately to "${targetSchool.name}". ${expiredAssignmentsCount} assignment(s) archived.`
        : `Transfer order for "${targetTeacher.fullName}" issued successfully. Status: Awaiting Destination HM joining approval.`,
      {
        transferRequest: {
          _id:                  transferRecord._id,
          status:               transferRecord.status,
          teacherName:          targetTeacher.fullName,
          fromSchool:           targetTeacher.schoolId?.name || String(sourceSchoolId),
          toSchool:             targetSchool.name,
          reason:               transferRecord.reason,
          expiredAssignments:   expiredAssignmentsCount,
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
 * List transfer requests with filters: teacherUserId, status, fromSchoolId, toSchoolId, limit, skip
 * Strictly enforces school boundaries for HM actors.
 */
export const handleGetTransfers = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { teacherUserId, status, fromSchoolId, toSchoolId, limit = 50, skip = 0 } = request.query;

  const queryFilter = {};
  if (teacherUserId && /^[0-9a-fA-F]{24}$/.test(teacherUserId)) queryFilter.teacherUserId = teacherUserId;
  if (status)       queryFilter.status = status;
  if (fromSchoolId && /^[0-9a-fA-F]{24}$/.test(fromSchoolId)) queryFilter.fromSchoolId = fromSchoolId;
  if (toSchoolId   && /^[0-9a-fA-F]{24}$/.test(toSchoolId))   queryFilter.toSchoolId   = toSchoolId;

  // Server-Enforced HM School Jurisdiction Guard
  if (actor.role === ROLES.HM) {
    const actorSchoolId = actor.schoolId?._id || actor.schoolId;
    queryFilter.$or = [{ fromSchoolId: actorSchoolId }, { toSchoolId: actorSchoolId }];
  }

  const transfers = await TransferRequest.find(queryFilter)
    .populate('teacherUserId', 'fullName email designation')
    .populate('fromSchoolId',  'name schoolCode code')
    .populate('toSchoolId',    'name schoolCode code')
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

/**
 * PATCH /api/v1/transfers/:id/approve-joining
 * Destination Head Master (HM) certifies physical arrival and approves faculty joining.
 * Exact State Machine Check: only transfers in AWAITING_DESTINATION_HM can be approved.
 */
export const handleApproveJoining = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  const { joiningDate, remarks = '' } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }

  const transferRecord = await TransferRequest.findById(id)
    .populate('fromSchoolId', 'name schoolCode code')
    .populate('toSchoolId', 'name schoolCode code')
    .populate('teacherUserId', 'fullName email schoolId role');

  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // Exact State Machine Check (Guardrail 2)
  if (transferRecord.status !== TRANSFER_STATUS.AWAITING_DESTINATION_HM) {
    return sendError(
      response,
      400,
      `Transfer cannot be approved for joining. Current status is "${transferRecord.status}", required status is "${TRANSFER_STATUS.AWAITING_DESTINATION_HM}".`
    );
  }

  // Destination HM Boundary Check
  const destinationSchoolId = String(transferRecord.toSchoolId?._id || transferRecord.toSchoolId);
  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== destinationSchoolId) {
      return sendError(
        response,
        403,
        'Access denied. Only the Destination Head Master (HM) can approve faculty joining for this school.'
      );
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const effectiveJoiningDate = joiningDate ? new Date(joiningDate) : new Date();

    // 1. Atomically transition transfer record status from AWAITING_DESTINATION_HM to JOINING_APPROVED
    // Guarantees that if two concurrent requests attempt approval, exactly ONE succeeds.
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: TRANSFER_STATUS.AWAITING_DESTINATION_HM,
      },
      {
        $set: {
          status: TRANSFER_STATUS.JOINING_APPROVED,
          destinationHMReview: {
            reviewedBy: requestingActor._id,
            reviewedAt: new Date(),
            joiningDateConfirmed: effectiveJoiningDate,
            hmRemarks: remarks.trim(),
          },
        },
      },
      { session, new: true }
    );

    if (!updatedTransfer) {
      await session.abortTransaction();
      session.endSession();
      return sendError(
        response,
        409,
        'Concurrent modification conflict: This transfer was already processed or is no longer awaiting joining approval.'
      );
    }

    // 2. Update User.schoolId to destination school
    await User.findByIdAndUpdate(
      transferRecord.teacherUserId._id,
      { $set: { schoolId: transferRecord.toSchoolId._id } },
      { session }
    );

    // 3. Expire all active teaching assignments at the old school
    const expiredAssignmentsResult = await TeachingAssignment.updateMany(
      {
        teacherId: transferRecord.teacherUserId._id,
        schoolId: transferRecord.fromSchoolId._id,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      },
      {
        $set: {
          status: TEACHING_ASSIGNMENT_STATUS.TRANSFERRED,
          effectiveTo: effectiveJoiningDate,
          remarks: `Auto-expired on approved transfer joining at ${transferRecord.toSchoolId.name}. Transfer ID: ${transferRecord._id}`,
        },
      },
      { session }
    );

    // 4. Sync TeacherProfile: update currentSchoolId + append transferHistory
    await TeacherProfile.findOneAndUpdate(
      { userId: transferRecord.teacherUserId._id },
      {
        $set: { currentSchoolId: transferRecord.toSchoolId._id },
        $push: {
          transferHistory: {
            fromSchoolId: transferRecord.fromSchoolId._id,
            toSchoolId: transferRecord.toSchoolId._id,
            transferRequestId: transferRecord._id,
            relievedDate: transferRecord.createdAt,
            joiningDate: effectiveJoiningDate,
          },
        },
      },
      { session }
    );

    // 5. Immutable Audit Log
    await AuditLog.create(
      [{
        actorId: requestingActor._id,
        actorRole: requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName: requestingActor.fullName || '',
        action: 'TEACHER_JOINING_CONFIRMED',
        targetModel: 'TransferRequest',
        targetId: transferRecord._id,
        targetName: transferRecord.teacherUserId.fullName,
        schoolId: transferRecord.toSchoolId._id,
        previousState: {
          status: TRANSFER_STATUS.AWAITING_DESTINATION_HM,
          schoolId: String(transferRecord.fromSchoolId._id),
          schoolName: transferRecord.fromSchoolId.name,
        },
        newState: {
          status: TRANSFER_STATUS.JOINING_APPROVED,
          schoolId: String(transferRecord.toSchoolId._id),
          schoolName: transferRecord.toSchoolId.name,
          joiningDate: effectiveJoiningDate,
          expiredAssignments: expiredAssignmentsResult.modifiedCount,
        },
        result: 'SUCCESS',
        reason: remarks.trim() || `Joining confirmed by Destination ${requestingActor.role}`,
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // 6. Notify teacher
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: 'Faculty Joining Approved',
      message: `Your physical arrival at ${transferRecord.toSchoolId.name} has been verified and approved by the Head Master.`,
      actionLink: '/transfers',
      rawMetadata: {
        transferRequestId: String(transferRecord._id),
        joiningDate: effectiveJoiningDate.toISOString(),
      },
      recipientUserIds: [String(transferRecord.teacherUserId._id)],
    });

    return sendSuccess(response, 200, 'Faculty joining approved and records activated successfully.', {
      transferRequest: updatedTransfer,
      expiredAssignments: expiredAssignmentsResult.modifiedCount,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return sendError(response, 500, `Joining approval failed: ${error.message}`);
  }
});

