import express from 'express';
import mfaRoutes from './mfaRoutes.js';
import {
  handleGetCaptcha,
  handleSendOtp,
  handleVerifyOtp,
  handleRegisterStudent,
  handleActivateStudentPortal,
  handleRegisterTeacher,
  handleRegisterStaff,
  handleRegisterParent,
  handleLogin,
  handleRefreshToken,
  handleLogout,
  handleGetMe,
  handleForgotPassword,
  handleResetPassword,
  handleResubmitCorrection,
  handleGetActiveSessions,
  handleTerminateSession,
} from '../controllers/authController.js';
import {
  authLimiter,
  loginLimiter,
  captchaLimiter,
  otpLimiter,
  registrationLimiter,
  refreshTokenLimiter,
  studentActivationLimiter,
} from '../middlewares/tripleLockRateLimiter.js';
import { honeypotCheck } from '../middlewares/honeypot.js';
import { validate } from '../middlewares/validate.js';
import { authenticate } from '../middlewares/authenticate.js';
import {
  sendOtpSchema,
  verifyOtpSchema,
  registerStudentSchema,
  studentPortalActivationSchema,
  registerTeacherSchema,
  registerStaffSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
} from '../validations/authSchemas.js';
import { registerParentSchema } from '../validations/parentSchemas.js';

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

// ─── Multi-Device Session Management ──────────────────────────────────────────
router.get('/sessions', authenticate, handleGetActiveSessions);
router.delete('/sessions/:sessionId', authenticate, handleTerminateSession);

// ─── Multi-Factor Authentication (MFA) ────────────────────────────────────────
router.use('/mfa', mfaRoutes);

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

// ─── Registration & Activation Endpoints (Public Onboarding) ──────────────────
router.post(
  '/register-student',
  registrationLimiter,
  honeypotCheck,
  validate(registerStudentSchema),
  handleRegisterStudent
);

router.post(
  '/activate-student-portal',
  studentActivationLimiter,
  honeypotCheck,
  validate(studentPortalActivationSchema),
  handleActivateStudentPortal
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
  '/register-parent',
  registrationLimiter,
  honeypotCheck,
  validate(registerParentSchema),
  handleRegisterParent
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
