import express from 'express';
import {
  handleSendOtp,
  handleVerifyOtp,
  handleRegisterStudent,
  handleRegisterTeacher,
} from '../controllers/authController.js';
import { authLimiter } from '../middlewares/tripleLockRateLimiter.js';
import { honeypotCheck } from '../middlewares/honeypot.js';
import { validate } from '../middlewares/validate.js';
import {
  sendOtpSchema,
  verifyOtpSchema,
  registerStudentSchema,
  registerTeacherSchema,
} from '../validations/authSchemas.js';
import { generateMathCaptcha } from '../utils/customMathCaptcha.js';
import { sendSuccess } from '../utils/apiResponse.js';

const router = express.Router();

// ─── Generate Math CAPTCHA ────────────────────────────────────────────────────
router.get('/captcha', (req, res) => {
  const captcha = generateMathCaptcha();
  return sendSuccess(res, 200, 'CAPTCHA generated successfully.', captcha);
});

// ─── OTP Endpoints ────────────────────────────────────────────────────────────
// Stack: Rate Limit → Honeypot → Zod Validation → Controller
router.post('/send-otp',
  authLimiter,
  honeypotCheck,
  validate(sendOtpSchema),
  handleSendOtp
);

router.post('/verify-otp',
  authLimiter,
  honeypotCheck,
  validate(verifyOtpSchema),
  handleVerifyOtp
);

// ─── Registration Endpoints ───────────────────────────────────────────────────
router.post('/register-student',
  authLimiter,
  honeypotCheck,
  validate(registerStudentSchema),
  handleRegisterStudent
);

router.post('/register-teacher',
  authLimiter,
  honeypotCheck,
  validate(registerTeacherSchema),
  handleRegisterTeacher
);

export default router;
