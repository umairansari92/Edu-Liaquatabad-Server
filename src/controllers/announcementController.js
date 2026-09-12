import mongoose from 'mongoose';
import Announcement from '../models/Announcement.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES } from '../../config/constants.js';
import logger from '../../config/logger.js';
import { invalidatePublicStatsCache } from './publicStatsController.js';

const AUTHORIZED_ANNOUNCEMENT_ROLES = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN];

/**
 * Public: Retrieve currently active executive announcement
 * GET /api/v1/announcements/active
 */
export const handleGetActiveAnnouncement = async (request, response, nextFunction) => {
  try {
    const activeAnnouncement = await Announcement.findOne({ status: 'ACTIVE' })
      .sort({ createdAt: -1 })
      .lean();

    return response.status(200).json({
      success: true,
      data: activeAnnouncement || null,
    });
  } catch (error) {
    logger.error(`[Announcement] Failed to fetch active announcement: ${error.message}`);
    return nextFunction(error);
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
  } catch (error) {
    logger.error(`[Announcement] Failed to fetch history: ${error.message}`);
    return nextFunction(error);
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
      eventDate = null,
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
    const newAnnouncementData = {
      title: title.trim(),
      message: message.trim(),
      type: type || 'INFO',
      eventDate: eventDate ? new Date(eventDate) : null,
      announcerName: announcerName.trim(),
      announcerDesignation: announcerDesignation.trim(),
      announcerPhotoUrl: announcerPhotoUrl ? announcerPhotoUrl.trim() : null,
      announcerPhotoPublicId: announcerPhotoPublicId ? announcerPhotoPublicId.trim() : null,
      status: 'ACTIVE',
      postedBy: requestingActor._id,
      townId: requestingActor.townId || null,
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
  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction().catch(() => {});
    }
    logger.error(`[Announcement] Failed to create announcement: ${error.message}`);
    return nextFunction(error);
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
  } catch (error) {
    logger.error(`[Announcement] Failed to archive announcement: ${error.message}`);
    return nextFunction(error);
  }
};
