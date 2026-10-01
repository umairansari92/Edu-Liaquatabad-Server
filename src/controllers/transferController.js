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
 * Initiates an inter-school staff/faculty transfer directive.
 * Enforces in-flight uniqueness, jurisdictional boundaries, target HM notification delivery, and atomic execution.
 */
export const handleInitiateTransfer = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const targetEmployeeUserId =
    request.body.employeeUserId ||
    request.body.employeeId ||
    request.body.teacherUserId ||
    request.body.teacherId ||
    request.body.userId;
  const targetSchoolId =
    request.body.targetSchoolId ||
    request.body.destinationSchoolId ||
    request.body.toSchoolId;
  const {
    isEmergencyOverride,
    overrideJustification,
    officialOrderNumber,
    orderDate,
  } = request.body;
  const transferReason = (request.body.reason || 'Official administrative transfer directive').trim();

  // ── Input validation ─────────────────────────────────────────────────────
  if (!targetEmployeeUserId || !/^[0-9a-fA-F]{24}$/.test(targetEmployeeUserId)) {
    return sendError(response, 400, 'A valid employee identifier is required.');
  }
  if (!targetSchoolId || !/^[0-9a-fA-F]{24}$/.test(targetSchoolId)) {
    return sendError(response, 400, 'A valid targetSchoolId is required.');
  }
  if (!transferReason || transferReason.length < 3) {
    return sendError(response, 400, 'A transfer reason of at least 3 characters is required.');
  }

  // ── Pre-transaction validation (read-only) ──────────────────────────────
  const [targetEmployee, targetSchool, activeExistingTransfer] = await Promise.all([
    User.findById(targetEmployeeUserId).populate('schoolId', 'name townId _id'),
    School.findById(targetSchoolId).lean(),
    TransferRequest.findOne({
      $or: [
        { teacherUserId: targetEmployeeUserId },
        { employeeUserId: targetEmployeeUserId },
      ],
      status: { $in: ACTIVE_IN_FLIGHT_STATUSES },
    }).lean(),
  ]);

  if (!targetEmployee) {
    return sendError(response, 404, 'Employee not found in personnel registry.');
  }

  // Transferable roles guard: Teachers, Peons, Supervisors, Staff
  const NON_TRANSFERABLE_ROLES = [ROLES.STUDENT, ROLES.PARENT];
  if (NON_TRANSFERABLE_ROLES.includes(targetEmployee.role)) {
    return sendError(
      response,
      400,
      `Personnel with role "${targetEmployee.role}" cannot be transferred via staff transfer directive.`
    );
  }

  const NON_TRANSFERABLE_STATUSES = ['RETIRED', 'REJECTED', 'SUSPENDED'];
  if (NON_TRANSFERABLE_STATUSES.includes(targetEmployee.status)) {
    return sendError(
      response,
      400,
      `Employee account status is "${targetEmployee.status}" and cannot be transferred.`
    );
  }

  const sourceSchoolId = targetEmployee.schoolId?._id || targetEmployee.schoolId;
  if (!sourceSchoolId) {
    return sendError(response, 400, 'Employee does not have a current school assignment. Assign a school first.');
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
    const sourceTownId = String(targetEmployee.schoolId?.townId || '');
    const actorTownId  = String(requestingActor.townId);

    if (targetTownId !== actorTownId || (sourceTownId && sourceTownId !== actorTownId)) {
      await AuditLog.create({
        actorId:    requestingActor._id || requestingActor.userId,
        actorRole:  requestingActor.role,
        actorName:  requestingActor.fullName || '',
        action:     'ADMIN_CROSS_TOWN_TRANSFER_BLOCKED',
        targetModel: 'TransferRequest',
        targetId:   targetEmployee._id,
        targetName: targetEmployee.fullName,
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

  // ── Look up active Head Master of Target School ─────────────────────────
  const targetHM = await User.findOne({
    schoolId: targetSchoolId,
    role: ROLES.HM,
    status: 'ACTIVE',
  }).lean();

  // ═══════════════════════════════════════════════════════════════════════
  // ATOMIC TRANSACTION
  // ═══════════════════════════════════════════════════════════════════════
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const effectiveOrderDate = orderDate ? new Date(orderDate) : new Date();

    let initialStatus = TRANSFER_STATUS.PENDING_TARGET_HM_APPROVAL;
    if (isEmergencyOverride) {
      initialStatus = TRANSFER_STATUS.OVERRIDDEN_AND_TRANSFERRED;
    }

    // 1. Create persistent TransferRequest record
    const [transferRecord] = await TransferRequest.create(
      [{
        teacherUserId:        targetEmployeeUserId,
        employeeUserId:       targetEmployeeUserId,
        employeeDesignation:  targetEmployee.designation || targetEmployee.role,
        fromSchoolId:         sourceSchoolId,
        toSchoolId:           targetSchoolId,
        initiatedBy:          requestingActor._id || requestingActor.userId,
        initiatorRole:        requestingActor.role,
        isEmergencyOverride:  Boolean(isEmergencyOverride),
        overrideJustification: overrideJustification || '',
        reason:               transferReason,
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
      // 2. Update employee's schoolId
      await User.findByIdAndUpdate(
        targetEmployeeUserId,
        { $set: { schoolId: targetSchoolId } },
        { session }
      );

      // 3. Expire ALL ACTIVE teaching assignments at old school → TRANSFERRED
      const expiredAssignmentsResult = await TeachingAssignment.updateMany(
        {
          teacherId: targetEmployeeUserId,
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
          classTeacherId: targetEmployeeUserId,
        },
        {
          $set: { classTeacherId: null },
        },
        { session }
      );
      clearedSectionsCount = clearedSectionsResult.modifiedCount;

      // 5. Sync TeacherProfile: update currentSchoolId + append transferHistory
      if (targetEmployee.role === ROLES.TEACHER) {
        await TeacherProfile.findOneAndUpdate(
          { userId: targetEmployeeUserId },
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
    }

    // 6. Write immutable audit log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           isEmergencyOverride ? 'TRANSFER_EMERGENCY_OVERRIDDEN' : 'TRANSFER_INITIATED',
        targetModel:      'User',
        targetId:         targetEmployee._id,
        targetName:       targetEmployee.fullName,
        townId:           requestingActor.townId || null,
        schoolId:         targetSchoolId,
        previousState: {
          schoolId:   String(sourceSchoolId),
          schoolName: targetEmployee.schoolId?.name || 'Previous School',
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
        reason:    transferReason,
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // ── Dispatch notifications outside transaction ─────────────────────────
    // 1. Dispatch persistent notification to Target School Head Master
    if (targetHM) {
      await dispatchNotificationEvent({
        eventType: 'TRANSFER',
        category: 'GOVERNANCE',
        title: 'Transfer Approval Required',
        message: `Transfer approval required: ${targetEmployee.fullName} (${targetEmployee.designation || targetEmployee.role}) requested to transfer from ${targetEmployee.schoolId?.name || 'Current School'} to ${targetSchool.name}. Initiated by ${requestingActor.fullName || requestingActor.role}.`,
        actionLink: '/transfers',
        rawMetadata: {
          transferRequestId: String(transferRecord._id),
          employeeId: String(targetEmployeeUserId),
          employeeName: targetEmployee.fullName,
          employeeDesignation: targetEmployee.designation || targetEmployee.role,
          fromSchool: targetEmployee.schoolId?.name || String(sourceSchoolId),
          fromSchoolId: String(sourceSchoolId),
          toSchool: targetSchool.name,
          toSchoolId: String(targetSchoolId),
          initiatedBy: String(requestingActor._id || requestingActor.userId),
          initiatedByName: requestingActor.fullName || requestingActor.role,
          reason: transferReason,
          orderNumber: officialOrderNumber || '',
          status: initialStatus,
        },
        recipientUserIds: [String(targetHM._id)],
      });
    }

    // 2. Dispatch notification to the employee
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: isEmergencyOverride ? 'Emergency Faculty Transfer Executed' : 'Transfer Request Initiated',
      message: isEmergencyOverride
        ? `You have been immediately transferred to ${targetSchool.name} under administrative emergency override.`
        : `A transfer request to ${targetSchool.name} has been initiated and sent to the Target School Head Master for approval.`,
      actionLink: '/transfers',
      rawMetadata: {
        transferRequestId: String(transferRecord._id),
        teacherName: targetEmployee.fullName,
        employeeName: targetEmployee.fullName,
        fromSchool: targetEmployee.schoolId?.name || String(sourceSchoolId),
        toSchool: targetSchool.name,
        orderNumber: officialOrderNumber || '',
        status: initialStatus,
      },
      recipientUserIds: [String(targetEmployeeUserId)],
    });

    return sendSuccess(
      response,
      201,
      isEmergencyOverride
        ? `Employee "${targetEmployee.fullName}" transferred immediately to "${targetSchool.name}". ${expiredAssignmentsCount} assignment(s) archived.`
        : `Transfer request sent to "${targetSchool.name}" Head Master for approval. Status: ${initialStatus}.`,
      {
        transferRequest: {
          _id:                  transferRecord._id,
          status:               transferRecord.status,
          teacherName:          targetEmployee.fullName,
          employeeName:         targetEmployee.fullName,
          fromSchool:           targetEmployee.schoolId?.name || String(sourceSchoolId),
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
    .populate('teacherUserId', 'fullName email designation schoolId role')
    .populate('employeeUserId', 'fullName email designation schoolId role')
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
    .populate('teacherUserId', 'fullName email designation cnic phone role schoolId')
    .populate('employeeUserId', 'fullName email designation cnic phone role schoolId')
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
 * PATCH /api/v1/transfers/:id/approve-joining (also aliased to /api/v1/transfers/:id/approve)
 * Target School Head Master (HM) explicitly reviews and approves incoming transfer.
 * Only the Head Master assigned to targetSchoolId can approve.
 * Atomically reassigns employee schoolId to destination school, revokes old duties, logs audit, and notifies initiator and employee.
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
    .populate('teacherUserId', 'fullName email schoolId role designation status');

  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // ── Terminal state race condition guard (409 Conflict) ─────────────────
  const TERMINAL_RESOLVED_STATUSES = [
    TRANSFER_STATUS.JOINED,
    TRANSFER_STATUS.JOINING_APPROVED,
    TRANSFER_STATUS.REJECTED,
    TRANSFER_STATUS.CANCELLED,
  ];
  if (
    TERMINAL_RESOLVED_STATUSES.includes(transferRecord.status) ||
    (transferRecord.status === TRANSFER_STATUS.APPROVED && transferRecord.approvedBy)
  ) {
    return sendError(response, 409, 'Transfer request has already been resolved.');
  }

  // If status is APPROVED from Town directive without HM approvedBy, relieving is required first
  if (transferRecord.status === TRANSFER_STATUS.APPROVED) {
    return sendError(
      response,
      400,
      `Transfer cannot be approved for joining. Faculty member must be formally relieved by the Source School Head Master first (AWAITING_DESTINATION_HM / RELIEVED). Current status is "${transferRecord.status}".`
    );
  }

  // Permissible pre-approval statuses
  const validJoiningPreStatuses = [
    TRANSFER_STATUS.PENDING_TARGET_HM_APPROVAL,
    TRANSFER_STATUS.TRANSFER_REQUESTED,
    TRANSFER_STATUS.RELIEVED,
    TRANSFER_STATUS.AWAITING_DESTINATION_HM,
  ];

  if (!validJoiningPreStatuses.includes(transferRecord.status)) {
    return sendError(
      response,
      400,
      `Transfer cannot be approved for joining. Current status is "${transferRecord.status}", required status is [RELIEVED, AWAITING_DESTINATION_HM].`
    );
  }

  // ── Target HM School Jurisdiction Guard (Anti-BOLA) ────────────────────
  const destinationSchoolId = String(transferRecord.toSchoolId?._id || transferRecord.toSchoolId);
  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== destinationSchoolId) {
      await AuditLog.create({
        actorId:    requestingActor._id || requestingActor.userId,
        actorRole:  requestingActor.role,
        actorName:  requestingActor.fullName || '',
        action:     'CROSS_SCHOOL_TRANSFER_APPROVAL_BLOCKED',
        targetModel: 'TransferRequest',
        targetId:   transferRecord._id,
        schoolId:   destinationSchoolId,
        result:     'DENIED',
        reason:     `HM from school ${actorSchoolId} attempted to approve transfer for target school ${destinationSchoolId}`,
        ipAddress:  request.ip || '',
        userAgent:  request.headers?.['user-agent'] || '',
        requestId:  request.headers?.['x-request-id'] || '',
      }).catch(() => {});
      return sendError(
        response,
        403,
        'Access denied. Only the Destination Head Master (HM) can approve faculty joining for this school.'
      );
    }
  }

  // Verify employee still exists and is transferable
  const targetEmployeeUserId =
    transferRecord.employeeUserId?._id ||
    transferRecord.employeeUserId ||
    transferRecord.teacherUserId?._id ||
    transferRecord.teacherUserId;

  let targetEmployee = null;
  if (
    transferRecord.employeeUserId &&
    typeof transferRecord.employeeUserId === 'object' &&
    (transferRecord.employeeUserId.fullName || transferRecord.employeeUserId.role)
  ) {
    targetEmployee = transferRecord.employeeUserId;
  } else if (
    transferRecord.teacherUserId &&
    typeof transferRecord.teacherUserId === 'object' &&
    (transferRecord.teacherUserId.fullName || transferRecord.teacherUserId.role)
  ) {
    targetEmployee = transferRecord.teacherUserId;
  } else {
    try {
      targetEmployee = await User.findById(targetEmployeeUserId);
    } catch (_castError) {
      targetEmployee = null;
    }
  }
  if (!targetEmployee) {
    return sendError(response, 404, 'Transferred employee account not found in personnel registry.');
  }
  const NON_TRANSFERABLE_STATUSES = ['RETIRED', 'REJECTED', 'SUSPENDED'];
  if (NON_TRANSFERABLE_STATUSES.includes(targetEmployee.status)) {
    return sendError(
      response,
      400,
      `Employee account status is "${targetEmployee.status}" and cannot be transferred.`
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const effectiveJoiningDate = joiningDate ? new Date(joiningDate) : new Date();

    // Determine target state based on lifecycle position
    let targetApprovedStatus = TRANSFER_STATUS.APPROVED;
    if ([TRANSFER_STATUS.RELIEVED, TRANSFER_STATUS.AWAITING_DESTINATION_HM].includes(transferRecord.status)) {
      targetApprovedStatus = TRANSFER_STATUS.JOINED;
    }

    // 1. Atomically transition transfer record status
    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: validJoiningPreStatuses },
      },
      {
        $set: {
          status:     targetApprovedStatus,
          approvedBy: requestingActor._id || requestingActor.userId,
          approvedAt: new Date(),
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

    const sourceSchoolId = transferRecord.fromSchoolId?._id || transferRecord.fromSchoolId;
    const targetSchoolId = transferRecord.toSchoolId?._id || transferRecord.toSchoolId;
    const sourceSchoolName = transferRecord.fromSchoolId?.name || 'Previous School';
    const targetSchoolName = transferRecord.toSchoolId?.name || 'New School';
    const targetTeacherName = targetEmployee.fullName || 'Employee';

    // 2. Update User.schoolId to destination school
    await User.findByIdAndUpdate(
      targetEmployeeUserId,
      { $set: { schoolId: targetSchoolId } },
      { session }
    );

    // 3. Expire all remaining active teaching assignments at the old school
    const expiredAssignmentsResult = await TeachingAssignment.updateMany(
      {
        teacherId: targetEmployeeUserId,
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
        classTeacherId: targetEmployeeUserId,
      },
      {
        $set: { classTeacherId: null },
      },
      { session }
    );

    // 5. Sync TeacherProfile if faculty member
    if (targetEmployee.role === ROLES.TEACHER) {
      await TeacherProfile.findOneAndUpdate(
        { userId: targetEmployeeUserId },
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
    }

    // 6. Immutable Audit Log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName:        requestingActor.fullName || '',
        action:           'TRANSFER_APPROVED',
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
          status:             targetApprovedStatus,
          schoolId:           String(targetSchoolId),
          schoolName:         targetSchoolName,
          joiningDate:        effectiveJoiningDate,
          approvedBy:         String(requestingActor._id || requestingActor.userId),
          approvedAt:         new Date(),
          expiredAssignments: expiredAssignmentsResult.modifiedCount,
        },
        result:    'SUCCESS',
        reason:    remarks.trim() || `Transfer joining approved by Target School Head Master (${requestingActor.fullName || requestingActor.role})`,
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // 7. Dispatch notification to initiating official
    if (transferRecord.initiatedBy) {
      await dispatchNotificationEvent({
        eventType: 'TRANSFER_STATUS',
        category: 'GOVERNANCE',
        title: 'Transfer Approved',
        message: `Transfer approved. ${targetTeacherName} has been transferred from ${sourceSchoolName} to ${targetSchoolName}.`,
        actionLink: '/transfers',
        rawMetadata: {
          transferRequestId: String(transferRecord._id),
          teacherName: targetTeacherName,
          employeeName: targetTeacherName,
          fromSchool: sourceSchoolName,
          toSchool: targetSchoolName,
          status: targetApprovedStatus,
        },
        recipientUserIds: [String(transferRecord.initiatedBy._id || transferRecord.initiatedBy)],
      });
    }

    // 8. Dispatch notification to the employee
    await dispatchNotificationEvent({
      eventType: 'TRANSFER_STATUS',
      category: 'GOVERNANCE',
      title: 'Transfer Approved',
      message: `Transfer approved. You have been transferred from ${sourceSchoolName} to ${targetSchoolName}.`,
      actionLink: '/transfers',
      rawMetadata: {
        transferRequestId: String(transferRecord._id),
        teacherName: targetTeacherName,
        employeeName: targetTeacherName,
        fromSchool: sourceSchoolName,
        toSchool: targetSchoolName,
        joiningDate: effectiveJoiningDate.toISOString(),
        status: targetApprovedStatus,
      },
      recipientUserIds: [String(targetEmployeeUserId)],
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
 * Transitions status to REJECTED (or REJECTED_BY_HM) with mandatory rejection reason and audit trail.
 */
export const handleRejectJoining = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  const { rejectionReason } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid transfer request ID format.');
  }
  if (!rejectionReason || rejectionReason.trim().length < 5) {
    return sendError(response, 400, 'A detailed rejection reason of at least 5 characters is required.');
  }

  const transferRecord = await TransferRequest.findById(id)
    .populate('fromSchoolId', 'name')
    .populate('toSchoolId', 'name')
    .populate('teacherUserId', 'fullName');

  if (!transferRecord) {
    return sendError(response, 404, 'Transfer request not found.');
  }

  // ── Terminal state race condition guard (409 Conflict) ─────────────────
  const TERMINAL_RESOLVED_STATUSES = [
    TRANSFER_STATUS.JOINED,
    TRANSFER_STATUS.JOINING_APPROVED,
    TRANSFER_STATUS.REJECTED,
    TRANSFER_STATUS.REJECTED_BY_HM,
    TRANSFER_STATUS.CANCELLED,
  ];
  if (TERMINAL_RESOLVED_STATUSES.includes(transferRecord.status)) {
    return sendError(response, 409, 'Transfer request has already been resolved.');
  }

  // Pre-status check: must be awaiting joining or initial review
  const validRejectStatuses = [
    TRANSFER_STATUS.PENDING_TARGET_HM_APPROVAL,
    TRANSFER_STATUS.TRANSFER_REQUESTED,
    TRANSFER_STATUS.APPROVED,
    TRANSFER_STATUS.INITIATED,
    TRANSFER_STATUS.RELIEVED,
    TRANSFER_STATUS.AWAITING_DESTINATION_HM,
  ];
  if (!validRejectStatuses.includes(transferRecord.status)) {
    return sendError(
      response,
      400,
      `Transfer cannot be rejected. Current status is "${transferRecord.status}".`
    );
  }

  // Destination HM boundary check
  const destinationSchoolId = String(transferRecord.toSchoolId?._id || transferRecord.toSchoolId);
  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== destinationSchoolId) {
      await AuditLog.create({
        actorId:    requestingActor._id || requestingActor.userId,
        actorRole:  requestingActor.role,
        actorName:  requestingActor.fullName || '',
        action:     'CROSS_SCHOOL_TRANSFER_REJECTION_BLOCKED',
        targetModel: 'TransferRequest',
        targetId:   transferRecord._id,
        schoolId:   destinationSchoolId,
        result:     'DENIED',
        reason:     `HM from school ${actorSchoolId} attempted to reject transfer for target school ${destinationSchoolId}`,
        ipAddress:  request.ip || '',
        userAgent:  request.headers?.['user-agent'] || '',
        requestId:  request.headers?.['x-request-id'] || '',
      }).catch(() => {});
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
    let targetRejectStatus = TRANSFER_STATUS.REJECTED;
    if ([TRANSFER_STATUS.RELIEVED, TRANSFER_STATUS.AWAITING_DESTINATION_HM].includes(transferRecord.status)) {
      targetRejectStatus = TRANSFER_STATUS.REJECTED_BY_HM;
    }

    const updatedTransfer = await TransferRequest.findOneAndUpdate(
      {
        _id: transferRecord._id,
        status: { $in: validRejectStatuses },
      },
      {
        $set: {
          status:          targetRejectStatus,
          rejectedBy:      requestingActor._id || requestingActor.userId,
          rejectedAt:      new Date(),
          rejectionReason: rejectionReason.trim(),
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

    const employeeName =
      transferRecord.teacherUserId?.fullName ||
      transferRecord.employeeUserId?.fullName ||
      'Employee';

    // Write audit log
    await AuditLog.create(
      [{
        actorId:          requestingActor._id || requestingActor.userId,
        actorRole:        requestingActor.role,
        actorName:        requestingActor.fullName || '',
        action:           'TRANSFER_REJECTED',
        targetModel:      'TransferRequest',
        targetId:         transferRecord._id,
        targetName:       employeeName,
        schoolId:         destinationSchoolId,
        previousState: {
          status: transferRecord.status,
        },
        newState: {
          status:          targetRejectStatus,
          rejectedBy:      String(requestingActor._id || requestingActor.userId),
          rejectedAt:      new Date(),
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

    // Notify initiating official
    if (transferRecord.initiatedBy) {
      await dispatchNotificationEvent({
        eventType: 'TRANSFER_STATUS',
        category: 'GOVERNANCE',
        title: 'Transfer Request Rejected',
        message: `Transfer rejected: The transfer of ${employeeName} to ${transferRecord.toSchoolId?.name || 'Target School'} was rejected by the Target School Head Master. Reason: ${rejectionReason.trim()}`,
        actionLink: '/transfers',
        rawMetadata: {
          transferRequestId: String(transferRecord._id),
          teacherName: employeeName,
          employeeName,
          fromSchool: transferRecord.fromSchoolId?.name || '',
          toSchool: transferRecord.toSchoolId?.name || '',
          status: targetRejectStatus,
        },
        recipientUserIds: [String(transferRecord.initiatedBy._id || transferRecord.initiatedBy)],
      });
    }

    return sendSuccess(response, 200, 'Faculty joining rejected. Transfer record updated.', {
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
