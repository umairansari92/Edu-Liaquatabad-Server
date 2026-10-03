import mongoose from 'mongoose';

/**
 * Idempotency Record Model
 * Guarantees that mutating operations (POST, PATCH, PUT, DELETE) executed with an Idempotency-Key
 * cannot produce duplicate database writes or conflicting state on network timeouts/retries.
 * 
 * Auto-expires via MongoDB native TTL index after 24 hours.
 */
const IdempotencyRecordSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    endpoint: {
      type: String,
      required: true,
      trim: true,
    },
    requestFingerprint: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'RESOLVED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    responseStatusCode: {
      type: Number,
      default: null,
    },
    responseHeaders: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // Native MongoDB TTL index
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: One key per user guarantees no race conditions or duplicate in-flight requests
IdempotencyRecordSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

const IdempotencyRecord = mongoose.model('IdempotencyRecord', IdempotencyRecordSchema);

export default IdempotencyRecord;
