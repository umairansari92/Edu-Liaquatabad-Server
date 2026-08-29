import mongoose from 'mongoose';
import { ROLES, SCOPES, USER_STATUS } from '../../config/constants.js';

const UserSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },
  assignedSchools: [{ type: mongoose.Schema.Types.ObjectId, ref: 'School' }],

  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  phoneNumber: { type: String, trim: true, default: '' },

  role: {
    type: String,
    enum: Object.values(ROLES),
    required: true,
    index: true,
  },

  scope: {
    type: String,
    enum: Object.values(SCOPES),
    required: true,
  },

  status: {
    type: String,
    enum: Object.values(USER_STATUS),
    default: USER_STATUS.PENDING_APPROVAL,
    index: true,
  },

  approvalDetails: {
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
    correctionRemarks: { type: String, default: '' },
  },

  lastLoginAt: { type: Date },
  refreshTokenHash: { type: String, select: false },
}, { timestamps: true });

export default mongoose.models.User || mongoose.model('User', UserSchema);
