/**
 * LeaveRequest Model
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Represents a CL (Casual Leave) or EL (Earned Leave) request for any staff member.
 *
 * POLICY FACTS (Owner-Confirmed):
 *   CL: 24 days per calendar year | Reset: 1 January | No carry-forward
 *   EL: Minimum 3 consecutive calendar days | Admin-level approval ONLY
 *
 * SOURCE TYPES:
 *   TEACHER_INITIATED — staff submitted their own request via platform
 *   HM_INITIATED      — HM created the record on behalf of absent staff
 *   SYSTEM            — automated process (e.g., midnight CL->ABSENT transition)
 */

import mongoose from 'mongoose';
import { LEAVE_TYPE, LEAVE_STATUS, LEAVE_SOURCE } from '../../config/constants.js';

const CorrectionHistorySchema = new mongoose.Schema({
  correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  correctedAt: { type: Date, required: true },
  previousStatus: { type: String, required: true },
  newStatus: { type: String, required: true },
  correctionReason: { type: String, required: true, minlength: [5, 'Correction reason must be at least 5 characters'], trim: true },
  previousState: { type: mongoose.Schema.Types.Mixed },
}, { _id: true, timestamps: false });

const LeaveRequestSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  townId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  staffUserId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  staffRole:     { type: String, required: true },
  staffCategory: { type: String },
  leaveType: { type: String, enum: Object.values(LEAVE_TYPE), required: true, index: true },
  startDate:    { type: Date, required: true, index: true },
  endDate:      { type: Date, required: true, index: true },
  durationDays: { type: Number, required: true, min: 1 },
  reason:    { type: String, required: true, trim: true, minlength: [3, 'Leave reason must be at least 3 characters'] },
  leaveYear: { type: Number, required: true, index: true },
  source: { type: String, enum: Object.values(LEAVE_SOURCE), required: true, index: true },
  status: { type: String, enum: Object.values(LEAVE_STATUS), default: LEAVE_STATUS.PENDING, required: true, index: true },
  submittedAt: { type: Date, required: true, default: Date.now },
  hmInitiatedActorId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  hmInitiatedReason:        { type: String, trim: true },
  hmInitiatedAbsentInstead: { type: Boolean, default: false },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },
  decisionReason: { type: String, trim: true },
  // Two-Tier Earned Leave (EL) Forwarding & Endorsement Fields
  forwardedByHm:        { type: Boolean, default: false, index: true },
  hmForwardedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  hmForwardedAt:        { type: Date },
  hmRecommendationNote: { type: String, trim: true },
  notificationDispatched: {
    submissionNotification:   { type: Boolean, default: false },
    decisionNotificationSent: { type: Boolean, default: false },
  },
  correctionHistory: { type: [CorrectionHistorySchema], default: [] },
  requestFingerprint: { type: String, index: true },
}, { timestamps: true });

LeaveRequestSchema.index(
  { staffUserId: 1, leaveType: 1, startDate: 1, endDate: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' }, name: 'unique_pending_leave_per_staff_date' }
);
LeaveRequestSchema.index({ staffUserId: 1, leaveType: 1, leaveYear: 1, status: 1 });
LeaveRequestSchema.index({ schoolId: 1, status: 1, leaveType: 1, startDate: 1 });

LeaveRequestSchema.virtual('startDatePkt').get(function () {
  if (!this.startDate) return null;
  return this.startDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
});
LeaveRequestSchema.virtual('endDatePkt').get(function () {
  if (!this.endDate) return null;
  return this.endDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
});
LeaveRequestSchema.set('toJSON', { virtuals: true });
LeaveRequestSchema.set('toObject', { virtuals: true });

export default mongoose.models.LeaveRequest || mongoose.model('LeaveRequest', LeaveRequestSchema);
