import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import compression from 'compression';

import { connectDatabase } from './config/database.js';
import logger from './config/logger.js';
import { startScheduledJobs } from './config/scheduledJobs.js';
import { globalLimiter } from './src/middlewares/tripleLockRateLimiter.js';
import { ipReputationCheck } from './src/middlewares/ipReputation.js';
import { errorHandler } from './src/middlewares/errorHandler.js';
import v1Routes from './src/routes/v1/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS & Origin Whitelisting ───────────────────────────────────────────────
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy.'));
    }
  },
  credentials: true,
}));

// ─── IP Reputation Gate ───────────────────────────────────────────────────────
app.use(ipReputationCheck);

// ─── Gzip Compression ─────────────────────────────────────────────────────────
app.use(compression());

// ─── HTTP Access Logging (Morgan → Winston) ───────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
  skip: (req) => req.path === '/api/v1/health',
}));

// ─── Body Parsing & Sanitization ─────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(mongoSanitize());

// ─── Global IP Rate Limiter ───────────────────────────────────────────────────
app.use(globalLimiter);

// ─── Database Connection ──────────────────────────────────────────────────────
connectDatabase();

// ─── Mount V1 BFF API Routes ─────────────────────────────────────────────────
app.use('/api/v1', v1Routes);

// ─── Root Fallback Route ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    platform: 'Education Department Liaquatabad Town Centre (DMC)',
    version: 'v1.0.0',
    docs: '/api/v1/health',
    security: 'CVifyPro Security Architecture v7.0',
  });
});

// ─── Centralized Error Handler ────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start HTTP Server (local dev only — Vercel uses serverless handler) ──────
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    logger.info(`[Server] Liaquatabad DMC Backend running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    startScheduledJobs();
  });
}

export default app;
