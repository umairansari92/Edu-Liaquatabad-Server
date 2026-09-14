import mongoose from 'mongoose';

const notificationOutboxSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ['ACADEMIC', 'GOVERNANCE', 'STAFF_PRIVACY', 'ATTENDANCE', 'SECURITY', 'SYSTEM'],
      default: 'SYSTEM',
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    actionLink: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    rawMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    recipientUserIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    audienceCriteria: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxRetries: {
      type: Number,
      default: 5,
    },
    lastError: {
      type: String,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient outbox worker reconciliation
notificationOutboxSchema.index({ status: 1, retryCount: 1, createdAt: 1 });

const NotificationOutbox = mongoose.models.NotificationOutbox || mongoose.model('NotificationOutbox', notificationOutboxSchema);

export default NotificationOutbox;
