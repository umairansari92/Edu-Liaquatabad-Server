import asyncHandler from 'express-async-handler';
import Exam from '../models/Exam.js';
import Result from '../models/Result.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { ROLES } from '../../config/constants.js';

/**
 * GET /api/v1/exams
 * Lists all scheduled exams within the actor's authorized school scope.
 * For HM: strictly bounded to req.user.schoolId.
 */
export const handleGetExams = asyncHandler(async (request, response) => {
  const actor = request.user;
  let targetSchoolId = request.query.schoolId;

  if (actor.role === ROLES.HM || actor.role === ROLES.TEACHER) {
    targetSchoolId = actor.schoolId?._id || actor.schoolId;
  }

  if (!targetSchoolId) {
    return sendError(response, 400, 'School ID scope could not be resolved.');
  }

  const exams = await Exam.find({ schoolId: targetSchoolId })
    .populate('schoolId', 'name code')
    .sort({ startDate: -1 })
    .lean();

  return sendSuccess(response, 200, 'Examinations retrieved successfully.', { exams });
});

/**
 * POST /api/v1/exams
 * Schedules a new examination period.
 * For HM: strictly bounded to req.user.schoolId.
 */
export const handleCreateExam = asyncHandler(async (request, response) => {
  const actor = request.user;
  let { schoolId, academicYear, title, examType, startDate, endDate } = request.body;

  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId) {
      return sendError(response, 403, 'Your HM account has no assigned school.');
    }
    if (schoolId && String(schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot schedule exams for another school.');
    }
    schoolId = actorSchoolId;
  }

  if (!schoolId || !academicYear || !title || !examType || !startDate || !endDate) {
    return sendError(response, 400, 'All fields (schoolId, academicYear, title, examType, startDate, endDate) are required.');
  }

  const school = await School.findById(schoolId).lean();
  if (!school) {
    return sendError(response, 404, 'School not found in municipal registry.');
  }

  const newExam = await Exam.create({
    schoolId,
    academicYear: academicYear.trim(),
    title: title.trim(),
    examType,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    status: 'UPCOMING',
  });

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'EXAM_SCHEDULED',
    targetModel: 'Exam',
    targetId: newExam._id,
    schoolId,
    newState: { title: newExam.title, examType, academicYear, status: 'UPCOMING' },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 201, `Exam "${title}" scheduled successfully.`, { exam: newExam });
});

/**
 * GET /api/v1/exams/:id/results
 * Lists student results for an exam with optional class and section filters.
 */
export const handleGetExamResults = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;
  const { classId, sectionId } = request.query;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  const exam = await Exam.findById(id).lean();
  if (!exam) {
    return sendError(response, 404, 'Exam not found.');
  }

  if (actor.role === ROLES.HM || actor.role === ROLES.TEACHER) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (actorSchoolId !== String(exam.schoolId)) {
      return sendError(response, 403, 'Access denied. You cannot view results for another school.');
    }
  }

  const filter = { examId: id };
  if (classId && /^[0-9a-fA-F]{24}$/.test(classId)) filter.classId = classId;
  if (sectionId && /^[0-9a-fA-F]{24}$/.test(sectionId)) filter.sectionId = sectionId;

  const results = await Result.find(filter)
    .populate('studentId', 'fullName email')
    .populate('classId', 'name numericGrade')
    .populate('sectionId', 'name')
    .populate('subjectMarks.subjectId', 'name code')
    .populate('evaluatedBy', 'fullName')
    .populate('approvedByHM', 'fullName')
    .sort({ percentage: -1 })
    .lean();

  return sendSuccess(response, 200, 'Exam results retrieved successfully.', {
    exam,
    totalCount: results.length,
    results,
  });
});

/**
 * PATCH /api/v1/exams/results/:id/verify
 * Head Master verifies submitted student result.
 * Documented Lifecycle: DRAFT / SUBMITTED -> VERIFIED_BY_HM
 */
export const handleVerifyExamResult = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;
  const { remarks = '' } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid result ID format.');
  }

  const resultRecord = await Result.findById(id);
  if (!resultRecord) {
    return sendError(response, 404, 'Result record not found.');
  }

  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== String(resultRecord.schoolId)) {
      return sendError(response, 403, 'Access denied. You can only verify results for your assigned school.');
    }
  }

  const previousState = { status: resultRecord.status, approvedByHM: resultRecord.approvedByHM };

  resultRecord.status = 'VERIFIED_BY_HM';
  resultRecord.approvedByHM = actor._id;
  if (remarks) resultRecord.remarks = remarks.trim();
  await resultRecord.save();

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'RESULT_VERIFIED_BY_HM',
    targetModel: 'Result',
    targetId: resultRecord._id,
    schoolId: resultRecord.schoolId,
    previousState,
    newState: { status: 'VERIFIED_BY_HM', approvedByHM: actor._id },
    result: 'SUCCESS',
    reason: remarks || `Result verified by HM`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, 'Student result verified successfully.', { result: resultRecord });
});

/**
 * POST /api/v1/exams/:id/publish
 * Head Master officially publishes all verified results for an examination.
 * Documented Lifecycle: VERIFIED_BY_HM -> PUBLISHED
 */
export const handlePublishExamResults = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  const exam = await Exam.findById(id);
  if (!exam) {
    return sendError(response, 404, 'Exam not found.');
  }

  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== String(exam.schoolId)) {
      return sendError(response, 403, 'Access denied. You can only publish exam results for your assigned school.');
    }
  }

  // Check if any results for this exam are still pending verification
  const unverifiedCount = await Result.countDocuments({
    examId: id,
    status: { $in: ['DRAFT', 'SUBMITTED'] },
  });

  if (unverifiedCount > 0) {
    return sendError(
      response,
      400,
      `Cannot publish gazette: ${unverifiedCount} student result(s) are pending HM verification.`
    );
  }

  // Publish all verified results for this exam
  const updateResult = await Result.updateMany(
    { examId: id, status: 'VERIFIED_BY_HM' },
    { $set: { status: 'PUBLISHED' } }
  );

  exam.status = 'PUBLISHED';
  await exam.save();

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'EXAM_RESULTS_PUBLISHED',
    targetModel: 'Exam',
    targetId: exam._id,
    schoolId: exam.schoolId,
    newState: { examStatus: 'PUBLISHED', publishedResultsCount: updateResult.modifiedCount },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, `Exam gazette published successfully. ${updateResult.modifiedCount} result(s) released.`, {
    examId: exam._id,
    publishedCount: updateResult.modifiedCount,
  });
});
