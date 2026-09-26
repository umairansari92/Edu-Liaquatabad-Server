import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorizeRoles.js';
import { validate } from '../middlewares/validate.js';
import { authLimiter, otpLimiter } from '../middlewares/tripleLockRateLimiter.js';
import { ROLES } from '../../config/constants.js';
import {
  handleLookupWard,
  handleInitiateClaim,
  handleVerifyClaimOtp,
  handleGetMyClaims,
  handleGetMyWards,
} from '../controllers/parentLinkController.js';
import {
  lookupWardSchema,
  initiateClaimSchema,
  verifyClaimOtpSchema,
} from '../validations/parentSchemas.js';

const router = express.Router();

// All parent routes require authenticated session with PARENT role
router.use(authenticate);
router.use(authorizeRoles(ROLES.PARENT));

// ─── 1. Candidate Ward Lookup (Anti-Enumeration Guard) ───────────────────────
router.post(
  '/lookup-ward',
  authLimiter,
  validate(lookupWardSchema),
  handleLookupWard
);

// ─── 2. Initiate Ward Claim & OTP Dispatch ──────────────────────────────────
router.post(
  '/initiate-claim',
  authLimiter,
  validate(initiateClaimSchema),
  handleInitiateClaim
);

// ─── 3. Verify Claim Contact OTP ────────────────────────────────────────────
router.post(
  '/verify-claim-otp',
  otpLimiter,
  validate(verifyClaimOtpSchema),
  handleVerifyClaimOtp
);

// ─── 4. List All Claims (Pending & Verified) ────────────────────────────────
router.get('/my-claims', handleGetMyClaims);

// ─── 5. List Authoritative Verified Wards ───────────────────────────────────
router.get('/my-wards', handleGetMyWards);

export default router;
