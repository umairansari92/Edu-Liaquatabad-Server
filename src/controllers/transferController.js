import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import School from '../models/School.js';
import TransferRequest from '../models/TransferRequest.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, TRANSFER_STATUS } from '../../config/constants.js';

/**
 * POST /api/v1/transfers
 * Initiate a teacher transfer from one school to another.
 * ROOT_ADMIN and SUPER_ADMIN can transfer any teacher across any schools.
 * ADMIN can transfer teachers only within their townId.
 * Transfer record is created + teacher's schoolId updated + audit log written.
 */
export const handleInitiateTransfer = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { teacherUserId, targetSchoolId, reason, isEmergencyOverride, overrideJustification, officialOrderNumber } = request.body;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!teacherUserId || !/^[0-9a-fA-F]{24}$/.test(teacherUserId)) {
    return sendError(response, 400, 'A valid teacherUserId is required.');
  }
  if (!targetSchoolId || !/^[0-9a-fA-F]{24}$/.test(targetSchoolId)) {
    return sendError(response, 400, 'A valid targetSchoolId is required.');
  }
  if (!reason || reason.trim().length < 5) {
    return sendError(response, 400, 'A transfer reason of at least 5 characters is required.');
  }

  // ── Resolve target teacher ─────────────────────────────────────────────────
  const targetTeacher = await User.findById(teacherUserId).populate('schoolId', 'name townId _id');
  if (!targetTeacher) {
    return sendError(response, 404, 'Teacher not found in personnel registry.');
  }
  if (targetTeacher.role !== ROLES.TEACHER) {
    return sendError(response, 400, `Only personnel with TEACHER role can be transferred. Target role: ${targetTeacher.role}.`);
  }

  const sourceSchoolId = targetTeacher.schoolId?._id;
  if (!sourceSchoolId) {
    return sendError(response, 400, 'Teacher does not have a current school assignment. Assign a school first.');
  }

  if (String(sourceSchoolId) === String(targetSchoolId)) {
    return sendError(response, 400, 'Source and target school cannot be the same.');
  }

  // ── Resolve target school ──────────────────────────────────────────────────
  const targetSchool = await School.findById(targetSchoolId).lean();
  if (!targetSchool) {
    return sendError(response, 404, 'Target school not found in municipal registry.');
  }

  // ── Jurisdictional check for ADMIN actors ──────────────────────────────────
  if (requestingActor.role === ROLES.ADMIN) {
    const targetTownId = String(targetSchool.townId);
    const sourceTownId = String(targetTeacher.schoolId.townId);
    const actorTownId = String(requestingActor.townId);

    if (targetTownId !== actorTownId || sourceTownId !== actorTownId) {
      await AuditLog.create({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorName: requestingActor.fullName || '',
        action: 'ADMIN_CROSS_TOWN_TRANSFER_BLOCKED',
        targetModel: 'TransferRequest',
        targetId: targetTeacher._id,
        targetName: targetTeacher.fullName,
        townId: requestingActor.townId,
        previousState: { sourceTownId, targetTownId },
        result: 'DENIED',
        reason: `ADMIN attempted cross-town teacher transfer: source town=${sourceTownId}, target town=${targetTownId}, actor town=${actorTownId}`,
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        requestId: '',
      });
      return sendError(response, 403, 'Access denied. ADMIN actors can only transfer teachers within their own administrative town jurisdiction.');
    }
  }

  // ── Create transfer request ────────────────────────────────────────────────
  const transferRecord = await TransferRequest.create({
    teacherUserId,
    fromSchoolId: sourceSchoolId,
    toSchoolId: targetSchoolId,
    initiatedBy: requestingActor._id || requestingActor.userId,
    initiatorRole: requestingActor.role,
    isEmergencyOverride: isEmergencyOverride || false,
    overrideJustification: overrideJustification || '',
    reason: reason.trim(),
    officialOrderNumber: officialOrderNumber || '',
    status: TRANSFER_STATUS.INITIATED,
  });

  // ── Update teacher's schoolId immediately (direct ROOT_ADMIN/SUPER_ADMIN transfer) ──
  const previousSchoolId = String(sourceSchoolId);
  targetTeacher.schoolId = targetSchoolId;
  await targetTeacher.save();

  // ── Write immutable audit event ────────────────────────────────────────────
  await AuditLog.create({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: 'TEACHER_TRANSFER_INITIATED',
    targetModel: 'User',
    targetId: targetTeacher._id,
    targetName: targetTeacher.fullName,
    townId: requestingActor.townId || null,
    schoolId: targetSchoolId,
    previousState: {
      schoolId: previousSchoolId,
      schoolName: targetTeacher.schoolId?.name || 'Previous School',
    },
    newState: {
      schoolId: targetSchoolId,
      schoolName: targetSchool.name,
      transferRequestId: String(transferRecord._id),
    },
    result: 'SUCCESS',
    reason: reason.trim(),
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 201, `Teacher "${targetTeacher.fullName}" transfer to "${targetSchool.name}" initiated successfully.`, {
    transferRequest: {
      _id: transferRecord._id,
      status: transferRecord.status,
      teacherName: targetTeacher.fullName,
      fromSchool: targetTeacher.schoolId?.name || previousSchoolId,
      toSchool: targetSchool.name,
      reason: transferRecord.reason,
      createdAt: transferRecord.createdAt,
    },
  });
});

/**
 * GET /api/v1/transfers
 * List transfer requests with filters: teacherUserId, status, schoolId, limit, skip
 */
export const handleGetTransfers = asyncHandler(async (request, response) => {
  const { teacherUserId, status, fromSchoolId, toSchoolId, limit = 50, skip = 0 } = request.query;

  const queryFilter = {};
  if (teacherUserId && /^[0-9a-fA-F]{24}$/.test(teacherUserId)) queryFilter.teacherUserId = teacherUserId;
  if (status) queryFilter.status = status;
  if (fromSchoolId && /^[0-9a-fA-F]{24}$/.test(fromSchoolId)) queryFilter.fromSchoolId = fromSchoolId;
  if (toSchoolId && /^[0-9a-fA-F]{24}$/.test(toSchoolId)) queryFilter.toSchoolId = toSchoolId;

  const transfers = await TransferRequest.find(queryFilter)
    .populate('teacherUserId', 'fullName email designation')
    .populate('fromSchoolId', 'name schoolCode')
    .populate('toSchoolId', 'name schoolCode')
    .populate('initiatedBy', 'fullName role')
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
