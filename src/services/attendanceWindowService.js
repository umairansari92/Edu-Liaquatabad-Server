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
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $gte: date } },
    ],
    offDays: targetDayOfWeek,
    $or: [
      { scopeType: 'SCHOOL', schoolId: school._id },
      { scopeType: 'TOWN', townId: school.townId },
    ],
  }).sort({ scopeType: -1 }).lean();

  if (activeWeeklyOff) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const result = {
      isClosed: true,
      type: 'WEEKLY_OFF',
      reason: `Official Weekly Off Day: ${dayNames[targetDayOfWeek]} (${activeWeeklyOff.reason})`,
      weeklyOff: activeWeeklyOff,
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
 * @param {boolean} [params.isLateOverride=false]
 * @param {string} [params.lateReason='']
 * @returns {Promise<{ allowed: boolean, code?: string, reason?: string, isLateOverride?: boolean, lateReason?: string }>}
 */
export const validateSubmissionWindow = async ({
  school,
  requestingActor,
  date = new Date(),
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

  const schedule = isFriday ? school.timings?.friday : school.timings?.regular;
  const windowStart = schedule?.attendanceWindowStart || (isFriday ? '07:15' : '07:45');
  const windowEnd   = schedule?.attendanceWindowEnd   || (isFriday ? '12:30' : '14:00');

  const currentTimePkt = getKarachiTimeString(date);

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
    const isActorHm = requestingActor.role === ROLES.HM || requestingActor.role === ROLES.ADMIN || requestingActor.role === ROLES.SUPER_ADMIN || requestingActor.role === ROLES.ROOT_ADMIN;

    if (isActorHm && isLateOverride) {
      // Ground check: Late override is STRICTLY permitted on the same calendar day in PKT!
      const todayPktDate = getKarachiDateString(new Date());
      const submissionDatePkt = getKarachiDateString(date);

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
