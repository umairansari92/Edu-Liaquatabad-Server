import mongoose from 'mongoose';

const AttendanceSummarySchema = new mongoose.Schema({
  entityType: {
    type: String,
    enum: ['STUDENT', 'STAFF'],
    default: 'STUDENT',
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  studentProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudentProfile',
    index: true,
  },
  schoolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    index: true,
  },
  classId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    index: true,
  },
  sectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section',
    index: true,
  },
  academicSession: {
    type: String, // e.g. "2025-2026"
    required: true,
    index: true,
  },
  year: {
    type: Number,
    required: true,
    min: 2020,
    max: 2100,
  },
  month: {
    type: Number, // 1 - 12
    required: true,
    min: 1,
    max: 12,
  },

  totalWorkingDays: {
    type: Number,
    default: 0,
    min: 0,
  },
  presentDays: {
    type: Number,
    default: 0,
    min: 0,
  },
  absentDays: {
    type: Number,
    default: 0,
    min: 0,
  },
  leaveDays: {
    type: Number,
    default: 0,
    min: 0,
  },

  lastCalculatedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

// Compound unique index: Exactly one summary per user per month in an academic session
AttendanceSummarySchema.index(
  { userId: 1, academicSession: 1, year: 1, month: 1 },
  { unique: true }
);

// High-speed section-level and school-level rollups
AttendanceSummarySchema.index(
  { sectionId: 1, academicSession: 1, year: 1, month: 1 }
);
AttendanceSummarySchema.index(
  { schoolId: 1, academicSession: 1, year: 1, month: 1 }
);

export default mongoose.models.AttendanceSummary || mongoose.model('AttendanceSummary', AttendanceSummarySchema);
