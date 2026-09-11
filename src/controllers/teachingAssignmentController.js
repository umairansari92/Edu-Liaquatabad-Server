import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import User from '../models/User.js';
import TeacherProfile from '../models/TeacherProfile.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';

/**
 * Validates whether the requesting actor is authorized to manage assignments for a school.
 */
const canManageSchoolAssignments = (actor, schoolId) => {
  if (!actor || !actor.role) return false;
  if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(actor.role)) return true;

  if (actor.role === ROLES.SUPERVISOR) {
    const assigned = (actor.assignedSchools || []).map((s) => String(s._id || s));
    return assigned.includes(String(schoolId));
  }

  if (actor.role === ROLES.HM) {
    return actor.schoolId && String(actor.schoolId._id || actor.schoolId) === String(schoolId);
  }

  return false;
};

/**
 * GET /api/v1/assignments/teacher/:teacherId
 * Retrieves both current ACTIVE and historical assignments for a teacher.
 * Historical records remain completely intact and immutable.
 */
export const handleGetTeacherAssignments = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { teacherId } = request.params;

  const targetTeacher = await User.findById(teacherId).select('fullName email schoolId role').lean();
  if (!targetTeacher) {
    return sendError(response, 404, 'Teacher not found.');
  }

  // Authorization: Self, HM of teacher's school, Supervisor, Admin, Super Admin
  const isSelf = String(actor._id) === String(teacherId);
  const isAuthorizedManager = targetTeacher.schoolId && canManageSchoolAssignments(actor, targetTeacher.schoolId);

  if (!isSelf && !isAuthorizedManager) {
    return sendError(response, 403, 'Access denied. You cannot view teaching assignments for this faculty member.');
  }

  const assignments = await TeachingAssignment.find({ teacherId })
    .populate('schoolId', 'name code')
    .populate('classId', 'name numericGrade')
    .populate('sectionId', 'name')
    .populate('subjectId', 'name code')
    .populate('assignedBy', 'fullName designation')
    .sort({ status: 1, createdAt: -1 })
    .lean();

  const activeAssignments = assignments.filter((a) => a.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE);
  const historicalAssignments = assignments.filter((a) => a.status !== TEACHING_ASSIGNMENT_STATUS.ACTIVE);

  return sendSuccess(response, 200, 'Teaching assignments retrieved successfully.', {
    teacher: {
      id: targetTeacher._id,
      name: targetTeacher.fullName,
      email: targetTeacher.email,
    },
    activeCount: activeAssignments.length,
    historyCount: historicalAssignments.length,
    activeAssignments,
    historicalAssignments,
  });
});

/**
 * GET /api/v1/assignments/my
 * Current authenticated teacher retrieves own assignments
 */
export const handleGetMyAssignments = asyncHandler(async (request, response) => {
  const teacherId = request.user._id;

  const assignments = await TeachingAssignment.find({ teacherId })
    .populate('schoolId', 'name code')
    .populate('classId', 'name numericGrade')
    .populate('sectionId', 'name')
    .populate('subjectId', 'name code')
    .sort({ status: 1, createdAt: -1 })
    .lean();

  const activeAssignments = assignments.filter((a) => a.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE);
  const historicalAssignments = assignments.filter((a) => a.status !== TEACHING_ASSIGNMENT_STATUS.ACTIVE);

  return sendSuccess(response, 200, 'Your teaching assignments retrieved.', {
    activeAssignments,
    historicalAssignments,
  });
});

/**
 * POST /api/v1/assignments
 * Creates a new subject assignment for a teacher.
 * Enforces:
 *   - Teacher exists and is a TEACHING staff member (non-teachers strictly rejected)
 *   - Approver has jurisdiction over the target school
 *   - No duplicate active assignment exists (overlap prevention)
 */
export const handleAddTeachingAssignment = asyncHandler(async (request, response) => {
  const actor = request.user;
  const {
    teacherId,
    schoolId,
    classId,
    sectionId,
    subjectId,
    academicSession,
    remarks = '',
  } = request.body;

  if (!teacherId || !schoolId || !classId || !sectionId || !subjectId || !academicSession) {
    return sendError(response, 400, 'All fields (teacherId, schoolId, classId, sectionId, subjectId, academicSession) are required.');
  }

  // School jurisdiction check
  if (!canManageSchoolAssignments(actor, schoolId)) {
    return sendError(response, 403, 'Access denied. You cannot assign teaching duties outside your authorized school/jurisdiction.');
  }

  // Verify teacher exists
  const targetUser = await User.findById(teacherId);
  if (!targetUser) {
    return sendError(response, 404, 'Teacher not found.');
  }

  // STRICT INVARIANT: Non-teaching staff (Peons, Clerks, Accountants) cannot receive teaching assignments
  const profile = await TeacherProfile.findOne({ userId: teacherId });
  if (profile && profile.isTeachingStaff === false) {
    return sendError(response, 400, 'Non-teaching staff (e.g. Clerks, Peons) cannot be assigned teaching duties.');
  }

  // Cross-validate school structure integrity: class, section, and subject must belong to schoolId
  const [targetClass, targetSection, targetSubject] = await Promise.all([
    Class.findById(classId).lean(),
    Section.findById(sectionId).lean(),
    Subject.findById(subjectId).lean(),
  ]);

  if (!targetClass || String(targetClass.schoolId) !== String(schoolId)) {
    return sendError(response, 400, 'Integrity violation: The specified class does not belong to this school.');
  }
  if (!targetSection || String(targetSection.schoolId) !== String(schoolId) || String(targetSection.classId) !== String(classId)) {
    return sendError(response, 400, 'Integrity violation: The specified section does not belong to this class or school.');
  }
  if (!targetSubject || String(targetSubject.schoolId) !== String(schoolId)) {
    return sendError(response, 400, 'Integrity violation: The specified subject does not belong to this school.');
  }

  // Overlap and Duplicate Check: Ensure no active assignment already exists for this exact combination
  const activeConflict = await TeachingAssignment.findOne({
    teacherId,
    classId,
    sectionId,
    subjectId,
    academicSession: academicSession.trim(),
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });

  if (activeConflict) {
    return sendError(
      response,
      409,
      'An active teaching assignment already exists for this teacher in the same class, section, subject, and academic session.'
    );
  }

  // Create immutable assignment record
  const newAssignment = await TeachingAssignment.create({
    teacherId,
    schoolId,
    classId,
    sectionId,
    subjectId,
    academicSession: academicSession.trim(),
    effectiveFrom: new Date(),
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    assignedBy: actor._id,
    remarks: remarks.trim(),
  });

  // Audit
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation,
    actorName: actor.fullName,
    action: 'TEACHING_ASSIGNMENT_CREATED',
    targetModel: 'TeachingAssignment',
    targetId: newAssignment._id,
    targetName: targetUser.fullName,
    schoolId,
    newState: {
      teacherId,
      classId,
      sectionId,
      subjectId,
      academicSession,
      status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 201, 'Teaching assignment created successfully.', newAssignment);
});

/**
 * PATCH /api/v1/assignments/:id/end
 * Concludes an active teaching assignment without deleting it, preserving historical records.
 */
export const handleEndTeachingAssignment = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;
  const { reason = 'Assignment completed or reassigned' } = request.body;

  const assignment = await TeachingAssignment.findById(id);
  if (!assignment) {
    return sendError(response, 404, 'Teaching assignment not found.');
  }

  if (assignment.status !== TEACHING_ASSIGNMENT_STATUS.ACTIVE) {
    return sendError(response, 400, `Assignment is not active (current status: ${assignment.status}).`);
  }

  // School jurisdiction check
  if (!canManageSchoolAssignments(actor, assignment.schoolId)) {
    return sendError(response, 403, 'Access denied. You cannot modify assignments for this school.');
  }

  // Transition to COMPLETED and set effectiveTo
  assignment.status = TEACHING_ASSIGNMENT_STATUS.COMPLETED;
  assignment.effectiveTo = new Date();
  assignment.remarks = reason.trim() ? `${assignment.remarks} [Ended: ${reason.trim()}]` : assignment.remarks;

  await assignment.save();

  // Audit
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation,
    actorName: actor.fullName,
    action: 'TEACHING_ASSIGNMENT_ENDED',
    targetModel: 'TeachingAssignment',
    targetId: assignment._id,
    schoolId: assignment.schoolId,
    newState: {
      status: TEACHING_ASSIGNMENT_STATUS.COMPLETED,
      effectiveTo: assignment.effectiveTo,
      reason,
    },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Teaching assignment ended and archived into history successfully.', assignment);
});
