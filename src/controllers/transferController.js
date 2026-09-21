import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import School from '../models/School.js';
import TransferRequest from '../models/TransferRequest.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import TeacherProfile from '../models/TeacherProfile.js';
import Section from '../models/Section.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, TRANSFER_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';
import {
  initiateTransferSchema,
  relieveTeacherSchema,
  approveJoiningSchema,
  rejectJoiningSchema,
  adminReviewSchema,
  cancelTransferSchema,
} from '../validations/transferSchemas.js';

// Active transfer statuses that block a duplicate in-flight transfer
const ACTIVE_IN_FLIGHT_STATUSES = Object.freeze([
  TRANSFER_STATUS.TRANSFER_REQUESTED,
  TRANSFER_STATUS.INITIATED,
  TRANSFER_STATUS.APPROVED,
  TRANSFER_STATUS.RELIEVED,
  TRANSFER_STATUS.AWAITING_DESTINATION_HM,
  TRANSFER_STATUS.ADMIN_REVIEW_REQUIRED,
]);

/**
 * POST /api/v1/transfers
 * Initiates a faculty transfer directive.
 * Enforces in-flight uniqueness, jurisdictional boundaries, and atomic execution.
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
    orderDate,
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

  // ── Pre-transaction validation (read-only) ──────────────────────────────
  const [targetTeacher, targetSchool, activeExistingTransfer] = await Promise.all([
    User.findById(teacherUserId).populate('schoolId', 'name townId _id'),
    School.findById(targetSchoolId).lean(),
    TransferRequest.findOne({
      teacherUserId,
      status: { $in: ACTIVE_IN_FLIGHT_STATUSES },
    }).lean(),
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

  // Guard against duplicate active in-flight transfers
  if (activeExistingTransfer) {
    return sendError(
      response,
      400,
      `Cannot initiate transfer. Teacher already has an active transfer directive in progress (Transfer ID: ${activeExistingTransfer._id}, Status: ${activeExistingTransfer.status}).`
    );
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
        userAgent:  request.headers?.['user-agent'] || '',
        requestId:  request.headers?.['x-request-id'] || '',
      });
      return sendError(response, 403, 'Access denied. ADMIN actors can only transfer teachers within their own town jurisdiction.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ATOMIC TRANSACTION
  // ═══════════════════════════════════════════════════════════════════════
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const effectiveOrderDate = orderDate ? new Date(orderDate) : new Date();

    let initialStatus = TRANSFER_STATUS.APPROVED;
    if (isEmergencyOverride) {
      initialStatus = TRANSFER_STATUS.OVERRIDDEN_AND_TRANSFERRED;
    } else if (!officialOrderNumber) {
      initialStatus = TRANSFER_STATUS.TRANSFER_REQUESTED;
    }

    // 1. Create TransferRequest record
    const [transferRecord] = await TransferRequest.create(
      [{
        teacherUserId,
        fromSchoolId:         sourceSchoolId,
        toSchoolId:           targetSchoolId,
        initiatedBy:          requestingActor._id || requestingActor.userId,
        initiatorRole:        requestingActor.role,
        isEmergencyOverride:  Boolean(isEmergencyOverride),
        overrideJustification: overrideJustification || '',
        reason:               reason.trim(),
        officialOrderNumber:  officialOrderNumber?.trim() || '',
        orderDate:            effectiveOrderDate,
        status:               initialStatus,
      }],
      { session }
    );

    let expiredAssignmentsCount = 0;
    let clearedSectionsCount = 0;

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
            effectiveTo: effectiveOrderDate,
            remarks:     `Auto-expired on emergency transfer to ${targetSchool.name}. Transfer ID: ${transferRecord._id}`,
          },
        },
        { session }
      );
      expiredAssignmentsCount = expiredAssignmentsResult.modifiedCount;

      // 4. Clear Section.classTeacherId at old school
      const clearedSectionsResult = await Section.updateMany(
        {
          schoolId:       sourceSchoolId,
          classTeacherId: teacherUserId,
        },
        {
          $set: { classTeacherId: null },
        },
        { session }
      );
      clearedSectionsCount = clearedSectionsResult.modifiedCount;

      // 5. Sync TeacherProfile: update currentSchoolId + append transferHistory
      await TeacherProfile.findOneAndUpdate(
        { userId: teacherUserId },
        {
          $set: { currentSchoolId: targetSchoolId },
          $push: {
            transferHistory: {
              fromSchoolId:         sourceSchoolId,
              toSchoolId:           targetSchoolId,
              transferRequestId:    transferRecord._id,
              relievedDate:         effectiveOrderDate,
              joiningDate:          effectiveOrderDate,
              orderReferenceNumber: officialOrderNumber || '',
            },
          },
        },
        { session }
      );
    }

    // 6. Write immutable audit log
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
          clearedClassTeacherSections: clearedSectionsCount,
        },
        result:    'SUCCESS',
        reason:    reason.trim(),
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // Dispatch notification
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: isEmergencyOverride ? 'Emergency Faculty Transfer Executed' : 'Faculty Transfer Directive Promulgated',
      message: isEmergencyOverride
        ? `You have been immediately transferred to ${targetSchool.name} under administrative emergency override.`
        : `A transfer directive to ${targetSchool.name} has been issued. Status: ${initialStatus}. Awaiting Source HM formal relieving.`,
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
        : `Transfer directive for "${targetTeacher.fullName}" issued successfully. Status: ${initialStatus}.`,
      {
        transferRequest: {
          _id:                  transferRecord._id,
          status:               transferRecord.status,
          teacherName:          targetTeacher.fullName,
          fromSchool:           targetTeacher.schoolId?.name || String(sourceSchoolId),
          toSchool:             targetSchool.name,
          reason:               transferRecord.reason,
          officialOrderNumber:  transferRecord.officialOrderNumber,
          expiredAssignments:   expiredAssignmentsCount,
          createdAt:            transferRecord.createdAt,
        },
      }
    );

  } catch (transactionError) {
    await session.abortTransaction();
    session.endSession();

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
      userAgent:  request.headers?.['user-agent'] || '',
      requestId:  request.headers?.['x-request-id'] || '',
    }).catch(() => {});

    return sendError(
      response,
      500,
      `Transfer initiation failed: ${transactionError.message}`
    );
  }
});

/**
 * GET /api/v1/transfers
 * List transfer requests with directional filtering and server-enforced school scoping.
 */
export const handleGetTransfers = asyncHandler(async (request, response) => {
  const actor = request.user;
  const {
    teacherUserId,
    status,
    fromSchoolId,
    toSchoolId,
    direction = 'all',
    limit = 50,
    skip = 0,
  } = request.query;

  const queryFilter = {};
  if (teacherUserId && /^[0-9a-fA-F]{24}$/.test(teacherUserId)) queryFilter.teacherUserId = teacherUserId;
  if (status) queryFilter.status = status;

  // ── Server-Enforced Jurisdictional Guard ─────────────────────────────────
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId);

    // Cross-school query validation (BOLA protection)
    if (fromSchoolId && String(fromSchoolId) !== actorSchoolId) {
      if (!toSchoolId || String(toSchoolId) !== actorSchoolId) {
        return sendError(response, 403, 'Access denied. Head Masters can only query transfer records involving their own school.');
      }
    }
    if (toSchoolId && String(toSchoolId) !== actorSchoolId) {
      if (!fromSchoolId || String(fromSchoolId) !== actorSchoolId) {
        return sendError(response, 403, 'Access denied. Head Masters can only query transfer records involving their own school.');
      }
    }

    if (direction === 'incoming') {
      queryFilter.toSchoolId = actorSchoolId;
    } else if (direction === 'outgoing') {
      queryFilter.fromSchoolId = actorSchoolId;
    } else if (direction === 'history') {
      queryFilter.$or = [{ fromSchoolId: actorSchoolId }, { toSchoolId: actorSchoolId }];
      queryFilter.status = {
        $in: [
          TRANSFER_STATUS.JOINED,
          TRANSFER_STATUS.JOINING_APPROVED,
          TRANSFER_STATUS.OVERRIDDEN_AND_TRANSFERRED,
          TRANSFER_STATUS.CANCELLED,
        ],
      };
    } else {
      // 'all'
      queryFilter.$or = [{ fromSchoolId: actorSchoolId }, { toSchoolId: actorSchoolId }];
    }
  } else if (actor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = (actor.assignedSchools || []).map((s) => String(s._id || s));
    if (assignedSchoolIds.length === 0) {
      return sendSuccess(response, 200, 'No assigned schools found.', { transfers: [], total: 0 });
    }
    queryFilter.$or = [
      { fromSchoolId: { $in: assignedSchoolIds } },
      { toSchoolId: { $in: assignedSchoolIds } },
    ];
  } else {
    // Admin / Super Admin / Root Admin
    if (fromSchoolId && /^[0-9a-fA-F]{24}$/.test(fromSchoolId)) queryFilter.fromSchoolId = fromSchoolId;
    if (toSchoolId && /^[0-9a-fA-F]{24}$/.test(toSchoolId)) queryFilter.toSchoolId = toSchoolId;
  }

  const transfers = await TransferRequest.find(queryFilter)
    .populate('teacherUserId', 'fullName email designation')
    .populate('fromSchoolId',  'name schoolCode code')
    .populate('toSchoolId',    'name schoolCode code')
    .populate('initiatedBy',   'fullName role')
    .populate('relievingDetails.relievedBy', 'fullName role designation')
    .populate('destinationHMReview.reviewedBy', 'fullName role designation')
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
 * GET /api/v1/transfers/:id
 * Retrieve a single transfer record with strict BOLA / IDOR protection.
 */
export const handleGetTransferById = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }

  const transferRecord = await TransferRequest.findById(id)
    .populate('teacherUserId', 'fullName email designation cnic phone')
    .populate('fromSchoolId',  'name schoolCode code address')
    .populate('toSchoolId',    'name schoolCode code address')
    .populate('initiatedBy',   'fullName role designation')
    .populate('relievingDetails.relievedBy', 'fullName role designation')
    .populate('destinationHMReview.reviewedBy', 'fullName role designation')
    .lean();

  if (!transferRecord) {
    return sendError(response, 404, 'Transfer record not found.');
  }

  // Server-side BOLA Guard
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId);
    const fromId = String(transferRecord.fromSchoolId?._id || transferRecord.fromSchoolId);
    const toId   = String(transferRecord.toSchoolId?._id || transferRecord.toSchoolId);

    if (actorSchoolId !== fromId && actorSchoolId !== toId) {
      return sendError(response, 403, 'Access denied. You can only view transfer records involving your assigned school.');
    }
  } else if (actor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = (actor.assignedSchools || []).map((s) => String(s._id || s));
    const fromId = String(transferRecord.fromSchoolId?._id || transferRecord.fromSchoolId);
    const toId   = String(transferRecord.toSchoolId?._id || transferRecord.toSchoolId);

    if (!assignedSchoolIds.includes(fromId) && !assignedSchoolIds.includes(toId)) {
      return sendError(response, 403, 'Access denied. You can only view transfer records involving schools in your assigned jurisdiction.');
    }
  }

  return sendSuccess(response, 200, 'Transfer record retrieved successfully.', {
    transfer: transferRecord,
  });
});

/**
 * PATCH /api/v1/transfers/:id/relieve
 * Source Head Master (HM) certifies asset clearance and formally relieves departing faculty.
 * Implements atomic duty expiry: TeachingAssignments expired + Section.classTeacherId cleared.
 */
export const handleRelieveTeacher = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  const {
    relievingDate,
    relievingRemarks = '',
    relievingOrderNumber = '',
    clearanceCertified,
  } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }

  if (clearanceCertified !== true) {
    return sendError(response, 400, 'Clearance certification must be verified before relieving faculty member.');
  }

  const transferRecord = await TransferRequest.findById(id)
    .populate('fromSchoolId', 'name schoolCode code')
    .populate('toSchoolId', 'name schoolCode code')
    .populate('teacherUserId', 'fullName email schoolId role');

  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // Exact State Machine Check: only APPROVED, INITIATED, or TRANSFER_REQUESTED can be relieved
  const validPreStatuses = [
    TRANSFER_STATUS.APPROVED,
    TRANSFER_STATUS.INITIATED,
    TRANSFER_STATUS.TRANSFER_REQUESTED,
  ];
  if (!validPreStatuses.includes(transferRecord.status)) {
    return sendError(
      response,
      400,
      `Transfer cannot be relieved. Current status is "${transferRecord.status}". Relieving is only permitted from [APPROVED, INITIATED, TRANSFER_REQUESTED].`
    );
  }

  // Source HM Boundary Check
  const sourceSchoolId = String(transferRecord.fromSchoolId?._id || transferRecord.fromSchoolId);
  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== sourceSchoolId) {
      return sendError(
        response,
        403,
        'Access denied. Only the Source Head Master (HM) can relieve faculty departing from this school.'
      );
    }
  }

  const targetTeacherUserId = transferRecord.teacherUserId?._id || transferRecord.teacherUserId;
  const targetTeacherName = transferRecord.teacherUserId?.fullName || 'Faculty Member';
  const effectiveRelievedDate = relievingDate ? new Date(relievingDate) : new Date();

  // ═══════════════════════════════════════════════════════════════════════
  // ATOMIC TRANSACTION: Relieve + Expire Duties + Clear ClassTeacher + Audit
  // ═══════════════════════════════════════════════════════════════════════
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Atomic Test-and-Set: Transition status to RELIEVED
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: validPreStatuses },
      },
      {
        $set: {
          status: TRANSFER_STATUS.RELIEVED,
          relievingDetails: {
            relievedBy:           requestingActor._id || requestingActor.userId,
            relievedAt:           effectiveRelievedDate,
            clearanceCertified:   true,
            relievingRemarks:     relievingRemarks.trim(),
            relievingOrderNumber: relievingOrderNumber.trim(),
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
        'Concurrent modification conflict: This transfer was already relieved or modified.'
      );
    }

    // 2. Revoke / Expire ALL active teaching assignments at the old school immediately
    const expiredAssignmentsResult = await TeachingAssignment.updateMany(
      {
        teacherId: targetTeacherUserId,
        schoolId:  sourceSchoolId,
        status:    TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      },
      {
        $set: {
          status:      TEACHING_ASSIGNMENT_STATUS.TRANSFERRED,
          effectiveTo: effectiveRelievedDate,
          remarks:     `Auto-expired upon formal relieving by Source HM. Relieving order: ${relievingOrderNumber || transferRecord._id}`,
        },
      },
      { session }
    );

    // 3. Clear Section.classTeacherId pointer at the source school to prevent orphan references
    const clearedSectionsResult = await Section.updateMany(
      {
        schoolId:       sourceSchoolId,
        classTeacherId: targetTeacherUserId,
      },
      {
        $set: { classTeacherId: null },
      },
      { session }
    );

    // 4. Immutable Audit Log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           'TEACHER_TRANSFER_RELIEVED',
        targetModel:      'TransferRequest',
        targetId:         transferRecord._id,
        targetName:       targetTeacherName,
        schoolId:         sourceSchoolId,
        previousState: {
          status:   transferRecord.status,
          schoolId: String(sourceSchoolId),
        },
        newState: {
          status:                      TRANSFER_STATUS.RELIEVED,
          relievedDate:                effectiveRelievedDate,
          expiredAssignments:          expiredAssignmentsResult.modifiedCount,
          clearedClassTeacherSections: clearedSectionsResult.modifiedCount,
        },
        result:    'SUCCESS',
        reason:    relievingRemarks.trim() || 'Clearance certified and relieved by Source HM',
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // 5. Dispatch notification
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: 'Faculty Formally Relieved',
      message: `You have been formally relieved from ${transferRecord.fromSchoolId?.name}. Please present your relieving order upon arrival at ${transferRecord.toSchoolId?.name}.`,
      actionLink: '/transfers',
      rawMetadata: {
        transferRequestId: String(transferRecord._id),
        teacherName: targetTeacherName,
        fromSchool: transferRecord.fromSchoolId?.name,
        toSchool: transferRecord.toSchoolId?.name,
      },
      recipientUserIds: [String(targetTeacherUserId)],
    });

    return sendSuccess(response, 200, 'Faculty member formally relieved and duties revoked.', {
      transferRequest: updatedTransfer,
      expiredAssignments: expiredAssignmentsResult.modifiedCount,
      clearedClassTeacherSections: clearedSectionsResult.modifiedCount,
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return sendError(response, 500, `Relieving operation failed: ${error.message}`);
  }
});

/**
 * PATCH /api/v1/transfers/:id/approve-joining
 * Destination Head Master (HM) certifies physical arrival and approves faculty joining.
 * Exact State Machine Check: only transfers in RELIEVED or AWAITING_DESTINATION_HM can be approved.
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

  // Exact State Machine Check
  const validJoiningPreStatuses = [
    TRANSFER_STATUS.RELIEVED,
    TRANSFER_STATUS.AWAITING_DESTINATION_HM,
  ];

  if (!validJoiningPreStatuses.includes(transferRecord.status)) {
    // If premature attempt prior to relieving
    if ([TRANSFER_STATUS.INITIATED, TRANSFER_STATUS.TRANSFER_REQUESTED, TRANSFER_STATUS.APPROVED].includes(transferRecord.status)) {
      return sendError(
        response,
        400,
        `Transfer cannot be approved for joining. Faculty member must be formally relieved by the Source School Head Master first (AWAITING_DESTINATION_HM / RELIEVED). Current status is "${transferRecord.status}".`
      );
    }
    return sendError(
      response,
      400,
      `Transfer cannot be approved for joining. Current status is "${transferRecord.status}", required status is [RELIEVED, AWAITING_DESTINATION_HM].`
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

    // 1. Atomically transition transfer record status to JOINED (or JOINING_APPROVED)
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: validJoiningPreStatuses },
      },
      {
        $set: {
          status: TRANSFER_STATUS.JOINED,
          destinationHMReview: {
            reviewedBy:           requestingActor._id || requestingActor.userId,
            reviewedAt:           new Date(),
            joiningDateConfirmed: effectiveJoiningDate,
            hmRemarks:            remarks.trim(),
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

    const targetTeacherUserId = transferRecord.teacherUserId?._id || transferRecord.teacherUserId;
    const sourceSchoolId = transferRecord.fromSchoolId?._id || transferRecord.fromSchoolId;
    const targetSchoolId = transferRecord.toSchoolId?._id || transferRecord.toSchoolId;
    const sourceSchoolName = transferRecord.fromSchoolId?.name || 'Previous School';
    const targetSchoolName = transferRecord.toSchoolId?.name || 'New School';
    const targetTeacherName = transferRecord.teacherUserId?.fullName || 'Faculty Member';

    // 2. Update User.schoolId to destination school
    await User.findByIdAndUpdate(
      targetTeacherUserId,
      { $set: { schoolId: targetSchoolId } },
      { session }
    );

    // 3. Expire all remaining active teaching assignments at the old school (safety guarantee)
    const expiredAssignmentsResult = await TeachingAssignment.updateMany(
      {
        teacherId: targetTeacherUserId,
        schoolId:  sourceSchoolId,
        status:    TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      },
      {
        $set: {
          status:      TEACHING_ASSIGNMENT_STATUS.TRANSFERRED,
          effectiveTo: effectiveJoiningDate,
          remarks:     `Auto-expired on approved transfer joining at ${targetSchoolName}. Transfer ID: ${transferRecord._id}`,
        },
      },
      { session }
    );

    // 4. Clear any remaining Section.classTeacherId pointer at source school
    await Section.updateMany(
      {
        schoolId:       sourceSchoolId,
        classTeacherId: targetTeacherUserId,
      },
      {
        $set: { classTeacherId: null },
      },
      { session }
    );

    // 5. Sync TeacherProfile: update currentSchoolId + append transferHistory
    await TeacherProfile.findOneAndUpdate(
      { userId: targetTeacherUserId },
      {
        $set: { currentSchoolId: targetSchoolId },
        $push: {
          transferHistory: {
            fromSchoolId:         sourceSchoolId,
            toSchoolId:           targetSchoolId,
            transferRequestId:    transferRecord._id,
            relievedDate:         transferRecord.relievingDetails?.relievedAt || transferRecord.createdAt,
            joiningDate:          effectiveJoiningDate,
            orderReferenceNumber: transferRecord.officialOrderNumber || transferRecord.relievingDetails?.relievingOrderNumber || '',
          },
        },
      },
      { session }
    );

    // 6. Immutable Audit Log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           'TEACHER_JOINING_CONFIRMED',
        targetModel:      'TransferRequest',
        targetId:         transferRecord._id,
        targetName:       targetTeacherName,
        schoolId:         targetSchoolId,
        previousState: {
          status:     transferRecord.status,
          schoolId:   String(sourceSchoolId),
          schoolName: sourceSchoolName,
        },
        newState: {
          status:             TRANSFER_STATUS.JOINED,
          schoolId:           String(targetSchoolId),
          schoolName:         targetSchoolName,
          joiningDate:        effectiveJoiningDate,
          expiredAssignments: expiredAssignmentsResult.modifiedCount,
        },
        result:    'SUCCESS',
        reason:    remarks.trim() || `Joining confirmed by Destination ${requestingActor.role}`,
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // 7. Notify teacher
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: 'Faculty Joining Approved',
      message: `Your physical arrival at ${targetSchoolName} has been verified and approved by the Head Master.`,
      actionLink: '/transfers',
      rawMetadata: {
        transferRequestId: String(transferRecord._id),
        joiningDate: effectiveJoiningDate.toISOString(),
      },
      recipientUserIds: [String(targetTeacherUserId)],
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

/**
 * PATCH /api/v1/transfers/:id/reject
 * Destination Head Master (HM) rejects physical joining due to document/identity discrepancy.
 * Transitions status to REJECTED_BY_HM and places transfer under ADMIN_REVIEW_REQUIRED.
 */
export const handleRejectJoining = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  const { rejectionReason } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }
  if (!rejectionReason || rejectionReason.trim().length < 10) {
    return sendError(response, 400, 'A detailed rejection reason of at least 10 characters is required.');
  }

  const transferRecord = await TransferRequest.findById(id)
    .populate('fromSchoolId', 'name')
    .populate('toSchoolId', 'name')
    .populate('teacherUserId', 'fullName');

  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // Pre-status check: must be awaiting joining
  const validRejectStatuses = [
    TRANSFER_STATUS.RELIEVED,
    TRANSFER_STATUS.AWAITING_DESTINATION_HM,
  ];
  if (!validRejectStatuses.includes(transferRecord.status)) {
    return sendError(
      response,
      400,
      `Transfer cannot be rejected. Current status is "${transferRecord.status}". Only transfers awaiting joining can be rejected.`
    );
  }

  // Destination HM boundary check
  const destinationSchoolId = String(transferRecord.toSchoolId?._id || transferRecord.toSchoolId);
  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== destinationSchoolId) {
      return sendError(
        response,
        403,
        'Access denied. Only the Destination Head Master (HM) can reject faculty joining for this school.'
      );
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: validRejectStatuses },
      },
      {
        $set: {
          status: TRANSFER_STATUS.REJECTED_BY_HM,
          rejectionDetails: {
            rejectedBy:      requestingActor._id || requestingActor.userId,
            rejectedAt:      new Date(),
            rejectionReason: rejectionReason.trim(),
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
        'Concurrent modification conflict: This transfer was already processed.'
      );
    }

    // Write audit log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorName:        requestingActor.fullName || '',
        action:           'TEACHER_TRANSFER_REJECTED_BY_HM',
        targetModel:      'TransferRequest',
        targetId:         transferRecord._id,
        targetName:       transferRecord.teacherUserId?.fullName || 'Faculty Member',
        schoolId:         destinationSchoolId,
        previousState: {
          status: transferRecord.status,
        },
        newState: {
          status:          TRANSFER_STATUS.REJECTED_BY_HM,
          rejectionReason: rejectionReason.trim(),
        },
        result:    'SUCCESS',
        reason:    rejectionReason.trim(),
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return sendSuccess(response, 200, 'Faculty joining rejected. Transfer record referred for Town Administration review.', {
      transferRequest: updatedTransfer,
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return sendError(response, 500, `Rejection processing failed: ${error.message}`);
  }
});

/**
 * PATCH /api/v1/transfers/:id/admin-review
 * Town Administration reviews a transfer rejected by HM.
 * Enforces explicit administrative review: transitions to APPROVED (re-affirmed) or CANCELLED.
 */
export const handleAdminReview = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  const { decision, adminRemarks, officialOrderNumber } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }
  if (!['APPROVE', 'CANCEL'].includes(decision)) {
    return sendError(response, 400, 'Decision must be either "APPROVE" or "CANCEL".');
  }
  if (!adminRemarks || adminRemarks.trim().length < 5) {
    return sendError(response, 400, 'Administrative review remarks of at least 5 characters are required.');
  }

  const transferRecord = await TransferRequest.findById(id);
  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // Pre-status check: must be REJECTED_BY_HM or ADMIN_REVIEW_REQUIRED
  if (transferRecord.status !== TRANSFER_STATUS.REJECTED_BY_HM && transferRecord.status !== TRANSFER_STATUS.ADMIN_REVIEW_REQUIRED) {
    return sendError(
      response,
      400,
      `Transfer is not pending administrative review. Current status: "${transferRecord.status}".`
    );
  }

  const newStatus = decision === 'APPROVE' ? TRANSFER_STATUS.APPROVED : TRANSFER_STATUS.CANCELLED;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: [TRANSFER_STATUS.REJECTED_BY_HM, TRANSFER_STATUS.ADMIN_REVIEW_REQUIRED] },
      },
      {
        $set: {
          status: newStatus,
          adminReviewDetails: {
            reviewedBy:            requestingActor._id || requestingActor.userId,
            reviewedAt:            new Date(),
            decision,
            adminRemarks:          adminRemarks.trim(),
            reassignedOrderNumber: officialOrderNumber?.trim() || '',
          },
        },
      },
      { session, new: true }
    );

    if (!updatedTransfer) {
      await session.abortTransaction();
      session.endSession();
      return sendError(response, 409, 'Concurrent modification conflict: Transfer already reviewed or modified.');
    }

    // Write audit log
    await AuditLog.create(
      [{
        actorId:     requestingActor._id || requestingActor.userId,
        actorRole:   requestingActor.role,
        actorName:   requestingActor.fullName || '',
        action:      decision === 'APPROVE' ? 'TEACHER_TRANSFER_ADMIN_REAPPROVED' : 'TEACHER_TRANSFER_ADMIN_CANCELLED',
        targetModel: 'TransferRequest',
        targetId:    transferRecord._id,
        previousState: {
          status: transferRecord.status,
        },
        newState: {
          status:       newStatus,
          decision,
          adminRemarks: adminRemarks.trim(),
        },
        result:    'SUCCESS',
        reason:    adminRemarks.trim(),
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return sendSuccess(
      response,
      200,
      `Transfer successfully reviewed and transitioned to "${newStatus}".`,
      { transferRequest: updatedTransfer }
    );

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return sendError(response, 500, `Admin review failed: ${error.message}`);
  }
});

/**
 * PATCH /api/v1/transfers/:id/cancel
 * Administrative cancellation of a transfer prior to formal relieving.
 */
export const handleCancelTransfer = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  const { cancellationReason } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }
  if (!cancellationReason || cancellationReason.trim().length < 5) {
    return sendError(response, 400, 'A cancellation reason of at least 5 characters is required.');
  }

  const transferRecord = await TransferRequest.findById(id);
  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // Can only cancel if not yet relieved
  const cancellableStatuses = [
    TRANSFER_STATUS.TRANSFER_REQUESTED,
    TRANSFER_STATUS.INITIATED,
    TRANSFER_STATUS.APPROVED,
    TRANSFER_STATUS.REJECTED_BY_HM,
  ];
  if (!cancellableStatuses.includes(transferRecord.status)) {
    return sendError(
      response,
      400,
      `Cannot cancel transfer after faculty has already been relieved or completed. Current status: "${transferRecord.status}". An administrative repatriation order is required.`
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: cancellableStatuses },
      },
      {
        $set: {
          status: TRANSFER_STATUS.CANCELLED,
          cancellationDetails: {
            cancelledBy:        requestingActor._id || requestingActor.userId,
            cancelledAt:        new Date(),
            cancellationReason: cancellationReason.trim(),
          },
        },
      },
      { session, new: true }
    );

    if (!updatedTransfer) {
      await session.abortTransaction();
      session.endSession();
      return sendError(response, 409, 'Concurrent modification conflict: Transfer already modified.');
    }

    await AuditLog.create(
      [{
        actorId:     requestingActor._id || requestingActor.userId,
        actorRole:   requestingActor.role,
        actorName:   requestingActor.fullName || '',
        action:      'TEACHER_TRANSFER_CANCELLED',
        targetModel: 'TransferRequest',
        targetId:    transferRecord._id,
        previousState: {
          status: transferRecord.status,
        },
        newState: {
          status:             TRANSFER_STATUS.CANCELLED,
          cancellationReason: cancellationReason.trim(),
        },
        result:    'SUCCESS',
        reason:    cancellationReason.trim(),
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return sendSuccess(response, 200, 'Transfer directive cancelled successfully.', {
      transferRequest: updatedTransfer,
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return sendError(response, 500, `Cancellation failed: ${error.message}`);
  }
});
