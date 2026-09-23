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
import {
  ROLES,
  ATTENDANCE_STATUS,
  STUDENT_STATUS,
  USER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from "../../config/constants.js";
import { processAttendanceDelta, computeRecordsHash } from "../services/attendanceRollupService.js";
import { validateSubmissionWindow, checkIsSchoolClosed } from "../services/attendanceWindowService.js";
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
  const windowCheck = school
    ? await validateSubmissionWindow({
        school,
        requestingActor,
        date: queryDate,
      })
    : { allowed: true };

  const closureCheck = school ? await checkIsSchoolClosed(school, queryDate) : { isClosed: false };
  const currentDayOfWeek = getKarachiDayOfWeek(queryDate);
  const isFriday = currentDayOfWeek === 5;
  const schedule = isFriday ? school?.timings?.friday : school?.timings?.regular;
  const currentTimePkt = getKarachiTimeString(queryDate);
  const isActorHmOrAdmin = [ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role);
  const todayPktDate = getKarachiDateString(new Date());
  const queryDatePkt = getKarachiDateString(queryDate);
  const canOverride = isActorHmOrAdmin && queryDatePkt === todayPktDate && school?.timings?.allowHmLateOverride !== false;

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
        startTime: schedule?.startTime || (isFriday ? "07:30" : "08:00"),
        endTime: schedule?.endTime || (isFriday ? "12:00" : "13:30"),
        attendanceWindowStart: schedule?.attendanceWindowStart || (isFriday ? "07:15" : "07:45"),
        attendanceWindowEnd: schedule?.attendanceWindowEnd || (isFriday ? "12:30" : "14:00"),
      },
      allowHmLateOverride: school?.timings?.allowHmLateOverride ?? true,
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

  const windowCheck = await validateSubmissionWindow({
    school,
    requestingActor,
    date: queryDate,
  });

  const closureCheck = await checkIsSchoolClosed(school, queryDate);

  const currentDayOfWeek = getKarachiDayOfWeek(queryDate);
  const isFriday = currentDayOfWeek === 5;
  const schedule = isFriday ? school.timings?.friday : school.timings?.regular;
  const currentTimePkt = getKarachiTimeString(queryDate);

  const isActorHmOrAdmin = [ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(requestingActor.role);
  const todayPktDate = getKarachiDateString(new Date());
  const queryDatePkt = getKarachiDateString(queryDate);
  const canOverride = isActorHmOrAdmin && queryDatePkt === todayPktDate && school.timings?.allowHmLateOverride !== false;

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
      startTime: schedule?.startTime || (isFriday ? "07:30" : "08:00"),
      endTime: schedule?.endTime || (isFriday ? "12:00" : "13:30"),
      attendanceWindowStart: schedule?.attendanceWindowStart || (isFriday ? "07:15" : "07:45"),
      attendanceWindowEnd: schedule?.attendanceWindowEnd || (isFriday ? "12:30" : "14:00"),
    },
    allowHmLateOverride: school.timings?.allowHmLateOverride ?? true,
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
  for (const id of effectiveAbsentIds) {
    const idStr = String(id);
    if (!/^[0-9a-fA-F]{24}$/.test(idStr)) {
      return sendError(response, 400, `Invalid studentProfileId format: ${id}`);
    }
    if (seenAbsentIds.has(idStr)) {
      return sendError(response, 400, `Duplicate studentProfileId detected in attendance payload: ${idStr}`);
    }
    seenAbsentIds.add(idStr);
  }

  // Validate format and reject duplicates within leave exceptions
  const seenLeaveIds = new Set();
  for (const id of effectiveLeaveIds) {
    const idStr = String(id);
    if (!/^[0-9a-fA-F]{24}$/.test(idStr)) {
      return sendError(response, 400, `Invalid studentProfileId format: ${id}`);
    }
    if (seenLeaveIds.has(idStr)) {
      return sendError(response, 400, `Duplicate studentProfileId detected in attendance payload: ${idStr}`);
    }
    seenLeaveIds.add(idStr);
  }

  // A + L overlap check — same student cannot be both Absent AND Leave
  const overlaps = [...seenAbsentIds].filter((id) => seenLeaveIds.has(id));
  if (overlaps.length > 0) {
    return sendError(response, 400,
      `A student cannot be marked both Absent and Leave simultaneously. Conflicting IDs: ${overlaps.join(", ")}`
    );
  }

  const absentSet = seenAbsentIds;
  const leaveSet  = seenLeaveIds;

  // Validate records array if provided (duplicate checks and status enum validation)
  if (Array.isArray(records) && records.length > 0) {
    const seenRecordIds = new Set();
    for (const rec of records) {
      const pid = String(rec.studentProfileId || rec.userId || '');
      if (pid) {
        if (!/^[0-9a-fA-F]{24}$/.test(pid)) {
          return sendError(response, 400, `Invalid studentProfileId format in records: ${pid}`);
        }
        if (seenRecordIds.has(pid)) {
          return sendError(response, 400, `Duplicate studentProfileId detected in attendance records: ${pid}`);
        }
        seenRecordIds.add(pid);
      }
      if (rec.status && !Object.values(ATTENDANCE_STATUS).includes(rec.status)) {
        return sendError(response, 400, `Invalid attendance status: "${rec.status}". Allowed values: ${Object.values(ATTENDANCE_STATUS).join(', ')}`);
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

  const school = await School.findById(section.schoolId).lean();
  if (!school) {
    return sendError(response, 404, "Section school entity not found in municipal registry.");
  }

  // ── 3-Stage Gate: Holiday Check -> Weekly Off Check -> PKT Dynamic Window Check
  const windowCheck = await validateSubmissionWindow({
    school,
    requestingActor,
    date: queryDate,
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
  for (const id of absentSet) {
    if (authorizedProfileIds.has(id)) {
      normalizedAbsentSet.add(id);
    } else if (userToProfileId.has(id)) {
      normalizedAbsentSet.add(userToProfileId.get(id));
    } else {
      return sendError(response, 400,
        `Student profile ${id} does not belong to the authorized roster for this section. ` +
        "Cross-section or external student IDs are rejected."
      );
    }
  }

  const normalizedLeaveSet = new Set();
  for (const id of leaveSet) {
    if (authorizedProfileIds.has(id)) {
      normalizedLeaveSet.add(id);
    } else if (userToProfileId.has(id)) {
      normalizedLeaveSet.add(userToProfileId.get(id));
    } else {
      return sendError(response, 400,
        `Student profile ${id} does not belong to the authorized roster for this section. ` +
        "Cross-section or external student IDs are rejected."
      );
    }
  }

  if (Array.isArray(records) && records.length > 0) {
    for (const rec of records) {
      const pid = String(rec.studentProfileId || rec.userId || '');
      if (pid && !authorizedProfileIds.has(pid) && !userToProfileId.has(pid)) {
        return sendError(response, 400,
          `Student profile ${pid} does not belong to the authorized roster for this section. ` +
          "Cross-section or external student IDs are rejected."
        );
      }
    }
  }

  const remarksMap = new Map();
  if (Array.isArray(records)) {
    for (const rec of records) {
      const key = String(rec.studentProfileId || rec.userId || '');
      if (key && rec.remarks) {
        remarksMap.set(key, String(rec.remarks).trim());
      }
    }
  }

  // Server derives final P/A/L for EVERY enrolled student
  // Teacher sends only exceptions; this guarantees complete, correct records
  const sanitizedRecords = authorizedStudents.map((profile) => {
    const pid = String(profile._id);
    const uid = String(profile.userId?._id || profileToUserId[pid]);
    let status = ATTENDANCE_STATUS.PRESENT; // default
    if (normalizedAbsentSet.has(pid))      status = ATTENDANCE_STATUS.ABSENT;
    else if (normalizedLeaveSet.has(pid))  status = ATTENDANCE_STATUS.LEAVE;
    const studentRemark = remarksMap.get(pid) || remarksMap.get(uid) || "";
    return {
      userId:  profileToUserId[pid],
      status,
      remarks: studentRemark,
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

  const presentCount = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount  = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount   = sanitizedRecords.filter((sanitizedRecord) => sanitizedRecord.status === ATTENDANCE_STATUS.LEAVE).length;

  const auditAction = windowCheck.isLateOverride ? "ATTENDANCE_LATE_OVERRIDE_SUBMITTED" : "ATTENDANCE_SUBMITTED";
  const auditReason = windowCheck.isLateOverride
    ? `HM Emergency Late Clearance: ${windowCheck.lateReason}`
    : "Teacher submitted daily attendance (A/L exceptions; P server-derived from enrollment).";

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
      sectionId:    String(section._id),
      date:         dayStart.toISOString().split("T")[0],
      totalRecords: sanitizedRecords.length,
      presentCount,
      absentCount,
      leaveCount,
      isLateOverride: Boolean(windowCheck.isLateOverride),
      lateReason: windowCheck.lateReason || null,
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

  const presentCount = roster.filter((item) => item.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount = roster.filter((item) => item.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount = roster.filter((item) => item.status === ATTENDANCE_STATUS.LEAVE).length;
  const lateCount = roster.filter((item) => item.status === ATTENDANCE_STATUS.LATE).length;

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

  const presentCount = sanitizedRecords.filter((item) => item.status === ATTENDANCE_STATUS.PRESENT).length;
  const absentCount = sanitizedRecords.filter((item) => item.status === ATTENDANCE_STATUS.ABSENT).length;
  const leaveCount = sanitizedRecords.filter((item) => item.status === ATTENDANCE_STATUS.LEAVE).length;
  const lateCount = sanitizedRecords.filter((item) => item.status === ATTENDANCE_STATUS.LATE).length;

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