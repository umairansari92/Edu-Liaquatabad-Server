import mongoose from 'mongoose';
import { TEACHER_STATUS } from '../../config/constants.js';

const TeacherProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  currentSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },
  claimedSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },

  // ─── Personal Information ───────────────────────────────────────────────────
  fatherName: { type: String, trim: true, default: '' },
  dateOfBirth: { type: Date },
  cnic: { type: String, trim: true, index: true }, // Format: 42101-1234567-1
  profilePhoto: {
    secureUrl: { type: String, default: '' },
    publicId: { type: String, default: '' },
  },

  // ─── Employment Information ─────────────────────────────────────────────────
  employeeId: { type: String, trim: true, uppercase: true, index: true }, // Government employee / personal number
  designation: { type: String, default: 'Teacher', trim: true },
  appointmentDate: { type: Date },
  qualification: { type: String, default: '', trim: true },
  joiningDate: { type: Date, default: Date.now },
  isTeachingStaff: { type: Boolean, default: true, index: true },
  specializationSubjects: [{ type: String }],

  // ─── Bank / Payroll Information ─────────────────────────────────────────────
  bankName: { type: String, trim: true, default: '' },
  branchName: { type: String, trim: true, default: '' },
  accountNumber: { type: String, trim: true, default: '' },
  accountTitle: { type: String, trim: true, default: '' },

  // ─── Privacy & Access Control Settings ──────────────────────────────────────
  privacySettings: {
    fieldVisibility: {
      profilePhoto: { type: String, enum: ['PUBLIC', 'SCHOOL', 'PRIVATE'], default: 'PUBLIC' },
      designation: { type: String, enum: ['PUBLIC', 'SCHOOL'], default: 'PUBLIC' },
      qualification: { type: String, enum: ['PUBLIC', 'SCHOOL', 'PRIVATE'], default: 'PUBLIC' },
      phoneNumber: { type: String, enum: ['SCHOOL', 'PRIVATE'], default: 'SCHOOL' },
      email: { type: String, enum: ['SCHOOL', 'PRIVATE'], default: 'SCHOOL' },
      cnic: { type: String, enum: ['AUTHORIZED_ROLE', 'PRIVATE'], default: 'AUTHORIZED_ROLE' },
      bankDetails: { type: String, enum: ['AUTHORIZED_ROLE', 'PRIVATE'], default: 'AUTHORIZED_ROLE' },
      residentialAddress: { type: String, enum: ['AUTHORIZED_ROLE', 'PRIVATE'], default: 'AUTHORIZED_ROLE' },
    },
    allowAuthorizedPdfDownload: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now },
  },

  // ─── Lifecycle & Approval State ─────────────────────────────────────────────
  lifecycleStatus: {
    type: String,
    enum: Object.values(TEACHER_STATUS),
    default: TEACHER_STATUS.PENDING_APPROVAL,
    index: true,
  },
  correctionRemarks: { type: String, default: '' },
  rejectionReason: { type: String, default: '' },

  approvalHistory: [{
    action: {
      type: String,
      enum: ['SUBMITTED', 'CORRECTION_REQUESTED', 'APPROVED', 'REJECTED'],
      required: true,
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    actorName: { type: String },
    decision: { type: String },
    reason: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  }],

  transferHistory: [{
    fromSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
    toSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
    transferRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'TransferRequest' },
    relievedDate: { type: Date },
    joiningDate: { type: Date },
    orderReferenceNumber: { type: String },
  }],
}, { timestamps: true });

export default mongoose.models.TeacherProfile || mongoose.model('TeacherProfile', TeacherProfileSchema);
