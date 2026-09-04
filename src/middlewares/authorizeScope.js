import { sendError } from '../utils/apiResponse.js';
import { ROLES, SCOPES } from '../../config/constants.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Server-Enforced Scope & Jurisdiction Guard (Anti-BOLA / IDOR Shield)
 * Ensures that actors can NEVER operate outside their institutional boundaries:
 * - ROOT_ADMIN: Supreme unrestricted scope across all entities
 * - TOWN scope (SUPER_ADMIN, ADMIN, SUPERVISOR): Restricted to assigned townId / assignedSchools
 * - SCHOOL scope (HM, TEACHER): Strictly restricted to their own schoolId
 * - CLASS_SECTION scope (TEACHER): Strictly restricted to assigned classes/sections
 * - SELF_CHILD scope (STUDENT, PARENT): Strictly restricted to self / linked children
 */
export const authorizeScope = async (req, res, next) => {
  try {
    const actor = req.user;
    if (!actor) {
      return sendError(res, 401, 'Unauthorized: User authentication required.');
    }

    // 1. Supreme ROOT_ADMIN bypasses all geographical/institutional scope boundaries
    if (actor.role === ROLES.ROOT_ADMIN) {
      return next();
    }

    // 2. Resolve Target School ID from Route Parameters, Query, or Body
    const targetSchoolId =
      req.params.schoolId ||
      req.query.schoolId ||
      req.body.schoolId ||
      null;

    // 3. Resolve Target User (if an account is being accessed or modified)
    const targetUserId = req.params.id || req.params.userId || req.body.userId || req.body.targetId;
    let targetUser = req.targetUser;

    if (!targetUser && targetUserId) {
      targetUser = await User.findById(targetUserId);
      if (targetUser) {
        req.targetUser = targetUser;
      }
    }

    // ── Check A: Target School Boundary ──────────────────────────────────────────
    if (targetSchoolId) {
      const targetSchoolStr = String(targetSchoolId);

      // A1. If actor is restricted to SCHOOL scope (HM, Teacher)
      if (actor.scope === SCOPES.SCHOOL || [ROLES.HM, ROLES.TEACHER].includes(actor.role)) {
        if (!actor.schoolId || String(actor.schoolId) !== targetSchoolStr) {
          await logScopeViolation(req, actor, 'TARGET_SCHOOL_SCOPE_VIOLATION', {
            attemptedSchoolId: targetSchoolStr,
            allowedSchoolId: String(actor.schoolId || 'none'),
          });
          return sendError(
            res,
            403,
            'Access denied. You do not have jurisdictional authority over this municipal school.'
          );
        }
      }

      // A2. If actor is a Supervisor with assignedSchools list
      if (actor.role === ROLES.SUPERVISOR && actor.assignedSchools?.length > 0) {
        const isAssigned = actor.assignedSchools.some((s) => String(s) === targetSchoolStr);
        if (!isAssigned) {
          await logScopeViolation(req, actor, 'SUPERVISOR_UNASSIGNED_SCHOOL_VIOLATION', {
            attemptedSchoolId: targetSchoolStr,
            assignedSchools: actor.assignedSchools.map(String),
          });
          return sendError(
            res,
            403,
            'Access denied. This municipal school is not assigned to your supervisory roster.'
          );
        }
      }
    }

    // ── Check B: Target User Boundary ────────────────────────────────────────────
    if (targetUser) {
      // B1. If actor is restricted to SCHOOL scope (HM managing staff/students)
      if (actor.scope === SCOPES.SCHOOL || actor.role === ROLES.HM) {
        if (
          targetUser.schoolId &&
          actor.schoolId &&
          String(targetUser.schoolId) !== String(actor.schoolId)
        ) {
          await logScopeViolation(req, actor, 'CROSS_SCHOOL_USER_MUTATION_VIOLATION', {
            targetUserId: targetUser._id,
            targetSchoolId: String(targetUser.schoolId),
            actorSchoolId: String(actor.schoolId),
          });
          return sendError(
            res,
            403,
            'Access denied. You cannot inspect or modify personnel belonging to another school.'
          );
        }
      }

      // B2. If actor has TOWN scope (ADMIN, SUPER_ADMIN), ensure target belongs to same town
      if (actor.scope === SCOPES.TOWN && actor.townId && targetUser.townId) {
        if (String(actor.townId) !== String(targetUser.townId)) {
          await logScopeViolation(req, actor, 'CROSS_TOWN_MUTATION_VIOLATION', {
            targetUserId: targetUser._id,
            targetTownId: String(targetUser.townId),
            actorTownId: String(actor.townId),
          });
          return sendError(
            res,
            403,
            'Access denied. Target user belongs to another administrative town directorate.'
          );
        }
      }
    }

    next();
  } catch (error) {
    return sendError(res, 500, 'Jurisdictional scope evaluation failed.', [{ message: error.message }]);
  }
};

/**
 * Writes an immutable security audit event whenever a scope breach is intercepted
 */
const logScopeViolation = async (req, actor, violationType, metadata) => {
  try {
    await AuditLog.create({
      actorId: actor._id || actor.userId,
      actorRole: actor.role,
      actorDesignation: actor.designation || '',
      actorName: actor.fullName || '',
      action: violationType,
      targetModel: 'ScopeGuard',
      targetId: actor._id || actor.userId,
      targetName: req.originalUrl,
      townId: actor.townId,
      schoolId: actor.schoolId || null,
      previousState: metadata,
      result: 'DENIED',
      reason: `BOLA/Scope Boundary Breach Blocked: Actor attempted unauthorized out-of-jurisdiction operation.`,
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      requestId: req.headers['x-request-id'] || '',
    });
  } catch (err) {
    console.error('[ScopeGuard Audit Error]', err.message);
  }
};
