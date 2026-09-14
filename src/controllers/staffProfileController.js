import asyncHandler from 'express-async-handler';
import PDFDocument from 'pdfkit';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import TeacherProfile from '../models/TeacherProfile.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import ProfileAccessRequest from '../models/ProfileAccessRequest.js';
import { ROLES, SCOPES, USER_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';
import { maskCnic, maskBankAccount } from './approvalController.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';
import { isTargetProtectedFromActor } from '../middlewares/authorizeHierarchy.js';

/**
 * Access Control Evaluator for Staff Profile
 * Evaluates actor's institutional role and administrative scope.
 */
export const evaluateProfileAccess = (actor, targetUser, targetProfile) => {
  if (!actor || !actor.role) return { canView: false, canViewSensitive: false };

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
    .populate('currentSchoolId', 'name code')
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

  // ─── Absolute Privacy Policy: User's explicit PRIVATE settings are respected even by ROOT_ADMIN ───
  const showPhone = isSelf || (privacy.phoneNumber !== 'PRIVATE' && (isPrivilegedAdmin || (privacy.phoneNumber === 'SCHOOL' && access.canView)));
  const showEmail = isSelf || (privacy.email !== 'PRIVATE' && (isPrivilegedAdmin || (privacy.email === 'SCHOOL' && access.canView)));
  const showPhoto = isSelf || privacy.profilePhoto !== 'PRIVATE';
  const showQual = isSelf || privacy.qualification !== 'PRIVATE';

  // Sensitive fields: If set to PRIVATE, ONLY self can view unmasked. Even ROOT_ADMIN receives masked values.
  const canRevealCnic = isSelf || (privacy.cnic !== 'PRIVATE' && access.canViewSensitive);
  const canRevealBank = isSelf || (privacy.bankDetails !== 'PRIVATE' && access.canViewSensitive);

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
      createdAt: targetUser.createdAt,
    },
    profile: targetProfile
      ? {
          fatherName: targetProfile.fatherName,
          dateOfBirth: targetProfile.dateOfBirth,
          employeeId: targetProfile.employeeId,
          appointmentDate: targetProfile.appointmentDate,
          qualification: showQual ? targetProfile.qualification : 'Protected',
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
          approvalHistory: (targetProfile.approvalHistory || []).map((h) => ({
            action: h.action,
            decision: h.decision,
            reason: h.reason,
            actorRole: h.actorRole,
            actorName: h.actorName,
            timestamp: h.timestamp,
          })),
        }
      : null,
    assignments: {
      active: assignments.filter((a) => a.status === TEACHING_ASSIGNMENT_STATUS.ACTIVE),
      history: assignments.filter((a) => a.status !== TEACHING_ASSIGNMENT_STATUS.ACTIVE),
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
 * PATCH /api/v1/staff/:id/privacy
 * Update staff field visibility and PDF consent settings.
 * Strictly enforces policy ceilings: CNIC and Bank Details can NEVER be PUBLIC.
 */
export const handleUpdatePrivacySettings = asyncHandler(async (request, response) => {
  const actor = request.user;
  const targetUserId = request.params.id === 'me' ? actor._id : request.params.id;

  const isSelf = String(actor._id) === String(targetUserId);
  const isRootAdmin = actor.role === ROLES.ROOT_ADMIN;

  if (!isSelf && !isRootAdmin) {
    return sendError(response, 403, 'Unauthorized: You can only configure your own privacy settings.');
  }

  const { fieldVisibility = {}, allowAuthorizedPdfDownload } = request.body;

  // ─── SECURITY CEILING ENFORCEMENT ───────────────────────────────────────────
  // CNIC and Bank Details can NEVER be PUBLIC or SCHOOL-wide on the open internet
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.cnic)) {
    return sendError(response, 400, 'Security Policy Violation: CNIC cannot be exposed publicly or school-wide. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.bankDetails)) {
    return sendError(response, 400, 'Security Policy Violation: Bank Details cannot be exposed publicly or school-wide. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }
  if (['PUBLIC', 'SCHOOL'].includes(fieldVisibility.residentialAddress)) {
    return sendError(response, 400, 'Security Policy Violation: Residential Address cannot be exposed publicly. It must remain AUTHORIZED_ROLE or PRIVATE.');
  }

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId });
  if (!targetProfile) {
    return sendError(response, 404, 'Teacher profile not found.');
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
    downloads: downloads.map((d) => ({
      id: d._id,
      actorName: d.actorName,
      actorRole: d.actorRole,
      actorDesignation: d.actorDesignation,
      downloadedAt: d.createdAt,
      reason: d.reason,
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
