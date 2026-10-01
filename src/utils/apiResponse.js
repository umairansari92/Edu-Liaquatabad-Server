/**
 * Standard API Response Envelope Builder
 */
export const sendSuccess = (httpResponse, statusCode = 200, message = 'Success', payloadData = {}, metadata = null) => {
  const envelope = {
    success: true,
    statusCode,
    message,
    data: payloadData,
  };
  if (metadata) {
    envelope.meta = metadata;
  }
  return httpResponse.status(statusCode).json(envelope);
};

export const sendError = (httpResponse, statusCode = 500, message = 'Internal Server Error', errors = []) => {
  return httpResponse.status(statusCode).json({
    success: false,
    statusCode,
    message,
    errors,
  });
};
