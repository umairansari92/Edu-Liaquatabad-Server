import { z } from 'zod';

const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;

const safeString = (max = 200, min = 0, minMsg = '') => {
  let schema = z.string().trim().max(max, `Must be ${max} chars or fewer`);
  if (min > 0) schema = schema.min(min, minMsg || `Must be at least ${min} chars`);
  return schema.refine((v) => !SCRIPT_INJECTION_REGEX.test(v), {
    message: 'Input contains disallowed characters.',
  });
};

// ─── Class Schemas ────────────────────────────────────────────────────────────

export const createClassSchema = z.object({
  schoolId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid schoolId format.'),
  name: safeString(100, 2, 'Class name must be at least 2 characters.'),
  code: safeString(20).optional(),
  numericGrade: z.number().int().min(1).max(14).optional(),
  gradeLevel: z.number().int().min(1).max(14).optional(),
}).strict().refine((data) => data.numericGrade !== undefined || data.gradeLevel !== undefined, {
  message: 'Either numericGrade or gradeLevel is required.',
  path: ['numericGrade'],
});

export const updateClassSchema = z.object({
  name: safeString(100, 2).optional(),
  code: safeString(20).optional(),
  numericGrade: z.number().int().min(1).max(14).optional(),
  gradeLevel: z.number().int().min(1).max(14).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED'], {
    errorMap: () => ({ message: 'Status must be ACTIVE, INACTIVE, or ARCHIVED.' }),
  }).optional(),
  reason: safeString(500, 3, 'Reason required for archiving.').optional(),
}).strict();

// ─── Section Schemas ──────────────────────────────────────────────────────────

export const createSectionSchema = z.object({
  schoolId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid schoolId format.').optional(),
  classId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid classId format.'),
  name: safeString(50, 1, 'Section name is required.'),
  capacity: z.number().int().min(1).max(120).optional(),
  roomNumber: safeString(50).optional(),
  classTeacherId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid classTeacherId format.').optional(),
}).strict();

export const updateSectionSchema = z.object({
  name: safeString(50, 1).optional(),
  capacity: z.number().int().min(1).max(120).optional(),
  roomNumber: safeString(50).optional(),
  classTeacherId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/).optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  reason: safeString(500, 3).optional(),
}).strict();

// ─── Subject Schemas ──────────────────────────────────────────────────────────

export const createSubjectSchema = z.object({
  schoolId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid schoolId format.'),
  classId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid classId format.').optional().or(z.literal('')),
  name: safeString(100, 2, 'Subject name must be at least 2 characters.'),
  code: safeString(20).optional(),
  isElective: z.boolean().optional(),
  totalMarks: z.number().int().min(1).max(1000).optional(),
  passingMarks: z.number().int().min(1).max(1000).optional(),
}).strict();

export const updateSubjectSchema = z.object({
  name: safeString(100, 2).optional(),
  code: safeString(20).optional(),
  isElective: z.boolean().optional(),
  totalMarks: z.number().int().min(1).max(1000).optional(),
  passingMarks: z.number().int().min(1).max(1000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  reason: safeString(500, 3).optional(),
}).strict();
