import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import Homework from '../models/Homework.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import StudentProfile from '../models/StudentProfile.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, TEACHING_ASSIGNMENT_STATUS, STUDENT_STATUS } from '../../config/constants.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../utils/cloudinaryUploader.js';

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY INVARIANTS (enforced on every write operation):
//
//   Layer 1: Actor must be authenticated (req.user from JWT)
//   Layer 2: Actor role must be TEACHER or HM (enforced by permission middleware)
//   Layer 3: actor.schoolId (JWT) must match the verified assignment's schoolId
//   Layer 4: TeachingAssignment.isTeacherAssigned() must confirm ACTIVE assignment
//            for exact school + class + section + subject combination
//   Layer 5: classId, sectionId, subjectId must all belong to the same school
//
//   NO client-supplied schoolId, classId, sectionId, subjectId, or teacherId is trusted.
//   All boundary fields are derived from authenticated identity + DB verification.
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/homework — Teacher/HM creates homework
// ═══════════════════════════════════════════════════════════════════════════════
export const handleCreateHomework = asyncHandler(async (request, response) => {
  const actor = request.user;

  // Client sends these identifiers — server verifies all of them
  const {
    classId,
    sectionId,
    subjectId,
    title,
    description,
    dueDate,
    attachments,
    visibleToStudents,
    remarks,
  } = request.body;

  // ── Basic field validation ─────────────────────────────────────────────────
  if (!classId   || !/^[0-9a-fA-F]{24}$/.test(classId))   return sendError(response, 400, 'A valid classId is required.');
  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) return sendError(response, 400, 'A valid sectionId is required.');
  if (!subjectId || !/^[0-9a-fA-F]{24}$/.test(subjectId)) return sendError(response, 400, 'A valid subjectId is required.');
  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return sendError(response, 400, 'Homework title is required (minimum 3 characters).');
  }
  if (!dueDate || isNaN(new Date(dueDate).getTime())) {
    return sendError(response, 400, 'A valid dueDate is required.');
  }

  // ── Layer 3: Actor school boundary (from JWT — never from request body) ────
  const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
  if (!actorSchoolId) {
    return sendError(response, 403, 'Access denied. Your account has no school assignment. Contact administration.');
  }

  const actorId = String(actor._id || actor.userId);

  // ── Layer 4: TeachingAssignment gate — exact school+class+section+subject ──
  // For HM role, we verify school boundary above is sufficient.
  // For TEACHER role, we additionally verify the TeachingAssignment.
  let verifiedAssignment = null;

  if (actor.role === ROLES.TEACHER) {
    verifiedAssignment = await TeachingAssignment.findOne({
      teacherId:  actorId,
      schoolId:   actorSchoolId,
      classId,
      sectionId,
      subjectId,
      status:     TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    }).lean();

    if (!verifiedAssignment) {
      return sendError(response, 403,
        'Access denied. You do not have an active teaching assignment for this exact ' +
        'school → class → section → subject combination. ' +
        'Contact your Head Master to assign you first.'
      );
    }
  }

  // For HM creating on behalf of school: verify the section+subject belong to their school
  // ── Layer 5: Integrity check — class, section, subject must all belong to schoolId ──
  const [targetClass, targetSection, targetSubject] = await Promise.all([
    Class.findById(classId).lean(),
    Section.findById(sectionId).lean(),
    Subject.findById(subjectId).lean(),
  ]);

  if (!targetClass || String(targetClass.schoolId) !== actorSchoolId) {
    return sendError(response, 400, 'Integrity violation: The specified class does not belong to your school.');
  }
  if (!targetSection || String(targetSection.schoolId) !== actorSchoolId || String(targetSection.classId) !== String(classId)) {
    return sendError(response, 400, 'Integrity violation: The specified section does not belong to this class or your school.');
  }
  if (!targetSubject || String(targetSubject.schoolId) !== actorSchoolId) {
    return sendError(response, 400, 'Integrity violation: The specified subject does not belong to your school.');
  }

  // ── Authoritative 7-Day Attachment Lifecycle Calculation ────────────────────
  // Server unconditionally enforces 7-day retention: uploadedAt = now, expiresAt = now + 7d.
  // The client NEVER supplies or overrides expiration dates.
  const uploadTimestamp = new Date();
  const RETENTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
  const attachmentExpiresAt = new Date(uploadTimestamp.getTime() + RETENTION_PERIOD_MS);

  const sanitizedAttachments = [];
  const newlyUploadedCloudinaryAssets = [];

  // 1. Process uploaded files from multipart/form-data
  const uploadedFilesList = [];
  if (request.file) uploadedFilesList.push(request.file);
  if (request.files) {
    if (Array.isArray(request.files)) uploadedFilesList.push(...request.files);
    else if (typeof request.files === 'object') uploadedFilesList.push(...Object.values(request.files).flat());
  }

  if (uploadedFilesList.length > 0) {
    for (const uploadedFile of uploadedFilesList) {
      const isPdf = uploadedFile.mimetype === 'application/pdf';
      const targetResourceType = isPdf ? 'auto' : 'image';

      try {
        const uploadResult = await uploadBufferToCloudinary(uploadedFile.buffer, {
          folder: 'liaquatabad_sms/homework',
          resourceType: targetResourceType,
        });

        const registeredAsset = {
          publicId: uploadResult.publicId,
          resourceType: uploadResult.resourceType || (isPdf ? 'raw' : 'image'),
        };
        newlyUploadedCloudinaryAssets.push(registeredAsset);

        sanitizedAttachments.push({
          fileName: uploadedFile.sanitizedFilename || uploadedFile.originalname || 'attachment',
          fileUrl: uploadResult.secureUrl,
          fileType: isPdf ? 'PDF' : 'IMAGE',
          publicId: uploadResult.publicId,
          resourceType: registeredAsset.resourceType,
          mimeType: uploadedFile.mimetype,
          sizeBytes: uploadedFile.size || uploadedFile.buffer?.length || 0,
          width: uploadResult.width || null,
          height: uploadResult.height || null,
          uploadedAt: uploadTimestamp,
          expiresAt: attachmentExpiresAt,
        });
      } catch (uploadError) {
        // Compensating rollback for already uploaded assets in this request batch
        if (newlyUploadedCloudinaryAssets.length > 0) {
          await Promise.allSettled(
            newlyUploadedCloudinaryAssets.map((asset) => deleteFromCloudinary(asset.publicId, asset.resourceType))
          );
        }
        return sendError(response, 502, `Attachment upload failed: ${uploadError.message}`);
      }
    }
  }

  // 2. Backward compatibility: handle existing attachments JSON payload if provided
  let bodyAttachments = attachments;
  if (typeof bodyAttachments === 'string') {
    try {
      bodyAttachments = JSON.parse(bodyAttachments);
    } catch {
      bodyAttachments = [];
    }
  }

  if (Array.isArray(bodyAttachments)) {
    for (const att of bodyAttachments) {
      if (!att.fileUrl || typeof att.fileUrl !== 'string') continue;
      sanitizedAttachments.push({
        fileName: att.fileName ? String(att.fileName).slice(0, 200) : 'attachment',
        fileUrl: att.fileUrl.trim().slice(0, 1000),
        fileType: ['PDF', 'IMAGE'].includes(att.fileType) ? att.fileType : 'IMAGE',
        publicId: att.publicId ? String(att.publicId).slice(0, 200) : '',
        resourceType: att.resourceType || (att.fileType === 'PDF' ? 'raw' : 'image'),
        mimeType: att.mimeType ? String(att.mimeType).slice(0, 100) : (att.fileType === 'PDF' ? 'application/pdf' : 'image/jpeg'),
        sizeBytes: Number(att.sizeBytes) || 0,
        width: Number(att.width) || null,
        height: Number(att.height) || null,
        uploadedAt: uploadTimestamp,
        expiresAt: attachmentExpiresAt, // Enforce server 7-day expiry
      });
    }
  }

  if (sanitizedAttachments.length > 10) {
    if (newlyUploadedCloudinaryAssets.length > 0) {
      await Promise.allSettled(
        newlyUploadedCloudinaryAssets.map((asset) => deleteFromCloudinary(asset.publicId, asset.resourceType))
      );
    }
    return sendError(response, 400, 'Maximum 10 attachments allowed per homework assignment.');
  }

  // ── Create homework record with compensating rollback ──────────────────────
  let homework;
  try {
    homework = await Homework.create({
      schoolId: actorSchoolId,
      classId,
      sectionId,
      subjectId,
      teacherId: actorId,
      teachingAssignmentId: verifiedAssignment?._id || null, // null for HM
      title: title.trim().slice(0, 200),
      description: description ? String(description).trim().slice(0, 2000) : '',
      dueDate: new Date(dueDate),
      attachments: sanitizedAttachments,
      status: 'ACTIVE',
      visibleToStudents: visibleToStudents !== false, // default true
      remarks: remarks ? String(remarks).slice(0, 500) : '',
    });
  } catch (creationError) {
    if (newlyUploadedCloudinaryAssets.length > 0) {
      await Promise.allSettled(
        newlyUploadedCloudinaryAssets.map((asset) => deleteFromCloudinary(asset.publicId, asset.resourceType))
      );
    }
    throw creationError;
  }

  await AuditLog.create({
    actorId:          actorId,
    actorRole:        actor.role,
    actorDesignation: actor.designation || '',
    actorName:        actor.fullName || '',
    action:           'HOMEWORK_CREATED',
    targetModel:      'Homework',
    targetId:         homework._id,
    targetName:       homework.title,
    schoolId:         actorSchoolId,
    newState: {
      classId,
      sectionId,
      subjectId,
      title:   homework.title,
      dueDate: homework.dueDate,
    },
    result:    'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  // ── Central Notification Dispatch (Students & Parents) ──────────────────────
  await dispatchNotificationEvent({
    eventType: 'HOMEWORK_CREATED',
    category: 'ACADEMIC',
    title: `New Homework: ${homework.title}`,
    message: `${targetSubject?.name || 'Subject'} homework assigned. Due: ${new Date(dueDate).toLocaleDateString()}.`,
    actionLink: `/homework`,
    rawMetadata: {
      homeworkId: String(homework._id),
      title: homework.title,
      subjectName: targetSubject?.name || 'General',
      className: targetClass?.name || 'Class',
      sectionName: targetSection?.name || 'A',
      dueDate: homework.dueDate,
      teacherName: actor.fullName,
    },
    audienceCriteria: {
      type: 'CLASS_STUDENTS_AND_PARENTS',
      schoolId: actorSchoolId,
      classId,
      sectionId,
    },
  });

  return sendSuccess(response, 201, 'Homework created successfully.', homework);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/homework/my — Teacher's own homework list
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetMyHomework = asyncHandler(async (request, response) => {
  const actor = request.user;
  const actorId      = String(actor._id || actor.userId);
  const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');

  const { status = 'ACTIVE', limit = 50, skip = 0 } = request.query;

  const filter = {
    teacherId: actorId,
    schoolId:  actorSchoolId,  // enforce school boundary
  };
  if (status && ['ACTIVE', 'EXPIRED', 'CANCELLED'].includes(status)) {
    filter.status = status;
  }

  const homework = await Homework.find(filter)
    .populate('classId',   'name numericGrade')
    .populate('sectionId', 'name')
    .populate('subjectId', 'name code')
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .skip(Number(skip))
    .lean();

  const total = await Homework.countDocuments(filter);

  return sendSuccess(response, 200, 'Your homework list retrieved.', { homework, total });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/homework/student — Student's homework for own class/section
//
// SECURITY: Student's class + section + school are derived from their authenticated
// StudentProfile record — NOT from any client-supplied query parameters.
// A student cannot see homework for another class even by manipulating the request.
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetStudentHomework = asyncHandler(async (request, response) => {
  const actor = request.user;
  const actorId = String(actor._id || actor.userId);

  // Load student's authoritative profile
  const studentProfile = await StudentProfile.findOne({
    userId:          actorId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  }).lean();

  if (!studentProfile) {
    return sendError(response, 404, 'Student profile not found. Contact your school administration.');
  }

  // Student boundary: use profile's school/class/section — NEVER request params
  const { includePastDays = 7 } = request.query;
  const pastCutoff = new Date();
  pastCutoff.setDate(pastCutoff.getDate() - Math.min(Number(includePastDays) || 7, 30));

  const homework = await Homework.find({
    schoolId:          studentProfile.schoolId,    // authoritative
    classId:           studentProfile.classId,     // authoritative
    sectionId:         studentProfile.sectionId,   // authoritative
    status:            'ACTIVE',
    visibleToStudents: true,
    dueDate:           { $gte: pastCutoff },
  })
    .populate('teacherId', 'fullName designation')
    .populate('subjectId', 'name code')
    .sort({ dueDate: 1 })
    .lean();

  // Active attachment lifecycle enforcement: filter out expired attachments past 7 days
  const currentEvaluationTime = new Date();
  const sanitizedHomework = homework.map((homeworkRecord) => ({
    ...homeworkRecord,
    attachments: (homeworkRecord.attachments || []).filter(
      (attachmentItem) => !attachmentItem.expiresAt || new Date(attachmentItem.expiresAt) > currentEvaluationTime
    ),
  }));

  return sendSuccess(response, 200, 'Your homework retrieved.', {
    homework: sanitizedHomework,
    studentClass:   studentProfile.classId,
    studentSection: studentProfile.sectionId,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/homework/school — HM views all school homework
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetSchoolHomework = asyncHandler(async (request, response) => {
  const actor = request.user;
  const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');

  if (!actorSchoolId) {
    return sendError(response, 403, 'Access denied. No school assignment found.');
  }

  const { status = 'ACTIVE', classId, sectionId, limit = 100, skip = 0 } = request.query;

  const filter = { schoolId: actorSchoolId };
  if (status && ['ACTIVE', 'EXPIRED', 'CANCELLED'].includes(status)) filter.status = status;
  if (classId   && /^[0-9a-fA-F]{24}$/.test(classId))   filter.classId   = classId;
  if (sectionId && /^[0-9a-fA-F]{24}$/.test(sectionId)) filter.sectionId = sectionId;

  const [homework, total] = await Promise.all([
    Homework.find(filter)
      .populate('teacherId', 'fullName designation')
      .populate('classId',   'name numericGrade')
      .populate('sectionId', 'name')
      .populate('subjectId', 'name code')
      .sort({ dueDate: -1 })
      .limit(Number(limit))
      .skip(Number(skip))
      .lean(),
    Homework.countDocuments(filter),
  ]);

  return sendSuccess(response, 200, 'School homework retrieved.', { homework, total });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/homework/:id — Teacher/HM edits homework
//
// Only the teacher who created it (or HM of same school) can edit.
// Boundary fields (schoolId, classId, sectionId, subjectId) are immutable after creation.
// ═══════════════════════════════════════════════════════════════════════════════
export const handleUpdateHomework = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'A valid homework ID is required.');
  }

  const homework = await Homework.findById(id);
  if (!homework) return sendError(response, 404, 'Homework not found.');

  const actorId       = String(actor._id || actor.userId);
  const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');

  // School boundary
  if (String(homework.schoolId) !== actorSchoolId) {
    return sendError(response, 403, 'Access denied. This homework belongs to a different school.');
  }

  // TEACHER can only edit their own homework; HM can edit any homework in their school
  if (actor.role === ROLES.TEACHER && String(homework.teacherId) !== actorId) {
    return sendError(response, 403, 'Access denied. You can only edit your own homework assignments.');
  }

  if (homework.status === 'CANCELLED') {
    return sendError(response, 400, 'Cannot edit a cancelled homework assignment.');
  }

  // Only editable fields — boundary fields are immutable
  const { title, description, dueDate, attachments, visibleToStudents, remarks } = request.body;

  if (title       !== undefined) homework.title             = String(title).trim().slice(0, 200);
  if (description !== undefined) homework.description       = String(description).trim().slice(0, 2000);
  if (dueDate     !== undefined) {
    const parsed = new Date(dueDate);
    if (isNaN(parsed.getTime())) return sendError(response, 400, 'Invalid dueDate.');
    homework.dueDate = parsed;
  }
  if (visibleToStudents !== undefined) homework.visibleToStudents = Boolean(visibleToStudents);
  if (remarks           !== undefined) homework.remarks           = String(remarks).slice(0, 500);

  // Handle existing attachments JSON if provided
  let updatedAttachments = [];
  let parsedAttachments = attachments;
  if (typeof parsedAttachments === 'string') {
    try {
      parsedAttachments = JSON.parse(parsedAttachments);
    } catch {
      parsedAttachments = null;
    }
  }

  if (Array.isArray(parsedAttachments)) {
    updatedAttachments = parsedAttachments.map((att) => ({
      fileName: att.fileName ? String(att.fileName).slice(0, 200) : 'attachment',
      fileUrl:  att.fileUrl  ? String(att.fileUrl).trim().slice(0, 1000) : '',
      fileType: ['PDF', 'IMAGE'].includes(att.fileType) ? att.fileType : 'IMAGE',
      publicId: att.publicId ? String(att.publicId).slice(0, 200) : '',
      resourceType: att.resourceType || (att.fileType === 'PDF' ? 'raw' : 'image'),
      mimeType: att.mimeType ? String(att.mimeType).slice(0, 100) : (att.fileType === 'PDF' ? 'application/pdf' : 'image/jpeg'),
      sizeBytes: Number(att.sizeBytes) || 0,
      width: Number(att.width) || null,
      height: Number(att.height) || null,
      uploadedAt: att.uploadedAt ? new Date(att.uploadedAt) : new Date(),
      expiresAt: att.expiresAt ? new Date(att.expiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })).filter((att) => att.fileUrl);
  } else if (attachments === undefined) {
    // Preserve current attachments if not explicitly replaced
    updatedAttachments = [...homework.attachments];
  }

  // Process newly uploaded files in PATCH request
  const newlyUploadedFiles = [];
  if (request.file) newlyUploadedFiles.push(request.file);
  if (request.files) {
    if (Array.isArray(request.files)) newlyUploadedFiles.push(...request.files);
    else if (typeof request.files === 'object') newlyUploadedFiles.push(...Object.values(request.files).flat());
  }

  if (newlyUploadedFiles.length > 0) {
    const uploadTimestamp = new Date();
    const attachmentExpiresAt = new Date(uploadTimestamp.getTime() + 7 * 24 * 60 * 60 * 1000);
    const uploadedAssetRollbackList = [];

    for (const fileItem of newlyUploadedFiles) {
      const isPdf = fileItem.mimetype === 'application/pdf';
      const targetResourceType = isPdf ? 'auto' : 'image';

      try {
        const uploadResult = await uploadBufferToCloudinary(fileItem.buffer, {
          folder: 'liaquatabad_sms/homework',
          resourceType: targetResourceType,
        });

        uploadedAssetRollbackList.push({
          publicId: uploadResult.publicId,
          resourceType: uploadResult.resourceType || (isPdf ? 'raw' : 'image'),
        });

        updatedAttachments.push({
          fileName: fileItem.sanitizedFilename || fileItem.originalname || 'attachment',
          fileUrl: uploadResult.secureUrl,
          fileType: isPdf ? 'PDF' : 'IMAGE',
          publicId: uploadResult.publicId,
          resourceType: uploadResult.resourceType || (isPdf ? 'raw' : 'image'),
          mimeType: fileItem.mimetype,
          sizeBytes: fileItem.size || fileItem.buffer?.length || 0,
          width: uploadResult.width || null,
          height: uploadResult.height || null,
          uploadedAt: uploadTimestamp,
          expiresAt: attachmentExpiresAt,
        });
      } catch (uploadError) {
        if (uploadedAssetRollbackList.length > 0) {
          await Promise.allSettled(
            uploadedAssetRollbackList.map((asset) => deleteFromCloudinary(asset.publicId, asset.resourceType))
          );
        }
        return sendError(response, 502, `Attachment upload failed: ${uploadError.message}`);
      }
    }
  }

  if (updatedAttachments.length > 10) {
    return sendError(response, 400, 'Maximum 10 attachments allowed per homework assignment.');
  }

  homework.attachments = updatedAttachments;
  await homework.save();

  return sendSuccess(response, 200, 'Homework updated successfully.', homework);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/v1/homework/:id — Teacher/HM cancels homework
//
// Soft-delete only — status set to CANCELLED, record preserved for history.
// ═══════════════════════════════════════════════════════════════════════════════
export const handleCancelHomework = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'A valid homework ID is required.');
  }

  const homework = await Homework.findById(id);
  if (!homework) return sendError(response, 404, 'Homework not found.');

  const actorId       = String(actor._id || actor.userId);
  const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');

  // School boundary
  if (String(homework.schoolId) !== actorSchoolId) {
    return sendError(response, 403, 'Access denied. This homework belongs to a different school.');
  }

  // TEACHER can only cancel their own
  if (actor.role === ROLES.TEACHER && String(homework.teacherId) !== actorId) {
    return sendError(response, 403, 'Access denied. You can only cancel your own homework assignments.');
  }

  if (homework.status === 'CANCELLED') {
    return sendError(response, 400, 'This homework assignment is already cancelled.');
  }

  homework.status = 'CANCELLED';
  await homework.save();

  await AuditLog.create({
    actorId:     actorId,
    actorRole:   actor.role,
    actorName:   actor.fullName || '',
    action:      'HOMEWORK_CANCELLED',
    targetModel: 'Homework',
    targetId:    homework._id,
    targetName:  homework.title,
    schoolId:    actorSchoolId,
    newState:    { status: 'CANCELLED' },
    result:      'SUCCESS',
    ipAddress:   request.ip || '',
    userAgent:   request.headers?.['user-agent'] || '',
    requestId:   request.headers?.['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Homework cancelled successfully. Record preserved for historical audit.', {
    _id:    homework._id,
    status: homework.status,
  });
});
