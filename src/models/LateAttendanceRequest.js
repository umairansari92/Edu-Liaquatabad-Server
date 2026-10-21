import mongoose from 'mongoose';

/**
 * LateAttendanceRequest Schema
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Governs official teacher requests for late classroom attendance clearance
 * after the configured Pakistan Standard Time (Asia/Karachi) submission window has closed.
 *
 * Enforces:
 * 1. Concurrency-safe partial unique index: strictly ONE pending request per teacher + section + date.
 * 2. Mandatory justification reason (min 5, max 500 characters).
 * 3. Immutable audit fields on HM decision.
 * 4. Bound expiry timestamp (`unlockedUntil`).
 */
const LateAttendanceRequestSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
    },
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      required: true,
      index: true,
    },
    teacherUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    teacherName: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    datePkt: {
      type: String,
      required: true,
      index: true,
    },
    reason: {
      type: String,
      required: [true, 'Justification reason is required for late attendance clearance.'],
      minlength: [5, 'Reason must be at least 5 characters.'],
      maxlength: [500, 'Reason cannot exceed 500 characters.'],
      trim: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
      default: 'PENDING',
      index: true,
    },
    unlockedUntil: {
      type: Date,
      index: true,
    },
    decisionBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    decisionByName: {
      type: String,
      default: '',
      trim: true,
    },
    decisionAt: {
      type: Date,
    },
    decisionRemarks: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Concurrency-safe partial unique index:
// Allows multiple historical REJECTED / EXPIRED requests, but strictly prevents duplicate PENDING requests
LateAttendanceRequestSchema.index(
  { sectionId: 1, datePkt: 1, teacherUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } }
);

// High-performance compound index for active clearance lookups during attendance window gating
LateAttendanceRequestSchema.index({
  sectionId: 1,
  datePkt: 1,
  teacherUserId: 1,
  status: 1,
  unlockedUntil: 1,
});

export default mongoose.models.LateAttendanceRequest ||
  mongoose.model('LateAttendanceRequest', LateAttendanceRequestSchema);
