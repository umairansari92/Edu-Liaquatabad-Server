import { ZodError } from 'zod';
import { sendError } from '../utils/apiResponse.js';

/**
 * Zod Request Body Validator Middleware
 * Usage: router.post('/path', validate(schema), handler)
 *
 * - Validates req.body against the provided Zod schema
 * - On failure: returns 422 with structured error details
 * - On success: replaces req.body with safe, parsed, trimmed values
 */
export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    // Extract the first error message per field for clear UX feedback
    const errors = result.error.errors.reduce((acc, err) => {
      const field = err.path.join('.');
      if (!acc[field]) {
        acc[field] = err.message;
      }
      return acc;
    }, {});

    const firstMessage = result.error.errors[0]?.message || 'Validation failed.';

    return sendError(res, 422, firstMessage, { fields: errors });
  }

  // Replace req.body with Zod-parsed (trimmed, coerced, safe) output
  req.body = result.data;
  next();
};

/**
 * Zod Query Params Validator Middleware
 * Usage: router.get('/path', validateQuery(schema), handler)
 */
export const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);

  if (!result.success) {
    const firstMessage = result.error.errors[0]?.message || 'Invalid query parameters.';
    return sendError(res, 422, firstMessage);
  }

  req.query = result.data;
  next();
};
