import rateLimit from 'express-rate-limit';

const isDevelopmentEnvironment = process.env.NODE_ENV !== 'production';

const isLocalhostRequest = (incomingRequest) => {
  if (!isDevelopmentEnvironment) return false;
  const clientIpAddress = incomingRequest.ip || incomingRequest.socket?.remoteAddress || '';
  return clientIpAddress === '::1' || clientIpAddress === '127.0.0.1' || clientIpAddress === '::ffff:127.0.0.1';
};

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopmentEnvironment ? 2000 : 300, // 2000 in dev, 300 in prod
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopmentEnvironment ? 500 : 30, // 500 in dev, 30 in prod
  standardHeaders: true,
  legacyHeaders: false,
  skip: (incomingRequest) => isLocalhostRequest(incomingRequest),
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

