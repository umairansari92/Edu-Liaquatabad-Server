/**
 * StaffAttendanceRecord Model
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Tracks individual staff member daily attendance submissions with approval workflow.
 * Separate from the existing Attendance model (which tracks class/section-level student records
 * and teacher daily muster sheets). This model tracks INDIVIDUAL staff self-submissions.
 *
 * APPROVAL FLOW:
 *   School staff (TEACHER, PEON, school roles) -> HM approves
 *   Office staff                               -> Admin approves
 *   HM own record                              -> No approval required (self-effective)
 *
 * 5-MINUTE RELAXATION RULE:
 *   Within 5 minutes of submission: approver may approve without a reason.
 *   After 5 minutes: approver MUST provide a free-text reason (backend enforced).
 */

import mongoose from 'mongoose';
import { STAFF_ATTENDANCE_STATUS } from '../../config/constants.js';

const StaffAttendanceRecordSchema = new mongoose.Schema({

  // Organizational scope
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  townId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },

  // Staff identity
  staffUserId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  staffRole:     { type: String, required: true },
  staffCategory: { type: String },

  // Attendance date (YYYY-MM-DD stored as UTC midnight, PKT business date)
  attendanceDate: { type: Date, required: true, index: true },

  // Server-authoritative submission timestamp (client cannot override)
  submittedAt: { type: Date, required: true, default: Date.now },

  // Whether the HM self-marked (no approval required path)
  isHmSelfRecord: { type: Boolean, default: false },

  // Approval state
  approvalStatus: {
    type: String,
    enum: Object.values(STAFF_ATTENDANCE_STATUS),
    default: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
    index: true,
  },

  // Approver details (null for HM self-records)
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },

  // Server-calculated approval delay in milliseconds from submittedAt
  approvalDelayMs: { type: Number },

  // Mandatory free-text reason when approvalDelayMs > 5 minutes
  // Not required if approvalDelayMs <= 5 minutes.
  lateApprovalReason: { type: String, trim: true },

  // Rejection reason (mandatory on rejection)
  rejectionReason: { type: String, trim: true },

  // Notification tracking
  notificationDispatched: { type: Boolean, default: false },
  notificationDispatchedAt: { type: Date },

}, { timestamps: true });

// Prevent duplicate attendance records for same staff / date
StaffAttendanceRecordSchema.index(
  { staffUserId: 1, attendanceDate: 1 },
  { unique: true, name: 'unique_staff_attendance_per_day' }
);

// Approver dashboard: pending records for a school
StaffAttendanceRecordSchema.index({ schoolId: 1, approvalStatus: 1, attendanceDate: -1 });

export default mongoose.models.StaffAttendanceRecord ||
  mongoose.model('StaffAttendanceRecord', StaffAttendanceRecordSchema);
