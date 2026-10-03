import Homework from '../models/Homework.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../../config/logger.js';
import { deleteFromCloudinary } from '../utils/cloudinaryUploader.js';

/**
 * 7-Day Homework Attachment Lifecycle Cleanup Service
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * SPECIFICATION & GOVERNANCE RULES:
 * 1. Attachments on homework assignments are temporary learning media (7-day retention).
 * 2. This cleanup service prunes expired Cloudinary assets and removes their references from MongoDB.
 * 3. The parent Homework document is NEVER hard deleted — curriculum history is strictly preserved.
 * 4. Cloudinary deletion is idempotent — assets already missing ('not found') are safely acknowledged.
 * 5. Failures on individual assets are isolated, logged, and will NOT crash the scheduler or block other assets.
 *
 * @param {Object} options
 * @param {Date} [options.referenceDate=new Date()] - Evaluated expiry threshold (defaults to current server time)
 * @returns {Promise<{ scannedHomeworkCount: number, expiredAttachmentsCount: number, deletedAssetsCount: number, failedAssetsCount: number, removedReferencesCount: number }>}
 */
export const cleanupExpiredHomeworkAttachments = async (options = {}) => {
  const referenceDate = options.referenceDate || new Date();
  logger.info(`[HomeworkCleanup] Starting attachment lifecycle sweep at reference time: ${referenceDate.toISOString()}`);

  const cleanupMetrics = {
    scannedHomeworkCount: 0,
    expiredAttachmentsCount: 0,
    deletedAssetsCount: 0,
    failedAssetsCount: 0,
    removedReferencesCount: 0,
  };

  try {
    // 1. Locate all homework documents containing at least one attachment past its expiresAt date
    const expiredHomeworkRecords = await Homework.find({
      'attachments.expiresAt': { $lte: referenceDate },
    });

    cleanupMetrics.scannedHomeworkCount = expiredHomeworkRecords.length;

    if (expiredHomeworkRecords.length === 0) {
      logger.info('[HomeworkCleanup] No expired homework attachments found. Sweep complete.');
      return cleanupMetrics;
    }

    for (const homeworkDocument of expiredHomeworkRecords) {
      const expiredAttachments = (homeworkDocument.attachments || []).filter(
        (attachmentItem) => attachmentItem.expiresAt && new Date(attachmentItem.expiresAt) <= referenceDate
      );

      cleanupMetrics.expiredAttachmentsCount += expiredAttachments.length;

      const successfullyProcessedAttachmentIds = [];

      for (const attachmentItem of expiredAttachments) {
        let isCloudinaryDeletionSuccessful = false;

        // If attachment has a Cloudinary publicId, attempt permanent asset destruction
        if (attachmentItem.publicId) {
          try {
            const targetResourceType =
              attachmentItem.resourceType || (attachmentItem.fileType === 'PDF' ? 'raw' : 'image');

            logger.info(
              `[HomeworkCleanup] Attempting Cloudinary deletion for publicId: ${attachmentItem.publicId} (${targetResourceType}) on homework: ${homeworkDocument._id}`
            );

            const cloudinaryResult = await deleteFromCloudinary(attachmentItem.publicId, targetResourceType);

            // Cloudinary destroy returns { result: 'ok' } or { result: 'not found' }
            if (cloudinaryResult?.result === 'ok' || cloudinaryResult?.result === 'not found') {
              isCloudinaryDeletionSuccessful = true;
              cleanupMetrics.deletedAssetsCount += 1;
            } else {
              logger.warn(
                `[HomeworkCleanup] Cloudinary reported non-ok status: ${JSON.stringify(cloudinaryResult)} for publicId: ${attachmentItem.publicId}`
              );
              // Still consider 'not found' as safe to remove DB reference; otherwise record failure
              if (String(cloudinaryResult?.result || '').toLowerCase().includes('not found')) {
                isCloudinaryDeletionSuccessful = true;
                cleanupMetrics.deletedAssetsCount += 1;
              } else {
                cleanupMetrics.failedAssetsCount += 1;
              }
            }
          } catch (cloudinaryError) {
            cleanupMetrics.failedAssetsCount += 1;
            logger.error(
              `[HomeworkCleanup] Failed to delete Cloudinary asset [${attachmentItem.publicId}] for homework [${homeworkDocument._id}]: ${cloudinaryError.message}`
            );
          }
        } else {
          // No publicId stored (e.g. legacy/mock attachment) — safe to clean reference from DB
          isCloudinaryDeletionSuccessful = true;
        }

        // Only prune from DB if Cloudinary deletion succeeded (or asset was already missing)
        // to prevent leaving un-tracked orphan Cloudinary storage.
        if (isCloudinaryDeletionSuccessful) {
          successfullyProcessedAttachmentIds.push(attachmentItem._id);
        }
      }

      // Pull successfully purged attachments from the homework document
      if (successfullyProcessedAttachmentIds.length > 0) {
        await Homework.updateOne(
          { _id: homeworkDocument._id },
          {
            $pull: {
              attachments: {
                _id: { $in: successfullyProcessedAttachmentIds },
              },
            },
          }
        );

        cleanupMetrics.removedReferencesCount += successfullyProcessedAttachmentIds.length;

        // Write structured audit log for compliance and transparency
        try {
          await AuditLog.create({
            actorId: homeworkDocument.teacherId,
            actorRole: 'SYSTEM_CRON',
            actorName: 'DMC Liaquatabad Lifecycle Scheduler',
            action: 'HOMEWORK_ATTACHMENT_EXPIRED',
            targetModel: 'Homework',
            targetId: homeworkDocument._id,
            targetName: homeworkDocument.title,
            schoolId: homeworkDocument.schoolId,
            previousState: {
              expiredCount: successfullyProcessedAttachmentIds.length,
              attachmentIds: successfullyProcessedAttachmentIds.map((id) => String(id)),
            },
            newState: {
              attachmentsRetentionExpired: true,
              purgedAt: new Date(),
            },
            result: 'SUCCESS',
          });
        } catch (auditError) {
          logger.warn(`[HomeworkCleanup] Audit log creation skipped: ${auditError.message}`);
        }
      }
    }

    logger.info(
      `[HomeworkCleanup] Sweep complete: ${cleanupMetrics.removedReferencesCount} attachments purged across ${cleanupMetrics.scannedHomeworkCount} homework assignments (${cleanupMetrics.failedAssetsCount} failures).`
    );

    return cleanupMetrics;
  } catch (fatalCleanupError) {
    logger.error(`[HomeworkCleanup] Fatal error in attachment lifecycle cleanup sweep: ${fatalCleanupError.message}`);
    return cleanupMetrics;
  }
};

export default {
  cleanupExpiredHomeworkAttachments,
};
