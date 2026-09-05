import crypto from 'crypto';

/**
 * Computes a deterministic SHA-256 device fingerprint from request metadata
 * @param {Object} incomingRequest Express request object
 * @returns {string} 64-character hex SHA-256 fingerprint
 */
export const generateDeviceFingerprint = (incomingRequest) => {
  const userAgent = incomingRequest.headers['user-agent'] || 'unknown-agent';
  const acceptLanguage = incomingRequest.headers['accept-language'] || 'unknown-lang';
  const secChUa = incomingRequest.headers['sec-ch-ua'] || '';
  const clientEntropy = incomingRequest.headers['x-client-entropy'] || '';

  const rawEntropy = `${userAgent}|${acceptLanguage}|${secChUa}|${clientEntropy}`;
  
  return crypto
    .createHash('sha256')
    .update(rawEntropy)
    .digest('hex');
};
