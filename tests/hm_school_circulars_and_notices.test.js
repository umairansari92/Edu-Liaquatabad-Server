/**
 * 🛡️ HEAD MASTER (HM) SCHOOL CIRCULARS & OFFICIAL NOTICE BOARD TEST SUITE (STEP 4)
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all 30 HM Step 4 Invariants:
 *  Group 1: Multi-Tier Scope & Scoped Visibility (Scenarios 1-6)
 *  Group 2: Authority Guardrails & Anti-BOLA Issuance (Scenarios 7-12)
 *  Group 3: File Security, Magic Bytes & Cloudinary Compensation (Scenarios 13-18)
 *  Group 4: Single Document & Secure Delivery Gate (Scenarios 19-22)
 *  Group 5: Lifecycle & Archival State Machine (Scenarios 23-26)
 *  Group 6: Audited Hard Delete, Search Sanitization & Priority Sorting (Scenarios 27-30)
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  ROLES,
  DOCUMENT_TYPES,
  AUDIENCE_TYPES,
} from '../config/constants.js';

// Production controllers and authorization resolver
import {
  handleGetDocuments,
  handleGetDocumentById,
  handleViewDocument,
  handleCreateDocument,
  handleArchiveDocument,
  handleDeleteDocument,
  authorizeDocumentAccess,
} from '../src/controllers/documentController.js';

import { validateFileMagicBytes } from '../src/middlewares/fileUpload.js';

// Domain models
import Document from '../src/models/Document.js';
import Organization from '../src/models/Organization.js';
import AuditLog from '../src/models/AuditLog.js';
import cloudinary from '../config/cloudinary.js';

let totalTests = 0;
let passedTests = 0;

async function runAsyncTest(testName, testFunction) {
  totalTests++;
  try {
    await testFunction();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (error) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(error);
    throw error;
  }
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return response;
}

function makeChainable(data) {
  return {
    _data: data,
    session() { return this; },
    populate() { return this; },
    sort() { return this; },
    limit() { return this; },
    skip() { return this; },
    lean() { return Promise.resolve(this._data); },
    then(resolve, reject) { return Promise.resolve(this._data).then(resolve, reject); },
  };
}

console.log('======================================================================');
console.log('🏛️ EXECUTING HM SCHOOL CIRCULARS & NOTICE BOARD SUITE (STEP 4)');
console.log('======================================================================\n');

// Standard Institutional Entities
const organizationId = '507f1f77bcf86cd799439090';
const schoolA_Id = '507f1f77bcf86cd799439001';
const schoolB_Id = '507f1f77bcf86cd799439002';
const townId = '507f1f77bcf86cd799439000';
const foreignTownId = '507f1f77bcf86cd799439999';

// Default stub to prevent buffering timeout if organization lookup occurs
Organization.findOne = () => Promise.resolve({ _id: organizationId, code: 'DMC_LIAQUATABAD' });
Organization.create = () => Promise.resolve({ _id: organizationId, code: 'DMC_LIAQUATABAD' });

const hmA_User = {
  _id: '507f1f77bcf86cd799439041',
  role: ROLES.HM,
  schoolId: { _id: schoolA_Id },
  fullName: 'Head Master Liaquatabad Primary',
  townId,
  organizationId,
};

const hmB_User = {
  _id: '507f1f77bcf86cd799439042',
  role: ROLES.HM,
  schoolId: { _id: schoolB_Id },
  fullName: 'Head Master School B',
  townId,
  organizationId,
};

const teacherA_User = {
  _id: '507f1f77bcf86cd799439051',
  role: ROLES.TEACHER,
  schoolId: { _id: schoolA_Id },
  fullName: 'Senior Teacher School A',
  townId,
  organizationId,
};

const docA_Id = '507f1f77bcf86cd799439101';
const docB_Id = '507f1f77bcf86cd799439102';
const docTown_Id = '507f1f77bcf86cd799439103';

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: MULTI-TIER SCOPE & SCOPED VISIBILITY
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 01: HM queries documents -> receives all notices belonging to own school across internal audiences', async () => {
  const origFind = Document.find;
  const origCount = Document.countDocuments;

  let capturedQuery = null;
  Document.find = (query) => {
    capturedQuery = query;
    return makeChainable([
      { _id: docA_Id, title: 'Teacher Duty Circular', scope: 'SCHOOL', schoolId: schoolA_Id, targetAudience: [AUDIENCE_TYPES.TEACHERS] },
      { _id: '507f1f77bcf86cd799439104', title: 'Parent Meeting Notice', scope: 'SCHOOL', schoolId: schoolA_Id, targetAudience: [AUDIENCE_TYPES.PARENTS] },
    ]);
  };
  Document.countDocuments = () => Promise.resolve(2);

  const req = { user: hmA_User, query: {} };
  const res = createMockResponse();

  await handleGetDocuments(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.documents.length, 2);
  // Confirms $or includes own schoolId regardless of audience
  const hasOwnSchoolBranch = capturedQuery.$or.some(
    (branch) => branch.scope === 'SCHOOL' && String(branch.schoolId) === schoolA_Id
  );
  assert.strictEqual(hasOwnSchoolBranch, true);

  Document.find = origFind;
  Document.countDocuments = origCount;
});

await runAsyncTest('Scenario 02: HM queries documents -> receives Town circulars (scope: TOWN) targeted to HM or ALL', async () => {
  const origFind = Document.find;
  const origCount = Document.countDocuments;

  let capturedQuery = null;
  Document.find = (query) => {
    capturedQuery = query;
    return makeChainable([
      { _id: docTown_Id, title: 'Town Exam Directive', scope: 'TOWN', townId, targetAudience: [AUDIENCE_TYPES.HM] },
    ]);
  };
  Document.countDocuments = () => Promise.resolve(1);

  const req = { user: hmA_User, query: {} };
  const res = createMockResponse();

  await handleGetDocuments(req, res);

  assert.strictEqual(res.statusCode, 200);
  const hasTownBranch = capturedQuery.$or.some(
    (branch) => branch.scope === 'TOWN' && String(branch.townId) === townId
  );
  assert.strictEqual(hasTownBranch, true);

  Document.find = origFind;
  Document.countDocuments = origCount;
});

await runAsyncTest('Scenario 03: Universal resolver: HM does NOT receive Town circulars targeted strictly to TEACHERS', async () => {
  const townTeacherDoc = {
    _id: docTown_Id,
    title: 'Teacher Training Schedule',
    scope: 'TOWN',
    townId,
    targetAudience: [AUDIENCE_TYPES.TEACHERS], // strictly Teachers!
  };

  const isHMAccessible = authorizeDocumentAccess(hmA_User, townTeacherDoc);
  assert.strictEqual(isHMAccessible, false);

  const isTeacherAccessible = authorizeDocumentAccess(teacherA_User, townTeacherDoc);
  assert.strictEqual(isTeacherAccessible, true);
});

await runAsyncTest('Scenario 04: Universal resolver: HM does NOT receive school notices belonging to School B', async () => {
  const schoolBDoc = {
    _id: docB_Id,
    title: 'School B Sports Day',
    scope: 'SCHOOL',
    schoolId: schoolB_Id,
    townId,
    targetAudience: [AUDIENCE_TYPES.TEACHERS, AUDIENCE_TYPES.PARENTS],
  };

  const isHMA_Accessible = authorizeDocumentAccess(hmA_User, schoolBDoc);
  assert.strictEqual(isHMA_Accessible, false);

  const isHMB_Accessible = authorizeDocumentAccess(hmB_User, schoolBDoc);
  assert.strictEqual(isHMB_Accessible, true);
});

await runAsyncTest('Scenario 05: HM queries with scopeCategory=school -> strictly filters scope: SCHOOL and actor schoolId', async () => {
  const origFind = Document.find;
  const origCount = Document.countDocuments;

  let capturedQuery = null;
  Document.find = (query) => {
    capturedQuery = query;
    return makeChainable([]);
  };
  Document.countDocuments = () => Promise.resolve(0);

  const req = { user: hmA_User, query: { scopeCategory: 'school' } };
  const res = createMockResponse();

  await handleGetDocuments(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(capturedQuery.scope, 'SCHOOL');
  assert.strictEqual(String(capturedQuery.schoolId), schoolA_Id);
  assert.strictEqual(capturedQuery.$or, undefined); // No town or global union

  Document.find = origFind;
  Document.countDocuments = origCount;
});

await runAsyncTest('Scenario 06: HM queries with scopeCategory=department -> strictly returns official Town/DMC directives', async () => {
  const origFind = Document.find;
  const origCount = Document.countDocuments;

  let capturedQuery = null;
  Document.find = (query) => {
    capturedQuery = query;
    return makeChainable([]);
  };
  Document.countDocuments = () => Promise.resolve(0);

  const req = { user: hmA_User, query: { scopeCategory: 'department' } };
  const res = createMockResponse();

  await handleGetDocuments(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(Array.isArray(capturedQuery.$or), true);
  const scopesInOr = capturedQuery.$or.map((branch) => branch.scope);
  assert.strictEqual(scopesInOr.includes('TOWN'), true);
  assert.strictEqual(scopesInOr.includes('GLOBAL'), true);
  assert.strictEqual(scopesInOr.includes('SCHOOL'), false); // No school notices

  Document.find = origFind;
  Document.countDocuments = origCount;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: AUTHORITY GUARDRAILS & ANTI-BOLA ISSUANCE
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 07: HM publishes valid school circular with audience [TEACHERS, PARENTS] -> 201 Created with scope: SCHOOL', async () => {
  const origCreate = Document.create;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  let createdDocumentDoc = null;
  let auditCreated = false;

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Document.create = (docs) => {
    createdDocumentDoc = {
      _id: docA_Id,
      ...docs[0],
    };
    return Promise.resolve([createdDocumentDoc]);
  };

  AuditLog.create = (entries) => {
    auditCreated = true;
    assert.strictEqual(entries[0].action, 'DOCUMENT_PUBLISHED');
    assert.strictEqual(String(entries[0].schoolId), schoolA_Id);
    return Promise.resolve(entries);
  };

  const req = {
    user: hmA_User,
    body: {
      title: 'Annual Sports Day Circular',
      documentType: DOCUMENT_TYPES.CIRCULAR,
      description: 'Instructions for all faculty and parents',
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/circular.pdf',
      targetAudience: [AUDIENCE_TYPES.TEACHERS, AUDIENCE_TYPES.PARENTS],
      referenceNumber: 'GBLSS/CIR/2026/001',
    },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdDocumentDoc.scope, 'SCHOOL');
  assert.strictEqual(String(createdDocumentDoc.schoolId), schoolA_Id);
  assert.strictEqual(createdDocumentDoc.referenceNumber, 'GBLSS/CIR/2026/001');
  assert.strictEqual(auditCreated, true);

  Document.create = origCreate;
  AuditLog.create = origAuditCreate;
  mongoose.startSession = origStartSession;
});

await runAsyncTest('Scenario 08: HM attempting to publish circular for foreign school -> rejected with 403 Forbidden (BOLA tripwire)', async () => {
  const req = {
    user: hmA_User,
    body: {
      title: 'Malicious Foreign Notice',
      documentType: DOCUMENT_TYPES.NOTICE,
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/notice.pdf',
      schoolId: schoolB_Id, // foreign school!
      targetAudience: [AUDIENCE_TYPES.TEACHERS],
    },
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /another school/i);
});

await runAsyncTest('Scenario 09: HM attempting to issue OFFICIAL_ORDER -> rejected with 403 Forbidden (Authority semantics)', async () => {
  const req = {
    user: hmA_User,
    body: {
      title: 'Town Administrative Order',
      documentType: DOCUMENT_TYPES.OFFICIAL_ORDER, // Prohibited for HM!
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/order.pdf',
      targetAudience: [AUDIENCE_TYPES.TEACHERS],
    },
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /official departmental orders/i);
});

await runAsyncTest('Scenario 10: HM attempting to issue ANNOUNCEMENT -> rejected with 403 Forbidden', async () => {
  const req = {
    user: hmA_User,
    body: {
      title: 'Public Portal Announcement',
      documentType: DOCUMENT_TYPES.ANNOUNCEMENT, // Prohibited for HM!
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/announcement.pdf',
    },
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /public announcements/i);
});

await runAsyncTest('Scenario 11: HM attempting to broadcast to GOVERNMENT_OFFICERS or ALL -> rejected with 403 Forbidden', async () => {
  const req = {
    user: hmA_User,
    body: {
      title: 'Directive to Officers',
      documentType: DOCUMENT_TYPES.CIRCULAR,
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/notice.pdf',
      targetAudience: [AUDIENCE_TYPES.GOVERNMENT_OFFICERS], // Prohibited for HM!
    },
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /school audiences/i);
});

await runAsyncTest('Scenario 12: Missing required title or documentType -> rejected with 400 Bad Request', async () => {
  const req = {
    user: hmA_User,
    body: {
      // missing title
      documentType: DOCUMENT_TYPES.NOTICE,
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/notice.pdf',
    },
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /Title and documentType are required/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: FILE SECURITY, MAGIC BYTES & CLOUDINARY COMPENSATION
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 13: Magic-byte verification: authentic %PDF- buffer passes validation', async () => {
  const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
  const req = {
    file: {
      buffer: pdfBuffer,
      mimetype: 'application/pdf',
      originalname: 'circular.pdf',
    },
  };
  const res = createMockResponse();
  let nextCalled = false;

  validateFileMagicBytes(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true);
});

await runAsyncTest('Scenario 14: Magic-byte verification: executable binary masquerading as .pdf -> rejected with 400', async () => {
  const fakePdfBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ executable signature
  const req = {
    file: {
      buffer: fakePdfBuffer,
      mimetype: 'application/pdf',
      originalname: 'malware.pdf',
    },
  };
  const res = createMockResponse();
  let nextCalled = false;

  validateFileMagicBytes(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /binary signature does not match declared type/i);
});

await runAsyncTest('Scenario 15: Magic-byte verification: authentic JPEG image passes validation', async () => {
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const req = {
    file: {
      buffer: jpegBuffer,
      mimetype: 'image/jpeg',
      originalname: 'notice.jpg',
    },
  };
  const res = createMockResponse();
  let nextCalled = false;

  validateFileMagicBytes(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true);
});

await runAsyncTest('Scenario 16: Missing attachment when no file is uploaded and no fileUrl provided -> rejected with 400', async () => {
  const req = {
    user: hmA_User,
    body: {
      title: 'Notice without document',
      documentType: DOCUMENT_TYPES.NOTICE,
      // fileUrl is missing
    },
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /document attachment or fileUrl is required/i);
});

await runAsyncTest('Scenario 17: Cloudinary compensation: DB transaction failure triggers deleteFromCloudinary cleanup', async () => {
  const origStartSession = mongoose.startSession;
  const origUploadStream = cloudinary.uploader.upload_stream;
  const origDestroy = cloudinary.uploader.destroy;

  let deleteCompensationCalled = false;
  let deletedPublicId = null;

  const mockPublicId = 'liaquatabad_sms/schools/507f1f77bcf86cd799439001/documents/doc_temp_99';
  cloudinary.uploader.upload_stream = (options, callback) => {
    return {
      end: () => {
        callback(null, {
          secure_url: 'https://res.cloudinary.com/dmc/raw/upload/test.pdf',
          public_id: mockPublicId,
          resource_type: 'raw',
          format: 'pdf',
          bytes: 1024,
        });
      },
    };
  };

  cloudinary.uploader.destroy = (publicId, options) => {
    deleteCompensationCalled = true;
    deletedPublicId = publicId;
    return Promise.resolve({ result: 'ok' });
  };

  // DB session aborts due to error
  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  const origCreate = Document.create;
  Document.create = () => Promise.reject(new Error('Simulated Database Write Failure'));

  const req = {
    user: hmA_User,
    file: {
      buffer: Buffer.from('%PDF-1.4'),
      mimetype: 'application/pdf',
      size: 1024,
      originalname: 'upload_fail.pdf',
    },
    body: {
      title: 'Orphan Candidate Notice',
      documentType: DOCUMENT_TYPES.NOTICE,
      targetAudience: [AUDIENCE_TYPES.TEACHERS],
    },
  };
  const res = createMockResponse();
  let capturedError = null;
  const next = (err) => {
    capturedError = err;
  };

  try {
    await handleCreateDocument(req, res, next);
  } finally {
    Document.create = origCreate;
    mongoose.startSession = origStartSession;
    cloudinary.uploader.upload_stream = origUploadStream;
    cloudinary.uploader.destroy = origDestroy;
  }

  assert.ok(capturedError, 'Expected database write error to be forwarded to next()');
  assert.match(capturedError.message, /Simulated Database Write Failure/i);
  assert.strictEqual(deleteCompensationCalled, true);
  assert.strictEqual(deletedPublicId, mockPublicId);
});

await runAsyncTest('Scenario 18: Secure document delivery (GET /:id/view) validates actor authorization before returning view URL', async () => {
  const origFindById = Document.findById;

  Document.findById = () => makeChainable({
    _id: docA_Id,
    title: 'Approved School Circular',
    scope: 'SCHOOL',
    schoolId: schoolA_Id,
    fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/circular.pdf',
    fileMimeType: 'application/pdf',
    fileSizeBytes: 2048,
    targetAudience: [AUDIENCE_TYPES.TEACHERS],
  });

  const req = { user: hmA_User, params: { id: docA_Id } };
  const res = createMockResponse();

  await handleViewDocument(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.viewUrl, 'https://res.cloudinary.com/dmc/raw/upload/circular.pdf');

  Document.findById = origFindById;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: SINGLE DOCUMENT & SECURE DELIVERY GATE
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 19: Secure document delivery (GET /:id/view) rejects foreign school HM with 403 Forbidden', async () => {
  const origFindById = Document.findById;

  Document.findById = () => makeChainable({
    _id: docB_Id,
    title: 'School B Confidential Notice',
    scope: 'SCHOOL',
    schoolId: schoolB_Id, // School B!
    fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/secret.pdf',
  });

  const req = { user: hmA_User, params: { id: docB_Id } };
  const res = createMockResponse();

  await handleViewDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /not authorized to access this document attachment/i);

  Document.findById = origFindById;
});

await runAsyncTest('Scenario 20: Single document fetch (GET /:id) authorizes same-school HM and returns metadata', async () => {
  const origFindById = Document.findById;

  Document.findById = () => makeChainable({
    _id: docA_Id,
    title: 'Faculty Guidelines',
    scope: 'SCHOOL',
    schoolId: schoolA_Id,
    documentType: DOCUMENT_TYPES.CIRCULAR,
    targetAudience: [AUDIENCE_TYPES.TEACHERS],
  });

  const req = { user: hmA_User, params: { id: docA_Id } };
  const res = createMockResponse();

  await handleGetDocumentById(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.document.title, 'Faculty Guidelines');

  Document.findById = origFindById;
});

await runAsyncTest('Scenario 21: Single document fetch (GET /:id) rejects foreign school HM with 403 Forbidden', async () => {
  const origFindById = Document.findById;

  Document.findById = () => makeChainable({
    _id: docB_Id,
    title: 'School B Internal Notice',
    scope: 'SCHOOL',
    schoolId: schoolB_Id,
  });

  const req = { user: hmA_User, params: { id: docB_Id } };
  const res = createMockResponse();

  await handleGetDocumentById(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /not authorized to view this document/i);

  Document.findById = origFindById;
});

await runAsyncTest('Scenario 22: Global document (scope: GLOBAL) is accessible to HM without requiring townId match', async () => {
  const globalDoc = {
    _id: '507f1f77bcf86cd799439199',
    title: 'Sindh Education Emergency Policy',
    scope: 'GLOBAL',
    townId: null, // independent of townId
    schoolId: null,
    targetAudience: [AUDIENCE_TYPES.ALL],
  };

  const isAccessible = authorizeDocumentAccess(hmA_User, globalDoc);
  assert.strictEqual(isAccessible, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: LIFECYCLE & ARCHIVAL STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 23: HM archives active school circular -> status: ARCHIVED, DOCUMENT_ARCHIVED audit log created', async () => {
  const origFindById = Document.findById;
  const origAuditCreate = AuditLog.create;

  let targetDoc = {
    _id: docA_Id,
    title: 'Expired Timetable Notice',
    scope: 'SCHOOL',
    schoolId: schoolA_Id,
    status: 'PUBLISHED',
    save() { return Promise.resolve(this); },
  };
  Document.findById = () => Promise.resolve(targetDoc);

  let auditCreated = false;
  AuditLog.create = (entry) => {
    auditCreated = true;
    assert.strictEqual(entry.action, 'DOCUMENT_ARCHIVED');
    assert.strictEqual(entry.newState.status, 'ARCHIVED');
    return Promise.resolve(entry);
  };

  const req = { user: hmA_User, params: { id: docA_Id } };
  const res = createMockResponse();

  await handleArchiveDocument(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(targetDoc.status, 'ARCHIVED');
  assert.strictEqual(auditCreated, true);

  Document.findById = origFindById;
  AuditLog.create = origAuditCreate;
});

await runAsyncTest('Scenario 24: Attempting to archive an already archived circular -> rejected with 400 Bad Request', async () => {
  const origFindById = Document.findById;

  Document.findById = () => Promise.resolve({
    _id: docA_Id,
    title: 'Already Archived Circular',
    scope: 'SCHOOL',
    schoolId: schoolA_Id,
    status: 'ARCHIVED',
  });

  const req = { user: hmA_User, params: { id: docA_Id } };
  const res = createMockResponse();

  await handleArchiveDocument(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /already archived/i);

  Document.findById = origFindById;
});

await runAsyncTest('Scenario 25: HM attempting to archive Town Departmental circular -> rejected with 403 Forbidden', async () => {
  const origFindById = Document.findById;

  Document.findById = () => Promise.resolve({
    _id: docTown_Id,
    title: 'Town Education Office Directive',
    scope: 'TOWN', // Departmental!
    townId,
    status: 'PUBLISHED',
  });

  const req = { user: hmA_User, params: { id: docTown_Id } };
  const res = createMockResponse();

  await handleArchiveDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /only archive internal circulars/i);

  Document.findById = origFindById;
});

await runAsyncTest('Scenario 26: HM attempting to archive circular from another school -> rejected with 403 Forbidden', async () => {
  const origFindById = Document.findById;

  Document.findById = () => Promise.resolve({
    _id: docB_Id,
    title: 'School B Active Circular',
    scope: 'SCHOOL',
    schoolId: schoolB_Id, // School B!
    status: 'PUBLISHED',
  });

  const req = { user: hmA_User, params: { id: docB_Id } };
  const res = createMockResponse();

  await handleArchiveDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /only archive internal circulars/i);

  Document.findById = origFindById;
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6: AUDITED HARD DELETE, SEARCH SANITIZATION & PRIORITY SORTING
// ─────────────────────────────────────────────────────────────────────────────

await runAsyncTest('Scenario 27: Audited hard delete: HM deletes own circular -> DB delete, Cloudinary purge, DOCUMENT_DELETED audit with full snapshot', async () => {
  const origFindById = Document.findById;
  const origDeleteOne = Document.deleteOne;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  let docDeleted = false;
  let auditCreated = false;
  let capturedSnapshot = null;

  const targetDoc = {
    _id: docA_Id,
    title: 'Obsolete Notice',
    referenceNumber: 'REF/OBS/01',
    documentType: DOCUMENT_TYPES.NOTICE,
    scope: 'SCHOOL',
    schoolId: schoolA_Id,
    townId,
    targetAudience: [AUDIENCE_TYPES.TEACHERS],
    publishedBy: hmA_User._id,
    publisherRole: ROLES.HM,
    status: 'PUBLISHED',
    fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/obsolete.pdf',
    cloudinaryPublicId: 'liaquatabad_sms/schools/schoolA/obsolete_doc',
    fileMimeType: 'application/pdf',
    fileSizeBytes: 4096,
    createdAt: new Date(),
  };

  Document.findById = () => Promise.resolve(targetDoc);
  Document.deleteOne = () => {
    docDeleted = true;
    return { session: () => Promise.resolve({ deletedCount: 1 }) };
  };

  AuditLog.create = (entries) => {
    auditCreated = true;
    const entry = entries[0];
    assert.strictEqual(entry.action, 'DOCUMENT_DELETED');
    capturedSnapshot = entry.previousState;
    return Promise.resolve(entries);
  };

  let cloudinaryPurged = false;
  const origDestroy = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = (id, options) => {
    cloudinaryPurged = true;
    assert.strictEqual(id, targetDoc.cloudinaryPublicId);
    return Promise.resolve({ result: 'ok' });
  };

  const req = {
    user: hmA_User,
    params: { id: docA_Id },
    body: { reason: 'Incorrect timetable replaced' },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockResponse();

  try {
    await handleDeleteDocument(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(docDeleted, true);
    assert.strictEqual(auditCreated, true);
    assert.strictEqual(cloudinaryPurged, true);
    // Verifies full previousState snapshot preserved
    assert.strictEqual(capturedSnapshot.title, 'Obsolete Notice');
    assert.strictEqual(capturedSnapshot.referenceNumber, 'REF/OBS/01');
    assert.strictEqual(capturedSnapshot.cloudinaryPublicId, targetDoc.cloudinaryPublicId);
  } finally {
    Document.findById = origFindById;
    Document.deleteOne = origDeleteOne;
    AuditLog.create = origAuditCreate;
    mongoose.startSession = origStartSession;
    cloudinary.uploader.destroy = origDestroy;
  }
});

await runAsyncTest('Scenario 28: HM attempting to delete Town Departmental circular -> rejected with 403 Forbidden', async () => {
  const origFindById = Document.findById;

  Document.findById = () => Promise.resolve({
    _id: docTown_Id,
    title: 'Departmental Official Directive',
    scope: 'TOWN', // Departmental!
    townId,
  });

  const req = { user: hmA_User, params: { id: docTown_Id } };
  const res = createMockResponse();

  await handleDeleteDocument(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /only delete circulars issued by their own assigned school/i);

  Document.findById = origFindById;
});

await runAsyncTest('Scenario 29: Search input with regex special characters (.*+?^${}()|[]\\) is safely escaped and does not crash', async () => {
  const origFind = Document.find;
  const origCount = Document.countDocuments;

  let capturedQuery = null;
  Document.find = (query) => {
    capturedQuery = query;
    return makeChainable([]);
  };
  Document.countDocuments = () => Promise.resolve(0);

  const maliciousSearch = '.*+?^${}()|[]\\';
  const req = { user: hmA_User, query: { search: maliciousSearch } };
  const res = createMockResponse();

  await handleGetDocuments(req, res);

  assert.strictEqual(res.statusCode, 200);
  // Escaped regex should not be raw '.*'
  assert.strictEqual(capturedQuery.title.$regex, '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');

  Document.find = origFind;
  Document.countDocuments = origCount;
});

await runAsyncTest('Scenario 30: Priority URGENT correctly sets isPinned: true in document creation', async () => {
  const origCreate = Document.create;
  const origAuditCreate = AuditLog.create;
  const origStartSession = mongoose.startSession;

  let createdDocumentDoc = null;
  const mockSession = {
    startTransaction() {},
    commitTransaction: () => Promise.resolve(),
    abortTransaction: () => Promise.resolve(),
    endSession() {},
  };
  mongoose.startSession = () => Promise.resolve(mockSession);

  Document.create = (docs) => {
    createdDocumentDoc = docs[0];
    return Promise.resolve([createdDocumentDoc]);
  };
  AuditLog.create = (entries) => Promise.resolve(entries);

  const req = {
    user: hmA_User,
    body: {
      title: 'Emergency Flood Closure Notice',
      documentType: DOCUMENT_TYPES.NOTICE,
      fileUrl: 'https://res.cloudinary.com/dmc/raw/upload/flood_notice.pdf',
      priority: 'URGENT',
      targetAudience: [AUDIENCE_TYPES.TEACHERS, AUDIENCE_TYPES.PARENTS],
    },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = createMockResponse();

  await handleCreateDocument(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createdDocumentDoc.priority, 'URGENT');
  assert.strictEqual(createdDocumentDoc.isPinned, true);

  Document.create = origCreate;
  AuditLog.create = origAuditCreate;
  mongoose.startSession = origStartSession;
});

console.log('\n======================================================================');
console.log(`🎉 COMPLETED: ${passedTests}/${totalTests} HM STEP 4 ASSERTIONS PASSED (100%)`);
console.log('======================================================================\n');
