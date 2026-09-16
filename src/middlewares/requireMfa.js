import { verifyMfaPendingToken } from '../utils/tokenUtils.js';
import { sendError } from '../utils/apiResponse.js';
import { USER_STATUS, ROLES } from '../../config/constants.js';
import User from '../models/User.js';

/**
 * Authenticate intermediate MFA_PENDING ticket.
 * Exclusively accepts short-lived MFA_PENDING tokens for step-2 verification / recovery endpoints.
 */
export const authenticateMfaPending = async (request, response, nextFunction) => {
  try {
    const authHeader = request.headers.authorization;
    let bearerToken = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      bearerToken = authHeader.split(' ')[1];
    } else if (request.body?.mfaPendingToken) {
      bearerToken = request.body.mfaPendingToken;
    }

    if (!bearerToken) {
      return sendError(response, 401, 'MFA pending authorization ticket is required.');
    }

    const decoded = verifyMfaPendingToken(bearerToken);
    if (!decoded || !decoded.userId) {
      return sendError(response, 401, 'Invalid or expired MFA pending ticket.');
    }

    // Load user context with MFA secret and recovery code material
    const user = await User.findById(decoded.userId).select(
      '+mfa.secretCiphertext +mfa.secretIv +mfa.secretTag +mfa.pendingSecret +mfa.recoveryCodes +tokenVersion'
    );

    if (!user) {
      return sendError(response, 401, 'User account not found.');
    }

    if (user.status !== USER_STATUS.ACTIVE) {
      return sendError(response, 403, `Account is unavailable (Status: ${user.status}).`);
    }

    // Ensure session has not been invalidated since ticket issuance
    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return sendError(response, 401, 'MFA ticket has been invalidated due to a security update. Please sign in again.');
    }

    request.mfaUser = user;
    request.mfaTokenPayload = decoded;
    nextFunction();
  } catch (error) {
    return sendError(response, 401, 'MFA authentication ticket expired or invalid.', [{ message: error.message }]);
  }
};

/**
 * Require MFA Verified Assurance on Privileged Operations
 * Enforces that caller holds an active session with mfaVerified: true.
 * If user is ROOT_ADMIN or has mfa.enabled === true, password-only sessions are strictly rejected.
 */
export const requireMfaVerified = (request, response, nextFunction) => {
  if (!request.user) {
    return sendError(response, 401, 'Authentication is required.');
  }

  const isRootAdmin = request.user.role === ROLES.ROOT_ADMIN;
  const isMfaEnforced = isRootAdmin || request.user.mfaEnforced;

  if (isMfaEnforced && request.user.mfaVerified !== true) {
    return sendError(response, 403, 'Multi-Factor Authentication (MFA) verification is required for this operation.');
  }

  nextFunction();
};
