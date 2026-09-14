import asyncHandler from 'express-async-handler';
import Notification from '../models/Notification.js';
import ProfileAccessRequest from '../models/ProfileAccessRequest.js';
import AuditLog from '../models/AuditLog.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { dispatchNotificationEvent } from '../services/notificationDispatcher.js';

/**
 * GET /api/v1/notifications
 * Paginated list of in-app notifications for authenticated user
 */
export const handleGetNotifications = asyncHandler(async (request, response) => {
  const userId = request.user._id;
  const { page = 1, limit = 20, category, unreadOnly } = request.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const filter = { recipientUserId: userId };
  if (category && category !== 'ALL') {
    filter.category = category;
  }
  if (unreadOnly === 'true') {
    filter.isRead = false;
  }

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ recipientUserId: userId, isRead: false }),
  ]);

  return sendSuccess(response, 200, 'Notifications retrieved successfully', {
    notifications,
    unreadCount,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      limit: limitNum,
    },
  });
});

/**
 * PATCH /api/v1/notifications/:id/read
 * Mark single notification as read
 */
export const handleMarkNotificationRead = asyncHandler(async (request, response) => {
  const userId = request.user._id;
  const { id } = request.params;

  const updatedNotification = await Notification.findOneAndUpdate(
    { _id: id, recipientUserId: userId },
    { isRead: true },
    { new: true }
  );

  if (!updatedNotification) {
    return sendError(response, 404, 'Notification not found.');
  }

  const unreadCount = await Notification.countDocuments({ recipientUserId: userId, isRead: false });

  return sendSuccess(response, 200, 'Notification marked as read', {
    notification: updatedNotification,
    unreadCount,
  });
});

/**
 * PATCH /api/v1/notifications/mark-all-read
 * Mark all notifications as read for current user
 */
export const handleMarkAllNotificationsRead = asyncHandler(async (request, response) => {
  const userId = request.user._id;

  await Notification.updateMany(
    { recipientUserId: userId, isRead: false },
    { isRead: true }
  );

  return sendSuccess(response, 200, 'All notifications marked as read', {
    unreadCount: 0,
  });
});

/**
 * POST /api/v1/notifications/access-requests/:id/respond
 * Staff member responds (ALLOW or DENY) to a PDF access consent request.
 * Enforces atomic state transition, ownership, and audit tracking.
 */
export const handleRespondToAccessRequest = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { id } = request.params;
  const { decision, remarks = '' } = request.body;

  if (!['ALLOW', 'DENY'].includes(decision)) {
    return sendError(response, 400, 'Decision must be ALLOW or DENY.');
  }

  const newStatus = decision === 'ALLOW' ? 'APPROVED' : 'DENIED';
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours validity

  // Atomic state transition: Only target staff can respond, and only while PENDING
  const updatedRequest = await ProfileAccessRequest.findOneAndUpdate(
    {
      _id: id,
      targetStaffUserId: actor._id,
      status: 'PENDING',
    },
    {
      status: newStatus,
      decisionDate: now,
      decisionRemarks: remarks.trim(),
      ...(decision === 'ALLOW' ? { expiresAt } : {}),
    },
    { new: true }
  );

  if (!updatedRequest) {
    // Check if it already exists to provide precise error
    const existing = await ProfileAccessRequest.findById(id);
    if (!existing) {
      return sendError(response, 404, 'Access request not found.');
    }
    if (String(existing.targetStaffUserId) !== String(actor._id)) {
      return sendError(response, 403, 'Unauthorized: You can only respond to access requests for your own profile.');
    }
    return sendError(response, 409, `Request has already been ${existing.status.toLowerCase()}.`);
  }

  // Mark the related notification as read
  await Notification.updateMany(
    {
      recipientUserId: actor._id,
      'metadata.accessRequestId': String(updatedRequest._id),
    },
    { isRead: true }
  );

  // Dispatch notification back to the requester
  if (decision === 'ALLOW') {
    await dispatchNotificationEvent({
      eventType: 'PDF_ACCESS_APPROVED',
      category: 'STAFF_PRIVACY',
      title: 'Profile PDF Access Approved',
      message: `${actor.fullName} has approved your request to download their official profile PDF. Valid for 24 hours.`,
      actionLink: `/staff/${actor._id}`,
      rawMetadata: {
        accessRequestId: String(updatedRequest._id),
        staffName: actor.fullName,
        staffDesignation: actor.designation || 'Staff',
        expiresAt,
      },
      recipientUserIds: [String(updatedRequest.requesterId)],
    });
  } else {
    await dispatchNotificationEvent({
      eventType: 'PDF_ACCESS_DENIED',
      category: 'STAFF_PRIVACY',
      title: 'Profile PDF Access Denied',
      message: `${actor.fullName} has declined your request to download their official profile PDF.`,
      actionLink: `/staff/${actor._id}`,
      rawMetadata: {
        accessRequestId: String(updatedRequest._id),
        staffName: actor.fullName,
        staffDesignation: actor.designation || 'Staff',
        remarks: remarks.trim(),
      },
      recipientUserIds: [String(updatedRequest.requesterId)],
    });
  }

  // Immutable Audit Log
  await AuditLog.create({
    actorId: actor._id,
    actorRole: actor.role,
    actorName: actor.fullName,
    actorDesignation: actor.designation || 'Staff',
    action: decision === 'ALLOW' ? 'PROFILE_ACCESS_APPROVED' : 'PROFILE_ACCESS_DENIED',
    targetModel: 'ProfileAccessRequest',
    targetId: updatedRequest._id,
    targetName: updatedRequest.purpose,
    schoolId: updatedRequest.schoolId || actor.schoolId,
    previousState: { status: 'PENDING' },
    newState: { status: newStatus, expiresAt, decisionRemarks: remarks.trim() },
    result: 'SUCCESS',
    reason: remarks.trim() || `Staff member responded with ${decision}`,
  });

  return sendSuccess(response, 200, `Access request successfully ${newStatus.toLowerCase()}.`, {
    accessRequest: updatedRequest,
  });
});
