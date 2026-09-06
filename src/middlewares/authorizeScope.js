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
export const authorizeScope = async (request, response, nextFunction) => {
  try {
    const requestingActor = request.user;
    if (!requestingActor) {
      return sendError(response, 401, 'Unauthorized: User authentication required.');
    }

    // 1. Supreme ROOT_ADMIN bypasses all geographical/institutional scope boundaries
    if (requestingActor.role === ROLES.ROOT_ADMIN) {
      return nextFunction();
    }

    // 2. Resolve Target School ID from Route Parameters, Query, or Body
    const targetSchoolId =
      request.params.schoolId ||
      request.query.schoolId ||
      request.body.schoolId ||
      null;

    // 3. Resolve Target User (if an account is being accessed or modified)
    const targetUserId = request.params.id || request.params.userId || request.body.userId || request.body.targetId;
    let targetUser = request.targetUser;

    if (!targetUser && targetUserId) {
      targetUser = await User.findById(targetUserId);
      if (targetUser) {
        request.targetUser = targetUser;
      }
    }

    // ── Check A: Target School Boundary ──────────────────────────────────────────
    if (targetSchoolId) {
      const targetSchoolString = String(targetSchoolId);

      // A1. If actor is restricted to SCHOOL scope (HM, Teacher)
      if (requestingActor.scope === SCOPES.SCHOOL || [ROLES.HM, ROLES.TEACHER].includes(requestingActor.role)) {
        if (!requestingActor.schoolId || String(requestingActor.schoolId) !== targetSchoolString) {
          await logScopeViolation(request, requestingActor, 'TARGET_SCHOOL_SCOPE_VIOLATION', {
            attemptedSchoolId: targetSchoolString,
            allowedSchoolId: String(requestingActor.schoolId || 'none'),
          });
          return sendError(
            response,
            403,
            'Access denied. You do not have jurisdictional authority over this municipal school.'
          );
        }
      }

      // A2. If actor is a Supervisor with assignedSchools list
      if (requestingActor.role === ROLES.SUPERVISOR && requestingActor.assignedSchools?.length > 0) {
        const isAssigned = requestingActor.assignedSchools.some(
          (assignedSchoolId) => String(assignedSchoolId) === targetSchoolString
        );
        if (!isAssigned) {
          await logScopeViolation(request, requestingActor, 'SUPERVISOR_UNASSIGNED_SCHOOL_VIOLATION', {
            attemptedSchoolId: targetSchoolString,
            assignedSchools: requestingActor.assignedSchools.map(String),
          });
          return sendError(
            response,
            403,
            'Access denied. This municipal school is not assigned to your supervisory roster.'
          );
        }
      }
    }

    // ── Check B: Target User Boundary ────────────────────────────────────────────
    if (targetUser) {
      // B1. If actor is restricted to SCHOOL scope (HM managing staff/students)
      if (requestingActor.scope === SCOPES.SCHOOL || requestingActor.role === ROLES.HM) {
        if (
          targetUser.schoolId &&
          requestingActor.schoolId &&
          String(targetUser.schoolId) !== String(requestingActor.schoolId)
        ) {
          await logScopeViolation(request, requestingActor, 'CROSS_SCHOOL_USER_MUTATION_VIOLATION', {
            targetUserId: targetUser._id,
            targetSchoolId: String(targetUser.schoolId),
            actorSchoolId: String(requestingActor.schoolId),
          });
          return sendError(
            response,
            403,
            'Access denied. You cannot inspect or modify personnel belonging to another school.'
          );
        }
      }

      // B2. If actor has ADMINISTRATIVE scope (ADMIN, SUPER_ADMIN), ensure target belongs to same administrative jurisdiction
      if (
        (requestingActor.scope === SCOPES.ADMINISTRATIVE || requestingActor.scope === 'TOWN') &&
        requestingActor.townId &&
        targetUser.townId
      ) {
        if (String(requestingActor.townId) !== String(targetUser.townId)) {
          await logScopeViolation(request, requestingActor, 'CROSS_ADMINISTRATIVE_MUTATION_VIOLATION', {
            targetUserId: targetUser._id,
            targetTownId: String(targetUser.townId),
            actorTownId: String(requestingActor.townId),
          });
          return sendError(
            response,
            403,
            'Access denied. Target user belongs to another administrative jurisdiction.'
          );
        }
      }
    }

    nextFunction();
  } catch (error) {
    return sendError(response, 500, 'Jurisdictional scope evaluation failed.', [{ message: error.message }]);
  }
};

/**
 * Writes an immutable security audit event whenever a scope breach is intercepted
 */
const logScopeViolation = async (request, requestingActor, violationType, metadata) => {
  try {
    await AuditLog.create({
      actorId: requestingActor._id || requestingActor.userId,
      actorRole: requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName: requestingActor.fullName || '',
      action: violationType,
      targetModel: 'ScopeGuard',
      targetId: requestingActor._id || requestingActor.userId,
      targetName: request.originalUrl,
      townId: requestingActor.townId,
      schoolId: requestingActor.schoolId || null,
      previousState: metadata,
      result: 'DENIED',
      reason: `BOLA/Scope Boundary Breach Blocked: Actor attempted unauthorized out-of-jurisdiction operation.`,
      ipAddress: request.ip || '',
      userAgent: request.headers['user-agent'] || '',
      requestId: request.headers['x-request-id'] || '',
    });
  } catch (loggingError) {
    console.error('[ScopeGuard Audit Error]', loggingError.message);
  }
};
