import express from 'express';
import {
  handleGetCaptcha,
  handleSendOtp,
  handleVerifyOtp,
  handleRegisterStudent,
  handleRegisterTeacher,
  handleLogin,
  handleRefreshToken,
  handleLogout,
  handleGetMe,
  handleForgotPassword,
  handleResetPassword,
} from '../controllers/authController.js';
import { authLimiter } from '../middlewares/tripleLockRateLimiter.js';
import { honeypotCheck } from '../middlewares/honeypot.js';
import { validate } from '../middlewares/validate.js';
import { authenticate } from '../middlewares/authenticate.js';
import {
  sendOtpSchema,
  verifyOtpSchema,
  registerStudentSchema,
  registerTeacherSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
} from '../validations/authSchemas.js';

const router = express.Router();

// ─── CAPTCHA ──────────────────────────────────────────────────────────────────
router.get('/captcha', handleGetCaptcha);

// ─── Sign In / Sign Out / Session ─────────────────────────────────────────────
router.post(
  '/login',
  authLimiter,
  honeypotCheck,
  validate(loginSchema),
  handleLogin
);

router.post('/refresh-token', handleRefreshToken);

router.post('/logout', authenticate, handleLogout);

router.get('/me', authenticate, handleGetMe);

// ─── OTP Operations ───────────────────────────────────────────────────────────
router.post(
  '/send-otp',
  authLimiter,
  honeypotCheck,
  validate(sendOtpSchema),
  handleSendOtp
);

router.post(
  '/verify-otp',
  authLimiter,
  honeypotCheck,
  validate(verifyOtpSchema),
  handleVerifyOtp
);

// ─── Registration Endpoints (Public Onboarding) ───────────────────────────────
router.post(
  '/register-student',
  authLimiter,
  honeypotCheck,
  validate(registerStudentSchema),
  handleRegisterStudent
);

router.post(
  '/register-teacher',
  authLimiter,
  honeypotCheck,
  validate(registerTeacherSchema),
  handleRegisterTeacher
);

// ─── Password Recovery ────────────────────────────────────────────────────────
router.post(
  '/forgot-password',
  authLimiter,
  honeypotCheck,
  validate(passwordResetRequestSchema),
  handleForgotPassword
);

router.post(
  '/reset-password',
  authLimiter,
  honeypotCheck,
  validate(passwordResetConfirmSchema),
  handleResetPassword
);

export default router;
