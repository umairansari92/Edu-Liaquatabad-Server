import mongoose from 'mongoose';
import { TEACHING_ASSIGNMENT_STATUS } from '../../config/constants.js';

const TeachingAssignmentSchema = new mongoose.Schema({
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  schoolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    index: true,
  },
  classId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    required: true,
    index: true,
  },
  sectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section',
    required: true,
    index: true,
  },
  subjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    required: true,
    index: true,
  },
  academicSession: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  effectiveFrom: {
    type: Date,
    default: Date.now,
    required: true,
  },
  effectiveTo: {
    type: Date,
    default: null,
  },
  status: {
    type: String,
    enum: Object.values(TEACHING_ASSIGNMENT_STATUS),
    default: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
    index: true,
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  remarks: {
    type: String,
    default: '',
  },
}, { timestamps: true });

/**
 * Partial Unique Index:
 * Guarantees that at the database layer, NO duplicate ACTIVE assignment can ever exist
 * for the exact same teacher, class, section, subject, and academic session.
 * Historical records (COMPLETED, INACTIVE, TRANSFERRED) remain preserved in place.
 */
TeachingAssignmentSchema.index(
  { teacherId: 1, classId: 1, sectionId: 1, subjectId: 1, academicSession: 1 },
  {
    unique: true,
    partialFilterExpression: { status: TEACHING_ASSIGNMENT_STATUS.ACTIVE },
  }
);

/**
 * Authoritative helper to check if a teacher has active assignment overlap
 */
TeachingAssignmentSchema.statics.findActiveConflict = async function ({
  teacherId,
  classId,
  sectionId,
  subjectId,
  academicSession,
}) {
  return this.findOne({
    teacherId,
    classId,
    sectionId,
    subjectId,
    academicSession,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });
};

/**
 * Authoritative check if teacher is assigned to a section & subject
 * (Strictly uses TeachingAssignment — NEVER relies on classTeacherId)
 */
TeachingAssignmentSchema.statics.isTeacherAssigned = async function ({
  teacherId,
  schoolId,
  sectionId,
  subjectId,
}) {
  const query = {
    teacherId,
    sectionId,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  };
  if (schoolId) query.schoolId = schoolId;
  if (subjectId) query.subjectId = subjectId;

  const assignment = await this.findOne(query);
  return Boolean(assignment);
};

export default mongoose.models.TeachingAssignment || mongoose.model('TeachingAssignment', TeachingAssignmentSchema);
