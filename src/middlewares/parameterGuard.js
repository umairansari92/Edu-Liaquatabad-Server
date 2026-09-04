/**
 * HTTP Parameter Pollution (HPP) & Content-Type Gate (Security v7.5)
 */

/**
 * Prevents HTTP Parameter Pollution (duplicate query keys producing unexpected arrays)
 */
export const hppGuard = (req, res, next) => {
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        // Take the first occurrence and drop duplicate pollutants
        req.query[key] = value[0];
      }
    }
  }

  next();
};

/**
 * Validates Content-Type headers for mutating HTTP methods
 */
export const contentTypeGuard = (req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    // If request has body payload, assert valid content-type
    if (contentLength > 0) {
      const isValid =
        contentType.includes('application/json') ||
        contentType.includes('multipart/form-data') ||
        contentType.includes('application/x-www-form-urlencoded');

      if (!isValid) {
        return res.status(415).json({
          success: false,
          statusCode: 415,
          message: 'Unsupported Media Type. Expected application/json or multipart/form-data.',
        });
      }
    }
  }

  next();
};
