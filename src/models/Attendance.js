import mongoose from 'mongoose';
import { ATTENDANCE_STATUS } from '../../config/constants.js';

const AttendanceSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  attendanceType: {
    type: String,
    enum: ['STUDENT', 'TEACHER'],
    required: true,
    index: true,
  },
  date: { type: Date, required: true, index: true },

  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', index: true },
  sectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', index: true },

  records: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(ATTENDANCE_STATUS), required: true },
    remarks: { type: String, default: '' },
  }],

  entryMode: {
    type: String,
    enum: ['MANUAL_PORTAL', 'SHEET_IMAGE_UPLOAD'],
    default: 'MANUAL_PORTAL',
  },
  sheetImageUrl: { type: String, default: '' },

  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verificationStatus: {
    type: String,
    enum: ['PENDING_VERIFICATION', 'VERIFIED', 'REQUIRES_REVIEW'],
    default: 'PENDING_VERIFICATION',
    index: true,
  },
}, { timestamps: true });

AttendanceSchema.index({ schoolId: 1, attendanceType: 1, date: 1, sectionId: 1 }, { unique: true });

export default mongoose.models.Attendance || mongoose.model('Attendance', AttendanceSchema);
