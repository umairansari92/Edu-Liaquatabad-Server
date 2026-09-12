import mongoose from 'mongoose';

const HolidayCalendarSchema = new mongoose.Schema({
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
  title: {
    type: String,
    required: true,
    trim: true,
  },
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 10,
  },
  holidayType: {
    type: String,
    enum: [
      'GAZETTED',
      'SUMMER_BREAK',
      'WINTER_BREAK',
      'RAIN_EMERGENCY',
      'LOCAL_HOLIDAY',
      'EMERGENCY_CLOSURE',
    ],
    required: true,
  },
  startDate: {
    type: String, // "YYYY-MM-DD" in PKT
    required: true,
    match: [/^\d{4}-\d{2}-\d{2}$/, 'startDate must be in YYYY-MM-DD format'],
  },
  endDate: {
    type: String, // "YYYY-MM-DD" in PKT
    required: true,
    match: [/^\d{4}-\d{2}-\d{2}$/, 'endDate must be in YYYY-MM-DD format'],
  },
  showInBanner: {
    type: Boolean,
    default: true,
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

HolidayCalendarSchema.index({ townId: 1, scopeType: 1, status: 1, startDate: 1, endDate: 1 });
HolidayCalendarSchema.index({ schoolId: 1, scopeType: 1, status: 1, startDate: 1, endDate: 1 });

export default mongoose.models.HolidayCalendar || mongoose.model('HolidayCalendar', HolidayCalendarSchema);
