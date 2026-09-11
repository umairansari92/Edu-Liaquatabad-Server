import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import {
  handleGetTeacherAssignments,
  handleGetMyAssignments,
  handleAddTeachingAssignment,
  handleEndTeachingAssignment,
} from '../controllers/teachingAssignmentController.js';

const router = express.Router();

router.use(authenticate);

// Current teacher view own assignments
router.get('/my', handleGetMyAssignments);

// Scoped view of assignments for a teacher
router.get('/teacher/:teacherId', handleGetTeacherAssignments);

// Add assignment (HM, Supervisor, Admin+)
router.post('/', handleAddTeachingAssignment);

// End assignment (preserves history)
router.patch('/:id/end', handleEndTeachingAssignment);

export default router;
