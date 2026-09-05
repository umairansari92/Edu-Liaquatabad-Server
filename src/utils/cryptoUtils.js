import crypto from 'crypto';

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * @param {string} knownString 
 * @param {string} candidateString 
 * @returns {boolean}
 */
export const timingSafeStringCompare = (knownString, candidateString) => {
  if (typeof knownString !== 'string' || typeof candidateString !== 'string') return false;
  
  const knownBuffer = Buffer.from(knownString);
  const candidateBuffer = Buffer.from(candidateString);
  
  if (knownBuffer.length !== candidateBuffer.length) {
    // Perform dummy constant-time comparison to prevent length-leak timing
    crypto.timingSafeEqual(knownBuffer, knownBuffer);
    return false;
  }
  
  return crypto.timingSafeEqual(knownBuffer, candidateBuffer);
};

/**
 * Generate a cryptographically secure random token (Hex encoded)
 * @param {number} bytes 
 * @returns {string}
 */
export const generateSecureRandomToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString('hex');
};

/**
 * Computes SHA-256 HMAC of a message with server secret
 * @param {string} message 
 * @param {string} secret 
 * @returns {string}
 */
export const computeHmacSha256 = (message, secret) => {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
};
