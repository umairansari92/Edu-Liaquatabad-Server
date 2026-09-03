import express from 'express';
import healthRoutes from '../healthRoutes.js';
import authRoutes from '../authRoutes.js';
import studentRoutes from '../studentRoutes.js';
import publicRoutes from '../publicRoutes.js';
import userRoutes from '../userRoutes.js';

const router = express.Router();

// Health check endpoint
router.use('/health', healthRoutes);

// Auth & OTP endpoints
router.use('/auth', authRoutes);

// User & Role Management endpoints
router.use('/users', userRoutes);

// Student enrollment & numbering endpoints
router.use('/students', studentRoutes);

// Public Gateway & Landing page statistics
router.use('/public', publicRoutes);

export default router;
