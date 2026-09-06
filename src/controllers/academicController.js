import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';

// ─── Helper: Write Academic Audit Event ──────────────────────────────────────
const writeAcademicAudit = async ({ actorId, actorRole, actorName, action, targetModel, targetId, targetName, schoolId, previousState, newState, result, reason, ipAddress, userAgent }) => {
  try {
    await AuditLog.create({
      actorId, actorRole, actorDesignation: '', actorName: actorName || '',
      action, targetModel, targetId, targetName: targetName || '',
      townId: null, schoolId: schoolId || null,
      previousState, newState, result, reason,
      ipAddress: ipAddress || '', userAgent: userAgent || '', requestId: '',
    });
  } catch (auditError) {
    console.error('[Academic Audit Error]', auditError.message);
  }
};

// ═══════════════════════════════════════════════════════════
// CLASS MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/v1/academic/classes?schoolId=
 * List all classes for a school (cascading: School → Classes)
 */
export const handleGetClasses = asyncHandler(async (request, response) => {
  const { schoolId } = request.query;
  const filter = {};
  if (schoolId && /^[0-9a-fA-F]{24}$/.test(schoolId)) {
    filter.schoolId = schoolId;
  }

  const classes = await Class.find(filter).sort({ numericGrade: 1 }).lean();

  // For each class, count its active sections
  const classIds = classes.map((c) => c._id);
  const sectionCounts = await Section.aggregate([
    { $match: { classId: { $in: classIds }, status: { $ne: 'ARCHIVED' } } },
    { $group: { _id: '$classId', count: { $sum: 1 } } },
  ]);
  const sectionCountMap = Object.fromEntries(sectionCounts.map((sc) => [String(sc._id), sc.count]));

  const enrichedClasses = classes.map((c) => ({
    ...c,
    sectionCount: sectionCountMap[String(c._id)] || 0,
  }));

  return sendSuccess(response, 200, 'Classes retrieved successfully.', { classes: enrichedClasses });
});

/**
 * POST /api/v1/academic/classes
 * Create a new class under a school
 */
export const handleCreateClass = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { schoolId, name, code } = request.body;
  const numericGrade = request.body.numericGrade ?? request.body.gradeLevel;

  const schoolRecord = await School.findById(schoolId).lean();
  if (!schoolRecord) {
    return sendError(response, 404, 'School not found. Cannot create class for non-existent school.');
  }

  // Prevent duplicate class (same grade in same school)
  const existingClass = await Class.findOne({ schoolId, numericGrade }).lean();
  if (existingClass) {
    return sendError(response, 409, `Class ${name} (Grade ${numericGrade}) already exists in this school.`);
  }

  const newClass = await Class.create({
    schoolId,
    name: name.trim(),
    code: code ? code.trim().toUpperCase() : `CL-${numericGrade}`,
    numericGrade,
    status: 'ACTIVE',
  });

  await writeAcademicAudit({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    action: 'CLASS_CREATED',
    targetModel: 'Class',
    targetId: newClass._id,
    targetName: `${name} (Grade ${numericGrade})`,
    schoolId,
    previousState: {},
    newState: { name, numericGrade, schoolId, code: newClass.code },
    result: 'SUCCESS',
    reason: `New class created by ${requestingActor.role}`,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return sendSuccess(response, 201, `Class "${name}" (Grade ${numericGrade}) created successfully.`, { class: newClass });
});

/**
 * PATCH /api/v1/academic/classes/:id
 * Edit or archive a class (soft-delete: status → ARCHIVED)
 */
export const handleUpdateClass = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return sendError(response, 400, 'Invalid class ID format.');

  const { name, code, status, reason } = request.body;
  const numericGrade = request.body.numericGrade ?? request.body.gradeLevel;

  const classRecord = await Class.findById(id);
  if (!classRecord) return sendError(response, 404, 'Class not found.');

  const previousState = { name: classRecord.name, numericGrade: classRecord.numericGrade, status: classRecord.status };

  if (name) classRecord.name = name.trim();
  if (code) classRecord.code = code.trim().toUpperCase();
  if (numericGrade !== undefined) classRecord.numericGrade = numericGrade;
  if (status) classRecord.status = status;

  await classRecord.save();

  await writeAcademicAudit({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    action: status === 'ARCHIVED' ? 'CLASS_ARCHIVED' : 'CLASS_UPDATED',
    targetModel: 'Class',
    targetId: classRecord._id,
    targetName: classRecord.name,
    schoolId: classRecord.schoolId,
    previousState,
    newState: { name: classRecord.name, numericGrade: classRecord.numericGrade, status: classRecord.status },
    result: 'SUCCESS',
    reason: reason || `Class updated by ${requestingActor.role}`,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return sendSuccess(response, 200, `Class updated successfully.`, { class: classRecord });
});

// ═══════════════════════════════════════════════════════════
// SECTION MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/v1/academic/sections?classId=&schoolId=
 * List sections cascaded under class or school
 */
export const handleGetSections = asyncHandler(async (request, response) => {
  const { classId, schoolId } = request.query;
  const filter = {};
  if (classId && /^[0-9a-fA-F]{24}$/.test(classId)) filter.classId = classId;
  if (schoolId && /^[0-9a-fA-F]{24}$/.test(schoolId)) filter.schoolId = schoolId;

  const sections = await Section.find(filter)
    .populate('classId', 'name numericGrade code')
    .populate('classTeacherId', 'fullName designation email')
    .sort({ name: 1 })
    .lean();

  return sendSuccess(response, 200, 'Sections retrieved successfully.', { sections });
});

/**
 * POST /api/v1/academic/sections
 * Create a new section under a class
 */
export const handleCreateSection = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { schoolId, classId, name, classTeacherId, capacity, roomNumber } = request.body;

  const classRecord = await Class.findById(classId).lean();
  if (!classRecord) return sendError(response, 404, 'Parent class not found.');

  const targetSchoolId = schoolId || classRecord.schoolId;

  const existingSection = await Section.findOne({
    classId,
    name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
  }).lean();

  if (existingSection) {
    return sendError(response, 409, `Section "${name}" already exists in this class.`);
  }

  const newSection = await Section.create({
    schoolId: targetSchoolId,
    classId,
    name: name.trim(),
    capacity: capacity || 40,
    roomNumber: roomNumber ? roomNumber.trim() : '',
    classTeacherId: classTeacherId || null,
    status: 'ACTIVE',
  });

  await writeAcademicAudit({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    action: 'SECTION_CREATED',
    targetModel: 'Section',
    targetId: newSection._id,
    targetName: `${classRecord.name} — Section ${name}`,
    schoolId: targetSchoolId,
    previousState: {},
    newState: { name, classId, schoolId: targetSchoolId },
    result: 'SUCCESS',
    reason: `Section created by ${requestingActor.role}`,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return sendSuccess(response, 201, `Section "${name}" created successfully.`, { section: newSection });
});

/**
 * PATCH /api/v1/academic/sections/:id
 * Edit or archive a section
 */
export const handleUpdateSection = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return sendError(response, 400, 'Invalid section ID format.');

  const { name, classTeacherId, capacity, roomNumber, status, reason } = request.body;
  const sectionRecord = await Section.findById(id);
  if (!sectionRecord) return sendError(response, 404, 'Section not found.');

  const previousState = { name: sectionRecord.name, status: sectionRecord.status };

  if (name) sectionRecord.name = name.trim();
  if (capacity !== undefined) sectionRecord.capacity = capacity;
  if (roomNumber !== undefined) sectionRecord.roomNumber = roomNumber.trim();
  if (classTeacherId !== undefined) sectionRecord.classTeacherId = classTeacherId || null;
  if (status) sectionRecord.status = status;

  await sectionRecord.save();

  await writeAcademicAudit({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    action: status === 'ARCHIVED' ? 'SECTION_ARCHIVED' : 'SECTION_UPDATED',
    targetModel: 'Section',
    targetId: sectionRecord._id,
    targetName: sectionRecord.name,
    schoolId: sectionRecord.schoolId,
    previousState,
    newState: { name: sectionRecord.name, status: sectionRecord.status },
    result: 'SUCCESS',
    reason: reason || `Section updated by ${requestingActor.role}`,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return sendSuccess(response, 200, 'Section updated successfully.', { section: sectionRecord });
});

// ═══════════════════════════════════════════════════════════
// SUBJECT MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/v1/academic/subjects?classId=&schoolId=
 * List all subjects cascaded under a class or school
 */
export const handleGetSubjects = asyncHandler(async (request, response) => {
  const { classId, schoolId } = request.query;
  const filter = {};
  if (classId && /^[0-9a-fA-F]{24}$/.test(classId)) filter.classId = classId;
  if (schoolId && /^[0-9a-fA-F]{24}$/.test(schoolId)) filter.schoolId = schoolId;

  const subjects = await Subject.find(filter)
    .populate('classId', 'name code numericGrade')
    .sort({ name: 1 })
    .lean();

  return sendSuccess(response, 200, 'Subjects retrieved successfully.', { subjects });
});

/**
 * POST /api/v1/academic/subjects
 * Create a new subject under a class or school
 */
export const handleCreateSubject = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { schoolId, classId, name, code, isElective, totalMarks, passingMarks } = request.body;

  const validClassId = (classId && /^[0-9a-fA-F]{24}$/.test(classId)) ? classId : null;

  const newSubject = await Subject.create({
    schoolId,
    classId: validClassId,
    name: name.trim(),
    code: code ? code.trim().toUpperCase() : '',
    isElective: !!isElective,
    totalMarks: totalMarks || 100,
    passingMarks: passingMarks || 33,
    status: 'ACTIVE',
  });

  await writeAcademicAudit({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    action: 'SUBJECT_CREATED',
    targetModel: 'Subject',
    targetId: newSubject._id,
    targetName: `${name} (${code || 'no-code'})`,
    schoolId,
    previousState: {},
    newState: { name, code, classId: validClassId, schoolId },
    result: 'SUCCESS',
    reason: `Subject created by ${requestingActor.role}`,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return sendSuccess(response, 201, `Subject "${name}" created successfully.`, { subject: newSubject });
});

/**
 * PATCH /api/v1/academic/subjects/:id
 * Edit or archive a subject
 */
export const handleUpdateSubject = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id } = request.params;
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return sendError(response, 400, 'Invalid subject ID format.');

  const { name, code, isElective, totalMarks, passingMarks, status, reason } = request.body;
  const subjectRecord = await Subject.findById(id);
  if (!subjectRecord) return sendError(response, 404, 'Subject not found.');

  const previousState = { name: subjectRecord.name, status: subjectRecord.status };

  if (name) subjectRecord.name = name.trim();
  if (code !== undefined) subjectRecord.code = code.trim().toUpperCase();
  if (isElective !== undefined) subjectRecord.isElective = !!isElective;
  if (totalMarks !== undefined) subjectRecord.totalMarks = totalMarks;
  if (passingMarks !== undefined) subjectRecord.passingMarks = passingMarks;
  if (status) subjectRecord.status = status;

  await subjectRecord.save();

  await writeAcademicAudit({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    action: status === 'ARCHIVED' ? 'SUBJECT_ARCHIVED' : 'SUBJECT_UPDATED',
    targetModel: 'Subject',
    targetId: subjectRecord._id,
    targetName: subjectRecord.name,
    schoolId: subjectRecord.schoolId,
    previousState,
    newState: { name: subjectRecord.name, status: subjectRecord.status },
    result: 'SUCCESS',
    reason: reason || `Subject updated by ${requestingActor.role}`,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return sendSuccess(response, 200, 'Subject updated successfully.', { subject: subjectRecord });
});
