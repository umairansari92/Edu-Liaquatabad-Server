import mongoose from 'mongoose';

const SubjectSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  isElective: { type: Boolean, default: false },
  totalMarks: { type: Number, default: 100 },
  passingMarks: { type: Number, default: 33 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
}, { timestamps: true });

export default mongoose.models.Subject || mongoose.model('Subject', SubjectSchema);
