import mongoose from 'mongoose';
import Announcement from '../models/Announcement.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, AUDIENCE_TYPES } from '../../config/constants.js';
import logger from '../../config/logger.js';
import { invalidatePublicStatsCache } from './publicStatsController.js';

const AUTHORIZED_ANNOUNCEMENT_ROLES = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN];

/**
 * Public/Protected: Retrieve currently active executive announcement
 * GET /api/v1/announcements/active
 * Filters out:
 * 1. Expired announcements (now > expiresAt, or default 7-day TTL if null)
 * 2. Scheduled future announcements (now < scheduledAt)
 * 3. Audience mismatch if actor is authenticated
 */
export const handleGetActiveAnnouncement = async (request, response, nextFunction) => {
  try {
    const currentMoment = new Date();
    const requestingActor = request.user || null;

    const query = { status: 'ACTIVE' };

    // Find latest active announcement
    const activeAnnouncement = await Announcement.findOne(query)
      .sort({ createdAt: -1 })
      .lean();

    if (!activeAnnouncement) {
      return response.status(200).json({
        success: true,
        data: null,
      });
    }

    // 1. Scheduled Publication Window Guard
    if (activeAnnouncement.scheduledAt) {
      const scheduledTime = new Date(activeAnnouncement.scheduledAt).getTime();
      if (!isNaN(scheduledTime) && scheduledTime > currentMoment.getTime()) {
        return response.status(200).json({
          success: true,
          data: null,
        });
      }
    }

    // 2. Explicit Expiry Guard
    if (activeAnnouncement.expiresAt) {
      const expiryTime = new Date(activeAnnouncement.expiresAt).getTime();
      if (!isNaN(expiryTime) && currentMoment.getTime() >= expiryTime) {
        return response.status(200).json({
          success: true,
          data: null,
        });
      }
    } else {
      // Default TTL Guard: Maximum 7 days for general announcements, 3 days for critical
      const createdTime = new Date(activeAnnouncement.createdAt).getTime();
      const maxTtlMs = activeAnnouncement.type === 'CRITICAL' ? (3 * 24 * 60 * 60 * 1000) : (7 * 24 * 60 * 60 * 1000);
      if (currentMoment.getTime() - createdTime > maxTtlMs) {
        return response.status(200).json({
          success: true,
          data: null,
        });
      }
    }

    // 3. Audience Targeting Guard
    if (requestingActor && Array.isArray(activeAnnouncement.targetAudience) && activeAnnouncement.targetAudience.length > 0) {
      const audiences = activeAnnouncement.targetAudience.map((audienceItem) => String(audienceItem).toUpperCase());
      if (!audiences.includes('ALL')) {
        const actorRole = String(requestingActor.role || '').toUpperCase();
        let isAudienceMatched = false;
        if (actorRole === ROLES.TEACHER && audiences.includes(AUDIENCE_TYPES.TEACHERS)) isAudienceMatched = true;
        if (actorRole === ROLES.STUDENT && audiences.includes(AUDIENCE_TYPES.STUDENTS)) isAudienceMatched = true;
        if (actorRole === ROLES.PARENT && audiences.includes(AUDIENCE_TYPES.PARENTS)) isAudienceMatched = true;
        if (actorRole === ROLES.PEON && audiences.includes(AUDIENCE_TYPES.NON_TEACHING_STAFF)) isAudienceMatched = true;
        if (actorRole === ROLES.HM && audiences.includes(AUDIENCE_TYPES.HM)) isAudienceMatched = true;
        if ([ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN].includes(actorRole) &&
            (audiences.includes(AUDIENCE_TYPES.OFFICE_STAFF) || audiences.includes(AUDIENCE_TYPES.GOVERNMENT_OFFICERS))) {
          isAudienceMatched = true;
        }

        if (!isAudienceMatched) {
          return response.status(200).json({
            success: true,
            data: null,
          });
        }
      }
    }

    return response.status(200).json({
      success: true,
      data: activeAnnouncement,
    });
  } catch (announcementFetchError) {
    logger.error(`[Announcement] Failed to fetch active announcement: ${announcementFetchError.message}`);
    return nextFunction(announcementFetchError);
  }
};

/**
 * Protected: Retrieve archived announcement history
 * GET /api/v1/announcements/history
 * Authorized: ROOT_ADMIN, SUPER_ADMIN, ADMIN
 */
export const handleGetAnnouncementHistory = async (request, response, nextFunction) => {
  try {
    const requestingActor = request.user;
    if (!AUTHORIZED_ANNOUNCEMENT_ROLES.includes(requestingActor.role)) {
      return response.status(403).json({
        success: false,
        message: 'Forbidden: Insufficient authority to view executive announcement history.',
      });
    }

    const { page = 1, limit = 20 } = request.query;
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNumber - 1) * limitNumber;

    const [announcements, totalCount] = await Promise.all([
      Announcement.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .populate('postedBy', 'name role designation')
        .populate('archivedBy', 'name role designation')
        .lean(),
      Announcement.countDocuments(),
    ]);

    return response.status(200).json({
      success: true,
      data: {
        announcements,
        pagination: {
          totalCount,
          currentPage: pageNumber,
          totalPages: Math.ceil(totalCount / limitNumber),
        },
      },
    });
  } catch (historyFetchError) {
    logger.error(`[Announcement] Failed to fetch history: ${historyFetchError.message}`);
    return nextFunction(historyFetchError);
  }
};

/**
 * Protected: Post a new executive announcement
 * POST /api/v1/announcements
 * Authorized: ROOT_ADMIN, SUPER_ADMIN, ADMIN
 * Invariant: Exactly ONE active announcement. Archives previous active announcement atomically.
 */
export const handleCreateAnnouncement = async (request, response, nextFunction) => {
  let session = null;
  let useTransaction = true;

  try {
    const requestingActor = request.user;
    if (!AUTHORIZED_ANNOUNCEMENT_ROLES.includes(requestingActor.role)) {
      return response.status(403).json({
        success: false,
        message: 'Forbidden: Insufficient authority to post executive announcements. Only Root, Super Admin, and Admin are permitted.',
      });
    }

    const {
      title,
      message,
      type = 'INFO',
      priority = 'NORMAL',
      targetAudience = ['ALL'],
      eventDate = null,
      scheduledAt = null,
      expiresAt = null,
      schoolId = null,
      announcerName,
      announcerDesignation,
      announcerPhotoUrl = null,
      announcerPhotoPublicId = null,
    } = request.body;

    // Strict Validations
    if (!title || typeof title !== 'string' || !title.trim()) {
      return response.status(400).json({ success: false, message: 'Announcement title is required.' });
    }
    if (title.trim().length > 120) {
      return response.status(400).json({ success: false, message: 'Announcement title cannot exceed 120 characters.' });
    }

    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      return response.status(400).json({ success: false, message: 'Announcement message must be at least 10 characters long.' });
    }
    if (message.trim().length > 1000) {
      return response.status(400).json({ success: false, message: 'Announcement message cannot exceed 1000 characters.' });
    }

    if (!announcerName || typeof announcerName !== 'string' || !announcerName.trim()) {
      return response.status(400).json({ success: false, message: 'Announcer name is required.' });
    }

    if (!announcerDesignation || typeof announcerDesignation !== 'string' || !announcerDesignation.trim()) {
      return response.status(400).json({ success: false, message: 'Announcer designation is required.' });
    }

    const validTypes = ['CRITICAL', 'HOLIDAY', 'EVENT', 'INFO'];
    if (type && !validTypes.includes(type)) {
      return response.status(400).json({
        success: false,
        message: `Invalid announcement type. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    // Session Transaction Initialization: Only attempt if database is connected
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        session = await mongoose.startSession();
        session.startTransaction();
      } catch (sessionError) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Production database must support transactions: ${sessionError.message}`);
        }
        // Non-production fallback only (e.g. local standalone MongoDB during testing)
        logger.warn(`[Announcement] Running without replica-set transaction in ${process.env.NODE_ENV || 'development'} mode: ${sessionError.message}`);
        useTransaction = false;
        session = null;
      }
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Database connection is not active for transaction.');
      }
      useTransaction = false;
      session = null;
    }

    const operationOptions = (useTransaction && session) ? { session } : {};

    // 1. Atomically archive currently active announcement(s)
    await Announcement.updateMany(
      { status: 'ACTIVE' },
      {
        $set: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archivedBy: requestingActor._id,
        },
      },
      operationOptions
    );

    // 2. Insert new active announcement
    const parsedScheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;

    const newAnnouncementData = {
      title: title.trim(),
      message: message.trim(),
      type: type || 'INFO',
      priority: priority || (type === 'CRITICAL' ? 'URGENT' : 'NORMAL'),
      targetAudience: Array.isArray(targetAudience) && targetAudience.length > 0 ? targetAudience : ['ALL'],
      eventDate: eventDate ? new Date(eventDate) : null,
      scheduledAt: parsedScheduledAt && !isNaN(parsedScheduledAt.getTime()) ? parsedScheduledAt : null,
      expiresAt: parsedExpiresAt && !isNaN(parsedExpiresAt.getTime()) ? parsedExpiresAt : null,
      announcerName: announcerName.trim(),
      announcerDesignation: announcerDesignation.trim(),
      announcerPhotoUrl: announcerPhotoUrl ? announcerPhotoUrl.trim() : null,
      announcerPhotoPublicId: announcerPhotoPublicId ? announcerPhotoPublicId.trim() : null,
      status: 'ACTIVE',
      postedBy: requestingActor._id,
      townId: requestingActor.townId || null,
      schoolId: schoolId || requestingActor.schoolId || null,
    };

    const [createdAnnouncement] = await Announcement.create([newAnnouncementData], operationOptions);

    // 3. Commit Transaction
    if (useTransaction && session) {
      await session.commitTransaction();
    }

    // 4. Instantly Invalidate Public Town Stats Cache
    invalidatePublicStatsCache();

    // 5. Immutable Audit Log (Article V.6)
    await AuditLog.create({
      actorId: requestingActor._id,
      actorRole: requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName: requestingActor.name || '',
      action: 'EXECUTIVE_ANNOUNCEMENT_POSTED',
      targetModel: 'Announcement',
      targetId: createdAnnouncement._id,
      targetName: createdAnnouncement.title,
      townId: requestingActor.townId || null,
      schoolId: requestingActor.schoolId || null,
      newState: {
        title: createdAnnouncement.title,
        announcerName: createdAnnouncement.announcerName,
        announcerDesignation: createdAnnouncement.announcerDesignation,
        type: createdAnnouncement.type,
      },
      result: 'SUCCESS',
      reason: 'Published executive town-wide announcement',
      ipAddress: request.ip || '',
      userAgent: request.get('user-agent') || '',
    }).catch((auditError) => {
      logger.error(`[Announcement] AuditLog creation failed: ${auditError.message}`);
    });

    return response.status(201).json({
      success: true,
      message: 'Executive announcement published successfully.',
      data: createdAnnouncement,
    });
  } catch (announcementCreateError) {
    if (useTransaction && session) {
      await session.abortTransaction().catch(() => {});
    }
    logger.error(`[Announcement] Failed to create announcement: ${announcementCreateError.message}`);
    return nextFunction(announcementCreateError);
  } finally {
    if (session) {
      session.endSession().catch(() => {});
    }
  }
};

/**
 * Protected: Archive an active announcement without replacing it
 * PATCH /api/v1/announcements/:id/archive
 * Authorized: ROOT_ADMIN, SUPER_ADMIN, ADMIN
 */
export const handleArchiveAnnouncement = async (request, response, nextFunction) => {
  try {
    const requestingActor = request.user;
    if (!AUTHORIZED_ANNOUNCEMENT_ROLES.includes(requestingActor.role)) {
      return response.status(403).json({
        success: false,
        message: 'Forbidden: Insufficient authority to archive executive announcements.',
      });
    }

    const { id } = request.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return response.status(400).json({ success: false, message: 'Invalid announcement ID.' });
    }

    const announcement = await Announcement.findById(id);
    if (!announcement) {
      return response.status(404).json({ success: false, message: 'Announcement not found.' });
    }

    if (announcement.status === 'ARCHIVED') {
      return response.status(400).json({ success: false, message: 'Announcement is already archived.' });
    }

    announcement.status = 'ARCHIVED';
    announcement.archivedAt = new Date();
    announcement.archivedBy = requestingActor._id;
    await announcement.save();

    // Instantly invalidate public town stats cache
    invalidatePublicStatsCache();

    // Immutable Audit Log
    await AuditLog.create({
      actorId: requestingActor._id,
      actorRole: requestingActor.role,
      actorDesignation: requestingActor.designation || '',
      actorName: requestingActor.name || '',
      action: 'EXECUTIVE_ANNOUNCEMENT_ARCHIVED',
      targetModel: 'Announcement',
      targetId: announcement._id,
      targetName: announcement.title,
      townId: requestingActor.townId || null,
      schoolId: requestingActor.schoolId || null,
      result: 'SUCCESS',
      reason: 'Archived executive announcement',
      ipAddress: request.ip || '',
      userAgent: request.get('user-agent') || '',
    }).catch((auditError) => {
      logger.error(`[Announcement] AuditLog archive failed: ${auditError.message}`);
    });

    return response.status(200).json({
      success: true,
      message: 'Announcement archived successfully.',
      data: announcement,
    });
  } catch (announcementArchiveError) {
    logger.error(`[Announcement] Failed to archive announcement: ${announcementArchiveError.message}`);
    return nextFunction(announcementArchiveError);
  }
};
