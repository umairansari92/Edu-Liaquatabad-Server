import mongoose from 'mongoose';

/**
 * SecurityLockout Collection
 * Persists rate limits and failed attempt strikes in MongoDB
 * to ensure security rules survive serverless container cold starts.
 */
const SecurityLockoutSchema = new mongoose.Schema({
  targetKey: { type: String, required: true, unique: true, index: true }, // e.g. "email:user@domain.com" or "ip:192.168.1.1"
  lockType: { type: String, enum: ['EMAIL', 'IP', 'DEVICE'], required: true },
  failedAttempts: { type: Number, default: 0 },
  isLocked: { type: Boolean, default: false },
  lockExpiresAt: { type: Date },
  lastAttemptAt: { type: Date, default: Date.now },
  ipAddresses: [{ type: String }],
  deviceFingerprints: [{ type: String }],
  
  // MongoDB TTL index to automatically clean up expired lockout records
  createdAt: { type: Date, default: Date.now, expires: 1800 }, // Auto delete after 30 minutes of inactivity
}, { timestamps: true });

export default mongoose.models.SecurityLockout || mongoose.model('SecurityLockout', SecurityLockoutSchema);
