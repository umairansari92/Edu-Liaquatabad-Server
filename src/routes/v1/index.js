import express from 'express';
import healthRoutes from '../healthRoutes.js';
import authRoutes from '../authRoutes.js';
import studentRoutes from '../studentRoutes.js';
import publicRoutes from '../publicRoutes.js';
import userRoutes from '../userRoutes.js';
import superAdminRoutes from '../superAdminRoutes.js';
import schoolRoutes from '../schoolRoutes.js';
import academicRoutes from '../academicRoutes.js';
import transferRoutes from '../transferRoutes.js';
import exportRoutes from '../exportRoutes.js';

const router = express.Router();

// Health check endpoint
router.use('/health', healthRoutes);

// Auth & OTP endpoints
router.use('/auth', authRoutes);

// User & Role Management endpoints
router.use('/users', userRoutes);

// Municipal School infrastructure endpoints
router.use('/schools', schoolRoutes);

// Student enrollment & numbering endpoints
router.use('/students', studentRoutes);

// Public Gateway & Landing page statistics
router.use('/public', publicRoutes);

// Super Admin provisioning & management (ROOT_ADMIN / SUPER_ADMIN only)
router.use('/admin/super-admins', superAdminRoutes);

// Academic management (Classes, Sections, Subjects)
router.use('/academic', academicRoutes);

// Teacher transfers & staff reassignments
router.use('/transfers', transferRoutes);

// Export operations (CSV streaming)
router.use('/exports', exportRoutes);

export default router;


