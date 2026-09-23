import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import AttendanceSummary from '../models/AttendanceSummary.js';
import StudentProfile from '../models/StudentProfile.js';
import Section from '../models/Section.js';
import School from '../models/School.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import AuditLog from '../models/AuditLog.js';
import cache from '../utils/cache.js';
import {
  calculateStudentAttendanceStats,
  resolveAcademicSession,
} from '../services/attendanceRollupService.js';
import { ROLES, STUDENT_STATUS } from '../../config/constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/analytics/student/:userId?
// Single student attendance intelligence (Current Month, Last Month, Academic Year)
// ─────────────────────────────────────────────────────────────────────────────
export const handleGetStudentAttendanceAnalytics = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorId = String(requestingActor._id || requestingActor.userId);
  const actorRole = requestingActor.role;

  const suppliedUserId = request.params.userId || request.query.userId;
  let targetUserId;

  // Student can only see their own attendance — attempting to pass another user's ID is rejected with 403
  if (actorRole === ROLES.STUDENT) {
    if (suppliedUserId && String(suppliedUserId) !== actorId) {
      await AuditLog.create({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorName: requestingActor.fullName || '',
        action: 'STUDENT_ATTENDANCE_SPOOF_BLOCKED',
        targetModel: 'Attendance',
        targetId: suppliedUserId,
        targetName: request.originalUrl,
        schoolId: requestingActor.schoolId || null,
        previousState: {
          attemptedUserId: suppliedUserId,
          authenticatedStudentId: actorId,
        },
        result: 'DENIED',
        reason: 'BOLA/IDOR attempt intercepted: Student passed another user\'s ID to attendance analytics.',
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
      });
      return sendError(response, 403, 'Access denied. You cannot inspect attendance analytics for another student.');
    }
    targetUserId = actorId;
  } else {
    targetUserId = suppliedUserId;
    if (!targetUserId) {
      return sendError(response, 400, 'A valid student userId is required.');
    }
  }

  if (!/^[0-9a-fA-F]{24}$/.test(targetUserId)) {
    return sendError(response, 400, 'Invalid userId format.');
  }

  // Load student profile for authority resolution
  const profile = await StudentProfile.findOne({ userId: targetUserId })
    .populate('userId', 'fullName email')
    .populate('schoolId', 'name code')
    .populate('classId', 'name')
    .populate('sectionId', 'name')
    .lean();

  if (!profile) {
    return sendError(response, 404, 'Student profile not found in municipal registry.');
  }

  // Scope & Authorization checks
  if (actorRole === ROLES.PARENT) {
    if (String(profile.parentUserId) !== actorId) {
      return sendError(response, 403, 'Access denied. You are not recorded as the authorized guardian for this student.');
    }
  } else if (actorRole === ROLES.TEACHER) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (String(profile.schoolId?._id || profile.schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. Student belongs to a different school.');
    }
    const isAssigned = await TeachingAssignment.isTeacherAssigned({
      teacherId: actorId,
      schoolId: actorSchoolId,
      sectionId: profile.sectionId?._id || profile.sectionId,
    });
    if (!isAssigned) {
      return sendError(response, 403, 'Access denied. You do not hold an active teaching assignment for this student\'s section.');
    }
  } else if (actorRole === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (String(profile.schoolId?._id || profile.schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. Student belongs to a different school than your jurisdiction.');
    }
  } else if (actorRole === ROLES.SUPERVISOR) {
    const assignedSchools = (requestingActor.assignedSchools || []).map(String);
    if (!assignedSchools.includes(String(profile.schoolId?._id || profile.schoolId))) {
      return sendError(response, 403, 'Access denied. Student\'s school is outside your supervisory zone.');
    }
  }
  // ADMIN, SUPER_ADMIN, ROOT_ADMIN have town-wide access

  const stats = await calculateStudentAttendanceStats(targetUserId, profile);
  if (!stats) {
    return sendError(response, 404, 'Attendance analytics unavailable for this student.');
  }

  return sendSuccess(response, 200, 'Student attendance analytics retrieved.', stats);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/analytics/section/:sectionId
// Class section analytics: aggregate + per-student comparison roster
// ─────────────────────────────────────────────────────────────────────────────
export const handleGetSectionAttendanceAnalytics = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorId = String(requestingActor._id || requestingActor.userId);
  const actorRole = requestingActor.role;
  const { sectionId } = request.params;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, 'A valid sectionId is required.');
  }

  const section = await Section.findById(sectionId)
    .populate('classId', 'name numericGrade code')
    .populate('schoolId', 'name code')
    .lean();

  if (!section) {
    return sendError(response, 404, 'Section not found.');
  }

  const sectionSchoolId = String(section.schoolId?._id || section.schoolId);

  // Authority enforcement
  if (actorRole === ROLES.TEACHER) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (actorSchoolId !== sectionSchoolId) {
      return sendError(response, 403, 'Access denied. Section belongs to a different school.');
    }
    const isAssigned = await TeachingAssignment.isTeacherAssigned({
      teacherId: actorId,
      schoolId: actorSchoolId,
      sectionId: section._id,
    });
    if (!isAssigned) {
      return sendError(response, 403, 'Access denied. No active teaching assignment in this section.');
    }
  } else if (actorRole === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (actorSchoolId !== sectionSchoolId) {
      return sendError(response, 403, 'Access denied. Section belongs to a different school.');
    }
  } else if (actorRole === ROLES.SUPERVISOR) {
    const assignedSchools = (requestingActor.assignedSchools || []).map(String);
    if (!assignedSchools.includes(sectionSchoolId)) {
      return sendError(response, 403, 'Access denied. Section\'s school is outside your supervisory zone.');
    }
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const lastMonthDate = new Date(currentYear, currentMonth - 2, 1);
  const lastYear = lastMonthDate.getFullYear();
  const lastMonth = lastMonthDate.getMonth() + 1;
  const session = resolveAcademicSession(now);

  // Load all active student profiles for this section
  const studentProfiles = await StudentProfile.find({
    sectionId: section._id,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  })
    .populate('userId', 'fullName _id')
    .sort({ grNumber: 1 })
    .lean();

  const userIds = studentProfiles.map(studentProfile => studentProfile.userId?._id).filter(Boolean);

  // Fetch all summaries for these students in this session
  const summaries = await AttendanceSummary.find({
    userId: { $in: userIds },
    academicSession: session,
  }).lean();

  // Map: `${userId}_${year}_${month}` -> summary
  const summaryMap = {};
  for (const summaryRecord of summaries) {
    summaryMap[`${String(summaryRecord.userId)}_${summaryRecord.year}_${summaryRecord.month}`] = summaryRecord;
  }

  let sectionCurrentPresent = 0;
  let sectionCurrentWorking = 0;
  let sectionLastPresent = 0;
  let sectionLastWorking = 0;
  let sectionSessionPresent = 0;
  let sectionSessionWorking = 0;

  const roster = studentProfiles.map(studentProfile => {
    const uid = String(studentProfile.userId?._id);
    const curr = summaryMap[`${uid}_${currentYear}_${currentMonth}`] || { presentDays: 0, totalWorkingDays: 0, absentDays: 0, leaveDays: 0 };
    const last = summaryMap[`${uid}_${lastYear}_${lastMonth}`] || { presentDays: 0, totalWorkingDays: 0, absentDays: 0, leaveDays: 0 };

    // Sum overall session for this student
    const studentSessionSummaries = summaries.filter(sessionSummary => String(sessionSummary.userId) === uid);
    let stSessionPresent = 0;
    let stSessionWorking = 0;
    let stSessionAbsent = 0;
    let stSessionLeave = 0;

    for (const s of studentSessionSummaries) {
      stSessionPresent += s.presentDays;
      stSessionWorking += s.totalWorkingDays;
      stSessionAbsent += s.absentDays;
      stSessionLeave += s.leaveDays;
    }

    sectionCurrentPresent += curr.presentDays;
    sectionCurrentWorking += curr.totalWorkingDays;
    sectionLastPresent += last.presentDays;
    sectionLastWorking += last.totalWorkingDays;
    sectionSessionPresent += stSessionPresent;
    sectionSessionWorking += stSessionWorking;

    const calcPct = (pDays, wDays) => wDays > 0 ? Number(((pDays / wDays) * 100).toFixed(1)) : 0;

    return {
      userId: p.userId?._id,
      fullName: p.userId?.fullName || 'Student',
      grNumber: p.grNumber,
      globalStudentId: p.globalStudentId || `GR-${p.grNumber}`,
      currentMonth: {
        present: curr.presentDays,
        absent: curr.absentDays,
        leave: curr.leaveDays,
        workingDays: curr.totalWorkingDays,
        percentage: calcPct(curr.presentDays, curr.totalWorkingDays),
      },
      lastMonth: {
        present: last.presentDays,
        absent: last.absentDays,
        leave: last.leaveDays,
        workingDays: last.totalWorkingDays,
        percentage: calcPct(last.presentDays, last.totalWorkingDays),
      },
      academicYear: {
        present: stSessionPresent,
        absent: stSessionAbsent,
        leave: stSessionLeave,
        workingDays: stSessionWorking,
        percentage: calcPct(stSessionPresent, stSessionWorking),
      },
    };
  });

  const calcSectionPct = (pDays, wDays) => wDays > 0 ? Number(((pDays / wDays) * 100).toFixed(1)) : 0;

  return sendSuccess(response, 200, 'Section attendance analytics retrieved.', {
    section: {
      _id: section._id,
      name: section.name,
      class: section.classId,
      school: section.schoolId,
    },
    academicSession: session,
    totalEnrolled: studentProfiles.length,
    aggregates: {
      currentMonthPct: calcSectionPct(sectionCurrentPresent, sectionCurrentWorking),
      lastMonthPct: calcSectionPct(sectionLastPresent, sectionLastWorking),
      overallSessionPct: calcSectionPct(sectionSessionPresent, sectionSessionWorking),
    },
    roster,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/analytics/school/:schoolId?
// School overview: aggregates, section comparisons, and low attendance flags
// ─────────────────────────────────────────────────────────────────────────────
export const handleGetSchoolAttendanceAnalytics = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorRole = requestingActor.role;

  let targetSchoolId = request.params.schoolId || request.query.schoolId;

  if (actorRole === ROLES.HM) {
    targetSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
  }

  if (!targetSchoolId || !/^[0-9a-fA-F]{24}$/.test(targetSchoolId)) {
    return sendError(response, 400, 'A valid schoolId is required.');
  }

  // Supervisor boundary check
  if (actorRole === ROLES.SUPERVISOR) {
    const assigned = (requestingActor.assignedSchools || []).map(String);
    if (!assigned.includes(String(targetSchoolId))) {
      return sendError(response, 403, 'Access denied. School is outside your supervisory jurisdiction.');
    }
  }

  const cacheKey = `school:${targetSchoolId}:analytics`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return sendSuccess(response, 200, 'School attendance analytics retrieved (cached).', cachedData);
  }

  const school = await School.findById(targetSchoolId).select('name code dmcRegion').lean();
  if (!school) {
    return sendError(response, 404, 'School not found.');
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const lastMonthDate = new Date(currentYear, currentMonth - 2, 1);
  const lastYear = lastMonthDate.getFullYear();
  const lastMonth = lastMonthDate.getMonth() + 1;
  const session = resolveAcademicSession(now);

  const [sections, allSummaries, studentCount] = await Promise.all([
    Section.find({ schoolId: targetSchoolId }).populate('classId', 'name numericGrade').lean(),
    AttendanceSummary.find({ schoolId: targetSchoolId, academicSession: session }).lean(),
    StudentProfile.countDocuments({ schoolId: targetSchoolId, lifecycleStatus: STUDENT_STATUS.ACTIVE }),
  ]);

  let totalCurrP = 0;
  let totalCurrW = 0;
  let totalLastP = 0;
  let totalLastW = 0;
  let totalSessP = 0;
  let totalSessW = 0;

  // Group summaries by sectionId
  const sectionSummaryMap = {};
  for (const s of allSummaries) {
    const secId = String(s.sectionId || 'unassigned');
    if (!sectionSummaryMap[secId]) {
      sectionSummaryMap[secId] = { currP: 0, currW: 0, lastP: 0, lastW: 0, sessP: 0, sessW: 0 };
    }
    const group = sectionSummaryMap[secId];

    if (s.year === currentYear && s.month === currentMonth) {
      group.currP += s.presentDays;
      group.currW += s.totalWorkingDays;
      totalCurrP += s.presentDays;
      totalCurrW += s.totalWorkingDays;
    } else if (s.year === lastYear && s.month === lastMonth) {
      group.lastP += s.presentDays;
      group.lastW += s.totalWorkingDays;
      totalLastP += s.presentDays;
      totalLastW += s.totalWorkingDays;
    }

    group.sessP += s.presentDays;
    group.sessW += s.totalWorkingDays;
    totalSessP += s.presentDays;
    totalSessW += s.totalWorkingDays;
  }

  const calcPct = (pDays, wDays) => wDays > 0 ? Number(((pDays / wDays) * 100).toFixed(1)) : 0;

  const sectionBreakdown = sections.map(sec => {
    const data = sectionSummaryMap[String(sec._id)] || { currP: 0, currW: 0, lastP: 0, lastW: 0, sessP: 0, sessW: 0 };
    return {
      sectionId: sec._id,
      name: sec.name,
      class: sec.classId?.name || 'Class',
      currentMonthPct: calcPct(data.currP, data.currW),
      lastMonthPct: calcPct(data.lastP, data.lastW),
      overallSessionPct: calcPct(data.sessP, data.sessW),
    };
  });

  // Calculate per-student low attendance (< 75%)
  const studentTotals = {};
  for (const s of allSummaries) {
    const uid = String(s.userId);
    if (!studentTotals[uid]) {
      studentTotals[uid] = {
        userId: s.userId,
        studentProfileId: s.studentProfileId,
        sectionId: s.sectionId,
        present: 0,
        workingDays: 0,
      };
    }
    studentTotals[uid].present += s.presentDays;
    studentTotals[uid].workingDays += s.totalWorkingDays;
  }

  const lowAttendanceProfiles = Object.values(studentTotals)
    .filter(st => st.workingDays >= 10 && calcPct(st.present, st.workingDays) < 75)
    .map(st => ({
      userId: st.userId,
      present: st.present,
      workingDays: st.workingDays,
      percentage: calcPct(st.present, st.workingDays),
    }));

  const result = {
    school: {
      _id: school._id,
      name: school.name,
      code: school.code,
      dmcRegion: school.dmcRegion,
    },
    academicSession: session,
    totalEnrolledStudents: studentCount,
    aggregates: {
      currentMonthPct: calcPct(totalCurrP, totalCurrW),
      lastMonthPct: calcPct(totalLastP, totalLastW),
      overallSessionPct: calcPct(totalSessP, totalSessW),
    },
    sectionBreakdown,
    lowAttendanceCount: lowAttendanceProfiles.length,
    lowAttendanceList: lowAttendanceProfiles.slice(0, 20), // Top 20 alerts
  };

  // Cache for 5 minutes (300 seconds)
  cache.set(cacheKey, result, 300);

  return sendSuccess(response, 200, 'School attendance analytics retrieved.', result);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /attendance/analytics/town-overview
// Town-level oversight across all DMC municipal schools
// ─────────────────────────────────────────────────────────────────────────────
export const handleGetTownAttendanceOverview = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorRole = requestingActor.role;

  // Permitted only for Level 60+ (Supervisor, Admin, Super Admin, Root Admin)
  const allowedRoles = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR];
  if (!allowedRoles.includes(actorRole)) {
    return sendError(response, 403, 'Access denied. Town-wide overview is reserved for municipal leadership.');
  }

  const cacheKey = 'town:overview:analytics';
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return sendSuccess(response, 200, 'Town attendance overview retrieved (cached).', cachedData);
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const lastMonthDate = new Date(currentYear, currentMonth - 2, 1);
  const lastYear = lastMonthDate.getFullYear();
  const lastMonth = lastMonthDate.getMonth() + 1;
  const session = resolveAcademicSession(now);

  const [schools, allSummaries, totalEnrolledStudents] = await Promise.all([
    School.find({}).select('name code dmcRegion').lean(),
    AttendanceSummary.find({ academicSession: session }).lean(),
    StudentProfile.countDocuments({ lifecycleStatus: STUDENT_STATUS.ACTIVE }),
  ]);

  let townCurrP = 0;
  let townCurrW = 0;
  let townLastP = 0;
  let townLastW = 0;
  let townSessP = 0;
  let townSessW = 0;

  const schoolMetricsMap = {};
  for (const s of schools) {
    schoolMetricsMap[String(s._id)] = {
      schoolId: s._id,
      name: s.name,
      code: s.code,
      dmcRegion: s.dmcRegion || 'Liaquatabad',
      currP: 0,
      currW: 0,
      lastP: 0,
      lastW: 0,
      sessP: 0,
      sessW: 0,
    };
  }

  for (const sum of allSummaries) {
    const sId = String(sum.schoolId);
    const metric = schoolMetricsMap[sId];
    if (metric) {
      if (sum.year === currentYear && sum.month === currentMonth) {
        metric.currP += sum.presentDays;
        metric.currW += sum.totalWorkingDays;
        townCurrP += sum.presentDays;
        townCurrW += sum.totalWorkingDays;
      } else if (sum.year === lastYear && sum.month === lastMonth) {
        metric.lastP += sum.presentDays;
        metric.lastW += sum.totalWorkingDays;
        townLastP += sum.presentDays;
        townLastW += sum.totalWorkingDays;
      }

      metric.sessP += sum.presentDays;
      metric.sessW += sum.totalWorkingDays;
      townSessP += sum.presentDays;
      townSessW += sum.totalWorkingDays;
    }
  }

  const calcPct = (pDays, wDays) => wDays > 0 ? Number(((pDays / wDays) * 100).toFixed(1)) : 0;

  const schoolRankings = Object.values(schoolMetricsMap).map((schoolMetric) => ({
    schoolId: schoolMetric.schoolId,
    name: schoolMetric.name,
    code: schoolMetric.code,
    dmcRegion: schoolMetric.dmcRegion,
    currentMonthPct: calcPct(schoolMetric.currP, schoolMetric.currW),
    lastMonthPct: calcPct(schoolMetric.lastP, schoolMetric.lastW),
    overallSessionPct: calcPct(schoolMetric.sessP, schoolMetric.sessW),
  })).sort((rankingA, rankingB) => rankingB.overallSessionPct - rankingA.overallSessionPct);

  const result = {
    academicSession: session,
    totalSchools: schools.length,
    totalEnrolledStudents,
    townAggregates: {
      currentMonthPct: calcPct(townCurrP, townCurrW),
      lastMonthPct: calcPct(townLastP, townLastW),
      overallSessionPct: calcPct(townSessP, townSessW),
    },
    schoolRankings,
  };

  // Cache town overview for 2 minutes (120 seconds)
  cache.set(cacheKey, result, 120);

  return sendSuccess(response, 200, 'Town attendance overview retrieved.', result);
});
