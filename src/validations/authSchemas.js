import { z } from 'zod';
import { BASE_ROLES, ROLES } from '../../config/constants.js';

// ─── Reusable Primitives ───────────────────────────────────────────────────────

/**
 * Blocks any input containing HTML tags, script injections, or MongoDB operators.
 * Applied to all freeform text fields.
 */
const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;
const SPECIAL_CHARS_STRICT_REGEX = /[<>{}()\[\]\\\/]/;

const safeString = (maximumLength = 200, minimumLength = 0, minimumLengthErrorMessage = '') => {
  let schema = z.string().trim().max(maximumLength, `Must be ${maximumLength} characters or fewer`);
  if (minimumLength > 0) {
    schema = schema.min(minimumLength, minimumLengthErrorMessage || `Must be at least ${minimumLength} characters`);
  }
  return schema.refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
    message: 'Input contains disallowed characters or code patterns.',
  });
};

const nameField = (label = 'Name') =>
  z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(100, `${label} must be 100 characters or fewer`)
    .refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
      message: 'Input contains disallowed characters or code patterns.',
    })
    .refine((inputValue) => !SPECIAL_CHARS_STRICT_REGEX.test(inputValue), {
      message: `${label} must not contain special characters.`,
    });

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'Email is required')
  .max(254, 'Email address is too long')
  .email('Please enter a valid email address')
  .refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
    message: 'Email contains disallowed patterns.',
  });

const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must not exceed 128 characters')
  .refine((inputValue) => /[A-Z]/.test(inputValue), { message: 'Password must contain at least one uppercase letter.' })
  .refine((inputValue) => /[0-9]/.test(inputValue), { message: 'Password must contain at least one number.' })
  .refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), { message: 'Password contains disallowed patterns.' });

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
  .refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
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
  baseRole: z.literal(BASE_ROLES.STUDENT).optional().default(BASE_ROLES.STUDENT),
  role: z.string().optional(),
  otpCode: otpField.optional().or(z.literal('')),
  captchaAnswer: z.string().trim().optional(),
  captchaChallengeToken: z.string().trim().optional(),
  _gotcha: z.string().max(0, 'Submission rejected.').optional(), // Honeypot
}).refine(
  (data) => !data.role || ![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM].includes(data.role),
  { message: 'Privileged authorities (ROOT_ADMIN, SUPER_ADMIN, ADMIN, HM) cannot be self-assigned at registration.', path: ['role'] }
);

export const cnicField = z
  .string()
  .trim()
  .regex(/^\d{5}-\d{7}-\d{1}$/, {
    message: 'CNIC must follow the official format: XXXXX-XXXXXXX-X (e.g., 42101-1234567-1)',
  });

export const teachingAssignmentInputSchema = z.object({
  classId: z.string().trim().min(1, 'Class is required'),
  sectionId: z.string().trim().min(1, 'Section is required'),
  subjectId: z.string().trim().min(1, 'Subject is required'),
  academicSession: z.string().trim().min(1, 'Academic session is required'),
});

export const registerTeacherSchema = z.object({
  // Personal Info
  fullName: nameField('Full Name'),
  fatherName: safeString(100, 2, "Father's Name is required"),
  dateOfBirth: z.union([z.string().min(1), z.date()]).refine((val) => !isNaN(new Date(val).getTime()), {
    message: 'Valid Date of Birth is required',
  }),
  cnic: cnicField,
  profilePhoto: z.object({
    secureUrl: z.string().optional().or(z.literal('')),
    publicId: z.string().optional(),
  }).optional(),

  // Employment Info
  employeeId: safeString(50, 3, 'Employee Number must be at least 3 characters'),
  designation: safeString(100, 2, 'Designation is required'),
  appointmentDate: z.union([z.string().min(1), z.date()]).refine((val) => !isNaN(new Date(val).getTime()), {
    message: 'Valid Date of Appointment is required',
  }),
  email: emailField,
  phoneNumber: phoneField,
  schoolId: z.string().trim().min(1, 'School selection is required'),
  qualification: safeString(100, 2, 'Qualification is required'),
  isTeachingStaff: z.boolean().optional().default(true),

  // Bank Info
  bankName: safeString(100, 2, 'Bank Name is required'),
  branchName: safeString(100, 2, 'Branch Name is required'),
  accountNumber: z.string().trim().min(5, 'Bank Account Number must be at least 5 characters').max(50),
  accountTitle: safeString(100, 2, 'Bank Account Title is required'),

  // Teaching Assignments (Teachers only)
  teachingAssignments: z.array(teachingAssignmentInputSchema).optional().default([]),

  // Security & Authentication
  password: passwordField,
  confirmPassword: z.string().min(1, 'Confirm password is required').optional(),
  baseRole: z.enum([BASE_ROLES.TEACHER, BASE_ROLES.PEON, BASE_ROLES.SUPERVISOR]).optional().default(BASE_ROLES.TEACHER),
  role: z.string().optional(),
  otpCode: otpField,
  captchaAnswer: z.string().trim().optional(),
  captchaChallengeToken: z.string().trim().optional(),
  _gotcha: z.string().max(0, 'Submission rejected.').optional(), // Honeypot
}).refine(
  (data) => !data.role || ![ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM].includes(data.role),
  { message: 'Privileged authorities (ROOT_ADMIN, SUPER_ADMIN, ADMIN, HM) cannot be self-assigned at registration.', path: ['role'] }
).refine(
  (data) => {
    // Non-teaching staff must NOT have teaching assignments
    if (data.isTeachingStaff === false && data.teachingAssignments && data.teachingAssignments.length > 0) {
      return false;
    }
    return true;
  },
  { message: 'Non-teaching staff cannot be assigned teaching assignments.', path: ['teachingAssignments'] }
);

export const registerStaffSchema = registerTeacherSchema;

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
  .refine((formValues) => formValues.newPassword === formValues.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
