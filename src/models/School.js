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
    enum: ['PRIMARY', 'SECONDARY', 'HIGHER_SECONDARY', 'ELEMENTARY'],
    required: true,
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
}, { timestamps: true });

export default mongoose.models.School || mongoose.model('School', SchoolSchema);
