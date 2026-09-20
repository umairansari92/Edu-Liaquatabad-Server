import mongoose from 'mongoose';

const ExamSchema = new mongoose.Schema({
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  academicYear: { type: String, required: true },
  title: { type: String, required: true },
  examType: {
    type: String,
    enum: ['MID_TERM', 'FINAL_TERM', 'MONTHLY_TEST', 'ASSESSMENT'],
    required: true,
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: {
    type: String,
    enum: ['UPCOMING', 'ONGOING', 'COMPLETED', 'PUBLISHED', 'CANCELLED'],
    default: 'UPCOMING',
  },
  resultsLastModifiedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// Compound indexes for scoped chronological retrieval and academic session filtering
ExamSchema.index({ schoolId: 1, startDate: -1 });
ExamSchema.index({ schoolId: 1, academicYear: 1, status: 1 });

export default mongoose.models.Exam || mongoose.model('Exam', ExamSchema);
