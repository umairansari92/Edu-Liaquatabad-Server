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
      expiresIn: '5m', // Short-lived 5-minute boundary
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

export const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth', // Restrict cookie delivery strictly to auth endpoints
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

export const clearRefreshCookie = (res) => {
  res.clearCookie('refreshToken', {
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

  const ua = userAgent.trim();

  // Browser detection
  let browser = 'Web Browser';
  if (ua.includes('Edg/')) {
    browser = 'Microsoft Edge';
  } else if (ua.includes('Chrome/') && !ua.includes('Chromium')) {
    browser = 'Google Chrome';
  } else if (ua.includes('Firefox/')) {
    browser = 'Mozilla Firefox';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    browser = 'Apple Safari';
  } else if (ua.includes('PostmanRuntime/')) {
    browser = 'Postman Client';
  }

  // Operating System detection
  let os = 'Unknown OS';
  if (ua.includes('Windows NT 10.0') || ua.includes('Windows NT 11.0')) {
    os = 'Windows';
  } else if (ua.includes('Windows')) {
    os = 'Windows';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    os = 'iOS';
  } else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
    os = 'macOS';
  } else if (ua.includes('Android')) {
    os = 'Android';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  }

  return `${browser} on ${os}`;
};

