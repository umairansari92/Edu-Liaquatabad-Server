import express from 'express';
import { handleExportSchoolsCsv, handleExportUsersCsv } from '../controllers/exportController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

router.use(authenticate);

// ─── Export Municipal Schools CSV ──────────────────────────────────────────────
// Accepts both /exports/schools and /exports/schools.csv (client compatibility)
router.get(
  '/schools',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  handleExportSchoolsCsv
);
router.get(
  '/schools.csv',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN),
  handleExportSchoolsCsv
);

// ─── Export Platform Users CSV ─────────────────────────────────────────────────
// Accepts both /exports/users and /exports/users.csv (client compatibility)
router.get(
  '/users',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN),
  handleExportUsersCsv
);
router.get(
  '/users.csv',
  authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN),
  handleExportUsersCsv
);

export default router;
