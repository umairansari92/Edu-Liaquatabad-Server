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

  // Organizational scope (schoolId required for school staff; townId required for office staff)
  schoolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    index: true,
    validate: {
      validator: function () {
        return Boolean(this.schoolId || this.townId);
      },
      message: 'Either schoolId or townId must be specified for StaffAttendanceRecord.',
    },
  },
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },

  // Staff identity
  staffUserId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  staffRole:     { type: String, required: true },
  staffCategory: { type: String },

  // Attendance date (YYYY-MM-DD stored as UTC midnight, PKT business date)
  attendanceDate: { type: Date, required: true, index: true },

  // Server-authoritative submission timestamp (client cannot override)
  submittedAt: { type: Date, required: true, default: Date.now },

  // Self-marked flags
  isHmSelfRecord:         { type: Boolean, default: false },
  isSuperAdminSelfRecord: { type: Boolean, default: false },

  // Operational Origin
  entryMode: {
    type: String,
    enum: ['STAFF_SELF', 'HM_SELF', 'SUPER_ADMIN_PANEL', 'ADMIN_TERMINAL'],
    default: 'STAFF_SELF',
  },
  markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  remarks:  { type: String, trim: true },

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

  // Immutable audit timeline of lifecycle transitions (e.g., rollover absent, late correction)
  statusHistory: [{
    event:          { type: String, required: true },
    previousStatus: { type: String },
    newStatus:      { type: String, required: true },
    changedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt:      { type: Date, default: Date.now },
    reason:         { type: String, trim: true },
    snapshot:       { type: mongoose.Schema.Types.Mixed },
  }],

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
