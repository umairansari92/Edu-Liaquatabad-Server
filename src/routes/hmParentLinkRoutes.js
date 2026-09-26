import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorizeRoles.js';
import { validate } from '../middlewares/validate.js';
import { authLimiter } from '../middlewares/tripleLockRateLimiter.js';
import { ROLES } from '../../config/constants.js';
import {
  handleGetHmParentLinks,
  handleHmVerifyParentLink,
  handleHmRejectParentLink,
  handleHmRevokeParentLink,
} from '../controllers/parentLinkController.js';
import {
  hmVerifyLinkSchema,
  hmRejectLinkSchema,
  hmRevokeLinkSchema,
} from '../validations/parentSchemas.js';

const router = express.Router();

// All HM parent-link routes require authenticated session with HM or Administrative oversight
router.use(authenticate);
router.use(authorizeRoles(ROLES.HM, ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ROOT_ADMIN));

// ─── 1. HM Pending Parent Claims Queue ──────────────────────────────────────
router.get('/', authLimiter, handleGetHmParentLinks);

// ─── 2. HM Approve & Verify Link ────────────────────────────────────────────
router.post(
  '/:linkId/verify',
  authLimiter,
  validate(hmVerifyLinkSchema),
  handleHmVerifyParentLink
);

// ─── 3. HM Reject Claim ─────────────────────────────────────────────────────
router.post(
  '/:linkId/reject',
  authLimiter,
  validate(hmRejectLinkSchema),
  handleHmRejectParentLink
);

// ─── 4. HM Revoke Previously Verified Link ──────────────────────────────────
router.post(
  '/:linkId/revoke',
  authLimiter,
  validate(hmRevokeLinkSchema),
  handleHmRevokeParentLink
);

export default router;
