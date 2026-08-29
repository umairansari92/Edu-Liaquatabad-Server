import mongoose from 'mongoose';
import { TEACHER_STATUS } from '../../config/constants.js';

const TeacherProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  currentSchoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },

  employeeId: { type: String, trim: true }, // TBD employee ID format
  designation: { type: String, default: 'Teacher' },
  qualification: { type: String, default: '' },
  specializationSubjects: [{ type: String }],
  joiningDate: { type: Date, default: Date.now },

  lifecycleStatus: {
    type: String,
    enum: Object.values(TEACHER_STATUS),
    default: TEACHER_STATUS.PENDING_APPROVAL,
    index: true,
  },

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
