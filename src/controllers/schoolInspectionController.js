/**
 * Municipal School Inspection Controller
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Implements inspection logging, status transitions,
 * infrastructure assessments, and remedial action tracking
 * with strict jurisdictional cluster scoping.
 */

import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import SchoolInspection, { INSPECTION_STATUS } from '../models/SchoolInspection.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES } from '../../config/constants.js';
import { resolveAcademicSession } from '../services/attendanceRollupService.js';

/**
 * POST /api/v1/inspections
 * Create a new school inspection record.
 * Allowed actors: SUPERVISOR (assigned schools only), ADMIN, SUPER_ADMIN, ROOT_ADMIN
 */
export const handleCreateInspection = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    schoolId: targetSchoolId,
    inspectionDate,
    academicSession,
    overallGrade,
    summaryScore,
    infrastructure,
    academicEnvironment,
    attendanceAudit,
    remedialDirectives,
    supervisorNotes,
    status = INSPECTION_STATUS.DRAFT,
  } = request.body;

  // 1. Verify Target School Exists
  const schoolRecord = await School.findById(targetSchoolId).lean();
  if (!schoolRecord) {
    return sendError(response, 404, 'Municipal school entity not found.');
  }

  // 2. Enforce Jurisdictional Boundaries
  if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map(String);
    if (!assignedSchoolIds.includes(String(targetSchoolId))) {
      await AuditLog.create({
        actorId: requestingActor._id,
        actorRole: requestingActor.role,
        actorName: requestingActor.fullName || '',
        action: 'SUPERVISOR_CROSS_SCHOOL_INSPECTION_BLOCKED',
        targetModel: 'SchoolInspection',
        targetId: targetSchoolId,
        targetName: schoolRecord.name,
        schoolId: targetSchoolId,
        previousState: { assignedSchools: assignedSchoolIds },
        result: 'DENIED',
        reason: 'BOLA violation intercepted: Supervisor attempted to create inspection for unassigned school.',
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
      });
      return sendError(response, 403, 'Access denied. You can only inspect municipal schools in your assigned cluster.');
    }
  } else if (requestingActor.role === ROLES.ADMIN) {
    if (String(schoolRecord.townId) !== String(requestingActor.townId)) {
      return sendError(response, 403, 'Access denied. Target school is outside your municipal town jurisdiction.');
    }
  }

  const determinedSession = academicSession || resolveAcademicSession(inspectionDate ? new Date(inspectionDate) : new Date());

  const newInspection = await SchoolInspection.create({
    schoolId: targetSchoolId,
    supervisorId: requestingActor._id,
    inspectionDate: inspectionDate ? new Date(inspectionDate) : new Date(),
    academicSession: determinedSession,
    status,
    overallGrade,
    summaryScore,
    infrastructure: infrastructure || {},
    academicEnvironment: academicEnvironment || {},
    attendanceAudit: attendanceAudit || {},
    remedialDirectives: remedialDirectives || [],
    supervisorNotes: supervisorNotes || '',
  });

  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName || '',
    action: 'INSPECTION_CREATED',
    targetModel: 'SchoolInspection',
    targetId: newInspection._id,
    targetName: `Inspection: ${schoolRecord.name}`,
    schoolId: targetSchoolId,
    newState: {
      inspectionId: newInspection._id,
      schoolId: targetSchoolId,
      status: newInspection.status,
      overallGrade: newInspection.overallGrade,
    },
    result: 'SUCCESS',
    reason: `Official municipal inspection logged for ${schoolRecord.name}`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 201, 'School inspection record created successfully.', {
    inspection: newInspection,
  });
});

/**
 * GET /api/v1/inspections
 * Retrieve list of inspection records scoped by actor authority.
 */
export const handleGetInspections = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    schoolId,
    status,
    academicSession,
    page = 1,
    limit = 50,
  } = request.query;

  const filterCriteria = { isArchived: false };

  // Authority Scope Filtering
  if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = requestingActor.assignedSchools || [];
    filterCriteria.schoolId = { $in: assignedSchoolIds };
    if (schoolId) {
      if (!assignedSchoolIds.map(String).includes(String(schoolId))) {
        return sendError(response, 403, 'Access denied. Specified school is outside your assigned cluster.');
      }
      filterCriteria.schoolId = schoolId;
    }
  } else if (requestingActor.role === ROLES.HM) {
    filterCriteria.schoolId = requestingActor.schoolId;
  } else if (requestingActor.role === ROLES.ADMIN) {
    if (schoolId) {
      filterCriteria.schoolId = schoolId;
    }
  }

  if (status) {
    filterCriteria.status = status;
  }

  if (academicSession) {
    filterCriteria.academicSession = academicSession;
  }

  const safePageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimitNumber = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const skipCount = (safePageNumber - 1) * safeLimitNumber;

  const [inspectionsList, totalCount] = await Promise.all([
    SchoolInspection.find(filterCriteria)
      .populate('schoolId', 'name schoolCode emisCode schoolType address')
      .populate('supervisorId', 'fullName designation email phoneNumber')
      .sort({ inspectionDate: -1, createdAt: -1 })
      .skip(skipCount)
      .limit(safeLimitNumber)
      .lean(),
    SchoolInspection.countDocuments(filterCriteria),
  ]);

  return sendSuccess(response, 200, 'School inspections retrieved successfully.', {
    inspections: inspectionsList,
    total: totalCount,
    page: safePageNumber,
    totalPages: Math.ceil(totalCount / safeLimitNumber),
  });
});

/**
 * GET /api/v1/inspections/:id
 * Retrieve single inspection report with full verifications and directives.
 */
export const handleGetInspectionById = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: inspectionId } = request.params;

  const inspectionRecord = await SchoolInspection.findById(inspectionId)
    .populate('schoolId', 'name schoolCode emisCode schoolType address contactPhone contactEmail')
    .populate('supervisorId', 'fullName designation email phoneNumber')
    .lean();

  if (!inspectionRecord) {
    return sendError(response, 404, 'School inspection record not found.');
  }

  // Scoping Guard
  if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map(String);
    const targetSchoolId = String(inspectionRecord.schoolId?._id || inspectionRecord.schoolId);
    if (!assignedSchoolIds.includes(targetSchoolId)) {
      return sendError(response, 403, 'Access denied. Inspection report belongs to a school outside your cluster.');
    }
  } else if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId);
    const targetSchoolId = String(inspectionRecord.schoolId?._id || inspectionRecord.schoolId);
    if (actorSchoolId !== targetSchoolId) {
      return sendError(response, 403, 'Access denied. You can only view inspections for your own assigned school.');
    }
  }

  return sendSuccess(response, 200, 'Inspection report retrieved successfully.', {
    inspection: inspectionRecord,
  });
});

/**
 * PATCH /api/v1/inspections/:id
 * Update a draft inspection report or modify remedial directives.
 */
export const handleUpdateInspection = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: inspectionId } = request.params;

  const inspectionRecord = await SchoolInspection.findById(inspectionId);
  if (!inspectionRecord) {
    return sendError(response, 404, 'School inspection record not found.');
  }

  // Ownership & Scoping Guard
  if (requestingActor.role === ROLES.SUPERVISOR) {
    if (String(inspectionRecord.supervisorId) !== String(requestingActor._id)) {
      return sendError(response, 403, 'Access denied. You can only update inspections logged by yourself.');
    }
    if (inspectionRecord.status === INSPECTION_STATUS.CLOSED) {
      return sendError(response, 400, 'Cannot edit an inspection that has already been CLOSED.');
    }
  }

  const previousSnapshot = inspectionRecord.toObject();

  // Apply updates
  const allowedFields = [
    'overallGrade',
    'summaryScore',
    'infrastructure',
    'academicEnvironment',
    'attendanceAudit',
    'remedialDirectives',
    'supervisorNotes',
    'status',
    'resolutionNotes',
  ];

  for (const fieldName of allowedFields) {
    if (request.body[fieldName] !== undefined) {
      inspectionRecord[fieldName] = request.body[fieldName];
    }
  }

  await inspectionRecord.save();

  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName || '',
    action: 'INSPECTION_UPDATED',
    targetModel: 'SchoolInspection',
    targetId: inspectionRecord._id,
    schoolId: inspectionRecord.schoolId,
    previousState: {
      status: previousSnapshot.status,
      overallGrade: previousSnapshot.overallGrade,
      summaryScore: previousSnapshot.summaryScore,
    },
    newState: {
      status: inspectionRecord.status,
      overallGrade: inspectionRecord.overallGrade,
      summaryScore: inspectionRecord.summaryScore,
    },
    result: 'SUCCESS',
    reason: 'School inspection report modified',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, 'Inspection report updated successfully.', {
    inspection: inspectionRecord,
  });
});

/**
 * POST /api/v1/inspections/:id/submit
 * Transition inspection from DRAFT to SUBMITTED or ACTION_REQUIRED.
 */
export const handleSubmitInspection = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: inspectionId } = request.params;

  const inspectionRecord = await SchoolInspection.findById(inspectionId);
  if (!inspectionRecord) {
    return sendError(response, 404, 'School inspection record not found.');
  }

  if (requestingActor.role === ROLES.SUPERVISOR) {
    if (String(inspectionRecord.supervisorId) !== String(requestingActor._id)) {
      return sendError(response, 403, 'Access denied. You can only submit inspections authored by yourself.');
    }
  }

  // Determine next state: ACTION_REQUIRED if high priority directives exist or grade is C/D, else SUBMITTED
  const hasUrgentDirectives = (inspectionRecord.remedialDirectives || []).some(
    (directiveItem) => directiveItem.priority === 'HIGH' && directiveItem.status === 'PENDING'
  );
  const requiresAction = hasUrgentDirectives || ['C', 'D'].includes(inspectionRecord.overallGrade);

  const previousStatus = inspectionRecord.status;
  inspectionRecord.status = requiresAction ? INSPECTION_STATUS.ACTION_REQUIRED : INSPECTION_STATUS.SUBMITTED;
  await inspectionRecord.save();

  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName || '',
    action: 'INSPECTION_SUBMITTED',
    targetModel: 'SchoolInspection',
    targetId: inspectionRecord._id,
    schoolId: inspectionRecord.schoolId,
    previousState: { status: previousStatus },
    newState: { status: inspectionRecord.status },
    result: 'SUCCESS',
    reason: `Official inspection finalized and submitted (Status: ${inspectionRecord.status})`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, `Inspection finalized and submitted as ${inspectionRecord.status}.`, {
    inspection: inspectionRecord,
  });
});

/**
 * PATCH /api/v1/inspections/:id/close
 * Formal closure of inspection after directives are confirmed remediated.
 */
export const handleCloseInspection = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: inspectionId } = request.params;
  const { resolutionNotes } = request.body;

  const inspectionRecord = await SchoolInspection.findById(inspectionId);
  if (!inspectionRecord) {
    return sendError(response, 404, 'School inspection record not found.');
  }

  if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map(String);
    if (!assignedSchoolIds.includes(String(inspectionRecord.schoolId))) {
      return sendError(response, 403, 'Access denied. Cannot close inspection for an unassigned school.');
    }
  }

  inspectionRecord.status = INSPECTION_STATUS.CLOSED;
  inspectionRecord.resolutionDate = new Date();
  inspectionRecord.resolutionNotes = resolutionNotes || 'All inspection directives verified and closed.';

  // Mark all directives as resolved
  if (inspectionRecord.remedialDirectives && inspectionRecord.remedialDirectives.length > 0) {
    inspectionRecord.remedialDirectives.forEach((directiveItem) => {
      directiveItem.status = 'RESOLVED';
    });
  }

  await inspectionRecord.save();

  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName || '',
    action: 'INSPECTION_CLOSED',
    targetModel: 'SchoolInspection',
    targetId: inspectionRecord._id,
    schoolId: inspectionRecord.schoolId,
    newState: {
      status: inspectionRecord.status,
      resolutionDate: inspectionRecord.resolutionDate,
      resolutionNotes: inspectionRecord.resolutionNotes,
    },
    result: 'SUCCESS',
    reason: 'Inspection record formally closed and verified',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, 'Inspection report closed successfully.', {
    inspection: inspectionRecord,
  });
});
