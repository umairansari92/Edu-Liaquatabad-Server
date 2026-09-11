import asyncHandler from 'express-async-handler';
import PDFDocument from 'pdfkit';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import User from '../models/User.js';
import TeacherProfile from '../models/TeacherProfile.js';
import TeachingAssignment from '../models/TeachingAssignment.js';
import School from '../models/School.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, SCOPES, USER_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';
import { maskCnic, maskBankAccount } from './approvalController.js';

/**
 * Access Control Evaluator for Staff Profile
 */
const evaluateProfileAccess = (actor, targetUser, targetProfile) => {
  if (!actor || !actor.role) return { canView: false, canViewSensitive: false };

  const isSelf = String(actor._id) === String(targetUser._id);
  if (isSelf) {
    return { canView: true, canViewSensitive: true };
  }

  // Root Admin & Super Admin have full access
  if (actor.role === ROLES.ROOT_ADMIN) {
    return { canView: true, canViewSensitive: true };
  }
  if (actor.role === ROLES.SUPER_ADMIN) {
    const isSameTown = actor.townId && targetUser.townId && String(actor.townId) === String(targetUser.townId);
    if (actor.scope === SCOPES.GLOBAL || isSameTown) {
      return { canView: true, canViewSensitive: true };
    }
  }

  // Admin: Town scope
  if (actor.role === ROLES.ADMIN) {
    const isSameTown = actor.townId && targetUser.townId && String(actor.townId) === String(targetUser.townId);
    if (isSameTown) {
      return { canView: true, canViewSensitive: true };
    }
  }

  // Supervisor: Assigned schools
  const targetSchoolId = targetUser.schoolId || targetUser.claimedSchoolId || targetProfile?.currentSchoolId || targetProfile?.claimedSchoolId;
  if (actor.role === ROLES.SUPERVISOR) {
    if (targetSchoolId) {
      const assigned = (actor.assignedSchools || []).map((s) => String(s._id || s));
      if (assigned.includes(String(targetSchoolId))) {
        return { canView: true, canViewSensitive: false }; // Masked sensitive
      }
    }
  }

  // HM: Same school only
  if (actor.role === ROLES.HM) {
    if (actor.schoolId && targetSchoolId && String(actor.schoolId._id || actor.schoolId) === String(targetSchoolId)) {
      return { canView: true, canViewSensitive: true };
    }
  }

  // Unauthorized (other teachers, students, parents)
  return { canView: false, canViewSensitive: false };
};

/**
 * GET /api/v1/staff/:id/profile
 * Retrieves detailed staff profile with ABAC sensitive field protection
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

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId })
    .populate('currentSchoolId', 'name code')
    .lean();

  const access = evaluateProfileAccess(actor, targetUser, targetProfile);
  if (!access.canView) {
    return sendError(response, 403, 'Access denied. You do not have authorization to view this staff profile.');
  }

  // Fetch teaching assignments if teacher
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

  // Format response with strict sensitive data masking/omission
  const responseData = {
    user: {
      id: targetUser._id,
      fullName: targetUser.fullName,
      email: targetUser.email,
      phoneNumber: targetUser.phoneNumber,
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
          qualification: targetProfile.qualification,
          joiningDate: targetProfile.joiningDate,
          isTeachingStaff: targetProfile.isTeachingStaff,
          lifecycleStatus: targetProfile.lifecycleStatus,
          profilePhoto: targetProfile.profilePhoto,
          // Sensitive Fields: returned full if authorized, masked/omitted otherwise
          cnic: access.canViewSensitive ? targetProfile.cnic : maskCnic(targetProfile.cnic),
          bankName: access.canViewSensitive ? targetProfile.bankName : (targetProfile.bankName ? 'Provided' : ''),
          branchName: access.canViewSensitive ? targetProfile.branchName : '****',
          accountNumber: access.canViewSensitive ? targetProfile.accountNumber : maskBankAccount(targetProfile.accountNumber),
          accountTitle: access.canViewSensitive ? targetProfile.accountTitle : '****',
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
  };

  return sendSuccess(response, 200, 'Staff profile retrieved successfully.', responseData);
});

/**
 * GET /api/v1/staff/:id/pdf
 * Server-side generation of official Government Service Record PDF using pdfkit.
 * Audited, access-controlled, and stream-delivered.
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

  const targetProfile = await TeacherProfile.findOne({ userId: targetUserId }).lean();
  const access = evaluateProfileAccess(actor, targetUser, targetProfile);

  if (!access.canView) {
    return sendError(response, 403, 'Access denied. You do not have permission to download this staff profile PDF.');
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

  // Response headers for PDF streaming
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

  // ─── Section: Personal & Employment Information ─────────────────────────────
  doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('1. PERSONAL & EMPLOYMENT INFORMATION', 40, yPos);
  doc.moveTo(40, yPos + 14).lineTo(555, yPos + 14).strokeColor('#cbd5e1').stroke();
  yPos += 20;

  doc.fontSize(9).font('Helvetica');
  const personalInfo = [
    ['Full Name:', targetUser.fullName || 'N/A', "Father's Name:", targetProfile?.fatherName || 'N/A'],
    ['Official Email:', targetUser.email || 'N/A', 'Contact Phone:', targetUser.phoneNumber || 'N/A'],
    ['Date of Birth:', targetProfile?.dateOfBirth ? new Date(targetProfile.dateOfBirth).toLocaleDateString() : 'N/A', 'CNIC:', access.canViewSensitive ? (targetProfile?.cnic || 'N/A') : maskCnic(targetProfile?.cnic)],
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

  // ─── Section: Bank & Payroll Details (Only if authorized) ───────────────────
  doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('2. BANK & DISBURSEMENT DETAILS', 40, yPos);
  doc.moveTo(40, yPos + 14).lineTo(555, yPos + 14).strokeColor('#cbd5e1').stroke();
  yPos += 20;

  if (access.canViewSensitive) {
    doc.fontSize(9).font('Helvetica');
    const bankInfo = [
      ['Bank Name:', targetProfile?.bankName || 'N/A', 'Branch:', targetProfile?.branchName || 'N/A'],
      ['Account Title:', targetProfile?.accountTitle || 'N/A', 'Account Number:', targetProfile?.accountNumber || 'N/A'],
    ];
    for (const row of bankInfo) {
      doc.font('Helvetica-Bold').text(row[0], 40, yPos, { width: 110 });
      doc.font('Helvetica').text(row[1], 150, yPos, { width: 150 });
      doc.font('Helvetica-Bold').text(row[2], 310, yPos, { width: 110 });
      doc.font('Helvetica').text(row[3], 420, yPos, { width: 135 });
      yPos += 16;
    }
  } else {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#64748b')
      .text('Bank & Payroll disbursement details are restricted by institutional privacy policy.', 40, yPos);
    yPos += 16;
  }

  yPos += 10;

  // ─── Section: Teaching Assignments (Teachers Only) ──────────────────────────
  if (targetProfile?.isTeachingStaff) {
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('3. AUTHORITATIVE TEACHING ASSIGNMENTS', 40, yPos);
    doc.moveTo(40, yPos + 14).lineTo(555, yPos + 14).strokeColor('#cbd5e1').stroke();
    yPos += 20;

    // Table Header
    doc.rect(40, yPos, 515, 18).fill('#e2e8f0');
    doc.fillColor('#0f172a').fontSize(8).font('Helvetica-Bold');
    doc.text('CLASS & SECTION', 45, yPos + 5, { width: 110 });
    doc.text('SUBJECT', 160, yPos + 5, { width: 130 });
    doc.text('SESSION', 295, yPos + 5, { width: 80 });
    doc.text('EFFECTIVE PERIOD', 380, yPos + 5, { width: 100 });
    doc.text('STATUS', 485, yPos + 5, { width: 65 });
    yPos += 20;

    if (assignments.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b')
        .text('No formal teaching assignments registered.', 45, yPos + 4);
      yPos += 16;
    } else {
      doc.fontSize(8).font('Helvetica').fillColor('#0f172a');
      for (const a of assignments) {
        if (yPos > 730) {
          doc.addPage();
          yPos = 40;
        }
        const classSec = `${a.classId?.name || 'Class'} (${a.sectionId?.name || 'Sec'})`;
        const subj = `${a.subjectId?.name || 'Subject'} [${a.subjectId?.code || ''}]`;
        const fromDate = a.effectiveFrom ? new Date(a.effectiveFrom).toLocaleDateString() : '';
        const toDate = a.effectiveTo ? new Date(a.effectiveTo).toLocaleDateString() : 'Present';
        const period = `${fromDate} - ${toDate}`;

        doc.text(classSec, 45, yPos, { width: 110 });
        doc.text(subj, 160, yPos, { width: 130 });
        doc.text(a.academicSession || 'N/A', 295, yPos, { width: 80 });
        doc.text(period, 380, yPos, { width: 100 });
        doc.font(a.status === 'ACTIVE' ? 'Helvetica-Bold' : 'Helvetica')
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
    .text(`Generated By: ${actor.fullName} (${actor.role}) | Access Token: Authenticated`, 50, yPos + 18)
    .text(`Generation Timestamp: ${new Date().toISOString()} | Target ID: ${targetUser._id}`, 50, yPos + 28)
    .text('Notice: This document is an official government administrative record. Tampering is punishable under applicable cyber and civil laws.', 50, yPos + 38);

  doc.end();

  // Audit PDF Generation (ZERO sensitive details in log)
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorDesignation: actor.designation,
    actorName: actor.fullName,
    action: 'STAFF_PROFILE_PDF_DOWNLOADED',
    targetModel: 'User',
    targetId: targetUser._id,
    targetName: targetUser.fullName,
    townId: targetUser.townId,
    schoolId: targetUser.schoolId?._id || targetUser.schoolId,
    newState: { employeeId: cleanEmpId, downloadedAt: new Date() },
    result: 'SUCCESS',
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });
});
