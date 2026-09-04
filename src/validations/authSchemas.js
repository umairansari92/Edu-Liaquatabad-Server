import { z } from 'zod';

// ─── Reusable Primitives ───────────────────────────────────────────────────────

/**
 * Blocks any input containing HTML tags, script injections, or MongoDB operators.
 * Applied to all freeform text fields.
 */
const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;
const SPECIAL_CHARS_STRICT_REGEX = /[<>{}()\[\]\\\/]/;

const safeString = (maxLen = 200, minLen = 0, minMsg = '') => {
  let schema = z.string().trim().max(maxLen, `Must be ${maxLen} characters or fewer`);
  if (minLen > 0) {
    schema = schema.min(minLen, minMsg || `Must be at least ${minLen} characters`);
  }
  return schema.refine((val) => !SCRIPT_INJECTION_REGEX.test(val), {
    message: 'Input contains disallowed characters or code patterns.',
  });
};

const nameField = (label = 'Name') =>
  z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(100, `${label} must be 100 characters or fewer`)
    .refine((val) => !SCRIPT_INJECTION_REGEX.test(val), {
      message: 'Input contains disallowed characters or code patterns.',
    })
    .refine((val) => !SPECIAL_CHARS_STRICT_REGEX.test(val), {
      message: `${label} must not contain special characters.`,
    });

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'Email is required')
  .max(254, 'Email address is too long')
  .email('Please enter a valid email address')
  .refine((val) => !SCRIPT_INJECTION_REGEX.test(val), {
    message: 'Email contains disallowed patterns.',
  });

const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must not exceed 128 characters')
  .refine((val) => /[A-Z]/.test(val), { message: 'Password must contain at least one uppercase letter.' })
  .refine((val) => /[0-9]/.test(val), { message: 'Password must contain at least one number.' })
  .refine((val) => !SCRIPT_INJECTION_REGEX.test(val), { message: 'Password contains disallowed patterns.' });

const phoneField = z
  .string()
  .trim()
  .regex(/^(\+92|0)?[3][0-9]{9}$/, 'Please enter a valid Pakistani mobile number (e.g. 03001234567)')
  .max(15, 'Phone number too long');

const otpField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'OTP must be exactly 6 numeric digits');

const rollNumberField = z
  .string()
  .trim()
  .min(1, 'Roll number is required')
  .max(20, 'Roll number too long')
  .regex(/^[A-Za-z0-9\-\/]+$/, 'Roll number may only contain letters, numbers, hyphens, or slashes');

const loginIdentifierField = z
  .string()
  .trim()
  .min(1, 'Email or GR Number is required')
  .max(254, 'Identifier is too long')
  .refine((val) => !SCRIPT_INJECTION_REGEX.test(val), {
    message: 'Identifier contains disallowed patterns.',
  });

export const loginSchema = z.object({
  email: loginIdentifierField,
  password: z.string().min(1, 'Password is required').max(128, 'Password too long'),
  captchaAnswer: z.union([z.string(), z.number()]).optional(),
  captchaChallengeToken: z.string().trim().optional(),
  _gotcha: z.string().max(0, 'Submission rejected.').optional(), // Honeypot
});

export const sendOtpSchema = z.object({
  email: emailField,
  purpose: z.enum(
    ['REGISTRATION', 'PASSWORD_RESET', 'MFA_LOGIN', 'SENSITIVE_ACTION'],
    { errorMap: () => ({ message: 'Invalid OTP purpose.' }) }
  ),
});

export const verifyOtpSchema = z.object({
  email: emailField,
  otpCode: otpField,
  purpose: z.enum(['REGISTRATION', 'PASSWORD_RESET', 'MFA_LOGIN', 'SENSITIVE_ACTION'], {
    errorMap: () => ({ message: 'Invalid OTP purpose.' }),
  }),
});

export const registerStudentSchema = z.object({
  fullName: nameField('Full Name'),
  fatherOrGuardianName: nameField('Father/Guardian Name'),
  schoolId: z.string().trim().max(100).optional(),
  grNumber: z.union([z.string().trim().min(1, 'GR Number is required').max(50), z.number()]).optional(),
  rollNumber: z.string().trim().max(50).optional(),
  password: passwordField,
  confirmPassword: z.string().min(1, 'Confirm password is required').optional(),
  email: emailField.optional().or(z.literal('')),
  className: safeString(50, 0).optional(),
  sectionName: safeString(10, 0).optional(),
  guardianContactNumber: phoneField.optional().or(z.literal('')),
  classId: z.string().trim().max(100).optional(),
  sectionId: z.string().trim().max(100).optional(),
  otpCode: otpField.optional().or(z.literal('')),
  captchaAnswer: z.string().trim().optional(),
  captchaChallengeToken: z.string().trim().optional(),
  _gotcha: z.string().max(0, 'Submission rejected.').optional(), // Honeypot
});

export const registerTeacherSchema = z.object({
  fullName: nameField('Full Name'),
  email: emailField,
  password: passwordField,
  phoneNumber: phoneField,
  designation: safeString(100, 2, 'Designation is required'),
  qualification: safeString(100, 2, 'Qualification is required'),
  schoolId: z.string().trim().max(100).optional(),
  otpCode: otpField,
  captchaAnswer: z.string().trim().optional(),
  captchaChallengeToken: z.string().trim().optional(),
  _gotcha: z.string().max(0, 'Submission rejected.').optional(), // Honeypot
});

export const passwordResetRequestSchema = z.object({
  email: emailField,
});

export const passwordResetConfirmSchema = z
  .object({
    email: emailField,
    otpCode: otpField,
    newPassword: passwordField,
    confirmPassword: z.string().min(1, 'Confirm password is required'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
