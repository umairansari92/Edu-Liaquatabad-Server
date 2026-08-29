/**
 * Standard API Response Envelope Builder
 */
export const sendSuccess = (res, statusCode = 200, message = 'Success', data = {}, meta = null) => {
  const response = {
    success: true,
    statusCode,
    message,
    data,
  };
  if (meta) {
    response.meta = meta;
  }
  return res.status(statusCode).json(response);
};

export const sendError = (res, statusCode = 500, message = 'Internal Server Error', errors = []) => {
  return res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    errors,
  });
};
