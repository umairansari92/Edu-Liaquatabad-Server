import Notification from '../models/Notification.js';
import NotificationOutbox from '../models/NotificationOutbox.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import logger from '../../config/logger.js';

/**
 * Strict Metadata Allowlist per Notification Event Type
 * Blocks any sensitive PII (CNIC, Bank Accounts, Passwords, OTP, Tokens)
 */
export const NOTIFICATION_METADATA_ALLOWLIST = {
  PDF_ACCESS_REQUEST: [
    'accessRequestId',
    'purpose',
    'scope',
    'requesterName',
    'requesterRole',
    'requesterDesignation',
    'schoolName',
    'expiresAt',
  ],
  PDF_ACCESS_APPROVED: [
    'accessRequestId',
    'staffName',
    'staffDesignation',
    'expiresAt',
    'schoolName',
  ],
  PDF_ACCESS_DENIED: [
    'accessRequestId',
    'staffName',
    'staffDesignation',
    'remarks',
    'schoolName',
  ],
  PDF_DOWNLOADED: [
    'actorName',
    'actorRole',
    'purpose',
    'downloadTimestamp',
    'schoolName',
  ],
  HOMEWORK_CREATED: [
    'homeworkId',
    'title',
    'subjectName',
    'className',
    'sectionName',
    'dueDate',
    'teacherName',
  ],
  TRANSFER_STATUS: [
    'transferRequestId',
    'teacherName',
    'fromSchool',
    'toSchool',
    'orderNumber',
  ],
  MEETING_SCHEDULED: [
    'meetingId',
    'title',
    'scheduledAt',
    'venue',
    'organizerName',
  ],
  APPROVAL_REQUIRED: [
    'staffId',
    'staffName',
    'employeeId',
    'designation',
    'schoolName',
  ],
  CIRCULAR: [
    'circularId',
    'title',
    'referenceNumber',
    'publisherName',
  ],
};

/**
 * Sanitizes metadata against explicit allowlist
 */
export const sanitizeNotificationMetadata = (eventType, rawMetadata = {}) => {
  const allowedKeys = NOTIFICATION_METADATA_ALLOWLIST[eventType] || [];
  const cleanMetadata = {};

  for (const key of allowedKeys) {
    if (rawMetadata[key] !== undefined) {
      // Ensure no nested raw objects that could contain leaked PII
      if (typeof rawMetadata[key] === 'object' && !(rawMetadata[key] instanceof Date) && rawMetadata[key] !== null) {
        cleanMetadata[key] = String(rawMetadata[key]._id || rawMetadata[key]);
      } else {
        cleanMetadata[key] = rawMetadata[key];
      }
    }
  }

  return cleanMetadata;
};

/**
 * Central Notification Dispatcher with Outbox Guarantee
 * Dispatches normalized, categorized, and sanitized in-app notifications
 * to target audiences with reliable fallback to MongoDB Outbox.
 */
export const dispatchNotificationEvent = async ({
  eventType,
  category = 'SYSTEM',
  title,
  message,
  actionLink = '',
  rawMetadata = {},
  recipientUserIds = [],
  audienceCriteria = null,
  options = {},
}) => {
  const cleanMetadata = sanitizeNotificationMetadata(eventType, rawMetadata);

  try {
    let targetRecipients = [...recipientUserIds];

    // ─── Audience Resolution ────────────────────────────────────────────────
    if (audienceCriteria) {
      if (audienceCriteria.type === 'CLASS_STUDENTS_AND_PARENTS') {
        const { schoolId, classId, sectionId } = audienceCriteria;
        const query = {};
        if (schoolId) query.schoolId = schoolId;
        if (classId) query.classId = classId;
        if (sectionId) query.sectionId = sectionId;

        const students = await StudentProfile.find(query)
          .select('userId parentUserId')
          .lean();

        for (const student of students) {
          if (student.userId) targetRecipients.push(String(student.userId));
          if (student.parentUserId) targetRecipients.push(String(student.parentUserId));
        }
      } else if (audienceCriteria.type === 'SCHOOL_STAFF') {
        const { schoolId, roles = [] } = audienceCriteria;
        const query = { schoolId, status: 'ACTIVE' };
        if (roles.length > 0) query.role = { $in: roles };

        const staffUsers = await User.find(query).select('_id').lean();
        for (const u of staffUsers) {
          targetRecipients.push(String(u._id));
        }
      } else if (audienceCriteria.type === 'TOWN_OFFICIALS') {
        const { townId, roles = [] } = audienceCriteria;
        const query = { status: 'ACTIVE' };
        if (townId) query.townId = townId;
        if (roles.length > 0) query.role = { $in: roles };

        const officials = await User.find(query).select('_id').lean();
        for (const u of officials) {
          targetRecipients.push(String(u._id));
        }
      }
    }

    // Deduplicate recipient IDs
    const uniqueRecipientIds = Array.from(new Set(targetRecipients.map((id) => String(id))));

    if (uniqueRecipientIds.length === 0) {
      return { success: true, count: 0 };
    }

    const notificationsToInsert = uniqueRecipientIds.map((userId) => ({
      recipientUserId: userId,
      title,
      message,
      notificationType: eventType,
      category,
      actionLink,
      metadata: cleanMetadata,
      isRead: false,
    }));

    await Notification.insertMany(notificationsToInsert, { ordered: false });

    logger.info(`[NotificationDispatcher] Dispatched ${notificationsToInsert.length} notifications for event: ${eventType}`);
    return { success: true, count: notificationsToInsert.length };
  } catch (error) {
    logger.error(`[NotificationDispatcher Error] Primary dispatch failed for ${eventType}: ${error.message}. Routing to Outbox.`);

    // ── Reliable Outbox Fallback (Zero Silent Notification Loss) ──────────────
    try {
      const outboxEntry = await NotificationOutbox.create({
        eventType,
        category,
        title,
        message,
        actionLink,
        rawMetadata: cleanMetadata,
        recipientUserIds: recipientUserIds.map((id) => String(id)),
        audienceCriteria,
        status: 'PENDING',
        retryCount: 0,
        lastError: error.message,
      });

      logger.info(`[NotificationDispatcher] Outbox record ${outboxEntry._id} created for deferred retry.`);
      return { success: true, outboxId: outboxEntry._id, deferred: true };
    } catch (outboxError) {
      logger.error(`[NotificationDispatcher Fatal] Failed to persist outbox record: ${outboxError.message}`);
      return { success: false, error: outboxError.message };
    }
  }
};

/**
 * Reconciles and retries pending outbox notifications
 * @returns {Promise<{ processed: number, failed: number }>}
 */
export const processPendingOutboxNotifications = async () => {
  const pendingRecords = await NotificationOutbox.find({
    status: 'PENDING',
    retryCount: { $lt: 5 },
  }).limit(50);

  let processed = 0;
  let failed = 0;

  for (const record of pendingRecords) {
    try {
      const result = await dispatchNotificationEvent({
        eventType: record.eventType,
        category: record.category,
        title: record.title,
        message: record.message,
        actionLink: record.actionLink,
        rawMetadata: record.rawMetadata,
        recipientUserIds: record.recipientUserIds,
        audienceCriteria: record.audienceCriteria,
      });

      if (result.success && !result.deferred) {
        record.status = 'PROCESSED';
        record.processedAt = new Date();
        await record.save();
        processed++;
      } else {
        record.retryCount += 1;
        record.lastError = result.error || 'Retry attempt failed';
        if (record.retryCount >= record.maxRetries) {
          record.status = 'FAILED';
        }
        await record.save();
        failed++;
      }
    } catch (err) {
      record.retryCount += 1;
      record.lastError = err.message;
      if (record.retryCount >= record.maxRetries) {
        record.status = 'FAILED';
      }
      await record.save();
      failed++;
    }
  }

  return { processed, failed };
};

