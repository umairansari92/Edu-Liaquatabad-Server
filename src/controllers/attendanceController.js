import asyncHandler from "express-async-handler";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import Attendance from "../models/Attendance.js";
import StudentProfile from "../models/StudentProfile.js";
import Section from "../models/Section.js";
import AuditLog from "../models/AuditLog.js";
import { ROLES, SCOPES, ATTENDANCE_STATUS, STUDENT_STATUS, USER_STATUS } from "../../config/constants.js";

// ─── Helper: Resolve and verify teacher's section access ─────────────────────
//
// SECURITY INVARIANTS ENFORCED HERE:
//   1. Account must be ACTIVE (not suspended/pending)
//   2. School boundary: section.schoolId must match actor's verified schoolId (JWT)
//   3. Assignment verification:
//      - TEACHER role: must be Section.classTeacherId (only provable assignment in current model)
//      - HM role and above: school boundary is sufficient (they manage the whole school)
//      - Scope claims from JWT are NOT used as the authorization decision — only role is.
//   4. MISSING CAPABILITY NOTE:
//      Subject-teacher assignment is NOT modelled in the current data schema.
//      A teacher who teaches a subject in a section but is NOT that section's classTeacherId
//      CANNOT be authorized to submit attendance for that section.
//      This is a documented MISSING DOMAIN CAPABILITY, not a silent omission.
//
const resolveTeacherSection = async (requestingActor, sectionId, response) => {
  // Enforce active account
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

  const actorSchoolId  = String(requestingActor.schoolId?._id || requestingActor.schoolId || "");
  const sectionSchoolId = String(section.schoolId);

  // School boundary — always enforced regardless of role
  if (!actorSchoolId || actorSchoolId !== sectionSchoolId) {
    sendError(response, 403, "Access denied. This section belongs to a different school than your verified posting.");
    return null;
  }

  // Role-based section authorization:
  // TEACHER must be the classTeacherId of this specific section.
  // This is NOT a scope check — it is a ROLE check.
  // Using scope as the guard would allow a TEACHER with elevated scope to bypass.
  const actorRole = requestingActor.role;
  if (actorRole === ROLES.TEACHER) {
    if (!section.classTeacherId) {
      sendError(response, 403,
        "Access denied. No class teacher is assigned to this section. " +
        "Subject-teacher attendance authorization requires a TeacherSectionAssignment model which is not yet implemented. " +
        "Contact your Head Master."
      );
      return null;
    }
    const assignedTeacherId = String(section.classTeacherId._id || section.classTeacherId);
    const actorId = String(requestingActor._id || requestingActor.userId);
    if (assignedTeacherId !== actorId) {
      sendError(response, 403,
        "Access denied. You are not the assigned class teacher for this section. " +
        "Note: Subject-teacher assignment is a planned domain capability not yet implemented in the current data model."
      );
      return null;
    }
  }
  // HM, ADMIN, SUPER_ADMIN, ROOT_ADMIN: school boundary above is sufficient.
  // PEON, STUDENT, PARENT: these roles should not reach this helper (blocked by permission middleware).

  return section;
};

// ═══════════════════════════════════════════════════════════
// GET ATTENDANCE STATUS
// ═══════════════════════════════════════════════════════════

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
    lateCount:    record.records.filter((r) => r.status === ATTENDANCE_STATUS.LATE).length,
    submittedAt:  record.updatedAt,
  });
});

// ═══════════════════════════════════════════════════════════
// GET ATTENDANCE SHEET (Roster for Marking)
// ═══════════════════════════════════════════════════════════

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
    StudentProfile.find({
      sectionId: section._id,
      schoolId: section.schoolId,
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

  const roster = studentProfiles.map((profile) => {
    const userId   = String(profile.userId?._id);
    const existing = attendanceMap[userId];
    return {
      studentProfileId: profile._id,
      userId: profile.userId?._id,
      fullName: profile.userId?.fullName || "Student",
      grNumber: profile.grNumber,
      globalStudentId: profile.globalStudentId || `GR-${profile.grNumber}`,
      gender: profile.gender || "UNSPECIFIED",
      currentStatus: existing?.status || ATTENDANCE_STATUS.PRESENT,
      remarks: existing?.remarks || "",
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

// ═══════════════════════════════════════════════════════════
// SUBMIT / UPDATE ATTENDANCE
// ═══════════════════════════════════════════════════════════

export const handleSubmitAttendance = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { sectionId, date, records } = request.body;

  if (!sectionId || !/^[0-9a-fA-F]{24}$/.test(sectionId)) {
    return sendError(response, 400, "A valid sectionId is required.");
  }
  if (!Array.isArray(records) || records.length === 0) {
    return sendError(response, 400, "Attendance records array is required and cannot be empty.");
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

  const authorizedStudents = await StudentProfile.find({
    sectionId: section._id,
    schoolId: section.schoolId,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  })
    .populate("userId", "fullName _id")
    .lean();

  const authorizedProfileIds = new Set(authorizedStudents.map((s) => String(s._id)));
  const profileToUserId = Object.fromEntries(authorizedStudents.map((s) => [String(s._id), s.userId?._id]));

  const validStatuses = Object.values(ATTENDANCE_STATUS);
  const sanitizedRecords = [];

  for (const rec of records) {
    if (!rec.studentProfileId || !/^[0-9a-fA-F]{24}$/.test(String(rec.studentProfileId))) {
      return sendError(response, 400, `Invalid studentProfileId: ${rec.studentProfileId}`);
    }
    if (!authorizedProfileIds.has(String(rec.studentProfileId))) {
      return sendError(response, 403, `Student ${rec.studentProfileId} does not belong to the authorized roster for this section.`);
    }
    if (!validStatuses.includes(rec.status)) {
      return sendError(response, 400, `Invalid attendance status "${rec.status}".`);
    }
    sanitizedRecords.push({
      userId: profileToUserId[String(rec.studentProfileId)],
      status: rec.status,
      remarks: rec.remarks ? String(rec.remarks).slice(0, 200) : "",
    });
  }

  const teacherSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || "");
  const teacherId = requestingActor._id || requestingActor.userId;

  const attendanceRecord = await Attendance.findOneAndUpdate(
    {
      schoolId: teacherSchoolId,
      sectionId: section._id,
      attendanceType: "STUDENT",
      date: { $gte: dayStart, $lte: dayEnd },
    },
    {
      $set: {
        schoolId: teacherSchoolId,
        sectionId: section._id,
        attendanceType: "STUDENT",
        date: dayStart,
        records: sanitizedRecords,
        entryMode: "MANUAL_PORTAL",
        recordedBy: teacherId,
        verificationStatus: "PENDING_VERIFICATION",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await AuditLog.create({
    actorId: teacherId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || "",
    actorName: requestingActor.fullName || "",
    action: "ATTENDANCE_SUBMITTED",
    targetModel: "Attendance",
    targetId: attendanceRecord._id,
    targetName: `${section.classId?.name || "Class"} — ${section.name}`,
    schoolId: teacherSchoolId,
    previousState: null,
    newState: {
      sectionId: String(section._id),
      date: dayStart.toISOString().split("T")[0],
      totalRecords: sanitizedRecords.length,
      presentCount: sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length,
      absentCount:  sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length,
    },
    result: "SUCCESS",
    reason: "Teacher submitted daily student attendance.",
    ipAddress: request.ip || "",
    userAgent: request.headers["user-agent"] || "",
    requestId: request.headers["x-request-id"] || "",
  });

  return sendSuccess(response, 200, "Attendance submitted successfully.", {
    attendanceId: attendanceRecord._id,
    section: { _id: section._id, name: section.name, class: section.classId },
    date: dayStart.toISOString().split("T")[0],
    totalRecords: sanitizedRecords.length,
    presentCount: sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length,
    absentCount:  sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.ABSENT).length,
    leaveCount:   sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.LEAVE).length,
    lateCount:    sanitizedRecords.filter((r) => r.status === ATTENDANCE_STATUS.LATE).length,
    verificationStatus: "PENDING_VERIFICATION",
    submittedAt: attendanceRecord.updatedAt,
  });
});