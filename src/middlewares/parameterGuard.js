/**
 * HTTP Parameter Pollution (HPP) & Content-Type Gate (Security v7.5)
 */

/**
 * Prevents HTTP Parameter Pollution (duplicate query keys producing unexpected arrays)
 */
export const hppGuard = (request, response, nextFunction) => {
  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (Array.isArray(value)) {
        // Take the first occurrence and drop duplicate pollutants
        request.query[key] = value[0];
      }
    }
  }

  nextFunction();
};

/**
 * Validates Content-Type headers for mutating HTTP methods
 */
export const contentTypeGuard = (request, response, nextFunction) => {
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    const contentType = request.headers['content-type'] || '';
    const contentLength = parseInt(request.headers['content-length'] || '0', 10);

    // If request has body payload, assert valid content-type
    if (contentLength > 0) {
      const isValidContentType =
        contentType.includes('application/json') ||
        contentType.includes('multipart/form-data') ||
        contentType.includes('application/x-www-form-urlencoded');

      if (!isValidContentType) {
        return response.status(415).json({
          success: false,
          statusCode: 415,
          message: 'Unsupported Media Type. Expected application/json or multipart/form-data.',
        });
      }
    }
  }

  nextFunction();
};
