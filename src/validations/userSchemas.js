import { z } from 'zod';
import { ROLES, SCOPES, USER_STATUS } from '../../config/constants.js';
import { PERMISSIONS } from '../config/permissions.js';

const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;

const safeString = (maximumLength = 200, minimumLength = 0, minimumLengthErrorMessage = '') => {
  let schema = z.string().trim().max(maximumLength, `Must be ${maximumLength} characters or fewer`);
  if (minimumLength > 0) {
    schema = schema.min(minimumLength, minimumLengthErrorMessage || `Must be at least ${minimumLength} characters`);
  }
  return schema.refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
    message: 'Input contains disallowed characters or code patterns.',
  });
};

/**
 * Role & Designation Assignment Schema (SEC-CRIT-01 hardened)
 * .strict() rejects any unknown fields to prevent body injection attacks.
 * customPermissions are validated against the canonical PERMISSIONS enum.
 */
export const assignRoleSchema = z.object({
  designation: safeString(100, 1).optional(),
  role: z.enum(Object.values(ROLES), {
    errorMap: () => ({ message: `Role must be one of: ${Object.values(ROLES).join(', ')}` }),
  }).optional(),
  scope: z.enum(Object.values(SCOPES), {
    errorMap: () => ({ message: `Scope must be one of: ${Object.values(SCOPES).join(', ')}` }),
  }).optional(),
  customPermissions: z
    .array(
      z.enum(Object.values(PERMISSIONS), {
        errorMap: () => ({ message: `Each permission must be a canonical system permission.` }),
      })
    )
    .max(50, 'Maximum 50 custom permissions allowed.')
    .optional(),
  reason: safeString(500, 3, 'A mandatory justification reason of at least 3 characters is required.'),
}).strict();

/**
 * User Lifecycle State Schema (SEC-CRIT-01 hardened)
 * .strict() prevents injection of forbidden fields like 'role' or 'scope' into lifecycle requests.
 */
export const updateLifecycleSchema = z.object({
  status: z.enum(Object.values(USER_STATUS), {
    errorMap: () => ({ message: `Status must be one of: ${Object.values(USER_STATUS).join(', ')}` }),
  }),
  reason: safeString(500, 3, 'A mandatory justification reason of at least 3 characters is required.'),
  correctionRemarks: safeString(500).optional(),
}).strict();
