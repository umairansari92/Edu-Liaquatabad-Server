import express from 'express';
import {
  handleExportSchoolsCsv,
  handleExportUsersCsv,
  handleExportStaffCsv,
  handleExportStudentsCsv,
  handleExportGuardiansCsv,
} from '../controllers/exportController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorizeRoles } from '../middlewares/authorize.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

router.use(authenticate);

// ─── Export Municipal Schools CSV ──────────────────────────────────────────────
router.get('/schools',     authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN), handleExportSchoolsCsv);
router.get('/schools.csv', authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN), handleExportSchoolsCsv);

// ─── Export All Platform Users CSV (generic) ───────────────────────────────────
router.get('/users',     authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN), handleExportUsersCsv);
router.get('/users.csv', authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN), handleExportUsersCsv);

// ─── Export Staff Directory CSV ────────────────────────────────────────────────
// User + TeacherProfile join — excludes students/parents
router.get('/staff',     authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN), handleExportStaffCsv);
router.get('/staff.csv', authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN), handleExportStaffCsv);

// ─── Export Students Directory CSV ────────────────────────────────────────────
// StudentProfile + User + School + Class + Section join
router.get('/students',     authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM), handleExportStudentsCsv);
router.get('/students.csv', authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HM), handleExportStudentsCsv);

// ─── Export Guardians/Parents Directory CSV ────────────────────────────────────
// PARENT baseRole users with linked student names, GR Nos, schools
router.get('/guardians',     authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN), handleExportGuardiansCsv);
router.get('/guardians.csv', authorizeRoles(ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN), handleExportGuardiansCsv);

export default router;

