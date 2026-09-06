import { z } from 'zod';

const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;

const safeString = (maximumLength = 200, minimumLength = 0, minimumLengthErrorMessage = '') => {
  let validationSchema = z.string().trim().max(maximumLength, `Must be ${maximumLength} characters or fewer`);
  if (minimumLength > 0) {
    validationSchema = validationSchema.min(minimumLength, minimumLengthErrorMessage || `Must be at least ${minimumLength} characters`);
  }
  return validationSchema.refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
    message: 'Input contains disallowed characters or code patterns.',
  });
};

export const createSchoolSchema = z.object({
  name: safeString(150, 3, 'School name must be at least 3 characters.'),
  schoolCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, 'School code must be 2–10 uppercase alphanumeric characters (e.g. MMHA, GGSS).')
    .optional(),
  emisCode: safeString(20).optional(),
  schoolType: z.enum(['PRIMARY', 'SECONDARY', 'HIGHER_SECONDARY', 'ELEMENTARY'], {
    errorMap: () => ({ message: 'School type must be PRIMARY, SECONDARY, HIGHER_SECONDARY, or ELEMENTARY.' }),
  }),
  genderType: z.enum(['BOYS', 'GIRLS', 'CO_EDUCATION'], {
    errorMap: () => ({ message: 'Gender type must be BOYS, GIRLS, or CO_EDUCATION.' }),
  }),
  address: safeString(300, 5, 'School address must be at least 5 characters.'),
  contactPhone: safeString(30).optional(),
  contactEmail: z.string().trim().email('Invalid contact email address.').optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED', 'INACTIVE', 'ARCHIVED']).optional(),
}).strict();

/**
 * Update School Schema (SEC-CRIT-02 hardened)
 * .strict() blocks injection of immutable identifiers (townId, organizationId, _id, etc.)
 * through the request body. Only allowed update fields can pass validation.
 */
export const updateSchoolSchema = z.object({
  name: safeString(150, 3).optional(),
  schoolCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, 'School code must be 2–10 uppercase alphanumeric characters.')
    .optional(),
  emisCode: safeString(20).optional(),
  schoolType: z.enum(['PRIMARY', 'SECONDARY', 'HIGHER_SECONDARY', 'ELEMENTARY']).optional(),
  genderType: z.enum(['BOYS', 'GIRLS', 'CO_EDUCATION']).optional(),
  address: safeString(300, 5).optional(),
  contactPhone: safeString(30).optional(),
  contactEmail: z.string().trim().email('Invalid contact email address.').optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED', 'INACTIVE', 'ARCHIVED']).optional(),
  reason: safeString(500, 3, 'A mandatory reason is required for updating municipal school records.').optional(),
}).strict();

