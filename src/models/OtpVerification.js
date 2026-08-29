import mongoose from 'mongoose';

/**
 * OtpVerification Collection
 * Enterprise OTP tracking with cryptographic hashing and MongoDB TTL auto-cleanup.
 */
const OtpVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  otpHash: { type: String, required: true },
  purpose: {
    type: String,
    enum: ['REGISTRATION', 'PASSWORD_RESET', 'MFA_LOGIN', 'SENSITIVE_ACTION'],
    default: 'REGISTRATION',
    required: true,
  },
  attempts: { type: Number, default: 0, max: 5 },
  resendCount: { type: Number, default: 0, max: 3 },
  lastResentAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },

  // MongoDB TTL index: Document automatically purged 10 minutes after creation
  createdAt: { type: Date, default: Date.now, expires: 600 },
}, { timestamps: true });

// Compound index to quickly fetch active OTP by email and purpose
OtpVerificationSchema.index({ email: 1, purpose: 1 });

export default mongoose.models.OtpVerification || mongoose.model('OtpVerification', OtpVerificationSchema);
