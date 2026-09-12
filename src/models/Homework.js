import mongoose from 'mongoose';

const { Schema } = mongoose;
const ObjectId   = Schema.Types.ObjectId;

/**
 * Homework Schema
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * SECURITY INVARIANTS:
 *   1. schoolId, classId, sectionId, subjectId are set exclusively from the
 *      server-verified TeachingAssignment — NEVER from client request body.
 *   2. teachingAssignmentId is the authorization FK proving the teacher was
 *      allowed to create this homework (set at creation time, immutable).
 *   3. Student homework queries filter by StudentProfile.schoolId + classId + sectionId
 *      derived from the authenticated student's profile — not client-supplied IDs.
 *   4. Historical homework records are preserved; records are CANCELLED, not deleted.
 */
const homeworkSchema = new Schema(
  {
    // ── Boundary fields (all server-verified, not client-supplied) ───────────
    schoolId:  { type: ObjectId, ref: 'School',   required: true, index: true },
    classId:   { type: ObjectId, ref: 'Class',    required: true, index: true },
    sectionId: { type: ObjectId, ref: 'Section',  required: true, index: true },
    subjectId: { type: ObjectId, ref: 'Subject',  required: true, index: true },

    // ── Who created it ────────────────────────────────────────────────────────
    teacherId:            { type: ObjectId, ref: 'User', required: true, index: true },
    teachingAssignmentId: {
      type:    ObjectId,
      ref:     'TeachingAssignment',
      required: true,
      // Immutable after creation — proving the teacher was authorized at creation time
    },

    // ── Content ───────────────────────────────────────────────────────────────
    title:       { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 2000 },
    dueDate:     { type: Date, required: true },

    // ── Optional file attachments (Cloudinary) ─────────────────────────────
    attachments: [
      {
        fileName: { type: String, trim: true },
        fileUrl:  { type: String, trim: true },        // Cloudinary secure URL
        fileType: { type: String, enum: ['PDF', 'IMAGE'], default: 'IMAGE' },
        publicId: { type: String, trim: true },         // Cloudinary publicId for deletion
      },
    ],

    // ── Visibility & lifecycle ─────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['ACTIVE', 'EXPIRED', 'CANCELLED'],
      default: 'ACTIVE',
      index:   true,
    },
    visibleToStudents: {
      type:    Boolean,
      default: true,  // Teacher can set false to save as draft before publishing
    },

    // ── Optional remarks by teacher ────────────────────────────────────────
    remarks: { type: String, default: '', maxlength: 500 },
  },
  {
    timestamps: true,
    // Optimize read performance with targeted indexes
    collection: 'homeworks',
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────

// Student homework query: filter by school + class + section + active + visible
homeworkSchema.index({ schoolId: 1, classId: 1, sectionId: 1, status: 1, visibleToStudents: 1 });

// Teacher homework list
homeworkSchema.index({ teacherId: 1, status: 1, createdAt: -1 });

// HM school-wide homework overview
homeworkSchema.index({ schoolId: 1, status: 1, dueDate: -1 });

// Due date index for auto-expiry cron job
homeworkSchema.index({ dueDate: 1, status: 1 });

const Homework = mongoose.model('Homework', homeworkSchema);
export default Homework;
