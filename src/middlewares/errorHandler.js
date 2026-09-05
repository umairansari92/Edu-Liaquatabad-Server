import { sendError } from '../utils/apiResponse.js';
import logger from '../../config/logger.js';

export const errorHandler = (error, request, response, nextFunction) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const statusCode = error.statusCode || (response.statusCode !== 200 ? response.statusCode : 500);

  // Log internal details securely for administrator debugging
  logger.error(`[Error Interceptor] ${error.message}`, {
    stack: error.stack,
    path: request.originalUrl,
    method: request.method,
    ip: request.ip,
  });

  // In production, sanitize 500 error messages to prevent internal implementation leaks
  let clientMessage = error.message || 'An unexpected internal server error occurred.';
  let clientErrors = error.errors || [];

  if (statusCode === 500 && isProduction) {
    clientMessage = 'An internal system error occurred. Telemetry has been logged for administrative review.';
    clientErrors = [];
  }

  return sendError(response, statusCode, clientMessage, clientErrors);
};
