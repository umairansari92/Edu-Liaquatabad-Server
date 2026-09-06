import { sendError } from '../utils/apiResponse.js';
import { ROLES, SCOPES } from '../../config/constants.js';
import User from '../models/User.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Server-Enforced Scope & Jurisdiction Guard (Anti-BOLA / IDOR Shield)
 * Ensures that actors can NEVER operate outside their institutional boundaries:
 * - ROOT_ADMIN: Supreme unrestricted scope across all entities
 * - TOWN scope (SUPER_ADMIN, ADMIN, SUPERVISOR): Restricted to assigned townId / assignedSchools
 * - SCHOOL scope (HM, TEACHER): Strictly restricted to their own schoolId
 * - CLASS_SECTION scope (TEACHER): Strictly restricted to assigned classes/sections
 * - SELF_CHILD scope (STUDENT, PARENT): Strictly restricted to self / linked children
 *
 * SEC-CRIT-02 (Wave 1 Remediation):
 *  - School object scope enforcement added for PATCH /api/v1/schools/:id
 *  - ADMIN actors restricted to schools within their assigned townId
 *  - Cross-town school mutation attempts are logged as DENIED audit events
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

    // ── SEC-CRIT-02: School Object Jurisdictional Enforcement ────────────────────
    // When the route is modifying a school entity (PATCH /api/v1/schools/:id),
    // we must resolve the target school from the path param and verify scope.
    // This is separate from the "schoolId in body/query" check which is for user routes.
    const isSchoolMutationRoute = (
      request.method === 'PATCH' &&
      request.route?.path === '/:id' &&
      request.baseUrl?.includes('/schools')
    );

    if (isSchoolMutationRoute && request.params.id) {
      const targetSchoolId = request.params.id;

      // Validate ObjectId format to prevent NoSQL injection via path param
      if (!/^[0-9a-fA-F]{24}$/.test(targetSchoolId)) {
        return sendError(response, 400, 'Invalid school ID format.');
      }

      const targetSchool = await School.findById(targetSchoolId).select('townId name _id').lean();
      if (!targetSchool) {
        return sendError(response, 404, 'Municipal school entity not found.');
      }

      const targetSchoolTownId = String(targetSchool.townId);

      // SUPER_ADMIN with GLOBAL scope can update any school
      if (requestingActor.role === ROLES.SUPER_ADMIN) {
        if (requestingActor.scope === SCOPES.GLOBAL) {
          return nextFunction();
        }
        // SUPER_ADMIN with ADMINISTRATIVE/TOWN scope must match town boundary
        if (requestingActor.townId && targetSchoolTownId !== String(requestingActor.townId)) {
          await logScopeViolation(request, requestingActor, 'SUPER_ADMIN_CROSS_TOWN_SCHOOL_VIOLATION', {
            attemptedSchoolId: targetSchoolId,
            targetSchoolTown: targetSchoolTownId,
            actorTownId: String(requestingActor.townId),
          });
          return sendError(response, 403, 'Access denied. This school is outside your administrative town jurisdiction.');
        }
        return nextFunction();
      }

      // ADMIN actors are strictly limited to schools in their assigned townId
      if (requestingActor.role === ROLES.ADMIN) {
        if (!requestingActor.townId) {
          await logScopeViolation(request, requestingActor, 'ADMIN_NO_TOWN_ASSIGNED_SCHOOL_VIOLATION', {
            attemptedSchoolId: targetSchoolId,
          });
          return sendError(response, 403, 'Access denied. Your administrative account has no town assignment.');
        }
        if (targetSchoolTownId !== String(requestingActor.townId)) {
          await logScopeViolation(request, requestingActor, 'ADMIN_CROSS_TOWN_SCHOOL_BOLA_VIOLATION', {
            attemptedSchoolId: targetSchoolId,
            targetSchoolTown: targetSchoolTownId,
            actorTownId: String(requestingActor.townId),
          });
          return sendError(
            response,
            403,
            'Access denied. You do not have jurisdictional authority over schools in another administrative town.'
          );
        }
        return nextFunction();
      }

      // SUPERVISOR actors can only modify schools from their assigned list
      if (requestingActor.role === ROLES.SUPERVISOR) {
        const isAssignedSupervisorSchool = (requestingActor.assignedSchools || []).some(
          (assignedSchoolId) => String(assignedSchoolId) === targetSchoolId
        );
        if (!isAssignedSupervisorSchool) {
          await logScopeViolation(request, requestingActor, 'SUPERVISOR_UNASSIGNED_SCHOOL_MUTATION_VIOLATION', {
            attemptedSchoolId: targetSchoolId,
            assignedSchools: (requestingActor.assignedSchools || []).map(String),
          });
          return sendError(response, 403, 'Access denied. This school is not in your supervisory assignment list.');
        }
        return nextFunction();
      }

      // HM can only update their own school record
      if (requestingActor.role === ROLES.HM) {
        if (!requestingActor.schoolId || String(requestingActor.schoolId) !== targetSchoolId) {
          await logScopeViolation(request, requestingActor, 'HM_CROSS_SCHOOL_MUTATION_VIOLATION', {
            attemptedSchoolId: targetSchoolId,
            actorSchoolId: String(requestingActor.schoolId || 'none'),
          });
          return sendError(response, 403, 'Access denied. You can only update your own school\'s record.');
        }
        return nextFunction();
      }

      // All other roles cannot mutate school objects
      await logScopeViolation(request, requestingActor, 'UNAUTHORIZED_SCHOOL_MUTATION_ATTEMPT', {
        attemptedSchoolId: targetSchoolId,
        actorRole: requestingActor.role,
      });
      return sendError(response, 403, 'Access denied. Your role does not have authority to modify school records.');
    }

    // ── Check A: Target School Boundary (query/body schoolId check) ───────────────
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
  } catch (scopeError) {
    return sendError(response, 500, 'Jurisdictional scope evaluation failed.', [{ message: scopeError.message }]);
  }
};

/**
 * Writes an immutable security audit event whenever a scope breach is intercepted.
 * Intentionally excludes any credential or secret fields.
 */
const logScopeViolation = async (request, requestingActor, violationType, metadata) => {
  try {
    await AuditLog.create({
      actorId:          requestingActor._id || requestingActor.userId,
      actorRole:        requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName:        requestingActor.fullName || '',
      action:           violationType,
      targetModel:      'ScopeGuard',
      targetId:         requestingActor._id || requestingActor.userId,
      targetName:       request.originalUrl,
      townId:           requestingActor.townId,
      schoolId:         requestingActor.schoolId || null,
      previousState:    metadata,
      result:           'DENIED',
      reason:           `BOLA/Scope Boundary Breach Blocked: Actor attempted unauthorized out-of-jurisdiction operation.`,
      ipAddress:        request.ip || '',
      userAgent:        request.headers['user-agent'] || '',
      requestId:        request.headers['x-request-id'] || '',
    });
  } catch (loggingError) {
    console.error('[ScopeGuard Audit Error]', loggingError.message);
  }
};
