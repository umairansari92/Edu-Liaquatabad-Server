import mongoose from 'mongoose';
import { TRANSFER_STATUS, ROLES } from '../../config/constants.js';

const TransferRequestSchema = new mongoose.Schema({
  teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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
    default: TRANSFER_STATUS.INITIATED,
    index: true,
  },

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

TransferRequestSchema.index({ fromSchoolId: 1, status: 1, createdAt: -1 });
TransferRequestSchema.index({ toSchoolId: 1, status: 1, createdAt: -1 });
TransferRequestSchema.index({ teacherUserId: 1, status: 1 });
TransferRequestSchema.index({ officialOrderNumber: 1 }, { sparse: true });

export default mongoose.models.TransferRequest || mongoose.model('TransferRequest', TransferRequestSchema);
