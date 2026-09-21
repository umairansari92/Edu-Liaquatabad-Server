import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Document from '../models/Document.js';
import Organization from '../models/Organization.js';
import AuditLog from '../models/AuditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { ROLES, DOCUMENT_TYPES, AUDIENCE_TYPES } from '../../config/constants.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../utils/cloudinaryUploader.js';

const ALLOWED_HM_AUDIENCES = [AUDIENCE_TYPES.TEACHERS, AUDIENCE_TYPES.STUDENTS, AUDIENCE_TYPES.PARENTS];
const PROHIBITED_HM_TYPES = [DOCUMENT_TYPES.OFFICIAL_ORDER, DOCUMENT_TYPES.ANNOUNCEMENT, DOCUMENT_TYPES.PDF_BOOK, DOCUMENT_TYPES.SYLLABUS];

/**
 * Universal Authorization Resolver for Document Metadata & Binary Byte Delivery.
 * Enforces:
 *   - GLOBAL scope: Independent of townId; visible to matched audience or administrative roles.
 *   - TOWN scope: Bound to actor.townId and designated audience.
 *   - SCHOOL scope: Strict isolation to actor.schoolId. HM has full administrative visibility over own school.
 *   - Publisher always has access.
 */
export const authorizeDocumentAccess = (requestingActor, targetDocument) => {
  if (!requestingActor || !targetDocument) return false;

  // 1. Supreme & Operational Platform Administrators
  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role)) {
    return true;
  }

  // 2. Publisher always has access to their own document
  const publisherId = String(targetDocument.publishedBy?._id || targetDocument.publishedBy || '');
  const actorId = String(requestingActor._id || requestingActor.userId || '');
  if (publisherId && publisherId === actorId) {
    return true;
  }

  const documentAudience = targetDocument.targetAudience || [];

  // 3. Scope: GLOBAL (Municipality/Platform-wide — independent of townId)
  if (targetDocument.scope === 'GLOBAL') {
    if (documentAudience.includes(AUDIENCE_TYPES.ALL)) return true;
    if (requestingActor.role === ROLES.HM && documentAudience.includes(AUDIENCE_TYPES.HM)) return true;
    if (requestingActor.role === ROLES.TEACHER && documentAudience.includes(AUDIENCE_TYPES.TEACHERS)) return true;
    if (requestingActor.role === ROLES.STUDENT && documentAudience.includes(AUDIENCE_TYPES.STUDENTS)) return true;
    if (requestingActor.role === ROLES.PARENT && documentAudience.includes(AUDIENCE_TYPES.PARENTS)) return true;
    if ([ROLES.ADMIN, ROLES.SUPERVISOR].includes(requestingActor.role) && documentAudience.includes(AUDIENCE_TYPES.GOVERNMENT_OFFICERS)) return true;
    return false;
  }

  // 4. Scope: TOWN (Town Education Office Directives)
  if (targetDocument.scope === 'TOWN') {
    if (String(targetDocument.townId) !== String(requestingActor.townId)) {
      return false;
    }
    if (documentAudience.includes(AUDIENCE_TYPES.ALL)) return true;
    if (requestingActor.role === ROLES.HM && documentAudience.includes(AUDIENCE_TYPES.HM)) return true;
    if (requestingActor.role === ROLES.TEACHER && documentAudience.includes(AUDIENCE_TYPES.TEACHERS)) return true;
    if (requestingActor.role === ROLES.STUDENT && documentAudience.includes(AUDIENCE_TYPES.STUDENTS)) return true;
    if (requestingActor.role === ROLES.PARENT && documentAudience.includes(AUDIENCE_TYPES.PARENTS)) return true;
    if ([ROLES.ADMIN, ROLES.SUPERVISOR].includes(requestingActor.role) && documentAudience.includes(AUDIENCE_TYPES.GOVERNMENT_OFFICERS)) return true;
    return false;
  }

  // 5. Scope: SCHOOL (School Internal Notices & Circulars)
  if (targetDocument.scope === 'SCHOOL') {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    const documentSchoolId = String(targetDocument.schoolId?._id || targetDocument.schoolId || '');

    // Cross-school isolation tripwire
    if (!actorSchoolId || documentSchoolId !== actorSchoolId) {
      // Supervisor can inspect assigned cluster schools; Town Admin can inspect town schools
      if (requestingActor.role === ROLES.ADMIN && String(requestingActor.townId) === String(targetDocument.townId)) {
        return true;
      }
      if (requestingActor.role === ROLES.SUPERVISOR) {
        const assignedSchoolIds = (requestingActor.assignedSchools || []).map((schoolItem) =>
          String(schoolItem?._id || schoolItem)
        );
        if (assignedSchoolIds.includes(documentSchoolId)) return true;
      }
      return false;
    }

    // HM has full administrative visibility over all documents within their assigned school
    if (requestingActor.role === ROLES.HM) {
      return true;
    }

    // Internal school members check audience matching
    if (documentAudience.includes(AUDIENCE_TYPES.ALL)) return true;
    if (requestingActor.role === ROLES.TEACHER && documentAudience.includes(AUDIENCE_TYPES.TEACHERS)) return true;
    if (requestingActor.role === ROLES.STUDENT && documentAudience.includes(AUDIENCE_TYPES.STUDENTS)) return true;
    if (requestingActor.role === ROLES.PARENT && documentAudience.includes(AUDIENCE_TYPES.PARENTS)) return true;
    return false;
  }

  return false;
};

/**
 * GET /api/v1/documents
 * Retrieves official documents, circulars, and notices.
 * Strictly scoped according to actor's institutional jurisdiction, category, and audience.
 */
export const handleGetDocuments = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { documentType, scopeCategory, search, status = 'PUBLISHED' } = request.query;

  // Pagination with hard clamping (max 100)
  const pageNumber = Math.max(1, parseInt(request.query.page, 10) || 1);
  const limitNumber = Math.min(100, Math.max(1, parseInt(request.query.limit, 10) || 20));
  const skipCount = (pageNumber - 1) * limitNumber;

  const query = { status };

  if (documentType && Object.values(DOCUMENT_TYPES).includes(documentType)) {
    query.documentType = documentType;
  }

  // Sanitized regex search with special character escaping
  const rawSearch = typeof search === 'string' ? search.trim().slice(0, 100) : '';
  if (rawSearch) {
    const escapedSearch = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.title = { $regex: escapedSearch, $options: 'i' };
  }

  // Scope & audience query construction for school leaders & constituents
  if (actor.role === ROLES.HM) {
    const actorSchoolId = actor.schoolId?._id || actor.schoolId;

    if (scopeCategory === 'school') {
      query.scope = 'SCHOOL';
      query.schoolId = actorSchoolId;
    } else if (scopeCategory === 'department') {
      query.$or = [
        { scope: 'TOWN', townId: actor.townId, targetAudience: { $in: [AUDIENCE_TYPES.ALL, AUDIENCE_TYPES.HM] } },
        { scope: 'GLOBAL', targetAudience: { $in: [AUDIENCE_TYPES.ALL, AUDIENCE_TYPES.HM] } },
      ];
    } else {
      // Default: 'all' communications accessible to this HM
      query.$or = [
        { scope: 'SCHOOL', schoolId: actorSchoolId },
        { scope: 'TOWN', townId: actor.townId, targetAudience: { $in: [AUDIENCE_TYPES.ALL, AUDIENCE_TYPES.HM] } },
        { scope: 'GLOBAL', targetAudience: { $in: [AUDIENCE_TYPES.ALL, AUDIENCE_TYPES.HM] } },
        { publishedBy: actor._id },
      ];
    }
  } else if ([ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT, ROLES.PEON].includes(actor.role)) {
    const actorSchoolId = actor.schoolId?._id || actor.schoolId;
    let audienceFilter = [AUDIENCE_TYPES.ALL];
    if (actor.role === ROLES.TEACHER) audienceFilter.push(AUDIENCE_TYPES.TEACHERS);
    if (actor.role === ROLES.STUDENT) audienceFilter.push(AUDIENCE_TYPES.STUDENTS);
    if (actor.role === ROLES.PARENT) audienceFilter.push(AUDIENCE_TYPES.PARENTS);

    query.$or = [
      { scope: 'SCHOOL', schoolId: actorSchoolId, targetAudience: { $in: audienceFilter } },
      { scope: 'TOWN', townId: actor.townId, targetAudience: { $in: audienceFilter } },
      { scope: 'GLOBAL', targetAudience: { $in: audienceFilter } },
      { publishedBy: actor._id },
    ];
  } else if (actor.role === ROLES.ADMIN) {
    if (scopeCategory === 'school') {
      query.scope = 'SCHOOL';
      query.townId = actor.townId;
    } else {
      query.$or = [
        { townId: actor.townId },
        { scope: 'GLOBAL' },
      ];
    }
  }

  const documents = await Document.find(query)
    .populate('schoolId', 'name code')
    .populate('publishedBy', 'fullName designation role')
    .sort({ isPinned: -1, createdAt: -1 })
    .limit(limitNumber)
    .skip(skipCount)
    .lean();

  const totalCount = await Document.countDocuments(query);

  return sendSuccess(response, 200, 'Documents and circulars retrieved successfully.', {
    documents,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      total: totalCount,
      pages: Math.ceil(totalCount / limitNumber) || 1,
    },
  });
});

/**
 * GET /api/v1/documents/:id
 * Fetches metadata for a single document with scope authorization verification.
 */
export const handleGetDocumentById = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id: documentId } = request.params;

  if (!documentId || !/^[0-9a-fA-F]{24}$/.test(documentId)) {
    return sendError(response, 400, 'Invalid document ID format.');
  }

  const targetDocument = await Document.findById(documentId)
    .populate('schoolId', 'name code')
    .populate('publishedBy', 'fullName designation role')
    .lean();

  if (!targetDocument) {
    return sendError(response, 404, 'Document not found.');
  }

  const isAuthorized = authorizeDocumentAccess(actor, targetDocument);
  if (!isAuthorized) {
    return sendError(response, 403, 'Access denied. You are not authorized to view this document.');
  }

  return sendSuccess(response, 200, 'Document retrieved successfully.', { document: targetDocument });
});

/**
 * GET /api/v1/documents/:id/view
 * Secure document byte delivery endpoint.
 * Applies the exact same authorization resolver before providing the verified delivery URL.
 */
export const handleViewDocument = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id: documentId } = request.params;

  if (!documentId || !/^[0-9a-fA-F]{24}$/.test(documentId)) {
    return sendError(response, 400, 'Invalid document ID format.');
  }

  const targetDocument = await Document.findById(documentId).lean();
  if (!targetDocument) {
    return sendError(response, 404, 'Document not found.');
  }

  const isAuthorized = authorizeDocumentAccess(actor, targetDocument);
  if (!isAuthorized) {
    return sendError(response, 403, 'Access denied. You are not authorized to access this document attachment.');
  }

  return sendSuccess(response, 200, 'Document delivery authorized.', {
    documentId: targetDocument._id,
    title: targetDocument.title,
    viewUrl: targetDocument.fileUrl,
    fileMimeType: targetDocument.fileMimeType,
    fileSizeBytes: targetDocument.fileSizeBytes,
  });
});

/**
 * POST /api/v1/documents
 * Publishes an official school circular or departmental order.
 * Enforces:
 *   - Semantic authority check: HM cannot select OFFICIAL_ORDER or ANNOUNCEMENT.
 *   - HM Guardrails: scope locked to SCHOOL, schoolId locked to actor.schoolId, audience restricted.
 *   - Priority / isPinned invariant: priority === 'URGENT' sets isPinned = true.
 *   - Cloudinary upload with compensation: uploaded asset is deleted if DB transaction fails.
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
    referenceNumber,
    priority = 'NORMAL',
    schoolId,
    townId,
  } = request.body || {};

  if (!title || !documentType) {
    return sendError(response, 400, 'Title and documentType are required.');
  }

  if (!Object.values(DOCUMENT_TYPES).includes(documentType)) {
    return sendError(response, 400, `Invalid documentType "${documentType}".`);
  }

  // ─── Semantic Authority Checking ───────────────────────────────────────────
  if (actor.role === ROLES.HM && PROHIBITED_HM_TYPES.includes(documentType)) {
    return sendError(
      response,
      403,
      'Access denied. Head Masters cannot issue official departmental orders or public announcements. Permitted types for school leadership: NOTICE, CIRCULAR, MEETING_NOTIFICATION.'
    );
  }

  // ─── HM Scoping & Boundary Guardrails ──────────────────────────────────────
  let effectiveScope = 'SCHOOL';
  let effectiveSchoolId = schoolId;
  let effectiveTownId = townId;

  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId) {
      return sendError(response, 403, 'Your HM account has no assigned school linkage.');
    }
    // Anti-BOLA Tripwire: HM cannot publish for a foreign school
    if (schoolId && String(schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot publish notices for another school.');
    }
    effectiveSchoolId = actorSchoolId;
    effectiveScope = 'SCHOOL';
    effectiveTownId = actor.townId || null;

    // Audience Check: Restricted strictly to subsets of [TEACHERS, STUDENTS, PARENTS]
    if (typeof targetAudience === 'string') {
      try {
        targetAudience = JSON.parse(targetAudience);
      } catch {
        targetAudience = [targetAudience];
      }
    }
    if (!Array.isArray(targetAudience)) {
      targetAudience = [targetAudience];
    }

    const invalidAudiences = targetAudience.filter((aud) => !ALLOWED_HM_AUDIENCES.includes(aud));
    if (
      invalidAudiences.length > 0 ||
      targetAudience.includes(AUDIENCE_TYPES.ALL) ||
      targetAudience.includes(AUDIENCE_TYPES.GOVERNMENT_OFFICERS)
    ) {
      return sendError(
        response,
        403,
        `Access denied. Head Masters can only broadcast to school audiences: ${ALLOWED_HM_AUDIENCES.join(', ')}. Global or town-wide audiences are prohibited.`
      );
    }
    if (targetAudience.length === 0) {
      targetAudience = [AUDIENCE_TYPES.TEACHERS];
    }
  } else if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actor.role)) {
    effectiveScope = schoolId ? 'SCHOOL' : townId ? 'TOWN' : 'GLOBAL';
  } else if (actor.role === ROLES.ADMIN) {
    effectiveScope = schoolId ? 'SCHOOL' : 'TOWN';
    effectiveTownId = actor.townId;
  }

  // ─── Cloudinary Upload & Two-Phase Safety ──────────────────────────────────
  let cloudinaryResult = null;
  let resolvedFileUrl = fileUrl;
  let resolvedPublicId = cloudinaryPublicId;
  let resolvedMimeType = fileMimeType;
  let resolvedSizeBytes = Number(fileSizeBytes) || 0;

  if (request.file) {
    try {
      cloudinaryResult = await uploadBufferToCloudinary(request.file.buffer, {
        folder: `liaquatabad_sms/schools/${effectiveSchoolId || 'general'}/documents`,
        resource_type: request.file.mimetype.startsWith('image/') ? 'image' : 'raw',
      });
      resolvedFileUrl = cloudinaryResult.secureUrl || cloudinaryResult.secure_url || cloudinaryResult.url;
      resolvedPublicId = cloudinaryResult.publicId || cloudinaryResult.public_id;
      resolvedMimeType = request.file.mimetype;
      resolvedSizeBytes = request.file.size;
    } catch (uploadError) {
      return sendError(response, 502, `Attachment upload failed: ${uploadError.message}`);
    }
  }

  if (!resolvedFileUrl) {
    return sendError(response, 400, 'A document attachment or fileUrl is required.');
  }

  // ─── Resolve Organization ──────────────────────────────────────────────────
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

  const isUrgent = priority === 'URGENT';

  // ─── Atomic Database Transaction with Compensation Cleanup ────────────────
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const createdDocuments = await Document.create([{
      organizationId: targetOrganizationId,
      townId: effectiveTownId,
      schoolId: effectiveSchoolId,
      scope: effectiveScope,
      title: title.trim(),
      referenceNumber: referenceNumber ? String(referenceNumber).trim() : null,
      documentType,
      description: description ? String(description).trim() : '',
      fileUrl: resolvedFileUrl.trim(),
      cloudinaryPublicId: resolvedPublicId ? resolvedPublicId.trim() : `doc_${Date.now()}`,
      fileMimeType: resolvedMimeType,
      fileSizeBytes: resolvedSizeBytes,
      priority: isUrgent ? 'URGENT' : 'NORMAL',
      isPinned: isUrgent,
      targetAudience,
      publishedBy: actor._id,
      publisherRole: actor.role,
      status: 'PUBLISHED',
    }], { session });

    const newDocument = createdDocuments[0];

    await AuditLog.create([{
      actorId: actor._id,
      actorRole: actor.role,
      actorDesignation: actor.designation || '',
      actorName: actor.fullName,
      action: 'DOCUMENT_PUBLISHED',
      targetModel: 'Document',
      targetId: newDocument._id,
      targetName: newDocument.title,
      schoolId: newDocument.schoolId,
      newState: {
        title: newDocument.title,
        documentType,
        scope: newDocument.scope,
        targetAudience,
        referenceNumber: newDocument.referenceNumber,
        priority: newDocument.priority,
      },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers?.['user-agent'] || '',
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return sendSuccess(response, 201, `Document "${title}" published successfully.`, { document: newDocument });
  } catch (transactionError) {
    await session.abortTransaction();
    session.endSession();

    const orphanAssetId = cloudinaryResult?.publicId || cloudinaryResult?.public_id;
    if (orphanAssetId) {
      try {
        await deleteFromCloudinary(
          orphanAssetId,
          request.file?.mimetype?.startsWith('image/') ? 'image' : 'raw'
        );
      } catch (compensationError) {
        console.error('[CRITICAL] Cloudinary compensation cleanup failed:', compensationError.message);
      }
    }
    throw transactionError;
  }
});

/**
 * PATCH /api/v1/documents/:id/archive
 * Lifecycle transition: PUBLISHED -> ARCHIVED.
 * Strict authority: HM can ONLY archive school notices belonging to their assigned school.
 * Departmental/Town directives are strictly protected from HM archival.
 */
export const handleArchiveDocument = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id: documentId } = request.params;

  if (!documentId || !/^[0-9a-fA-F]{24}$/.test(documentId)) {
    return sendError(response, 400, 'Invalid document ID format.');
  }

  const targetDocument = await Document.findById(documentId);
  if (!targetDocument) {
    return sendError(response, 404, 'Document not found.');
  }

  // Authority Scope Guard
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (targetDocument.scope !== 'SCHOOL' || String(targetDocument.schoolId) !== actorSchoolId) {
      return sendError(
        response,
        403,
        'Access denied. Head Masters can only archive internal circulars issued by their own assigned school.'
      );
    }
  } else if (![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(actor.role)) {
    return sendError(response, 403, 'Access denied. Insufficient institutional authority to archive documents.');
  }

  // Lifecycle State Machine Check
  if (targetDocument.status === 'ARCHIVED') {
    return sendError(response, 400, 'Document is already archived.');
  }
  if (targetDocument.status !== 'PUBLISHED') {
    return sendError(response, 400, `Cannot archive document with status "${targetDocument.status}".`);
  }

  const previousState = { status: targetDocument.status };
  targetDocument.status = 'ARCHIVED';
  await targetDocument.save();

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'DOCUMENT_ARCHIVED',
    targetModel: 'Document',
    targetId: targetDocument._id,
    targetName: targetDocument.title,
    schoolId: targetDocument.schoolId,
    previousState,
    newState: { status: 'ARCHIVED' },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
  });

  return sendSuccess(response, 200, `Document "${targetDocument.title}" archived successfully.`, {
    document: targetDocument,
  });
});

/**
 * DELETE /api/v1/documents/:id
 * Audited Hard Delete: Permanently purges MongoDB record and Cloudinary asset to eliminate bloat.
 * Invariant: AuditLog preserves a complete metadata snapshot (previousState) for SuperAdmin inspection.
 */
export const handleDeleteDocument = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id: documentId } = request.params;
  const { reason = 'Operational document purged by school leadership' } = request.body || {};

  if (!documentId || !/^[0-9a-fA-F]{24}$/.test(documentId)) {
    return sendError(response, 400, 'Invalid document ID format.');
  }

  const targetDocument = await Document.findById(documentId);
  if (!targetDocument) {
    return sendError(response, 404, 'Document not found.');
  }

  // Authority Scope Guard
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (targetDocument.scope !== 'SCHOOL' || String(targetDocument.schoolId) !== actorSchoolId) {
      return sendError(
        response,
        403,
        'Access denied. Head Masters can only delete circulars issued by their own assigned school.'
      );
    }
  } else if (![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(actor.role)) {
    return sendError(response, 403, 'Access denied. Insufficient institutional authority to delete documents.');
  }

  // Capture complete metadata snapshot for audit preservation
  const previousStateSnapshot = {
    title: targetDocument.title,
    referenceNumber: targetDocument.referenceNumber || null,
    documentType: targetDocument.documentType,
    scope: targetDocument.scope,
    schoolId: targetDocument.schoolId,
    townId: targetDocument.townId,
    targetAudience: targetDocument.targetAudience,
    publishedBy: targetDocument.publishedBy,
    publisherRole: targetDocument.publisherRole,
    status: targetDocument.status,
    fileUrl: targetDocument.fileUrl,
    cloudinaryPublicId: targetDocument.cloudinaryPublicId,
    fileMimeType: targetDocument.fileMimeType,
    fileSizeBytes: targetDocument.fileSizeBytes,
    createdAt: targetDocument.createdAt,
  };

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await Document.deleteOne({ _id: targetDocument._id }).session(session);

    await AuditLog.create([{
      actorId: actor._id,
      actorRole: actor.role,
      actorDesignation: actor.designation || '',
      actorName: actor.fullName,
      action: 'DOCUMENT_DELETED',
      targetModel: 'Document',
      targetId: targetDocument._id,
      targetName: targetDocument.title,
      schoolId: targetDocument.schoolId,
      previousState: previousStateSnapshot,
      newState: null,
      result: 'SUCCESS',
      reason: String(reason).trim(),
      ipAddress: request.ip || '',
      userAgent: request.headers?.['user-agent'] || '',
    }], { session });

    await session.commitTransaction();
    session.endSession();
  } catch (deleteError) {
    await session.abortTransaction();
    session.endSession();
    throw deleteError;
  }

  // Purge asset from Cloudinary CDN to reclaim storage
  if (targetDocument.cloudinaryPublicId) {
    try {
      await deleteFromCloudinary(
        targetDocument.cloudinaryPublicId,
        targetDocument.fileMimeType?.startsWith('image/') ? 'image' : 'raw'
      );
    } catch (cloudinaryDeleteError) {
      console.error('[Cloudinary Purge Warning]', cloudinaryDeleteError.message);
    }
  }

  return sendSuccess(response, 200, `Document "${targetDocument.title}" deleted and purged successfully.`, {
    deletedDocumentId: targetDocument._id,
  });
});
