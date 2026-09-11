import express from 'express';
import rateLimit from 'express-rate-limit';
import { getPublicTownStats } from '../controllers/publicStatsController.js';
import School from '../models/School.js';
import Class from '../models/Class.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';

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

// GET /api/v1/public/schools — Public active schools list for onboarding forms
router.get('/schools', async (incomingRequest, outgoingResponse) => {
  try {
    const schoolsList = await School.find({ status: 'ACTIVE' })
      .select('_id name schoolCode schoolType genderType address')
      .sort({ name: 1 })
      .lean();

    return outgoingResponse.status(200).json({
      success: true,
      statusCode: 200,
      data: { schools: schoolsList },
    });
  } catch (databaseError) {
    return outgoingResponse.status(500).json({
      success: false,
      statusCode: 500,
      message: 'Failed to retrieve active schools list',
    });
  }
});

// GET /api/v1/public/schools/:schoolId/structure — Public classes, sections & subjects for registration forms
router.get('/schools/:schoolId/structure', async (incomingRequest, outgoingResponse) => {
  try {
    const { schoolId } = incomingRequest.params;
    const [classes, sections, subjects] = await Promise.all([
      Class.find({ schoolId, status: 'ACTIVE' }).select('_id name numericGrade').sort({ numericGrade: 1 }).lean(),
      Section.find({ schoolId, status: 'ACTIVE' }).select('_id classId name').lean(),
      Subject.find({ schoolId, status: 'ACTIVE' }).select('_id classId name code').lean(),
    ]);

    return outgoingResponse.status(200).json({
      success: true,
      statusCode: 200,
      data: { classes, sections, subjects },
    });
  } catch (error) {
    return outgoingResponse.status(500).json({
      success: false,
      statusCode: 500,
      message: 'Failed to retrieve school academic structure',
    });
  }
});

export default router;
