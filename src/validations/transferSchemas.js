import { z } from 'zod';

const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;

const safeString = (max = 200, min = 0, minMsg = '') => {
  let schema = z.string().trim().max(max, `Must be ${max} chars or fewer`);
  if (min > 0) schema = schema.min(min, minMsg || `Must be at least ${min} chars`);
  return schema.refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
    message: 'Input contains disallowed characters.',
  });
};

export const initiateTransferSchema = z.object({
  teacherUserId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid teacherUserId format.').optional(),
  teacherId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid teacherId format.').optional(),
  targetSchoolId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid targetSchoolId format.').optional(),
  destinationSchoolId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid destinationSchoolId format.').optional(),
  reason: safeString(1000, 5, 'Transfer reason must be at least 5 characters.'),
  officialOrderNumber: safeString(100).optional(),
  orderDate: z.string().optional(),
  isEmergencyOverride: z.boolean().optional(),
  overrideJustification: safeString(1000).optional(),
}).refine(
  (data) => Boolean(data.teacherUserId || data.teacherId),
  { message: 'A valid teacherUserId is required.', path: ['teacherUserId'] }
).refine(
  (data) => Boolean(data.targetSchoolId || data.destinationSchoolId),
  { message: 'A valid targetSchoolId is required.', path: ['targetSchoolId'] }
).refine(
  (data) => !data.isEmergencyOverride || (data.overrideJustification && data.overrideJustification.trim().length >= 10),
  { message: 'Emergency override requires a justification of at least 10 characters.', path: ['overrideJustification'] }
);

export const relieveTeacherSchema = z.object({
  relievingDate: z.string().optional(),
  relievingRemarks: safeString(1000).optional(),
  relievingOrderNumber: safeString(100).optional(),
  clearanceCertified: z.boolean({
    required_error: 'Clearance certification must be explicitly verified.',
  }).refine((val) => val === true, {
    message: 'Clearance certification must be true before relieving faculty member.',
  }),
});

export const approveJoiningSchema = z.object({
  joiningDate: z.string().optional(),
  remarks: safeString(1000).optional(),
});

export const rejectJoiningSchema = z.object({
  rejectionReason: safeString(1000, 10, 'Rejection reason must be at least 10 characters.'),
});

export const adminReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'CANCEL'], {
    errorMap: () => ({ message: 'Decision must be either APPROVE or CANCEL.' }),
  }),
  adminRemarks: safeString(1000, 5, 'Administrative review remarks must be at least 5 characters.'),
  officialOrderNumber: safeString(100).optional(),
});

export const cancelTransferSchema = z.object({
  cancellationReason: safeString(1000, 5, 'Cancellation reason must be at least 5 characters.'),
});
