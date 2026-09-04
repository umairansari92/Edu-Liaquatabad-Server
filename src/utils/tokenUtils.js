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

export const verifyAccessToken = (token) => {
  return jwt.verify(token, getAccessSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
};

export const verifyRefreshToken = (token) => {
  return jwt.verify(token, getRefreshSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
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
