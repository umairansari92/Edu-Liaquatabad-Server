import { z } from 'zod';
import { PARENT_RELATIONSHIP } from '../../config/constants.js';

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

const cnicField = z
  .string()
  .trim()
  .regex(/^\d{5}-\d{7}-\d{1}$|^\d{13}$/, 'CNIC must be 13 digits (e.g. 42101-1234567-1 or 4210112345671)');

const otpField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Verification code must be exactly 6 numeric digits');

// ─── 1. Parent Registration Schema ──────────────────────────────────────────
export const registerParentSchema = z.object({
  fullName: nameField('Parent Name'),
  email: emailField,
  password: passwordField,
  confirmPassword: z.string().optional(),
  phoneNumber: phoneField,
  guardianCnicNumber: cnicField.optional(),
  cnicNumber: cnicField.optional(),
  relationship: z.enum(Object.values(PARENT_RELATIONSHIP)).optional(),
  otpCode: otpField.optional(),
  captchaAnswer: process.env.NODE_ENV === 'production'
    ? z.union([z.string(), z.number()]).refine((val) => String(val).trim().length > 0, 'CAPTCHA answer is required.')
    : z.union([z.string(), z.number()]).optional(),
  captchaChallengeToken: process.env.NODE_ENV === 'production'
    ? z.string().trim().min(1, 'CAPTCHA challenge token is required.')
    : z.string().trim().optional(),
  _gotcha: z.string().max(0, 'Submission rejected.').optional(),
});

// ─── 2. Ward Lookup Schema (Anti-Enumeration Guard) ──────────────────────────
export const lookupWardSchema = z.object({
  schoolId: z.string().min(1, 'School ID is required'),
  grNumber: z.union([z.string(), z.number()]).optional(),
  admissionRegisterNumber: z.string().trim().optional(),
  globalStudentId: z.string().trim().optional(),
}).refine(
  (data) => data.grNumber || data.admissionRegisterNumber || data.globalStudentId,
  {
    message: 'Either GR Number, Admission Register Number, or Global Student ID is required for lookup.',
  }
);

// ─── 3. Initiate Ward Claim Schema ───────────────────────────────────────────
export const initiateClaimSchema = z.object({
  studentProfileId: z.string().min(1, 'Student Profile ID is required'),
  relationship: z.enum(Object.values(PARENT_RELATIONSHIP), {
    errorMap: () => ({ message: 'Relationship must be FATHER, MOTHER, or GUARDIAN' }),
  }),
});

// ─── 4. Verify Claim Contact OTP Schema ──────────────────────────────────────
export const verifyClaimOtpSchema = z.object({
  linkId: z.string().min(1, 'Link ID is required'),
  otpCode: otpField,
});

// ─── 5. HM Verify Parent Link Schema ─────────────────────────────────────────
export const hmVerifyLinkSchema = z.object({
  remarks: safeString(500).optional(),
});

// ─── 6. HM Reject Parent Link Schema ─────────────────────────────────────────
export const hmRejectLinkSchema = z.object({
  rejectionReason: safeString(500, 10, 'Rejection reason must be at least 10 characters'),
});

// ─── 7. HM Revoke Parent Link Schema ─────────────────────────────────────────
export const hmRevokeLinkSchema = z.object({
  revocationReason: safeString(500, 10, 'Revocation reason must be at least 10 characters'),
});
