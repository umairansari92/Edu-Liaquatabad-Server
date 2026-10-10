import cron from 'node-cron';
import logger from './logger.js';
import SecurityLockout from '../src/models/SecurityLockout.js';
import { cleanupExpiredHomeworkAttachments } from '../src/services/homeworkCleanupService.js';
import { reconcileHolidayLifecycle } from '../src/services/holidayLifecycleService.js';

/**
 * Scheduled Background Jobs
 * DMC Liaquatabad Education Platform
 */

export const startScheduledJobs = () => {
  // ─── Startup Lifecycle Reconciler ─────────────────────────────────────────
  // Reconciles any closures that reached date boundaries while server was offline
  reconcileHolidayLifecycle().catch((startupError) => {
    logger.warn(`[Cron Startup] Initial holiday lifecycle reconciliation notice: ${startupError.message}`);
  });

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
    } catch (cleanupError) {
      logger.error(`[Cron] SecurityLockout cleanup failed: ${cleanupError.message}`);
    }
  });

  // ─── Job 2: Daily Audit Digest Log ───────────────────────────────────────
  // Runs every day at 00:01 AM PKT — logs platform health summary
  cron.schedule('1 0 * * *', async () => {
    logger.info('[Cron] Daily platform health digest — DMC Liaquatabad Education System operational.');
  }, {
    timezone: 'Asia/Karachi',
  });

  // ─── Job 3: Daily Homework Attachment Lifecycle Cleanup (7-Day Expiry) ─────
  // Runs every day at 02:00 AM PKT — prunes expired Cloudinary assets & DB references
  cron.schedule('0 2 * * *', async () => {
    try {
      logger.info('[Cron] Starting daily homework attachment lifecycle cleanup...');
      const metrics = await cleanupExpiredHomeworkAttachments();
      logger.info(`[Cron] Homework attachment cleanup complete: ${metrics.removedReferencesCount} attachments purged.`);
    } catch (cronError) {
      logger.error(`[Cron] Homework attachment cleanup encountered an unhandled error: ${cronError.message}`);
    }
  }, {
    timezone: 'Asia/Karachi',
  });

  // ─── Job 4: Daily Holiday & Closure Lifecycle Reconciler ──────────────────
  // Runs every day at 00:01 AM PKT — reconciles SCHEDULED -> ACTIVE and ACTIVE -> EXPIRED
  cron.schedule('1 0 * * *', async () => {
    try {
      logger.info('[Cron] Starting daily holiday & closure lifecycle reconciliation...');
      const summary = await reconcileHolidayLifecycle();
      if (summary.totalTransitions > 0) {
        logger.info(`[Cron] Holiday lifecycle reconciliation complete: ${summary.totalTransitions} transitions logged.`);
      }
    } catch (cronError) {
      logger.error(`[Cron] Holiday lifecycle reconciliation encountered an error: ${cronError.message}`);
    }
  }, {
    timezone: 'Asia/Karachi',
  });

  logger.info('[Cron] All scheduled background jobs registered successfully.');
};
