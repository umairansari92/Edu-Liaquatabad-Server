import mongoose from 'mongoose';

const ResultSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  sectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', required: true },

  subjectMarks: [{
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    subjectName: { type: String, trim: true },
    subComponents: {
      nazra: { type: Number, min: 0, max: 20 },
      written: { type: Number, min: 0, max: 80 },
    },
    obtainedMarks: { type: Number, required: true, min: 0 },
    maxMarks: { type: Number, required: true, default: 100 },
    isGradedOnly: { type: Boolean, default: false },
    letterGrade: { type: String, trim: true, default: '' },
    isPassed: { type: Boolean, required: true },
  }],

  totalObtainedMarks: { type: Number, required: true },
  totalMaxMarks: { type: Number, required: true },
  percentage: { type: Number, required: true },
  grade: { type: String, required: true },
  position: { type: Number },
  rank: { type: Number },
  rankFormatted: { type: String, trim: true },
  resultStatus: {
    type: String,
    enum: ['PASSED', 'FAILED', 'ABSENT'],
    default: 'PASSED',
  },
  remarks: { type: String, default: '' },

  evaluatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedByHM: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    enum: ['DRAFT', 'SUBMITTED', 'VERIFIED_BY_HM', 'PUBLISHED'],
    default: 'DRAFT',
    index: true,
  },
}, { timestamps: true });

ResultSchema.index({ examId: 1, studentId: 1 }, { unique: true });

// Compound index for gazette filtering and in-index percentage sorting
ResultSchema.index({ examId: 1, classId: 1, sectionId: 1, percentage: -1 });

// Compound index for lifecycle status counting (unverified drafts check)
ResultSchema.index({ examId: 1, status: 1 });

export default mongoose.models.Result || mongoose.model('Result', ResultSchema);
