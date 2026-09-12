import mongoose from 'mongoose';

const WeeklyOffPatternSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  townId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Town',
    required: true,
    index: true,
  },
  scopeType: {
    type: String,
    enum: ['TOWN', 'SCHOOL'],
    default: 'TOWN',
    required: true,
    index: true,
  },
  schoolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    index: true,
  },
  offDays: {
    type: [{
      type: Number,
      min: 0, // 0 = Sunday
      max: 6, // 6 = Saturday
    }],
    required: true,
    validate: [val => val.length > 0, 'At least one off day must be specified'],
  },
  effectiveFrom: {
    type: Date,
    required: true,
    default: Date.now,
  },
  effectiveTo: {
    type: Date,
    default: null, // null means ongoing indefinitely until amended
  },
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 10,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'CANCELLED'],
    default: 'ACTIVE',
    index: true,
  },
}, { timestamps: true });

WeeklyOffPatternSchema.index({ townId: 1, scopeType: 1, status: 1 });
WeeklyOffPatternSchema.index({ schoolId: 1, scopeType: 1, status: 1 });

export default mongoose.models.WeeklyOffPattern || mongoose.model('WeeklyOffPattern', WeeklyOffPatternSchema);
