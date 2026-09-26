import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import Exam from '../models/Exam.js';
import Result from '../models/Result.js';
import Homework from '../models/Homework.js';
import Document from '../models/Document.js';
import School from '../models/School.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import User from '../models/User.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { calculateStudentAttendanceStats } from '../services/attendanceRollupService.js';
import { generateStudentMarksheetPdf } from '../utils/marksheetPdfGenerator.js';
import { computeClassTabulation } from '../utils/examCalculations.js';

/**
 * 🏛️ PARENT BFF (Backend-For-Frontend) CONTROLLER
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * All endpoints in this controller are mounted behind verifyParentWardLink middleware.
 * Request context guarantees:
 *   - req.parentWardLink: Authenticated parent's verified ParentStudentLink record.
 *   - req.wardProfile: Fully populated, active StudentProfile record.
 */

// ─── 1. Ward Profile Particulars ─────────────────────────────────────────────
// GET /api/v1/parent/wards/:studentProfileId/profile
export const handleGetWardProfile = asyncHandler(async (request, response) => {
  const { wardProfile, parentWardLink } = request;

  const sanitizedWard = {
    studentProfileId: wardProfile._id,
    studentUserId: wardProfile.userId?._id || wardProfile.userId,
    fullName: wardProfile.userId?.fullName || 'N/A',
    grNumber: wardProfile.grNumber,
    gender: wardProfile.gender,
    dateOfBirth: wardProfile.dateOfBirth,
    enrollmentDate: wardProfile.enrollmentDate,
    lifecycleStatus: wardProfile.lifecycleStatus,
    relationship: parentWardLink.relationship,
    linkVerifiedAt: parentWardLink.hmVerifiedAt || parentWardLink.updatedAt,
    school: {
      id: wardProfile.schoolId?._id || wardProfile.schoolId,
      name: wardProfile.schoolId?.name || 'N/A',
      code: wardProfile.schoolId?.code || 'N/A',
      emisCode: wardProfile.schoolId?.emisCode || 'N/A',
      address: wardProfile.schoolId?.address || '',
    },
    class: {
      id: wardProfile.classId?._id || wardProfile.classId,
      name: wardProfile.classId?.name || 'N/A',
      numericGrade: wardProfile.classId?.numericGrade || 0,
    },
    section: {
      id: wardProfile.sectionId?._id || wardProfile.sectionId,
      name: wardProfile.sectionId?.name || 'N/A',
    },
  };

  return sendSuccess(response, 200, 'Ward profile retrieved successfully.', sanitizedWard);
});

// ─── 2. Ward Attendance Intelligence & Daily Logs ────────────────────────────
// GET /api/v1/parent/wards/:studentProfileId/attendance
export const handleGetWardAttendance = asyncHandler(async (request, response) => {
  const { wardProfile } = request;
  const studentUserId = String(wardProfile.userId?._id || wardProfile.userId);

  // Compute standard attendance rollup stats
  let analyticsStats = null;
  try {
    analyticsStats = await calculateStudentAttendanceStats(studentUserId, wardProfile);
  } catch {
    analyticsStats = {
      overall: { totalDays: 0, presentCount: 0, absentCount: 0, leaveCount: 0, percentage: 0 },
      currentMonth: { totalDays: 0, presentCount: 0, absentCount: 0, leaveCount: 0, percentage: 0 },
    };
  }

  // Retrieve recent daily attendance logs (last 30 entries)
  const schoolId = wardProfile.schoolId?._id || wardProfile.schoolId;
  const sectionId = wardProfile.sectionId?._id || wardProfile.sectionId;

  const attendanceRecords = await Attendance.find({
    schoolId,
    sectionId,
    'records.userId': studentUserId,
  })
    .sort({ date: -1 })
    .limit(30)
    .lean();

  const dailyHistory = attendanceRecords.map((attendanceDoc) => {
    const studentEntry = (attendanceDoc.records || []).find(
      (recordItem) => String(recordItem.userId) === studentUserId
    );
    return {
      date: attendanceDoc.date,
      status: studentEntry?.status || 'UNKNOWN',
      remarks: studentEntry?.remarks || '',
    };
  });

  return sendSuccess(response, 200, 'Ward attendance records retrieved.', {
    summary: analyticsStats,
    history: dailyHistory,
  });
});

// ─── 3. Ward Academic Results (Published Only) ───────────────────────────────
// GET /api/v1/parent/wards/:studentProfileId/marksheets
export const handleGetWardMarksheets = asyncHandler(async (request, response) => {
  const { wardProfile } = request;
  const studentUserId = String(wardProfile.userId?._id || wardProfile.userId);

  // Strictly query ONLY published exam results
  const publishedResults = await Result.find({
    studentId: studentUserId,
    status: 'PUBLISHED',
  })
    .populate('examId', 'title term academicYear startDate endDate status totalMarks passingMarks')
    .populate('subjectMarks.subjectId', 'name code')
    .sort({ createdAt: -1 })
    .lean();

  const marksheets = publishedResults.map((resultItem) => ({
    resultId: resultItem._id,
    exam: {
      id: resultItem.examId?._id,
      title: resultItem.examId?.title || 'Term Examination',
      term: resultItem.examId?.term || 'Annual',
      academicYear: resultItem.examId?.academicYear || '2025-2026',
      totalMarks: resultItem.examId?.totalMarks || 700,
      passingMarks: resultItem.examId?.passingMarks || 231,
    },
    subjectMarks: (resultItem.subjectMarks || []).map((subjectMark) => ({
      subjectId: subjectMark.subjectId?._id,
      subjectName: subjectMark.subjectId?.name || 'Subject',
      subjectCode: subjectMark.subjectId?.code || '',
      theoryMarks: subjectMark.theoryMarks || 0,
      practicalMarks: subjectMark.practicalMarks || 0,
      totalObtained: subjectMark.totalObtained || 0,
      maxMarks: subjectMark.maxMarks || 100,
      passingMarks: subjectMark.passingMarks || 33,
      isPassed: subjectMark.isPassed !== false,
      grade: subjectMark.grade || 'C',
    })),
    totalMarksObtained: resultItem.totalMarksObtained || 0,
    totalMaxMarks: resultItem.totalMaxMarks || 700,
    percentage: resultItem.percentage || 0,
    grade: resultItem.grade || 'C',
    status: resultItem.status,
    rankFormatted: resultItem.rankFormatted || 'N/A',
    publishedAt: resultItem.publishedAt || resultItem.updatedAt,
  }));

  return sendSuccess(response, 200, 'Ward examination results retrieved.', {
    count: marksheets.length,
    marksheets,
  });
});

// ─── 4. Download Ward Official Marksheet PDF ─────────────────────────────────
// GET /api/v1/parent/wards/:studentProfileId/marksheets/:examId/download
export const handleDownloadWardMarksheetPdf = asyncHandler(async (request, response) => {
  const { wardProfile } = request;
  const { examId } = request.params;
  const studentUserId = String(wardProfile.userId?._id || wardProfile.userId);

  if (!examId || !/^[0-9a-fA-F]{24}$/.test(examId)) {
    return sendError(response, 400, 'Invalid exam identifier format.');
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) {
    return sendError(response, 404, 'Examination record not found.');
  }

  // Publication Gate: Parents can ONLY download PUBLISHED results
  const result = await Result.findOne({
    examId,
    studentId: studentUserId,
    status: 'PUBLISHED',
  })
    .populate('subjectMarks.subjectId', 'name code')
    .lean();

  if (!result) {
    return sendError(
      response,
      403,
      'Access denied. Official Marksheet is not available until examination results are formally published.'
    );
  }

  // Populate necessary details for marksheet rendering
  const [studentUser, schoolDoc, classDoc, sectionDoc] = await Promise.all([
    User.findById(studentUserId).lean(),
    School.findById(exam.schoolId).lean(),
    Class.findById(result.classId).lean(),
    Section.findById(result.sectionId).lean(),
  ]);

  // Compute rank if not stored
  if (!result.rankFormatted) {
    const cohortFilter = { examId };
    if (result.sectionId) {
      cohortFilter.sectionId = result.sectionId;
    } else if (result.classId) {
      cohortFilter.classId = result.classId;
    }
    const allCohortResults = await Result.find(cohortFilter).lean();
    const { rankedResults } = computeClassTabulation(allCohortResults);
    const matched = rankedResults.find((r) => String(r.studentId?._id || r.studentId) === studentUserId);
    if (matched) {
      result.rank = matched.rank;
      result.rankFormatted = matched.rankFormatted;
    }
  }

  const pdfBuffer = await generateStudentMarksheetPdf({
    result,
    exam,
    student: studentUser || wardProfile.userId,
    studentProfile: wardProfile,
    school: schoolDoc || wardProfile.schoolId,
    classDoc: classDoc || wardProfile.classId,
    sectionDoc: sectionDoc || wardProfile.sectionId,
  });

  const sanitizedFileName = `Marksheet-${wardProfile.grNumber || 'Student'}-${exam.term || 'Term'}.pdf`.replace(/\s+/g, '_');
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename="${sanitizedFileName}"`);
  response.setHeader('Content-Length', pdfBuffer.length);

  return response.status(200).send(pdfBuffer);
});

// ─── 5. Ward Homework Assignments ────────────────────────────────────────────
// GET /api/v1/parent/wards/:studentProfileId/homework
export const handleGetWardHomework = asyncHandler(async (request, response) => {
  const { wardProfile } = request;
  const schoolId = wardProfile.schoolId?._id || wardProfile.schoolId;
  const classId = wardProfile.classId?._id || wardProfile.classId;
  const sectionId = wardProfile.sectionId?._id || wardProfile.sectionId;

  const { includePastDays = 14 } = request.query;
  const pastCutoff = new Date();
  pastCutoff.setDate(pastCutoff.getDate() - Math.min(Number(includePastDays) || 14, 60));

  const homeworkList = await Homework.find({
    schoolId,
    classId,
    sectionId,
    status: 'ACTIVE',
    visibleToStudents: true,
    dueDate: { $gte: pastCutoff },
  })
    .populate('teacherId', 'fullName designation')
    .populate('subjectId', 'name code')
    .sort({ dueDate: 1 })
    .lean();

  const formattedHomework = homeworkList.map((hw) => ({
    id: hw._id,
    title: hw.title,
    description: hw.description,
    subject: {
      id: hw.subjectId?._id,
      name: hw.subjectId?.name || 'General',
      code: hw.subjectId?.code || '',
    },
    teacher: {
      id: hw.teacherId?._id,
      fullName: hw.teacherId?.fullName || 'Teacher',
      designation: hw.teacherId?.designation || '',
    },
    dueDate: hw.dueDate,
    attachments: hw.attachments || [],
    createdAt: hw.createdAt,
  }));

  return sendSuccess(response, 200, 'Ward homework assignments retrieved.', {
    count: formattedHomework.length,
    homework: formattedHomework,
  });
});

// ─── 6. Ward School & Municipal Circulars ────────────────────────────────────
// GET /api/v1/parent/wards/:studentProfileId/circulars
export const handleGetWardCirculars = asyncHandler(async (request, response) => {
  const { wardProfile } = request;
  const schoolId = wardProfile.schoolId?._id || wardProfile.schoolId;
  const townId = wardProfile.schoolId?.townId || wardProfile.townId;

  // Retrieve published circulars targeted to parents or all audiences for this school/town/global
  const circulars = await Document.find({
    status: 'PUBLISHED',
    $or: [
      {
        scope: 'GLOBAL',
        targetAudience: { $in: ['ALL', 'PARENTS'] },
      },
      {
        scope: 'TOWN',
        townId,
        targetAudience: { $in: ['ALL', 'PARENTS'] },
      },
      {
        scope: 'SCHOOL',
        schoolId,
        targetAudience: { $in: ['ALL', 'PARENTS', 'STUDENTS'] },
      },
    ],
  })
    .populate('publishedBy', 'fullName designation role')
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(50)
    .lean();

  const formattedCirculars = circulars.map((doc) => ({
    id: doc._id,
    title: doc.title,
    documentType: doc.documentType,
    scope: doc.scope,
    category: doc.category,
    summary: doc.summary,
    fileUrl: doc.fileUrl,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    publishedAt: doc.publishedAt || doc.createdAt,
    publisher: {
      name: doc.publishedBy?.fullName || 'Administration',
      designation: doc.publishedBy?.designation || 'Education Department',
    },
  }));

  return sendSuccess(response, 200, 'Ward circulars retrieved.', {
    count: formattedCirculars.length,
    circulars: formattedCirculars,
  });
});
