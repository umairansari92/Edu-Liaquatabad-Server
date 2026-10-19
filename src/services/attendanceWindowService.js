/**
 * ⏰ Attendance Window & School Closure Verification Service
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Implements:
 * 1. Stage 1: Active Holiday / Vacation Check (TOWN + SCHOOL scopes)
 * 2. Stage 2: Weekly-Off Pattern Check (Sunday / Saturday policies)
 * 3. Stage 3: Dynamic Timing Window (PKT Timezone, Friday Jummah schedules)
 * 4. HM Bounded Same-Day Late Override Guard (strictly today <= 23:59 PKT)
 */

import mongoose from 'mongoose';
import HolidayCalendar from '../models/HolidayCalendar.js';
import WeeklyOffPattern from '../models/WeeklyOffPattern.js';
import cache from '../utils/cache.js';
import {
  getKarachiTimeString,
  getKarachiDateString,
  getKarachiDayOfWeek,
} from '../utils/karachiTime.js';
import { ROLES } from '../../config/constants.js';

export const DEFAULT_SCHOOL_TIMINGS = Object.freeze({
  regular: {
    startTime:             '08:00',
    endTime:               '13:30',
    attendanceWindowStart: '07:45',
    attendanceWindowEnd:   '14:00',
  },
  friday: {
    startTime:             '07:30',
    endTime:               '12:00',
    attendanceWindowStart: '07:15',
    attendanceWindowEnd:   '12:30',
  },
  allowHmLateOverride: true,
});

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Resolves safe, validated operational schedule and attendance window for a school.
 * Backward-compatible: falls back safely to municipal default timings if legacy or missing.
 *
 * @param {Object} school
 * @param {boolean} isFriday
 * @returns {{ windowStart: string, windowEnd: string, startTime: string, endTime: string, allowHmLateOverride: boolean }}
 */
export const resolveSchoolSchedule = (school, isFriday) => {
  const daySchedule = isFriday ? school?.timings?.friday : school?.timings?.regular;
  const fallbackSchedule = isFriday ? DEFAULT_SCHOOL_TIMINGS.friday : DEFAULT_SCHOOL_TIMINGS.regular;

  let windowStart = daySchedule?.attendanceWindowStart;
  let windowEnd = daySchedule?.attendanceWindowEnd;

  // Validate window format and validity
  if (!windowStart || typeof windowStart !== 'string' || !TIME_REGEX.test(windowStart)) {
    windowStart = fallbackSchedule.attendanceWindowStart;
  }
  if (!windowEnd || typeof windowEnd !== 'string' || !TIME_REGEX.test(windowEnd)) {
    windowEnd = fallbackSchedule.attendanceWindowEnd;
  }

  // Ensure windowEnd > windowStart; if corrupted in legacy record, use safe fallback
  if (windowEnd <= windowStart) {
    windowStart = fallbackSchedule.attendanceWindowStart;
    windowEnd = fallbackSchedule.attendanceWindowEnd;
  }

  let startTime = daySchedule?.startTime;
  let endTime = daySchedule?.endTime;
  if (!startTime || typeof startTime !== 'string' || !TIME_REGEX.test(startTime)) {
    startTime = fallbackSchedule.startTime;
  }
  if (!endTime || typeof endTime !== 'string' || !TIME_REGEX.test(endTime)) {
    endTime = fallbackSchedule.endTime;
  }

  const allowHmLateOverride = school?.timings?.allowHmLateOverride !== undefined
    ? Boolean(school.timings.allowHmLateOverride)
    : DEFAULT_SCHOOL_TIMINGS.allowHmLateOverride;

  return {
    windowStart,
    windowEnd,
    startTime,
    endTime,
    allowHmLateOverride,
  };
};

/**
 * Checks if a school is officially closed on a given date due to
 * an active holiday, vacation, rain emergency, or weekly off day.
 *
 * @param {Object} school
 * @param {Date} [date=new Date()]
 * @returns {Promise<{ isClosed: boolean, reason?: string, type?: string }>}
 */
export const checkIsSchoolClosed = async (school, date = new Date()) => {
  if (!school) return { isClosed: false };
  if (mongoose.connection.readyState === 0 && HolidayCalendar.findOne === mongoose.Model.findOne) {
    return { isClosed: false };
  }

  const targetDatePkt = getKarachiDateString(date);
  const targetDayOfWeek = getKarachiDayOfWeek(date);

  const cacheKey = `school:${school._id}:closed:${targetDatePkt}`;
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // ── Stage 1: Check HolidayCalendar (Town scope OR School scope) ──────────────
  const activeHoliday = await HolidayCalendar.findOne({
    status: 'ACTIVE',
    startDate: { $lte: targetDatePkt },
    endDate: { $gte: targetDatePkt },
    $or: [
      { scopeType: 'TOWN', townId: school.townId },
      { scopeType: 'SCHOOL', schoolId: school._id },
    ],
  }).sort({ scopeType: -1 }).lean(); // SCHOOL scope matches first if both exist

  if (activeHoliday) {
    const result = {
      isClosed: true,
      type: 'HOLIDAY',
      reason: `${activeHoliday.title} (${activeHoliday.reason})`,
      holiday: activeHoliday,
    };
    cache.set(cacheKey, result, 60); // Cache for 60 seconds
    return result;
  }

  // ── Stage 2: Check WeeklyOffPattern (Recurring weekend rules) ───────────────
  const activeWeeklyOff = await WeeklyOffPattern.findOne({
    status: 'ACTIVE',
    effectiveFrom: { $lte: date },
    $and: [
      {
        $or: [
          { effectiveTo: null },
          { effectiveTo: { $gte: date } },
        ],
      },
      {
        $or: [
          { scopeType: 'SCHOOL', schoolId: school._id },
          { scopeType: 'TOWN', townId: school.townId },
        ],
      },
    ],
    offDays: targetDayOfWeek,
  }).sort({ scopeType: -1 }).lean();

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (activeWeeklyOff) {
    const result = {
      isClosed: true,
      type: 'WEEKLY_OFF',
      reason: `Official Weekly Off Day: ${dayNames[targetDayOfWeek]} (${activeWeeklyOff.reason})`,
      weeklyOff: activeWeeklyOff,
    };
    cache.set(cacheKey, result, 60);
    return result;
  }

  // Statutory baseline fallback: Sunday (0) is always a non-working day unless specifically overridden
  if (targetDayOfWeek === 0) {
    const result = {
      isClosed: true,
      type: 'WEEKLY_OFF',
      reason: 'Official Weekly Off Day: Sunday (Statutory Government Weekly Off)',
    };
    cache.set(cacheKey, result, 60);
    return result;
  }

  const result = { isClosed: false };
  cache.set(cacheKey, result, 60);
  return result;
};

/**
 * Full 3-Stage validation gate for attendance submission.
 * Enforces holiday checks, weekly off days, PKT timing windows, and HM overrides.
 *
 * @param {Object} params
 * @param {Object} params.school
 * @param {Object} params.requestingActor
 * @param {Date} [params.date=new Date()]
 * @param {Date} [params.currentTime]
 * @param {boolean} [params.isLateOverride=false]
 * @param {string} [params.lateReason='']
 * @returns {Promise<{ allowed: boolean, code?: string, reason?: string, isLateOverride?: boolean, lateReason?: string }>}
 */
export const validateSubmissionWindow = async ({
  school,
  requestingActor,
  date = new Date(),
  currentTime,
  isLateOverride = false,
  lateReason = '',
}) => {
  if (!school) {
    return { allowed: false, code: 'SCHOOL_NOT_FOUND', reason: 'School reference not found.' };
  }

  // ── 1. Holiday & Weekly-Off Checks ──────────────────────────────────────────
  const closureStatus = await checkIsSchoolClosed(school, date);
  if (closureStatus.isClosed) {
    return {
      allowed: false,
      code: 'SCHOOL_CLOSED',
      reason: `Attendance marking is suspended. ${closureStatus.reason}`,
    };
  }

  // ── 2. Timezone-Aware Timing Window Check ──────────────────────────────────
  const currentDayOfWeek = getKarachiDayOfWeek(date);
  const isFriday = currentDayOfWeek === 5;

  const { windowStart, windowEnd, allowHmLateOverride } = resolveSchoolSchedule(school, isFriday);

  const todayPktDate = getKarachiDateString(new Date());
  const submissionDatePkt = getKarachiDateString(date);

  // Determine effective clock time:
  // 1. Explicit currentTime parameter takes precedence.
  // 2. If date is a date-only Date (UTC midnight 00:00:00.000) representing today in PKT,
  //    evaluate against the current real-world clock time (new Date()).
  // 3. Otherwise (e.g. unit tests passing simulated hours or specific timestamps), use date.
  let effectiveTimeDate = currentTime;
  if (!effectiveTimeDate) {
    const isUtcMidnight = date instanceof Date &&
      date.getUTCHours() === 0 &&
      date.getUTCMinutes() === 0 &&
      date.getUTCSeconds() === 0 &&
      date.getUTCMilliseconds() === 0;

    if (isUtcMidnight && submissionDatePkt === todayPktDate) {
      effectiveTimeDate = new Date();
    } else {
      effectiveTimeDate = date;
    }
  }

  const currentTimePkt = getKarachiTimeString(effectiveTimeDate);

  // Early gate
  if (currentTimePkt < windowStart) {
    return {
      allowed: false,
      code: 'WINDOW_NOT_OPENED',
      reason: `Attendance window has not opened yet. Window opens at ${windowStart} PKT for this school.`,
    };
  }

  // Late gate
  if (currentTimePkt > windowEnd) {
    const isActorHm = requestingActor?.role === ROLES.HM || requestingActor?.role === ROLES.ADMIN || requestingActor?.role === ROLES.SUPER_ADMIN || requestingActor?.role === ROLES.ROOT_ADMIN;

    if (isActorHm && isLateOverride) {
      // If late override is administratively disabled for this school
      if (!allowHmLateOverride && requestingActor?.role === ROLES.HM) {
        return {
          allowed: false,
          code: 'OVERRIDE_DISABLED',
          reason: 'Emergency late override is administratively disabled for this school. Contact municipal education administration.',
        };
      }

      // Ground check: Late override is STRICTLY permitted on the same calendar day in PKT!
      if (submissionDatePkt !== todayPktDate) {
        return {
          allowed: false,
          code: 'BACKDATING_BLOCKED',
          reason: 'Emergency late override is restricted strictly to the same calendar day (until 23:59 PKT). Historical attendance adjustments require formal administrative review.',
        };
      }

      if (!lateReason || typeof lateReason !== 'string' || lateReason.trim().length < 5) {
        return {
          allowed: false,
          code: 'REASON_REQUIRED',
          reason: 'A specific justification (minimum 5 characters, e.g. "Power outage / internet disruption") is mandatory for emergency late clearance.',
        };
      }

      return {
        allowed: true,
        isLateOverride: true,
        lateReason: lateReason.trim(),
      };
    }

    return {
      allowed: false,
      code: 'WINDOW_CLOSED',
      reason: `Attendance window closed at ${windowEnd} PKT. Contact your Head Master for same-day emergency late clearance.`,
    };
  }

  return { allowed: true };
};
