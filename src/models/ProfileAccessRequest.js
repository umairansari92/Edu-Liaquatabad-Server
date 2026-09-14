import mongoose from 'mongoose';

/**
 * ProfileAccessRequest
 * Governs the consent lifecycle for accessing and downloading official staff profile dossiers.
 * Supports atomic state transitions: PENDING -> APPROVED | DENIED | EXPIRED | REVOKED.
 */
const ProfileAccessRequestSchema = new mongoose.Schema({
  requesterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  requesterName: {
    type: String,
    required: true,
    trim: true,
  },
  requesterRole: {
    type: String,
    required: true,
  },
  requesterDesignation: {
    type: String,
    default: '',
    trim: true,
  },
  targetStaffUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  schoolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    index: true,
  },
  purpose: {
    type: String,
    required: [true, 'Official purpose is required to request profile access'],
    trim: true,
    maxlength: 300,
  },
  scope: {
    type: String,
    enum: ['OFFICIAL_SERVICE_RECORD', 'EMPLOYMENT_VERIFICATION', 'ANNUAL_AUDIT'],
    default: 'OFFICIAL_SERVICE_RECORD',
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'REVOKED'],
    default: 'PENDING',
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  decisionDate: {
    type: Date,
  },
  decisionRemarks: {
    type: String,
    default: '',
    trim: true,
    maxlength: 300,
  },
  downloadedAt: {
    type: Date,
  },
  downloadCount: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

// Index for finding valid, unexpired approvals
ProfileAccessRequestSchema.index({
  requesterId: 1,
  targetStaffUserId: 1,
  status: 1,
  expiresAt: 1,
});

export default mongoose.models.ProfileAccessRequest || mongoose.model('ProfileAccessRequest', ProfileAccessRequestSchema);
