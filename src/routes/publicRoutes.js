import express from 'express';
import rateLimit from 'express-rate-limit';
import { getPublicTownStats } from '../controllers/publicStatsController.js';

const router = express.Router();

const publicStatsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many requests for public statistics. Please try again in a moment.',
  },
});

// GET /api/v1/public/stats — Public statistics for Next.js Landing Page (Throttled & Cached)
router.get('/stats', publicStatsLimiter, getPublicTownStats);

export default router;
