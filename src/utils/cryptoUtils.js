import crypto from 'crypto';

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * @param {string} a 
 * @param {string} b 
 * @returns {boolean}
 */
export const timingSafeStringCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  
  if (bufA.length !== bufB.length) {
    // Perform dummy constant-time comparison to prevent length-leak timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
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
