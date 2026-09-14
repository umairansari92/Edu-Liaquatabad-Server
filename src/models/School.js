import mongoose from 'mongoose';

const SchoolSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', required: true, index: true },
  name: { type: String, required: true, trim: true },
  emisCode: { type: String, unique: true, sparse: true },

  /**
   * schoolCode — Short unique abbreviation used as prefix for global student IDs.
   * e.g. 'MMHA' → student gets 'MMHA-0001', 'MMHA-0002' ...
   * Can ONLY be set/changed by: HM, SUPERVISOR, DDO, SUPER_ADMIN
   */
  schoolCode: {
    type: String,
    trim: true,
    uppercase: true,
    unique: true,
    sparse: true, // null until admin assigns it
    match: [/^[A-Z0-9]{2,10}$/, 'School code must be 2–10 uppercase alphanumeric characters'],
  },
  schoolCodeSetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  schoolCodeSetAt: { type: Date, default: null },

  /**
   * lastGrNumber — Tracks the highest GR No currently issued in this school.
   * Auto-incremented atomically on each new admission.
   * HM can override by providing a manual GR No (for existing/old students).
   */
  lastGrNumber: { type: Number, default: 0 },

  /**
   * lastGlobalSequence — Tracks the last issued global student ID sequence for this school.
   * Format result: {schoolCode}-{padded sequence} e.g. MMHA-0001
   */
  lastGlobalSequence: { type: Number, default: 0 },

  schoolType: {
    type: String,
    enum: ['ECE', 'PRIMARY', 'ELEMENTARY', 'SECONDARY'],
    required: true,
  },
  supportedMediums: {
    type: [String],
    enum: ['URDU', 'ENGLISH', 'SINDHI'],
    default: ['URDU', 'ENGLISH'],
  },
  gradeRange: {
    lowestGrade: { type: String, default: 'KG1' },
    highestGrade: { type: String, default: 'CLASS_5' },
  },
  genderType: {
    type: String,
    enum: ['BOYS', 'GIRLS', 'CO_EDUCATION'],
    required: true,
  },
  address: { type: String, required: true },
  contactPhone: { type: String, default: '' },
  contactEmail: { type: String, default: '' },
  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'CLOSED', 'INACTIVE', 'ARCHIVED'],
    default: 'ACTIVE',
  },

  /**
   * Operational Timings & Attendance Window
   * Configurable per school by ROOT_ADMIN, SUPER_ADMIN, ADMIN.
   * Supports seasonal shifts (summer/winter) and Friday Jummah schedules.
   */
  timings: {
    regular: {
      startTime:             { type: String, default: '08:00' },
      endTime:               { type: String, default: '13:30' },
      attendanceWindowStart: { type: String, default: '07:45' },
      attendanceWindowEnd:   { type: String, default: '14:00' },
    },
    friday: {
      startTime:             { type: String, default: '07:30' },
      endTime:               { type: String, default: '12:00' },
      attendanceWindowStart: { type: String, default: '07:15' },
      attendanceWindowEnd:   { type: String, default: '12:30' },
    },
    allowHmLateOverride: { type: Boolean, default: true },
  },
}, { timestamps: true });

export default mongoose.models.School || mongoose.model('School', SchoolSchema);
