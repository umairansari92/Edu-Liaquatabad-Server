import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import HolidayCalendar from '../models/HolidayCalendar.js';
import WeeklyOffPattern from '../models/WeeklyOffPattern.js';
import School from '../models/School.js';
import Attendance from '../models/Attendance.js';
import AuditLog from '../models/AuditLog.js';
import cache from '../utils/cache.js';
import { getKarachiDateString } from '../utils/karachiTime.js';
import { ROLES } from '../../config/constants.js';
import { invalidatePublicStatsCache } from './publicStatsController.js';

// ═══════════════════════════════════════════════════════════════════════════════
// POST /holidays — Declare Town Holiday, Break, or School Emergency Closure
// ═══════════════════════════════════════════════════════════════════════════════
export const handleCreateHoliday = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorRole = requestingActor.role;
  const actorId = requestingActor._id || requestingActor.userId;

  const {
    title,
    reason,
    holidayType,
    startDate,
    endDate,
    scopeType = 'TOWN',
    schoolId,
    townId,
    showInBanner = true,
  } = request.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return sendError(response, 400, 'Title is required for the holiday/closure announcement.');
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    return sendError(response, 400, 'A detailed justification (minimum 10 characters) is mandatory for governance accountability.');
  }

  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return sendError(response, 400, 'startDate and endDate must be in YYYY-MM-DD format.');
  }

  if (startDate > endDate) {
    return sendError(response, 400, 'startDate cannot be after endDate.');
  }

  const todayPkt = getKarachiDateString(new Date());

  let finalScopeType = scopeType;
  let finalSchoolId = schoolId;
  let finalTownId = townId || requestingActor.townId?._id || requestingActor.townId;
  let finalHolidayType = holidayType || 'GAZETTED';

  // ── HM Scope Hard-Lock Guard ────────────────────────────────────────────────
  if (actorRole === ROLES.HM) {
    // HM is strictly hard-locked to their own school only
    finalScopeType = 'SCHOOL';
    finalSchoolId = requestingActor.schoolId?._id || requestingActor.schoolId;
    finalHolidayType = 'EMERGENCY_CLOSURE';

    // Strict backdating block for HM emergency declarations
    if (startDate < todayPkt) {
      return sendError(response, 400, 'Emergency closures can only be declared for today or future dates. Historical closures require formal administrative review.');
    }

    if (!finalSchoolId) {
      return sendError(response, 400, 'No verified school assignment found on your Head Master credentials.');
    }

    const schoolDoc = await School.findById(finalSchoolId).select('townId organizationId').lean();
    if (!schoolDoc) {
      return sendError(response, 404, 'Assigned school not found in municipal registry.');
    }
    finalTownId = schoolDoc.townId;
  } else {
    // Admin / Super Admin / Root Admin level
    const allowedAdminRoles = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN];
    if (!allowedAdminRoles.includes(actorRole)) {
      return sendError(response, 403, 'Access denied. You do not hold authority to declare holidays or emergency closures.');
    }

    if (finalScopeType === 'SCHOOL') {
      if (!finalSchoolId || !/^[0-9a-fA-F]{24}$/.test(String(finalSchoolId))) {
        return sendError(response, 400, 'A valid schoolId is required when declaring a school-specific closure.');
      }
      const schoolDoc = await School.findById(finalSchoolId).select('townId organizationId').lean();
      if (!schoolDoc) return sendError(response, 404, 'Target school not found.');
      finalTownId = schoolDoc.townId;
    }

    // ── Admin Backdating & Attendance Conflict Guard ─────────────────────────
    if (startDate < todayPkt) {
      const startObj = new Date(startDate);
      const endObj = new Date(endDate);
      endObj.setHours(23, 59, 59, 999);

      const attendanceQuery = {
        date: { $gte: startObj, $lte: endObj },
        attendanceType: 'STUDENT',
      };
      if (finalScopeType === 'SCHOOL') {
        attendanceQuery.schoolId = finalSchoolId;
      } else if (finalTownId) {
        const townSchoolIds = await School.find({ townId: finalTownId }).distinct('_id');
        attendanceQuery.schoolId = { $in: townSchoolIds };
      }

      const existingAttendance = await Attendance.findOne(attendanceQuery).select('_id date schoolId').lean();
      if (existingAttendance) {
        return sendError(
          response,
          409,
          `Cannot retroactively declare holiday for past dates (${startDate} to ${endDate}). Submitted attendance registers already exist for this period. Formal administrative reconciliation is required.`
        );
      }

      if (reason.trim().length < 15) {
        return sendError(
          response,
          400,
          'Retroactive holiday declaration requires a detailed justification (minimum 15 characters) for the permanent municipal audit trail.'
        );
      }
    }
  }

  const orgId = requestingActor.organizationId?._id || requestingActor.organizationId || requestingActor.orgId;

  const holiday = await HolidayCalendar.create({
    organizationId: orgId,
    townId: finalTownId,
    scopeType: finalScopeType,
    schoolId: finalScopeType === 'SCHOOL' ? finalSchoolId : null,
    title: title.trim(),
    reason: reason.trim(),
    holidayType: finalHolidayType,
    startDate,
    endDate,
    showInBanner: !!showInBanner,
    createdBy: actorId,
    status: 'ACTIVE',
  });

  // AuditLog Generation (Constitution Article V.6)
  await AuditLog.create({
    actorId,
    actorRole,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: 'HOLIDAY_DECLARED',
    targetModel: 'HolidayCalendar',
    targetId: holiday._id,
    targetName: holiday.title,
    schoolId: finalSchoolId || null,
    previousState: null,
    newState: {
      title: holiday.title,
      reason: holiday.reason,
      scopeType: holiday.scopeType,
      startDate: holiday.startDate,
      endDate: holiday.endDate,
      holidayType: holiday.holidayType,
    },
    result: 'SUCCESS',
    reason: `Holiday/Closure declared: ${holiday.reason}`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  // Invalidate holiday caches
  cache.delByPrefix('school:');
  cache.delByPrefix('town:');
  invalidatePublicStatsCache();

  return sendSuccess(response, 201, 'Holiday/Closure declared successfully.', holiday);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /holidays — List active holidays & vacations
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetHolidays = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { status = 'ACTIVE', year } = request.query;

  const filter = {};
  if (status) filter.status = status;

  if (year && /^\d{4}$/.test(year)) {
    filter.startDate = { $regex: `^${year}` };
  }

  // Scope to actor's town or school
  const actorSchoolId = requestingActor.schoolId?._id || requestingActor.schoolId;
  const actorTownId = requestingActor.townId?._id || requestingActor.townId;

  if ([ROLES.HM, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT].includes(requestingActor.role)) {
    filter.$or = [
      { scopeType: 'TOWN', ...(actorTownId ? { townId: actorTownId } : {}) },
      ...(actorSchoolId ? [{ scopeType: 'SCHOOL', schoolId: actorSchoolId }] : []),
    ];
  } else if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = Array.isArray(requestingActor.assignedSchools)
      ? requestingActor.assignedSchools.map((assignedSchool) => assignedSchool?._id || assignedSchool)
      : [];
    filter.$or = [
      { scopeType: 'TOWN', ...(actorTownId ? { townId: actorTownId } : {}) },
      { scopeType: 'SCHOOL', schoolId: { $in: assignedSchoolIds } },
    ];
  } else if (requestingActor.role === ROLES.ADMIN && actorTownId) {
    // Town Admin: lock to their assigned municipal town
    filter.townId = actorTownId;
  }

  const holidays = await HolidayCalendar.find(filter)
    .populate('schoolId', 'name code')
    .populate('createdBy', 'fullName role')
    .sort({ startDate: -1 })
    .lean();

  return sendSuccess(response, 200, 'Holidays retrieved successfully.', {
    total: holidays.length,
    holidays,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /holidays/:id/cancel — Cancel an active holiday / emergency closure
// ═══════════════════════════════════════════════════════════════════════════════
export const handleCancelHoliday = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorRole = requestingActor.role;
  const actorId = requestingActor._id || requestingActor.userId;
  const { id } = request.params;
  const { cancelReason } = request.body;

  if (!cancelReason || typeof cancelReason !== 'string' || cancelReason.trim().length < 5) {
    return sendError(response, 400, 'A valid reason (minimum 5 characters) is required to cancel an announced holiday.');
  }

  const holiday = await HolidayCalendar.findById(id);
  if (!holiday) {
    return sendError(response, 404, 'Holiday record not found.');
  }

  if (holiday.status === 'CANCELLED') {
    return sendError(response, 400, 'This holiday announcement is already cancelled.');
  }

  // Authority check
  if (actorRole === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (holiday.scopeType !== 'SCHOOL' || String(holiday.schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You can only cancel emergency closures declared for your own school.');
    }
  } else {
    const allowedAdminRoles = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN];
    if (!allowedAdminRoles.includes(actorRole)) {
      return sendError(response, 403, 'Access denied. Only municipal administrators can cancel town-wide holidays.');
    }
  }

  const previousState = { status: holiday.status };
  holiday.status = 'CANCELLED';
  await holiday.save();

  // AuditLog Generation
  await AuditLog.create({
    actorId,
    actorRole,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: 'HOLIDAY_CANCELLED',
    targetModel: 'HolidayCalendar',
    targetId: holiday._id,
    targetName: holiday.title,
    schoolId: holiday.schoolId || null,
    previousState,
    newState: { status: 'CANCELLED', cancelReason: cancelReason.trim() },
    result: 'SUCCESS',
    reason: cancelReason.trim(),
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  cache.delByPrefix('school:');
  cache.delByPrefix('town:');
  invalidatePublicStatsCache();

  return sendSuccess(response, 200, 'Holiday announcement cancelled successfully.', holiday);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /weekly-off — Configure Recurring Weekly Off Days (Sunday / Saturday)
// ═══════════════════════════════════════════════════════════════════════════════
export const handleCreateWeeklyOffPattern = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const actorRole = requestingActor.role;
  const actorId = requestingActor._id || requestingActor.userId;

  // Only ROOT_ADMIN, SUPER_ADMIN, ADMIN can set weekly off patterns
  const allowedRoles = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN];
  if (!allowedRoles.includes(actorRole)) {
    return sendError(response, 403, 'Access denied. Only municipal leadership can configure weekly off patterns.');
  }

  const {
    townId,
    scopeType = 'TOWN',
    schoolId,
    offDays = [0], // 0 = Sunday
    effectiveFrom,
    effectiveTo = null,
    reason,
  } = request.body;

  if (!Array.isArray(offDays) || offDays.length === 0) {
    return sendError(response, 400, 'offDays must be a non-empty array of weekday numbers (0=Sun, 6=Sat).');
  }

  for (const day of offDays) {
    if (typeof day !== 'number' || day < 0 || day > 6) {
      return sendError(response, 400, 'Invalid weekday number. Must be between 0 (Sunday) and 6 (Saturday).');
    }
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    return sendError(response, 400, 'A detailed justification (minimum 10 characters) is required.');
  }

  const finalTownId = townId || requestingActor.townId?._id || requestingActor.townId;
  if (!finalTownId) {
    return sendError(response, 400, 'townId is required.');
  }

  let finalSchoolId = null;
  if (scopeType === 'SCHOOL') {
    if (!schoolId || !/^[0-9a-fA-F]{24}$/.test(String(schoolId))) {
      return sendError(response, 400, 'A valid schoolId is required when configuring a school-scoped weekly off pattern.');
    }
    const schoolDoc = await School.findById(schoolId).select('townId organizationId').lean();
    if (!schoolDoc) {
      return sendError(response, 404, 'Target school not found in municipal registry.');
    }
    finalSchoolId = schoolDoc._id;
  }

  const orgId = requestingActor.organizationId?._id || requestingActor.organizationId || requestingActor.orgId;

  // Deactivate any currently active weekly off pattern for this exact scope
  const deactivationFilter = {
    townId: finalTownId,
    scopeType,
    status: 'ACTIVE',
  };
  if (scopeType === 'SCHOOL') {
    deactivationFilter.schoolId = finalSchoolId;
  }

  await WeeklyOffPattern.updateMany(
    deactivationFilter,
    { $set: { status: 'CANCELLED', effectiveTo: new Date() } }
  );

  const pattern = await WeeklyOffPattern.create({
    organizationId: orgId,
    townId: finalTownId,
    scopeType,
    schoolId: scopeType === 'SCHOOL' ? finalSchoolId : null,
    offDays,
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
    reason: reason.trim(),
    createdBy: actorId,
    status: 'ACTIVE',
  });

  // AuditLog Generation
  await AuditLog.create({
    actorId,
    actorRole,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: 'WEEKLY_OFF_PATTERN_CONFIGURED',
    targetModel: 'WeeklyOffPattern',
    targetId: pattern._id,
    targetName: `Weekly Off: ${offDays.join(', ')}`,
    schoolId: pattern.schoolId || null,
    previousState: null,
    newState: {
      scopeType: pattern.scopeType,
      offDays: pattern.offDays,
      reason: pattern.reason,
    },
    result: 'SUCCESS',
    reason: pattern.reason,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  cache.delByPrefix('school:');
  cache.delByPrefix('town:');
  invalidatePublicStatsCache();

  return sendSuccess(response, 201, 'Weekly off pattern configured successfully.', pattern);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /weekly-off — List active weekly off patterns (Scoped to Actor's Town/School)
// ═══════════════════════════════════════════════════════════════════════════════
export const handleGetWeeklyOffPatterns = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { status = 'ACTIVE' } = request.query;

  const filter = {};
  if (status) filter.status = status;

  const actorSchoolId = requestingActor.schoolId?._id || requestingActor.schoolId;
  const actorTownId = requestingActor.townId?._id || requestingActor.townId;

  // Enforce 100% Data Isolation: Zero Cross-Tenant / Cross-School Data Leakage
  if ([ROLES.HM, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT].includes(requestingActor.role)) {
    filter.$or = [
      { scopeType: 'TOWN', ...(actorTownId ? { townId: actorTownId } : {}) },
      ...(actorSchoolId ? [{ scopeType: 'SCHOOL', schoolId: actorSchoolId }] : []),
    ];
  } else if (requestingActor.role === ROLES.SUPERVISOR) {
    const assignedSchoolIds = Array.isArray(requestingActor.assignedSchools)
      ? requestingActor.assignedSchools.map((assignedSchool) => assignedSchool?._id || assignedSchool)
      : [];
    filter.$or = [
      { scopeType: 'TOWN', ...(actorTownId ? { townId: actorTownId } : {}) },
      { scopeType: 'SCHOOL', schoolId: { $in: assignedSchoolIds } },
    ];
  } else if (requestingActor.role === ROLES.ADMIN && actorTownId) {
    // Town Admin: restrict to their verified town
    filter.townId = actorTownId;
  }

  const patterns = await WeeklyOffPattern.find(filter)
    .populate('schoolId', 'name code')
    .populate('createdBy', 'fullName role')
    .sort({ createdAt: -1 })
    .lean();

  return sendSuccess(response, 200, 'Weekly off patterns retrieved.', {
    total: patterns.length,
    patterns,
  });
});
