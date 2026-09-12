import crypto from 'crypto';
import Attendance from '../models/Attendance.js';
import AttendanceSummary from '../models/AttendanceSummary.js';
import StudentProfile from '../models/StudentProfile.js';
import cache from '../utils/cache.js';
import { ATTENDANCE_STATUS } from '../../config/constants.js';

/**
 * Resolves standard academic session string from date (e.g. July-June cycle)
 * @param {Date} date
 * @returns {string} e.g. "2025-2026"
 */
export const resolveAcademicSession = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getFullYear();
  // July or later is session start year; before July is second year of session
  if (d.getMonth() >= 6) {
    return `${year}-${year + 1}`;
  }
  return `${year - 1}-${year}`;
};

/**
 * Creates a deterministic hash of records to detect identical submissions
 * @param {Array} records 
 * @returns {string}
 */
export const computeRecordsHash = (records = []) => {
  const sorted = [...records]
    .map(r => `${String(r.userId)}:${r.status}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(sorted).digest('hex').substring(0, 32);
};

/**
 * Process delta updates on AttendanceSummary for student records
 * Handles new submissions, in-place corrections/edits, and deletes/unmarks idempotently.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.schoolId
 * @param {string|ObjectId} params.sectionId
 * @param {string|ObjectId} params.classId
 * @param {Date} params.date
 * @param {Array} params.previousRecords
 * @param {Array} params.newRecords
 * @param {string} [params.academicSession]
 * @param {boolean} [params.isDeleted]
 */
export const processAttendanceDelta = async ({
  schoolId,
  sectionId,
  classId,
  date,
  previousRecords = [],
  newRecords = [],
  academicSession,
  isDeleted = false,
}) => {
  const recordDate = new Date(date);
  const year = recordDate.getFullYear();
  const month = recordDate.getMonth() + 1; // 1-indexed (1-12)
  const session = academicSession || resolveAcademicSession(recordDate);

  // Build maps: userId -> status
  const oldMap = {};
  for (const r of previousRecords) {
    oldMap[String(r.userId)] = r.status;
  }

  const newMap = {};
  if (!isDeleted) {
    for (const r of newRecords) {
      newMap[String(r.userId)] = r.status;
    }
  }

  // Find all student userIds touched in this pass
  const allUserIds = Array.from(new Set([...Object.keys(oldMap), ...Object.keys(newMap)]));
  if (allUserIds.length === 0) return;

  // Batch query student profiles to capture studentProfileId
  const profiles = await StudentProfile.find({
    userId: { $in: allUserIds },
  }).select('_id userId classId sectionId').lean();

  const profileByUserId = {};
  for (const p of profiles) {
    profileByUserId[String(p.userId)] = p;
  }

  const bulkOps = [];

  for (const uid of allUserIds) {
    const oldStatus = oldMap[uid];
    const newStatus = newMap[uid];

    let deltaWorkingDays = 0;
    let deltaPresent = 0;
    let deltaAbsent = 0;
    let deltaLeave = 0;

    if (isDeleted) {
      // Entire day or student was removed
      if (oldStatus) {
        deltaWorkingDays = -1;
        if (oldStatus === ATTENDANCE_STATUS.PRESENT) deltaPresent = -1;
        else if (oldStatus === ATTENDANCE_STATUS.ABSENT) deltaAbsent = -1;
        else if (oldStatus === ATTENDANCE_STATUS.LEAVE) deltaLeave = -1;
      }
    } else if (!oldStatus && newStatus) {
      // Brand new entry for student on this date
      deltaWorkingDays = 1;
      if (newStatus === ATTENDANCE_STATUS.PRESENT) deltaPresent = 1;
      else if (newStatus === ATTENDANCE_STATUS.ABSENT) deltaAbsent = 1;
      else if (newStatus === ATTENDANCE_STATUS.LEAVE) deltaLeave = 1;
    } else if (oldStatus && newStatus) {
      // Edit / Correction on existing date
      if (oldStatus === newStatus) {
        // Idempotent: No change
        continue;
      }
      deltaWorkingDays = 0; // Working day count unchanged
      deltaPresent = (newStatus === ATTENDANCE_STATUS.PRESENT ? 1 : 0) - (oldStatus === ATTENDANCE_STATUS.PRESENT ? 1 : 0);
      deltaAbsent  = (newStatus === ATTENDANCE_STATUS.ABSENT  ? 1 : 0) - (oldStatus === ATTENDANCE_STATUS.ABSENT  ? 1 : 0);
      deltaLeave   = (newStatus === ATTENDANCE_STATUS.LEAVE   ? 1 : 0) - (oldStatus === ATTENDANCE_STATUS.LEAVE   ? 1 : 0);
    } else if (oldStatus && !newStatus) {
      // Student unmarked from roster on this date
      deltaWorkingDays = -1;
      if (oldStatus === ATTENDANCE_STATUS.PRESENT) deltaPresent = -1;
      else if (oldStatus === ATTENDANCE_STATUS.ABSENT) deltaAbsent = -1;
      else if (oldStatus === ATTENDANCE_STATUS.LEAVE) deltaLeave = -1;
    }

    if (deltaWorkingDays === 0 && deltaPresent === 0 && deltaAbsent === 0 && deltaLeave === 0) {
      continue;
    }

    const studentProfile = profileByUserId[uid];

    bulkOps.push({
      updateOne: {
        filter: {
          userId: uid,
          academicSession: session,
          year,
          month,
        },
        update: {
          $inc: {
            totalWorkingDays: deltaWorkingDays,
            presentDays: deltaPresent,
            absentDays: deltaAbsent,
            leaveDays: deltaLeave,
          },
          $setOnInsert: {
            entityType: 'STUDENT',
            studentProfileId: studentProfile?._id || null,
            schoolId,
            classId: classId || studentProfile?.classId,
            sectionId: sectionId || studentProfile?.sectionId,
            academicSession: session,
            year,
            month,
          },
          $set: {
            lastCalculatedAt: new Date(),
          },
        },
        upsert: true,
      },
    });
  }

  if (bulkOps.length > 0) {
    await AttendanceSummary.bulkWrite(bulkOps);
  }

  // Cascading cache invalidation for the affected school and town overview
  cache.invalidateSchool(schoolId);
};

/**
 * Reconcile/Recalculate summary from authoritative Attendance records
 * Self-healing mechanism to guarantee absolute correctness and recover from anomalies.
 */
export const reconcileSectionMonthRollup = async (schoolId, sectionId, year, month, academicSession) => {
  const session = academicSession || `${year}-${year + 1}`;
  const rangeStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const rangeEnd = new Date(year, month, 0, 23, 59, 59, 999);

  const [records, studentProfiles] = await Promise.all([
    Attendance.find({
      schoolId,
      sectionId,
      attendanceType: 'STUDENT',
      date: { $gte: rangeStart, $lte: rangeEnd },
    }).lean(),
    StudentProfile.find({
      sectionId,
      schoolId,
    }).select('_id userId classId sectionId').lean(),
  ]);

  const bulkOps = [];

  for (const profile of studentProfiles) {
    const uidStr = String(profile.userId);
    let presentDays = 0;
    let absentDays = 0;
    let leaveDays = 0;
    let totalWorkingDays = 0;

    for (const rec of records) {
      const entry = rec.records?.find(r => String(r.userId) === uidStr);
      if (entry) {
        totalWorkingDays++;
        if (entry.status === ATTENDANCE_STATUS.PRESENT) presentDays++;
        else if (entry.status === ATTENDANCE_STATUS.ABSENT) absentDays++;
        else if (entry.status === ATTENDANCE_STATUS.LEAVE) leaveDays++;
      }
    }

    bulkOps.push({
      updateOne: {
        filter: {
          userId: profile.userId,
          academicSession: session,
          year,
          month,
        },
        update: {
          $set: {
            entityType: 'STUDENT',
            studentProfileId: profile._id,
            schoolId,
            classId: profile.classId,
            sectionId: profile.sectionId,
            academicSession: session,
            year,
            month,
            totalWorkingDays,
            presentDays,
            absentDays,
            leaveDays,
            lastCalculatedAt: new Date(),
          },
        },
        upsert: true,
      },
    });
  }

  if (bulkOps.length > 0) {
    await AttendanceSummary.bulkWrite(bulkOps);
  }

  cache.invalidateSchool(schoolId);
};

/**
 * Calculates student attendance intelligence:
 * 1. Current Month %
 * 2. Last Month %
 * 3. Academic Year / Overall % strictly calculated from official admissionDate up to now
 *
 * @param {ObjectId|string} userId
 * @param {Object} [studentProfile]
 * @returns {Promise<Object>}
 */
export const calculateStudentAttendanceStats = async (userId, studentProfile = null) => {
  const profile = studentProfile || await StudentProfile.findOne({ userId }).populate('schoolId', 'name code').populate('classId', 'name').populate('sectionId', 'name').lean();
  if (!profile) {
    return null;
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // Calculate last month and year
  const lastMonthDate = new Date(currentYear, currentMonth - 2, 1);
  const lastYear = lastMonthDate.getFullYear();
  const lastMonth = lastMonthDate.getMonth() + 1;

  const currentSession = resolveAcademicSession(now);

  // Fetch all monthly summaries for this student in the current session
  const summaries = await AttendanceSummary.find({
    userId,
    academicSession: currentSession,
  }).sort({ year: 1, month: 1 }).lean();

  const summaryMap = {};
  for (const s of summaries) {
    summaryMap[`${s.year}-${s.month}`] = s;
  }

  // Current Month Stats
  const currentSum = summaryMap[`${currentYear}-${currentMonth}`] || {
    totalWorkingDays: 0,
    presentDays: 0,
    absentDays: 0,
    leaveDays: 0,
  };

  // Last Month Stats
  const lastSum = summaryMap[`${lastYear}-${lastMonth}`] || {
    totalWorkingDays: 0,
    presentDays: 0,
    absentDays: 0,
    leaveDays: 0,
  };

  // Overall / Academic Year calculation:
  // Strictly respects student's admissionDate: attendance before admission date is excluded.
  const admissionDate = profile.admissionDate ? new Date(profile.admissionDate) : new Date(currentYear, 0, 1);
  const admissionYear = admissionDate.getFullYear();
  const admissionMonth = admissionDate.getMonth() + 1;

  let sessionTotalWorkingDays = 0;
  let sessionPresentDays = 0;
  let sessionAbsentDays = 0;
  let sessionLeaveDays = 0;

  const monthlyHistory = [];

  for (const s of summaries) {
    // If summary is for a month before student's admission, skip from academic year total
    if (s.year < admissionYear || (s.year === admissionYear && s.month < admissionMonth)) {
      continue;
    }

    sessionTotalWorkingDays += Math.max(0, s.totalWorkingDays);
    sessionPresentDays += Math.max(0, s.presentDays);
    sessionAbsentDays += Math.max(0, s.absentDays);
    sessionLeaveDays += Math.max(0, s.leaveDays);

    monthlyHistory.push({
      year: s.year,
      month: s.month,
      monthLabel: new Date(s.year, s.month - 1, 1).toLocaleString('default', { month: 'short' }),
      totalWorkingDays: s.totalWorkingDays,
      presentDays: s.presentDays,
      absentDays: s.absentDays,
      leaveDays: s.leaveDays,
      percentage: s.totalWorkingDays > 0
        ? Number(((s.presentDays / s.totalWorkingDays) * 100).toFixed(1))
        : 0,
    });
  }

  const calcPct = (present, total) => {
    if (!total || total <= 0) return 0;
    return Number(((present / total) * 100).toFixed(1));
  };

  return {
    student: {
      userId: profile.userId,
      studentProfileId: profile._id,
      grNumber: profile.grNumber,
      globalStudentId: profile.globalStudentId,
      admissionDate: profile.admissionDate,
      school: profile.schoolId,
      class: profile.classId,
      section: profile.sectionId,
    },
    academicSession: currentSession,
    currentMonth: {
      year: currentYear,
      month: currentMonth,
      monthLabel: now.toLocaleString('default', { month: 'long' }),
      workingDays: currentSum.totalWorkingDays,
      present: currentSum.presentDays,
      absent: currentSum.absentDays,
      leave: currentSum.leaveDays,
      percentage: calcPct(currentSum.presentDays, currentSum.totalWorkingDays),
    },
    lastMonth: {
      year: lastYear,
      month: lastMonth,
      monthLabel: lastMonthDate.toLocaleString('default', { month: 'long' }),
      workingDays: lastSum.totalWorkingDays,
      present: lastSum.presentDays,
      absent: lastSum.absentDays,
      leave: lastSum.leaveDays,
      percentage: calcPct(lastSum.presentDays, lastSum.totalWorkingDays),
    },
    academicYear: {
      session: currentSession,
      calculatedFromAdmissionDate: admissionDate.toISOString().split('T')[0],
      totalWorkingDays: sessionTotalWorkingDays,
      present: sessionPresentDays,
      absent: sessionAbsentDays,
      leave: sessionLeaveDays,
      percentage: calcPct(sessionPresentDays, sessionTotalWorkingDays),
    },
    monthlyHistory,
  };
};
