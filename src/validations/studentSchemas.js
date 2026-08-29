import { z } from 'zod';

// ─── Reusable Primitives ───────────────────────────────────────────────────────
const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;
const SPECIAL_CHARS_STRICT_REGEX = /[<>{}()\[\]\\\/]/;

const safeString = (maxLen = 200, minLen = 0, minMsg = '') => {
  let schema = z.string().trim().max(maxLen, `Must be ${maxLen} characters or fewer`);
  if (minLen > 0) {
    schema = schema.min(minLen, minMsg || `Must be at least ${minLen} characters`);
  }
  return schema.refine((v) => !SCRIPT_INJECTION_REGEX.test(v), {
    message: 'Input contains disallowed characters.',
  });
};

const nameField = (label = 'Name') =>
  z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(100, `${label} must be 100 characters or fewer`)
    .refine((v) => !SCRIPT_INJECTION_REGEX.test(v), {
      message: 'Input contains disallowed characters.',
    })
    .refine((v) => !SPECIAL_CHARS_STRICT_REGEX.test(v), {
      message: `${label} must not contain special characters.`,
    });

const phoneField = z
  .string().trim()
  .regex(/^(\+92|0)?[3][0-9]{9}$/, 'Enter a valid Pakistani mobile number (e.g. 03001234567)')
  .max(15);

const mongoId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid ID format');

// ─── School Code Schema ────────────────────────────────────────────────────────
/**
 * Used by authorized roles (HM, Supervisor, Admin+) to set or update a school's code.
 * The code is the prefix for global student IDs: e.g. MMHA → MMHA-0001
 */
export const setSchoolCodeSchema = z.object({
  schoolCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'School code must be at least 2 characters')
    .max(10, 'School code must not exceed 10 characters')
    .regex(/^[A-Z0-9]+$/, 'School code must contain only uppercase letters and numbers'),
});

// ─── HM Student Enrollment Schema ─────────────────────────────────────────────
/**
 * Used when HM (or admin+) adds a student — new admission or old record entry.
 * GR No and Global Student ID are NOT entered by user; handled by system.
 * EXCEPTION: HM can manually provide grNumber for EXISTING_ENTRY (old students).
 */
export const enrollStudentSchema = z
  .object({
    admissionType: z.enum(['NEW_ADMISSION', 'EXISTING_ENTRY'], {
      errorMap: () => ({ message: 'Admission type must be NEW_ADMISSION or EXISTING_ENTRY.' }),
    }),

    // Student personal details
    fullName: nameField('Full Name'),
    dateOfBirth: z.string().trim().optional(),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),

    // Contact
    guardianName: nameField('Father/Guardian Name'),
    guardianContact: phoneField,
    residentialAddress: safeString(300).optional(),

    // Academic placement
    classId: mongoId,
    sectionId: mongoId,

    // Admission date (defaults to today if not provided)
    admissionDate: z.string().trim().optional(),

    // Manual GR — only required when admissionType === 'EXISTING_ENTRY'
    manualGrNumber: z.number().int().positive().optional(),
  })
  .refine(
    (data) => {
      if (data.admissionType === 'EXISTING_ENTRY') {
        return data.manualGrNumber !== undefined && data.manualGrNumber > 0;
      }
      return true;
    },
    {
      message: 'GR Number is required for existing student entries.',
      path: ['manualGrNumber'],
    }
  );

// ─── Preview Next GR ──────────────────────────────────────────────────────────
export const previewGrSchema = z.object({
  schoolId: mongoId,
});

// ─── Check GR Availability ────────────────────────────────────────────────────
export const checkGrSchema = z.object({
  schoolId: mongoId,
  grNumber: z.coerce.number().int().positive('GR number must be a positive integer'),
});
