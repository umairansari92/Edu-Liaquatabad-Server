import crypto from 'crypto';

/**
 * Computes a deterministic SHA-256 device fingerprint from request metadata
 * @param {Object} req Express request object
 * @returns {string} 64-character hex SHA-256 fingerprint
 */
export const generateDeviceFingerprint = (req) => {
  const userAgent = req.headers['user-agent'] || 'unknown-agent';
  const acceptLanguage = req.headers['accept-language'] || 'unknown-lang';
  const secChUa = req.headers['sec-ch-ua'] || '';
  const clientEntropy = req.headers['x-client-entropy'] || '';

  const rawEntropy = `${userAgent}|${acceptLanguage}|${secChUa}|${clientEntropy}`;
  
  return crypto
    .createHash('sha256')
    .update(rawEntropy)
    .digest('hex');
};
