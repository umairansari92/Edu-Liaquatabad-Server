import mongoose from 'mongoose';
import { TRANSFER_STATUS, ROLES } from '../../config/constants.js';

const TransferRequestSchema = new mongoose.Schema({
  teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  toSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },

  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  initiatorRole: {
    type: String,
    enum: [ROLES.SUPERVISOR, ROLES.DDO, ROLES.CHAIRMAN, ROLES.VICE_CHAIRMAN],
    required: true,
  },

  isEmergencyOverride: { type: Boolean, default: false },
  overrideJustification: { type: String, default: '' },

  reason: { type: String, required: true },
  officialOrderNumber: { type: String, default: '' },

  status: {
    type: String,
    enum: Object.values(TRANSFER_STATUS),
    default: TRANSFER_STATUS.INITIATED,
    index: true,
  },

  destinationHMReview: {
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    joiningDateConfirmed: { type: Date },
    hmRemarks: { type: String, default: '' },
  },
}, { timestamps: true });

export default mongoose.models.TransferRequest || mongoose.model('TransferRequest', TransferRequestSchema);
