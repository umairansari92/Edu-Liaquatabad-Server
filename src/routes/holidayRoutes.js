import express from 'express';
import {
  handleCreateHoliday,
  handleGetHolidays,
  handleCancelHoliday,
  handleCreateWeeklyOffPattern,
  handleGetWeeklyOffPatterns,
} from '../controllers/holidayController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { idempotencyGuard } from '../middlewares/idempotency.js';

const router = express.Router();

// Holidays & Emergency Closures
router.post('/holidays', authenticate, idempotencyGuard, handleCreateHoliday);
router.get('/holidays', authenticate, handleGetHolidays);
router.patch('/holidays/:id/cancel', authenticate, idempotencyGuard, handleCancelHoliday);

// Recurring Weekly Off Patterns
router.post('/weekly-off', authenticate, idempotencyGuard, handleCreateWeeklyOffPattern);
router.get('/weekly-off', authenticate, handleGetWeeklyOffPatterns);

export default router;
