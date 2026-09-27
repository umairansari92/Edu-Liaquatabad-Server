import mongoose from 'mongoose';
import School from '../models/School.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import User from '../models/User.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import { TEACHING_ASSIGNMENT_STATUS, ROLES, TIMETABLE_SLOT_TYPE } from '../../config/constants.js';
import { getKarachiTimeString, getKarachiDayOfWeek } from '../utils/karachiTime.js';

export class TimetableValidationError extends Error {
  constructor(message, statusCode = 400, errorType = 'VALIDATION_ERROR', details = {}) {
    super(message);
    this.name = 'TimetableValidationError';
    this.statusCode = statusCode;
    this.errorType = errorType;
    this.details = details;
  }
}

/**
 * Deterministically computes the current active period status without any background timers.
 * Purely functional: current time + day in PKT + configured period slots.
 */
export const calculateLivePeriod = (periodSlots = [], targetTime = null, targetDayNumber = null) => {
  const currentKarachiTime = targetTime || getKarachiTimeString();
  const currentDayOfWeekNumber = targetDayNumber !== null && targetDayNumber !== undefined
    ? targetDayNumber
    : getKarachiDayOfWeek();

  const DAY_NAMES = {
    0: 'SUNDAY',
    1: 'MONDAY',
    2: 'TUESDAY',
    3: 'WEDNESDAY',
    4: 'THURSDAY',
    5: 'FRIDAY',
    6: 'SATURDAY',
  };

  const dayName = DAY_NAMES[currentDayOfWeekNumber] || 'MONDAY';

  // Sunday is official weekly off
  if (currentDayOfWeekNumber === 0) {
    return {
      status: 'OFF_DAY',
      currentDay: 'SUNDAY',
      currentTime: currentKarachiTime,
      activeSlot: null,
      nextSlot: null,
      message: 'School is closed today (Sunday).',
    };
  }

  if (!periodSlots || periodSlots.length === 0) {
    return {
      status: 'UNCONFIGURED',
      currentDay: dayName,
      currentTime: currentKarachiTime,
      activeSlot: null,
      nextSlot: null,
      message: 'No period slots configured for this timetable.',
    };
  }

  const sortedSlots = [...periodSlots].sort((slotA, slotB) =>
    slotA.startTime.localeCompare(slotB.startTime)
  );

  const firstSlot = sortedSlots[0];
  const lastSlot = sortedSlots[sortedSlots.length - 1];

  // Case 1: Before School
  if (currentKarachiTime < firstSlot.startTime) {
    return {
      status: 'BEFORE_SCHOOL',
      currentDay: dayName,
      currentTime: currentKarachiTime,
      activeSlot: null,
      nextSlot: firstSlot,
      message: `School has not started yet. First slot (${firstSlot.label}) begins at ${firstSlot.startTime}.`,
    };
  }

  // Case 2: After School
  if (currentKarachiTime >= lastSlot.endTime) {
    return {
      status: 'AFTER_SCHOOL',
      currentDay: dayName,
      currentTime: currentKarachiTime,
      activeSlot: null,
      nextSlot: null,
      message: `School concluded for today at ${lastSlot.endTime}.`,
    };
  }

  // Case 3: Check Active Slot or Interval
  for (let slotIndex = 0; slotIndex < sortedSlots.length; slotIndex++) {
    const slot = sortedSlots[slotIndex];

    // Inside an active slot
    if (currentKarachiTime >= slot.startTime && currentKarachiTime < slot.endTime) {
      let resolvedStatus = 'ACTIVE_TEACHING';
      if (slot.slotType === TIMETABLE_SLOT_TYPE.ASSEMBLY) resolvedStatus = 'ASSEMBLY';
      else if (slot.slotType === TIMETABLE_SLOT_TYPE.RECESS) resolvedStatus = 'RECESS';
      else if (slot.slotType === TIMETABLE_SLOT_TYPE.ZERO_PERIOD) resolvedStatus = 'ZERO_PERIOD';
      else if (slot.slotType === TIMETABLE_SLOT_TYPE.SPECIAL_ACTIVITY) resolvedStatus = 'SPECIAL_ACTIVITY';

      return {
        status: resolvedStatus,
        currentDay: dayName,
        currentTime: currentKarachiTime,
        activeSlot: slot,
        nextSlot: sortedSlots[slotIndex + 1] || null,
        message: `${slot.label} in progress (${slot.startTime} - ${slot.endTime}).`,
      };
    }

    // Between slots (interval / passing period)
    if (slotIndex < sortedSlots.length - 1) {
      const nextSlot = sortedSlots[slotIndex + 1];
      if (currentKarachiTime >= slot.endTime && currentKarachiTime < nextSlot.startTime) {
        return {
          status: 'INTERVAL',
          currentDay: dayName,
          currentTime: currentKarachiTime,
          activeSlot: null,
          previousSlot: slot,
          nextSlot,
          message: `Passing period. Next is ${nextSlot.label} at ${nextSlot.startTime}.`,
        };
      }
    }
  }

  return {
    status: 'UNCONFIGURED_GAP',
    currentDay: dayName,
    currentTime: currentKarachiTime,
    activeSlot: null,
    nextSlot: null,
    message: 'Current time falls into an unconfigured schedule gap.',
  };
};

/**
 * Authoritative Server-Side Conflict Detection Engine
 * Validates cross-school boundaries, double-bookings, existence, and mandatory TeachingAssignments.
 */
export const validateTimetableConflicts = async ({
  schoolId,
  academicYear,
  periodSlots = [],
  schedule = [],
}) => {
  const normalizedSchoolId = String(schoolId);

  // ── 1. Verify Target School Exists & Is Active ───────────────────────────────
  const targetSchool = await School.findById(normalizedSchoolId).select('_id name status townId').lean();
  if (!targetSchool) {
    throw new TimetableValidationError('Target school does not exist.', 404, 'SCHOOL_NOT_FOUND');
  }
  if (targetSchool.status !== 'ACTIVE') {
    throw new TimetableValidationError(
      `Cannot configure timetable: School status is ${targetSchool.status}.`,
      400,
      'SCHOOL_NOT_ACTIVE'
    );
  }

  // ── 2. Slot Resolution & Mapping ─────────────────────────────────────────────
  const slotMapByNumber = new Map(periodSlots.map((slot) => [slot.periodNumber, slot]));

  // ── 3. Internal In-Memory Collision Detection ────────────────────────────────
  const classSectionAssignedKeys = new Set();
  const teacherAssignedKeys = new Set();

  for (let entryIndex = 0; entryIndex < schedule.length; entryIndex++) {
    const entry = schedule[entryIndex];
    const slot = slotMapByNumber.get(entry.periodNumber);

    if (!slot) {
      throw new TimetableValidationError(
        `Schedule entry ${entryIndex + 1} references non-existent periodNumber ${entry.periodNumber}.`,
        422,
        'INVALID_PERIOD_SLOT'
      );
    }

    // A. Class/Section Clash Check (same class + section cannot have multiple subjects at same day+period)
    const classSectionKey = `${entry.dayOfWeek}_${entry.periodNumber}_${entry.classId}_${entry.sectionId}`;
    if (classSectionAssignedKeys.has(classSectionKey)) {
      throw new TimetableValidationError(
        `Class/Section double-booking: Section is already scheduled on ${entry.dayOfWeek} for period ${entry.periodNumber}.`,
        409,
        'SECTION_PERIOD_CLASH',
        { dayOfWeek: entry.dayOfWeek, periodNumber: entry.periodNumber, classId: entry.classId, sectionId: entry.sectionId }
      );
    }
    classSectionAssignedKeys.add(classSectionKey);

    // B. Teacher Clash Check (same teacher cannot teach two classes at same day+period)
    if (entry.teacherId) {
      const teacherKey = `${entry.dayOfWeek}_${entry.periodNumber}_${String(entry.teacherId)}`;
      if (teacherAssignedKeys.has(teacherKey)) {
        throw new TimetableValidationError(
          `Teacher double-booking: Teacher is already scheduled to teach another class on ${entry.dayOfWeek} period ${entry.periodNumber}.`,
          409,
          'TEACHER_PERIOD_CLASH',
          { dayOfWeek: entry.dayOfWeek, periodNumber: entry.periodNumber, teacherId: entry.teacherId }
        );
      }
      teacherAssignedKeys.add(teacherKey);
    }
  }

  // ── 4. Collect IDs for Batch Database Verification ───────────────────────────
  const uniqueClassIds = [...new Set(schedule.map((entry) => String(entry.classId)))];
  const uniqueSectionIds = [...new Set(schedule.map((entry) => String(entry.sectionId)))];
  const uniqueSubjectIds = [...new Set(schedule.filter((entry) => entry.subjectId).map((entry) => String(entry.subjectId)))];
  const uniqueTeacherIds = [...new Set(schedule.filter((entry) => entry.teacherId).map((entry) => String(entry.teacherId)))];

  // A. Validate Classes (Existence, Active, School Ownership)
  if (uniqueClassIds.length > 0) {
    const classRecords = await Class.find({ _id: { $in: uniqueClassIds } }).select('_id schoolId name status').lean();
    const classMap = new Map(classRecords.map((cls) => [String(cls._id), cls]));

    for (const classIdString of uniqueClassIds) {
      const classRecord = classMap.get(classIdString);
      if (!classRecord) {
        throw new TimetableValidationError(`Class ID '${classIdString}' not found.`, 404, 'CLASS_NOT_FOUND');
      }
      if (classRecord.status !== 'ACTIVE') {
        throw new TimetableValidationError(`Class '${classRecord.name}' is not ACTIVE (status: ${classRecord.status}).`, 422, 'CLASS_INACTIVE');
      }
      if (String(classRecord.schoolId) !== normalizedSchoolId) {
        throw new TimetableValidationError(
          `Cross-school boundary violation: Class '${classRecord.name}' belongs to another school.`,
          403,
          'CROSS_SCHOOL_CLASS_VIOLATION'
        );
      }
    }
  }

  // B. Validate Sections (Existence, Active, School Ownership, Class Match)
  if (uniqueSectionIds.length > 0) {
    const sectionRecords = await Section.find({ _id: { $in: uniqueSectionIds } }).select('_id classId schoolId name status').lean();
    const sectionMap = new Map(sectionRecords.map((sec) => [String(sec._id), sec]));

    for (const entry of schedule) {
      const sectionRecord = sectionMap.get(String(entry.sectionId));
      if (!sectionRecord) {
        throw new TimetableValidationError(`Section ID '${entry.sectionId}' not found.`, 404, 'SECTION_NOT_FOUND');
      }
      if (sectionRecord.status !== 'ACTIVE') {
        throw new TimetableValidationError(`Section '${sectionRecord.name}' is not ACTIVE (status: ${sectionRecord.status}).`, 422, 'SECTION_INACTIVE');
      }
      if (sectionRecord.schoolId && String(sectionRecord.schoolId) !== normalizedSchoolId) {
        throw new TimetableValidationError(
          `Cross-school boundary violation: Section '${sectionRecord.name}' belongs to another school.`,
          403,
          'CROSS_SCHOOL_SECTION_VIOLATION'
        );
      }
      if (String(sectionRecord.classId) !== String(entry.classId)) {
        throw new TimetableValidationError(
          `Section mismatch: Section '${sectionRecord.name}' belongs to class ID ${sectionRecord.classId}, not ${entry.classId}.`,
          422,
          'SECTION_CLASS_MISMATCH'
        );
      }
    }
  }

  // C. Validate Subjects (Existence, Active, School Ownership)
  if (uniqueSubjectIds.length > 0) {
    const subjectRecords = await Subject.find({ _id: { $in: uniqueSubjectIds } }).select('_id schoolId name status').lean();
    const subjectMap = new Map(subjectRecords.map((sub) => [String(sub._id), sub]));

    for (const subjectIdString of uniqueSubjectIds) {
      const subjectRecord = subjectMap.get(subjectIdString);
      if (!subjectRecord) {
        throw new TimetableValidationError(`Subject ID '${subjectIdString}' not found.`, 404, 'SUBJECT_NOT_FOUND');
      }
      if (subjectRecord.status !== 'ACTIVE') {
        throw new TimetableValidationError(`Subject '${subjectRecord.name}' is not ACTIVE (status: ${subjectRecord.status}).`, 422, 'SUBJECT_INACTIVE');
      }
      if (String(subjectRecord.schoolId) !== normalizedSchoolId) {
        throw new TimetableValidationError(
          `Cross-school boundary violation: Subject '${subjectRecord.name}' belongs to another school.`,
          403,
          'CROSS_SCHOOL_SUBJECT_VIOLATION'
        );
      }
    }
  }

  // D. Validate Teachers (Existence, Active, Role, School Authorization)
  if (uniqueTeacherIds.length > 0) {
    const teacherRecords = await User.find({ _id: { $in: uniqueTeacherIds } }).select('_id fullName schoolId assignedSchools role status').lean();
    const teacherMap = new Map(teacherRecords.map((usr) => [String(usr._id), usr]));

    for (const teacherIdString of uniqueTeacherIds) {
      const teacherRecord = teacherMap.get(teacherIdString);
      if (!teacherRecord) {
        throw new TimetableValidationError(`Teacher ID '${teacherIdString}' not found.`, 404, 'TEACHER_NOT_FOUND');
      }
      if (teacherRecord.status !== 'ACTIVE') {
        throw new TimetableValidationError(`Teacher '${teacherRecord.fullName}' is not ACTIVE (status: ${teacherRecord.status}).`, 422, 'TEACHER_INACTIVE');
      }
      if (![ROLES.TEACHER, ROLES.HM].includes(teacherRecord.role)) {
        throw new TimetableValidationError(`User '${teacherRecord.fullName}' is not a designated teacher (role: ${teacherRecord.role}).`, 422, 'INVALID_TEACHER_ROLE');
      }

      // Teacher must either belong directly to this school or be assigned to it
      const belongsToSchool = String(teacherRecord.schoolId) === normalizedSchoolId;
      const isAssignedToSchool = (teacherRecord.assignedSchools || []).some(
        (assignedSchoolId) => String(assignedSchoolId) === normalizedSchoolId
      );

      if (!belongsToSchool && !isAssignedToSchool) {
        throw new TimetableValidationError(
          `Unauthorized Teacher: Teacher '${teacherRecord.fullName}' is not assigned to school '${targetSchool.name}'.`,
          403,
          'UNAUTHORIZED_TEACHER_SCHOOL'
        );
      }
    }
  }

  // ── 5. Strict Mandatory TeachingAssignment Cross-Verification ───────────────
  // For every TEACHING schedule entry, verify an active TeachingAssignment exists.
  for (let entryIndex = 0; entryIndex < schedule.length; entryIndex++) {
    const entry = schedule[entryIndex];
    const slot = slotMapByNumber.get(entry.periodNumber);

    if (slot && slot.slotType === TIMETABLE_SLOT_TYPE.TEACHING) {
      if (!entry.teacherId) {
        throw new TimetableValidationError(
          `Teaching period entry (${entry.dayOfWeek}, Period ${entry.periodNumber}) requires an assigned teacherId.`,
          422,
          'MISSING_TEACHING_TEACHER'
        );
      }
      if (!entry.subjectId) {
        throw new TimetableValidationError(
          `Teaching period entry (${entry.dayOfWeek}, Period ${entry.periodNumber}) requires an assigned subjectId.`,
          422,
          'MISSING_TEACHING_SUBJECT'
        );
      }

      // Check TeachingAssignment in DB
      const hasActiveAssignment = await TeachingAssignment.findOne({
        teacherId: entry.teacherId,
        schoolId: normalizedSchoolId,
        classId: entry.classId,
        sectionId: entry.sectionId,
        subjectId: entry.subjectId,
        status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
      }).lean();

      if (!hasActiveAssignment) {
        throw new TimetableValidationError(
          `Academic Assignment Violation: Teacher is not actively assigned to teach this subject in this section in TeachingAssignment records. Allocation rejected.`,
          422,
          'TEACHING_ASSIGNMENT_NOT_FOUND',
          {
            teacherId: entry.teacherId,
            classId: entry.classId,
            sectionId: entry.sectionId,
            subjectId: entry.subjectId,
            dayOfWeek: entry.dayOfWeek,
            periodNumber: entry.periodNumber,
          }
        );
      }
    }
  }

  return { isValid: true, targetSchool };
};
