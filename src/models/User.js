import mongoose from 'mongoose';
import { ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';

const UserSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },
  assignedSchools: [{ type: mongoose.Schema.Types.ObjectId, ref: 'School' }],

  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  phoneNumber: { type: String, trim: true, default: '' },

  // Civil Service Title (e.g., "Town Chairman", "Deputy Director of Education", "Head Master")
  designation: { type: String, trim: true, default: '' },

  // System Authority Role
  role: {
    type: String,
    enum: Object.values(ROLES),
    required: true,
    index: true,
  },

  // Operational Scope
  scope: {
    type: String,
    enum: Object.values(SCOPES),
    required: true,
  },

  // Optional Granular Capability Overrides (Bounded by Permission Ceiling)
  customPermissions: [{ type: String }],

  // Lifecycle State
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

  // Security & Session Revocation
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: { type: Date },
  refreshTokenHash: { type: String, select: false },
}, { timestamps: true });

// Virtual to easily read numerical hierarchy level
UserSchema.virtual('roleLevel').get(function () {
  return ROLE_HIERARCHY[this.role] || 0;
});

UserSchema.set('toJSON', { virtuals: true });
UserSchema.set('toObject', { virtuals: true });

export default mongoose.models.User || mongoose.model('User', UserSchema);
