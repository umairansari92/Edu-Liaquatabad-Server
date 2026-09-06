import mongoose from 'mongoose';

const SectionSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true, index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },
  name: { type: String, required: true, trim: true },
  capacity: { type: Number, default: 40 },
  roomNumber: { type: String, trim: true },
  classTeacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
}, { timestamps: true });

export default mongoose.models.Section || mongoose.model('Section', SectionSchema);
