import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Timetable from '../models/Timetable.js';
import School from '../models/School.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import ParentStudentLink from '../models/ParentStudentLink.js';
import Section from '../models/Section.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import AuditLog from '../models/AuditLog.js';
import {
  ROLES,
  TIMETABLE_STATUS,
  PARENT_STUDENT_LINK_STATUS,
} from '../../config/constants.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import {
  calculateLivePeriod,
  validateTimetableConflicts,
  TimetableValidationError,
} from '../services/timetableConflictService.js';

/**
 * GET /api/v1/timetables/school/:schoolId
 * Fetches the active timetable for a specific school, complete with populated references
 * and deterministic real-time live period calculation.
 */
export const handleGetSchoolTimetable = asyncHandler(async (request, response) => {
  const { schoolId } = request.params;
  const { academicYear } = request.query;

  if (!mongoose.Types.ObjectId.isValid(schoolId)) {
    return sendError(response, 400, 'Invalid school ID format.');
  }

  const queryCriteria = {
    schoolId,
    status: TIMETABLE_STATUS.ACTIVE,
  };
  if (academicYear) {
    queryCriteria.academicYear = String(academicYear).trim();
  }

  const activeTimetable = await Timetable.findOne(queryCriteria)
    .populate('schedule.classId', 'name code numericGrade')
    .populate('schedule.sectionId', 'name medium roomNumber')
    .populate('schedule.subjectId', 'name code')
    .populate('schedule.teacherId', 'fullName email designation')
    .lean();

  if (!activeTimetable) {
    return sendError(response, 404, 'No active timetable found for this school.');
  }

  let schoolDetails = null;
  if (typeof School.findById === 'function') {
    const query = School.findById(schoolId).select('name schoolCode emisCode townId');
    schoolDetails = query && typeof query.lean === 'function' ? await query.lean() : await query;
  }

  let schoolFaculty = [];
  if (typeof User.find === 'function') {
    const query = User.find({
      schoolId,
      role: { $in: [ROLES.TEACHER, ROLES.HM] },
      status: 'ACTIVE',
    }).select('_id fullName designation');
    schoolFaculty = query && typeof query.lean === 'function' ? await query.lean() : await query;
  }
  if (!Array.isArray(schoolFaculty)) schoolFaculty = [];

  const teachingSlots = (activeTimetable.periodSlots || []).filter(
    (slot) => slot.slotType === 'TEACHING'
  );

  const teacherFreePeriods = {};
  const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  for (const day of DAYS) {
    teacherFreePeriods[day] = schoolFaculty.map((teacher) => {
      const assignedPeriods = new Set(
        activeTimetable.schedule
          .filter(
            (entry) =>
              entry.dayOfWeek === day &&
              String(entry.teacherId?._id || entry.teacherId) === String(teacher._id)
          )
          .map((entry) => entry.periodNumber)
      );

      const freeSlotNumbers = teachingSlots
        .filter((slot) => !assignedPeriods.has(slot.periodNumber))
        .map((slot) => slot.periodNumber)
        .sort((firstPeriodNumber, secondPeriodNumber) => firstPeriodNumber - secondPeriodNumber);

      return {
        teacherId: teacher._id,
        teacherName: teacher.fullName,
        designation: teacher.designation || 'Teacher',
        freePeriods: freeSlotNumbers,
        formatted: freeSlotNumbers.map((periodDigit) => String(periodDigit).padStart(2, '0')).join(', '),
        totalAssigned: assignedPeriods.size,
        totalFree: freeSlotNumbers.length,
      };
    });
  }

  const liveStatus = calculateLivePeriod(activeTimetable.periodSlots);

  return sendSuccess(response, 200, 'School timetable retrieved successfully.', {
    ...activeTimetable,
    schoolDetails,
    teacherFreePeriods,
    liveStatus,
  });
});

/**
 * POST /api/v1/timetables/manage
 * Authoritative endpoint for creating or updating a school timetable.
 * Performs deep conflict checks, optimistic concurrency checking, and immutable audit logging.
 */
export const handleManageTimetable = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    schoolId,
    academicYear,
    status = TIMETABLE_STATUS.ACTIVE,
    version,
    periodSlots,
    schedule,
  } = request.body;

  // 1. Jurisdictional HM Enforcement: HM can ONLY manage their own school
  if (requestingActor.role === ROLES.HM) {
    if (!requestingActor.schoolId || String(requestingActor.schoolId) !== String(schoolId)) {
      await AuditLog.create({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName: requestingActor.fullName || '',
        action: 'HM_CROSS_SCHOOL_TIMETABLE_VIOLATION',
        targetModel: 'Timetable',
        targetId: schoolId,
        schoolId: requestingActor.schoolId || null,
        townId: requestingActor.townId || null,
        result: 'DENIED',
        reason: 'HM attempted cross-school timetable mutation.',
        ipAddress: request.ip || '',
        userAgent: request.headers?.['user-agent'] || '',
        requestId: request.headers?.['x-request-id'] || '',
      });
      return sendError(response, 403, 'Access denied: You can only manage your own school timetable.');
    }
  }

  // 1.5. Section resolution & auto-sync of TeachingAssignments for allocated classes
  if (Array.isArray(schedule) && schedule.length > 0) {
    const missingSectionEntries = schedule.filter((entry) => !entry.sectionId);
    if (mongoose.connection?.readyState === 1 && missingSectionEntries.length > 0 && typeof Section.find === 'function') {
      const classIds = [...new Set(missingSectionEntries.map((entry) => String(entry.classId)).filter(Boolean))];
      const sectionQuery = Section.find({ classId: { $in: classIds }, schoolId });
      const sections = sectionQuery && typeof sectionQuery.lean === 'function' ? await sectionQuery.lean() : await sectionQuery;
      const sectionByClass = new Map();
      if (Array.isArray(sections)) {
        for (const sectionItem of sections) {
          if (!sectionByClass.has(String(sectionItem.classId))) {
            sectionByClass.set(String(sectionItem.classId), sectionItem);
          }
        }
      }

      for (const entry of missingSectionEntries) {
        if (!entry.sectionId && sectionByClass.has(String(entry.classId))) {
          entry.sectionId = sectionByClass.get(String(entry.classId))._id;
        }
      }
    }

    if (mongoose.connection?.readyState === 1 && typeof TeachingAssignment.findOneAndUpdate === 'function') {
      for (const entry of schedule) {
        if (entry.teacherId && entry.subjectId && entry.classId && entry.sectionId) {
          await TeachingAssignment.findOneAndUpdate(
            {
              teacherId: entry.teacherId,
              schoolId,
              classId: entry.classId,
              sectionId: entry.sectionId,
              subjectId: entry.subjectId,
            },
            {
              $set: { status: 'ACTIVE' },
            },
            { upsert: true, new: true }
          );
        }
      }
    }

    // 1.6. Institutional Rule: The teacher assigned to Period 1 automatically becomes the primary Class Teacher
    if (mongoose.connection?.readyState === 1 && typeof Section.findByIdAndUpdate === 'function') {
      const periodOneEntries = schedule.filter((entry) => Number(entry.periodNumber) === 1 && entry.sectionId && entry.teacherId);
      for (const p1Entry of periodOneEntries) {
        await Section.findByIdAndUpdate(p1Entry.sectionId, {
          $set: { classTeacherId: p1Entry.teacherId },
        });
      }
    }
  }

  // 2. Server-Authoritative Conflict Engine
  let conflictValidationResult;
  try {
    conflictValidationResult = await validateTimetableConflicts({
      schoolId,
      academicYear,
      periodSlots,
      schedule,
    });
  } catch (validationError) {
    if (validationError instanceof TimetableValidationError) {
      return sendError(response, validationError.statusCode, validationError.message, {
        errorType: validationError.errorType,
        details: validationError.details,
      });
    }
    throw validationError;
  }

  const { targetSchool } = conflictValidationResult;

  // 3. Concurrency-Safe Mutation / Upsert Logic
  const existingTimetable = await Timetable.findOne({
    schoolId,
    academicYear,
    status: TIMETABLE_STATUS.ACTIVE,
  });

  let savedTimetable;
  let actionType = 'TIMETABLE_CREATED';
  let previousStateSnapshot = null;

  if (existingTimetable) {
    // Optimistic Concurrency Check: If client supplied a version, enforce match
    if (version !== undefined && version !== null && existingTimetable.version !== version) {
      return sendError(
        response,
        409,
        `Conflict: Timetable was updated by another administrator (expected version ${version}, but database is at version ${existingTimetable.version}). Please refresh and review before saving.`
      );
    }

    previousStateSnapshot = {
      version: existingTimetable.version,
      periodSlotsCount: existingTimetable.periodSlots.length,
      scheduleCount: existingTimetable.schedule.length,
      updatedAt: existingTimetable.updatedAt,
    };

    existingTimetable.periodSlots = periodSlots;
    existingTimetable.schedule = schedule;
    existingTimetable.status = status;
    existingTimetable.version = (existingTimetable.version || 1) + 1;
    existingTimetable.updatedBy = requestingActor._id;

    savedTimetable = await existingTimetable.save();
    actionType = 'TIMETABLE_UPDATED';
  } else {
    savedTimetable = await Timetable.create({
      schoolId,
      academicYear,
      status,
      version: 1,
      periodSlots,
      schedule,
      createdBy: requestingActor._id,
    });
    actionType = 'TIMETABLE_CREATED';
  }

  // 4. Immutable Security Audit Log
  await AuditLog.create({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: actionType,
    targetModel: 'Timetable',
    targetId: savedTimetable._id,
    schoolId,
    townId: targetSchool.townId || null,
    previousState: previousStateSnapshot,
    newState: {
      version: savedTimetable.version,
      academicYear: savedTimetable.academicYear,
      periodSlotsCount: savedTimetable.periodSlots.length,
      scheduleEntriesCount: savedTimetable.schedule.length,
    },
    result: 'SUCCESS',
    reason: `Timetable ${actionType === 'TIMETABLE_CREATED' ? 'created' : 'updated'} via administrative management portal.`,
    ipAddress: request.ip || '',
    userAgent: request.headers?.['user-agent'] || '',
    requestId: request.headers?.['x-request-id'] || '',
  });

  return sendSuccess(
    response,
    actionType === 'TIMETABLE_CREATED' ? 201 : 200,
    `Timetable ${actionType === 'TIMETABLE_CREATED' ? 'created' : 'updated'} successfully.`,
    savedTimetable
  );
});

/**
 * GET /api/v1/timetables/town-live-monitor
 * High-level monitoring view for Town Administrators and Supervisors.
 * Computes deterministic real-time status across all authorized schools in their cluster.
 */
export const handleGetTownLiveMonitor = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const schoolFilterCriteria = { status: 'ACTIVE' };

  if (requestingActor.role === ROLES.SUPERVISOR) {
    schoolFilterCriteria._id = { $in: requestingActor.assignedSchools || [] };
  } else if (requestingActor.role === ROLES.ADMIN) {
    if (requestingActor.townId) {
      schoolFilterCriteria.townId = requestingActor.townId;
    }
  }

  const municipalSchools = await School.find(schoolFilterCriteria)
    .select('_id name schoolCode emisCode townId')
    .sort({ name: 1 })
    .lean();

  const monitoredSchoolsList = await Promise.all(
    municipalSchools.map(async (schoolRecord) => {
      const activeTimetable = await Timetable.findOne({
        schoolId: schoolRecord._id,
        status: TIMETABLE_STATUS.ACTIVE,
      }).lean();

      if (!activeTimetable) {
        return {
          schoolId: schoolRecord._id,
          schoolName: schoolRecord.name,
          schoolCode: schoolRecord.schoolCode || '',
          emisCode: schoolRecord.emisCode || '',
          hasTimetable: false,
          liveStatus: null,
          activePeriodsSummary: null,
        };
      }

      const liveStatus = calculateLivePeriod(activeTimetable.periodSlots);
      let activePeriodsSummary = null;

      if (liveStatus.status === 'ACTIVE_TEACHING' && liveStatus.activeSlot) {
        const todayDayOfWeek = liveStatus.currentDay;
        const currentActivePeriodNumber = liveStatus.activeSlot.periodNumber;

        const ongoingClasses = activeTimetable.schedule.filter(
          (entry) =>
            entry.dayOfWeek === todayDayOfWeek &&
            entry.periodNumber === currentActivePeriodNumber
        );

        activePeriodsSummary = {
          activePeriodNumber: currentActivePeriodNumber,
          label: liveStatus.activeSlot.label,
          totalOngoingClasses: ongoingClasses.length,
          timeWindow: `${liveStatus.activeSlot.startTime} - ${liveStatus.activeSlot.endTime}`,
        };
      }

      return {
        schoolId: schoolRecord._id,
        schoolName: schoolRecord.name,
        schoolCode: schoolRecord.schoolCode || '',
        emisCode: schoolRecord.emisCode || '',
        hasTimetable: true,
        academicYear: activeTimetable.academicYear,
        liveStatus,
        activePeriodsSummary,
      };
    })
  );

  return sendSuccess(
    response,
    200,
    'Town live timetable monitoring data retrieved successfully.',
    monitoredSchoolsList
  );
});

/**
 * GET /api/v1/timetables/my-schedule
 * Personalized schedule resolver for Teachers, Students, and Parents.
 * Resolves schedule based strictly on the authenticated actor without trusting client parameters.
 */
export const handleGetMySchedule = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  // ── A. Teacher Personal Timetable ──────────────────────────────────────────
  if (requestingActor.role === ROLES.TEACHER) {
    const teacherSchoolId = requestingActor.schoolId;
    if (!teacherSchoolId) {
      return sendError(response, 400, 'Teacher profile is not associated with any municipal school.');
    }

    const activeTimetable = await Timetable.findOne({
      schoolId: teacherSchoolId,
      status: TIMETABLE_STATUS.ACTIVE,
    })
      .populate('schedule.classId', 'name code numericGrade')
      .populate('schedule.sectionId', 'name medium roomNumber')
      .populate('schedule.subjectId', 'name code')
      .lean();

    if (!activeTimetable) {
      return sendError(response, 404, 'No active timetable found for your school.');
    }

    const teacherAllocations = activeTimetable.schedule.filter(
      (entry) => String(entry.teacherId) === String(requestingActor._id)
    );

    const liveStatus = calculateLivePeriod(activeTimetable.periodSlots);
    let currentTeacherActivity = null;
    let nextTeacherActivity = null;

    if (liveStatus.currentDay && liveStatus.currentDay !== 'SUNDAY') {
      const todayAllocations = teacherAllocations.filter(
        (entry) => entry.dayOfWeek === liveStatus.currentDay
      );

      if (liveStatus.status === 'ACTIVE_TEACHING' && liveStatus.activeSlot) {
        const ongoingLesson = todayAllocations.find(
          (entry) => entry.periodNumber === liveStatus.activeSlot.periodNumber
        );
        currentTeacherActivity = ongoingLesson || { status: 'FREE_PERIOD', message: 'No teaching assignment scheduled for this period.' };
      }

      if (liveStatus.nextSlot) {
        const upcomingLesson = todayAllocations.find(
          (entry) => entry.periodNumber === liveStatus.nextSlot.periodNumber
        );
        nextTeacherActivity = upcomingLesson || { status: 'FREE_PERIOD', message: 'No class scheduled in next period.' };
      }
    }

    const teachingSlots = (activeTimetable.periodSlots || []).filter(
      (slot) => slot.slotType === 'TEACHING'
    );
    const assignedPeriodNumbers = new Set(
      teacherAllocations
        .filter((entry) => entry.dayOfWeek === (liveStatus.currentDay && liveStatus.currentDay !== 'SUNDAY' ? liveStatus.currentDay : 'MONDAY'))
        .map((entry) => entry.periodNumber)
    );
    const myFreePeriodsToday = teachingSlots
      .filter((slot) => !assignedPeriodNumbers.has(slot.periodNumber))
      .map((slot) => slot.periodNumber)
      .sort((firstPeriodNumber, secondPeriodNumber) => firstPeriodNumber - secondPeriodNumber);

    return sendSuccess(response, 200, 'Teacher personal schedule retrieved.', {
      schoolId: teacherSchoolId,
      academicYear: activeTimetable.academicYear,
      periodSlots: activeTimetable.periodSlots,
      mySchedule: teacherAllocations,
      myFreePeriodsToday,
      liveStatus,
      currentTeacherActivity,
      nextTeacherActivity,
    });
  }

  // ── B. Student Personal Class Timetable ─────────────────────────────────────
  if (requestingActor.role === ROLES.STUDENT) {
    const studentProfile = await StudentProfile.findOne({ userId: requestingActor._id }).lean();
    if (!studentProfile) {
      return sendError(response, 404, 'Student enrollment record not found.');
    }

    const activeTimetable = await Timetable.findOne({
      schoolId: studentProfile.schoolId,
      status: TIMETABLE_STATUS.ACTIVE,
    })
      .populate('schedule.classId', 'name code numericGrade')
      .populate('schedule.sectionId', 'name medium roomNumber')
      .populate('schedule.subjectId', 'name code')
      .populate('schedule.teacherId', 'fullName designation')
      .lean();

    if (!activeTimetable) {
      return sendError(response, 404, 'No active timetable found for your school.');
    }

    const studentClassSchedule = activeTimetable.schedule.filter((entry) => {
      const entryClassId = String(entry.classId?._id || entry.classId);
      const studentClassId = String(studentProfile.classId?._id || studentProfile.classId);
      if (entryClassId !== studentClassId) return false;
      if (studentProfile.sectionId && entry.sectionId) {
        return String(entry.sectionId?._id || entry.sectionId) === String(studentProfile.sectionId?._id || studentProfile.sectionId);
      }
      return true;
    });

    const liveStatus = calculateLivePeriod(activeTimetable.periodSlots);
    let currentClassActivity = null;

    if (liveStatus.status === 'ACTIVE_TEACHING' && liveStatus.activeSlot) {
      currentClassActivity = studentClassSchedule.find(
        (entry) =>
          entry.dayOfWeek === liveStatus.currentDay &&
          entry.periodNumber === liveStatus.activeSlot.periodNumber
      ) || null;
    }

    return sendSuccess(response, 200, 'Student personal class timetable retrieved.', {
      schoolId: studentProfile.schoolId,
      classId: studentProfile.classId,
      sectionId: studentProfile.sectionId,
      academicYear: activeTimetable.academicYear,
      periodSlots: activeTimetable.periodSlots,
      mySchedule: studentClassSchedule,
      liveStatus,
      currentClassActivity,
    });
  }

  // ── C. Parent Child Timetable (Bound through ParentStudentLink) ────────────
  if (requestingActor.role === ROLES.PARENT) {
    const { studentId } = request.query;
    if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
      return sendError(response, 400, 'A valid studentId parameter is required to view ward schedule.');
    }

    // Verify verified parental relationship
    const verifiedParentLink = await ParentStudentLink.findOne({
      parentId: requestingActor._id,
      studentId,
      status: PARENT_STUDENT_LINK_STATUS.VERIFIED,
    }).lean();

    if (!verifiedParentLink) {
      return sendError(
        response,
        403,
        'Access denied: You do not have an approved/verified parental link to this student.'
      );
    }

    const studentProfile = await StudentProfile.findOne({
      $or: [{ _id: studentId }, { userId: studentId }],
    }).lean();

    if (!studentProfile) {
      return sendError(response, 404, 'Enrolled ward record not found.');
    }

    const activeTimetable = await Timetable.findOne({
      schoolId: studentProfile.schoolId,
      status: TIMETABLE_STATUS.ACTIVE,
    })
      .populate('schedule.classId', 'name code numericGrade')
      .populate('schedule.sectionId', 'name medium roomNumber')
      .populate('schedule.subjectId', 'name code')
      .populate('schedule.teacherId', 'fullName designation')
      .lean();

    if (!activeTimetable) {
      return sendError(response, 404, 'No active timetable found for this school.');
    }

    const wardSchedule = activeTimetable.schedule.filter((entry) => {
      const entryClassId = String(entry.classId?._id || entry.classId);
      const studentClassId = String(studentProfile.classId?._id || studentProfile.classId);
      if (entryClassId !== studentClassId) return false;
      if (studentProfile.sectionId && entry.sectionId) {
        return String(entry.sectionId?._id || entry.sectionId) === String(studentProfile.sectionId?._id || studentProfile.sectionId);
      }
      return true;
    });

    const liveStatus = calculateLivePeriod(activeTimetable.periodSlots);

    return sendSuccess(response, 200, 'Ward timetable retrieved successfully.', {
      studentId: studentProfile._id,
      schoolId: studentProfile.schoolId,
      classId: studentProfile.classId,
      sectionId: studentProfile.sectionId,
      academicYear: activeTimetable.academicYear,
      periodSlots: activeTimetable.periodSlots,
      wardSchedule,
      liveStatus,
    });
  }

  return sendError(response, 403, 'Your role is not authorized to query personal schedule.');
});
