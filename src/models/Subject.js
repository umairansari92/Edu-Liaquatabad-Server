import mongoose from 'mongoose';

const SubjectSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true, index: true },
  name: { type: String, required: true },
  code: { type: String },
  totalMarks: { type: Number, default: 100 },
  passingMarks: { type: Number, default: 33 },
}, { timestamps: true });

export default mongoose.models.Subject || mongoose.model('Subject', SubjectSchema);
