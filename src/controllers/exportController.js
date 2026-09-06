import asyncHandler from 'express-async-handler';
import School from '../models/School.js';
import User from '../models/User.js';

/**
 * Escapes a CSV cell value safely.
 * Wraps in double quotes and escapes internal double-quotes.
 */
const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return '';
  const stringValue = String(value).replace(/"/g, '""');
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue}"`;
  }
  return stringValue;
};

const buildCsvRow = (cells) => cells.map(escapeCsvCell).join(',');

const getDateString = () => new Date().toISOString().slice(0, 10); // e.g. 2026-09-07

/**
 * GET /api/v1/export/schools.csv
 * Streams a CSV of all municipal schools.
 * Columns: name, code, emisCode, type, gender, address, phone, email, status, createdAt
 */
export const handleExportSchoolsCsv = asyncHandler(async (request, response) => {
  const schools = await School.find({}).sort({ name: 1 }).lean();

  const filename = `schools_${getDateString()}.csv`;
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // UTF-8 BOM for Excel compatibility
  response.write('\uFEFF');

  // Header row
  const headerRow = buildCsvRow([
    'School Name', 'School Code', 'EMIS Code', 'School Type',
    'Gender Type', 'Address', 'Contact Phone', 'Contact Email',
    'Status', 'Registered On',
  ]);
  response.write(headerRow + '\n');

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
      new Date(school.createdAt).toLocaleDateString('en-PK', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    ]);
    response.write(dataRow + '\n');
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
  const { role, status } = request.query;

  const queryFilter = {};
  if (role) queryFilter.role = role;
  if (status) queryFilter.status = status;

  const users = await User.find(queryFilter)
    .populate('townId', 'name')
    .populate('schoolId', 'name schoolCode')
    .sort({ role: 1, fullName: 1 })
    .select('-passwordHash -refreshTokenHash -otpSecret')
    .lean();

  const filename = `users_${getDateString()}.csv`;
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // UTF-8 BOM for Excel compatibility
  response.write('\uFEFF');

  // Header row
  const headerRow = buildCsvRow([
    'Full Name', 'Email', 'Role', 'Civil Designation',
    'Status', 'Town', 'School', 'Registered On',
  ]);
  response.write(headerRow + '\n');

  // Data rows
  for (const userRecord of users) {
    const dataRow = buildCsvRow([
      userRecord.fullName,
      userRecord.email,
      userRecord.role,
      userRecord.designation || '',
      userRecord.status,
      userRecord.townId?.name || '',
      userRecord.schoolId?.name || '',
      new Date(userRecord.createdAt).toLocaleDateString('en-PK', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    ]);
    response.write(dataRow + '\n');
  }

  response.end();
});
