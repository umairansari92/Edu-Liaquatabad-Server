import asyncHandler from 'express-async-handler';
import Document from '../models/Document.js';
import Organization from '../models/Organization.js';
import AuditLog from '../models/AuditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { ROLES, DOCUMENT_TYPES, AUDIENCE_TYPES } from '../../config/constants.js';

const ALLOWED_HM_AUDIENCES = [AUDIENCE_TYPES.TEACHERS, AUDIENCE_TYPES.STUDENTS, AUDIENCE_TYPES.PARENTS];

/**
 * GET /api/v1/documents
 * Retrieves official documents, circulars, and notices.
 * Strictly scoped according to actor's institutional jurisdiction and audience.
 */
export const handleGetDocuments = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { documentType, search, limit = 50, skip = 0 } = request.query;

  const query = { status: 'PUBLISHED' };

  if (documentType && Object.values(DOCUMENT_TYPES).includes(documentType)) {
    query.documentType = documentType;
  }

  if (search && search.trim()) {
    query.title = { $regex: search.trim(), $options: 'i' };
  }

  // Scope filtering
  if ([ROLES.HM, ROLES.TEACHER, ROLES.STUDENT, ROLES.PEON].includes(actor.role)) {
    const actorSchoolId = actor.schoolId?._id || actor.schoolId;
    query.$or = [
      { schoolId: actorSchoolId },
      { schoolId: null, townId: actor.townId },
      { schoolId: null, townId: null },
    ];

    // Role-based audience visibility
    let audienceFilter = [AUDIENCE_TYPES.ALL];
    if (actor.role === ROLES.HM) audienceFilter.push(AUDIENCE_TYPES.HM);
    if (actor.role === ROLES.TEACHER) audienceFilter.push(AUDIENCE_TYPES.TEACHERS);
    if (actor.role === ROLES.STUDENT) audienceFilter.push(AUDIENCE_TYPES.STUDENTS);

    query.targetAudience = { $in: audienceFilter };
  }

  const documents = await Document.find(query)
    .populate('schoolId', 'name code')
    .populate('publishedBy', 'fullName designation role')
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .skip(Number(skip))
    .lean();

  const total = await Document.countDocuments(query);

  return sendSuccess(response, 200, 'Documents and circulars retrieved successfully.', {
    documents,
    total,
  });
});

/**
 * POST /api/v1/documents
 * Publishes an official notice, circular, or departmental order.
 * HM Guardrail: HM can only publish notices within their own school scope,
 * and target audience must be restricted to TEACHERS, STUDENTS, PARENTS.
 * HM town-wide/global publication is strictly rejected.
 */
export const handleCreateDocument = asyncHandler(async (request, response) => {
  const actor = request.user;
  let {
    title,
    documentType,
    description = '',
    fileUrl,
    cloudinaryPublicId,
    fileMimeType = 'application/pdf',
    fileSizeBytes = 0,
    targetAudience = [],
    schoolId,
    townId,
  } = request.body;

  if (!title || !documentType || !fileUrl) {
    return sendError(response, 400, 'Title, documentType, and fileUrl are required.');
  }

  // Resolve Organization
  let targetOrganizationId = actor.organizationId;
  if (!targetOrganizationId) {
    let defaultOrg = await Organization.findOne({ code: 'DMC_LIAQUATABAD' });
    if (!defaultOrg) {
      defaultOrg = await Organization.create({
        name: 'Liaquatabad Town DMC Education Department',
        code: 'DMC_LIAQUATABAD',
      });
    }
    targetOrganizationId = defaultOrg._id;
  }

  // ─── Strict HM Guardrails ──────────────────────────────────────────────────
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId) {
      return sendError(response, 403, 'Your HM account has no assigned school.');
    }
    if (schoolId && String(schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot publish notices for another school.');
    }
    schoolId = actorSchoolId;
    townId = null; // HM cannot set town-level broadcast

    // Audience check: Must strictly be within [TEACHERS, STUDENTS, PARENTS]
    const invalidAudiences = targetAudience.filter((aud) => !ALLOWED_HM_AUDIENCES.includes(aud));
    if (invalidAudiences.length > 0 || targetAudience.includes(AUDIENCE_TYPES.ALL) || targetAudience.includes(AUDIENCE_TYPES.GOVERNMENT_OFFICERS)) {
      return sendError(
        response,
        403,
        `Access denied. Head Masters can only broadcast to school audiences: ${ALLOWED_HM_AUDIENCES.join(', ')}. Global or town-wide audiences are prohibited.`
      );
    }
    if (targetAudience.length === 0) {
      targetAudience = [AUDIENCE_TYPES.TEACHERS];
    }
  }

  const newDoc = await Document.create({
    organizationId: targetOrganizationId,
    townId: townId || actor.townId || null,
    schoolId: schoolId || (actor.role === ROLES.HM ? actor.schoolId : null),
    title: title.trim(),
    documentType,
    description: description.trim(),
    fileUrl: fileUrl.trim(),
    cloudinaryPublicId: cloudinaryPublicId ? cloudinaryPublicId.trim() : `doc_${Date.now()}`,
    fileMimeType,
    fileSizeBytes: Number(fileSizeBytes) || 0,
    targetAudience,
    publishedBy: actor._id,
    publisherRole: actor.role,
    status: 'PUBLISHED',
  });

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'DOCUMENT_PUBLISHED',
    targetModel: 'Document',
    targetId: newDoc._id,
    targetName: newDoc.title,
    schoolId: newDoc.schoolId,
    newState: { title: newDoc.title, documentType, targetAudience },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 201, `Document "${title}" published successfully.`, { document: newDoc });
});
