import asyncHandler from "express-async-handler";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import Attendance from "../models/Attendance.js";
import StudentProfile from "../models/StudentProfile.js";
import Section from "../models/Section.js";
import TeachingAssignment from "../models/TeachingAssignment.js";
import AuditLog from "../models/AuditLog.js";
import {
  ROLES,
  ATTENDANCE_STATUS,
  STUDENT_STATUS,
  USER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from "../../config/constants.js";
import { processAttendanceDelta, computeRecordsHash } from "../services/attendanceRollupService.js";
import cache from "../utils/cache.js";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION RESOLVER — The single authorization gate for all attendance endpoints.
//
// SECURITY INVARIANTS:
//   1. Actor account must be ACTIVE.
//   2. School boundary: section.schoolId must match actor.schoolId from JWT.
//      Client-supplied IDs are NEVER trusted for school resolution.
//   3. TEACHER role: must have an ACTIVE TeachingAssignment in this section.
//      Authorization source = TeachingAssignment.isTeacherAssigned() — NOT classTeacherId.
//      Attendance is section-level responsibility; any subject teacher assigned
//      to the section may mark attendance (subject check omitted intentionally).
//   4. HM and above: school boundary alone is sufficient.
//   5. PEON/STUDENT/PARENT must be blocked upstream by permission middleware.
// ─────────────────────────────────────────────────────────────────────────────
const resolveTeacherSection = async (requestingActor, sectionId, response) => {
  if (requestingActor.status && requestingActor.status !== USER_STATUS.ACTIVE) {
    sendError(response, 403, "Access denied. Your account is not in an active state. Contact your Head Master.");
    return null;
  }

  const section = await Section.findById(sectionId)
    .populate("classId", "name numericGrade code")
    .lean();

  if (!section) {
    sendError(response, 404, "Class section not found in municipal registry.");
    return null;
  }

  // School boundary — always enforced; actor.schoolId comes from JWT, not request body
  const actorSchoolId   = String(requestingActor.schoolId?._id || requestingActor.schoolId || "");
  const sectionSchoolId = String(section.schoolId);

  if (!actorSchoolId || actorSchoolId !== sectionSchoolId) {
    sendError(response, 403, "Access denied. This section belongs to a different school than your verified posting.");
    return null;
  }

  // TEACHER gate: verify via TeachingAssignment (authoritative source)
  if (requestingActor.role === ROLES.TEACHER) {
    const actorId = String(requestingActor._id || requestingActor.userId);
    const isAssigned = await TeachingAssignment.isTeacherAssigned({
      teacherId: actorId,
      schoolId:  actorSchoolId,
      sectionId: section._id,
      // subjectId omitted — attendance is section-level, not subject-level
    });
    if (!isAssigned) {
      sendError(response, 403,
        "Access denied. You have no active teaching assignment in this section. " +
        "Contact your Head Master to assign you to this class."
      );
      return null;
    }
  }
  // HM (Level 50+): school boundary above is sufficient — they govern the whole school.

  return section;
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /attendance/status
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetAttendanceStatus = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { sectionId, date } = request.query;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) return sendError(response, 400, "Invalid date format.");

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd   = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  const record = await Attendance.findOne({
    schoolId: section.schoolId,
    sectionId: section._id,
    attendanceType: "STUDENT",
    date: { $gte: dayStart, $lte: dayEnd },
  }).lean();

  if (!record) {
    return sendSuccess(response, 200, "Attendance not yet submitted.", {
      section: { _id: section._id, name: section.name, class: section.classId },
      date: queryDate.toISOString().split("T")[0],
      submitted: false,
      status: "NOT_SUBMITTED",
    });
  }

  return sendSuccess(response, 200, "Attendance status retrieved.", {
    section: { _id: section._id, name: section.name, class: section.classId },
    date: queryDate.toISOString().split("T")[0],
    submitted: true,
    status: record.verificationStatus,
    totalRecords: record.records.length,
    presentCount: record.records.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length,
    absentCount:  record.records.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length,
    leaveCount:   record.records.filter((r) => r.status === ATTENDANCE_STATUS.LEAVE).length,
    submittedAt:  record.updatedAt,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /attendance/sheet — Authoritative roster for marking
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetAttendanceSheet = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { sectionId, date } = request.query;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) return sendError(response, 400, "Invalid date format.");

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd   = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  const [studentProfiles, existingRecord] = await Promise.all([
    // Authoritative roster — teacher CANNOT add arbitrary students
    StudentProfile.find({
      sectionId: section._id,
      schoolId:  section.schoolId,
      lifecycleStatus: STUDENT_STATUS.ACTIVE,
    })
      .populate("userId", "fullName _id")
      .sort({ grNumber: 1 })
      .lean(),
    Attendance.findOne({
      schoolId: section.schoolId,
      sectionId: section._id,
      attendanceType: "STUDENT",
      date: { $gte: dayStart, $lte: dayEnd },
    }).lean(),
  ]);

  const attendanceMap = {};
  if (existingRecord) {
    for (const rec of existingRecord.records) {
      attendanceMap[String(rec.userId)] = rec;
    }
  }

  // Default is PRESENT — teacher marks exceptions (A/L) only
  const roster = studentProfiles.map((profile) => {
    const userId   = String(profile.userId?._id);
    const existing = attendanceMap[userId];
    return {
      studentProfileId: profile._id,
      userId:           profile.userId?._id,
      fullName:         profile.userId?.fullName || "Student",
      grNumber:         profile.grNumber,
      globalStudentId:  profile.globalStudentId || `GR-${profile.grNumber}`,
      gender:           profile.gender || "UNSPECIFIED",
      currentStatus:    existing?.status || ATTENDANCE_STATUS.PRESENT,
      remarks:          existing?.remarks || "",
    };
  });

  return sendSuccess(response, 200, "Attendance sheet retrieved.", {
    section: { _id: section._id, name: section.name, roomNumber: section.roomNumber || "", class: section.classId },
    date: queryDate.toISOString().split("T")[0],
    alreadySubmitted: !!existingRecord,
    verificationStatus: existingRecord?.verificationStatus || null,
    roster,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /attendance/submit
//
// Teacher sends ONLY exceptions:
//   { sectionId, date, absentStudentProfileIds: [...], leaveStudentProfileIds: [...] }
//
// Server derives:
//   Student not in absent or leave → PRESENT (automatically)
//   Student in absent → ABSENT
//   Student in leave  → LEAVE
//   Student in BOTH   → 400 Bad Request (A+L overlap)
//
// Client-supplied "P" is ignored entirely — server calculates from enrollment.
// ═══════════════════════════════════════════════════════════════════════════════
export const handleSubmitAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    sectionId,
    date,
    absentStudentProfileIds = [],
    leaveStudentProfileIds  = [],
  } = request.body;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }
  if (!Array.isArray(absentStudentProfileIds)) {
    return sendError(response, 400, "absentStudentProfileIds must be an array.");
  }
  if (!Array.isArray(leaveStudentProfileIds)) {
    return sendError(response, 400, "leaveStudentProfileIds must be an array.");
  }

  // Validate all submitted IDs are valid ObjectIds
  const allIds = [...absentStudentProfileIds, ...leaveStudentProfileIds];
  for (const id of allIds) {
    if (!/^[0-9a-fA-F]{24}$/.test(String(id))) {
      return sendError(response, 400, `Invalid studentProfileId format: ${id}`);
    }
  }

  // A + L overlap check — same student cannot be both Absent AND Leave
  const absentSet = new Set(absentStudentProfileIds.map(String));
  const leaveSet  = new Set(leaveStudentProfileIds.map(String));
  const overlaps  = [...absentSet].filter((id) => leaveSet.has(id));
  if (overlaps.length > 0) {
    return sendError(response, 400,
      `A student cannot be marked both Absent and Leave simultaneously. Conflicting IDs: ${overlaps.join(", ")}`
    );
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) return sendError(response, 400, "Invalid date format.");

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (queryDate > todayEnd) return sendError(response, 400, "Attendance cannot be submitted for a future date.");

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd   = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  // Load authoritative roster — cross-section injection rejected below
  const authorizedStudents = await StudentProfile.find({
    sectionId: section._id,
    schoolId:  section.schoolId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  })
    .populate("userId", "fullName _id")
    .lean();

  const authorizedProfileIds = new Set(authorizedStudents.map((s) => String(s._id)));
  const profileToUserId      = Object.fromEntries(authorizedStudents.map((s) => [String(s._id), s.userId?._id]));

  // Verify submitted IDs are in the authoritative roster — reject injected IDs
  for (const id of [...absentSet, ...leaveSet]) {
    if (!authorizedProfileIds.has(id)) {
      return sendError(response, 403,
        `Student profile ${id} does not belong to the authorized roster for this section. ` +
        "Cross-section or external student IDs are rejected."
      );
    }
  }

  // Server derives final P/A/L for EVERY enrolled student
  // Teacher sends only exceptions; this guarantees complete, correct records
  const sanitizedRecords = authorizedStudents.map((profile) => {
    const pid = String(profile._id);
    let status = ATTENDANCE_STATUS.PRESENT; // default
    if (absentSet.has(pid))      status = ATTENDANCE_STATUS.ABSENT;
    else if (leaveSet.has(pid))  status = ATTENDANCE_STATUS.LEAVE;
    return {
      userId:  profileToUserId[pid],
      status,
      remarks: "",
    };
  });

  const teacherSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || "");
  const teacherId       = requestingActor._id || requestingActor.userId;

  // Retrieve existing record to compute accurate mathematical delta (edit-safe)
  const existingRecord = await Attendance.findOne({
    schoolId:      teacherSchoolId,
    sectionId:     section._id,
    attendanceType: "STUDENT",
    date: { $gte: dayStart, $lte: dayEnd },
  }).lean();

  const newHash = computeRecordsHash(sanitizedRecords);
  const isDuplicate = existingRecord && existingRecord.contentHash === newHash;

  const attendanceRecord = await Attendance.findOneAndUpdate(
    {
      schoolId:      teacherSchoolId,
      sectionId:     section._id,
      attendanceType: "STUDENT",
      date: { $gte: dayStart, $lte: dayEnd },
    },
    {
      $set: {
        schoolId:      teacherSchoolId,
        sectionId:     section._id,
        attendanceType: "STUDENT",
        date:           dayStart,
        records:        sanitizedRecords,
        entryMode:      "MANUAL_PORTAL",
        recordedBy:     teacherId,
        verificationStatus: "PENDING_VERIFICATION",
        contentHash:    newHash,
        lastRollupAt:   new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Trigger atomic delta rollup if not identical duplicate
  if (!isDuplicate) {
    await processAttendanceDelta({
      schoolId: teacherSchoolId,
      sectionId: section._id,
      classId: section.classId?._id || section.classId,
      date: dayStart,
      previousRecords: existingRecord?.records || [],
      newRecords: sanitizedRecords,
    });
  }

  const presentCount = sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount  = sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount   = sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.LEAVE).length;

  await AuditLog.create({
    actorId:          teacherId,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || "",
    actorName:        requestingActor.fullName || "",
    action:           "ATTENDANCE_SUBMITTED",
    targetModel:      "Attendance",
    targetId:         attendanceRecord._id,
    targetName:       `${section.classId?.name || "Class"} — ${section.name}`,
    schoolId:         teacherSchoolId,
    previousState:    null,
    newState: {
      sectionId:    String(section._id),
      date:         dayStart.toISOString().split("T")[0],
      totalRecords: sanitizedRecords.length,
      presentCount,
      absentCount,
      leaveCount,
    },
    result:    "SUCCESS",
    reason:    "Teacher submitted daily attendance (A/L exceptions; P server-derived from enrollment).",
    ipAddress: request.ip || "",
    userAgent: request.headers["user-agent"] || "",
    requestId: request.headers["x-request-id"] || "",
  });

  return sendSuccess(response, 200, "Attendance submitted successfully.", {
    attendanceId:       attendanceRecord._id,
    section:            { _id: section._id, name: section.name, class: section.classId },
    date:               dayStart.toISOString().split("T")[0],
    totalRecords:       sanitizedRecords.length,
    presentCount,
    absentCount,
    leaveCount,
    verificationStatus: "PENDING_VERIFICATION",
    submittedAt:        attendanceRecord.updatedAt,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /attendance/register — Official monthly P/A/L register
//
// Query: sectionId, month (1-12), year
// Derived exclusively from authoritative daily Attendance records.
// This is NOT a second manually-editable source of truth.
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetAttendanceRegister = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { sectionId, month, year } = request.query;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }
  const parsedMonth = parseInt(month, 10);
  const parsedYear  = parseInt(year, 10);
  if (!parsedMonth || parsedMonth < 1 || parsedMonth > 12) {
    return sendError(response, 400, "A valid month (1-12) is required.");
  }
  if (!parsedYear || parsedYear < 2020 || parsedYear > 2100) {
    return sendError(response, 400, "A valid year is required.");
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  const rangeStart = new Date(parsedYear, parsedMonth - 1, 1, 0, 0, 0, 0);
  const rangeEnd   = new Date(parsedYear, parsedMonth, 0, 23, 59, 59, 999);

  const [attendanceRecords, studentProfiles] = await Promise.all([
    Attendance.find({
      schoolId:      section.schoolId,
      sectionId:     section._id,
      attendanceType: "STUDENT",
      date: { $gte: rangeStart, $lte: rangeEnd },
    }).sort({ date: 1 }).lean(),
    StudentProfile.find({
      sectionId:       section._id,
      schoolId:        section.schoolId,
      lifecycleStatus: STUDENT_STATUS.ACTIVE,
    })
      .populate("userId", "fullName _id")
      .sort({ grNumber: 1 })
      .lean(),
  ]);

  // Build { dateString → { userId → status } }
  const dateStatusMap = {};
  const workingDays   = [];

  for (const rec of attendanceRecords) {
    const dateStr = new Date(rec.date).toISOString().split("T")[0];
    workingDays.push(dateStr);
    dateStatusMap[dateStr] = {};
    for (const entry of rec.records) {
      dateStatusMap[dateStr][String(entry.userId)] = entry.status;
    }
  }

  const students = studentProfiles.map((profile) => {
    const uidStr     = String(profile.userId?._id);
    const attendance = {};
    const totals     = { P: 0, A: 0, L: 0 };

    for (const dateStr of workingDays) {
      const status = dateStatusMap[dateStr]?.[uidStr] || null;
      attendance[dateStr] = status;
      if (status === "PRESENT")     totals.P++;
      else if (status === "ABSENT") totals.A++;
      else if (status === "LEAVE")  totals.L++;
    }

    return {
      userId:           profile.userId?._id,
      fullName:         profile.userId?.fullName || "Student",
      grNumber:         profile.grNumber,
      globalStudentId:  profile.globalStudentId || `GR-${profile.grNumber}`,
      gender:           profile.gender || "UNSPECIFIED",
      attendance,
      totals,
      workingDaysRecorded: workingDays.length,
      attendancePercentage: workingDays.length > 0
        ? ((totals.P / workingDays.length) * 100).toFixed(1) + "%"
        : "N/A",
    };
  });

  // Class aggregate: Total Present / (Total Students × Working Days) × 100
  const totalPresent      = students.reduce((sum, s) => sum + s.totals.P, 0);
  const classAggregatePct = students.length > 0 && workingDays.length > 0
    ? ((totalPresent / (students.length * workingDays.length)) * 100).toFixed(1) + "%"
    : "N/A";

  return sendSuccess(response, 200, "Monthly attendance register retrieved.", {
    section: { _id: section._id, name: section.name, class: section.classId, schoolId: section.schoolId },
    month:            parsedMonth,
    year:             parsedYear,
    workingDays,
    totalWorkingDays: workingDays.length,
    totalStudents:    students.length,
    classAggregatePct,
    students,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /attendance/monthly-summary — Previous / Current / Total per-student summary
//
// Query: sectionId, month, year, academicSession (e.g. "2026-27")
//
// Previous = cumulative attendance before current month within the academic session
// Current  = current month only
// Total    = Previous + Current
//
// Per-student %:    Present / Applicable Working Days × 100
// Class aggregate %: Total Present / (Total Students × Working Days) × 100
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetMonthlySummary = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { sectionId, month, year, academicSession } = request.query;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }
  const parsedMonth = parseInt(month, 10);
  const parsedYear  = parseInt(year, 10);
  if (!parsedMonth || parsedMonth < 1 || parsedMonth > 12) {
    return sendError(response, 400, "A valid month (1-12) is required.");
  }
  if (!parsedYear || parsedYear < 2020 || parsedYear > 2100) {
    return sendError(response, 400, "A valid year is required.");
  }
  if (!academicSession || typeof academicSession !== "string") {
    return sendError(response, 400, 'academicSession is required (e.g. "2026-27").');
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  // Current month range
  const currentStart = new Date(parsedYear, parsedMonth - 1, 1, 0, 0, 0, 0);
  const currentEnd   = new Date(parsedYear, parsedMonth, 0, 23, 59, 59, 999);

  // Previous range: session start → last day of previous month
  // Session "2026-27" → starts Jan 1 of session start year
  const sessionStartYear = parseInt(academicSession.split("-")[0], 10) || parsedYear;
  const previousStart    = new Date(sessionStartYear, 0, 1, 0, 0, 0, 0);
  const previousEnd      = new Date(parsedYear, parsedMonth - 1, 0, 23, 59, 59, 999);

  const commonQuery = {
    schoolId:      section.schoolId,
    sectionId:     section._id,
    attendanceType: "STUDENT",
  };

  const [currentRecords, previousRecords, studentProfiles] = await Promise.all([
    Attendance.find({ ...commonQuery, date: { $gte: currentStart, $lte: currentEnd } }).sort({ date: 1 }).lean(),
    Attendance.find({ ...commonQuery, date: { $gte: previousStart, $lte: previousEnd } }).sort({ date: 1 }).lean(),
    StudentProfile.find({
      sectionId:       section._id,
      schoolId:        section.schoolId,
      lifecycleStatus: STUDENT_STATUS.ACTIVE,
    })
      .populate("userId", "fullName _id")
      .sort({ grNumber: 1 })
      .lean(),
  ]);

  const currentWorkingDays  = currentRecords.length;
  const previousWorkingDays = previousRecords.length;

  // Aggregate P/A/L for a user across a set of daily records
  const aggregate = (records, uidStr) => {
    let present = 0, absent = 0, leave = 0;
    for (const rec of records) {
      const entry = rec.records.find((r) => String(r.userId) === uidStr);
      if (entry) {
        if (entry.status === ATTENDANCE_STATUS.PRESENT)     present++;
        else if (entry.status === ATTENDANCE_STATUS.ABSENT) absent++;
        else if (entry.status === ATTENDANCE_STATUS.LEAVE)  leave++;
      }
    }
    return { present, absent, leave };
  };

  const students = studentProfiles.map((profile) => {
    const uidStr   = String(profile.userId?._id);
    const current  = aggregate(currentRecords, uidStr);
    const previous = aggregate(previousRecords, uidStr);

    const total = {
      present:     previous.present + current.present,
      absent:      previous.absent  + current.absent,
      leave:       previous.leave   + current.leave,
      workingDays: previousWorkingDays + currentWorkingDays,
    };

    const totalPct = total.workingDays > 0
      ? ((total.present / total.workingDays) * 100).toFixed(1) + "%"
      : "N/A";

    return {
      userId:          profile.userId?._id,
      fullName:        profile.userId?.fullName || "Student",
      grNumber:        profile.grNumber,
      globalStudentId: profile.globalStudentId || `GR-${profile.grNumber}`,
      previousMonth: { ...previous, workingDays: previousWorkingDays },
      currentMonth:  { ...current,  workingDays: currentWorkingDays  },
      total,
      attendancePercentage: totalPct,
    };
  });

  // Class aggregate: Total Present (all students) / (Total Students × Total Working Days) × 100
  const totalPresentAll   = students.reduce((sum, s) => sum + s.total.present, 0);
  const totalWorkingDays  = currentWorkingDays + previousWorkingDays;
  const classAggregatePct = students.length > 0 && totalWorkingDays > 0
    ? ((totalPresentAll / (students.length * totalWorkingDays)) * 100).toFixed(1) + "%"
    : "N/A";

  return sendSuccess(response, 200, "Monthly attendance summary retrieved.", {
    section: { _id: section._id, name: section.name, class: section.classId, schoolId: section.schoolId },
    month:                parsedMonth,
    year:                 parsedYear,
    academicSession,
    currentWorkingDays,
    previousWorkingDays,
    totalWorkingDays,
    totalStudents:        students.length,
    classAggregatePct,
    students,
  });
});