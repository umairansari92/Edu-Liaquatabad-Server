import express from 'express';
import healthRoutes from '../healthRoutes.js';
import authRoutes from '../authRoutes.js';
import studentRoutes from '../studentRoutes.js';
import publicRoutes from '../publicRoutes.js';
import userRoutes from '../userRoutes.js';
import superAdminRoutes from '../superAdminRoutes.js';
import schoolRoutes from '../schoolRoutes.js';
import academicRoutes from '../academicRoutes.js';
import attendanceRoutes from '../attendanceRoutes.js';
import transferRoutes from '../transferRoutes.js';
import exportRoutes from '../exportRoutes.js';
import adminUserRoutes from '../adminUserRoutes.js';
import systemControlRoutes from '../systemControlRoutes.js';
import { systemOutageGuard } from '../../middlewares/systemOutageGuard.js';

const router = express.Router();

// Health check endpoint (always accessible for monitoring probes)
router.use('/health', healthRoutes);

// System Control endpoints (ROOT_ADMIN only, bypasses outage guard)
router.use('/system-control', systemControlRoutes);

// Global System Outage Simulation Guard (simulates 503 cluster failure for non-root users when active)
router.use(systemOutageGuard);

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

// Super Admin management & governance (ROOT_ADMIN / SUPER_ADMIN only)
router.use('/admin/super-admins', superAdminRoutes);

// Privileged Administrative User Governance (Authority Grant Workflow)
router.use('/admin/users', adminUserRoutes);

// Academic management (Classes, Sections, Subjects)
router.use('/academic', academicRoutes);

// Teacher Attendance management (submit, view status, roster sheet)
router.use('/attendance', attendanceRoutes);

// Teacher transfers & staff reassignments
router.use('/transfers', transferRoutes);

// Export operations (CSV streaming)
router.use('/exports', exportRoutes);

export default router;



