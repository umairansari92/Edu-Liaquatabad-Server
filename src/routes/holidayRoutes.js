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

router.use(authenticate);
router.use(idempotencyGuard);

// Holidays & Emergency Closures
router.post('/holidays', handleCreateHoliday);
router.get('/holidays', handleGetHolidays);
router.patch('/holidays/:id/cancel', handleCancelHoliday);

// Recurring Weekly Off Patterns
router.post('/weekly-off', handleCreateWeeklyOffPattern);
router.get('/weekly-off', handleGetWeeklyOffPatterns);

export default router;
