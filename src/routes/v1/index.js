import express from 'express';
import healthRoutes from '../healthRoutes.js';
import authRoutes from '../authRoutes.js';
import studentRoutes from '../studentRoutes.js';

const router = express.Router();

// Health check endpoint
router.use('/health', healthRoutes);

// Auth & OTP endpoints
router.use('/auth', authRoutes);

// Student enrollment & numbering endpoints
router.use('/students', studentRoutes);

export default router;
