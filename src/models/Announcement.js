import mongoose from 'mongoose';
import { AUDIENCE_TYPES } from '../../config/constants.js';

const AnnouncementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Announcement title is mandatory'],
      trim: true,
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    message: {
      type: String,
      required: [true, 'Announcement message is mandatory'],
      trim: true,
      minlength: [10, 'Message must be at least 10 characters long'],
      maxlength: [1000, 'Message cannot exceed 1000 characters'],
    },
    type: {
      type: String,
      enum: ['CRITICAL', 'HOLIDAY', 'EVENT', 'INFO'],
      default: 'INFO',
    },
    priority: {
      type: String,
      enum: ['NORMAL', 'IMPORTANT', 'URGENT'],
      default: 'NORMAL',
    },
    targetAudience: [{
      type: String,
      enum: Object.values(AUDIENCE_TYPES),
      default: ['ALL'],
    }],
    eventDate: {
      type: Date,
      default: null,
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    announcerName: {
      type: String,
      required: [true, 'Announcer name is mandatory'],
      trim: true,
    },
    announcerDesignation: {
      type: String,
      required: [true, 'Announcer designation is mandatory'],
      trim: true,
    },
    announcerPhotoUrl: {
      type: String,
      default: null,
      trim: true,
    },
    announcerPhotoPublicId: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'ARCHIVED'],
      default: 'ACTIVE',
      index: true,
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    townId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Town',
      default: null,
      index: true,
    },
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      default: null,
      index: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for fast lookup of active announcement and history queries
AnnouncementSchema.index({ status: 1, createdAt: -1 });
AnnouncementSchema.index({ townId: 1, status: 1 });

const Announcement = mongoose.model('Announcement', AnnouncementSchema);
export default Announcement;
