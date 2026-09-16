import mongoose from 'mongoose';

/**
 * CaptchaNonce Schema (SEC-HIGH-03 Distributed Anti-Replay Protection)
 * Persists consumed CAPTCHA nonces in MongoDB with a TTL index to eliminate
 * replay attacks across distributed containers and multi-process workers.
 */
const CaptchaNonceSchema = new mongoose.Schema({
  nonce: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // TTL index: documents are automatically pruned at expiresAt
  },
}, { timestamps: true });

export default mongoose.models.CaptchaNonce || mongoose.model('CaptchaNonce', CaptchaNonceSchema);
