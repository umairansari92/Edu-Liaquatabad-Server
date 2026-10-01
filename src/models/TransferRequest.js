import mongoose from 'mongoose';
import { TRANSFER_STATUS, ROLES } from '../../config/constants.js';

const TransferRequestSchema = new mongoose.Schema({
  teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employeeUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  employeeDesignation: { type: String, default: '' },
  fromSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  toSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },

  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  initiatorRole: {
    type: String,
    enum: [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM],
    required: true,
  },

  isEmergencyOverride: { type: Boolean, default: false },
  overrideJustification: { type: String, default: '' },

  reason: { type: String, required: true },
  officialOrderNumber: { type: String, default: '' },
  orderDate: { type: Date },

  status: {
    type: String,
    enum: Object.values(TRANSFER_STATUS),
    default: TRANSFER_STATUS.PENDING_TARGET_HM_APPROVAL,
    index: true,
  },

  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },
  rejectionReason: { type: String, default: '' },

  relievingDetails: {
    relievedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    relievedAt: { type: Date },
    clearanceCertified: { type: Boolean, default: false },
    relievingRemarks: { type: String, default: '' },
    relievingOrderNumber: { type: String, default: '' },
  },

  destinationHMReview: {
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    joiningDateConfirmed: { type: Date },
    hmRemarks: { type: String, default: '' },
  },

  rejectionDetails: {
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
  },

  adminReviewDetails: {
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    decision: { type: String, enum: ['APPROVE', 'CANCEL'] },
    adminRemarks: { type: String, default: '' },
    reassignedOrderNumber: { type: String, default: '' },
  },

  cancellationDetails: {
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, default: '' },
  },
}, { timestamps: true });

// Synchronize teacherUserId and employeeUserId for multi-role staff support
TransferRequestSchema.pre('validate', function (next) {
  if (this.teacherUserId && !this.employeeUserId) {
    this.employeeUserId = this.teacherUserId;
  } else if (this.employeeUserId && !this.teacherUserId) {
    this.teacherUserId = this.employeeUserId;
  }
  if (this.rejectionDetails?.rejectionReason && !this.rejectionReason) {
    this.rejectionReason = this.rejectionDetails.rejectionReason;
  }
  if (this.rejectionReason && (!this.rejectionDetails || !this.rejectionDetails.rejectionReason)) {
    this.rejectionDetails = this.rejectionDetails || {};
    this.rejectionDetails.rejectionReason = this.rejectionReason;
  }
  next();
});

TransferRequestSchema.virtual('sourceSchoolId').get(function () {
  return this.fromSchoolId;
});

TransferRequestSchema.virtual('targetSchoolId').get(function () {
  return this.toSchoolId;
});

TransferRequestSchema.virtual('employeeId').get(function () {
  return this.employeeUserId || this.teacherUserId;
});

TransferRequestSchema.index({ fromSchoolId: 1, status: 1, createdAt: -1 });
TransferRequestSchema.index({ toSchoolId: 1, status: 1, createdAt: -1 });
TransferRequestSchema.index({ teacherUserId: 1, status: 1 });
TransferRequestSchema.index({ employeeUserId: 1, status: 1 });
TransferRequestSchema.index({ officialOrderNumber: 1 }, { sparse: true });

export default mongoose.models.TransferRequest || mongoose.model('TransferRequest', TransferRequestSchema);
