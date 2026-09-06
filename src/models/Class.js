import mongoose from 'mongoose';

const ClassSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  numericGrade: { type: Number, required: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
}, { timestamps: true });

export default mongoose.models.Class || mongoose.model('Class', ClassSchema);
