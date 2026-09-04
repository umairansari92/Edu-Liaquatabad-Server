import { sendError } from '../utils/apiResponse.js';
import logger from '../../config/logger.js';

export const errorHandler = (err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const statusCode = err.statusCode || (res.statusCode !== 200 ? res.statusCode : 500);

  // Log internal details securely for administrator debugging
  logger.error(`[Error Interceptor] ${err.message}`, {
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  // In production, sanitize 500 error messages to prevent internal implementation leaks
  let clientMessage = err.message || 'An unexpected internal server error occurred.';
  let clientErrors = err.errors || [];

  if (statusCode === 500 && isProduction) {
    clientMessage = 'An internal system error occurred. Telemetry has been logged for administrative review.';
    clientErrors = [];
  }

  return sendError(res, statusCode, clientMessage, clientErrors);
};
