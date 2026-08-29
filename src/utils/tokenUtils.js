import jwt from 'jsonwebtoken';

export const signAccessToken = (payload) => {
  const secret = process.env.JWT_ACCESS_SECRET || 'dev_fallback_access_secret_min_32_chars';
  return jwt.sign(payload, secret, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  });
};

export const signRefreshToken = (payload) => {
  const secret = process.env.JWT_REFRESH_SECRET || 'dev_fallback_refresh_secret_min_32_chars';
  return jwt.sign(payload, secret, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
};

export const verifyAccessToken = (token) => {
  const secret = process.env.JWT_ACCESS_SECRET || 'dev_fallback_access_secret_min_32_chars';
  return jwt.verify(token, secret);
};

export const verifyRefreshToken = (token) => {
  const secret = process.env.JWT_REFRESH_SECRET || 'dev_fallback_refresh_secret_min_32_chars';
  return jwt.verify(token, secret);
};

export const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

export const clearRefreshCookie = (res) => {
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
};
