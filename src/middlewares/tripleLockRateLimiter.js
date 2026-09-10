import rateLimit from 'express-rate-limit';
import SecurityLockout from '../models/SecurityLockout.js';
import { evaluateImpossibleTravel } from '../utils/geoVelocityDetector.js';

const isDevelopmentEnvironment = process.env.NODE_ENV !== 'production';

// Helper to determine if the request is from local machine in development
const isLocalhostRequest = (incomingRequest) => {
  if (!isDevelopmentEnvironment) return false;
  const clientIpAddress = incomingRequest.ip || incomingRequest.socket?.remoteAddress || '';
  return clientIpAddress === '::1' || clientIpAddress === '127.0.0.1' || clientIpAddress === '::ffff:127.0.0.1';
};

// Lock 1: IP-Level Global Rate Limiter
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopmentEnvironment ? 2000 : 300, // 2000 in dev, 300 in prod
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Global IP rate limit exceeded. Please try again after 15 minutes.',
  },
});

// Lock 2: General Auth Rate Limiter (legacy/general fallback)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopmentEnvironment ? 500 : 30, // 500 in dev, 30 in prod
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
  },
});

// Dedicated Login Limiter (prevents brute-forcing credentials)
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopmentEnvironment ? 200 : 15, // 15 failed logins per 15 min in prod
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many login attempts from this IP. Please try again after 15 minutes.',
  },
});

// Dedicated Captcha Limiter — strict per-IP (no localhost skip; enforced in all envs)
export const captchaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minute window
  max: isDevelopmentEnvironment ? 60 : 30, // 30 captchas per 5 min in prod; 60 in dev
  standardHeaders: true,
  legacyHeaders: false,
  // No localhost skip — CAPTCHA endpoint must be rate-limited in ALL environments
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many CAPTCHA requests. Please wait a few moments before refreshing.',
  },
});

// Dedicated OTP Limiter
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: isDevelopmentEnvironment ? 100 : 10, // 10 OTP dispatches per 10 min
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many OTP requests. Please wait a few minutes before requesting another code.',
  },
});

// Dedicated Registration Limiter
export const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopmentEnvironment ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many registration attempts. Please try again after 15 minutes.',
  },
});

// Dedicated Silent Refresh Token Limiter
export const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopmentEnvironment ? 1000 : 150,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many session refresh attempts. Please re-authenticate.',
  },
});

/**
 * Lock 3: Account-Centric Global Brute-Force Lockout (MongoDB-Backed)
 * Survives Serverless Cold Starts on Vercel
 */
export const checkEmailLockout = async (emailAddress, clientIpAddress) => {
  const targetKey = `email:${emailAddress.toLowerCase().trim()}`;
  try {
    const lockoutRecord = await SecurityLockout.findOne({ targetKey });

    if (lockoutRecord && lockoutRecord.isLocked && lockoutRecord.lockExpiresAt) {
      const currentDate = new Date();
      if (currentDate < lockoutRecord.lockExpiresAt) {
        const remainingMinutes = Math.max(1, Math.ceil((lockoutRecord.lockExpiresAt.getTime() - currentDate.getTime()) / 60000));
        return {
          locked: true,
          minutesRemaining: remainingMinutes,
          message: `Account is temporarily locked due to repeated failed attempts across network proxies (Security v7.0). Please try again in ${remainingMinutes} minute(s).`,
        };
      } else {
        // Lock has naturally expired, reset status
        await SecurityLockout.deleteOne({ targetKey });
      }
    }
  } catch (databaseError) {
    console.error('[SecurityLockout Error]', databaseError.message);
  }

  return { locked: false, minutesRemaining: 0 };
};

/**
 * Records failed login across rotating IPs in MongoDB
 */
export const recordFailedLogin = async (emailAddress, clientIpAddress, deviceFingerprint = '') => {
  const targetKey = `email:${emailAddress.toLowerCase().trim()}`;
  const resolvedIpString = typeof clientIpAddress === 'string' ? clientIpAddress : (clientIpAddress?.ip || '0.0.0.0');

  try {
    let lockoutRecord = await SecurityLockout.findOne({ targetKey });
    const currentDate = new Date();

    if (!lockoutRecord) {
      lockoutRecord = await SecurityLockout.create({
        targetKey,
        lockType: 'EMAIL',
        failedAttempts: 1,
        isLocked: false,
        lastAttemptAt: currentDate,
        ipAddresses: [resolvedIpString],
        deviceFingerprints: deviceFingerprint ? [deviceFingerprint] : [],
      });
    } else {
      lockoutRecord.failedAttempts += 1;
      lockoutRecord.lastAttemptAt = currentDate;
      if (resolvedIpString && !lockoutRecord.ipAddresses.includes(resolvedIpString)) {
        lockoutRecord.ipAddresses.push(resolvedIpString);
      }
      if (deviceFingerprint && !lockoutRecord.deviceFingerprints.includes(deviceFingerprint)) {
        lockoutRecord.deviceFingerprints.push(deviceFingerprint);
      }

      // If threshold reached, lock for 15 minutes
      if (lockoutRecord.failedAttempts >= 5) {
        lockoutRecord.isLocked = true;
        lockoutRecord.lockExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      }

      await lockoutRecord.save();
    }

    return {
      failedAttempts: lockoutRecord.failedAttempts,
      isLocked: lockoutRecord.isLocked,
      lockExpiresAt: lockoutRecord.lockExpiresAt,
    };
  } catch (databaseError) {
    console.error('[RecordFailedLogin Error]', databaseError.message);
    return { failedAttempts: 1, isLocked: false };
  }
};

/**
 * Clears lockout upon verified successful login
 */
export const clearLoginLockout = async (emailAddress, clientIpAddress) => {
  const targetKey = `email:${emailAddress.toLowerCase().trim()}`;
  try {
    await SecurityLockout.deleteOne({ targetKey });
  } catch (databaseError) {
    console.error('[ClearLoginLockout Error]', databaseError.message);
  }
};

