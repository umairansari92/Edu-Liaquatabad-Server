import express from 'express';
import { getPublicTownStats } from '../controllers/publicStatsController.js';

const router = express.Router();

// GET /api/v1/public/stats — Public statistics for Next.js Landing Page
router.get('/stats', getPublicTownStats);

export default router;
