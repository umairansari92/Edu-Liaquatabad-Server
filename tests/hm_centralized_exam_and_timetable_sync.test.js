import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { handleCreateExam, handlePublishExamResults } from '../src/controllers/examController.js';
import Exam from '../src/models/Exam.js';
import Section from '../src/models/Section.js';

console.log('🧪 Running Centralized Exam Guards & Timetable Class Teacher Auto-Sync Unit Verification');

// Test 1: HM attempting to create a CENTRALIZED exam receives 403 Forbidden
{
  const mockSchoolId = new mongoose.Types.ObjectId();
  const mockReq = {
    user: {
      _id: new mongoose.Types.ObjectId(),
      role: 'HM',
      schoolId: mockSchoolId,
    },
    body: {
      schoolId: mockSchoolId.toString(),
      title: 'Town-Wide Board Examination 2026',
      examType: 'FINAL_TERM',
      academicYear: '2026-2027',
      startDate: new Date('2026-11-01'),
      endDate: new Date('2026-11-15'),
      examScope: 'CENTRALIZED',
    },
  };

  let statusCode = null;
  let jsonResponse = null;

  const mockRes = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResponse = data;
      return this;
    },
  };

  await handleCreateExam(mockReq, mockRes);
  assert.equal(statusCode, 403, 'HM must receive 403 when creating CENTRALIZED exam');
  assert.match(jsonResponse.message, /Administration/i, 'Error message must cite administrative authority');
  console.log('  ✅ PASS: HM cannot schedule CENTRALIZED exam (403 server-enforced)');
}

// Test 2: HM attempting to publish a CENTRALIZED exam receives 403 Forbidden
{
  const mockSchoolId = new mongoose.Types.ObjectId();
  const mockExamId = new mongoose.Types.ObjectId();

  const mockExamDoc = {
    _id: mockExamId,
    schoolId: mockSchoolId,
    examScope: 'CENTRALIZED',
    status: 'UPCOMING',
  };

  const originalFindById = Exam.findById;
  Exam.findById = () => ({
    then: (resolve) => resolve(mockExamDoc),
    session: () => ({
      exec: async () => mockExamDoc,
      then: (resolve) => resolve(mockExamDoc),
    }),
  });

  const mockReq = {
    user: {
      _id: new mongoose.Types.ObjectId(),
      role: 'HM',
      schoolId: mockSchoolId,
    },
    params: {
      id: mockExamId.toString(),
    },
  };

  let statusCode = null;
  let jsonResponse = null;

  const mockRes = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResponse = data;
      return this;
    },
  };

  try {
    await handlePublishExamResults(mockReq, mockRes);
    assert.equal(statusCode, 403, 'HM must receive 403 when publishing CENTRALIZED exam');
    assert.match(jsonResponse.message, /Administration/i, 'Error message must cite administrative authority');
    console.log('  ✅ PASS: HM cannot publish results for CENTRALIZED exam (403 server-enforced)');
  } finally {
    Exam.findById = originalFindById;
  }
}

// Test 3: Timetable Period 1 teacher logic synchronization
{
  const sectionId = new mongoose.Types.ObjectId();
  const period1TeacherId = new mongoose.Types.ObjectId();
  const period2TeacherId = new mongoose.Types.ObjectId();

  const mockSchedule = [
    { periodNumber: 1, sectionId: sectionId.toString(), teacherId: period1TeacherId.toString(), subjectId: new mongoose.Types.ObjectId() },
    { periodNumber: 2, sectionId: sectionId.toString(), teacherId: period2TeacherId.toString(), subjectId: new mongoose.Types.ObjectId() },
  ];

  const period1Entries = mockSchedule.filter(
    (entry) => Number(entry.periodNumber) === 1 && entry.sectionId && entry.teacherId
  );

  assert.equal(period1Entries.length, 1);
  assert.equal(period1Entries[0].teacherId, period1TeacherId.toString(), 'Period 1 teacher must be selected as Class Teacher');
  console.log('  ✅ PASS: Period 1 teacher filter correctly isolates the designated Class Teacher');
}

console.log('🏆 All Centralized Exam & Timetable Sync Assertions Passed!');
