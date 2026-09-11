import asyncHandler from 'express-async-handler';
import School from '../models/School.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import TeacherProfile from '../models/TeacherProfile.js';
import AuditLog from '../models/AuditLog.js';
import { BASE_ROLES } from '../../config/constants.js';

/**
 * Always-quote CSV cell strategy (RFC 4180 safe).
 * Wraps every value in double quotes and escapes internal double-quotes by doubling them.
 * Prevents column shift in Excel when values contain commas or newlines.
 */
const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return '""';
  const stringValue = String(value).replace(/"/g, '""');
  return `"${stringValue}"`;
};

const buildCsvRow = (cells) => cells.map(escapeCsvCell).join(',');

const getDateString = () => new Date().toISOString().slice(0, 10);

const formatDate = (d) => (d ? new Date(d).toISOString().split('T')[0] : '');

/** Write an immutable audit log entry for each export event */
const writeExportAudit = async (actor, request, action, totalRecords, filename) => {
  try {
    await AuditLog.create({
      actorId:          actor._id || actor.userId,
      actorRole:        actor.role,
      actorDesignation: actor.designation || '',
      actorName:        actor.fullName    || '',
      action,
      result:           'SUCCESS',
      reason:           `Official CSV export initiated by ${actor.role}`,
      requestMetadata: {
        ipAddress: request.ip || 'unknown',
        userAgent: request.headers['user-agent'] || 'unknown',
        method:    request.method,
        url:       request.originalUrl,
      },
      details: { totalRecords, filename, exportedAt: new Date().toISOString() },
    });
  } catch (auditErr) {
    console.error(`[ExportController] Audit write failed (${action}):`, auditErr.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/export/schools.csv
 * Streams a CSV of all municipal schools.
 */
export const handleExportSchoolsCsv = asyncHandler(async (request, response) => {
  const actor  = request.user;
  const schools = await School.find({}).sort({ name: 1 }).lean();

  const filename = `schools_${getDateString()}.csv`;
  response
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'no-store');

  response.write('\uFEFF');
  response.write(buildCsvRow([
    'School Name', 'School Code', 'EMIS Code', 'School Type',
    'Gender Type', 'Address', 'Contact Phone', 'Contact Email',
    'Status', 'Registered On',
  ]) + '\r\n');

  for (const school of schools) {
    response.write(buildCsvRow([
      school.name,
      school.schoolCode || '',
      school.emisCode || '',
      school.schoolType,
      school.genderType,
      school.address,
      school.contactPhone || '',
      school.contactEmail || '',
      school.status,
      formatDate(school.createdAt),
    ]) + '\r\n');
  }

  await writeExportAudit(actor, request, 'SCHOOLS_CSV_EXPORTED', schools.length, filename);
  response.end();
});

/**
 * GET /api/v1/export/users.csv
 * Streams a CSV of all platform users (generic — ROOT_ADMIN hidden).
 */
export const handleExportUsersCsv = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { role, status } = request.query;

  const queryFilter = { role: { $ne: 'ROOT_ADMIN' } };
  if (role) {
    queryFilter.role = role === 'ROOT_ADMIN' ? '__NEVER_MATCH_HIDDEN__' : role;
  }
  if (status) queryFilter.status = status;

  const users = await User.find(queryFilter)
    .populate('townId', 'name')
    .populate('schoolId', 'name schoolCode')
    .sort({ role: 1, fullName: 1 })
    .select('-passwordHash -refreshTokenHash -otpSecret')
    .lean();

  const filename = `users_${getDateString()}.csv`;
  response
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'no-store');

  response.write('\uFEFF');
  response.write(buildCsvRow([
    'Full Name', 'Email', 'Role', 'Civil Designation',
    'Base Role', 'Scope', 'Status', 'Assigned School', 'School Code', 'Registered On',
  ]) + '\r\n');

  for (const u of users) {
    response.write(buildCsvRow([
      u.fullName,
      u.email,
      u.role,
      u.designation || '',
      u.baseRole    || '',
      u.scope       || '',
      u.status,
      u.schoolId?.name       || '',
      u.schoolId?.schoolCode || '',
      formatDate(u.createdAt),
    ]) + '\r\n');
  }

  await writeExportAudit(actor, request, 'PERSONNEL_CSV_EXPORTED', users.length, filename);
  response.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW DOMAIN-SPECIFIC EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/export/staff.csv
 * Full staff directory export: User + TeacherProfile join.
 * Query params (optional): schoolId, role, status, search
 * Authorized: ADMIN, SUPER_ADMIN, ROOT_ADMIN
 */
export const handleExportStaffCsv = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { schoolId, role, status, search } = request.query;

  // Build User query — exclude academic entities (students/parents)
  const userFilter = {
    role:     { $ne: 'ROOT_ADMIN' },
    baseRole: { $nin: [BASE_ROLES.STUDENT, BASE_ROLES.PARENT] },
  };
  if (role) userFilter.role = role;
  if (status) userFilter.status = status;
  if (schoolId) userFilter.schoolId = schoolId;
  if (search) {
    userFilter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email:    { $regex: search, $options: 'i' } },
    ];
  }

  const staffUsers = await User.find(userFilter)
    .populate('schoolId', 'name schoolCode')
    .sort({ fullName: 1 })
    .select('-passwordHash -refreshTokenHash -otpSecret')
    .lean();

  // Fetch TeacherProfiles keyed by userId for O(1) lookup
  const staffUserIds = staffUsers.map((u) => u._id);
  const teacherProfiles = await TeacherProfile.find({ userId: { $in: staffUserIds } })
    .populate('currentSchoolId', 'name schoolCode')
    .lean();
  const profileMap = {};
  for (const tp of teacherProfiles) {
    profileMap[String(tp.userId)] = tp;
  }

  const filename = `staff_directory_${getDateString()}.csv`;
  response
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'no-store');

  response.write('\uFEFF');
  response.write(buildCsvRow([
    'Full Name', 'Email', 'Phone Number',
    'Civil Designation', 'Base Role', 'System Role', 'Scope',
    'Assigned School', 'School Code',
    'Employee ID', 'Qualification', 'Subject Specialization',
    'Joining Date', 'Account Status', 'Registered On',
  ]) + '\r\n');

  for (const u of staffUsers) {
    const profile = profileMap[String(u._id)] || {};
    response.write(buildCsvRow([
      u.fullName,
      u.email        || '',
      u.phoneNumber  || '',
      u.designation  || '',
      u.baseRole     || '',
      u.role,
      u.scope        || '',
      u.schoolId?.name       || profile.currentSchoolId?.name       || '',
      u.schoolId?.schoolCode || profile.currentSchoolId?.schoolCode || '',
      profile.employeeId             || '',
      profile.qualification          || '',
      (profile.specializationSubjects || []).join(' | '),
      formatDate(profile.joiningDate),
      u.status,
      formatDate(u.createdAt),
    ]) + '\r\n');
  }

  await writeExportAudit(actor, request, 'STAFF_CSV_EXPORTED', staffUsers.length, filename);
  response.end();
});

/**
 * GET /api/v1/export/students.csv
 * Full student directory export: StudentProfile + User + School + Class + Section.
 * Query params (optional): schoolId, classId, sectionId, status, search
 * Authorized: HM, SUPERVISOR, ADMIN, SUPER_ADMIN, ROOT_ADMIN
 */
export const handleExportStudentsCsv = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { schoolId, classId, sectionId, status, search } = request.query;

  const profileFilter = {};
  if (schoolId)  profileFilter.schoolId  = schoolId;
  if (classId)   profileFilter.classId   = classId;
  if (sectionId) profileFilter.sectionId = sectionId;
  if (status)    profileFilter.lifecycleStatus = status;

  let profiles = await StudentProfile.find(profileFilter)
    .populate('userId',    'fullName email phoneNumber status')
    .populate('schoolId',  'name schoolCode')
    .populate('classId',   'name numericGrade')
    .populate('sectionId', 'name')
    .populate('enrolledBy', 'fullName')
    .sort({ 'schoolId': 1, grNumber: 1 })
    .lean();

  // Search filter applied post-populate (name / GR No)
  if (search) {
    const searchLower = search.toLowerCase();
    profiles = profiles.filter((p) =>
      (p.userId?.fullName || '').toLowerCase().includes(searchLower) ||
      String(p.grNumber).includes(search) ||
      (p.globalStudentId || '').toLowerCase().includes(searchLower)
    );
  }

  const filename = `students_directory_${getDateString()}.csv`;
  response
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'no-store');

  response.write('\uFEFF');
  response.write(buildCsvRow([
    'Full Name', 'Email', 'Phone Number',
    'GR Number', 'Global Student ID',
    'School', 'School Code',
    'Class', 'Section',
    'Gender', 'Date of Birth',
    'Father / Guardian Name', 'Guardian Contact',
    'Residential Address',
    'Admission Type', 'Admission Date',
    'Lifecycle Status', 'Enrolled By', 'Registered On',
  ]) + '\r\n');

  for (const p of profiles) {
    response.write(buildCsvRow([
      p.userId?.fullName   || '',
      p.userId?.email      || '',
      p.userId?.phoneNumber || p.guardianContactNumber || '',
      p.grNumber,
      p.globalStudentId    || '',
      p.schoolId?.name     || '',
      p.schoolId?.schoolCode || '',
      p.classId?.name      || '',
      p.sectionId?.name    || '',
      p.gender             || '',
      formatDate(p.dateOfBirth),
      p.fatherOrGuardianName   || '',
      p.guardianContactNumber  || '',
      p.residentialAddress     || '',
      p.admissionType          || '',
      formatDate(p.admissionDate),
      p.lifecycleStatus        || '',
      p.enrolledBy?.fullName   || '',
      formatDate(p.createdAt),
    ]) + '\r\n');
  }

  await writeExportAudit(actor, request, 'STUDENTS_CSV_EXPORTED', profiles.length, filename);
  response.end();
});

/**
 * GET /api/v1/export/guardians.csv
 * Guardian/Parent directory with linked students list.
 * Query params (optional): status, search
 * Authorized: ADMIN, SUPER_ADMIN, ROOT_ADMIN
 */
export const handleExportGuardiansCsv = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { status, search } = request.query;

  const guardianFilter = { baseRole: BASE_ROLES.PARENT };
  if (status) guardianFilter.status = status;
  if (search) {
    guardianFilter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email:    { $regex: search, $options: 'i' } },
    ];
  }

  const guardians = await User.find(guardianFilter)
    .sort({ fullName: 1 })
    .select('-passwordHash -refreshTokenHash -otpSecret')
    .lean();

  // Fetch all linked students in a single batched query
  const guardianIds = guardians.map((g) => g._id);
  const linkedStudentProfiles = await StudentProfile.find({
    parentUserId: { $in: guardianIds },
  })
    .populate('userId',   'fullName')
    .populate('schoolId', 'name')
    .populate('classId',  'name')
    .lean();

  // Build guardian → students lookup map
  const studentsByGuardian = {};
  for (const sp of linkedStudentProfiles) {
    const key = String(sp.parentUserId);
    if (!studentsByGuardian[key]) studentsByGuardian[key] = [];
    studentsByGuardian[key].push(
      `${sp.userId?.fullName || 'Student'} (GR-${sp.grNumber}${sp.globalStudentId ? ' / ' + sp.globalStudentId : ''}, ${sp.schoolId?.name || ''}, ${sp.classId?.name || ''})`
    );
  }

  const filename = `guardians_directory_${getDateString()}.csv`;
  response
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'no-store');

  response.write('\uFEFF');
  response.write(buildCsvRow([
    'Full Name', 'Email', 'Phone Number',
    'Account Status',
    'Linked Students Count',
    'Linked Students (Name / GR No / School / Class)',
    'Registered On',
  ]) + '\r\n');

  for (const g of guardians) {
    const linkedStudents = studentsByGuardian[String(g._id)] || [];
    response.write(buildCsvRow([
      g.fullName,
      g.email        || '',
      g.phoneNumber  || '',
      g.status,
      linkedStudents.length,
      linkedStudents.join(' || '),
      formatDate(g.createdAt),
    ]) + '\r\n');
  }

  await writeExportAudit(actor, request, 'GUARDIANS_CSV_EXPORTED', guardians.length, filename);
  response.end();
});

