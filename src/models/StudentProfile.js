import mongoose from 'mongoose';
import { STUDENT_STATUS } from '../../config/constants.js';

const StudentProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', index: true },
  sectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', index: true },

  // ─── Dual Student Numbering & Admission Register Identification ──────────────

  /**
   * GR No (General Register Number)
   * School-scoped sequential integer (e.g. 1045).
   * Unique per school via compound index { schoolId: 1, grNumber: 1 }.
   */
  grNumber: {
    type: Number,
    required: true,
  },

  /**
   * Admission Register Number
   * Human-readable institutional format: {SchoolCode}-{AdmissionYear}-{SequentialNumber}
   * Example: 'LTC045-2026-0001', 'MMHA-2026-0127'
   * Auto-generated server-side; immutable once assigned.
   */
  admissionRegisterNumber: {
    type: String,
    trim: true,
    uppercase: true,
    index: true,
  },

  /**
   * Global Student ID
   * Platform-wide unique identifier: {SchoolCode}-{NNNN} e.g. 'MMHA-0001'
   */
  globalStudentId: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true,
    index: true,
  },

  /**
   * Admission type — distinguishes new admissions from paper records migration
   */
  admissionType: {
    type: String,
    enum: ['NEW_ADMISSION', 'EXISTING_ENTRY'],
    default: 'NEW_ADMISSION',
    required: true,
  },

  // ─── Student Personal Identity ─────────────────────────────────────────────
  studentFullName: { type: String, trim: true },
  dateOfBirth: { type: Date, required: true },
  dateOfBirthInWords: { type: String, trim: true }, // Auto-derived from dateOfBirth
  gender: { type: String, enum: ['MALE', 'FEMALE', 'OTHER'], required: true },
  religion: { type: String, trim: true, default: 'ISLAM' },
  placeOfBirth: { type: String, trim: true },
  studentPhotoUrl: { type: String, trim: true },

  // ─── Parent & Guardian Information ─────────────────────────────────────────
  fatherFullName: { type: String, trim: true },
  motherFullName: { type: String, trim: true },
  relationshipWithStudent: {
    type: String,
    enum: ['FATHER', 'MOTHER', 'GUARDIAN'],
    default: 'FATHER',
    required: true,
  },
  guardianCnicNumber: { type: String, trim: true }, // Masked in audit logs (*****-[last4])
  fatherQualification: { type: String, trim: true },
  motherQualification: { type: String, trim: true },
  fatherOccupation: { type: String, trim: true },
  parentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  // ─── Contact Information & Addresses ───────────────────────────────────────
  permanentResidentialAddress: { type: String, trim: true },
  parentOfficeAddress: { type: String, trim: true },
  guardianCellNumber: { type: String, trim: true },
  guardianEmail: { type: String, trim: true, lowercase: true },
  residencePhoneNumber: { type: String, trim: true },
  businessPhoneNumber: { type: String, trim: true },

  // Legacy field aliases for backwards compatibility with existing modules & tests
  fatherOrGuardianName: { type: String, trim: true },
  guardianContactNumber: { type: String },
  residentialAddress: { type: String, default: '' },
  rollNumber: { type: String },

  // ─── Academic & Admission Data ─────────────────────────────────────────────
  admissionClassRequested: { type: String, trim: true },
  lastSchoolAttended: { type: String, trim: true },
  admissionDate: { type: Date, default: Date.now },
  admissionRemarks: { type: String, trim: true },

  // ─── Transfer History & Identity Persistence ───────────────────────────────
  admissionHistory: [{
    fromSchool: { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
    previousGrNumber: { type: Number },
    previousAdmissionRegisterNumber: { type: String },
    transferDate: { type: Date, default: Date.now },
    remarks: { type: String },
  }],

  // ─── Lifecycle & Metadata ──────────────────────────────────────────────────
  lifecycleStatus: {
    type: String,
    enum: Object.values(STUDENT_STATUS),
    default: STUDENT_STATUS.PENDING_APPROVAL,
    index: true,
  },

  enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  enrolledAt: { type: Date, default: Date.now },

}, { timestamps: true });

// ─── Indexes ──────────────────────────────────────────────────────────────────

// School-scoped unique GR Number
StudentProfileSchema.index({ schoolId: 1, grNumber: 1 }, { unique: true });

// School-scoped unique Admission Register Number
StudentProfileSchema.index({ schoolId: 1, admissionRegisterNumber: 1 }, { unique: true, sparse: true });

// Class roster index
StudentProfileSchema.index({ schoolId: 1, classId: 1, sectionId: 1 });

export default mongoose.models.StudentProfile || mongoose.model('StudentProfile', StudentProfileSchema);
