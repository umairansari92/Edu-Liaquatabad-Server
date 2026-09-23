/**
 * Municipal School Inspection Model
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Captures field inspection audits, infrastructure assessments,
 * academic verifications, and remedial directives issued by
 * cluster supervisors.
 */

import mongoose from 'mongoose';
import { resolveAcademicSession } from '../services/attendanceRollupService.js';

export const INSPECTION_STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  CLOSED: 'CLOSED',
  // DEFERRED TO FUTURE CROSS-ACTOR GOVERNANCE PHASES:
  // Requires dedicated HM acknowledgment endpoint (PATCH /api/v1/inspections/:id/acknowledge)
  ACKNOWLEDGED_BY_HM: 'ACKNOWLEDGED_BY_HM',
  // Requires Town Education Officer administrative audit endpoint (PATCH /api/v1/inspections/:id/admin-review)
  REVIEWED_BY_ADMIN: 'REVIEWED_BY_ADMIN',
};

export const OVERALL_GRADE = {
  A: 'A', // Exemplary (>= 85%)
  B: 'B', // Satisfactory (70% - 84%)
  C: 'C', // Needs Improvement (50% - 69%)
  D: 'D', // Deficient / Escalated (< 50%)
};

const remedialDirectiveSchema = new mongoose.Schema(
  {
    directiveText: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    priority: {
      type: String,
      enum: ['HIGH', 'MEDIUM', 'LOW'],
      default: 'MEDIUM',
    },
    targetCompletionDate: {
      type: Date,
      required: false,
    },
    status: {
      type: String,
      enum: ['PENDING', 'RESOLVED'],
      default: 'PENDING',
    },
    resolutionNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
  },
  { _id: true }
);

const schoolInspectionSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    supervisorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    inspectionDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    academicSession: {
      type: String,
      required: true,
      trim: true,
      default: () => resolveAcademicSession(),
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(INSPECTION_STATUS),
      default: INSPECTION_STATUS.DRAFT,
      index: true,
    },
    overallGrade: {
      type: String,
      enum: Object.values(OVERALL_GRADE),
      default: OVERALL_GRADE.B,
    },
    summaryScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 75,
    },
    // Category 1: Infrastructure & Facilities
    infrastructure: {
      cleanlinessRating: {
        type: String,
        enum: ['POOR', 'FAIR', 'GOOD', 'EXCELLENT'],
        default: 'GOOD',
      },
      drinkingWaterAvailable: {
        type: Boolean,
        default: true,
      },
      washroomsFunctional: {
        type: Boolean,
        default: true,
      },
      electricityFunctional: {
        type: Boolean,
        default: true,
      },
      boundaryWallSecure: {
        type: Boolean,
        default: true,
      },
      classroomsConditionRating: {
        type: String,
        enum: ['POOR', 'FAIR', 'GOOD', 'EXCELLENT'],
        default: 'GOOD',
      },
      notes: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: '',
      },
    },
    // Category 2: Academic Environment
    academicEnvironment: {
      lessonPlansMaintained: {
        type: Boolean,
        default: true,
      },
      studentNotebooksChecked: {
        type: Boolean,
        default: true,
      },
      timetableCompliance: {
        type: Boolean,
        default: true,
      },
      syllabusProgressRating: {
        type: String,
        enum: ['BEHIND', 'ON_SCHEDULE', 'AHEAD'],
        default: 'ON_SCHEDULE',
      },
      notes: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: '',
      },
    },
    // Category 3: Attendance Spot-Check Verifications
    attendanceAudit: {
      studentsEnrolledCount: {
        type: Number,
        min: 0,
        default: 0,
      },
      physicalHeadcount: {
        type: Number,
        min: 0,
        default: 0,
      },
      headcountDiscrepancy: {
        type: Number,
        default: 0,
      },
      teachersRegisteredCount: {
        type: Number,
        min: 0,
        default: 0,
      },
      teachersPresentCount: {
        type: Number,
        min: 0,
        default: 0,
      },
      unauthorizedTeacherAbsentees: {
        type: Number,
        min: 0,
        default: 0,
      },
      notes: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: '',
      },
    },
    // Category 4: Remedial Directives to Head Master
    remedialDirectives: {
      type: [remedialDirectiveSchema],
      default: [],
    },
    supervisorNotes: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: '',
    },
    resolutionDate: {
      type: Date,
      default: null,
    },
    resolutionNotes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for high-frequency queries
schoolInspectionSchema.index({ supervisorId: 1, inspectionDate: -1 });
schoolInspectionSchema.index({ schoolId: 1, inspectionDate: -1 });
schoolInspectionSchema.index({ status: 1, schoolId: 1 });

const SchoolInspection = mongoose.model('SchoolInspection', schoolInspectionSchema);

export default SchoolInspection;
