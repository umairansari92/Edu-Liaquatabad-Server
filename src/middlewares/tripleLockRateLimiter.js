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

