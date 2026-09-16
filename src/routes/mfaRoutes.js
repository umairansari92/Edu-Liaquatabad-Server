import express from 'express';
import {
  handleMfaSetup,
  handleMfaConfirm,
  handleMfaVerifyLogin,
  handleMfaRecoveryLogin,
  handleMfaStatus,
  handleMfaDisable,
  handleMfaRegenerateRecoveryCodes,
  handleAdminMfaReset,
} from '../controllers/mfaController.js';
import {
  authenticateMfaPending,
  requireMfaVerified,
} from '../middlewares/requireMfa.js';
import { authenticate } from '../middlewares/authenticate.js';
import {
  mfaVerifyLimiter,
  mfaRecoveryLimiter,
  mfaSetupLimiter,
} from '../middlewares/tripleLockRateLimiter.js';
import { validate } from '../middlewares/validate.js';
import {
  mfaConfirmSetupSchema,
  mfaVerifyLoginSchema,
  mfaRecoveryLoginSchema,
  mfaStepUpPasswordSchema,
  adminMfaResetSchema,
} from '../validations/authSchemas.js';
import { verifyMfaPendingToken } from '../utils/tokenUtils.js';
import { sendError } from '../utils/apiResponse.js';

const router = express.Router();

/**
 * Flexible authenticator for MFA setup & confirmation.
 * Accepts either an active privileged session token or an MFA_PENDING ticket.
 */
const authenticateSessionOrMfaPending = async (request, response, nextFunction) => {
  const authHeader = request.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.split(' ')[1]
    : request.body?.mfaPendingToken;

  if (!token) {
    return sendError(response, 401, 'Authentication token is required.');
  }

  try {
    const decoded = verifyMfaPendingToken(token);
    if (decoded && decoded.tokenType === 'MFA_PENDING') {
      return authenticateMfaPending(request, response, nextFunction);
    }
  } catch {
    // Fall back to standard session authentication
  }

  return authenticate(request, response, nextFunction);
};

// ─── Setup & Enrollment ───────────────────────────────────────────────────────
router.post(
  '/setup',
  mfaSetupLimiter,
  authenticateSessionOrMfaPending,
  handleMfaSetup
);

router.post(
  '/confirm',
  mfaSetupLimiter,
  validate(mfaConfirmSetupSchema),
  authenticateSessionOrMfaPending,
  handleMfaConfirm
);

// ─── Step-2 Login Handshakes (Strictly MFA_PENDING ticket required) ───────────
router.post(
  '/verify-login',
  mfaVerifyLimiter,
  validate(mfaVerifyLoginSchema),
  authenticateMfaPending,
  handleMfaVerifyLogin
);

router.post(
  '/recovery-login',
  mfaRecoveryLimiter,
  validate(mfaRecoveryLoginSchema),
  authenticateMfaPending,
  handleMfaRecoveryLogin
);

// ─── Status Query (Authenticated session required) ────────────────────────────
router.get(
  '/status',
  authenticate,
  handleMfaStatus
);

// ─── Disable MFA (Authenticated session + step-up password required) ──────────
router.post(
  '/disable',
  mfaSetupLimiter,
  authenticate,
  requireMfaVerified,
  validate(mfaStepUpPasswordSchema),
  handleMfaDisable
);

// ─── Regenerate Recovery Codes (Authenticated session + step-up password) ─────
router.post(
  '/regenerate-recovery-codes',
  mfaSetupLimiter,
  authenticate,
  requireMfaVerified,
  validate(mfaStepUpPasswordSchema),
  handleMfaRegenerateRecoveryCodes
);

// ─── Admin Reset Subordinate MFA (Privileged Session + mfaVerified) ───────────
router.post(
  '/admin-reset/:userId',
  mfaSetupLimiter,
  authenticate,
  requireMfaVerified,
  validate(adminMfaResetSchema),
  handleAdminMfaReset
);

export default router;

