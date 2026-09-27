import mongoose from 'mongoose';
import { TIMETABLE_SLOT_TYPE, TIMETABLE_STATUS, TIMETABLE_DAYS } from '../../config/constants.js';

const PeriodSlotSchema = new mongoose.Schema({
  periodNumber: {
    type: Number,
    required: true,
  },
  slotType: {
    type: String,
    enum: Object.values(TIMETABLE_SLOT_TYPE),
    default: TIMETABLE_SLOT_TYPE.TEACHING,
    required: true,
  },
  label: {
    type: String,
    required: true,
    trim: true,
  },
  startTime: {
    type: String,
    required: true,
    match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Start time must be in HH:mm 24-hour format'],
  },
  endTime: {
    type: String,
    required: true,
    match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'End time must be in HH:mm 24-hour format'],
  },
}, { _id: false });

const ScheduleEntrySchema = new mongoose.Schema({
  dayOfWeek: {
    type: String,
    enum: TIMETABLE_DAYS,
    required: true,
  },
  periodNumber: {
    type: Number,
    required: true,
  },
  classId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    required: true,
    index: true,
  },
  sectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section',
    required: true,
    index: true,
  },
  subjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    default: null,
  },
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  roomNumber: {
    type: String,
    trim: true,
    default: '',
  },
}, { _id: true });

const TimetableSchema = new mongoose.Schema({
  schoolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    index: true,
  },
  academicYear: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  status: {
    type: String,
    enum: Object.values(TIMETABLE_STATUS),
    default: TIMETABLE_STATUS.ACTIVE,
    index: true,
  },
  version: {
    type: Number,
    default: 1,
  },
  periodSlots: {
    type: [PeriodSlotSchema],
    default: [],
  },
  schedule: {
    type: [ScheduleEntrySchema],
    default: [],
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, { timestamps: true });

/**
 * Partial Unique Index:
 * Only ONE active timetable is permitted per school per academic year.
 */
TimetableSchema.index(
  { schoolId: 1, academicYear: 1 },
  {
    unique: true,
    partialFilterExpression: { status: TIMETABLE_STATUS.ACTIVE },
  }
);

TimetableSchema.index({ 'schedule.teacherId': 1, schoolId: 1, status: 1 });
TimetableSchema.index({ 'schedule.classId': 1, 'schedule.sectionId': 1, status: 1 });

export default mongoose.models.Timetable || mongoose.model('Timetable', TimetableSchema);
