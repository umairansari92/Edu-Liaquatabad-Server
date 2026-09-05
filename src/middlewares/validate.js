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
export const validate = (schema) => (request, response, nextFunction) => {
  const result = schema.safeParse(request.body);

  if (!result.success) {
    // Extract the first error message per field for clear UX feedback
    const formattedErrors = result.error.errors.reduce((accumulatedErrors, validationIssue) => {
      const fieldPath = validationIssue.path.join('.');
      if (!accumulatedErrors[fieldPath]) {
        accumulatedErrors[fieldPath] = validationIssue.message;
      }
      return accumulatedErrors;
    }, {});

    const firstErrorMessage = result.error.errors[0]?.message || 'Validation failed.';

    return sendError(response, 422, firstErrorMessage, { fields: formattedErrors });
  }

  // Replace request.body with Zod-parsed (trimmed, coerced, safe) output
  request.body = result.data;
  nextFunction();
};

/**
 * Zod Query Params Validator Middleware
 * Usage: router.get('/path', validateQuery(schema), handler)
 */
export const validateQuery = (schema) => (request, response, nextFunction) => {
  const result = schema.safeParse(request.query);

  if (!result.success) {
    const firstErrorMessage = result.error.errors[0]?.message || 'Invalid query parameters.';
    return sendError(response, 422, firstErrorMessage);
  }

  request.query = result.data;
  nextFunction();
};
