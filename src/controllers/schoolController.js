/**
 * Municipal School Infrastructure Controller
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Enforces dynamic multi-school registration and governance.
 * Accessible to ROOT_ADMIN, SUPER_ADMIN, and ADMIN (DDO).
 */

import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import School from '../models/School.js';
import Organization from '../models/Organization.js';
import Town from '../models/Town.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, SCOPES } from '../../config/constants.js';

/**
 * Helper to write immutable audit record
 */
const writeSchoolAuditLog = async ({
  actorId,
  actorRole,
  actorDesignation,
  actorName,
  action,
  targetSchoolId,
  targetSchoolName,
  townId,
  previousState,
  newState,
  result,
  reason,
  ipAddress,
  userAgent,
  requestId,
}) => {
  await AuditLog.create({
    actorId,
    actorRole,
    actorDesignation: actorDesignation || '',
    actorName: actorName || '',
    action,
    targetModel: 'School',
    targetId: targetSchoolId,
    targetName: targetSchoolName,
    townId: townId || null,
    schoolId: targetSchoolId,
    previousState,
    newState,
    result,
    reason: reason || 'Municipal school operational event',
    ipAddress: ipAddress || '',
    userAgent: userAgent || '',
    requestId: requestId || '',
  });
};

/**
 * POST /api/v1/schools
 * Register a new municipal school entity.
 * Permitted actors: ROOT_ADMIN, SUPER_ADMIN, ADMIN
 */
export const handleCreateSchool = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    name,
    schoolCode,
    emisCode,
    schoolType,
    genderType,
    address,
    contactPhone = '',
    contactEmail = '',
    status = 'ACTIVE',
  } = request.body;

  // 1. Resolve Town & Organization
  let targetTownId = requestingActor.townId;
  let targetOrganizationId = requestingActor.organizationId;

  if (!targetTownId || !targetOrganizationId) {
    let defaultTown = await Town.findOne({ code: 'TOWN_LIAQ' });
    if (!defaultTown) {
      let defaultOrganization = await Organization.findOne({ code: 'DMC_LIAQUATABAD' });
      if (!defaultOrganization) {
        defaultOrganization = await Organization.create({
          name: 'Education Department (DMC)',
          code: 'DMC_LIAQUATABAD',
          description: 'Liaquatabad Municipal District Education Governance Authority',
        });
      }
      defaultTown = await Town.create({
        organizationId: defaultOrganization._id,
        name: 'Liaquatabad Town Centre',
        code: 'TOWN_LIAQ',
        officeAddress: 'Main Liaquatabad Town Municipal Administration Complex, Karachi',
      });
    }
    targetTownId = defaultTown._id;
    targetOrganizationId = defaultTown.organizationId;
  }

  // 2. Uniqueness Checks
  if (schoolCode) {
    const existingSchoolCode = await School.findOne({ schoolCode: schoolCode.toUpperCase().trim() });
    if (existingSchoolCode) {
      return sendError(response, 409, `School code "${schoolCode.toUpperCase().trim()}" is already assigned to another municipal institution.`);
    }
  }

  if (emisCode && emisCode.trim()) {
    const existingEmisCode = await School.findOne({ emisCode: emisCode.trim() });
    if (existingEmisCode) {
      return sendError(response, 409, `EMIS code "${emisCode.trim()}" is already registered in the municipal registry.`);
    }
  }

  // 3. Create Municipal School Entity
  const newSchool = await School.create({
    organizationId: targetOrganizationId,
    townId: targetTownId,
    name: name.trim(),
    schoolCode: schoolCode ? schoolCode.toUpperCase().trim() : undefined,
    schoolCodeSetBy: schoolCode ? requestingActor._id : null,
    schoolCodeSetAt: schoolCode ? new Date() : null,
    emisCode: emisCode ? emisCode.trim() : undefined,
    schoolType,
    genderType,
    address: address.trim(),
    contactPhone: contactPhone.trim(),
    contactEmail: contactEmail.trim().toLowerCase(),
    status,
  });

  // 4. Record Immutable Audit Trail
  await writeSchoolAuditLog({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: 'MUNICIPAL_SCHOOL_REGISTERED',
    targetSchoolId: newSchool._id,
    targetSchoolName: newSchool.name,
    townId: targetTownId,
    previousState: null,
    newState: {
      name: newSchool.name,
      schoolCode: newSchool.schoolCode,
      emisCode: newSchool.emisCode,
      schoolType: newSchool.schoolType,
      genderType: newSchool.genderType,
      status: newSchool.status,
    },
    result: 'SUCCESS',
    reason: `Municipal school institution registered by ${requestingActor.role} (${requestingActor.fullName}).`,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 201, 'Municipal school registered successfully.', {
    school: newSchool,
  });
});

/**
 * GET /api/v1/schools
 * List all municipal schools (scoped by caller authority)
 */
export const handleGetSchools = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const {
    search,
    schoolType,
    genderType,
    status,
    page = 1,
    limit = 50,
  } = request.query;

  const filterQuery = {};

  // Scope Enforcement
  if (requestingActor.role === ROLES.SUPERVISOR) {
    filterQuery._id = { $in: requestingActor.assignedSchools || [] };
  } else if ([ROLES.HM, ROLES.TEACHER].includes(requestingActor.role)) {
    filterQuery._id = requestingActor.schoolId;
  }

  // Search by Name, Code, EMIS, or Address
  if (search && typeof search === 'string') {
    const escapedSearchString = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filterQuery.$or = [
      { name: { $regex: escapedSearchString, $options: 'i' } },
      { schoolCode: { $regex: escapedSearchString, $options: 'i' } },
      { emisCode: { $regex: escapedSearchString, $options: 'i' } },
      { address: { $regex: escapedSearchString, $options: 'i' } },
    ];
  }

  if (schoolType) filterQuery.schoolType = schoolType;
  if (genderType) filterQuery.genderType = genderType;
  if (status) filterQuery.status = status;

  const safePageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimitNumber = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const skipCount = (safePageNumber - 1) * safeLimitNumber;

  const [schoolsList, totalSchoolsCount] = await Promise.all([
    School.find(filterQuery)
      .populate('townId', 'name code')
      .sort({ name: 1 })
      .skip(skipCount)
      .limit(safeLimitNumber)
      .lean(),
    School.countDocuments(filterQuery),
  ]);

  // Attach Faculty and Student Counts dynamically
  const enrichedSchools = await Promise.all(
    schoolsList.map(async (schoolRecord) => {
      const [facultyCount, headMasterUser] = await Promise.all([
        User.countDocuments({ schoolId: schoolRecord._id, role: ROLES.TEACHER, status: 'ACTIVE' }),
        User.findOne({ schoolId: schoolRecord._id, role: ROLES.HM, status: 'ACTIVE' }).select('fullName email phoneNumber designation').lean(),
      ]);

      return {
        ...schoolRecord,
        facultyCount,
        headMaster: headMasterUser ? headMasterUser.fullName : 'Vacant / Not Appointed',
        headMasterContact: headMasterUser ? headMasterUser.phoneNumber : schoolRecord.contactPhone,
      };
    })
  );

  return sendSuccess(response, 200, 'Municipal schools retrieved successfully.', {
    schools: enrichedSchools,
    total: totalSchoolsCount,
    page: safePageNumber,
    totalPages: Math.ceil(totalSchoolsCount / safeLimitNumber),
  });
});

/**
 * GET /api/v1/schools/:id
 * Retrieve single municipal school details
 */
export const handleGetSchoolById = asyncHandler(async (request, response) => {
  const { id: targetSchoolId } = request.params;

  const schoolRecord = await School.findById(targetSchoolId)
    .populate('townId', 'name code officeAddress')
    .populate('organizationId', 'name code')
    .lean();

  if (!schoolRecord) {
    return sendError(response, 404, 'Municipal school entity not found.');
  }

  const [facultyMembersList, headMasterUser] = await Promise.all([
    User.find({ schoolId: targetSchoolId, role: ROLES.TEACHER })
      .select('fullName email designation phoneNumber status')
      .lean(),
    User.findOne({ schoolId: targetSchoolId, role: ROLES.HM }).select('fullName email designation phoneNumber status').lean(),
  ]);

  return sendSuccess(response, 200, 'Municipal school details retrieved.', {
    school: {
      ...schoolRecord,
      headMaster: headMasterUser,
      faculty: facultyMembersList,
      facultyTotal: facultyMembersList.length,
    },
  });
});

/**
 * PATCH /api/v1/schools/:id
 * Update municipal school details
 */
export const handleUpdateSchool = asyncHandler(async (request, response) => {
  const requestingActor = request.user;
  const { id: targetSchoolId } = request.params;

  // ── SEC-CRIT-02: ObjectId format validation ───────────────────────────────────
  if (!targetSchoolId || !/^[0-9a-fA-F]{24}$/.test(targetSchoolId)) {
    return sendError(response, 400, 'Invalid school ID format. Must be a valid 24-character hexadecimal MongoDB ObjectId.');
  }

  const {
    name,
    schoolCode,
    emisCode,
    schoolType,
    genderType,
    address,
    contactPhone,
    contactEmail,
    status,
    reason = 'Municipal administrative update',
  } = request.body;

  const schoolRecord = await School.findById(targetSchoolId);
  if (!schoolRecord) {
    return sendError(response, 404, 'Municipal school not found.');
  }

  // ── SEC-CRIT-02: Controller-level jurisdictional assertion (defense-in-depth) ─
  // Even if authorizeScope middleware were somehow bypassed, the controller
  // independently enforces the ADMIN town boundary.
  if (requestingActor.role === ROLES.ADMIN) {
    if (!requestingActor.townId) {
      await writeSchoolAuditLog({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName: requestingActor.fullName || '',
        action: 'ADMIN_NO_TOWN_SCHOOL_UPDATE_BLOCKED',
        targetSchoolId: schoolRecord._id,
        targetSchoolName: schoolRecord.name,
        townId: null,
        previousState: { townId: String(schoolRecord.townId) },
        newState: {},
        result: 'DENIED',
        reason: 'CONTROLLER_GUARD: ADMIN actor has no townId assigned — cannot update any school.',
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        requestId: request.headers['x-request-id'] || '',
      });
      return sendError(response, 403, 'Access denied. Your administrative account has no town assignment.');
    }

    if (String(schoolRecord.townId) !== String(requestingActor.townId)) {
      await writeSchoolAuditLog({
        actorId: requestingActor._id || requestingActor.userId,
        actorRole: requestingActor.role,
        actorDesignation: requestingActor.designation || '',
        actorName: requestingActor.fullName || '',
        action: 'ADMIN_CROSS_TOWN_SCHOOL_UPDATE_BLOCKED',
        targetSchoolId: schoolRecord._id,
        targetSchoolName: schoolRecord.name,
        townId: requestingActor.townId,
        previousState: { schoolTownId: String(schoolRecord.townId), actorTownId: String(requestingActor.townId) },
        newState: {},
        result: 'DENIED',
        reason: `CONTROLLER_GUARD: ADMIN cannot update a school outside their administrative jurisdiction. School town: ${schoolRecord.townId}, Actor town: ${requestingActor.townId}.`,
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        requestId: request.headers['x-request-id'] || '',
      });
      return sendError(
        response,
        403,
        'Access denied. You do not have jurisdictional authority over schools in another administrative town.'
      );
    }
  }

  const previousState = {
    name: schoolRecord.name,
    schoolCode: schoolRecord.schoolCode,
    emisCode: schoolRecord.emisCode,
    schoolType: schoolRecord.schoolType,
    genderType: schoolRecord.genderType,
    address: schoolRecord.address,
    status: schoolRecord.status,
  };

  if (name !== undefined) schoolRecord.name = name.trim();
  if (schoolType !== undefined) schoolRecord.schoolType = schoolType;
  if (genderType !== undefined) schoolRecord.genderType = genderType;
  if (address !== undefined) schoolRecord.address = address.trim();
  if (contactPhone !== undefined) schoolRecord.contactPhone = contactPhone.trim();
  if (contactEmail !== undefined) schoolRecord.contactEmail = contactEmail.trim().toLowerCase();
  if (status !== undefined) schoolRecord.status = status;

  if (schoolCode !== undefined && schoolCode.trim() !== schoolRecord.schoolCode) {
    const codeConflict = await School.findOne({
      schoolCode: schoolCode.toUpperCase().trim(),
      _id: { $ne: schoolRecord._id },
    });
    if (codeConflict) {
      return sendError(response, 409, `School code "${schoolCode}" is already assigned to another school.`);
    }
    schoolRecord.schoolCode = schoolCode.toUpperCase().trim();
    schoolRecord.schoolCodeSetBy = requestingActor._id;
    schoolRecord.schoolCodeSetAt = new Date();
  }

  if (emisCode !== undefined && emisCode.trim() !== schoolRecord.emisCode) {
    const emisConflict = await School.findOne({
      emisCode: emisCode.trim(),
      _id: { $ne: schoolRecord._id },
    });
    if (emisConflict) {
      return sendError(response, 409, `EMIS code "${emisCode}" is already in use.`);
    }
    schoolRecord.emisCode = emisCode.trim();
  }

  await schoolRecord.save();

  const newState = {
    name: schoolRecord.name,
    schoolCode: schoolRecord.schoolCode,
    emisCode: schoolRecord.emisCode,
    schoolType: schoolRecord.schoolType,
    genderType: schoolRecord.genderType,
    address: schoolRecord.address,
    status: schoolRecord.status,
  };

  await writeSchoolAuditLog({
    actorId: requestingActor._id || requestingActor.userId,
    actorRole: requestingActor.role,
    actorDesignation: requestingActor.designation || '',
    actorName: requestingActor.fullName || '',
    action: 'MUNICIPAL_SCHOOL_UPDATED',
    targetSchoolId: schoolRecord._id,
    targetSchoolName: schoolRecord.name,
    townId: schoolRecord.townId,
    previousState,
    newState,
    result: 'SUCCESS',
    reason,
    ipAddress: request.ip || '',
    userAgent: request.headers['user-agent'] || '',
    requestId: request.headers['x-request-id'] || '',
  });

  return sendSuccess(response, 200, 'Municipal school updated successfully.', {
    school: schoolRecord,
  });
});
