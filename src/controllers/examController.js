import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Exam from '../models/Exam.js';
import Result from '../models/Result.js';
import School from '../models/School.js';
import User from '../models/User.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import AuditLog from '../models/AuditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { ROLES } from '../../config/constants.js';

/**
 * Resolves the authorized school context for an exam operation.
 * Bounded by: GLOBAL (Root/Super Admin), TOWN (Admin), ASSIGNED_SCHOOLS (Supervisor), SCHOOL (HM/Teacher).
 * Throws an Error with an attached statusCode on authorization or boundary failure.
 */
export const resolveAuthorizedSchoolScope = async (requestingActor, requestedSchoolId) => {
  if (!requestingActor || !requestingActor.role) {
    const error = new Error('Unauthorized: User not authenticated.');
    error.statusCode = 401;
    throw error;
  }

  // 1. ROOT_ADMIN & SUPER_ADMIN (GLOBAL Scope)
  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role)) {
    if (!requestedSchoolId) {
      const error = new Error('School ID is required for global administrators.');
      error.statusCode = 400;
      throw error;
    }
    return String(requestedSchoolId);
  }

  // 2. ADMIN (TOWN Scope)
  if (requestingActor.role === ROLES.ADMIN) {
    if (!requestedSchoolId) {
      const error = new Error('School ID is required for town administrators.');
      error.statusCode = 400;
      throw error;
    }
    const targetSchool = await School.findById(requestedSchoolId).lean();
    if (!targetSchool) {
      const error = new Error('School not found in municipal registry.');
      error.statusCode = 404;
      throw error;
    }
    if (String(targetSchool.townId) !== String(requestingActor.townId)) {
      const error = new Error('Access denied. You cannot manage examinations outside your town jurisdiction.');
      error.statusCode = 403;
      throw error;
    }
    return String(requestedSchoolId);
  }

  // 3. SUPERVISOR (ASSIGNED_SCHOOLS Scope)
  if (requestingActor.role === ROLES.SUPERVISOR) {
    if (!requestedSchoolId) {
      const error = new Error('School ID is required for supervisors.');
      error.statusCode = 400;
      throw error;
    }
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map((schoolItem) =>
      String(schoolItem?._id || schoolItem)
    );
    if (!assignedSchoolIds.includes(String(requestedSchoolId))) {
      const error = new Error('Access denied. Target school is not in your assigned inspection cluster.');
      error.statusCode = 403;
      throw error;
    }
    return String(requestedSchoolId);
  }

  // 4. HM & TEACHER (SCHOOL Scope)
  if ([ROLES.HM, ROLES.TEACHER].includes(requestingActor.role)) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId) {
      const error = new Error('Access denied. Your account has no assigned school linkage.');
      error.statusCode = 403;
      throw error;
    }
    // Strict Anti-BOLA Tripwire: Client cannot pass a foreign schoolId
    if (requestedSchoolId && String(requestedSchoolId) !== actorSchoolId) {
      const error = new Error('Access denied. You cannot query or manipulate examinations for another school.');
      error.statusCode = 403;
      throw error;
    }
    return actorSchoolId;
  }

  const error = new Error('Access denied. Insufficient institutional authority.');
  error.statusCode = 403;
  throw error;
};

/**
 * GET /api/v1/exams
 * Lists all scheduled exams within the actor's authorized school scope.
 */
export const handleGetExams = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  let targetSchoolId;

  try {
    targetSchoolId = await resolveAuthorizedSchoolScope(requestingActor, request.query.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 500, scopeError.message);
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
 */
export const handleCreateExam = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { schoolId, academicYear, title, examType, startDate, endDate } = request.body;

  let targetSchoolId;
  try {
    targetSchoolId = await resolveAuthorizedSchoolScope(requestingActor, schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 500, scopeError.message);
  }

  if (!targetSchoolId || !academicYear || !title || !examType || !startDate || !endDate) {
    return sendError(
      response,
      400,
      'All fields (schoolId, academicYear, title, examType, startDate, endDate) are required.'
    );
  }

  const parsedStartDate = new Date(startDate);
  const parsedEndDate = new Date(endDate);

  if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
    return sendError(response, 400, 'Invalid startDate or endDate format.');
  }

  if (parsedEndDate < parsedStartDate) {
    return sendError(response, 400, 'End date cannot precede start date.');
  }

  const schoolRecord = await School.findById(targetSchoolId).lean();
  if (!schoolRecord) {
    return sendError(response, 404, 'School not found in municipal registry.');
  }

  const newExam = await Exam.create({
    schoolId: targetSchoolId,
    academicYear: String(academicYear).trim(),
    title: String(title).trim(),
    examType,
    startDate: parsedStartDate,
    endDate: parsedEndDate,
    status: 'UPCOMING',
  });

  await AuditLog.create({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName,
    action: 'EXAM_SCHEDULED',
    targetModel: 'Exam',
    targetId: newExam._id,
    schoolId: targetSchoolId,
    newState: { title: newExam.title, examType, academicYear: newExam.academicYear, status: 'UPCOMING' },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
  });

  return sendSuccess(response, 201, `Exam "${title}" scheduled successfully.`, { exam: newExam });
});

/**
 * GET /api/v1/exams/:id/results
 * Lists student results for an exam with data minimization (zero email projection).
 */
export const handleGetExamResults = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { classId, sectionId } = request.query;

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) {
    return sendError(response, 404, 'Exam not found.');
  }

  try {
    await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  const filter = { examId };
  if (classId && /^[0-9a-fA-F]{24}$/.test(classId)) filter.classId = classId;
  if (sectionId && /^[0-9a-fA-F]{24}$/.test(sectionId)) filter.sectionId = sectionId;

  // Student Data Minimization: fullName and rollNumber only — zero email projection
  const results = await Result.find(filter)
    .populate('studentId', 'fullName rollNumber')
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
 * POST /api/v1/exams/:id/results
 * Submits student marks with 5-point cross-entity validation and atomic concurrency handling.
 */
export const handleSubmitStudentMarks = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { studentId, classId, sectionId, subjectMarks, remarks } = request.body;

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  if (!studentId || !classId || !sectionId || !Array.isArray(subjectMarks) || subjectMarks.length === 0) {
    return sendError(response, 400, 'All fields (studentId, classId, sectionId, subjectMarks) are required.');
  }

  if (!/^[0-9a-fA-F]{24}$/.test(studentId) || !/^[0-9a-fA-F]{24}$/.test(classId) || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, 'Invalid student, class, or section ID format.');
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    return sendError(response, 404, 'Exam not found.');
  }

  let effectiveSchoolId;
  try {
    effectiveSchoolId = await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  if (String(exam.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 403, 'Access denied. Exam belongs to another school.');
  }

  // Lifecycle check on parent Exam
  if (exam.status === 'PUBLISHED') {
    return sendError(response, 400, 'Examination gazette is officially published and permanently locked.');
  }
  if (exam.status === 'UPCOMING') {
    return sendError(response, 400, 'Exam has not commenced yet.');
  }
  if (exam.status === 'CANCELLED') {
    return sendError(response, 400, 'Cannot submit marks for a cancelled examination.');
  }

  // 5-Point Cross-Entity Validation
  const [studentRecord, classRecord, sectionRecord] = await Promise.all([
    User.findById(studentId).lean(),
    Class.findById(classId).lean(),
    Section.findById(sectionId).lean(),
  ]);

  if (!studentRecord) {
    return sendError(response, 404, 'Student user not found.');
  }
  const studentSchoolId = String(studentRecord.schoolId?._id || studentRecord.schoolId || '');
  if (studentSchoolId !== String(effectiveSchoolId)) {
    return sendError(response, 403, 'Access denied. Student is not enrolled in this school.');
  }

  if (!classRecord) {
    return sendError(response, 404, 'Academic class not found.');
  }
  if (String(classRecord.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 403, 'Access denied. Class belongs to another school.');
  }

  if (!sectionRecord) {
    return sendError(response, 404, 'Academic section not found.');
  }
  if (sectionRecord.schoolId && String(sectionRecord.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 403, 'Access denied. Section belongs to another school.');
  }

  if (String(sectionRecord.classId) !== String(classRecord._id)) {
    return sendError(response, 400, 'Relational error: Selected section does not belong to the selected class.');
  }

  // Fast duplicate pre-check
  const existingResult = await Result.findOne({ examId, studentId }).lean();
  if (existingResult) {
    return sendError(response, 409, 'Duplicate result: Student already has a recorded result for this exam.');
  }

  // Calculate totals, percentage, grade, and passing status
  let totalMaxMarks = 0;
  let totalObtainedMarks = 0;
  const sanitizedSubjectMarks = [];

  for (const markItem of subjectMarks) {
    if (!markItem.subjectId || !/^[0-9a-fA-F]{24}$/.test(String(markItem.subjectId))) {
      return sendError(response, 400, 'Invalid subject ID format in marks submission.');
    }
    const subjectMax = Number(markItem.maxMarks || markItem.totalMarks) || 100;
    const subjectObtained = Number(markItem.obtainedMarks) || 0;
    if (subjectObtained < 0 || subjectMax <= 0 || subjectObtained > subjectMax) {
      return sendError(response, 400, 'Obtained marks must be non-negative and cannot exceed maximum marks.');
    }
    const subjectPassing = Number(markItem.passingMarks) || (subjectMax * 0.33);
    const isPassing = subjectObtained >= subjectPassing;

    totalMaxMarks += subjectMax;
    totalObtainedMarks += subjectObtained;
    sanitizedSubjectMarks.push({
      subjectId: markItem.subjectId,
      obtainedMarks: subjectObtained,
      maxMarks: subjectMax,
      isPassed: isPassing,
    });
  }

  const percentage = totalMaxMarks > 0 ? Number(((totalObtainedMarks / totalMaxMarks) * 100).toFixed(2)) : 0;
  let grade = 'F';
  if (percentage >= 80) grade = 'A+';
  else if (percentage >= 70) grade = 'A';
  else if (percentage >= 60) grade = 'B';
  else if (percentage >= 50) grade = 'C';
  else if (percentage >= 40) grade = 'D';
  else if (percentage >= 33) grade = 'E';

  // Execute atomic write within transaction session
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Lock verification: Ensure exam has not been concurrently published
    const lockedExam = await Exam.findOne({ _id: examId, status: { $ne: 'PUBLISHED' } }).session(session);
    if (!lockedExam) {
      await session.abortTransaction();
      session.endSession();
      return sendError(response, 400, 'Examination gazette is officially published and permanently locked.');
    }

    // Touch resultsLastModifiedAt
    lockedExam.resultsLastModifiedAt = new Date();
    await lockedExam.save({ session });

    const createdResults = await Result.create([{
      schoolId: effectiveSchoolId,
      examId,
      studentId,
      classId,
      sectionId,
      subjectMarks: sanitizedSubjectMarks,
      totalObtainedMarks,
      totalMaxMarks,
      percentage,
      grade,
      status: 'SUBMITTED',
      evaluatedBy: requestingActor._id || requestingActor.userId,
      remarks: remarks ? String(remarks).trim() : '',
    }], { session });

    const newResult = createdResults[0];

    await AuditLog.create([{
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName: requestingActor.fullName,
      action: 'RESULT_MARKS_SUBMITTED',
      targetModel: 'Result',
      targetId: newResult._id,
      schoolId: effectiveSchoolId,
      newState: { status: 'SUBMITTED', studentId, percentage, grade },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers?.['user-agent'] || '',
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return sendSuccess(response, 201, 'Student marks submitted successfully.', { result: newResult });
  } catch (transactionError) {
    await session.abortTransaction();
    session.endSession();
    if (transactionError.code === 11000) {
      return sendError(response, 409, 'Duplicate result: Student already has a recorded result for this exam.');
    }
    throw transactionError;
  }
});

/**
 * PATCH /api/v1/exams/results/:id/verify
 * Head Master certifies a submitted student result.
 */
export const handleVerifyExamResult = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: resultId } = request.params;
  const { remarks = '' } = request.body;

  if (!resultId || !/^[0-9a-fA-F]{24}$/.test(resultId)) {
    return sendError(response, 400, 'Invalid result ID format.');
  }

  const targetResult = await Result.findById(resultId);
  if (!targetResult) {
    return sendError(response, 404, 'Result record not found.');
  }

  try {
    await resolveAuthorizedSchoolScope(requestingActor, targetResult.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  const parentExam = await Exam.findById(targetResult.examId).lean();
  if (!parentExam) {
    return sendError(response, 404, 'Parent exam not found.');
  }

  // Immutability checks
  if (parentExam.status === 'PUBLISHED' || targetResult.status === 'PUBLISHED') {
    return sendError(response, 400, 'Examination gazette is officially published and permanently locked.');
  }

  // Lifecycle state machine invariant
  if (targetResult.status === 'DRAFT') {
    return sendError(response, 400, 'Cannot verify unsubmitted draft result.');
  }

  // Idempotent no-op
  if (targetResult.status === 'VERIFIED_BY_HM') {
    return sendSuccess(response, 200, 'Student result is already verified.', { result: targetResult });
  }

  if (targetResult.status !== 'SUBMITTED') {
    return sendError(response, 400, `Cannot verify result with status "${targetResult.status}".`);
  }

  const previousState = { status: targetResult.status, approvedByHM: targetResult.approvedByHM };

  targetResult.status = 'VERIFIED_BY_HM';
  targetResult.approvedByHM = requestingActor._id || requestingActor.userId;
  if (remarks) targetResult.remarks = String(remarks).trim();
  await targetResult.save();

  await AuditLog.create({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName,
    action: 'RESULT_VERIFIED_BY_HM',
    targetModel: 'Result',
    targetId: targetResult._id,
    schoolId: targetResult.schoolId,
    previousState,
    newState: { status: 'VERIFIED_BY_HM', approvedByHM: requestingActor._id || requestingActor.userId },
    result: 'SUCCESS',
    reason: remarks || 'Result verified by HM',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
  });

  return sendSuccess(response, 200, 'Student result verified successfully.', { result: targetResult });
});

/**
 * POST /api/v1/exams/:id/results/batch-verify
 * Batch certifies all submitted results for an examination in an atomic transaction.
 * Zero-Audit Guarantee: No audit log is written when 0 results are modified.
 */
export const handleBatchVerifyExamResults = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { classId, sectionId, remarks } = request.body || {};

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    return sendError(response, 404, 'Exam not found.');
  }

  let effectiveSchoolId;
  try {
    effectiveSchoolId = await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  if (String(exam.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 403, 'Access denied. Exam belongs to another school.');
  }

  if (exam.status === 'PUBLISHED') {
    return sendError(response, 400, 'Cannot batch-verify a published examination.');
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const filter = { examId, status: 'SUBMITTED' };
    if (classId && /^[0-9a-fA-F]{24}$/.test(classId)) filter.classId = classId;
    if (sectionId && /^[0-9a-fA-F]{24}$/.test(sectionId)) filter.sectionId = sectionId;

    const updateBatchResult = await Result.updateMany(
      filter,
      {
        $set: {
          status: 'VERIFIED_BY_HM',
          approvedByHM: requestingActor._id || requestingActor.userId,
        },
      },
      { session }
    );

    const verifiedCount = updateBatchResult.modifiedCount || 0;

    // Zero-Audit Guarantee: Strict zero audit logs when modifiedCount === 0
    if (verifiedCount > 0) {
      await AuditLog.create([{
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName: requestingActor.fullName,
        action: 'RESULTS_BATCH_VERIFIED_BY_HM',
        targetModel: 'Exam',
        targetId: exam._id,
        schoolId: exam.schoolId,
        newState: {
          verifiedCount,
          classId: classId || null,
          sectionId: sectionId || null,
        },
        result: 'SUCCESS',
        reason: remarks || `Batch verified ${verifiedCount} result(s) by HM`,
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
      }], { session });
    }

    await session.commitTransaction();
    session.endSession();

    if (verifiedCount === 0) {
      return sendSuccess(response, 200, 'No submitted results were pending verification.', {
        verifiedCount: 0,
      });
    }

    return sendSuccess(response, 200, `Successfully verified ${verifiedCount} student result(s).`, {
      verifiedCount,
    });
  } catch (transactionError) {
    await session.abortTransaction();
    session.endSession();
    throw transactionError;
  }
});

/**
 * POST /api/v1/exams/:id/publish
 * Publishes verified examination results with concurrency protection and strict invariant gates.
 */
export const handlePublishExamResults = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    return sendError(response, 404, 'Exam not found.');
  }

  let effectiveSchoolId;
  try {
    effectiveSchoolId = await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  if (String(exam.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 403, 'Access denied. You can only publish exam results for your assigned school.');
  }

  if (exam.status === 'PUBLISHED') {
    return sendError(response, 409, 'Exam gazette is already published.');
  }

  // Pre-flight unverified count check
  const preflightUnverifiedCount = await Result.countDocuments({
    examId,
    status: { $in: ['DRAFT', 'SUBMITTED'] },
  });

  if (preflightUnverifiedCount > 0) {
    return sendError(
      response,
      400,
      `Cannot publish gazette: ${preflightUnverifiedCount} student result(s) are pending HM verification.`
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1. Atomic Concurrency Lock on Exam
    const lockedExam = await Exam.findOneAndUpdate(
      { _id: examId, status: { $ne: 'PUBLISHED' } },
      { $set: { status: 'PUBLISHED' } },
      { session, new: true }
    );

    if (!lockedExam) {
      await session.abortTransaction();
      session.endSession();
      return sendError(response, 409, 'Exam gazette is already published.');
    }

    // 2. Candidate Count Check (> 0)
    const totalResultsCount = await Result.countDocuments({ examId }).session(session);
    if (totalResultsCount === 0) {
      await session.abortTransaction();
      session.endSession();
      return sendError(response, 400, 'Cannot publish gazette: No student results have been recorded for this exam.');
    }

    // 3. Unverified Results Check (=== 0)
    const unverifiedCount = await Result.countDocuments({
      examId,
      status: { $in: ['DRAFT', 'SUBMITTED'] },
    }).session(session);

    if (unverifiedCount > 0) {
      await session.abortTransaction();
      session.endSession();
      return sendError(
        response,
        400,
        `Cannot publish gazette: ${unverifiedCount} student result(s) are pending HM verification.`
      );
    }

    // 4. Atomic Transition of all VERIFIED_BY_HM results to PUBLISHED
    const publishBatchResult = await Result.updateMany(
      { examId, status: 'VERIFIED_BY_HM' },
      { $set: { status: 'PUBLISHED' } },
      { session }
    );

    // 5. Audit Log inside transaction
    await AuditLog.create([{
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName: requestingActor.fullName,
      action: 'EXAM_RESULTS_PUBLISHED',
      targetModel: 'Exam',
      targetId: lockedExam._id,
      schoolId: lockedExam.schoolId,
      newState: { examStatus: 'PUBLISHED', publishedResultsCount: publishBatchResult.modifiedCount },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers?.['user-agent'] || '',
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return sendSuccess(
      response,
      200,
      `Exam gazette published successfully. ${publishBatchResult.modifiedCount} result(s) released.`,
      {
        examId: lockedExam._id,
        publishedCount: publishBatchResult.modifiedCount,
      }
    );
  } catch (transactionError) {
    await session.abortTransaction();
    session.endSession();
    throw transactionError;
  }
});
