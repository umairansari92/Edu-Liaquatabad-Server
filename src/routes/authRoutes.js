import express from 'express';
import {
  handleGetCaptcha,
  handleSendOtp,
  handleVerifyOtp,
  handleRegisterStudent,
  handleRegisterTeacher,
  handleRegisterStaff,
  handleLogin,
  handleRefreshToken,
  handleLogout,
  handleGetMe,
  handleForgotPassword,
  handleResetPassword,
  handleResubmitCorrection,
} from '../controllers/authController.js';
import {
  authLimiter,
  loginLimiter,
  captchaLimiter,
  otpLimiter,
  registrationLimiter,
  refreshTokenLimiter,
} from '../middlewares/tripleLockRateLimiter.js';
import { honeypotCheck } from '../middlewares/honeypot.js';
import { validate } from '../middlewares/validate.js';
import { authenticate } from '../middlewares/authenticate.js';
import {
  sendOtpSchema,
  verifyOtpSchema,
  registerStudentSchema,
  registerTeacherSchema,
  registerStaffSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
} from '../validations/authSchemas.js';

const router = express.Router();

// ─── CAPTCHA ──────────────────────────────────────────────────────────────────
router.get('/captcha', captchaLimiter, handleGetCaptcha);

// ─── Sign In / Sign Out / Session ─────────────────────────────────────────────
router.post(
  '/login',
  loginLimiter,
  honeypotCheck,
  validate(loginSchema),
  handleLogin
);

router.post('/refresh-token', refreshTokenLimiter, handleRefreshToken);

router.post('/logout', authenticate, handleLogout);

router.get('/me', authenticate, handleGetMe);

// ─── OTP Operations ───────────────────────────────────────────────────────────
router.post(
  '/send-otp',
  otpLimiter,
  honeypotCheck,
  validate(sendOtpSchema),
  handleSendOtp
);

router.post(
  '/verify-otp',
  otpLimiter,
  honeypotCheck,
  validate(verifyOtpSchema),
  handleVerifyOtp
);

// ─── Registration Endpoints (Public Onboarding) ───────────────────────────────
router.post(
  '/register-student',
  registrationLimiter,
  honeypotCheck,
  validate(registerStudentSchema),
  handleRegisterStudent
);

router.post(
  '/register-teacher',
  registrationLimiter,
  honeypotCheck,
  validate(registerTeacherSchema),
  handleRegisterTeacher
);

router.post(
  '/register-staff',
  registrationLimiter,
  honeypotCheck,
  validate(registerStaffSchema),
  handleRegisterStaff
);

router.post(
  '/resubmit-correction',
  authLimiter,
  honeypotCheck,
  handleResubmitCorrection
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
