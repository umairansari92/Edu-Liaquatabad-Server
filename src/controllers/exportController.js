import asyncHandler from 'express-async-handler';
import School from '../models/School.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';

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

const getDateString = () => new Date().toISOString().slice(0, 10); // e.g. 2026-09-07

/**
 * GET /api/v1/export/schools.csv
 * Streams a CSV of all municipal schools.
 * Columns: name, code, emisCode, type, gender, address, phone, email, status, createdAt
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

  // UTF-8 BOM for Excel compatibility
  response.write('\uFEFF');

  // Header row
  const headerRow = buildCsvRow([
    'School Name', 'School Code', 'EMIS Code', 'School Type',
    'Gender Type', 'Address', 'Contact Phone', 'Contact Email',
    'Status', 'Registered On',
  ]);
  response.write(headerRow + '\r\n');

  // Data rows
  for (const school of schools) {
    const dataRow = buildCsvRow([
      school.name,
      school.schoolCode || '',
      school.emisCode || '',
      school.schoolType,
      school.genderType,
      school.address,
      school.contactPhone || '',
      school.contactEmail || '',
      school.status,
      new Date(school.createdAt).toISOString().split('T')[0],
    ]);
    response.write(dataRow + '\r\n');
  }

  // Immutable audit record
  try {
    await AuditLog.create({
      actorId:          actor._id || actor.userId,
      actorRole:        actor.role,
      actorDesignation: actor.designation || '',
      actorName:        actor.fullName    || '',
      action:           'SCHOOLS_CSV_EXPORTED',
      result:           'SUCCESS',
      reason:           `Official schools CSV export initiated by ${actor.role}`,
      requestMetadata: {
        ipAddress: request.ip || 'unknown',
        userAgent: request.headers['user-agent'] || 'unknown',
        method:    request.method,
        url:       request.originalUrl,
      },
      details: { totalRecords: schools.length, filename, exportedAt: new Date().toISOString() },
    });
  } catch (auditErr) {
    console.error('[ExportController] Audit write failed (schools):', auditErr.message);
  }

  response.end();
});

/**
 * GET /api/v1/export/users.csv
 * Streams a CSV of all platform users.
 * Query params: role, status (optional filters)
 * Columns: name, email, role, designation, status, townId, schoolId, createdAt
 */
export const handleExportUsersCsv = asyncHandler(async (request, response) => {
  const actor = request.user;
  const { role, status } = request.query;

  // ROOT_ADMIN Stealth: strictly exclude ROOT_ADMIN accounts from all official CSV exports
  const queryFilter = {
    role: { $ne: 'ROOT_ADMIN' },
  };
  if (role) {
    if (role === 'ROOT_ADMIN') {
      queryFilter.role = '__NEVER_MATCH_HIDDEN__';
    } else {
      queryFilter.role = role;
    }
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

  // UTF-8 BOM for Excel compatibility
  response.write('\uFEFF');

  // Header row
  const headerRow = buildCsvRow([
    'Full Name', 'Email', 'Role', 'Civil Designation',
    'Base Role', 'Scope', 'Status', 'Assigned School', 'School Code', 'Registered On',
  ]);
  response.write(headerRow + '\r\n');

  // Data rows
  for (const userRecord of users) {
    const dataRow = buildCsvRow([
      userRecord.fullName,
      userRecord.email,
      userRecord.role,
      userRecord.designation || '',
      userRecord.baseRole    || '',
      userRecord.scope       || '',
      userRecord.status,
      userRecord.schoolId?.name      || '',
      userRecord.schoolId?.schoolCode || '',
      new Date(userRecord.createdAt).toISOString().split('T')[0],
    ]);
    response.write(dataRow + '\r\n');
  }

  // Immutable audit record
  try {
    await AuditLog.create({
      actorId:          actor._id || actor.userId,
      actorRole:        actor.role,
      actorDesignation: actor.designation || '',
      actorName:        actor.fullName    || '',
      action:           'PERSONNEL_CSV_EXPORTED',
      result:           'SUCCESS',
      reason:           `Official personnel CSV export initiated by ${actor.role}`,
      requestMetadata: {
        ipAddress: request.ip || 'unknown',
        userAgent: request.headers['user-agent'] || 'unknown',
        method:    request.method,
        url:       request.originalUrl,
      },
      details: { totalRecords: users.length, filename, exportedAt: new Date().toISOString() },
    });
  } catch (auditErr) {
    console.error('[ExportController] Audit write failed (users):', auditErr.message);
  }

  response.end();
});

