import { z } from 'zod';
import { ROLES, SCOPES, USER_STATUS } from '../../config/constants.js';

const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;

const safeString = (maxLen = 200, minLen = 0, minMsg = '') => {
  let schema = z.string().trim().max(maxLen, `Must be ${maxLen} characters or fewer`);
  if (minLen > 0) {
    schema = schema.min(minLen, minMsg || `Must be at least ${minLen} characters`);
  }
  return schema.refine((val) => !SCRIPT_INJECTION_REGEX.test(val), {
    message: 'Input contains disallowed characters or code patterns.',
  });
};

export const assignRoleSchema = z.object({
  designation: safeString(100, 1).optional(),
  role: z.enum(Object.values(ROLES), {
    errorMap: () => ({ message: `Role must be one of: ${Object.values(ROLES).join(', ')}` }),
  }).optional(),
  scope: z.enum(Object.values(SCOPES), {
    errorMap: () => ({ message: `Scope must be one of: ${Object.values(SCOPES).join(', ')}` }),
  }).optional(),
  customPermissions: z.array(safeString(100)).max(50).optional(),
  reason: safeString(500, 3, 'A mandatory justification reason of at least 3 characters is required.'),
});

export const updateLifecycleSchema = z.object({
  status: z.enum(Object.values(USER_STATUS), {
    errorMap: () => ({ message: `Status must be one of: ${Object.values(USER_STATUS).join(', ')}` }),
  }),
  reason: safeString(500, 3, 'A mandatory justification reason of at least 3 characters is required.'),
  correctionRemarks: safeString(500).optional(),
});
