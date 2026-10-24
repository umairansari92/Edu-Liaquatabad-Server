import asyncHandler from 'express-async-handler';
import PDFDocument from 'pdfkit';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import TeacherProfile from '../models/TeacherProfile.js';
import StudentProfile from '../models/StudentProfile.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import ProfileAccessRequest from '../models/ProfileAccessRequest.js';
import { ROLES, SCOPES, USER_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';
import { maskCnic, maskBankAccount } from './approvalController.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';
import { isTargetProtectedFromActor } from '../middlewares/authorizeHierarchy.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../utils/cloudinaryUploader.js';

/**
 * Access Control Evaluator for Staff Profile
 * Evaluates actor's institutional role and administrative scope.
 */
export const evaluateProfileAccess = (actor, targetUser, targetProfile) => {
  if (!actor || !actor.role) return { canView: false, canViewSensitive: false };

  // Parent isolation: Parent accounts do not possess or view staff dossiers
  if (actor.role === ROLES.PARENT) {
    return { canView: false, canViewSensitive: false };
  }

  const isSelf = String(actor._id) === String(targetUser._id);
  if (isSelf) {
    return { canView: true, canViewSensitive: true, isSelf: true };
  }

  // Root Admin & Super Admin have global or town-scoped full authority
  if (actor.role === ROLES.ROOT_ADMIN) {
    return { canView: true, canViewSensitive: true, isPrivilegedAdmin: true };
  }
  if (actor.role === ROLES.SUPER_ADMIN) {
    const isSameTown = actor.townId && targetUser.townId && String(actor.townId) === String(targetUser.townId);
    if (actor.scope === SCOPES.GLOBAL || isSameTown) {
      return { canView: true, canViewSensitive: true, isPrivilegedAdmin: true };
    }
  }

  // Admin: Town scope
  if (actor.role === ROLES.ADMIN) {
    const isSameTown = actor.townId && targetUser.townId && String(actor.townId) === String(targetUser.townId);
    if (isSameTown) {
      return { canView: true, canViewSensitive: true, isPrivilegedAdmin: true };
    }
  }

  // Supervisor: Assigned schools
  const targetSchoolId = targetUser.schoolId?._id || targetUser.schoolId || targetUser.claimedSchoolId || targetProfile?.currentSchoolId || targetProfile?.claimedSchoolId;
  if (actor.role === ROLES.SUPERVISOR) {
    if (targetSchoolId) {
      const assigned = (actor.assignedSchools || []).map((assignedSchool) => String(assignedSchool._id || assignedSchool));
      if (assigned.includes(String(targetSchoolId))) {
        return { canView: true, canViewSensitive: false }; // Masked sensitive
      }
    }
  }

  // HM: Same school only
  if (actor.role === ROLES.HM) {
    const actorSchoolId = String(actor.schoolId?._id || actor.schoolId || '');
    if (actorSchoolId && targetSchoolId && actorSchoolId === String(targetSchoolId)) {
      return { canView: true, canViewSensitive: true };
    }
  }

  // Unauthorized (other teachers, students, parents)
  return { canView: false, canViewSensitive: false };
};

/**
 * GET /api/v1/staff/:id/profile
 * Retrieves detailed staff profile combining ABAC institutional security + Staff Privacy Settings
 */
export const handleGetStaffProfile = asyncHandler(async (request, response) => {
  const actor = request.user;

  // Backend Parent Isolation: Reject parent requests to staff profile endpoints
  if (actor.role === ROLES.PARENT) {
    return sendError(
      response,
      403,
      'Access denied: Parent accounts do not possess staff service records. Please access the Parent Portal to view your linked student records.'
    );
  }

  const targetUserId = request.params.id === 'me' ? actor._id : request.params.id;

  const targetUser = await User.findById(targetUserId)
    .populate('schoolId', 'name code address district')
    .populate('claimedSchoolId', 'name code address district')
    .lean();

  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  // Identity Protection Policy: Return 404 if target is protected/invisible to actor
  if (isTargetProtectedFromActor(actor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId })
    .populate('currentSchoolId', 'name code address district')
    .populate('transferHistory.fromSchoolId', 'name code address district')
    .populate('transferHistory.toSchoolId', 'name code address district')
    .lean();

  const access = evaluateProfileAccess(actor, targetUser, targetProfile);
  if (!access.canView) {
    return sendError(response, 403, 'Access denied. You do not have authorization to view this staff profile.');
  }

  const isSelf = String(actor._id) === String(targetUser._id);
  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actor.role);
  const privacy = targetProfile?.privacySettings?.fieldVisibility || {
    profilePhoto: 'PUBLIC',
    designation: 'PUBLIC',
    qualification: 'PUBLIC',
    phoneNumber: 'SCHOOL',
    email: 'SCHOOL',
    cnic: 'AUTHORIZED_ROLE',
    bankDetails: 'AUTHORIZED_ROLE',
    residentialAddress: 'AUTHORIZED_ROLE',
  };

  // Check if an unexpired active approval exists for this requester
  let activeApproval = null;
  if (!isSelf && !isPrivilegedAdmin) {
    activeApproval = await ProfileAccessRequest.findOne({
      requesterId: actor._id,
      targetStaffUserId: targetUser._id,
      status: 'APPROVED',
      expiresAt: { $gt: new Date() },
    }).lean();
  }

  // Fetch teaching assignments if teaching staff
  let assignments = [];
  if (targetProfile?.isTeachingStaff) {
    assignments = await TeachingAssignment.find({ teacherId: targetUserId })
      .populate('schoolId', 'name code')
      .populate('classId', 'name numericGrade')
      .populate('sectionId', 'name')
      .populate('subjectId', 'name code')
      .sort({ status: 1, createdAt: -1 })
      .lean();
  }

  // Fetch StudentProfile if student role
  let studentProfile = null;
  if (targetUser.role === ROLES.STUDENT) {
    studentProfile = await StudentProfile.findOne({ userId: targetUserId })
      .populate('schoolId', 'name code address district')
      .populate('classId', 'name numericGrade')
      .populate('sectionId', 'name')
      .lean();
  }

  // ─── Absolute Privacy Policy: User's explicit PRIVATE settings are respected even by ROOT_ADMIN ───
  const showPhone = isSelf || (privacy.phoneNumber !== 'PRIVATE' && (
    isPrivilegedAdmin ||
    privacy.phoneNumber === 'PUBLIC' ||
    (privacy.phoneNumber === 'SCHOOL' && access.canView) ||
    (privacy.phoneNumber === 'AUTHORIZED_ROLE' && access.canViewSensitive)
  ));
  const showEmail = isSelf || (privacy.email !== 'PRIVATE' && (
    isPrivilegedAdmin ||
    privacy.email === 'PUBLIC' ||
    (privacy.email === 'SCHOOL' && access.canView) ||
    (privacy.email === 'AUTHORIZED_ROLE' && access.canViewSensitive)
  ));
  const showPhoto = isSelf || privacy.profilePhoto !== 'PRIVATE';
  const showQual = isSelf || privacy.qualification !== 'PRIVATE';

  // Sensitive fields: If set to PRIVATE, ONLY self can view unmasked. Even ROOT_ADMIN receives masked values.
  const canRevealCnic = isSelf || (privacy.cnic !== 'PRIVATE' && access.canViewSensitive);
  const canRevealBank = isSelf || (privacy.bankDetails !== 'PRIVATE' && access.canViewSensitive);
  const canRevealAddress = isSelf || (privacy.residentialAddress !== 'PRIVATE' && access.canViewSensitive);

  const responseData = {
    user: {
      id: targetUser._id,
      fullName: targetUser.fullName,
      email: showEmail ? targetUser.email : 'Protected (Staff Privacy)',
      phoneNumber: showPhone ? targetUser.phoneNumber : 'Protected (Staff Privacy)',
      designation: targetUser.designation,
      baseRole: targetUser.baseRole,
      role: targetUser.role,
      status: targetUser.status,
      school: targetUser.schoolId || targetUser.claimedSchoolId,
      isClaimedOnly: !targetUser.schoolId && !!targetUser.claimedSchoolId,
      assignedSchools: targetUser.assignedSchools || [],
      townId: targetUser.townId || null,
      createdAt: targetUser.createdAt,
    },
    profile: targetProfile
      ? {
          fatherName: targetProfile.fatherName,
          dateOfBirth: targetProfile.dateOfBirth,
          employeeId: targetProfile.employeeId,
          appointmentDate: targetProfile.appointmentDate,
          qualification: showQual ? targetProfile.qualification : 'Protected',
          residentialAddress: canRevealAddress ? (targetProfile.residentialAddress || '') : 'Protected (Staff Privacy)',
          joiningDate: targetProfile.joiningDate,
          isTeachingStaff: targetProfile.isTeachingStaff,
          lifecycleStatus: targetProfile.lifecycleStatus,
          profilePhoto: showPhoto ? targetProfile.profilePhoto : { secureUrl: '', publicId: '' },
          // Sensitive Fields: returned unmasked ONLY if authorized AND not set to PRIVATE
          cnic: canRevealCnic ? targetProfile.cnic : maskCnic(targetProfile.cnic),
          bankName: canRevealBank ? targetProfile.bankName : (targetProfile.bankName ? 'Provided' : ''),
          branchName: canRevealBank ? targetProfile.branchName : '****',
          accountNumber: canRevealBank ? targetProfile.accountNumber : maskBankAccount(targetProfile.accountNumber),
          accountTitle: canRevealBank ? targetProfile.accountTitle : '****',
          correctionRemarks: targetProfile.correctionRemarks,
          approvalHistory: (targetProfile.approvalHistory || []).map((historyItem) => ({
            action: historyItem.action,
            decision: historyItem.decision,
            reason: historyItem.reason,
            actorRole: historyItem.actorRole,
            actorName: historyItem.actorName,
            timestamp: historyItem.timestamp,
          })),
          transferHistory: (targetProfile.transferHistory || []).map((historyItem) => ({
            fromSchool: historyItem.fromSchoolId ? {
              _id: historyItem.fromSchoolId._id || historyItem.fromSchoolId,
              name: historyItem.fromSchoolId.name || 'School',
              code: historyItem.fromSchoolId.code || '',
            } : null,
            toSchool: historyItem.toSchoolId ? {
              _id: historyItem.toSchoolId._id || historyItem.toSchoolId,
              name: historyItem.toSchoolId.name || 'School',
              code: historyItem.toSchoolId.code || '',
            } : null,
            transferRequestId: historyItem.transferRequestId,
            relievedDate: historyItem.relievedDate || null,
            joiningDate: historyItem.joiningDate || null,
            orderReferenceNumber: historyItem.orderReferenceNumber || '',
          })),
        }
      : null,
    studentProfile: studentProfile
      ? {
          grNumber: studentProfile.grNumber,
          admissionRegisterNumber: studentProfile.admissionRegisterNumber,
          globalStudentId: studentProfile.globalStudentId,
          studentFullName: studentProfile.studentFullName || targetUser.fullName,
          bFormNumber: canRevealCnic ? studentProfile.bFormNumber : maskCnic(studentProfile.bFormNumber),
          dateOfBirth: studentProfile.dateOfBirth,
          dateOfBirthInWords: studentProfile.dateOfBirthInWords,
          gender: studentProfile.gender,
          religion: studentProfile.religion,
          placeOfBirth: studentProfile.placeOfBirth,
          studentPhotoUrl: showPhoto ? studentProfile.studentPhotoUrl : '',
          fatherFullName: studentProfile.fatherFullName,
          motherFullName: studentProfile.motherFullName,
          relationshipWithStudent: studentProfile.relationshipWithStudent,
          guardianCnicNumber: canRevealCnic ? studentProfile.guardianCnicNumber : maskCnic(studentProfile.guardianCnicNumber),
          guardianCellNumber: showPhone ? studentProfile.guardianCellNumber : 'Protected (Privacy)',
          guardianEmail: showEmail ? studentProfile.guardianEmail : 'Protected (Privacy)',
          permanentResidentialAddress: canRevealAddress ? studentProfile.permanentResidentialAddress : 'Protected (Privacy)',
          residentialAddress: canRevealAddress ? (studentProfile.residentialAddress || studentProfile.permanentResidentialAddress) : 'Protected (Privacy)',
          admissionClassRequested: studentProfile.admissionClassRequested,
          mediumOfInstruction: studentProfile.mediumOfInstruction,
          lastSchoolAttended: studentProfile.lastSchoolAttended,
          admissionDate: studentProfile.admissionDate,
          admissionRemarks: studentProfile.admissionRemarks,
          admissionHistory: studentProfile.admissionHistory || [],
          class: studentProfile.classId,
          section: studentProfile.sectionId,
          lifecycleStatus: studentProfile.lifecycleStatus,
        }
      : null,
    assignments: {
      active: assignments.filter((assignmentItem) => assignmentItem.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE),
      history: assignments.filter((assignmentItem) => assignmentItem.status !== TEACHING_ASSIGNMENT_STATUS.ACTIVE),
    },
    // Privacy & PDF Access Metadata
    privacySettings: (isSelf || isPrivilegedAdmin)
      ? (targetProfile?.privacySettings || {
          fieldVisibility: privacy,
          allowAuthorizedPdfDownload: false,
        })
      : undefined,
    pdfAccess: {
      isSelf,
      allowed: isSelf || isPrivilegedAdmin || !!targetProfile?.privacySettings?.allowAuthorizedPdfDownload || !!activeApproval,
      canDirectDownload: isSelf || isPrivilegedAdmin || !!targetProfile?.privacySettings?.allowAuthorizedPdfDownload || !!activeApproval,
      requiresConsent: !isSelf && !isPrivilegedAdmin && !targetProfile?.privacySettings?.allowAuthorizedPdfDownload && !activeApproval,
      activeApproval: activeApproval
        ? {
            requestId: activeApproval._id,
            expiresAt: activeApproval.expiresAt,
            purpose: activeApproval.purpose,
          }
        : null,
    },
  };

  return sendSuccess(response, 200, 'Staff profile retrieved successfully.', responseData);
});

/**
 * PATCH /api/v1/staff/:id/profile
 * Update self-managed fields for staff profile.
 * Strictly prevents mass assignment to authoritative fields (role, school, cnic, status, etc.).
 */
export const handleUpdateStaffProfile = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  // Backend Parent Isolation
  if (requestingActor.role === ROLES.PARENT) {
    return sendError(response, 403, 'Access denied: Parent accounts do not possess employee service records.');
  }

  const targetUserId = request.params.id === 'me' ? requestingActor._id : request.params.id;

  const isSelf = String(requestingActor._id) === String(targetUserId);
  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role);

  if (!isSelf && !isPrivilegedAdmin) {
    return sendError(response, 403, 'Unauthorized: You are only permitted to update your own personal profile.');
  }

  const targetUser = await User.findById(targetUserId);
  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  if (isTargetProtectedFromActor(requestingActor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  // ─── STRICT MASS ASSIGNMENT & SCHEMA ALLOWLIST GUARD ───────────────────────
  const ALLOWED_PROFILE_KEYS = [
    'phoneNumber',
    'fatherName',
    'residentialAddress',
    'qualification',
    'bankName',
    'branchName',
    'accountTitle',
    'accountNumber',
  ];

  const requestKeys = Object.keys(request.body);
  if (requestKeys.length === 0) {
    return sendError(response, 400, 'No fields provided for profile update.');
  }

  for (const key of requestKeys) {
    if (!ALLOWED_PROFILE_KEYS.includes(key)) {
      return sendError(
        response,
        400,
        `Direct modification of protected or unrecognized field [${key}] is strictly prohibited. Permitted fields: ${ALLOWED_PROFILE_KEYS.join(', ')}.`
      );
    }

    const value = request.body[key];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      return sendError(
        response,
        400,
        `Invalid data type for field [${key}]. Expected string value.`
      );
    }
  }

  // Format and length validations
  if (request.body.phoneNumber !== undefined) {
    const cleanPhone = String(request.body.phoneNumber || '').trim();
    if (cleanPhone && (cleanPhone.length > 20 || !/^[0-9+\s-]{7,20}$/.test(cleanPhone))) {
      return sendError(response, 400, 'Invalid contact phone number format. Permitted: 7 to 20 digits, spaces, hyphens, and leading plus.');
    }
  }
  if (request.body.fatherName !== undefined && String(request.body.fatherName).length > 100) {
    return sendError(response, 400, 'Father name exceeds maximum length of 100 characters.');
  }
  if (request.body.residentialAddress !== undefined && String(request.body.residentialAddress).length > 300) {
    return sendError(response, 400, 'Residential address exceeds maximum length of 300 characters.');
  }
  if (request.body.qualification !== undefined && String(request.body.qualification).length > 100) {
    return sendError(response, 400, 'Qualification exceeds maximum length of 100 characters.');
  }
  if (request.body.bankName !== undefined && String(request.body.bankName).length > 100) {
    return sendError(response, 400, 'Bank name exceeds maximum length of 100 characters.');
  }
  if (request.body.branchName !== undefined && String(request.body.branchName).length > 100) {
    return sendError(response, 400, 'Branch name exceeds maximum length of 100 characters.');
  }
  if (request.body.accountTitle !== undefined && String(request.body.accountTitle).length > 100) {
    return sendError(response, 400, 'Account title exceeds maximum length of 100 characters.');
  }
  if (request.body.accountNumber !== undefined && String(request.body.accountNumber).length > 50) {
    return sendError(response, 400, 'Account number exceeds maximum length of 50 characters.');
  }

  // Find or create TeacherProfile
  let targetProfile = await TeacherProfile.findOne({ userId: targetUserId });
  if (!targetProfile) {
    targetProfile = await TeacherProfile.create({
      userId: targetUser._id,
      currentSchoolId: targetUser.schoolId || null,
      claimedSchoolId: targetUser.claimedSchoolId || null,
      isTeachingStaff: targetUser.role === ROLES.TEACHER,
      designation: targetUser.designation || 'Staff',
    });
  }

  const beforeSnapshot = {
    phoneNumber: targetUser.phoneNumber || '',
    fatherName: targetProfile.fatherName || '',
    residentialAddress: targetProfile.residentialAddress || '',
    qualification: targetProfile.qualification || '',
    bankName: targetProfile.bankName || '',
    branchName: targetProfile.branchName || '',
    accountTitle: targetProfile.accountTitle || '',
    accountNumber: maskBankAccount(targetProfile.accountNumber || ''),
  };

  const changedFields = [];

  // Update User self-managed fields
  if (request.body.phoneNumber !== undefined) {
    const cleanPhone = String(request.body.phoneNumber || '').trim();
    if (cleanPhone && !/^[0-9+\s-]{7,20}$/.test(cleanPhone)) {
      return sendError(response, 400, 'Invalid contact phone number format.');
    }
    targetUser.phoneNumber = cleanPhone;
    changedFields.push('phoneNumber');
  }

  // Update TeacherProfile self-managed fields
  if (request.body.fatherName !== undefined) {
    targetProfile.fatherName = String(request.body.fatherName || '').trim().slice(0, 100);
    changedFields.push('fatherName');
  }
  if (request.body.residentialAddress !== undefined) {
    targetProfile.residentialAddress = String(request.body.residentialAddress || '').trim().slice(0, 300);
    changedFields.push('residentialAddress');
  }
  if (request.body.qualification !== undefined) {
    targetProfile.qualification = String(request.body.qualification || '').trim().slice(0, 100);
    changedFields.push('qualification');
  }
  if (request.body.bankName !== undefined) {
    targetProfile.bankName = String(request.body.bankName || '').trim().slice(0, 100);
    changedFields.push('bankName');
  }
  if (request.body.branchName !== undefined) {
    targetProfile.branchName = String(request.body.branchName || '').trim().slice(0, 100);
    changedFields.push('branchName');
  }
  if (request.body.accountTitle !== undefined) {
    targetProfile.accountTitle = String(request.body.accountTitle || '').trim().slice(0, 100);
    changedFields.push('accountTitle');
  }
  if (request.body.accountNumber !== undefined) {
    targetProfile.accountNumber = String(request.body.accountNumber || '').trim().slice(0, 50);
    changedFields.push('accountNumber');
  }

  // StudentProfile synchronization if target is Student
  let studentProfile = null;
  if (targetUser.role === ROLES.STUDENT) {
    studentProfile = await StudentProfile.findOne({ userId: targetUserId });
    if (studentProfile) {
      if (request.body.fatherName !== undefined) studentProfile.fatherFullName = targetProfile.fatherName;
      if (request.body.residentialAddress !== undefined) {
        studentProfile.residentialAddress = targetProfile.residentialAddress;
        studentProfile.permanentResidentialAddress = targetProfile.residentialAddress;
      }
      if (request.body.phoneNumber !== undefined) studentProfile.guardianCellNumber = targetUser.phoneNumber;
      await studentProfile.save();
    }
  }

  await targetUser.save();
  await targetProfile.save();

  const afterSnapshot = {
    phoneNumber: targetUser.phoneNumber || '',
    fatherName: targetProfile.fatherName || '',
    residentialAddress: targetProfile.residentialAddress || '',
    qualification: targetProfile.qualification || '',
    bankName: targetProfile.bankName || '',
    branchName: targetProfile.branchName || '',
    accountTitle: targetProfile.accountTitle || '',
    accountNumber: maskBankAccount(targetProfile.accountNumber || ''),
  };

  // Immutable Audit Log
  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    actorDesignation: requestingActor.designation,
    action: 'STAFF_PROFILE_UPDATED',
    targetModel: 'TeacherProfile',
    targetId: targetProfile._id,
    targetName: targetUser.fullName,
    townId: targetUser.townId,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    previousState: beforeSnapshot,
    newState: afterSnapshot,
    result: 'SUCCESS',
    reason: isSelf ? 'Self-managed profile fields updated' : `Profile updated by administrative actor (${requestingActor.role})`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Profile details updated successfully.', {
    user: {
      id: targetUser._id,
      fullName: targetUser.fullName,
      email: targetUser.email,
      phoneNumber: targetUser.phoneNumber,
      designation: targetUser.designation,
      role: targetUser.role,
      status: targetUser.status,
    },
    profile: {
      fatherName: targetProfile.fatherName,
      residentialAddress: targetProfile.residentialAddress,
      qualification: targetProfile.qualification,
      bankName: targetProfile.bankName,
      branchName: targetProfile.branchName,
      accountTitle: targetProfile.accountTitle,
      accountNumber: isSelf ? targetProfile.accountNumber : maskBankAccount(targetProfile.accountNumber),
    },
    changedFields,
  });
});

/**
 * POST /api/v1/staff/:id/photo
 * Upload or replace personal profile photo using in-memory upload and Cloudinary.
 * Deletes previous photo on successful replacement.
 */
export const handleUploadProfilePhoto = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  // Backend Parent Isolation
  if (requestingActor.role === ROLES.PARENT) {
    return sendError(response, 403, 'Access denied: Parent accounts do not possess employee service records.');
  }

  const targetUserId = request.params.id === 'me' ? requestingActor._id : request.params.id;

  const isSelf = String(requestingActor._id) === String(targetUserId);
  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role);

  if (!isSelf && !isPrivilegedAdmin) {
    return sendError(response, 403, 'Unauthorized: You can only update your own profile photo.');
  }

  const targetUser = await User.findById(targetUserId);
  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  if (isTargetProtectedFromActor(requestingActor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  if (!request.file || !request.file.buffer) {
    return sendError(response, 400, 'No photo file provided for upload.');
  }

  // Size validation: max 5MB
  if (request.file.size > 5 * 1024 * 1024) {
    return sendError(response, 400, 'Photo exceeds maximum allowed size of 5MB.');
  }

  // Allowed image mime types
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedMimes.includes(request.file.mimetype)) {
    return sendError(response, 400, 'Invalid image format. Permitted types: JPEG, PNG, WEBP.');
  }

  let targetProfile = await TeacherProfile.findOne({ userId: targetUserId });
  if (!targetProfile) {
    targetProfile = await TeacherProfile.create({
      userId: targetUser._id,
      currentSchoolId: targetUser.schoolId || null,
      claimedSchoolId: targetUser.claimedSchoolId || null,
      isTeachingStaff: targetUser.role === ROLES.TEACHER,
      designation: targetUser.designation || 'Staff',
    });
  }

  const oldPublicId = targetProfile.profilePhoto?.publicId;

  // 1. Upload new photo to Cloudinary first
  let uploadResult;
  try {
    uploadResult = await uploadBufferToCloudinary(request.file.buffer, {
      folder: 'liaquatabad_sms/profiles',
      resourceType: 'image',
    });
  } catch (cloudinaryError) {
    return sendError(response, 502, `Cloudinary upload failed: ${cloudinaryError.message || 'Unable to store profile photo.'}`);
  }

  // 2. Persist new photo in database
  targetProfile.profilePhoto = {
    secureUrl: uploadResult.secureUrl,
    publicId: uploadResult.publicId,
  };

  try {
    await targetProfile.save();
  } catch (dbError) {
    // Compensation: delete newly uploaded photo from Cloudinary if database persistence fails
    try {
      await deleteFromCloudinary(uploadResult.publicId, 'image');
    } catch (compensationError) {
      console.warn('[Profile Photo Compensation Warning]:', compensationError.message);
    }
    throw dbError;
  }

  // If student, sync studentPhotoUrl
  if (targetUser.role === ROLES.STUDENT) {
    const studentProfile = await StudentProfile.findOne({ userId: targetUserId });
    if (studentProfile) {
      studentProfile.studentPhotoUrl = uploadResult.secureUrl;
      await studentProfile.save();
    }
  }

  // 3. Delete previous photo from Cloudinary only AFTER the new photo is safely committed
  if (oldPublicId && oldPublicId !== uploadResult.publicId) {
    try {
      await deleteFromCloudinary(oldPublicId, 'image');
    } catch (cleanupError) {
      console.warn('[Profile Photo Cleanup Warning]:', cleanupError.message);
    }
  }

  // Audit Log
  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    actorDesignation: requestingActor.designation,
    action: 'PROFILE_PHOTO_UPDATED',
    targetModel: 'TeacherProfile',
    targetId: targetProfile._id,
    targetName: targetUser.fullName,
    townId: targetUser.townId,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    newState: {
      publicId: uploadResult.publicId,
      format: uploadResult.format,
      bytes: uploadResult.bytes,
    },
    result: 'SUCCESS',
    reason: isSelf ? 'Profile photo updated by account owner' : `Profile photo updated by ${requestingActor.role}`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Profile photo updated successfully.', {
    profilePhoto: targetProfile.profilePhoto,
  });
});

/**
 * DELETE /api/v1/staff/:id/photo
 * Remove personal profile photo and delete from Cloudinary storage.
 */
export const handleDeleteProfilePhoto = asyncHandler(async (request, response) => {
  const requestingActor = request.user;

  // Backend Parent Isolation
  if (requestingActor.role === ROLES.PARENT) {
    return sendError(response, 403, 'Access denied: Parent accounts do not possess employee service records.');
  }

  const targetUserId = request.params.id === 'me' ? requestingActor._id : request.params.id;

  const isSelf = String(requestingActor._id) === String(targetUserId);
  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(requestingActor.role);

  if (!isSelf && !isPrivilegedAdmin) {
    return sendError(response, 403, 'Unauthorized: You can only remove your own profile photo.');
  }

  const targetUser = await User.findById(targetUserId);
  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  if (isTargetProtectedFromActor(requestingActor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId });
  if (!targetProfile || !targetProfile.profilePhoto?.publicId) {
    return sendSuccess(response, 200, 'No active profile photo to remove.', {
      profilePhoto: { secureUrl: '', publicId: '' },
    });
  }

  const oldPublicId = targetProfile.profilePhoto.publicId;
  try {
    await deleteFromCloudinary(oldPublicId, 'image');
  } catch (cleanupError) {
    console.warn('[Profile Photo Delete Warning]:', cleanupError.message);
  }

  targetProfile.profilePhoto = { secureUrl: '', publicId: '' };
  await targetProfile.save();

  if (targetUser.role === ROLES.STUDENT) {
    const studentProfile = await StudentProfile.findOne({ userId: targetUserId });
    if (studentProfile) {
      studentProfile.studentPhotoUrl = '';
      await studentProfile.save();
    }
  }

  await AuditLog.create({
    actorId: requestingActor._id,
    actorRole: requestingActor.role,
    actorName: requestingActor.fullName,
    actorDesignation: requestingActor.designation,
    action: 'PROFILE_PHOTO_DELETED',
    targetModel: 'TeacherProfile',
    targetId: targetProfile._id,
    targetName: targetUser.fullName,
    townId: targetUser.townId,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    previousState: { publicId: oldPublicId },
    newState: { publicId: '' },
    result: 'SUCCESS',
    reason: isSelf ? 'Profile photo removed by account owner' : `Profile photo removed by ${requestingActor.role}`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Profile photo removed successfully.', {
    profilePhoto: { secureUrl: '', publicId: '' },
  });
});

/**
 * PATCH /api/v1/staff/:id/privacy
 * Update staff field visibility and PDF consent settings.
 * Strictly enforces policy ceilings: CNIC and Bank Details can NEVER be PUBLIC.
 */
export const handleUpdatePrivacySettings = asyncHandler(async (request, response) => {
  const actor = request.user;

  // Backend Parent Isolation
  if (actor.role === ROLES.PARENT) {
    return sendError(response, 403, 'Access denied: Parent accounts do not possess employee service records.');
  }

  const targetUserId = request.params.id === 'me' ? actor._id : request.params.id;

  const isSelf = String(actor._id) === String(targetUserId);
  const isRootAdmin = actor.role === ROLES.ROOT_ADMIN;

  if (!isSelf && !isRootAdmin) {
    return sendError(response, 403, 'Unauthorized: You can only configure your own privacy settings.');
  }

  const { fieldVisibility = {}, allowAuthorizedPdfDownload } = request.body;

  // ─── VALIDATE VISIBILITY TIERS ─────────────────────────────────────────────
  const VALID_TIERS = ['PUBLIC', 'SCHOOL', 'AUTHORIZED_ROLE', 'PRIVATE'];
  if (fieldVisibility && typeof fieldVisibility === 'object') {
    for (const [fieldKey, tierValue] of Object.entries(fieldVisibility)) {
      if (!VALID_TIERS.includes(tierValue)) {
        return sendError(
          response,
          400,
          `Invalid visibility tier [${tierValue}] for field [${fieldKey}]. Permitted: ${VALID_TIERS.join(', ')}.`
        );
      }
    }
  }

  // ─── SECURITY CEILING ENFORCEMENT ───────────────────────────────────────────
  // CNIC, B-Form, Bank Details, and Residential Address can NEVER be PUBLIC or SCHOOL-wide
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.cnic)) {
    return sendError(response, 400, 'Security Policy Violation: CNIC cannot be exposed publicly or school-wide. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.bFormNumber)) {
    return sendError(response, 400, 'Security Policy Violation: B-Form number cannot be exposed publicly or school-wide. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.bankDetails)) {
    return sendError(response, 400, 'Security Policy Violation: Bank Details cannot be exposed publicly or school-wide. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.residentialAddress)) {
    return sendError(response, 400, 'Security Policy Violation: Residential Address cannot be exposed publicly or school-wide. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }

  let targetProfile = await TeacherProfile.findOne({ userId: targetUserId });
  if (!targetProfile) {
    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return sendError(response, 404, 'User not found.');
    }
    targetProfile = await TeacherProfile.create({
      userId: targetUser._id,
      currentSchoolId: targetUser.schoolId || null,
      claimedSchoolId: targetUser.claimedSchoolId || null,
      isTeachingStaff: targetUser.role === ROLES.TEACHER,
      designation: targetUser.designation || 'Staff',
    });
  }

  const existingSettings = targetProfile.privacySettings || {
    fieldVisibility: {},
    allowAuthorizedPdfDownload: false,
  };

  targetProfile.privacySettings = {
    fieldVisibility: {
      ...existingSettings.fieldVisibility,
      ...fieldVisibility,
    },
    allowAuthorizedPdfDownload: allowAuthorizedPdfDownload !== undefined
      ? Boolean(allowAuthorizedPdfDownload)
      : existingSettings.allowAuthorizedPdfDownload,
    updatedAt: new Date(),
  };

  await targetProfile.save();

  // Audit Log
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorName: actor.fullName,
    actorDesignation: actor.designation,
    action: 'STAFF_PRIVACY_SETTINGS_UPDATED',
    targetModel: 'TeacherProfile',
    targetId: targetProfile._id,
    targetName: actor.fullName,
    newState: {
      allowAuthorizedPdfDownload: targetProfile.privacySettings.allowAuthorizedPdfDownload,
      fieldVisibility: targetProfile.privacySettings.fieldVisibility,
    },
    result: 'SUCCESS',
    reason: 'Staff member updated profile privacy & PDF consent preferences',
  });

  return sendSuccess(response, 200, 'Privacy settings updated successfully.', {
    privacySettings: targetProfile.privacySettings,
  });
});

/**
 * POST /api/v1/staff/:id/request-pdf-access
 * Submit a formal ProfileAccessRequest declaring official administrative purpose.
 * Dispatches PDF_ACCESS_REQUEST notification to the target staff member.
 */
export const handleRequestPdfAccess = asyncHandler(async (request, response) => {
  const actor = request.user;
  const targetUserId = request.params.id;

  if (String(actor._id) === String(targetUserId)) {
    return sendError(response, 400, 'You do not need to submit an access request to download your own profile PDF.');
  }

  const targetUser = await User.findById(targetUserId).populate('schoolId', 'name code');
  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  if (isTargetProtectedFromActor(actor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId });
  const access = evaluateProfileAccess(actor, targetUser, targetProfile);

  if (!access.canView) {
    return sendError(response, 403, 'Access denied. You do not have jurisdictional authority over this staff member.');
  }

  const { purpose, scope = 'OFFICIAL_SERVICE_RECORD' } = request.body;
  if (!purpose || !purpose.trim()) {
    return sendError(response, 400, 'A valid official purpose is required to request profile access (e.g. Annual Audit, Service Verification).');
  }

  // Check if a PENDING request already exists to prevent duplicate spam
  const existingPending = await ProfileAccessRequest.findOne({
    requesterId: actor._id,
    targetStaffUserId: targetUser._id,
    status: 'PENDING',
  });

  if (existingPending) {
    return sendError(response, 409, 'An access request for this staff member is already pending their review.');
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h to respond

  const newRequest = await ProfileAccessRequest.create({
    requesterId: actor._id,
    requesterName: actor.fullName,
    requesterRole: actor.role,
    requesterDesignation: actor.designation || 'Administrative Authority',
    targetStaffUserId: targetUser._id,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    purpose: purpose.trim(),
    scope,
    status: 'PENDING',
    expiresAt,
  });

  // Dispatch in-app notification to the target staff member
  await dispatchNotificationEvent({
    eventType: 'PDF_ACCESS_REQUEST',
    category: 'STAFF_PRIVACY',
    title: 'Profile PDF Access Request',
    message: `${actor.fullName} (${actor.designation || actor.role}) has requested access to download your official service record PDF for: "${purpose.trim()}".`,
    actionLink: `/staff/me`,
    rawMetadata: {
      accessRequestId: String(newRequest._id),
      purpose: purpose.trim(),
      scope,
      requesterName: actor.fullName,
      requesterRole: actor.role,
      requesterDesignation: actor.designation || 'Staff',
      schoolName: targetUser.schoolId?.name || 'Education Department',
      expiresAt,
    },
    recipientUserIds: [String(targetUser._id)],
  });

  // Audit Log
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorName: actor.fullName,
    actorDesignation: actor.designation,
    action: 'PROFILE_ACCESS_REQUESTED',
    targetModel: 'ProfileAccessRequest',
    targetId: newRequest._id,
    targetName: targetUser.fullName,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    newState: { purpose: purpose.trim(), scope, expiresAt },
    result: 'SUCCESS',
    reason: `Official PDF access requested for: ${purpose.trim()}`,
  });

  return sendSuccess(response, 201, 'Profile PDF access request submitted. The staff member has been notified for consent.', {
    accessRequest: newRequest,
  });
});

/**
 * GET /api/v1/staff/:id/access-history
 * Retrieve recent access requests and download telemetry for transparency.
 */
export const handleGetStaffAccessHistory = asyncHandler(async (request, response) => {
  const actor = request.user;
  const targetUserId = request.params.id === 'me' ? actor._id : request.params.id;

  const isSelf = String(actor._id) === String(targetUserId);
  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actor.role);

  const targetUser = await User.findById(targetUserId).lean();
  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  if (isTargetProtectedFromActor(actor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  const [requests, downloads] = await Promise.all([
    ProfileAccessRequest.find({ targetStaffUserId: targetUserId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    AuditLog.find({
      targetId: targetUserId,
      action: 'PROFILE_PDF_DOWNLOADED',
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);

  return sendSuccess(response, 200, 'Access history retrieved successfully.', {
    requests,
    downloads: downloads.map((downloadRecord) => ({
      id: downloadRecord._id,
      actorName: downloadRecord.actorName,
      actorRole: downloadRecord.actorRole,
      actorDesignation: downloadRecord.actorDesignation,
      downloadedAt: downloadRecord.createdAt,
      reason: downloadRecord.reason,
    })),
  });
});

/**
 * GET /api/v1/staff/:id/pdf
 * Server-side generation of official Government Service Record PDF using pdfkit.
 * Enforces strict consent: checks allowAuthorizedPdfDownload OR active unexpired approved ProfileAccessRequest.
 * Stream-delivered; zero sensitive PII in telemetry logs.
 */
export const handleGenerateStaffProfilePdf = asyncHandler(async (request, response) => {
  const actor = request.user;
  const targetUserId = request.params.id === 'me' ? actor._id : request.params.id;

  const targetUser = await User.findById(targetUserId)
    .populate('schoolId', 'name code address district')
    .lean();

  if (!targetUser) {
    return sendError(response, 404, 'Staff member not found.');
  }

  // Identity Protection Policy: Return 404 if target is protected/invisible to actor
  if (isTargetProtectedFromActor(actor, targetUser)) {
    return sendError(response, 404, 'Staff member not found.');
  }

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId }).lean();
  const access = evaluateProfileAccess(actor, targetUser, targetProfile);

  if (!access.canView) {
    return sendError(response, 403, 'Access denied. You do not have jurisdictional permission to view this staff profile.');
  }

  const isSelf = String(actor._id) === String(targetUser._id);
  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN].includes(actor.role);
  const preAllowed = !!targetProfile?.privacySettings?.allowAuthorizedPdfDownload;
  const privacy = targetProfile?.privacySettings?.fieldVisibility || {
    profilePhoto: 'PUBLIC',
    designation: 'PUBLIC',
    qualification: 'PUBLIC',
    phoneNumber: 'SCHOOL',
    email: 'SCHOOL',
    cnic: 'AUTHORIZED_ROLE',
    bankDetails: 'AUTHORIZED_ROLE',
    residentialAddress: 'AUTHORIZED_ROLE',
  };

  let activeApproval = null;
  if (!isSelf && !isPrivilegedAdmin && !preAllowed) {
    // Check if an unexpired approved consent exists
    activeApproval = await ProfileAccessRequest.findOne({
      requesterId: actor._id,
      targetStaffUserId: targetUser._id,
      status: 'APPROVED',
      expiresAt: { $gt: new Date() },
    });

    if (!activeApproval) {
      return sendError(
        response,
        403,
        'Staff consent required. You must submit an official PDF access request before downloading this service record.'
      );
    }
  }

  // If approved consent exists, increment download count
  if (activeApproval) {
    activeApproval.downloadCount = (activeApproval.downloadCount || 0) + 1;
    activeApproval.downloadedAt = new Date();
    await activeApproval.save();
  }

  // Fetch teaching assignments
  let assignments = [];
  if (targetProfile?.isTeachingStaff) {
    assignments = await TeachingAssignment.find({ teacherId: targetUserId })
      .populate('schoolId', 'name code')
      .populate('classId', 'name numericGrade')
      .populate('sectionId', 'name')
      .populate('subjectId', 'name code')
      .sort({ status: 1, createdAt: -1 })
      .lean();
  }

  // Create PDF Document stream
  const doc = new PDFDocument({ margin: 40, size: 'A4' });

  // Response headers for authenticated stream download
  const cleanEmpId = targetProfile?.employeeId || 'STAFF';
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename=ServiceRecord_${cleanEmpId}.pdf`);

  doc.pipe(response);

  // ─── Official Header ────────────────────────────────────────────────────────
  doc.rect(40, 40, 515, 60).fill('#0f172a');
  doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
    .text('GOVERNMENT OF SINDH', 50, 48, { align: 'center', width: 495 });
  doc.fontSize(10).font('Helvetica')
    .text('EDUCATION DEPARTMENT — LIAQUATABAD TOWN CENTRE (DMC)', 50, 66, { align: 'center', width: 495 });
  doc.fontSize(8).font('Helvetica-Oblique')
    .text('OFFICIAL INSTITUTIONAL SERVICE RECORD & EMPLOYEE DOSSIER', 50, 80, { align: 'center', width: 495 });

  doc.moveDown(2);
  let yPos = 115;

  // ─── Status & ID Strip ──────────────────────────────────────────────────────
  doc.rect(40, yPos, 515, 22).fill('#f1f5f9');
  doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold')
    .text(`EMPLOYEE NO: ${targetProfile?.employeeId || 'N/A'}`, 50, yPos + 6);
  doc.text(`STATUS: ${targetUser.status}`, 250, yPos + 6);
  doc.text(`DESIGNATION: ${targetUser.designation || 'N/A'}`, 380, yPos + 6);

  yPos += 30;

  // ─── Section 1: Personal & Employment Information ───────────────────────────
  doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('1. PERSONAL & EMPLOYMENT INFORMATION', 40, yPos);
  doc.moveTo(40, yPos + 14).lineTo(555, yPos + 14).strokeColor('#cbd5e1').stroke();
  yPos += 20;

  doc.fontSize(9).font('Helvetica');
  const showCnicInPdf = isSelf || (privacy.cnic !== 'PRIVATE' && access.canViewSensitive);
  const personalInfo = [
    ['Full Name:', targetUser.fullName || 'N/A', "Father's Name:", targetProfile?.fatherName || 'N/A'],
    ['Official Email:', targetUser.email || 'N/A', 'Contact Phone:', targetUser.phoneNumber || 'N/A'],
    ['Date of Birth:', targetProfile?.dateOfBirth ? new Date(targetProfile.dateOfBirth).toLocaleDateString() : 'N/A', 'CNIC:', showCnicInPdf ? (targetProfile?.cnic || 'N/A') : maskCnic(targetProfile?.cnic)],
    ['Institution/School:', targetUser.schoolId?.name || 'Unassigned / Claimed', 'School Code:', targetUser.schoolId?.code || 'N/A'],
    ['Date of Appointment:', targetProfile?.appointmentDate ? new Date(targetProfile.appointmentDate).toLocaleDateString() : 'N/A', 'Qualification:', targetProfile?.qualification || 'N/A'],
    ['Staff Classification:', targetProfile?.isTeachingStaff ? 'Teaching Faculty' : 'Non-Teaching Support Staff', 'System Role:', targetUser.role],
  ];

  for (const row of personalInfo) {
    doc.font('Helvetica-Bold').text(row[0], 40, yPos, { width: 110 });
    doc.font('Helvetica').text(row[1], 150, yPos, { width: 150 });
    doc.font('Helvetica-Bold').text(row[2], 310, yPos, { width: 110 });
    doc.font('Helvetica').text(row[3], 420, yPos, { width: 135 });
    yPos += 16;
  }

  yPos += 10;

  // ─── Section 2: Bank & Payroll Details (Only if authorized and not PRIVATE) ───
  doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('2. BANK & DISBURSEMENT DETAILS', 40, yPos);
  doc.moveTo(40, yPos + 14).lineTo(555, yPos + 14).strokeColor('#cbd5e1').stroke();
  yPos += 20;

  const showBankInPdf = isSelf || (privacy.bankDetails !== 'PRIVATE' && access.canViewSensitive);
  if (showBankInPdf) {
    const bankInfo = [
      ['Bank Name:', targetProfile?.bankName || 'Not Provided', 'Branch Name:', targetProfile?.branchName || 'Not Provided'],
      ['Account Title:', targetProfile?.accountTitle || 'Not Provided', 'Account Number:', targetProfile?.accountNumber || 'Not Provided'],
    ];

    for (const row of bankInfo) {
      doc.font('Helvetica-Bold').text(row[0], 40, yPos, { width: 110 });
      doc.font('Helvetica').text(row[1], 150, yPos, { width: 150 });
      doc.font('Helvetica-Bold').text(row[2], 310, yPos, { width: 110 });
      doc.font('Helvetica').text(row[3], 420, yPos, { width: 135 });
      yPos += 16;
    }
  } else {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b')
      .text('Bank details are restricted under platform privacy policy or authorized treasury access.', 40, yPos);
    yPos += 16;
  }

  yPos += 10;

  // ─── Section 3: Authoritative Teaching Roster ───────────────────────────────
  if (targetProfile?.isTeachingStaff) {
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('3. AUTHORIZED TEACHING ASSIGNMENTS', 40, yPos);
    doc.moveTo(40, yPos + 14).lineTo(555, yPos + 14).strokeColor('#cbd5e1').stroke();
    yPos += 20;

    if (assignments.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b')
        .text('No active teaching assignments currently on authoritative file.', 40, yPos);
      yPos += 16;
    } else {
      doc.rect(40, yPos, 515, 18).fill('#f8fafc');
      doc.fillColor('#334155').fontSize(8).font('Helvetica-Bold')
        .text('CLASS / GRADE', 45, yPos + 5, { width: 100 })
        .text('SECTION', 150, yPos + 5, { width: 70 })
        .text('SUBJECT', 225, yPos + 5, { width: 150 })
        .text('SCHOOL', 380, yPos + 5, { width: 100 })
        .text('STATUS', 485, yPos + 5, { width: 65 });
      yPos += 20;

      for (const a of assignments.slice(0, 10)) {
        doc.fillColor('#0f172a').fontSize(8).font('Helvetica')
          .text(a.classId?.name || 'Class', 45, yPos, { width: 100 })
          .text(a.sectionId?.name || 'A', 150, yPos, { width: 70 })
          .text(a.subjectId?.name || 'General', 225, yPos, { width: 150 })
          .text(a.schoolId?.code || 'LTC', 380, yPos, { width: 100 })
          .font('Helvetica-Bold')
          .text(a.status, 485, yPos, { width: 65 });
        doc.font('Helvetica');
        yPos += 14;
      }
    }
  }

  // ─── Footer & Official Verification Stamp ───────────────────────────────────
  if (yPos > 700) {
    doc.addPage();
    yPos = 40;
  }
  yPos = Math.max(yPos + 20, 680);

  doc.rect(40, yPos, 515, 65).strokeColor('#cbd5e1').stroke();
  doc.fontSize(7).font('Helvetica-Bold').fillColor('#475569')
    .text('OFFICIAL VERIFICATION & AUDIT TELEMETRY:', 50, yPos + 8);
  doc.font('Helvetica').fontSize(7)
    .text(`Generated By: ${actor.fullName} (${actor.role}) | Authority Token: Authenticated`, 50, yPos + 18)
    .text(`Generation Timestamp: ${new Date().toISOString()} | Target ID: ${targetUser._id}`, 50, yPos + 28)
    .text(`Access Basis: ${isSelf ? 'Self Download' : preAllowed ? 'Staff Pre-Approved Policy' : activeApproval ? `Consent ID ${activeApproval._id}` : 'Privileged Authority'}`, 50, yPos + 38)
    .text('Notice: This document is an official government administrative record. Tampering is punishable under applicable cyber and civil laws.', 50, yPos + 48);

  doc.end();

  // ─── Dispatch Transparent Notification to Staff Member ──────────────────────
  if (!isSelf) {
    await dispatchNotificationEvent({
      eventType: 'PDF_DOWNLOADED',
      category: 'STAFF_PRIVACY',
      title: 'Profile Dossier Downloaded',
      message: `Your official service record PDF was downloaded by ${actor.fullName} (${actor.designation || actor.role}) for ${activeApproval?.purpose || 'Official Administrative Record'}.`,
      actionLink: `/staff/me`,
      rawMetadata: {
        actorName: actor.fullName,
        actorRole: actor.role,
        purpose: activeApproval?.purpose || 'Official Administrative Record',
        downloadTimestamp: new Date(),
        schoolName: targetUser.schoolId?.name || 'Education Department',
      },
      recipientUserIds: [String(targetUser._id)],
    });
  }

  // ─── Immutable Audit Log (ZERO sensitive details in log) ────────────────────
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation,
    actorName: actor.fullName,
    action: 'PROFILE_PDF_DOWNLOADED',
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: targetUser.townId,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    newState: {
      employeeId: cleanEmpId,
      downloadedAt: new Date(),
      accessBasis: isSelf ? 'SELF' : preAllowed ? 'PRE_ALLOWED' : activeApproval ? 'APPROVED_CONSENT' : 'PRIVILEGED_ADMIN',
    },
    result: 'SUCCESS',
    reason: activeApproval?.purpose || (isSelf ? 'Self dossier download' : 'Official administrative inspection'),
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });
});

/**
 * GET /api/v1/staff/school
 * Retrieves scoped teaching faculty directory for an authorized school.
 * For HM: strictly bounded to request.user.schoolId.
 * Reuses authoritative maskCnic helper.
 */
export const handleGetSchoolFaculty = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  let effectiveSchoolId = null;

  if (requestingActor.role === ROLES.HM) {
    const actorSchoolId = String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!actorSchoolId) {
      return sendError(response, 403, 'Your Head Master account is not assigned to any municipal school.');
    }
    if (request.query.schoolId && String(request.query.schoolId) !== actorSchoolId) {
      return sendError(response, 403, 'Access denied. You cannot view faculty outside your authorized school.');
    }
    effectiveSchoolId = actorSchoolId;
  } else if (requestingActor.role === ROLES.SUPERVISOR) {
    const targetSchoolId = request.query.schoolId;
    if (!targetSchoolId) {
      return sendError(response, 400, 'schoolId query parameter is required for Supervisor oversight.');
    }
    const assignedSchoolIds = (requestingActor.assignedSchools || []).map((assignedSchool) =>
      String(assignedSchool?._id || assignedSchool)
    );
    if (!assignedSchoolIds.includes(String(targetSchoolId))) {
      return sendError(response, 403, 'Access denied. This school is not within your assigned supervisor jurisdiction.');
    }
    effectiveSchoolId = String(targetSchoolId);
  } else if ([ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(requestingActor.role)) {
    effectiveSchoolId = request.query.schoolId || String(requestingActor.schoolId?._id || requestingActor.schoolId || '');
    if (!effectiveSchoolId) {
      return sendError(response, 400, 'schoolId query parameter is required for administrative query.');
    }
  } else {
    return sendError(response, 403, 'Access denied. You lack authority to view the school faculty roster.');
  }

  const { search, status, page = 1, limit = 50 } = request.query;
  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const limitNumber = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const skipRecords = (pageNumber - 1) * limitNumber;

  const userFilter = {
    schoolId: effectiveSchoolId,
    role: ROLES.TEACHER,
  };

  if (status) {
    userFilter.status = status;
  } else {
    userFilter.status = { $ne: USER_STATUS.REJECTED };
  }

  if (search && search.trim()) {
    const trimmedSearch = search.trim();
    // Also look up matching profiles by employeeId or cnic
    const matchingProfiles = await TeacherProfile.find({
      currentSchoolId: effectiveSchoolId,
      $or: [
        { employeeId: { $regex: trimmedSearch, $options: 'i' } },
        { cnic: { $regex: trimmedSearch, $options: 'i' } },
      ],
    }).select('userId').lean();

    const matchingUserIds = matchingProfiles.map((matchingProfile) => matchingProfile.userId);

    userFilter.$or = [
      { fullName: { $regex: trimmedSearch, $options: 'i' } },
      { email: { $regex: trimmedSearch, $options: 'i' } },
      ...(matchingUserIds.length > 0 ? [{ _id: { $in: matchingUserIds } }] : []),
    ];
  }

  const [totalRecords, facultyUsers] = await Promise.all([
    User.countDocuments(userFilter),
    User.find(userFilter)
      .select('fullName email phoneNumber designation status createdAt')
      .sort({ fullName: 1 })
      .skip(skipRecords)
      .limit(limitNumber)
      .lean(),
  ]);

  const facultyUserIds = facultyUsers.map((facultyMember) => facultyMember._id);

  const [teacherProfiles, activeAssignments] = await Promise.all([
    TeacherProfile.find({ userId: { $in: facultyUserIds } }).lean(),
    TeachingAssignment.find({
      schoolId: effectiveSchoolId,
      teacherId: { $in: facultyUserIds },
      status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    })
      .populate('classId', 'name numericGrade code')
      .populate('sectionId', 'name')
      .populate('subjectId', 'name code')
      .lean(),
  ]);

  const profileMap = new Map(
    teacherProfiles.map((teacherProfile) => [String(teacherProfile.userId), teacherProfile])
  );

  const assignmentMap = new Map();
  for (const assignment of activeAssignments) {
    const teacherIdString = String(assignment.teacherId);
    if (!assignmentMap.has(teacherIdString)) {
      assignmentMap.set(teacherIdString, []);
    }
    assignmentMap.get(teacherIdString).push(assignment);
  }

  const formattedFaculty = facultyUsers.map((facultyMember) => {
    const memberIdString = String(facultyMember._id);
    const profile = profileMap.get(memberIdString) || {};
    const memberAssignments = assignmentMap.get(memberIdString) || [];

    return {
      _id: facultyMember._id,
      userId: facultyMember._id,
      fullName: facultyMember.fullName,
      email: facultyMember.email,
      phoneNumber: facultyMember.phoneNumber || '',
      designation: facultyMember.designation || profile.designation || 'Teacher',
      employeeId: profile.employeeId || 'ID-PENDING',
      bpsScale: profile.bpsScale || profile.bps || 'BPS-14',
      qualification: profile.qualification || 'Not Specified',
      joiningDate: profile.joiningDate || facultyMember.createdAt,
      appointmentDate: profile.appointmentDate || null,
      isTeachingStaff: profile.isTeachingStaff !== false,
      specializationSubjects: profile.specializationSubjects || [],
      cnicMasked: maskCnic(profile.cnic),
      status: facultyMember.status,
      activeDutyCount: memberAssignments.length,
      activeAssignments: memberAssignments.map((assignmentItem) => ({
        assignmentId: assignmentItem._id,
        className: assignmentItem.classId?.name,
        sectionName: assignmentItem.sectionId?.name,
        subjectName: assignmentItem.subjectId?.name,
        academicSession: assignmentItem.academicSession,
      })),
    };
  });

  return sendSuccess(response, 200, 'School faculty roster retrieved successfully.', {
    schoolId: effectiveSchoolId,
    totalRecords,
    totalPages: Math.ceil(totalRecords / limitNumber) || 1,
    currentPage: pageNumber,
    pageSize: limitNumber,
    faculty: formattedFaculty,
  });
});

