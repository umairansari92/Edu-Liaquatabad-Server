/**
 * School Inspection Validation Schemas (Zod)
 * Education Department Liaquatabad Town Centre (DMC)
 */

import { z } from 'zod';
import { INSPECTION_STATUS, OVERALL_GRADE } from '../models/SchoolInspection.js';

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const remedialDirectiveInputSchema = z.object({
  directiveText: z.string().min(5, 'Directive text must be at least 5 characters').max(1000),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  targetCompletionDate: z.string().optional().nullable(),
  status: z.enum(['PENDING', 'RESOLVED']).default('PENDING'),
  resolutionNotes: z.string().max(1000).optional().default(''),
});

export const createSchoolInspectionSchema = z.object({
  body: z.object({
    schoolId: z.string().regex(objectIdRegex, 'Invalid school ID format'),
    inspectionDate: z.string().optional(),
    academicSession: z.string().optional(),
    overallGrade: z.enum(Object.values(OVERALL_GRADE)).optional(),
    summaryScore: z.number().min(0).max(100).optional(),
    infrastructure: z
      .object({
        cleanlinessRating: z.enum(['POOR', 'FAIR', 'GOOD', 'EXCELLENT']).optional(),
        drinkingWaterAvailable: z.boolean().optional(),
        washroomsFunctional: z.boolean().optional(),
        electricityFunctional: z.boolean().optional(),
        boundaryWallSecure: z.boolean().optional(),
        classroomsConditionRating: z.enum(['POOR', 'FAIR', 'GOOD', 'EXCELLENT']).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    academicEnvironment: z
      .object({
        lessonPlansMaintained: z.boolean().optional(),
        studentNotebooksChecked: z.boolean().optional(),
        timetableCompliance: z.boolean().optional(),
        syllabusProgressRating: z.enum(['BEHIND', 'ON_SCHEDULE', 'AHEAD']).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    attendanceAudit: z
      .object({
        studentsEnrolledCount: z.number().min(0).optional(),
        physicalHeadcount: z.number().min(0).optional(),
        headcountDiscrepancy: z.number().optional(),
        teachersRegisteredCount: z.number().min(0).optional(),
        teachersPresentCount: z.number().min(0).optional(),
        unauthorizedTeacherAbsentees: z.number().min(0).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    remedialDirectives: z.array(remedialDirectiveInputSchema).optional(),
    supervisorNotes: z.string().max(4000).optional(),
    status: z.enum([INSPECTION_STATUS.DRAFT, INSPECTION_STATUS.SUBMITTED, INSPECTION_STATUS.ACTION_REQUIRED]).optional(),
  }),
});

export const updateSchoolInspectionSchema = z.object({
  params: z.object({
    id: z.string().regex(objectIdRegex, 'Invalid inspection ID format'),
  }),
  body: z.object({
    overallGrade: z.enum(Object.values(OVERALL_GRADE)).optional(),
    summaryScore: z.number().min(0).max(100).optional(),
    infrastructure: z
      .object({
        cleanlinessRating: z.enum(['POOR', 'FAIR', 'GOOD', 'EXCELLENT']).optional(),
        drinkingWaterAvailable: z.boolean().optional(),
        washroomsFunctional: z.boolean().optional(),
        electricityFunctional: z.boolean().optional(),
        boundaryWallSecure: z.boolean().optional(),
        classroomsConditionRating: z.enum(['POOR', 'FAIR', 'GOOD', 'EXCELLENT']).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    academicEnvironment: z
      .object({
        lessonPlansMaintained: z.boolean().optional(),
        studentNotebooksChecked: z.boolean().optional(),
        timetableCompliance: z.boolean().optional(),
        syllabusProgressRating: z.enum(['BEHIND', 'ON_SCHEDULE', 'AHEAD']).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    attendanceAudit: z
      .object({
        studentsEnrolledCount: z.number().min(0).optional(),
        physicalHeadcount: z.number().min(0).optional(),
        headcountDiscrepancy: z.number().optional(),
        teachersRegisteredCount: z.number().min(0).optional(),
        teachersPresentCount: z.number().min(0).optional(),
        unauthorizedTeacherAbsentees: z.number().min(0).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    remedialDirectives: z.array(remedialDirectiveInputSchema).optional(),
    supervisorNotes: z.string().max(4000).optional(),
    status: z.enum(Object.values(INSPECTION_STATUS)).optional(),
    resolutionNotes: z.string().max(2000).optional(),
  }),
});

export const closeInspectionSchema = z.object({
  params: z.object({
    id: z.string().regex(objectIdRegex, 'Invalid inspection ID format'),
  }),
  body: z.object({
    resolutionNotes: z.string().min(5, 'Resolution notes must be at least 5 characters').max(2000),
  }),
});
