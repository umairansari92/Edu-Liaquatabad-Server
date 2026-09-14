import mongoose from 'mongoose';

/**
 * Notification Schema
 * Backwards-compatible central notification model supporting in-app notifications
 * across Academic, Governance, Staff Privacy, Attendance, and Security domains.
 */
const NotificationSchema = new mongoose.Schema({
  recipientUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  notificationType: {
    type: String,
    enum: [
      'ONBOARDING',
      'TRANSFER',
      'ATTENDANCE',
      'EXAM_RESULT',
      'CIRCULAR',
      'SECURITY_ALERT',
      'PDF_ACCESS_REQUEST',
      'PDF_ACCESS_APPROVED',
      'PDF_ACCESS_DENIED',
      'PDF_DOWNLOADED',
      'HOMEWORK_CREATED',
      'MEETING_SCHEDULED',
      'APPROVAL_REQUIRED',
    ],
    required: true,
    index: true,
  },
  category: {
    type: String,
    enum: ['ACADEMIC', 'GOVERNANCE', 'STAFF_PRIVACY', 'ATTENDANCE', 'SECURITY', 'SYSTEM'],
    default: 'SYSTEM',
    index: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  actionLink: {
    type: String,
    default: '',
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
}, { timestamps: true });

// Compound index for user unread querying
NotificationSchema.index({ recipientUserId: 1, isRead: 1, createdAt: -1 });

export default mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
