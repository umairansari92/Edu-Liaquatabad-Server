import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Exam from '../models/Exam.js';
import Result from '../models/Result.js';
import School from '../models/School.js';
import User from '../models/User.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import StudentProfile from '../models/StudentProfile.js';
import Subject from '../models/Subject.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import AuditLog from '../models/AuditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { ROLES, TEACHING_ASSIGNMENT_STATUS, STUDENT_STATUS } from '../../config/constants.js';
import {
  generateStudentMarksheetPdf,
  generateTabulationSheetPdf,
} from '../utils/marksheetPdfGenerator.js';
import { computeClassTabulation, computeStudentResultMetrics } from '../utils/examCalculations.js';

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

  // 4. HM, TEACHER & STUDENT (SCHOOL Scope)
  if ([ROLES.HM, ROLES.TEACHER, ROLES.STUDENT].includes(requestingActor.role)) {
    let actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId && requestingActor.role === ROLES.STUDENT) {
      const studentProfile = await StudentProfile.findOne({ userId: requestingActor._id }).select('schoolId').lean();
      if (studentProfile?.schoolId) {
        actorSchoolId = String(studentProfile.schoolId);
      }
    }
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

  // ── Privacy & Anti-Harassment Boundary: Students cannot view cohort results gazettes ─
  if (requestingActor.role === ROLES.STUDENT) {
    await AuditLog.create({
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorName: requestingActor.fullName || '',
      action: 'COHORT_RESULTS_ACCESS_BLOCKED',
      targetModel: 'Exam',
      targetId: examId,
      targetName: request.originalUrl,
      schoolId: requestingActor.schoolId || null,
      result: 'DENIED',
      reason: 'Student attempted unauthorized access to cohort-level examination gazette.',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
    });
    return sendError(
      response,
      403,
      'Access denied. Students are not authorized to view cohort examination gazettes. Use /api/v1/exams/my-results.'
    );
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

  // Teacher authorization check:
  if (requestingActor.role === ROLES.TEACHER) {
    const actorId = String(requestingActor._id || requestingActor.userId);
    const isClassTeacher = sectionRecord.classTeacherId && String(sectionRecord.classTeacherId) === actorId;
    const isAssigned = await TeachingAssignment.isTeacherAssigned({
      teacherId: actorId,
      schoolId: effectiveSchoolId,
      sectionId: sectionRecord._id,
    });
    if (!isClassTeacher && !isAssigned) {
      return sendError(response, 403, 'Access denied. You have no teaching assignment for this class section.');
    }
  }

  // Fast duplicate pre-check
  const existingResult = await Result.findOne({ examId, studentId }).lean();
  if (existingResult) {
    return sendError(response, 409, 'Duplicate result: Student already has a recorded result for this exam.');
  }

  // Calculate totals, percentage, grade, and passing status using centralized engine
  const sanitizedSubjectMarks = [];

  for (const markItem of subjectMarks) {
    if (!markItem.subjectId || !/^[0-9a-fA-F]{24}$/.test(String(markItem.subjectId))) {
      return sendError(response, 400, 'Invalid subject ID format in marks submission.');
    }

    const isGraded = Boolean(markItem.isGradedOnly);
    if (isGraded) {
      const letterGrade = (markItem.letterGrade || 'A').toUpperCase();
      sanitizedSubjectMarks.push({
        subjectId: markItem.subjectId,
        subjectName: markItem.subjectName || 'DRAWING',
        isGradedOnly: true,
        letterGrade,
        obtainedMarks: 0,
        maxMarks: 0,
        isPassed: !['FAIL', 'F'].includes(letterGrade),
      });
      continue;
    }

    let subjectMax = Number(markItem.maxMarks || markItem.totalMarks) || 100;
    let subjectObtained = 0;
    let subComponents;

    if (markItem.subComponents && (markItem.subComponents.nazra !== undefined || markItem.subComponents.written !== undefined)) {
      const nazra = Number(markItem.subComponents.nazra) || 0;
      const written = Number(markItem.subComponents.written) || 0;
      if (nazra < 0 || nazra > 20 || written < 0 || written > 80) {
        return sendError(response, 400, 'Islamiat sub-components must be within range: Nazra (0-20), Written (0-80).');
      }
      subjectObtained = nazra + written;
      subjectMax = 100;
      subComponents = { nazra, written };
    } else {
      subjectObtained = Number(markItem.obtainedMarks) || 0;
      if (subjectObtained < 0 || subjectMax <= 0 || subjectObtained > subjectMax) {
        return sendError(response, 400, 'Obtained marks must be non-negative and cannot exceed maximum marks.');
      }
    }

    const subjectPassing = Number(markItem.passingMarks) || (subjectMax * 0.33);
    const isPassing = subjectObtained >= subjectPassing;

    sanitizedSubjectMarks.push({
      subjectId: markItem.subjectId,
      subjectName: markItem.subjectName || '',
      obtainedMarks: subjectObtained,
      maxMarks: subjectMax,
      subComponents,
      isGradedOnly: false,
      isPassed: isPassing,
    });
  }

  const calculatedMetrics = computeStudentResultMetrics(sanitizedSubjectMarks);
  const totalMaxMarks = calculatedMetrics.totalMaxMarks;
  const totalObtainedMarks = calculatedMetrics.totalObtainedMarks;
  const percentage = calculatedMetrics.percentage;
  const grade = calculatedMetrics.grade;
  const resultStatus = calculatedMetrics.resultStatus;

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
      resultStatus,
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

/**
 * GET /api/v1/exams/:id/results/:studentId/marksheet
 * Streams official Government DMC Marksheet PDF (A4 Portrait, Image 1 Replica).
 * Requires result to be in VERIFIED_BY_HM or PUBLISHED state.
 */
export const handleDownloadStudentMarksheet = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId, studentId } = request.params;

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }
  if (!studentId || !/^[0-9a-fA-F]{24}$/.test(studentId)) {
    return sendError(response, 400, 'Invalid student ID format.');
  }

  // ── Student Ownership Check (Anti-BOLA/IDOR Shield) ───────────────────────
  if (requestingActor.role === ROLES.STUDENT) {
    const authenticatedStudentId = String(requestingActor._id || requestingActor.userId);
    if (String(studentId) !== authenticatedStudentId) {
      await AuditLog.create({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorName: requestingActor.fullName || '',
        action: 'STUDENT_CROSS_USER_MARKSHEET_BLOCKED',
        targetModel: 'Result',
        targetId: studentId,
        targetName: request.originalUrl,
        schoolId: requestingActor.schoolId || null,
        previousState: {
          attemptedStudentId: studentId,
          authenticatedStudentId,
          examId,
        },
        result: 'DENIED',
        reason: 'BOLA/IDOR attempt intercepted: Student attempted to download another student\'s official marksheet.',
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
      });
      return sendError(response, 403, 'Access denied. You can only download your own official marksheet.');
    }
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) {
    return sendError(response, 404, 'Exam record not found.');
  }

  // Anti-BOLA guard
  try {
    await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  const result = await Result.findOne({ examId, studentId })
    .populate('subjectMarks.subjectId', 'name code')
    .lean();

  if (!result) {
    return sendError(response, 404, 'Exam result not found for this student.');
  }

  // ── Student Publication Gate: Students can ONLY download PUBLISHED results ─
  if (requestingActor.role === ROLES.STUDENT && result.status !== 'PUBLISHED') {
    await AuditLog.create({
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorName: requestingActor.fullName || '',
      action: 'STUDENT_UNPUBLISHED_MARKSHEET_BLOCKED',
      targetModel: 'Result',
      targetId: result._id,
      targetName: request.originalUrl,
      schoolId: requestingActor.schoolId || null,
      previousState: {
        resultStatus: result.status,
        examId,
        studentId,
      },
      result: 'DENIED',
      reason: 'Student attempted to download an unapproved/unpublished examination marksheet.',
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
    });
    return sendError(
      response,
      403,
      'Access denied. Official Marksheet is not available until examination results are formally published.'
    );
  }

  // State Machine Verification Gate for Staff: Only VERIFIED_BY_HM or PUBLISHED results can be issued as official marksheets
  if (!['VERIFIED_BY_HM', 'PUBLISHED'].includes(result.status)) {
    return sendError(
      response,
      400,
      `Official Marksheet can only be issued for verified or published examination results. Current status is "${result.status}".`
    );
  }

  // Populate student particulars
  const [student, studentProfile, school, classDoc, sectionDoc] = await Promise.all([
    User.findById(studentId).lean(),
    StudentProfile.findOne({ userId: studentId }).lean(),
    School.findById(exam.schoolId).lean(),
    Class.findById(result.classId).lean(),
    Section.findById(result.sectionId).lean(),
  ]);

  // If rank is not yet stored on single result, compute rank dynamically within cohort
  if (!result.rankFormatted) {
    const cohortFilter = { examId };
    if (result.sectionId) {
      cohortFilter.sectionId = result.sectionId;
    } else if (result.classId) {
      cohortFilter.classId = result.classId;
    }
    const allCohortResults = await Result.find(cohortFilter).lean();
    const { rankedResults } = computeClassTabulation(allCohortResults);
    const matched = rankedResults.find((r) => String(r.studentId?._id || r.studentId) === String(studentId));
    if (matched) {
      result.rank = matched.rank;
      result.rankFormatted = matched.rankFormatted;
    }
  }

  const cleanGr = studentProfile?.grNumber || studentProfile?.rollNumber || 'GR';
  const cleanName = (studentProfile?.studentFullName || student?.fullName || 'STUDENT').replace(/[^a-zA-Z0-9]/g, '_');

  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `inline; filename=Marksheet_${cleanGr}_${cleanName}.pdf`);

  const pdfDoc = generateStudentMarksheetPdf({
    exam,
    result,
    student,
    studentProfile,
    school,
    classDoc,
    sectionDoc,
    issuanceDate: new Date(),
  });

  pdfDoc.pipe(response);
  pdfDoc.end();
});

/**
 * GET /api/v1/exams/:id/tabulation-sheet
 * Streams official Government DMC Tabulation Sheet PDF (LEGAL LANDSCAPE, Image 2 Replica).
 * Query parameters: classId (required), sectionId (optional).
 */
export const handleDownloadClassTabulationPdf = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { classId, sectionId } = request.query;

  if (requestingActor.role === ROLES.STUDENT) {
    return sendError(response, 403, 'Access denied. Students are not authorized to download class tabulation sheets.');
  }

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }
  if (!classId || !/^[0-9a-fA-F]{24}$/.test(classId)) {
    return sendError(response, 400, 'A valid classId is required to generate the Tabulation Sheet.');
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) {
    return sendError(response, 404, 'Exam record not found.');
  }

  // Anti-BOLA guard
  try {
    await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  const queryFilter = { examId, classId };
  if (sectionId && /^[0-9a-fA-F]{24}$/.test(sectionId)) {
    queryFilter.sectionId = sectionId;
  }

  const rawResults = await Result.find(queryFilter)
    .populate('studentId', 'fullName email')
    .populate('subjectMarks.subjectId', 'name code')
    .lean();

  if (rawResults.length === 0) {
    return sendError(response, 404, 'No student results found for this class in this examination.');
  }

  // Fetch StudentProfiles for dual numbering (GR, Roll No, Father Name)
  const studentUserIds = rawResults.map((r) => r.studentId?._id || r.studentId);
  const profiles = await StudentProfile.find({ userId: { $in: studentUserIds } }).lean();
  const profileMap = new Map();
  profiles.forEach((p) => profileMap.set(String(p.userId), p));

  const enrichedResults = rawResults.map((r) => ({
    ...r,
    studentProfile: profileMap.get(String(r.studentId?._id || r.studentId)) || {},
  }));

  const { rankedResults, classStatistics } = computeClassTabulation(enrichedResults);

  const [school, classDoc, sectionDoc] = await Promise.all([
    School.findById(exam.schoolId).lean(),
    Class.findById(classId).lean(),
    sectionId ? Section.findById(sectionId).lean() : null,
  ]);

  const cleanClass = (classDoc?.name || 'Class').replace(/[^a-zA-Z0-9]/g, '_');
  const cleanExam = (exam.title || 'Exam').replace(/[^a-zA-Z0-9]/g, '_');

  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename=TabulationSheet_${cleanClass}_${cleanExam}.pdf`);

  const pdfDoc = generateTabulationSheetPdf({
    exam,
    rankedResults,
    classStatistics,
    school,
    classDoc,
    sectionDoc,
  });

  pdfDoc.pipe(response);
  pdfDoc.end();
});

/**
 * GET /api/v1/exams/:id/tabulation-data
 * JSON endpoint providing auto-computed spreadsheet data (ranks, percentages, stats).
 * Used by HmDashboard Tab 5 interactive Tabulation Sheet grid.
 */
export const handleGetClassTabulationData = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { classId, sectionId } = request.query;

  if (requestingActor.role === ROLES.STUDENT) {
    return sendError(response, 403, 'Access denied. Students are not authorized to view class tabulation data.');
  }

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) {
    return sendError(response, 404, 'Exam record not found.');
  }

  try {
    await resolveAuthorizedSchoolScope(requestingActor, exam.schoolId);
  } catch (scopeError) {
    return sendError(response, scopeError.statusCode || 403, scopeError.message);
  }

  const queryFilter = { examId };
  if (classId && /^[0-9a-fA-F]{24}$/.test(classId)) queryFilter.classId = classId;
  if (sectionId && /^[0-9a-fA-F]{24}$/.test(sectionId)) queryFilter.sectionId = sectionId;

  const rawResults = await Result.find(queryFilter)
    .populate('studentId', 'fullName email')
    .populate('classId', 'name numericGrade')
    .populate('sectionId', 'name')
    .populate('subjectMarks.subjectId', 'name code')
    .lean();

  const studentUserIds = rawResults.map((r) => r.studentId?._id || r.studentId);
  const profiles = await StudentProfile.find({ userId: { $in: studentUserIds } }).lean();
  const profileMap = new Map();
  profiles.forEach((p) => profileMap.set(String(p.userId), p));

  const enrichedResults = rawResults.map((r) => ({
    ...r,
    studentProfile: profileMap.get(String(r.studentId?._id || r.studentId)) || {},
  }));

  const { rankedResults, classStatistics } = computeClassTabulation(enrichedResults);

  return sendSuccess(response, 200, 'Tabulation sheet data calculated successfully.', {
    exam,
    rankedResults,
    classStatistics,
  });
});

/**
 * GET /api/v1/exams/:id/entry-roster
 * Retrieves the marks entry roster for an exam + class + section + subject.
 * Returns enrolled students with their existing marks (if any) and subject configs.
 */
export const handleGetExamMarksEntryRoster = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { classId, sectionId, subjectId } = request.query;

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }
  if (!classId || !/^[0-9a-fA-F]{24}$/.test(classId) || !sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, 'Valid classId and sectionId query parameters are required.');
  }

  const exam = await Exam.findById(examId).lean();
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
    return sendError(response, 400, 'Examination gazette is officially published and permanently locked.');
  }
  if (exam.status === 'CANCELLED') {
    return sendError(response, 400, 'Cannot enter marks for a cancelled examination.');
  }

  const [classRecord, sectionRecord] = await Promise.all([
    Class.findById(classId).lean(),
    Section.findById(sectionId).lean(),
  ]);

  if (!classRecord || String(classRecord.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 404, 'Class not found in this school.');
  }
  if (!sectionRecord || String(sectionRecord.schoolId) !== String(effectiveSchoolId) || String(sectionRecord.classId) !== String(classId)) {
    return sendError(response, 404, 'Section does not match the selected class or school.');
  }

  // Teacher capability check:
  if (requestingActor.role === ROLES.TEACHER) {
    const actorId = String(requestingActor._id || requestingActor.userId);
    if (subjectId) {
      const hasSubjectAssignment = await TeachingAssignment.findOne({
        teacherId: actorId,
        schoolId: effectiveSchoolId,
        classId,
        sectionId,
        subjectId,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      }).lean();
      if (!hasSubjectAssignment) {
        return sendError(response, 403, 'Access denied. You do not have an active teaching assignment for this subject in this section.');
      }
    } else {
      const isClassTeacher = sectionRecord.classTeacherId && String(sectionRecord.classTeacherId) === actorId;
      const hasAnyAssignment = await TeachingAssignment.findOne({
        teacherId: actorId,
        schoolId: effectiveSchoolId,
        classId,
        sectionId,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      }).lean();
      if (!isClassTeacher && !hasAnyAssignment) {
        return sendError(response, 403, 'Access denied. You are not assigned to this class section.');
      }
    }
  }

  // Fetch all active subjects for this class
  const classSubjects = await Subject.find({
    classId,
    schoolId: effectiveSchoolId,
    status: 'ACTIVE',
  }).lean();

  let targetSubject = null;
  if (subjectId) {
    targetSubject = classSubjects.find((s) => String(s._id) === String(subjectId));
    if (!targetSubject) {
      targetSubject = await Subject.findById(subjectId).lean();
    }
  }

  // Fetch enrolled active students in this section
  const studentProfiles = await StudentProfile.find({
    sectionId,
    schoolId: effectiveSchoolId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  })
    .populate('userId', 'fullName rollNumber email')
    .sort({ grNumber: 1 })
    .lean();

  // Fetch existing results for this exam + section
  const existingResults = await Result.find({
    examId,
    classId,
    sectionId,
  }).lean();

  const resultsMap = new Map();
  for (const res of existingResults) {
    resultsMap.set(String(res.studentId), res);
  }

  const roster = studentProfiles.map((profile) => {
    const studentUser = profile.userId || {};
    const studentUserId = String(studentUser._id || profile._id);
    const existingResult = resultsMap.get(studentUserId) || null;

    let targetSubjectMarks = null;
    if (existingResult && subjectId) {
      targetSubjectMarks = existingResult.subjectMarks.find(
        (sm) => String(sm.subjectId) === String(subjectId)
      ) || null;
    }

    return {
      studentId: studentUserId,
      studentProfileId: profile._id,
      fullName: studentUser.fullName || 'Student',
      rollNumber: studentUser.rollNumber || '',
      grNumber: profile.grNumber,
      globalStudentId: profile.globalStudentId || `GR-${profile.grNumber}`,
      gender: profile.gender || 'UNSPECIFIED',
      hasExistingResult: Boolean(existingResult),
      resultStatus: existingResult?.status || 'NOT_ENTERED',
      existingSubjectMarks: targetSubjectMarks,
      existingAllSubjectMarks: existingResult?.subjectMarks || [],
      existingRemarks: existingResult?.remarks || '',
      totalObtainedMarks: existingResult?.totalObtainedMarks ?? null,
      percentage: existingResult?.percentage ?? null,
      grade: existingResult?.grade || null,
    };
  });

  return sendSuccess(response, 200, 'Exam marks entry roster retrieved.', {
    exam: {
      _id: exam._id,
      title: exam.title,
      examType: exam.examType,
      academicYear: exam.academicYear,
      status: exam.status,
    },
    class: { _id: classRecord._id, name: classRecord.name, numericGrade: classRecord.numericGrade },
    section: { _id: sectionRecord._id, name: sectionRecord.name },
    targetSubject: targetSubject || null,
    classSubjects,
    totalStudents: roster.length,
    roster,
  });
});

/**
 * POST /api/v1/exams/:id/results/bulk
 * Bulk marks submission for an entire section/subject with atomic concurrency lock.
 */
export const handleBulkSubmitStudentMarks = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: examId } = request.params;
  const { classId, sectionId, subjectId } = request.body;
  const entries = Array.isArray(request.body.entries) ? request.body.entries : request.body.results;

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam ID format.');
  }
  if (!classId || !/^[0-9a-fA-F]{24}$/.test(classId) || !sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, 'Valid classId and sectionId are required.');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return sendError(response, 400, 'Entries array cannot be empty.');
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
    return sendError(response, 400, 'Examination gazette is officially published and permanently locked.');
  }
  if (exam.status === 'UPCOMING') {
    return sendError(response, 400, 'Exam has not commenced yet.');
  }
  if (exam.status === 'CANCELLED') {
    return sendError(response, 400, 'Cannot submit marks for a cancelled examination.');
  }

  const [classRecord, sectionRecord] = await Promise.all([
    Class.findById(classId).lean(),
    Section.findById(sectionId).lean(),
  ]);

  if (!classRecord || String(classRecord.schoolId) !== String(effectiveSchoolId)) {
    return sendError(response, 404, 'Class not found in this school.');
  }
  if (!sectionRecord || String(sectionRecord.schoolId) !== String(effectiveSchoolId) || String(sectionRecord.classId) !== String(classId)) {
    return sendError(response, 400, 'Relational error: Selected section does not belong to the selected class.');
  }

  // Teacher capability check:
  if (requestingActor.role === ROLES.TEACHER) {
    const actorId = String(requestingActor._id || requestingActor.userId);
    if (subjectId) {
      const hasSubjectAssignment = await TeachingAssignment.findOne({
        teacherId: actorId,
        schoolId: effectiveSchoolId,
        classId,
        sectionId,
        subjectId,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      }).lean();
      if (!hasSubjectAssignment) {
        return sendError(response, 403, 'Access denied. You do not have an active teaching assignment for this subject in this section.');
      }
    } else {
      const isClassTeacher = sectionRecord.classTeacherId && String(sectionRecord.classTeacherId) === actorId;
      if (!isClassTeacher) {
        return sendError(response, 403, 'Access denied. Only the assigned Class Teacher can submit multi-subject results for this section.');
      }
    }
  }

  // Authoritative student roster check — every student must belong to this section!
  const authorizedStudents = await StudentProfile.find({
    sectionId,
    schoolId: effectiveSchoolId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  }).lean();

  const authorizedStudentUserIds = new Set(authorizedStudents.map((p) => String(p.userId)));
  const seenStudentIds = new Set();

  for (const entry of entries) {
    if (!entry.studentId || !/^[0-9a-fA-F]{24}$/.test(String(entry.studentId))) {
      return sendError(response, 400, `Invalid studentId in entry: ${entry.studentId}`);
    }
    const sIdStr = String(entry.studentId);
    if (seenStudentIds.has(sIdStr)) {
      return sendError(response, 400, `Duplicate studentId detected in batch entries: ${sIdStr}`);
    }
    seenStudentIds.add(sIdStr);

    if (!authorizedStudentUserIds.has(sIdStr)) {
      return sendError(response, 403, `Access denied. Student ${entry.studentId} does not belong to this section.`);
    }
  }

  let targetSubjectDoc = null;
  if (subjectId) {
    targetSubjectDoc = await Subject.findById(subjectId).lean();
    if (!targetSubjectDoc || String(targetSubjectDoc.schoolId) !== String(effectiveSchoolId)) {
      return sendError(response, 404, 'Subject not found in this school.');
    }
  }

  // Execute in MongoDB transaction
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Assert exam remains unpublished
    const lockedExam = await Exam.findOne({ _id: examId, status: { $ne: 'PUBLISHED' } }).session(session);
    if (!lockedExam) {
      await session.abortTransaction();
      session.endSession();
      return sendError(response, 400, 'Examination gazette was concurrently published.');
    }

    lockedExam.resultsLastModifiedAt = new Date();
    await lockedExam.save({ session });

    const processedResults = [];

    for (const entry of entries) {
      const studentId = String(entry.studentId);
      let result = await Result.findOne({ examId, studentId }).session(session);

      if (!result) {
        result = new Result({
          schoolId: effectiveSchoolId,
          examId,
          studentId,
          classId,
          sectionId,
          subjectMarks: [],
          status: 'SUBMITTED',
          evaluatedBy: requestingActor._id || requestingActor.userId,
        });
      } else {
        if (result.status === 'PUBLISHED') {
          await session.abortTransaction();
          session.endSession();
          return sendError(response, 400, `Result for student ${studentId} is officially published and cannot be modified.`);
        }
      }

      // If updating a specific subject:
      if (subjectId && targetSubjectDoc) {
        const isDrawing = Boolean(targetSubjectDoc.name && targetSubjectDoc.name.toUpperCase().includes('DRAWING'));
        const isGradedOnly = Boolean(entry.isGradedOnly || targetSubjectDoc.isGradedOnly || isDrawing);
        let markItemIndex = result.subjectMarks.findIndex((sm) => String(sm.subjectId) === String(subjectId));
        const markItemData = {
          subjectId: targetSubjectDoc._id,
          subjectName: targetSubjectDoc.name,
          isGradedOnly,
          obtainedMarks: 0,
          maxMarks: targetSubjectDoc.totalMarks || 100,
          isPassed: true,
        };

        if (isGradedOnly) {
          const VALID_GRADES = new Set(['A-1', 'A+', 'A', 'B', 'C', 'D', 'E', 'FAIL', 'F']);
          const letterGrade = String(entry.letterGrade || 'A').toUpperCase().trim();
          if (!VALID_GRADES.has(letterGrade)) {
            await session.abortTransaction();
            session.endSession();
            return sendError(response, 400, `Invalid letter grade: "${entry.letterGrade}". Allowed: A+, A, B, C, D, FAIL.`);
          }
          markItemData.isGradedOnly = true;
          markItemData.letterGrade = letterGrade;
          markItemData.obtainedMarks = 0;
          markItemData.maxMarks = 0;
          markItemData.isPassed = !['FAIL', 'F'].includes(letterGrade);
        } else if (entry.subComponents && (entry.subComponents.nazra !== undefined || entry.subComponents.written !== undefined)) {
          const rawNazra = entry.subComponents.nazra;
          const rawWritten = entry.subComponents.written;
          const nazra = Number(rawNazra);
          const written = Number(rawWritten);
          if (rawNazra === null || rawWritten === null || isNaN(nazra) || isNaN(written) || !Number.isFinite(nazra) || !Number.isFinite(written) || nazra < 0 || nazra > 20 || written < 0 || written > 80) {
            await session.abortTransaction();
            session.endSession();
            return sendError(response, 400, 'Islamiat sub-components must be valid finite numbers: Nazra (0-20), Written (0-80).');
          }
          markItemData.isGradedOnly = false;
          markItemData.subComponents = { nazra, written };
          markItemData.obtainedMarks = nazra + written;
          markItemData.maxMarks = 100;
          markItemData.isPassed = (nazra + written) >= (targetSubjectDoc.passingMarks || 33);
        } else {
          const maxMarks = Number(entry.maxMarks || targetSubjectDoc.totalMarks) || 100;
          const rawObtained = entry.obtainedMarks;
          const obtainedMarks = Number(rawObtained);
          if (rawObtained === null || rawObtained === undefined || isNaN(obtainedMarks) || !Number.isFinite(obtainedMarks) || obtainedMarks < 0 || obtainedMarks > maxMarks) {
            await session.abortTransaction();
            session.endSession();
            return sendError(response, 400, `Obtained marks (${rawObtained}) must be a valid finite number between 0 and cannot exceed max marks (${maxMarks}).`);
          }
          markItemData.isGradedOnly = false;
          markItemData.obtainedMarks = obtainedMarks;
          markItemData.maxMarks = maxMarks;
          markItemData.isPassed = obtainedMarks >= (targetSubjectDoc.passingMarks || (maxMarks * 0.33));
        }

        if (markItemIndex >= 0) {
          result.subjectMarks[markItemIndex] = markItemData;
        } else {
          result.subjectMarks.push(markItemData);
        }
      } else if (Array.isArray(entry.subjectMarks)) {
        result.subjectMarks = entry.subjectMarks.map((sm) => ({
          subjectId: sm.subjectId,
          subjectName: sm.subjectName || '',
          obtainedMarks: Number(sm.obtainedMarks) || 0,
          maxMarks: Number(sm.maxMarks) || 100,
          subComponents: sm.subComponents,
          isGradedOnly: Boolean(sm.isGradedOnly),
          letterGrade: sm.letterGrade,
          isPassed: Boolean(sm.isPassed),
        }));
      }

      // Recalculate metrics
      const metrics = computeStudentResultMetrics(result.subjectMarks);
      result.totalMaxMarks = metrics.totalMaxMarks;
      result.totalObtainedMarks = metrics.totalObtainedMarks;
      result.percentage = metrics.percentage;
      result.grade = metrics.grade;
      result.resultStatus = metrics.resultStatus;

      // Update conduct / behavioral remarks if provided
      if (entry.remarks !== undefined) {
        result.remarks = String(entry.remarks).trim();
      }

      result.evaluatedBy = requestingActor._id || requestingActor.userId;
      result.status = 'SUBMITTED';

      await result.save({ session });
      processedResults.push(result);
    }

    await session.commitTransaction();
    session.endSession();

    await AuditLog.create({
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName: requestingActor.fullName,
      action: 'EXAM_MARKS_BULK_SUBMITTED',
      targetModel: 'Exam',
      targetId: exam._id,
      schoolId: effectiveSchoolId,
      newState: {
        examId: exam._id,
        classId,
        sectionId,
        subjectId: subjectId || null,
        processedCount: processedResults.length,
      },
      result: 'SUCCESS',
      ipAddress: request.ip || '',
      userAgent: request.headers?.['user-agent'] || '',
    });

    return sendSuccess(response, 200, `Successfully submitted marks for ${processedResults.length} students.`, {
      examId,
      classId,
      sectionId,
      subjectId: subjectId || null,
      processedCount: processedResults.length,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
});

/**
 * GET /api/v1/exams/my-results
 * Dedicated Student Workspace Endpoint: Retrieves authenticated student's published exam results.
 * Strictly filters by studentId = request.user._id AND status = 'PUBLISHED'.
 * Client-provided studentId or userId in query or body are completely ignored.
 * Sanitized projection of academic particulars: Islamiat split, Drawing letter grade, 700 aggregate.
 */
export const handleGetMyExamResults = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  if (requestingActor.role !== ROLES.STUDENT) {
    return sendError(response, 403, 'Access denied. Only registered students may access this examination results endpoint.');
  }

  const authenticatedStudentId = requestingActor._id || requestingActor.userId;
  const filterCriteria = {
    studentId: authenticatedStudentId,
    status: 'PUBLISHED',
  };

  const { examId } = request.query;
  if (examId) {
    if (!/^[0-9a-fA-F]{24}$/.test(examId)) {
      return sendError(response, 400, 'Invalid examId format.');
    }
    filterCriteria.examId = examId;
  }

  const publishedResults = await Result.find(filterCriteria)
    .populate('examId', 'name term session academicYear examType startDate endDate publicationDate')
    .populate('schoolId', 'name code')
    .populate('classId', 'name numericGrade code')
    .populate('sectionId', 'name roomNumber')
    .populate('subjectMarks.subjectId', 'name code')
    .sort({ createdAt: -1 })
    .lean();

  const sanitizedResults = publishedResults.map((resultRecord) => ({
    _id: resultRecord._id,
    exam: resultRecord.examId ? {
      _id: resultRecord.examId._id,
      name: resultRecord.examId.name,
      term: resultRecord.examId.term,
      session: resultRecord.examId.session,
      academicYear: resultRecord.examId.academicYear,
      examType: resultRecord.examId.examType,
      startDate: resultRecord.examId.startDate,
      endDate: resultRecord.examId.endDate,
      publicationDate: resultRecord.examId.publicationDate,
    } : null,
    school: resultRecord.schoolId ? {
      _id: resultRecord.schoolId._id,
      name: resultRecord.schoolId.name,
      code: resultRecord.schoolId.code,
    } : null,
    class: resultRecord.classId ? {
      _id: resultRecord.classId._id,
      name: resultRecord.classId.name,
      numericGrade: resultRecord.classId.numericGrade,
      code: resultRecord.classId.code,
    } : null,
    section: resultRecord.sectionId ? {
      _id: resultRecord.sectionId._id,
      name: resultRecord.sectionId.name,
      roomNumber: resultRecord.sectionId.roomNumber || '',
    } : null,
    subjectMarks: (resultRecord.subjectMarks || []).map((subjectMarkItem) => ({
      subjectId: subjectMarkItem.subjectId?._id || subjectMarkItem.subjectId,
      subjectName: subjectMarkItem.subjectId?.name || subjectMarkItem.subjectName || 'Subject',
      subjectCode: subjectMarkItem.subjectId?.code || '',
      subComponents: subjectMarkItem.subComponents ? {
        nazra: subjectMarkItem.subComponents.nazra ?? null,
        written: subjectMarkItem.subComponents.written ?? null,
      } : null,
      obtainedMarks: subjectMarkItem.obtainedMarks,
      maxMarks: subjectMarkItem.maxMarks,
      isGradedOnly: Boolean(subjectMarkItem.isGradedOnly),
      letterGrade: subjectMarkItem.letterGrade || '',
      isPassed: subjectMarkItem.isPassed,
    })),
    totalObtainedMarks: resultRecord.totalObtainedMarks,
    totalMaxMarks: resultRecord.totalMaxMarks,
    percentage: resultRecord.percentage,
    grade: resultRecord.grade,
    position: resultRecord.position,
    rank: resultRecord.rank,
    rankFormatted: resultRecord.rankFormatted,
    resultStatus: resultRecord.resultStatus,
    remarks: resultRecord.remarks || '',
    status: resultRecord.status, // Always 'PUBLISHED'
    createdAt: resultRecord.createdAt,
    updatedAt: resultRecord.updatedAt,
  }));

  return sendSuccess(response, 200, 'Student examination results retrieved successfully.', {
    results: sanitizedResults,
    totalCount: sanitizedResults.length,
  });
});


