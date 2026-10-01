import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_ISSUER = 'liaquatabad-education-dmc';
const JWT_AUDIENCE = 'liaquatabad-education-portal';

const getAccessSecret = () => {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL SECURITY ERROR: JWT_ACCESS_SECRET is required in production.');
    }
    return 'dev_fallback_access_secret_min_32_chars';
  }
  return secret;
};

const getRefreshSecret = () => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL SECURITY ERROR: JWT_REFRESH_SECRET is required in production.');
    }
    return 'dev_fallback_refresh_secret_min_32_chars';
  }
  return secret;
};

const getMfaPendingSecret = () => {
  const secret = process.env.JWT_MFA_PENDING_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL SECURITY ERROR: JWT_MFA_PENDING_SECRET is required in production.');
    }
    return 'dev_fallback_mfa_pending_secret_min_32_chars';
  }
  return secret;
};

export const signAccessToken = (payload) => {
  return jwt.sign(payload, getAccessSecret(), {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
};

export const signRefreshToken = (payload) => {
  return jwt.sign(payload, getRefreshSecret(), {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
};

export const signMfaPendingToken = (payload) => {
  return jwt.sign(
    {
      ...payload,
      tokenType: 'MFA_PENDING',
    },
    getMfaPendingSecret(),
    {
      algorithm: 'HS256',
      expiresIn: '15m', // Relaxed 15-minute window prevents premature timeout
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
};

export const verifyAccessToken = (token) => {
  const decoded = jwt.verify(token, getAccessSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });

  if (decoded && decoded.tokenType === 'MFA_PENDING') {
    throw new Error('Security Error: Intermediate MFA token cannot be used as an access token');
  }

  return decoded;
};

export const verifyRefreshToken = (token) => {
  return jwt.verify(token, getRefreshSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
};

export const verifyMfaPendingToken = (token) => {
  const decoded = jwt.verify(token, getMfaPendingSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });

  if (!decoded || decoded.tokenType !== 'MFA_PENDING') {
    throw new Error('Security Error: Invalid token type for MFA pending ticket');
  }

  return decoded;
};

/**
 * Computes a high-entropy SHA-256 hash of a token for secure database storage
 */
export const hashToken = (token) => {
  if (!token) return '';
  return crypto.createHash('sha256').update(token).digest('hex');
};

export const setRefreshCookie = (response, token) => {
  response.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth', // Restrict cookie delivery strictly to auth endpoints
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

export const clearRefreshCookie = (response) => {
  response.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
  });
};

/**
 * Derives a clean, human-readable device label from a User-Agent string
 * e.g., "Google Chrome on Windows 10/11", "Apple Safari on iOS", etc.
 */
export const parseDeviceLabel = (userAgent) => {
  if (!userAgent || typeof userAgent !== 'string') {
    return 'Unknown Device';
  }

  const normalizedUserAgent = userAgent.trim();

  // Browser detection
  let browser = 'Web Browser';
  if (normalizedUserAgent.includes('Edg/')) {
    browser = 'Microsoft Edge';
  } else if (normalizedUserAgent.includes('Chrome/') && !normalizedUserAgent.includes('Chromium')) {
    browser = 'Google Chrome';
  } else if (normalizedUserAgent.includes('Firefox/')) {
    browser = 'Mozilla Firefox';
  } else if (normalizedUserAgent.includes('Safari/') && !normalizedUserAgent.includes('Chrome')) {
    browser = 'Apple Safari';
  } else if (normalizedUserAgent.includes('PostmanRuntime/')) {
    browser = 'Postman Client';
  }

  // Operating System detection
  let operatingSystem = 'Unknown OS';
  if (normalizedUserAgent.includes('Windows NT 10.0') || normalizedUserAgent.includes('Windows NT 11.0')) {
    operatingSystem = 'Windows';
  } else if (normalizedUserAgent.includes('Windows')) {
    operatingSystem = 'Windows';
  } else if (normalizedUserAgent.includes('iPhone') || normalizedUserAgent.includes('iPad')) {
    operatingSystem = 'iOS';
  } else if (normalizedUserAgent.includes('Macintosh') || normalizedUserAgent.includes('Mac OS X')) {
    operatingSystem = 'macOS';
  } else if (normalizedUserAgent.includes('Android')) {
    operatingSystem = 'Android';
  } else if (normalizedUserAgent.includes('Linux')) {
    operatingSystem = 'Linux';
  }

  return `${browser} on ${operatingSystem}`;
};

