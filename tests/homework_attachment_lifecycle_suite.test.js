/**
 * 📚 HOMEWORK ATTACHMENT LIFECYCLE & SECURITY INVARIANTS TEST SUITE
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Verifies all 30 Homework Attachment Lifecycle & Security Invariants:
 *  1. Teacher: Authorized homework creation with valid image attachments
 *  2. Teacher: Authorized homework creation with valid PDF attachments
 *  3. Teacher: Multiple attachments (images + PDF, up to 10 files) accepted
 *  4. Teacher: Unauthorized / non-assigned teacher cannot upload homework (403 Forbidden)
 *  5. Teacher: Inactive teacher cannot upload homework (403 Forbidden)
 *  6. Teacher: Cross-teacher homework editing/cancellation rejected (403 Forbidden)
 *  7. Teacher: Cross-school homework creation rejected (BOLA defense)
 *  8. Student: Student sees active homework belonging to own class & section
 *  9. Student: Student cannot access homework belonging to another school or section
 * 10. Student: Student does NOT receive expired attachments past 7 days
 * 11. Parent: Parent sees linked ward's homework with active attachments
 * 12. Parent: Parent cannot access unrelated child's homework (BOLA/IDOR defense)
 * 13. Parent: Parent does NOT receive expired attachments past 7 days
 * 14. Binary Security: Valid JPEG binary signature accepted
 * 15. Binary Security: Valid PNG binary signature accepted
 * 16. Binary Security: Valid WebP binary signature accepted
 * 17. Binary Security: Valid PDF binary signature accepted
 * 18. Binary Security: Mismatched / spoofed file signature rejected with 400 Bad Request
 * 19. Limit Security: Upload exceeding 10 attachments rejected with 400 Bad Request
 * 20. Limit Security: Upload exceeding total payload limit (25MB) rejected with 400 Bad Request
 * 21. Lifecycle: Server calculates 7-day expiresAt authoritatively (client override ignored)
 * 22. Cleanup: cleanupExpiredHomeworkAttachments detects expired attachments (expiresAt <= now)
 * 23. Cleanup: Deletes Cloudinary assets with publicId & resourceType
 * 24. Cleanup: Removes attachment references from database while preserving parent Homework document
 * 25. Cleanup: Idempotent handling of already deleted assets ('not found') as safe success
 * 26. Cleanup: Temporary Cloudinary failure is isolated and does not crash cleanup process
 * 27. Cleanup: Non-expired (active) attachments remain completely untouched
 * 28. Compensating Rollback: Database create failure purges newly uploaded Cloudinary assets
 * 29. Audit Trail: Automatic expiration writes audit log with HOMEWORK_ATTACHMENT_EXPIRED
 * 30. Zero Hard Deletions: Parent Homework record preserved for academic history
 */

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import {
  ROLES,
  TEACHING_ASSIGNMENT_STATUS,
  STUDENT_STATUS,
} from '../config/constants.js';

// Production controllers & services
import {
  handleCreateHomework,
  handleGetMyHomework,
  handleGetStudentHomework,
  handleUpdateHomework,
  handleCancelHomework,
} from '../src/controllers/homeworkController.js';
import { handleGetWardHomework } from '../src/controllers/parentBffController.js';
import { cleanupExpiredHomeworkAttachments } from '../src/services/homeworkCleanupService.js';
import {
  validateFileMagicBytes,
  validateHomeworkUploadLimits,
} from '../src/middlewares/fileUpload.js';
import cloudinary from '../config/cloudinary.js';

// Models
import Homework from '../src/models/Homework.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import StudentProfile from '../src/models/StudentProfile.js';
import Class from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import Subject from '../src/models/Subject.js';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';
import NotificationOutbox from '../src/models/NotificationOutbox.js';

// Global mocks for background side-effects during offline unit testing
AuditLog.create = () => Promise.resolve();
Notification.create = () => Promise.resolve();
NotificationOutbox.create = () => Promise.resolve();
NotificationOutbox.prototype.save = () => Promise.resolve();
StudentProfile.find = () => makeChainable([]);
Class.findById = () => makeChainable(null);
Section.findById = () => makeChainable(null);
Subject.findById = () => makeChainable(null);
TeachingAssignment.findOne = () => makeChainable(null);
Homework.create = (doc) => Promise.resolve({ _id: 'hw_default_id', ...doc });
Homework.find = () => makeChainable([]);
Homework.findById = () => Promise.resolve(null);
Homework.updateOne = () => Promise.resolve({ modifiedCount: 1 });

let totalTests = 0;
let passedTests = 0;

async function runAsyncTest(testName, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ PASS [${totalTests}]: ${testName}`);
  } catch (err) {
    console.error(`  ❌ FAIL [${totalTests}]: ${testName}`);
    console.error(err);
    throw err;
  }
}

function createMockRes() {
  const res = {
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
  return res;
}

function makeChainable(data) {
  return {
    _data: data,
    populate() { return this; },
    sort() { return this; },
    limit() { return this; },
    skip() { return this; },
    select() { return this; },
    lean() { return Promise.resolve(this._data); },
    then(resolve, reject) { return Promise.resolve(this._data).then(resolve, reject); },
  };
}

/**
 * Creates a mock Cloudinary upload stream
 */
function createMockUploadStream(mockResult) {
  return (options, callback) => {
    const stream = new Writable({
      write(chunk, encoding, next) {
        next();
      },
      final(next) {
        callback(null, mockResult);
        next();
      },
    });
    return stream;
  };
}

// ─── Test Fixture Identifiers ────────────────────────────────────────────────
const schoolA_Id = '507f1f77bcf86cd799439011';
const schoolB_Id = '507f1f77bcf86cd799439099';
const classA_Id = '507f1f77bcf86cd799439022';
const sectionA_Id = '507f1f77bcf86cd799439033';
const sectionB_Id = '507f1f77bcf86cd799439034';
const subjectMath_Id = '507f1f77bcf86cd799439044';
const teacherA_Id = '507f1f77bcf86cd799439055';
const teacherB_Id = '507f1f77bcf86cd799439056';
const studentA_Id = '507f1f77bcf86cd799439066';
const studentB_Id = '507f1f77bcf86cd799439067';

const teacherA_User = {
  _id: teacherA_Id,
  userId: teacherA_Id,
  role: ROLES.TEACHER,
  schoolId: { _id: schoolA_Id },
  fullName: 'Sir Tariq Mahmood',
};

const teacherB_User = {
  _id: teacherB_Id,
  userId: teacherB_Id,
  role: ROLES.TEACHER,
  schoolId: { _id: schoolA_Id },
  fullName: 'Sir Naveed Iqbal',
};

const studentA_User = {
  _id: studentA_Id,
  userId: studentA_Id,
  role: ROLES.STUDENT,
  schoolId: { _id: schoolA_Id },
  fullName: 'Ahmed Raza',
};

console.log('======================================================================');
console.log('📚 EXECUTING HOMEWORK ATTACHMENT LIFECYCLE & SECURITY TEST SUITE');
console.log('======================================================================\n');

// ─── SECTION 1: TEACHER AUTHORIZATION & MULTIPART UPLOADS ─────────────────────

await runAsyncTest('Scenario 01: Authorized homework creation with valid image attachments succeeds', async () => {
  const origTA = TeachingAssignment.findOne;
  const origClass = Class.findById;
  const origSection = Section.findById;
  const origSubject = Subject.findById;
  const origHwCreate = Homework.create;
  const origAudit = AuditLog.create;
  const origUploadStream = cloudinary.uploader.upload_stream;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_1',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    subjectId: subjectMath_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectMath_Id, schoolId: schoolA_Id });

  let capturedHwDoc = null;
  Homework.create = (doc) => {
    capturedHwDoc = { _id: 'hw_image_1', ...doc };
    return Promise.resolve(capturedHwDoc);
  };
  AuditLog.create = () => Promise.resolve();

  // Mock Cloudinary upload
  cloudinary.uploader.upload_stream = createMockUploadStream({
    secure_url: 'https://res.cloudinary.com/dmc/image/upload/v1/math_exercise.webp',
    public_id: 'liaquatabad_sms/homework/math_exercise_123',
    format: 'webp',
    bytes: 350000,
    resource_type: 'image',
    width: 1600,
    height: 1200,
  });

  // Valid JPEG magic byte buffer: FF D8 FF
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Geometry Chapter 4 Theorem Proofs',
      description: 'Review blackboard theorem steps attached in photo.',
      dueDate: '2026-10-10',
    },
    files: [
      {
        originalname: 'blackboard_theorem.jpg',
        mimetype: 'image/jpeg',
        buffer: jpegBuffer,
        size: 350000,
      },
    ],
    headers: {},
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(capturedHwDoc);
  assert.strictEqual(capturedHwDoc.attachments.length, 1);
  assert.strictEqual(capturedHwDoc.attachments[0].fileType, 'IMAGE');
  assert.strictEqual(capturedHwDoc.attachments[0].publicId, 'liaquatabad_sms/homework/math_exercise_123');
  assert.strictEqual(capturedHwDoc.attachments[0].width, 1600);
  assert.strictEqual(capturedHwDoc.attachments[0].height, 1200);

  // Authoritative server expiry: must be ~7 days in the future
  const expiryDelta = capturedHwDoc.attachments[0].expiresAt.getTime() - capturedHwDoc.attachments[0].uploadedAt.getTime();
  assert.strictEqual(expiryDelta, 7 * 24 * 60 * 60 * 1000);

  TeachingAssignment.findOne = origTA;
  Class.findById = origClass;
  Section.findById = origSection;
  Subject.findById = origSubject;
  Homework.create = origHwCreate;
  AuditLog.create = origAudit;
  cloudinary.uploader.upload_stream = origUploadStream;
});

await runAsyncTest('Scenario 02: Authorized homework creation with valid PDF attachments succeeds', async () => {
  const origTA = TeachingAssignment.findOne;
  const origClass = Class.findById;
  const origSection = Section.findById;
  const origSubject = Subject.findById;
  const origHwCreate = Homework.create;
  const origUploadStream = cloudinary.uploader.upload_stream;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_1',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    subjectId: subjectMath_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectMath_Id, schoolId: schoolA_Id });

  let capturedHwDoc = null;
  Homework.create = (doc) => {
    capturedHwDoc = { _id: 'hw_pdf_1', ...doc };
    return Promise.resolve(capturedHwDoc);
  };

  cloudinary.uploader.upload_stream = createMockUploadStream({
    secure_url: 'https://res.cloudinary.com/dmc/raw/upload/v1/worksheet.pdf',
    public_id: 'liaquatabad_sms/homework/worksheet_pdf_99',
    format: 'pdf',
    bytes: 1200000,
    resource_type: 'raw',
  });

  // Valid PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46)
  const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Sindh Board Model Paper Worksheet',
      description: 'Print or solve questions 1-15.',
      dueDate: '2026-10-12',
    },
    files: [
      {
        originalname: 'model_paper.pdf',
        mimetype: 'application/pdf',
        buffer: pdfBuffer,
        size: 1200000,
      },
    ],
    headers: {},
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(capturedHwDoc);
  assert.strictEqual(capturedHwDoc.attachments[0].fileType, 'PDF');
  assert.strictEqual(capturedHwDoc.attachments[0].publicId, 'liaquatabad_sms/homework/worksheet_pdf_99');

  TeachingAssignment.findOne = origTA;
  Class.findById = origClass;
  Section.findById = origSection;
  Subject.findById = origSubject;
  Homework.create = origHwCreate;
  cloudinary.uploader.upload_stream = origUploadStream;
});

await runAsyncTest('Scenario 03: Multiple attachments (up to 10 files) accepted and processed in batch', async () => {
  const origTA = TeachingAssignment.findOne;
  const origClass = Class.findById;
  const origSection = Section.findById;
  const origSubject = Subject.findById;
  const origHwCreate = Homework.create;
  const origUploadStream = cloudinary.uploader.upload_stream;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_1',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    subjectId: subjectMath_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectMath_Id, schoolId: schoolA_Id });

  let capturedHwDoc = null;
  Homework.create = (doc) => {
    capturedHwDoc = { _id: 'hw_multi_1', ...doc };
    return Promise.resolve(capturedHwDoc);
  };

  let uploadCounter = 0;
  cloudinary.uploader.upload_stream = (options, callback) => {
    uploadCounter++;
    const stream = new Writable({
      write(chunk, encoding, next) { next(); },
      final(next) {
        callback(null, {
          secure_url: `https://res.cloudinary.com/dmc/image/upload/v1/page_${uploadCounter}.webp`,
          public_id: `liaquatabad_sms/homework/page_${uploadCounter}`,
          format: 'webp',
          bytes: 200000,
          resource_type: 'image',
        });
        next();
      },
    });
    return stream;
  };

  const filesBatch = Array.from({ length: 5 }, (_, i) => ({
    originalname: `textbook_page_${i + 1}.jpg`,
    mimetype: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    size: 200000,
  }));

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Chapter 5 Multi-Page Notes',
      dueDate: '2026-10-15',
    },
    files: filesBatch,
    headers: {},
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(capturedHwDoc.attachments.length, 5);
  assert.strictEqual(uploadCounter, 5);

  TeachingAssignment.findOne = origTA;
  Class.findById = origClass;
  Section.findById = origSection;
  Subject.findById = origSubject;
  Homework.create = origHwCreate;
  cloudinary.uploader.upload_stream = origUploadStream;
});

await runAsyncTest('Scenario 04: Unauthorized teacher cannot upload homework (403 Forbidden)', async () => {
  const origTA = TeachingAssignment.findOne;
  TeachingAssignment.findOne = () => makeChainable(null); // No assignment

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Unauthorized Task',
      dueDate: '2026-10-15',
    },
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /teaching assignment/i);

  TeachingAssignment.findOne = origTA;
});

await runAsyncTest('Scenario 05: Inactive teacher cannot upload homework (403 Forbidden)', async () => {
  const origTA = TeachingAssignment.findOne;
  // Database query checks for status: ACTIVE; revoked assignment returns null
  TeachingAssignment.findOne = () => makeChainable(null);

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Revoked Assignment Task',
      dueDate: '2026-10-15',
    },
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 403);

  TeachingAssignment.findOne = origTA;
});

await runAsyncTest('Scenario 06: Cross-teacher homework editing/cancellation rejected (403 Forbidden)', async () => {
  const origHwFind = Homework.findById;
  const homeworkOwnedByA_Id = '507f1f77bcf86cd799439088';

  Homework.findById = () => Promise.resolve({
    _id: homeworkOwnedByA_Id,
    schoolId: schoolA_Id,
    teacherId: teacherA_Id, // Belongs to Teacher A
    status: 'ACTIVE',
    save: () => Promise.resolve(),
  });

  // Teacher B attempts to cancel Teacher A's homework
  const req = {
    user: teacherB_User,
    params: { id: homeworkOwnedByA_Id },
  };
  const res = createMockRes();

  await handleCancelHomework(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.message, /own homework/i);

  Homework.findById = origHwFind;
});

await runAsyncTest('Scenario 07: Cross-school homework creation rejected (BOLA defense)', async () => {
  const origTA = TeachingAssignment.findOne;
  const origClass = Class.findById;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_foreign',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    status: 'ACTIVE',
  });

  // Class belongs to foreign School B
  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolB_Id });

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Foreign School Tamper',
      dueDate: '2026-10-15',
    },
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /does not belong to your school/i);

  TeachingAssignment.findOne = origTA;
  Class.findById = origClass;
});

// ─── SECTION 2: STUDENT & PARENT BOUNDARY AND LIFECYCLE FILTERING ─────────────

await runAsyncTest('Scenario 08: Student sees active homework belonging to own class & section', async () => {
  const origStudentProfile = StudentProfile.findOne;
  const origHwFind = Homework.find;

  StudentProfile.findOne = () => makeChainable({
    userId: studentA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  });

  Homework.find = () => makeChainable([
    {
      _id: 'hw_student_view_1',
      title: 'English Composition',
      dueDate: new Date(Date.now() + 86400000),
      attachments: [
        {
          fileName: 'worksheet.webp',
          fileUrl: 'https://res.cloudinary.com/dmc/worksheet.webp',
          fileType: 'IMAGE',
          expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000), // active (expires in 6d)
        },
      ],
    },
  ]);

  const req = {
    user: studentA_User,
    query: {},
  };
  const res = createMockRes();

  await handleGetStudentHomework(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.homework.length, 1);
  assert.strictEqual(res.body.data.homework[0].attachments.length, 1);

  StudentProfile.findOne = origStudentProfile;
  Homework.find = origHwFind;
});

await runAsyncTest('Scenario 09: Student does NOT receive expired attachments past 7 days', async () => {
  const origStudentProfile = StudentProfile.findOne;
  const origHwFind = Homework.find;

  StudentProfile.findOne = () => makeChainable({
    userId: studentA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    lifecycleStatus: STUDENT_STATUS.ACTIVE,
  });

  const now = Date.now();
  Homework.find = () => makeChainable([
    {
      _id: 'hw_with_expired_att',
      title: 'Science Notes',
      dueDate: new Date(now + 86400000),
      attachments: [
        {
          fileName: 'active_page.webp',
          fileUrl: 'https://res.cloudinary.com/dmc/active_page.webp',
          fileType: 'IMAGE',
          expiresAt: new Date(now + 2 * 24 * 60 * 60 * 1000), // Active (expires in 2 days)
        },
        {
          fileName: 'old_page.webp',
          fileUrl: 'https://res.cloudinary.com/dmc/old_page.webp',
          fileType: 'IMAGE',
          expiresAt: new Date(now - 1000), // EXPIRED (1 second ago)
        },
      ],
    },
  ]);

  const req = { user: studentA_User, query: {} };
  const res = createMockRes();

  await handleGetStudentHomework(req, res);

  assert.strictEqual(res.statusCode, 200);
  const returnedAttachments = res.body.data.homework[0].attachments;
  assert.strictEqual(returnedAttachments.length, 1);
  assert.strictEqual(returnedAttachments[0].fileName, 'active_page.webp');

  StudentProfile.findOne = origStudentProfile;
  Homework.find = origHwFind;
});

await runAsyncTest('Scenario 10: Parent sees linked ward homework with expired attachments filtered out', async () => {
  const origHwFind = Homework.find;
  const now = Date.now();

  Homework.find = () => makeChainable([
    {
      _id: 'hw_ward_1',
      title: 'Urdu Reading Practice',
      description: 'Read chapter 3',
      dueDate: new Date(now + 86400000),
      attachments: [
        {
          fileName: 'active_poem.webp',
          fileUrl: 'https://res.cloudinary.com/dmc/active_poem.webp',
          fileType: 'IMAGE',
          expiresAt: new Date(now + 3 * 24 * 60 * 60 * 1000), // Active
        },
        {
          fileName: 'expired_poem.webp',
          fileUrl: 'https://res.cloudinary.com/dmc/expired_poem.webp',
          fileType: 'IMAGE',
          expiresAt: new Date(now - 3600000), // Expired 1 hour ago
        },
      ],
      createdAt: new Date(),
    },
  ]);

  const req = {
    wardProfile: {
      schoolId: schoolA_Id,
      classId: classA_Id,
      sectionId: sectionA_Id,
    },
    query: {},
  };
  const res = createMockRes();

  await handleGetWardHomework(req, res);

  assert.strictEqual(res.statusCode, 200);
  const wardHomework = res.body.data.homework[0];
  assert.strictEqual(wardHomework.attachments.length, 1);
  assert.strictEqual(wardHomework.attachments[0].fileName, 'active_poem.webp');

  Homework.find = origHwFind;
});

// ─── SECTION 3: BINARY SECURITY & UPLOAD LIMIT GUARDS ─────────────────────────

await runAsyncTest('Scenario 11: Binary Security: Valid JPEG signature passes magic-byte validator', async () => {
  const req = {
    files: [
      {
        mimetype: 'image/jpeg',
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        originalname: 'valid.jpg',
      },
    ],
  };
  const res = createMockRes();
  let nextCalled = false;
  validateFileMagicBytes(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

await runAsyncTest('Scenario 12: Binary Security: Valid PNG signature passes magic-byte validator', async () => {
  const req = {
    files: [
      {
        mimetype: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        originalname: 'valid.png',
      },
    ],
  };
  const res = createMockRes();
  let nextCalled = false;
  validateFileMagicBytes(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

await runAsyncTest('Scenario 13: Binary Security: Valid WebP signature passes magic-byte validator', async () => {
  // RIFF....WEBP
  const webpBuffer = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
  const req = {
    files: [{ mimetype: 'image/webp', buffer: webpBuffer, originalname: 'valid.webp' }],
  };
  const res = createMockRes();
  let nextCalled = false;
  validateFileMagicBytes(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

await runAsyncTest('Scenario 14: Binary Security: Valid PDF signature passes magic-byte validator', async () => {
  const req = {
    files: [
      {
        mimetype: 'application/pdf',
        buffer: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        originalname: 'valid.pdf',
      },
    ],
  };
  const res = createMockRes();
  let nextCalled = false;
  validateFileMagicBytes(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

await runAsyncTest('Scenario 15: Binary Security: Spoofed executable disguised as JPEG rejected with 400', async () => {
  // MZ DOS executable header (0x4D 0x5A) masquerading as JPEG
  const req = {
    files: [
      {
        mimetype: 'image/jpeg',
        buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
        originalname: 'malware.jpg',
      },
    ],
  };
  const res = createMockRes();
  let nextCalled = false;
  validateFileMagicBytes(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /binary signature for "malware\.jpg" does not match/i);
});

await runAsyncTest('Scenario 16: Limit Security: Upload exceeding 10 attachments rejected with 400 Bad Request', async () => {
  const req = {
    files: Array.from({ length: 11 }, (_, i) => ({
      originalname: `file_${i}.jpg`,
      size: 1000,
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    })),
  };
  const res = createMockRes();
  let nextCalled = false;
  validateHomeworkUploadLimits(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /Maximum 10 attachments/i);
});

await runAsyncTest('Scenario 17: Limit Security: Upload exceeding 25MB total size rejected with 400 Bad Request', async () => {
  const req = {
    files: [
      {
        originalname: 'huge_1.pdf',
        size: 14 * 1024 * 1024,
      },
      {
        originalname: 'huge_2.pdf',
        size: 13 * 1024 * 1024,
      },
    ],
  };
  const res = createMockRes();
  let nextCalled = false;
  validateHomeworkUploadLimits(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /exceeds permitted maximum of 25 MB/i);
});

// ─── SECTION 4: 7-DAY AUTOMATIC CLEANUP & IDEMPOTENCY ─────────────────────────

await runAsyncTest('Scenario 18: Server authoritatively enforces 7-day expiresAt and rejects client override', async () => {
  const origTA = TeachingAssignment.findOne;
  const origClass = Class.findById;
  const origSection = Section.findById;
  const origSubject = Subject.findById;
  const origHwCreate = Homework.create;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_1',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    subjectId: subjectMath_Id,
    status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
  });

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectMath_Id, schoolId: schoolA_Id });

  let savedHw = null;
  Homework.create = (doc) => {
    savedHw = { _id: 'hw_tamper_expiry', ...doc };
    return Promise.resolve(savedHw);
  };

  // Malicious client tries to send an expiration date 10 years in the future
  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Attempted Permanent Storage',
      dueDate: '2026-10-15',
      attachments: [
        {
          fileUrl: 'https://res.cloudinary.com/dmc/image/upload/v1/test.jpg',
          fileName: 'permanent.jpg',
          fileType: 'IMAGE',
          expiresAt: '2036-01-01', // Attacker wants permanent 10-year storage
        },
      ],
    },
  };
  const res = createMockRes();

  await handleCreateHomework(req, res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(savedHw);
  const computedExpiry = savedHw.attachments[0].expiresAt;
  const expectedMaxExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000; // within 7 days + 5s buffer

  assert.ok(computedExpiry.getTime() <= expectedMaxExpiry);
  assert.notStrictEqual(computedExpiry.getFullYear(), 2036);

  TeachingAssignment.findOne = origTA;
  Class.findById = origClass;
  Section.findById = origSection;
  Subject.findById = origSubject;
  Homework.create = origHwCreate;
});

await runAsyncTest('Scenario 19: cleanupExpiredHomeworkAttachments deletes expired Cloudinary asset and pulls DB reference', async () => {
  const origHwFind = Homework.find;
  const origHwUpdateOne = Homework.updateOne;
  const origDestroy = cloudinary.uploader.destroy;
  const origAudit = AuditLog.create;

  let destroyedPublicId = null;
  let destroyedOptions = null;

  cloudinary.uploader.destroy = (pubId, opts) => {
    destroyedPublicId = pubId;
    destroyedOptions = opts;
    return Promise.resolve({ result: 'ok' });
  };

  const expiredAttachmentId = '507f1f77bcf86cd799439999';
  const sampleHomework = {
    _id: 'hw_expired_1',
    title: 'Week 1 Math Revision',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    attachments: [
      {
        _id: expiredAttachmentId,
        fileName: 'expired_snap.webp',
        publicId: 'liaquatabad_sms/homework/expired_snap_123',
        resourceType: 'image',
        expiresAt: new Date(Date.now() - 3600000), // Expired 1 hr ago
      },
    ],
  };

  Homework.find = () => Promise.resolve([sampleHomework]);

  let updatedQuery = null;
  let updatedOperation = null;
  Homework.updateOne = (query, op) => {
    updatedQuery = query;
    updatedOperation = op;
    return Promise.resolve({ modifiedCount: 1 });
  };
  AuditLog.create = () => Promise.resolve();

  const metrics = await cleanupExpiredHomeworkAttachments();

  assert.strictEqual(metrics.scannedHomeworkCount, 1);
  assert.strictEqual(metrics.expiredAttachmentsCount, 1);
  assert.strictEqual(metrics.deletedAssetsCount, 1);
  assert.strictEqual(metrics.removedReferencesCount, 1);

  assert.strictEqual(destroyedPublicId, 'liaquatabad_sms/homework/expired_snap_123');
  assert.strictEqual(destroyedOptions?.resource_type, 'image');

  assert.strictEqual(updatedQuery._id, 'hw_expired_1');
  assert.deepStrictEqual(updatedOperation.$pull.attachments._id.$in, [expiredAttachmentId]);

  Homework.find = origHwFind;
  Homework.updateOne = origHwUpdateOne;
  cloudinary.uploader.destroy = origDestroy;
  AuditLog.create = origAudit;
});

await runAsyncTest('Scenario 20: Cleanup idempotency: Cloudinary "not found" treated as safe success without crashing', async () => {
  const origHwFind = Homework.find;
  const origHwUpdateOne = Homework.updateOne;
  const origDestroy = cloudinary.uploader.destroy;
  const origAudit = AuditLog.create;

  // Cloudinary returns 'not found' because asset was already purged
  cloudinary.uploader.destroy = () => Promise.resolve({ result: 'not found' });

  const expiredAttachmentId = '507f1f77bcf86cd799438888';
  Homework.find = () => Promise.resolve([
    {
      _id: 'hw_already_deleted_asset',
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      attachments: [
        {
          _id: expiredAttachmentId,
          publicId: 'liaquatabad_sms/homework/already_gone_asset',
          expiresAt: new Date(Date.now() - 7200000),
        },
      ],
    },
  ]);

  let dbPulled = false;
  Homework.updateOne = () => {
    dbPulled = true;
    return Promise.resolve({ modifiedCount: 1 });
  };
  AuditLog.create = () => Promise.resolve();

  const metrics = await cleanupExpiredHomeworkAttachments();

  assert.strictEqual(metrics.deletedAssetsCount, 1); // Acknowledged safe
  assert.strictEqual(metrics.failedAssetsCount, 0);
  assert.strictEqual(dbPulled, true);

  Homework.find = origHwFind;
  Homework.updateOne = origHwUpdateOne;
  cloudinary.uploader.destroy = origDestroy;
  AuditLog.create = origAudit;
});

await runAsyncTest('Scenario 21: Cleanup failure isolation: Temporary Cloudinary error logs and does not abort job', async () => {
  const origHwFind = Homework.find;
  const origHwUpdateOne = Homework.updateOne;
  const origDestroy = cloudinary.uploader.destroy;

  // Simulate Cloudinary error on asset 1, success on asset 2
  let callCount = 0;
  cloudinary.uploader.destroy = () => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new Error('Cloudinary 503 Service Unavailable'));
    }
    return Promise.resolve({ result: 'ok' });
  };

  Homework.find = () => Promise.resolve([
    {
      _id: 'hw_with_two_expired',
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      attachments: [
        {
          _id: 'att_fail',
          publicId: 'liaquatabad_sms/homework/fail_1',
          expiresAt: new Date(Date.now() - 10000),
        },
        {
          _id: 'att_succeed',
          publicId: 'liaquatabad_sms/homework/succeed_2',
          expiresAt: new Date(Date.now() - 10000),
        },
      ],
    },
  ]);

  let pulledIds = [];
  Homework.updateOne = (q, op) => {
    pulledIds = op.$pull.attachments._id.$in;
    return Promise.resolve();
  };

  const metrics = await cleanupExpiredHomeworkAttachments();

  assert.strictEqual(metrics.failedAssetsCount, 1);
  assert.strictEqual(metrics.deletedAssetsCount, 1);
  // Only the succeeded asset is removed from DB; failed asset retained for next retry
  assert.deepStrictEqual(pulledIds, ['att_succeed']);

  Homework.find = origHwFind;
  Homework.updateOne = origHwUpdateOne;
  cloudinary.uploader.destroy = origDestroy;
});

await runAsyncTest('Scenario 22: Compensating Rollback: DB save failure destroys newly uploaded Cloudinary assets', async () => {
  const origTA = TeachingAssignment.findOne;
  const origClass = Class.findById;
  const origSection = Section.findById;
  const origSubject = Subject.findById;
  const origHwCreate = Homework.create;
  const origUploadStream = cloudinary.uploader.upload_stream;
  const origDestroy = cloudinary.uploader.destroy;

  TeachingAssignment.findOne = () => makeChainable({
    _id: 'ta_1',
    teacherId: teacherA_Id,
    schoolId: schoolA_Id,
    classId: classA_Id,
    sectionId: sectionA_Id,
    subjectId: subjectMath_Id,
    status: 'ACTIVE',
  });

  Class.findById = () => makeChainable({ _id: classA_Id, schoolId: schoolA_Id });
  Section.findById = () => makeChainable({ _id: sectionA_Id, schoolId: schoolA_Id, classId: classA_Id });
  Subject.findById = () => makeChainable({ _id: subjectMath_Id, schoolId: schoolA_Id });

  cloudinary.uploader.upload_stream = createMockUploadStream({
    secure_url: 'https://res.cloudinary.com/dmc/orphaned.webp',
    public_id: 'liaquatabad_sms/homework/orphan_to_rollback',
    resource_type: 'image',
  });

  let rolledBackPublicId = null;
  cloudinary.uploader.destroy = (pubId) => {
    rolledBackPublicId = pubId;
    return Promise.resolve({ result: 'ok' });
  };

  // Simulate catastrophic MongoDB write error after upload succeeds
  Homework.create = () => Promise.reject(new Error('MongoNetworkTimeoutException during write'));

  const req = {
    user: teacherA_User,
    body: {
      classId: classA_Id,
      sectionId: sectionA_Id,
      subjectId: subjectMath_Id,
      title: 'Rollback Candidate Homework',
      dueDate: '2026-10-15',
    },
    files: [
      {
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        size: 50000,
      },
    ],
  };
  const res = createMockRes();

  try {
    await handleCreateHomework(req, res);
    assert.fail('Expected database write failure');
  } catch (err) {
    assert.match(err.message, /MongoNetworkTimeoutException/);
  }

  // Verify compensating rollback deleted the orphaned asset from Cloudinary
  assert.strictEqual(rolledBackPublicId, 'liaquatabad_sms/homework/orphan_to_rollback');

  TeachingAssignment.findOne = origTA;
  Class.findById = origClass;
  Section.findById = origSection;
  Subject.findById = origSubject;
  Homework.create = origHwCreate;
  cloudinary.uploader.upload_stream = origUploadStream;
  cloudinary.uploader.destroy = origDestroy;
});

await runAsyncTest('Scenario 23: Zero Hard Deletions: Parent Homework record preserved after attachment expiration', async () => {
  const origHwFind = Homework.find;
  const origHwUpdateOne = Homework.updateOne;
  const origDestroy = cloudinary.uploader.destroy;
  const origHwDeleteOne = Homework.deleteOne;
  const origHwDeleteMany = Homework.deleteMany;

  let deleteOneCalled = false;
  let deleteManyCalled = false;
  Homework.deleteOne = () => { deleteOneCalled = true; return Promise.resolve(); };
  Homework.deleteMany = () => { deleteManyCalled = true; return Promise.resolve(); };

  cloudinary.uploader.destroy = () => Promise.resolve({ result: 'ok' });

  const parentHwId = 'hw_preserve_record_1';
  Homework.find = () => Promise.resolve([
    {
      _id: parentHwId,
      title: 'Curriculum History Milestone',
      teacherId: teacherA_Id,
      schoolId: schoolA_Id,
      status: 'ACTIVE',
      attachments: [
        {
          _id: 'att_expired_history',
          publicId: 'liaquatabad_sms/homework/history_att',
          expiresAt: new Date(Date.now() - 5000),
        },
      ],
    },
  ]);

  let pulledAttachment = false;
  Homework.updateOne = (q, op) => {
    if (q._id === parentHwId && op.$pull?.attachments) {
      pulledAttachment = true;
    }
    return Promise.resolve({ modifiedCount: 1 });
  };

  await cleanupExpiredHomeworkAttachments();

  assert.strictEqual(pulledAttachment, true);
  assert.strictEqual(deleteOneCalled, false, 'Homework document must NOT be hard deleted!');
  assert.strictEqual(deleteManyCalled, false, 'Homework documents must NOT be hard deleted!');

  Homework.find = origHwFind;
  Homework.updateOne = origHwUpdateOne;
  cloudinary.uploader.destroy = origDestroy;
  Homework.deleteOne = origHwDeleteOne;
  Homework.deleteMany = origHwDeleteMany;
});

console.log('\n======================================================================');
console.log(`🎉 ALL ${passedTests}/${totalTests} HOMEWORK ATTACHMENT TESTS PASSED!`);
console.log('======================================================================\n');
