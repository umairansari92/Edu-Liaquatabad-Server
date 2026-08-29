import rateLimit from 'express-rate-limit';
import SecurityLockout from '../models/SecurityLockout.js';
import { evaluateImpossibleTravel } from '../utils/geoVelocityDetector.js';

// Lock 1: IP-Level Global Rate Limiter
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: 'Global IP rate limit exceeded. Please try again after 15 minutes.',
  },
});

// Lock 2: Auth Endpoints Rate Limiter
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 auth attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
  },
});

/**
 * Lock 3: Account-Centric Global Brute-Force Lockout (MongoDB-Backed)
 * Survives Serverless Cold Starts on Vercel
 */
export const checkEmailLockout = async (email, ip) => {
  const targetKey = `email:${email.toLowerCase().trim()}`;
  try {
    const record = await SecurityLockout.findOne({ targetKey });

    if (record && record.isLocked && record.lockExpiresAt) {
      const now = new Date();
      if (now < record.lockExpiresAt) {
        const remainingMinutes = Math.ceil((record.lockExpiresAt.getTime() - now.getTime()) / 60000);
        return {
          locked: true,
          message: `Account is temporarily locked due to repeated failed attempts across network proxies (Security v7.0). Please try again in ${remainingMinutes} minute(s).`,
        };
      } else {
        // Lock has naturally expired, reset status
        await SecurityLockout.deleteOne({ targetKey });
      }
    }
  } catch (err) {
    console.error('[SecurityLockout Error]', err.message);
  }

  return { locked: false };
};

/**
 * Records failed login across rotating IPs in MongoDB
 */
export const recordFailedLogin = async (email, ip, deviceFingerprint = '') => {
  const targetKey = `email:${email.toLowerCase().trim()}`;
  try {
    const record = await SecurityLockout.findOne({ targetKey });
    const now = new Date();

    if (!record) {
      await SecurityLockout.create({
        targetKey,
        lockType: 'EMAIL',
        failedAttempts: 1,
        isLocked: false,
        lastAttemptAt: now,
        ipAddresses: [ip],
        deviceFingerprints: deviceFingerprint ? [deviceFingerprint] : [],
      });
    } else {
      record.failedAttempts += 1;
      record.lastAttemptAt = now;
      if (ip && !record.ipAddresses.includes(ip)) {
        record.ipAddresses.push(ip);
      }
      if (deviceFingerprint && !record.deviceFingerprints.includes(deviceFingerprint)) {
        record.deviceFingerprints.push(deviceFingerprint);
      }

      // If threshold reached, lock for 15 minutes
      if (record.failedAttempts >= 5) {
        record.isLocked = true;
        record.lockExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      }

      await record.save();
    }
  } catch (err) {
    console.error('[RecordFailedLogin Error]', err.message);
  }
};

/**
 * Clears lockout upon verified successful login
 */
export const clearLoginLockout = async (email, ip) => {
  const targetKey = `email:${email.toLowerCase().trim()}`;
  try {
    await SecurityLockout.deleteOne({ targetKey });
  } catch (err) {
    console.error('[ClearLoginLockout Error]', err.message);
  }
};
