import asyncHandler from "express-async-handler";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import Attendance from "../models/Attendance.js";
import StudentProfile from "../models/StudentProfile.js";
import Section from "../models/Section.js";
import TeachingAssignment from "../models/TeachingAssignment.js";
import AuditLog from "../models/AuditLog.js";
import School from "../models/School.js";
import User from "../models/User.js";
import TeacherProfile from "../models/TeacherProfile.js";
import HolidayCalendar from "../models/HolidayCalendar.js";
import WeeklyOffPattern from "../models/WeeklyOffPattern.js";
import {
  ROLES,
  ATTENDANCE_STATUS,
  STUDENT_STATUS,
  USER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from "../../config/constants.js";
import { processAttendanceDelta, computeRecordsHash } from "../services/attendanceRollupService.js";
import { validateSubmissionWindow, checkIsSchoolClosed, resolveSchoolSchedule } from "../services/attendanceWindowService.js";
import {
  getKarachiTimeString,
  getKarachiDateString,
  getKarachiDayOfWeek,
} from "../utils/karachiTime.js";
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

  // TEACHER gate: verify via TeachingAssignment or classTeacherId
  if (requestingActor.role === ROLES.TEACHER) {
    const actorId = String(requestingActor._id || requestingActor.userId);
    const isAssigned = (await TeachingAssignment.isTeacherAssigned({
      teacherId: actorId,
      schoolId:  actorSchoolId,
      sectionId: section._id,
      // subjectId omitted — attendance is section-level, not subject-level
    })) || (section.classTeacherId && String(section.classTeacherId._id || section.classTeacherId) === actorId);

    if (!isAssigned) {
      sendError(response, 403,
        "Access denied. You have no active teaching assignment or class teacher role in this section. " +
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
    presentCount: record.records.filter((recordItem) => recordItem.status === ATTENDANCE_STATUS.PRESENT).length,
    absentCount:  record.records.filter((recordItem) => recordItem.status === ATTENDANCE_STATUS.ABSENT).length,
    leaveCount:   record.records.filter((recordItem) => recordItem.status === ATTENDANCE_STATUS.LEAVE).length,
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

  // Calculate real-time submission window and closure status for UI
  const school = await School.findById(section.schoolId).lean();
  const todayPktDate = getKarachiDateString(new Date());
  const queryDatePkt = getKarachiDateString(queryDate);
  const isToday = queryDatePkt === todayPktDate;
  const isActorHmOrAdmin = [ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role);

  let windowCheck;
  if (!school) {
    windowCheck = { allowed: true };
  } else if (queryDatePkt < todayPktDate && requestingActor.role === ROLES.TEACHER) {
    windowCheck = {
      allowed: false,
      code: 'PAST_DATE_CLOSED',
      reason: 'Past-date attendance submission is strictly closed for teachers. Contact your Head Master for authorized clearance.',
    };
  } else if (queryDatePkt > todayPktDate) {
    windowCheck = {
      allowed: false,
      code: 'FUTURE_DATE_BLOCKED',
      reason: 'Future-date attendance submission is not permitted.',
    };
  } else {
    windowCheck = await validateSubmissionWindow({
      school,
      requestingActor,
      date: queryDate,
      currentTime: isToday ? new Date() : undefined,
    });
  }

  const closureCheck = school ? await checkIsSchoolClosed(school, queryDate) : { isClosed: false };
  const currentDayOfWeek = getKarachiDayOfWeek(queryDate);
  const isFriday = currentDayOfWeek === 5;
  const resolved = resolveSchoolSchedule(school, isFriday);
  const currentTimePkt = getKarachiTimeString(isToday ? new Date() : queryDate);
  const canOverride = isActorHmOrAdmin && isToday && resolved.allowHmLateOverride !== false;

  return sendSuccess(response, 200, "Attendance sheet retrieved.", {
    section: { _id: section._id, name: section.name, roomNumber: section.roomNumber || "", class: section.classId },
    date: queryDate.toISOString().split("T")[0],
    alreadySubmitted: !!existingRecord,
    verificationStatus: existingRecord?.verificationStatus || null,
    roster,
    windowStatus: {
      allowed: windowCheck.allowed,
      code: windowCheck.code || (windowCheck.allowed ? "WINDOW_OPEN" : "UNKNOWN"),
      reason: windowCheck.reason || "",
      isClosed: closureCheck.isClosed,
      closureType: closureCheck.type || null,
      closureReason: closureCheck.reason || null,
      currentTimePkt,
      currentDatePkt: queryDatePkt,
      isFriday,
      schedule: {
        startTime: resolved.startTime,
        endTime: resolved.endTime,
        attendanceWindowStart: resolved.windowStart,
        attendanceWindowEnd: resolved.windowEnd,
      },
      allowHmLateOverride: resolved.allowHmLateOverride,
      canOverride,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /attendance/window-status — Dedicated real-time window & closure query
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetAttendanceWindowStatus = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { schoolId, date } = request.query;

  let targetSchoolId = schoolId;
  if (!targetSchoolId && (requestingActor.role === ROLES.TEACHER || requestingActor.role === ROLES.HM)) {
    targetSchoolId = requestingActor.schoolId?._id || requestingActor.schoolId;
  }

  if (!targetSchoolId) {
    return sendError(response, 400, "A valid schoolId is required to determine attendance window status.");
  }

  const school = await School.findById(targetSchoolId).lean();
  if (!school) {
    return sendError(response, 404, "School not found in municipal registry.");
  }

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) return sendError(response, 400, "Invalid date format.");

  const todayPktDate = getKarachiDateString(new Date());
  const queryDatePkt = getKarachiDateString(queryDate);
  const isToday = queryDatePkt === todayPktDate;
  const isActorHmOrAdmin = [ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role);

  let windowCheck;
  if (queryDatePkt < todayPktDate && requestingActor.role === ROLES.TEACHER) {
    windowCheck = {
      allowed: false,
      code: 'PAST_DATE_CLOSED',
      reason: 'Past-date attendance submission is strictly closed for teachers. Contact your Head Master for authorized clearance.',
    };
  } else if (queryDatePkt > todayPktDate) {
    windowCheck = {
      allowed: false,
      code: 'FUTURE_DATE_BLOCKED',
      reason: 'Future-date attendance submission is not permitted.',
    };
  } else {
    windowCheck = await validateSubmissionWindow({
      school,
      requestingActor,
      date: queryDate,
      currentTime: isToday ? new Date() : undefined,
    });
  }

  const closureCheck = await checkIsSchoolClosed(school, queryDate);

  const currentDayOfWeek = getKarachiDayOfWeek(queryDate);
  const isFriday = currentDayOfWeek === 5;
  const resolved = resolveSchoolSchedule(school, isFriday);
  const currentTimePkt = getKarachiTimeString(isToday ? new Date() : queryDate);
  const canOverride = isActorHmOrAdmin && isToday && resolved.allowHmLateOverride !== false;

  return sendSuccess(response, 200, "Attendance window status retrieved.", {
    allowed: windowCheck.allowed,
    code: windowCheck.code || (windowCheck.allowed ? "WINDOW_OPEN" : "UNKNOWN"),
    reason: windowCheck.reason || "",
    isClosed: closureCheck.isClosed,
    closureType: closureCheck.type || null,
    closureReason: closureCheck.reason || null,
    currentTimePkt,
    currentDatePkt: queryDatePkt,
    isFriday,
    schedule: {
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      attendanceWindowStart: resolved.windowStart,
      attendanceWindowEnd: resolved.windowEnd,
    },
    allowHmLateOverride: resolved.allowHmLateOverride,
    canOverride,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /attendance/submit
//
// Teacher sends exceptions or records:
//   { sectionId, date, absentStudentProfileIds: [...], leaveStudentProfileIds: [...], isLateOverride, lateReason }
//
// Server derives:
//   Student not in absent or leave → PRESENT (automatically)
//   Student in absent → ABSENT
//   Student in leave  → LEAVE
//   Student in BOTH   → 400 Bad Request (A+L overlap)
// ═══════════════════════════════════════════════════════════════════════════════
export const handleSubmitAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    sectionId,
    date,
    absentStudentProfileIds = [],
    leaveStudentProfileIds  = [],
    records = [],
    isLateOverride = false,
    lateReason = '',
    // CL Proxy fields — HM only. When the assigned teacher is on Casual Leave,
    // the HM submits attendance on that teacher's behalf using these fields.
    proxyTeacherId = null,
    proxyReason    = '',
  } = request.body;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }

  // Graceful derivation if client sends 'records' array instead of direct arrays
  let effectiveAbsentIds = Array.isArray(absentStudentProfileIds) ? [...absentStudentProfileIds] : [];
  let effectiveLeaveIds  = Array.isArray(leaveStudentProfileIds)  ? [...leaveStudentProfileIds]  : [];

  if (effectiveAbsentIds.length === 0 && effectiveLeaveIds.length === 0 && Array.isArray(records) && records.length > 0) {
    effectiveAbsentIds = records
      .filter((submittedRecord) => submittedRecord.status === ATTENDANCE_STATUS.ABSENT || submittedRecord.currentStatus === ATTENDANCE_STATUS.ABSENT)
      .map((submittedRecord) => submittedRecord.studentProfileId || submittedRecord.userId);
    effectiveLeaveIds = records
      .filter((submittedRecord) => submittedRecord.status === ATTENDANCE_STATUS.LEAVE || submittedRecord.currentStatus === ATTENDANCE_STATUS.LEAVE)
      .map((submittedRecord) => submittedRecord.studentProfileId || submittedRecord.userId);
  }

  // Validate format and reject duplicates within absent exceptions
  const seenAbsentIds = new Set();
  for (const absentCandidateId of effectiveAbsentIds) {
    const absentIdString = String(absentCandidateId);
    if (!/^[0-9a-fA-F]{24}$/.test(absentIdString)) {
      return sendError(response, 400, `Invalid studentProfileId format: ${absentCandidateId}`);
    }
    if (seenAbsentIds.has(absentIdString)) {
      return sendError(response, 400, `Duplicate studentProfileId detected in attendance payload: ${absentIdString}`);
    }
    seenAbsentIds.add(absentIdString);
  }

  // Validate format and reject duplicates within leave exceptions
  const seenLeaveIds = new Set();
  for (const leaveCandidateId of effectiveLeaveIds) {
    const leaveIdString = String(leaveCandidateId);
    if (!/^[0-9a-fA-F]{24}$/.test(leaveIdString)) {
      return sendError(response, 400, `Invalid studentProfileId format: ${leaveCandidateId}`);
    }
    if (seenLeaveIds.has(leaveIdString)) {
      return sendError(response, 400, `Duplicate studentProfileId detected in attendance payload: ${leaveIdString}`);
    }
    seenLeaveIds.add(leaveIdString);
  }

  // A + L overlap check — same student cannot be both Absent AND Leave
  const conflictingStudentIds = [...seenAbsentIds].filter((absentStudentId) => seenLeaveIds.has(absentStudentId));
  if (conflictingStudentIds.length > 0) {
    return sendError(response, 400,
      `A student cannot be marked both Absent and Leave simultaneously. Conflicting IDs: ${conflictingStudentIds.join(", ")}`
    );
  }

  const absentSet = seenAbsentIds;
  const leaveSet  = seenLeaveIds;

  // Validate records array if provided (duplicate checks and status enum validation)
  if (Array.isArray(records) && records.length > 0) {
    const seenRecordIds = new Set();
    for (const submittedRecordItem of records) {
      const candidateProfileIdentifier = String(submittedRecordItem.studentProfileId || submittedRecordItem.userId || '');
      if (candidateProfileIdentifier) {
        if (!/^[0-9a-fA-F]{24}$/.test(candidateProfileIdentifier)) {
          return sendError(response, 400, `Invalid studentProfileId format in records: ${candidateProfileIdentifier}`);
        }
        if (seenRecordIds.has(candidateProfileIdentifier)) {
          return sendError(response, 400, `Duplicate studentProfileId detected in attendance records: ${candidateProfileIdentifier}`);
        }
        seenRecordIds.add(candidateProfileIdentifier);
      }
      if (submittedRecordItem.status && !Object.values(ATTENDANCE_STATUS).includes(submittedRecordItem.status)) {
        return sendError(response, 400, `Invalid attendance status: "${submittedRecordItem.status}". Allowed values: ${Object.values(ATTENDANCE_STATUS).join(', ')}`);
      }
    }
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) return sendError(response, 400, "Invalid date format.");

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (queryDate > todayEnd) return sendError(response, 400, "Attendance cannot be submitted for a future date.");

  const todayPktDate = getKarachiDateString(new Date());
  const queryDatePkt = getKarachiDateString(queryDate);

  if (queryDatePkt > todayPktDate) {
    return sendError(response, 400, "Attendance cannot be submitted for a future date.");
  }

  if (queryDatePkt < todayPktDate && requestingActor.role === ROLES.TEACHER) {
    return sendError(
      response,
      403,
      "Past-date attendance submission is strictly closed for teachers. Contact your Head Master for authorized clearance."
    );
  }

  const school = await School.findById(section.schoolId).lean();
  if (!school) {
    return sendError(response, 404, "Section school entity not found in municipal registry.");
  }

  // ── 3-Stage Gate: Holiday Check -> Weekly Off Check -> PKT Dynamic Window Check
  const windowCheck = await validateSubmissionWindow({
    school,
    requestingActor,
    date: queryDate,
    currentTime: queryDatePkt === todayPktDate ? new Date() : undefined,
    isLateOverride: Boolean(isLateOverride),
    lateReason: typeof lateReason === 'string' ? lateReason : '',
  });

  if (!windowCheck.allowed) {
    return sendError(response, 403, windowCheck.reason);
  }

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

  const authorizedProfileIds = new Set(authorizedStudents.map((studentProfile) => String(studentProfile._id)));
  const userToProfileId      = new Map(authorizedStudents.map((studentProfile) => [
    String(studentProfile.userId?._id || studentProfile.userId || ''),
    String(studentProfile._id),
  ]));
  const profileToUserId      = Object.fromEntries(authorizedStudents.map((studentProfile) => [
    String(studentProfile._id),
    studentProfile.userId?._id || studentProfile.userId || studentProfile._id,
  ]));

  // Verify submitted IDs are in the authoritative roster — reject injected IDs
  const normalizedAbsentSet = new Set();
  for (const absentTargetId of absentSet) {
    if (authorizedProfileIds.has(absentTargetId)) {
      normalizedAbsentSet.add(absentTargetId);
    } else if (userToProfileId.has(absentTargetId)) {
      normalizedAbsentSet.add(userToProfileId.get(absentTargetId));
    } else {
      return sendError(response, 400,
        `Student profile ${absentTargetId} does not belong to the authorized roster for this section. ` +
        "Cross-section or external student IDs are rejected."
      );
    }
  }

  const normalizedLeaveSet = new Set();
  for (const leaveTargetId of leaveSet) {
    if (authorizedProfileIds.has(leaveTargetId)) {
      normalizedLeaveSet.add(leaveTargetId);
    } else if (userToProfileId.has(leaveTargetId)) {
      normalizedLeaveSet.add(userToProfileId.get(leaveTargetId));
    } else {
      return sendError(response, 400,
        `Student profile ${leaveTargetId} does not belong to the authorized roster for this section. ` +
        "Cross-section or external student IDs are rejected."
      );
    }
  }

  if (Array.isArray(records) && records.length > 0) {
    for (const submittedRecordItem of records) {
      const candidateProfileIdentifier = String(submittedRecordItem.studentProfileId || submittedRecordItem.userId || '');
      if (candidateProfileIdentifier && !authorizedProfileIds.has(candidateProfileIdentifier) && !userToProfileId.has(candidateProfileIdentifier)) {
        return sendError(response, 400,
          `Student profile ${candidateProfileIdentifier} does not belong to the authorized roster for this section. ` +
          "Cross-section or external student IDs are rejected."
        );
      }
    }
  }

  const remarksMap = new Map();
  if (Array.isArray(records)) {
    for (const submittedRecordForRemarks of records) {
      const studentIdentifierKey = String(submittedRecordForRemarks.studentProfileId || submittedRecordForRemarks.userId || '');
      if (studentIdentifierKey && submittedRecordForRemarks.remarks) {
        remarksMap.set(studentIdentifierKey, String(submittedRecordForRemarks.remarks).trim());
      }
    }
  }

  // Server derives final P/A/L for EVERY enrolled student
  // Teacher sends only exceptions; this guarantees complete, correct records
  const sanitizedRecords = authorizedStudents.map((enrolledStudentProfile) => {
    const studentProfileIdString = String(enrolledStudentProfile._id);
    const studentUserIdString = String(enrolledStudentProfile.userId?._id || profileToUserId[studentProfileIdString]);
    let status = ATTENDANCE_STATUS.PRESENT; // default
    if (normalizedAbsentSet.has(studentProfileIdString))      status = ATTENDANCE_STATUS.ABSENT;
    else if (normalizedLeaveSet.has(studentProfileIdString))  status = ATTENDANCE_STATUS.LEAVE;
    const studentRemark = remarksMap.get(studentProfileIdString) || remarksMap.get(studentUserIdString) || "";
    return {
      userId:  profileToUserId[studentProfileIdString],
      status,
      remarks: studentRemark,
    };
  });

  const teacherSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || "");
  const teacherId       = requestingActor._id || requestingActor.userId;

  // ── CL Proxy Validation (HM only) ────────────────────────────────────────────
  // When an HM submits attendance for a section whose teacher is on Casual Leave,
  // they MUST supply proxyTeacherId (the teacher being proxied) and proxyReason.
  // We verify the teacher belongs to the same school — no cross-school proxy allowed.
  let proxyTeacherRecord = null;
  const isHmClProxy = requestingActor.role === ROLES.HM && proxyTeacherId && typeof proxyTeacherId === 'string';

  if (isHmClProxy) {
    if (!/^[0-9a-fA-F]{24}$/.test(proxyTeacherId)) {
      return sendError(response, 400, 'Invalid proxyTeacherId format. Must be a valid MongoDB ObjectId.');
    }
    if (!proxyReason || typeof proxyReason !== 'string' || proxyReason.trim().length < 5) {
      return sendError(response, 400, 'proxyReason is required when submitting attendance as CL proxy (minimum 5 characters).');
    }
    // Verify the proxied teacher belongs to this school and holds TEACHER role
    proxyTeacherRecord = await User.findOne({
      _id:      proxyTeacherId,
      schoolId: teacherSchoolId,
      role:     ROLES.TEACHER,
    }).select('fullName designation').lean();

    if (!proxyTeacherRecord) {
      return sendError(
        response,
        403,
        `CL Proxy denied: Teacher ${proxyTeacherId} does not belong to your school or does not hold a TEACHER role. ` +
        'You can only proxy for teachers within your own school.'
      );
    }
  }

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

  const presentCount = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount  = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount   = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.LEAVE).length;

  // ── Determine audit action and reason based on submission context ────────────
  let auditAction;
  let auditReason;

  if (isHmClProxy && proxyTeacherRecord) {
    auditAction = "ATTENDANCE_HM_CL_PROXY_SUBMITTED";
    auditReason =
      `HM submitted student attendance on behalf of teacher ` +
      `'${proxyTeacherRecord.fullName}' (${proxyTeacherId}) who is on Casual Leave. ` +
      `Proxy reason: ${proxyReason.trim()}`;
  } else if (windowCheck.isLateOverride) {
    auditAction = "ATTENDANCE_LATE_OVERRIDE_SUBMITTED";
    auditReason = `HM Emergency Late Clearance: ${windowCheck.lateReason}`;
  } else {
    auditAction = "ATTENDANCE_SUBMITTED";
    auditReason = "Teacher submitted daily attendance (A/L exceptions; P server-derived from enrollment).";
  }

  await AuditLog.create({
    actorId:          teacherId,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || "",
    actorName:        requestingActor.fullName || "",
    action:           auditAction,
    targetModel:      "Attendance",
    targetId:         attendanceRecord._id,
    targetName:       `${section.classId?.name || "Class"} — ${section.name}`,
    schoolId:         teacherSchoolId,
    previousState:    null,
    newState: {
      sectionId:       String(section._id),
      date:            dayStart.toISOString().split("T")[0],
      totalRecords:    sanitizedRecords.length,
      presentCount,
      absentCount,
      leaveCount,
      isLateOverride:  Boolean(windowCheck.isLateOverride),
      lateReason:      windowCheck.lateReason || null,
      // CL Proxy fields — present only when HM is acting on behalf of a CL teacher
      isClProxy:       isHmClProxy,
      proxyTeacherId:  isHmClProxy ? proxyTeacherId : null,
      proxyTeacherName: isHmClProxy ? (proxyTeacherRecord?.fullName || null) : null,
      proxyReason:     isHmClProxy ? proxyReason.trim() : null,
    },
    result:    "SUCCESS",
    reason:    auditReason,
    ipAddress: request.ip || "",
    userAgent: request.headers?.["user-agent"] || "",
    requestId: request.headers?.["x-request-id"] || "",
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
    // Included when HM submits on behalf of a CL teacher
    proxyContext: isHmClProxy
      ? {
          isClProxy:        true,
          proxyTeacherId,
          proxyTeacherName: proxyTeacherRecord?.fullName || null,
          proxyReason:      proxyReason.trim(),
        }
      : null,
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

  const school = await School.findById(section.schoolId).lean();
  const daysInMonth = new Date(parsedYear, parsedMonth, 0).getDate();
  const monthStartStr = `${parsedYear}-${String(parsedMonth).padStart(2, "0")}-01`;
  const monthEndStr = `${parsedYear}-${String(parsedMonth).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const todayPktDate = getKarachiDateString(new Date());

  const rangeStart = new Date(parsedYear, parsedMonth - 1, 1, 0, 0, 0, 0);
  const rangeEnd   = new Date(parsedYear, parsedMonth, 0, 23, 59, 59, 999);

  const [attendanceRecords, studentProfiles, activeHolidays, activeWeeklyOffs] = await Promise.all([
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
    HolidayCalendar.find({
      status: "ACTIVE",
      startDate: { $lte: monthEndStr },
      endDate: { $gte: monthStartStr },
      $or: [
        { scopeType: "SCHOOL", schoolId: section.schoolId },
        { scopeType: "TOWN", townId: school?.townId },
      ],
    }).sort({ scopeType: 1 }).lean(), // SCHOOL scope ('S') matches before TOWN ('T')
    WeeklyOffPattern.find({
      status: "ACTIVE",
      effectiveFrom: { $lte: rangeEnd },
      $and: [
        {
          $or: [
            { effectiveTo: null },
            { effectiveTo: { $gte: rangeStart } },
          ],
        },
        {
          $or: [
            { scopeType: "SCHOOL", schoolId: section.schoolId },
            { scopeType: "TOWN", townId: school?.townId },
          ],
        },
      ],
    }).sort({ scopeType: 1 }).lean(), // SCHOOL scope ('S') matches before TOWN ('T')
  ]);

  // Build { dateString → { userId → status } } & document lookup
  const dateAttendanceDocMap = {};
  const dateStatusMap = {};
  const workingDays   = [];

  for (const rec of attendanceRecords) {
    const dateStr = getKarachiDateString(new Date(rec.date));
    workingDays.push(dateStr);
    dateAttendanceDocMap[dateStr] = rec;
    dateStatusMap[dateStr] = {};
    for (const entry of rec.records) {
      dateStatusMap[dateStr][String(entry.userId)] = entry.status;
    }
  }

  // Construct official month calendar metadata for all 1..daysInMonth days
  const calendarDays = [];
  let totalWorkingDaysInMonth = 0;
  let recordedWorkingDaysCount = 0;
  let missedWorkingDaysCount = 0;
  let totalSundaysCount = 0;
  let totalHolidaysCount = 0;

  const dayNamesShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayNamesFull = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const dateStr = `${parsedYear}-${String(parsedMonth).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    const dayDate = new Date(`${dateStr}T12:00:00.000Z`);
    const dayOfWeek = getKarachiDayOfWeek(dayDate);

    const isToday = dateStr === todayPktDate;
    const isFutureDate = dateStr > todayPktDate;
    const isPastDate = dateStr < todayPktDate;

    // Check holiday match
    const matchingHoliday = activeHolidays.find((holiday) => holiday.startDate <= dateStr && holiday.endDate >= dateStr);

    // Check weekly off match (SCHOOL scope matches before TOWN because activeWeeklyOffs was sorted with scopeType: 1)
    const matchingWeeklyOff = activeWeeklyOffs.find((weeklyOff) => {
      const effectiveFromStr = getKarachiDateString(weeklyOff.effectiveFrom);
      const effectiveToStr = weeklyOff.effectiveTo ? getKarachiDateString(weeklyOff.effectiveTo) : null;
      if (effectiveFromStr > dateStr) return false;
      if (effectiveToStr && effectiveToStr < dateStr) return false;
      return true;
    });

    const isSunday = dayOfWeek === 0;
    const isSaturday = dayOfWeek === 6;

    let isConfiguredWeeklyOff = false;
    let matchingWeeklyOffForDay = null;

    if (matchingWeeklyOff) {
      if (Array.isArray(matchingWeeklyOff.offDays) && matchingWeeklyOff.offDays.includes(dayOfWeek)) {
        isConfiguredWeeklyOff = true;
        matchingWeeklyOffForDay = matchingWeeklyOff;
      }
    } else {
      // Statutory Sindh Government fallback (5-day week): Saturday (6) and Sunday (0) are official off days
      if (isSunday || isSaturday) {
        isConfiguredWeeklyOff = true;
      }
    }

    let dayType = "WORKING_DAY";
    let isClosed = false;
    let isWeeklyOff = false;
    let overlapNote = null;
    let closureLabel = "";
    let closureReason = "";
    let status = "PENDING";

    if (matchingHoliday) {
      dayType = "HOLIDAY";
      isClosed = true;
      closureLabel = matchingHoliday.title || matchingHoliday.reason || "Public Holiday";
      closureReason = matchingHoliday.reason || matchingHoliday.title || "Official Public Holiday";
      status = "HOLIDAY";
      totalHolidaysCount++;
      if (isConfiguredWeeklyOff) {
        isWeeklyOff = true;
        overlapNote = `Gazetted holiday falls on ${dayNamesFull[dayOfWeek]} weekly off`;
      }
    } else if (isConfiguredWeeklyOff) {
      dayType = "WEEKLY_OFF";
      isClosed = true;
      isWeeklyOff = true;
      closureLabel = dayNamesFull[dayOfWeek];
      closureReason = matchingWeeklyOffForDay?.reason || `Official Weekly Off Day: ${dayNamesFull[dayOfWeek]} (Statutory Sindh Weekend)`;
      status = "WEEKLY_OFF";
      if (isSunday) totalSundaysCount++;
    } else {
      totalWorkingDaysInMonth++;
      const hasAttendance = Boolean(dateAttendanceDocMap[dateStr]);

      if (hasAttendance) {
        status = "ATTENDANCE_TAKEN";
        recordedWorkingDaysCount++;
      } else if (isFutureDate) {
        status = "FUTURE_DATE";
      } else if (isToday) {
        status = "TODAY_PENDING";
      } else {
        status = "NOT_TAKEN";
        closureLabel = "Attendance Not Taken";
        closureReason = "School working day with no attendance recorded during permitted window";
        missedWorkingDaysCount++;
      }
    }

    const hasAttendance = Boolean(dateAttendanceDocMap[dateStr]);

    calendarDays.push({
      date: dateStr,
      dayNumber: dayNum,
      dayOfWeek,
      dayName: dayNamesShort[dayOfWeek],
      dayNameFull: dayNamesFull[dayOfWeek],
      dayType,
      isClosed,
      isWeeklyOff,
      overlapNote,
      closureLabel,
      closureReason,
      isAttendanceTaken: hasAttendance,
      hasRecordedAttendance: hasAttendance,
      isPastDate,
      isToday,
      isFutureDate,
      status,
      verificationStatus: dateAttendanceDocMap[dateStr]?.verificationStatus || null,
      submittedAt: dateAttendanceDocMap[dateStr]?.updatedAt || null,
    });
  }

  // Construct authoritative student list with daily statuses
  const students = studentProfiles.map((profile, index) => {
    const uidStr     = String(profile.userId?._id || profile.userId);
    const attendance = {};
    const dailyStatus = {};
    const totals     = { P: 0, A: 0, L: 0 };

    for (const calDay of calendarDays) {
      const dateStr = calDay.date;
      const statusValue = dateStatusMap[dateStr]?.[uidStr] || null;
      attendance[dateStr] = statusValue;

      if (statusValue === ATTENDANCE_STATUS.PRESENT)     totals.P++;
      else if (statusValue === ATTENDANCE_STATUS.ABSENT) totals.A++;
      else if (statusValue === ATTENDANCE_STATUS.LEAVE)  totals.L++;

      dailyStatus[dateStr] = {
        status: statusValue,
        dayType: calDay.dayType,
        dayStatus: calDay.status,
        label: statusValue
          ? (statusValue === "PRESENT" ? "P" : statusValue === "ABSENT" ? "A" : "L")
          : (calDay.isClosed ? calDay.closureLabel : (calDay.status === "NOT_TAKEN" ? "Not Taken" : "—")),
      };
    }

    const recordedDaysForStudent = recordedWorkingDaysCount;
    const attendancePercentage = recordedDaysForStudent > 0
      ? ((totals.P / recordedDaysForStudent) * 100).toFixed(1) + "%"
      : "N/A";

    return {
      srNo:             String(index + 1).padStart(2, "0"),
      userId:           profile.userId?._id || profile.userId,
      fullName:         profile.userId?.fullName || "Student",
      grNumber:         profile.grNumber,
      rollNumber:       profile.rollNumber || index + 1,
      globalStudentId:  profile.globalStudentId || `GR-${profile.grNumber}`,
      gender:           profile.gender || "UNSPECIFIED",
      attendance,
      dailyStatus,
      totals,
      workingDaysRecorded: recordedDaysForStudent,
      attendancePercentage,
    };
  });

  // Class aggregate: Total Present / (Total Students × Recorded Working Days) × 100
  const totalPresent      = students.reduce((sum, s) => sum + s.totals.P, 0);
  const classAggregatePct = students.length > 0 && recordedWorkingDaysCount > 0
    ? ((totalPresent / (students.length * recordedWorkingDaysCount)) * 100).toFixed(1) + "%"
    : "N/A";

  return sendSuccess(response, 200, "Monthly attendance register retrieved.", {
    section: {
      _id: section._id,
      name: section.name,
      class: section.classId,
      schoolId: section.schoolId,
    },
    school: school ? {
      _id: school._id,
      name: school.name,
      schoolCode: school.schoolCode,
      emisCode: school.emisCode,
      timings: school.timings,
    } : null,
    month:               parsedMonth,
    year:                parsedYear,
    daysInMonth,
    calendarDays,
    workingDays,
    totalCalendarDays:   daysInMonth,
    totalWorkingDays:    totalWorkingDaysInMonth,
    recordedWorkingDays: recordedWorkingDaysCount,
    missedWorkingDays:   missedWorkingDaysCount,
    totalSundays:        totalSundaysCount,
    totalHolidays:       totalHolidaysCount,
    totalStudents:       students.length,
    classAggregatePct,
    students,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /attendance/clear-missed — HM / Admin Authorized Missed-Attendance Clearance
//
// Narrowly authorized exception workflow allowing HM or central Administrator
// to clear missed attendance ("Attendance Not Taken") for an unrecorded past
// working day with a mandatory recorded reason (>= 10 chars) and audit logging.
// ═══════════════════════════════════════════════════════════════════════════════
export const handleClearMissedAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    sectionId,
    date,
    absentStudentProfileIds = [],
    leaveStudentProfileIds  = [],
    records = [],
    reason = "",
  } = request.body;

  // Strict role check: Teacher role is strictly blocked
  const isAuthorizedRole = [ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role);
  if (!isAuthorizedRole) {
    return sendError(response, 403, "Access denied. Only Head Masters and authorized Administrators can clear missed attendance.");
  }

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }

  if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
    return sendError(
      response,
      400,
      "A mandatory justification reason (minimum 10 characters) is required to clear missed attendance."
    );
  }

  const section = await resolveTeacherSection(requestingActor, sectionId, response);
  if (!section) return;

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) return sendError(response, 400, "Invalid date format.");

  const todayPktDate = getKarachiDateString(new Date());
  const queryDatePkt = getKarachiDateString(queryDate);

  if (queryDatePkt >= todayPktDate) {
    return sendError(
      response,
      400,
      "Missed-attendance clearance is strictly for past working days. For today, use the standard attendance submission workflow."
    );
  }

  const school = await School.findById(section.schoolId).lean();
  if (!school) {
    return sendError(response, 404, "School entity not found in municipal registry.");
  }

  // Verify that the school was not officially closed on this date
  const closureStatus = await checkIsSchoolClosed(school, queryDate);
  if (closureStatus.isClosed) {
    return sendError(
      response,
      400,
      `Cannot clear attendance for an official non-working day or holiday: ${closureStatus.reason}`
    );
  }

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd   = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  // Check if attendance already exists — missed clearance cannot overwrite existing records
  const existingRecord = await Attendance.findOne({
    schoolId: section.schoolId,
    sectionId: section._id,
    attendanceType: "STUDENT",
    date: { $gte: dayStart, $lte: dayEnd },
  }).lean();

  if (existingRecord) {
    return sendError(
      response,
      409,
      "Attendance for this date has already been recorded. Missed-attendance clearance cannot overwrite existing records. Use official attendance correction."
    );
  }

  // Format and validate exception lists
  let effectiveAbsentIds = Array.isArray(absentStudentProfileIds) ? [...absentStudentProfileIds] : [];
  let effectiveLeaveIds  = Array.isArray(leaveStudentProfileIds)  ? [...leaveStudentProfileIds]  : [];

  if (effectiveAbsentIds.length === 0 && effectiveLeaveIds.length === 0 && Array.isArray(records) && records.length > 0) {
    effectiveAbsentIds = records
      .filter((rec) => rec.status === ATTENDANCE_STATUS.ABSENT || rec.currentStatus === ATTENDANCE_STATUS.ABSENT)
      .map((rec) => rec.studentProfileId || rec.userId);
    effectiveLeaveIds = records
      .filter((rec) => rec.status === ATTENDANCE_STATUS.LEAVE || rec.currentStatus === ATTENDANCE_STATUS.LEAVE)
      .map((rec) => rec.studentProfileId || rec.userId);
  }

  // Load authoritative roster — cross-section injection rejected
  const authorizedStudents = await StudentProfile.find({
    sectionId: section._id,
    schoolId:  section.schoolId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  })
    .populate("userId", "fullName _id")
    .lean();

  const authorizedProfileIds = new Set(authorizedStudents.map((sp) => String(sp._id)));
  const userToProfileId = new Map(authorizedStudents.map((sp) => [
    String(sp.userId?._id || sp.userId || ""),
    String(sp._id),
  ]));
  const profileToUserId = Object.fromEntries(authorizedStudents.map((sp) => [
    String(sp._id),
    sp.userId?._id || sp.userId || sp._id,
  ]));

  const normalizedAbsentSet = new Set();
  for (const id of effectiveAbsentIds) {
    const sId = String(id);
    if (authorizedProfileIds.has(sId)) normalizedAbsentSet.add(sId);
    else if (userToProfileId.has(sId)) normalizedAbsentSet.add(userToProfileId.get(sId));
    else return sendError(response, 400, `Student profile ${sId} does not belong to this section.`);
  }

  const normalizedLeaveSet = new Set();
  for (const id of effectiveLeaveIds) {
    const sId = String(id);
    if (authorizedProfileIds.has(sId)) normalizedLeaveSet.add(sId);
    else if (userToProfileId.has(sId)) normalizedLeaveSet.add(userToProfileId.get(sId));
    else return sendError(response, 400, `Student profile ${sId} does not belong to this section.`);
  }

  // Check overlap
  for (const absentId of normalizedAbsentSet) {
    if (normalizedLeaveSet.has(absentId)) {
      return sendError(response, 400, "A student cannot be marked both Absent and Leave simultaneously.");
    }
  }

  const remarksMap = new Map();
  if (Array.isArray(records)) {
    for (const r of records) {
      const k = String(r.studentProfileId || r.userId || "");
      if (k && r.remarks) remarksMap.set(k, String(r.remarks).trim());
    }
  }

  const sanitizedRecords = authorizedStudents.map((studentProfile) => {
    const pId = String(studentProfile._id);
    const uId = String(studentProfile.userId?._id || profileToUserId[pId]);
    let status = ATTENDANCE_STATUS.PRESENT;
    if (normalizedAbsentSet.has(pId))      status = ATTENDANCE_STATUS.ABSENT;
    else if (normalizedLeaveSet.has(pId))  status = ATTENDANCE_STATUS.LEAVE;
    const studentRemark = remarksMap.get(pId) || remarksMap.get(uId) || "";
    return {
      userId:  profileToUserId[pId],
      status,
      remarks: studentRemark,
    };
  });

  const actorId = requestingActor._id || requestingActor.userId;
  const schoolId = String(section.schoolId);
  const newHash = computeRecordsHash(sanitizedRecords);

  const attendanceRecord = await Attendance.create({
    schoolId,
    sectionId: section._id,
    attendanceType: "STUDENT",
    date: dayStart,
    records: sanitizedRecords,
    entryMode: "MANUAL_PORTAL",
    recordedBy: actorId,
    verifiedBy: actorId,
    verificationStatus: "VERIFIED",
    contentHash: newHash,
    lastRollupAt: new Date(),
  });

  await processAttendanceDelta({
    schoolId,
    sectionId: section._id,
    classId: section.classId?._id || section.classId,
    date: dayStart,
    previousRecords: [],
    newRecords: sanitizedRecords,
  });

  const presentCount = sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount  = sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount   = sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.LEAVE).length;

  await AuditLog.create({
    actorId,
    actorRole:        requestingActor.role,
    actorDesignation: requestingActor.designation || "",
    actorName:        requestingActor.fullName || "",
    action:           "ATTENDANCE_MISSED_DAY_CLEARED",
    targetModel:      "Attendance",
    targetId:         attendanceRecord._id,
    targetName:       `${section.classId?.name || "Class"} — ${section.name}`,
    schoolId,
    previousState:    null,
    newState: {
      sectionId:         String(section._id),
      date:              dayStart.toISOString().split("T")[0],
      totalRecords:      sanitizedRecords.length,
      presentCount,
      absentCount,
      leaveCount,
      isMissedClearance: true,
      reason:            reason.trim(),
    },
    result:    "SUCCESS",
    reason:    `HM cleared missed attendance for past date (${queryDatePkt}): ${reason.trim()}`,
    ipAddress: request.ip || "",
    userAgent: request.headers?.["user-agent"] || "",
    requestId: request.headers?.["x-request-id"] || "",
  });

  return sendSuccess(response, 201, "Missed attendance cleared and verified successfully.", {
    attendanceId:       attendanceRecord._id,
    section:            { _id: section._id, name: section.name, class: section.classId },
    date:               dayStart.toISOString().split("T")[0],
    totalRecords:       sanitizedRecords.length,
    presentCount,
    absentCount,
    leaveCount,
    verificationStatus: "VERIFIED",
    submittedAt:        attendanceRecord.createdAt,
    clearedBy: {
      actorId,
      name:   requestingActor.fullName,
      role:   requestingActor.role,
      reason: reason.trim(),
    },
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
      const entry = rec.records.find((recordItem) => String(recordItem.userId) === uidStr);
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

/**
 * PATCH /api/v1/attendance/:id/verify
 * Allows Head Master (HM) or higher authority to verify a daily attendance record.
 * Status: PENDING_VERIFICATION -> VERIFIED.
 */
export const handleVerifyAttendance = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;
  const { remarks = '' } = request.body;

  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return sendError(response, 400, 'Invalid attendance ID format.');
  }

  const attendanceRecord = await Attendance.findById(id);
  if (!attendanceRecord) {
    return sendError(response, 404, 'Attendance record not found.');
  }

  // School boundary check
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== String(attendanceRecord.schoolId)) {
      return sendError(response, 403, 'Access denied. You can only verify attendance for your assigned school.');
    }
  }

  // Future date rejection
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (attendanceRecord.date && new Date(attendanceRecord.date) > todayEnd) {
    return sendError(response, 400, 'Attendance record cannot be verified for a future date.');
  }

  // Idempotency guard: already verified record cannot be re-verified
  if (attendanceRecord.verificationStatus === 'VERIFIED') {
    return sendError(response, 409, 'Attendance record is already verified.');
  }

  const previousState = {
    verificationStatus: attendanceRecord.verificationStatus,
    verifiedBy: attendanceRecord.verifiedBy,
  };

  attendanceRecord.verificationStatus = 'VERIFIED';
  attendanceRecord.verifiedBy = actor._id;
  await attendanceRecord.save();

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'ATTENDANCE_VERIFIED',
    targetModel: 'Attendance',
    targetId: attendanceRecord._id,
    schoolId: attendanceRecord.schoolId,
    previousState,
    newState: { verificationStatus: 'VERIFIED', verifiedBy: actor._id },
    result: 'SUCCESS',
    reason: remarks || `Attendance verified by ${actor.role}`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, 'Attendance record verified successfully.', { attendance: attendanceRecord });
});

/**
 * POST /api/v1/attendance/upload-sheet
 * Allows Head Master (HM) or authorized staff to upload/record a physical paper attendance register image.
 */
export const handleUploadAttendanceSheet = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { sectionId, date, sheetImageUrl } = request.body;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, 'A valid sectionId is required.');
  }
  if (!sheetImageUrl || typeof sheetImageUrl !== 'string') {
    return sendError(response, 400, 'A valid sheetImageUrl is required.');
  }

  const section = await Section.findById(sectionId).lean();
  if (!section) {
    return sendError(response, 404, 'Section not found.');
  }

  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (!actorSchoolId || actorSchoolId !== String(section.schoolId)) {
      return sendError(response, 403, 'Access denied. Section belongs to a different school.');
    }
  }

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) {
    return sendError(response, 400, 'Invalid date format.');
  }

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (queryDate > todayEnd) {
    return sendError(response, 400, 'Attendance sheet cannot be uploaded for a future date.');
  }

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  let record = await Attendance.findOne({
    schoolId: section.schoolId,
    sectionId: section._id,
    attendanceType: 'STUDENT',
    date: { $gte: dayStart, $lte: dayEnd },
  });

  if (record) {
    record.sheetImageUrl = sheetImageUrl.trim();
    record.entryMode = 'SHEET_IMAGE_UPLOAD';
    await record.save();
  } else {
    record = await Attendance.create({
      schoolId: section.schoolId,
      attendanceType: 'STUDENT',
      date: dayStart,
      classId: section.classId,
      sectionId: section._id,
      records: [],
      entryMode: 'SHEET_IMAGE_UPLOAD',
      sheetImageUrl: sheetImageUrl.trim(),
      recordedBy: actor._id,
      verificationStatus: 'PENDING_VERIFICATION',
    });
  }

  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation || '',
    actorName: actor.fullName,
    action: 'ATTENDANCE_SHEET_UPLOADED',
    targetModel: 'Attendance',
    targetId: record._id,
    schoolId: section.schoolId,
    newState: { entryMode: 'SHEET_IMAGE_UPLOAD', sheetImageUrl: record.sheetImageUrl },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
  });

  return sendSuccess(response, 200, 'Attendance sheet uploaded and recorded successfully.', { attendance: record });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /attendance/teachers/daily — Head Master authoritative daily teacher roster
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetTeacherDailyAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  let effectiveSchoolId = null;

  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId) {
      return sendError(response, 403, 'Your Head Master account is not assigned to any municipal school.');
    }
    if (request.query.schoolId && String(request.query.schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot view teacher attendance outside your authorized school.');
    }
    effectiveSchoolId = actorSchoolId;
  } else if (requestingActor.role === ROLES.SUPERVISOR) {
    const targetSchoolId = request.query.schoolId;
    if (!targetSchoolId) {
      return sendError(response, 400, 'schoolId query parameter is required for Supervisor oversight.');
    }
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map((assignedSchool) =>
      String(assignedSchool?._id || assignedSchool)
    );
    if (!assignedSchoolIds.includes(String(targetSchoolId))) {
      return sendError(response, 403, 'Access denied. This school is not within your assigned supervisor jurisdiction.');
    }
    effectiveSchoolId = String(targetSchoolId);
  } else if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(requestingActor.role)) {
    effectiveSchoolId = request.query.schoolId || String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!effectiveSchoolId) {
      return sendError(response, 400, 'schoolId query parameter is required for administrative query.');
    }
  } else {
    return sendError(response, 403, 'Access denied. You lack authority to view teacher daily attendance.');
  }

  const queryDate = request.query.date ? new Date(request.query.date) : new Date();
  if (isNaN(queryDate.getTime())) {
    return sendError(response, 400, 'Invalid date format.');
  }

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  // Authoritative teaching faculty for the school
  const teachers = await User.find({
    schoolId: effectiveSchoolId,
    role: ROLES.TEACHER,
    status: USER_STATUS.ACTIVE,
  })
    .select('fullName email phoneNumber designation createdAt')
    .sort({ fullName: 1 })
    .lean();

  const teacherIds = teachers.map((teacherItem) => teacherItem._id);

  const [teacherProfiles, existingAttendance] = await Promise.all([
    TeacherProfile.find({ userId: { $in: teacherIds } }).lean(),
    Attendance.findOne({
      schoolId: effectiveSchoolId,
      attendanceType: 'TEACHER',
      date: { $gte: dayStart, $lte: dayEnd },
      sectionId: null,
    }).lean(),
  ]);

  const profileMap = new Map(
    teacherProfiles.map((teacherProfile) => [String(teacherProfile.userId), teacherProfile])
  );

  const recordsMap = new Map();
  if (existingAttendance && Array.isArray(existingAttendance.records)) {
    for (const recordItem of existingAttendance.records) {
      recordsMap.set(String(recordItem.userId), recordItem);
    }
  }

  // TBD [Article I Compliance]: Formal departmental threshold/grace-period for automatic
  // LATE classification is pending government notification. Currently designated manually
  // by the Head Master based on the physical morning attendance register.
  const roster = teachers.map((teacherItem) => {
    const teacherIdString = String(teacherItem._id);
    const profile = profileMap.get(teacherIdString) || {};
    const existing = recordsMap.get(teacherIdString);

    return {
      userId: teacherItem._id,
      fullName: teacherItem.fullName,
      email: teacherItem.email,
      phoneNumber: teacherItem.phoneNumber || '',
      designation: teacherItem.designation || profile.designation || 'Teacher',
      employeeId: profile.employeeId || 'ID-PENDING',
      bpsScale: profile.bpsScale || profile.bps || 'BPS-14',
      qualification: profile.qualification || '',
      status: existing ? existing.status : ATTENDANCE_STATUS.PRESENT,
      remarks: existing ? existing.remarks || '' : '',
    };
  });

  const presentCount = roster.filter((rosterRecord) => rosterRecord.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount = roster.filter((rosterRecord) => rosterRecord.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount = roster.filter((rosterRecord) => rosterRecord.status === ATTENDANCE_STATUS.LEAVE).length;
  const lateCount = roster.filter((rosterRecord) => rosterRecord.status === ATTENDANCE_STATUS.LATE).length;

  return sendSuccess(response, 200, 'Teacher daily attendance roster retrieved successfully.', {
    schoolId: effectiveSchoolId,
    date: queryDate.toISOString().split('T')[0],
    alreadySubmitted: Boolean(existingAttendance),
    verificationStatus: existingAttendance?.verificationStatus || null,
    verifiedAt: existingAttendance?.updatedAt || null,
    summary: {
      totalFaculty: roster.length,
      presentCount,
      absentCount,
      leaveCount,
      lateCount,
    },
    roster,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /attendance/teachers/daily — Head Master saves & verifies daily teacher register
// ═══════════════════════════════════════════════════════════════════════════════
export const handleSaveTeacherDailyAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  let effectiveSchoolId = null;

  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId) {
      return sendError(response, 403, 'Your Head Master account is not assigned to any municipal school.');
    }
    if (request.body.schoolId && String(request.body.schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot record teacher attendance outside your authorized school.');
    }
    effectiveSchoolId = actorSchoolId;
  } else if (requestingActor.role === ROLES.SUPERVISOR) {
    const targetSchoolId = request.body.schoolId;
    if (!targetSchoolId) {
      return sendError(response, 400, 'schoolId is required in request body for Supervisor recording.');
    }
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map((assignedSchool) =>
      String(assignedSchool?._id || assignedSchool)
    );
    if (!assignedSchoolIds.includes(String(targetSchoolId))) {
      return sendError(response, 403, 'Access denied. This school is not within your assigned supervisor jurisdiction.');
    }
    effectiveSchoolId = String(targetSchoolId);
  } else if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(requestingActor.role)) {
    effectiveSchoolId = request.body.schoolId || String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!effectiveSchoolId) {
      return sendError(response, 400, 'schoolId is required for administrative recording.');
    }
  } else {
    return sendError(response, 403, 'Access denied. You lack authority to record teacher daily attendance.');
  }

  const { date, records } = request.body;

  if (!Array.isArray(records) || records.length === 0) {
    return sendError(response, 400, 'A non-empty records array is required.');
  }

  const queryDate = date ? new Date(date) : new Date();
  if (isNaN(queryDate.getTime())) {
    return sendError(response, 400, 'Invalid date format.');
  }

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (queryDate > todayEnd) {
    return sendError(response, 400, 'Teacher attendance cannot be recorded for a future date.');
  }

  const dayStart = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(queryDate.getFullYear(), queryDate.getMonth(), queryDate.getDate(), 23, 59, 59, 999);

  // Validate format and ensure no duplicate teacher IDs in submission
  const validStatuses = Object.values(ATTENDANCE_STATUS);
  const seenUserIds = new Set();
  const submittedTeacherIds = [];

  for (const recordItem of records) {
    const rawUserId = String(recordItem.userId || '');
    if (!/^[0-9a-fA-F]{24}$/.test(rawUserId)) {
      return sendError(response, 400, `Invalid teacher userId format: ${rawUserId}`);
    }
    if (seenUserIds.has(rawUserId)) {
      return sendError(response, 400, `Duplicate teacher entry detected in records payload: ${rawUserId}`);
    }
    if (!validStatuses.includes(recordItem.status)) {
      return sendError(response, 400, `Invalid attendance status "${recordItem.status}" for teacher ${rawUserId}.`);
    }
    seenUserIds.add(rawUserId);
    submittedTeacherIds.push(rawUserId);
  }

  // BOLA / Cross-School Verification Guard:
  // Every single submitted teacher MUST belong to effectiveSchoolId and hold TEACHER role
  const authorizedTeachers = await User.find({
    _id: { $in: submittedTeacherIds },
    schoolId: effectiveSchoolId,
    role: ROLES.TEACHER,
  })
    .select('_id fullName')
    .lean();

  const authorizedTeacherIdSet = new Set(authorizedTeachers.map((teacherItem) => String(teacherItem._id)));

  for (const submittedId of submittedTeacherIds) {
    if (!authorizedTeacherIdSet.has(submittedId)) {
      return sendError(
        response,
        403,
        `Integrity violation: Faculty member ${submittedId} does not belong to this school or is not an authorized teacher.`
      );
    }
  }

  // Sanitize records
  const sanitizedRecords = records.map((recordItem) => ({
    userId: recordItem.userId,
    status: recordItem.status,
    remarks: typeof recordItem.remarks === 'string' ? recordItem.remarks.trim() : '',
  }));

  const newHash = computeRecordsHash(sanitizedRecords);

  // Atomic upsert of the school's single daily teacher attendance document
  const attendanceRecord = await Attendance.findOneAndUpdate(
    {
      schoolId: effectiveSchoolId,
      attendanceType: 'TEACHER',
      date: { $gte: dayStart, $lte: dayEnd },
      sectionId: null,
    },
    {
      $set: {
        schoolId: effectiveSchoolId,
        attendanceType: 'TEACHER',
        date: dayStart,
        classId: null,
        sectionId: null,
        records: sanitizedRecords,
        entryMode: 'MANUAL_PORTAL',
        recordedBy: requestingActor._id,
        verifiedBy: requestingActor._id,
        verificationStatus: 'VERIFIED',
        contentHash: newHash,
        lastRollupAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const presentCount = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.LEAVE).length;
  const lateCount = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.LATE).length;

  // Immutable Audit Log
  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName,
    action: 'TEACHER_ATTENDANCE_RECORDED',
    targetModel: 'Attendance',
    targetId: attendanceRecord._id,
    schoolId: effectiveSchoolId,
    newState: {
      date: dayStart,
      totalFaculty: sanitizedRecords.length,
      presentCount,
      absentCount,
      leaveCount,
      lateCount,
      contentHash: newHash,
      verificationStatus: 'VERIFIED',
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });


  return sendSuccess(response, 200, 'Teacher daily attendance successfully recorded and verified.', {
    attendance: attendanceRecord,
    summary: {
      totalFaculty: sanitizedRecords.length,
      presentCount,
      absentCount,
      leaveCount,
      lateCount,
    },
  });
});

/**
 * GET /api/v1/attendance/teachers/my-attendance
 * Authenticated teacher views their own attendance history as marked by HM.
 * Supports query params: month (1-12), year (e.g. 2026).
 */
export const handleGetTeacherSelfAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const teacherId = String(requestingActor._id || requestingActor.userId);
  const teacherSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');

  if (!teacherSchoolId) {
    return sendError(response, 403, 'Your account is not assigned to a school. Contact your Head Master.');
  }

  const { month, year } = request.query;
  const currentNow = new Date();
  const queryYear = year ? parseInt(year, 10) : currentNow.getFullYear();
  const queryMonth = month ? parseInt(month, 10) - 1 : currentNow.getMonth();

  if (isNaN(queryYear) || isNaN(queryMonth) || queryMonth < 0 || queryMonth > 11) {
    return sendError(response, 400, 'Invalid month (1-12) or year parameter.');
  }

  const startDate = new Date(queryYear, queryMonth, 1, 0, 0, 0, 0);
  const endDate = new Date(queryYear, queryMonth + 1, 0, 23, 59, 59, 999);

  // Query teacher daily attendance documents for this school and date range
  const attendanceDocs = await Attendance.find({
    schoolId: teacherSchoolId,
    attendanceType: 'TEACHER',
    date: { $gte: startDate, $lte: endDate },
    'records.userId': teacherId,
  })
    .sort({ date: 1 })
    .lean();

  const history = [];
  let presentCount = 0;
  let absentCount = 0;
  let leaveCount = 0;
  let lateCount = 0;

  for (const doc of attendanceDocs) {
    const record = doc.records.find((rec) => String(rec.userId) === teacherId);
    if (!record) continue;

    const status = record.status;
    if (status === ATTENDANCE_STATUS.PRESENT) presentCount++;
    else if (status === ATTENDANCE_STATUS.ABSENT) absentCount++;
    else if (status === ATTENDANCE_STATUS.LEAVE) leaveCount++;
    else if (status === ATTENDANCE_STATUS.LATE) lateCount++;

    history.push({
      date: doc.date.toISOString().split('T')[0],
      status,
      remarks: record.remarks || '',
      verificationStatus: doc.verificationStatus,
    });
  }

  const totalMarkedDays = history.length;
  const effectivePresent = presentCount + lateCount;
  const attendancePercentage = totalMarkedDays > 0
    ? Number(((effectivePresent / totalMarkedDays) * 100).toFixed(1))
    : 0;

  return sendSuccess(response, 200, 'Teacher self-attendance history retrieved.', {
    period: { month: queryMonth + 1, year: queryYear },
    summary: {
      totalMarkedDays,
      presentCount,
      absentCount,
      leaveCount,
      lateCount,
      attendancePercentage,
    },
    history,
  });
});