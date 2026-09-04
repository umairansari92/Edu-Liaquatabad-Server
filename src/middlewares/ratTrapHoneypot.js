import express from 'express';
import AuditLog from '../models/AuditLog.js';
import SecurityLockout from '../models/SecurityLockout.js';
import { generateDeviceFingerprint } from '../utils/deviceFingerprint.js';

const HONEYPOT_TRAP_FIELDS = [
  '_gotcha',
  '_hp_timestamp',
  '_website_url_trap',
  '_confirm_code_dummy',
  'website_url',
  'comment_body_hidden',
];

/**
 * Traps bot submissions that auto-fill hidden input fields
 */
export const ratTrapHoneypotCheck = async (req, res, next) => {
  const body = req.body || {};
  let triggeredField = null;

  for (const field of HONEYPOT_TRAP_FIELDS) {
    if (body[field] !== undefined && body[field] !== '' && body[field] !== null) {
      triggeredField = field;
      break;
    }
  }

  if (triggeredField) {
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '0.0.0.0';
    const deviceFingerprint = generateDeviceFingerprint(req);

    console.warn(`🚨 [RAT TRAP TRIGGERED] Bot honeypot field [${triggeredField}] filled by IP: ${rawIp}`);

    // Quarantine IP in MongoDB SecurityLockout for 24 hours
    try {
      const lockExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await SecurityLockout.findOneAndUpdate(
        { targetKey: `ip:${rawIp}` },
        {
          $inc: { failedAttempts: 10 },
          $set: { isLocked: true, lockExpiresAt, lastAttemptAt: new Date() },
        },
        { upsert: true }
      );

      // Record Immutable Security Audit Log
      await AuditLog.create({
        actorId: '000000000000000000000000', // Unauthenticated Attacker
        actorRole: 'MALICIOUS_BOT_CRAWLER',
        actorDesignation: 'Honeypot Trap Trigger',
        actorName: 'Automated Bot Attacker',
        action: 'SECURITY_RAT_TRAP_HONEYPOT_TRIGGERED',
        targetModel: 'HoneypotTrap',
        targetId: '000000000000000000000000',
        targetName: req.originalUrl,
        previousState: { field: triggeredField, value: body[triggeredField] },
        newState: { quarantined: true, durationHours: 24, ip: rawIp },
        result: 'DENIED',
        reason: `Automated Bot Trap Triggered: Hidden honeypot field [${triggeredField}] filled.`,
        ipAddress: rawIp,
        userAgent: req.headers['user-agent'] || '',
        requestId: req.headers['x-request-id'] || '',
      });
    } catch (err) {
      console.error('[RatTrap Error]', err.message);
    }

    // Deceptive delayed response to waste bot compute threads (Tarpit)
    return setTimeout(() => {
      res.status(418).json({
        success: false,
        statusCode: 418,
        message: 'Security breach detected. Trap engaged. IP quarantined.',
      });
    }, 2000);
  }

  next();
};

/**
 * Malicious crawler bait router: intercepts probes on common attack surfaces
 */
export const ratTrapBaitRouter = express.Router();

const BAIT_PATHS = [
  '/.env',
  '/.git',
  '/.git/config',
  '/wp-admin',
  '/wp-login.php',
  '/phpmyadmin',
  '/xmlrpc.php',
  '/admin/config.json',
  '/cgi-bin/',
  '/api/v1/debug/secrets',
  '/actuator/health',
  '/console',
  '/.aws/credentials',
  '/config.env',
];

BAIT_PATHS.forEach((path) => {
  ratTrapBaitRouter.all(path, async (req, res) => {
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '0.0.0.0';

    console.warn(`🚨 [RAT TRAP PROBE CAUGHT] Malicious URL crawler probe at [${path}] from IP: ${rawIp}`);

    try {
      const lockExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await SecurityLockout.findOneAndUpdate(
        { targetKey: `ip:${rawIp}` },
        {
          $inc: { failedAttempts: 20 },
          $set: { isLocked: true, lockExpiresAt, lastAttemptAt: new Date() },
        },
        { upsert: true }
      );

      await AuditLog.create({
        actorId: '000000000000000000000000',
        actorRole: 'MALICIOUS_CRAWLER_PROBE',
        actorDesignation: 'Bait Endpoint Trap',
        actorName: 'Malicious Vulnerability Scanner',
        action: 'SECURITY_RAT_TRAP_PROBE_CAUGHT',
        targetModel: 'BaitEndpoint',
        targetId: '000000000000000000000000',
        targetName: path,
        newState: { quarantined: true, durationHours: 48, probedPath: path, ip: rawIp },
        result: 'DENIED',
        reason: `Vulnerability scanning probe caught on decoy honeypot path [${path}].`,
        ipAddress: rawIp,
        userAgent: req.headers['user-agent'] || '',
        requestId: req.headers['x-request-id'] || '',
      });
    } catch (err) {
      console.error('[RatTrap Probe Error]', err.message);
    }

    return setTimeout(() => {
      res.status(418).json({
        success: false,
        statusCode: 418,
        message: 'Decoy path triggered. Your network has been blacklisted and forensic telemetry recorded.',
      });
    }, 3000);
  });
});
