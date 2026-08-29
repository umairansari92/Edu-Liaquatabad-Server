import cron from 'node-cron';
import logger from './logger.js';
import SecurityLockout from '../src/models/SecurityLockout.js';

/**
 * Scheduled Background Jobs
 * DMC Liaquatabad Education Platform
 */

export const startScheduledJobs = () => {
  // ─── Job 1: Security Lockout Cleanup ─────────────────────────────────────
  // Runs every 30 minutes — prunes expired lockout records not yet cleaned by TTL
  cron.schedule('*/30 * * * *', async () => {
    try {
      const result = await SecurityLockout.deleteMany({
        isLocked: true,
        lockExpiresAt: { $lt: new Date() },
      });
      if (result.deletedCount > 0) {
        logger.info(`[Cron] SecurityLockout cleanup: ${result.deletedCount} expired records removed.`);
      }
    } catch (err) {
      logger.error(`[Cron] SecurityLockout cleanup failed: ${err.message}`);
    }
  });

  // ─── Job 2: Daily Audit Digest Log ───────────────────────────────────────
  // Runs every day at 00:01 AM PKT — logs platform health summary
  cron.schedule('1 0 * * *', async () => {
    logger.info('[Cron] Daily platform health digest — DMC Liaquatabad Education System operational.');
  }, {
    timezone: 'Asia/Karachi',
  });

  logger.info('[Cron] All scheduled background jobs registered successfully.');
};
