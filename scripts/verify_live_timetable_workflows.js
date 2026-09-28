import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = 'http://localhost:5000/api/v1';

let passed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (!condition) {
    console.error(`❌ FAIL [${total}]: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passed++;
  console.log(`✅ PASS [${total}]: ${message}`);
}

async function loginUser(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${data.message}`);
  }
  return {
    token: data.data.accessToken,
    user: data.data.user,
  };
}

console.log('\n======================================================================');
console.log('🏛️  END-TO-END LIVE WORKFLOW & NETWORK VERIFICATION');
console.log('   Testing live API & database state on port 5000');
console.log('======================================================================\n');

// 1. HM Login
console.log('--- 1. HM Authentication & Session Setup ---');
const hm = await loginUser('test.teacher06@example.test', 'DevPassword2026!');
assert(hm.user.role === 'HM', 'HM role verified from authentication response');
assert(Boolean(hm.user.schoolId), 'HM schoolId present in authentication token');
const hmSchoolId = hm.user.schoolId;

// 2. Fetch Initial School Timetable & Live Period Status
console.log('\n--- 2. Load School Timetable & Live Period HUD ---');
const getTimetableRes = await fetch(`${BASE_URL}/timetables/school/${hmSchoolId}`, {
  headers: { Authorization: `Bearer ${hm.token}` },
});
assert(getTimetableRes.status === 200 || getTimetableRes.status === 404, 'Initial timetable fetch returns 200 or 404');
const getTimetableData = await getTimetableRes.json();
if (getTimetableRes.status === 200) {
  assert(Boolean(getTimetableData.data.liveStatus), 'liveStatus attached to school timetable');
  console.log(`  ℹ️ Live Period Status: ${getTimetableData.data.liveStatus.status} (${getTimetableData.data.liveStatus.message})`);
}

// 3. Inspect School Academic Context (Classes, Sections, Subjects, Teaching Assignments)
console.log('\n--- 3. Verify School Academic Context & Teaching Assignments ---');
const ClassModel = (await import('../src/models/Class.js')).default;
const SectionModel = (await import('../src/models/Section.js')).default;
const SubjectModel = (await import('../src/models/Subject.js')).default;
const TeachingAssignment = (await import('../src/models/TeachingAssignment.js')).default;
const { connectDatabase } = await import('../config/database.js');
await connectDatabase();

let schoolClass = await ClassModel.findOne({ schoolId: hmSchoolId, status: 'ACTIVE' });
let schoolSection = await SectionModel.findOne({ schoolId: hmSchoolId, status: 'ACTIVE' });
let schoolSubject = await SubjectModel.findOne({ schoolId: hmSchoolId, status: 'ACTIVE' });

// If not present in live DB, find any active or seed
if (!schoolClass || !schoolSection || !schoolSubject) {
  console.log('  ⚠️ Creating baseline academic records for live testing in school jurisdiction...');
  if (!schoolClass) {
    schoolClass = await ClassModel.create({
      schoolId: hmSchoolId,
      name: 'Class 5',
      numericGrade: 5,
      capacity: 40,
      status: 'ACTIVE',
    });
  }
  if (!schoolSection) {
    schoolSection = await SectionModel.create({
      schoolId: hmSchoolId,
      class: schoolClass._id,
      name: 'A',
      capacity: 40,
      status: 'ACTIVE',
    });
  }
  if (!schoolSubject) {
    schoolSubject = await SubjectModel.create({
      schoolId: hmSchoolId,
      name: 'General Science',
      code: 'SCI-5',
      status: 'ACTIVE',
    });
  }
}

assert(Boolean(schoolClass), 'School class available');
assert(Boolean(schoolSection), 'School section available');
assert(Boolean(schoolSubject), 'School subject available');

// Get teacher in this school
const User = (await import('../src/models/User.js')).default;
let teacherUser = await User.findOne({ schoolId: hmSchoolId, role: 'TEACHER', status: 'ACTIVE' });
assert(Boolean(teacherUser), 'Teacher user exists in HM school jurisdiction');

// Check or create active TeachingAssignment
let assignment = await TeachingAssignment.findOne({
  teacherId: teacherUser._id,
  schoolId: hmSchoolId,
  classId: schoolClass._id,
  sectionId: schoolSection._id,
  subjectId: schoolSubject._id,
  status: 'ACTIVE',
});

if (!assignment) {
  assignment = await TeachingAssignment.create({
    teacherId: teacherUser._id,
    schoolId: hmSchoolId,
    classId: schoolClass._id,
    sectionId: schoolSection._id,
    subjectId: schoolSubject._id,
    academicSession: '2025-2026',
    status: 'ACTIVE',
    assignedBy: hm.user._id || hm.user.id,
  });
  console.log('  ℹ️ Provisioned active TeachingAssignment for live testing');
}
assert(Boolean(assignment), 'Active TeachingAssignment confirmed');

// 4. Save Timetable via HM Management Endpoint
console.log('\n--- 4. Configure Period Slots, Assign Teacher/Subject & Save ---');
const periodSlotsConfig = [
  { periodNumber: 0, label: 'Morning Assembly', startTime: '08:00', endTime: '08:20', slotType: 'ASSEMBLY' },
  { periodNumber: 1, label: 'Period 1', startTime: '08:20', endTime: '09:05', slotType: 'TEACHING' },
  { periodNumber: 2, label: 'Period 2', startTime: '09:05', endTime: '09:50', slotType: 'TEACHING' },
  { periodNumber: 3, label: 'Recess Interval', startTime: '09:50', endTime: '10:20', slotType: 'RECESS' },
  { periodNumber: 4, label: 'Period 3', startTime: '10:20', endTime: '11:05', slotType: 'TEACHING' },
  { periodNumber: 5, label: 'Period 4', startTime: '11:05', endTime: '11:50', slotType: 'TEACHING' },
];

const scheduleEntries = [
  {
    dayOfWeek: 'MONDAY',
    periodNumber: 1,
    classId: schoolClass._id.toString(),
    sectionId: schoolSection._id.toString(),
    subjectId: schoolSubject._id.toString(),
    teacherId: teacherUser._id.toString(),
    roomNumber: 'Room 101',
  },
  {
    dayOfWeek: 'TUESDAY',
    periodNumber: 2,
    classId: schoolClass._id.toString(),
    sectionId: schoolSection._id.toString(),
    subjectId: schoolSubject._id.toString(),
    teacherId: teacherUser._id.toString(),
    roomNumber: 'Room 101',
  },
];

const savePayload = {
  schoolId: hmSchoolId.toString(),
  academicYear: '2025-2026',
  periodSlots: periodSlotsConfig,
  schedule: scheduleEntries,
};

// Check if existing timetable has a version
if (getTimetableRes.status === 200 && getTimetableData.data?.version !== undefined) {
  savePayload.version = getTimetableData.data.version;
}

const saveRes = await fetch(`${BASE_URL}/timetables/manage`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${hm.token}`,
  },
  body: JSON.stringify(savePayload),
});

const saveData = await saveRes.json();
if (saveRes.status !== 200 && saveRes.status !== 201) {
  console.error('Save failed details:', JSON.stringify(saveData, null, 2));
}
assert(saveRes.status === 200 || saveRes.status === 201, `Timetable saved successfully (HTTP ${saveRes.status})`);
assert(saveData.data.schedule.length === 2, 'Two schedule allocations saved');
assert(saveData.data.periodSlots.length === 6, 'Six period slots configured');
const savedVersion = saveData.data.version;
console.log(`  ℹ️ Timetable Version in DB: ${savedVersion}`);

// 5. Verify Persistence on Reload
console.log('\n--- 5. Confirm Persistence on Subsequent GET ---');
const reloadRes = await fetch(`${BASE_URL}/timetables/school/${hmSchoolId}`, {
  headers: { Authorization: `Bearer ${hm.token}` },
});
const reloadData = await reloadRes.json();
assert(reloadRes.status === 200, 'Reload fetch returns HTTP 200');
assert(reloadData.data.schedule.length === 2, 'Allocations persisted after reload');
assert(reloadData.data.schedule[0].roomNumber === 'Room 101', 'Room number persisted');
assert(Boolean(reloadData.data.liveStatus), 'Live period calculation evaluated on persistence reload');

// 6. Test Optimistic Concurrency Control (Version Conflict -> 409)
console.log('\n--- 6. Test Optimistic Concurrency Conflict (409) ---');
// DB version is at savedVersion (e.g. 1 or 2). A stale client sending savedVersion + 999 or savedVersion - 1
const staleVersion = savedVersion > 1 ? savedVersion - 1 : savedVersion + 5;
const staleSavePayload = {
  ...savePayload,
  version: staleVersion,
};
const conflictRes = await fetch(`${BASE_URL}/timetables/manage`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${hm.token}`,
  },
  body: JSON.stringify(staleSavePayload),
});
const conflictData = await conflictRes.json();
assert(conflictRes.status === 409, `Stale version rejected with HTTP 409 Conflict (got ${conflictRes.status})`);
console.log(`  ℹ️ Server 409 Message: "${conflictData.message}"`);

// 7. Test Mandatory TeachingAssignment Conflict Rejection (422/400)
console.log('\n--- 7. Test Invalid / Unassigned Teacher Conflict Rejection ---');
// Pick an unassigned teacher or unassigned subject
const otherSubject = await SubjectModel.findOne({
  schoolId: hmSchoolId,
  _id: { $ne: schoolSubject._id },
  status: 'ACTIVE',
}) || await SubjectModel.create({
  schoolId: hmSchoolId,
  name: 'Unassigned Art',
  code: 'ART-5',
  status: 'ACTIVE',
});

const invalidAssignmentPayload = {
  ...savePayload,
  version: savedVersion,
  schedule: [
    ...scheduleEntries,
    {
      dayOfWeek: 'WEDNESDAY',
      periodNumber: 1,
      classId: schoolClass._id.toString(),
      sectionId: schoolSection._id.toString(),
      subjectId: otherSubject._id.toString(), // Teacher has NO assignment for Art!
      teacherId: teacherUser._id.toString(),
      roomNumber: 'Art Lab',
    },
  ],
};

const invalidRes = await fetch(`${BASE_URL}/timetables/manage`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${hm.token}`,
  },
  body: JSON.stringify(invalidAssignmentPayload),
});
const invalidData = await invalidRes.json();
assert(invalidRes.status === 422 || invalidRes.status === 400, `Unassigned teacher rejected with HTTP ${invalidRes.status}`);
console.log(`  ℹ️ Conflict Engine Enforcement: "${invalidData.message}"`);

// 8. Test BOLA Cross-School Protection (403 Forbidden)
console.log('\n--- 8. Test Cross-School BOLA Protection (403) ---');
const otherSchool = await (await import('../src/models/School.js')).default.findOne({ _id: { $ne: hmSchoolId } });
if (otherSchool) {
  const bolaPayload = {
    ...savePayload,
    schoolId: otherSchool._id.toString(), // Foreign school!
    version: 1,
  };
  const bolaRes = await fetch(`${BASE_URL}/timetables/manage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hm.token}`,
    },
    body: JSON.stringify(bolaPayload),
  });
  assert(bolaRes.status === 403, `Cross-school mutation blocked with HTTP 403 Forbidden (got ${bolaRes.status})`);
  console.log('  ℹ️ Anti-BOLA Tripwire successfully blocked foreign school mutation');
} else {
  console.log('  ℹ️ Skipped foreign school BOLA check (only 1 school in DB)');
}

// 9. Supervisor / Town Admin Live Class Monitor
console.log('\n--- 9. High Official Live Class Monitor (GET /town-live-monitor) ---');
const superAdmin = await loginUser('test.staff01@example.test', 'DevPassword2026!');
const liveMonitorRes = await fetch(`${BASE_URL}/timetables/town-live-monitor`, {
  headers: { Authorization: `Bearer ${superAdmin.token}` },
});
assert(liveMonitorRes.status === 200, 'Town live monitor returns HTTP 200 for town officials');
const liveMonitorData = await liveMonitorRes.json();
assert(Array.isArray(liveMonitorData.data), 'Returns array of monitored schools');
console.log(`  ℹ️ Monitored Schools Count: ${liveMonitorData.data.length}`);
const monitoredSchool = liveMonitorData.data.find((s) => s.schoolId === hmSchoolId.toString());
if (monitoredSchool) {
  assert(monitoredSchool.hasTimetable === true, 'HM school correctly reports hasTimetable = true');
  assert(Boolean(monitoredSchool.liveStatus), 'HM school has computed liveStatus');
  console.log(`  ℹ️ School Live Status: ${monitoredSchool.liveStatus.status}`);
}

// 10. Teacher Personalized Schedule
console.log('\n--- 10. Teacher Personalized Schedule (GET /my-schedule) ---');
const teacherAuth = await loginUser('test.teacher02@example.test', 'DevPassword2026!');
const teacherScheduleRes = await fetch(`${BASE_URL}/timetables/my-schedule`, {
  headers: { Authorization: `Bearer ${teacherAuth.token}` },
});
assert(teacherScheduleRes.status === 200, 'Teacher schedule returns HTTP 200');
const teacherScheduleData = await teacherScheduleRes.json();
assert(Array.isArray(teacherScheduleData.data.mySchedule), 'mySchedule is an array');
assert(Boolean(teacherScheduleData.data.periodSlots), 'periodSlots included for rendering timeline');
// Ensure no other teacher's lessons leaked into this response
const foreignLessons = teacherScheduleData.data.mySchedule.filter(
  (entry) => entry.teacherId && entry.teacherId.toString() !== teacherAuth.user._id.toString()
);
assert(foreignLessons.length === 0, 'Zero cross-teacher schedule leakage (data isolation verified)');
console.log(`  ℹ️ Teacher Scheduled Lessons Count: ${teacherScheduleData.data.mySchedule.length}`);

// 11. Student Class Timetable
console.log('\n--- 11. Student Class Timetable (GET /my-schedule) ---');
const studentAuth = await loginUser('test.student01@example.test', 'DevPassword2026!');
const studentScheduleRes = await fetch(`${BASE_URL}/timetables/my-schedule`, {
  headers: { Authorization: `Bearer ${studentAuth.token}` },
});
assert(studentScheduleRes.status === 200, 'Student schedule returns HTTP 200');
const studentScheduleData = await studentScheduleRes.json();
assert(Array.isArray(studentScheduleData.data.mySchedule), 'student mySchedule is an array');
console.log(`  ℹ️ Student Class Schedule Lessons Count: ${studentScheduleData.data.mySchedule.length}`);

// 12. Empty State / Unauthenticated Checks
console.log('\n--- 12. Empty States & Security Boundary Validations ---');
const unauthRes = await fetch(`${BASE_URL}/timetables/my-schedule`);
assert(unauthRes.status === 401, 'Unauthenticated request returns HTTP 401');

const hmInvalidIdRes = await fetch(`${BASE_URL}/timetables/school/invalid-object-id`, {
  headers: { Authorization: `Bearer ${hm.token}` },
});
assert(hmInvalidIdRes.status === 403, 'HM with mismatched/invalid schoolId blocked with HTTP 403 Forbidden');

const adminInvalidIdRes = await fetch(`${BASE_URL}/timetables/school/invalid-object-id`, {
  headers: { Authorization: `Bearer ${superAdmin.token}` },
});
assert(adminInvalidIdRes.status === 400, 'Admin with malformed schoolId returns HTTP 400 Bad Request');

console.log('\n======================================================================');
console.log(`🎉 ALL ${passed}/${total} LIVE END-TO-END WORKFLOW ASSERTIONS PASSED!`);
console.log('======================================================================\n');

process.exit(0);
