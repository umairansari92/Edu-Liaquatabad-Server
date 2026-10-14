import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  STAFF_ATTENDANCE_STATUS,
  LEAVE_STATUS,
  LEAVE_TYPE,
  LEAVE_SOURCE,
  STAFF_CATEGORY,
  ROLES
} from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await mongoose.connect(process.env.MONGODB_URI);
const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));
const SAR = mongoose.model('StaffAttendanceRecord', new mongoose.Schema({}, { strict: false }));
const LR = mongoose.model('LeaveRequest', new mongoose.Schema({}, { strict: false }));

const hm = await User.findOne({ email: 'staff01.liaquatabad@dmc.gov.pk' });
const teacher1 = await User.findOne({ email: 'staff16.liaquatabad@dmc.gov.pk' });
const teacher2 = await User.findOne({ email: 'staff17.liaquatabad@dmc.gov.pk' });
const teacher3 = await User.findOne({ email: 'staff46.liaquatabad@dmc.gov.pk' });

const now = new Date();
const todayDateUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));

console.log('HM School:', hm.schoolId);

// 1. Staff Attendance Record: Submitted 2 mins ago (Within 5-min window)
const recentSubmission = await SAR.findOneAndUpdate(
  { staffUserId: teacher1._id, attendanceDate: todayDateUtc },
  {
    $set: {
      schoolId: hm.schoolId,
      townId: hm.townId,
      staffUserId: teacher1._id,
      staffRole: ROLES.TEACHER,
      staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
      attendanceDate: todayDateUtc,
      approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
      submittedAt: new Date(Date.now() - 2 * 60 * 1000),
      isHmSelfRecord: false
    }
  },
  { upsert: true, new: true }
);

// 2. Staff Attendance Record: Submitted 15 mins ago (Late approval, requires reason)
const lateSubmission = await SAR.findOneAndUpdate(
  { staffUserId: teacher2._id, attendanceDate: todayDateUtc },
  {
    $set: {
      schoolId: hm.schoolId,
      townId: hm.townId,
      staffUserId: teacher2._id,
      staffRole: ROLES.TEACHER,
      staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
      attendanceDate: todayDateUtc,
      approvalStatus: STAFF_ATTENDANCE_STATUS.PENDING_APPROVAL,
      submittedAt: new Date(Date.now() - 15 * 60 * 1000),
      isHmSelfRecord: false
    }
  },
  { upsert: true, new: true }
);

// 3. Pending Casual Leave Request (for teacher 1)
const futureStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
const futureEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const pendingLeave = await LR.findOneAndUpdate(
  { staffUserId: teacher1._id, leaveType: LEAVE_TYPE.CASUAL_LEAVE, status: LEAVE_STATUS.PENDING },
  {
    $set: {
      organizationId: hm.organizationId,
      townId: hm.townId,
      schoolId: hm.schoolId,
      staffUserId: teacher1._id,
      staffRole: ROLES.TEACHER,
      staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
      leaveType: LEAVE_TYPE.CASUAL_LEAVE,
      startDate: futureStart,
      endDate: futureEnd,
      durationDays: 2,
      reason: 'Attending sibling wedding ceremony in Hyderabad',
      status: LEAVE_STATUS.PENDING,
      source: LEAVE_SOURCE.TEACHER_INITIATED,
      appliedAt: new Date()
    }
  },
  { upsert: true, new: true }
);

// 4. Superseded Leave Request (Rolled over to Absent, eligible for late correction)
const pastStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
const pastEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const supersededLeave = await LR.findOneAndUpdate(
  { staffUserId: teacher3._id, status: LEAVE_STATUS.SUPERSEDED },
  {
    $set: {
      organizationId: hm.organizationId,
      townId: hm.townId,
      schoolId: hm.schoolId,
      staffUserId: teacher3._id,
      staffRole: ROLES.TEACHER,
      staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
      leaveType: LEAVE_TYPE.CASUAL_LEAVE,
      startDate: pastStart,
      endDate: pastEnd,
      durationDays: 2,
      reason: 'Urgent hospitalization of father',
      status: LEAVE_STATUS.SUPERSEDED,
      source: LEAVE_SOURCE.TEACHER_INITIATED,
      appliedAt: pastStart,
      reviewedAt: new Date(pastEnd.getTime() + 12 * 3600 * 1000),
      rejectionReason: 'Auto-superseded: request was not reviewed prior to PKT midnight rollover.'
    }
  },
  { upsert: true, new: true }
);

// Corresponding Absent StaffAttendanceRecord for teacher 3 with statusHistory
const pastDay1Utc = new Date(Date.UTC(pastStart.getUTCFullYear(), pastStart.getUTCMonth(), pastStart.getUTCDate()));
const pastDay2Utc = new Date(Date.UTC(pastEnd.getUTCFullYear(), pastEnd.getUTCMonth(), pastEnd.getUTCDate()));

for (const d of [pastDay1Utc, pastDay2Utc]) {
  await SAR.findOneAndUpdate(
    { staffUserId: teacher3._id, attendanceDate: d },
    {
      $set: {
        schoolId: hm.schoolId,
        townId: hm.townId,
        staffUserId: teacher3._id,
        staffRole: ROLES.TEACHER,
        staffCategory: STAFF_CATEGORY.SCHOOL_STAFF,
        attendanceDate: d,
        approvalStatus: STAFF_ATTENDANCE_STATUS.REJECTED,
        submittedAt: d,
        isHmSelfRecord: false,
        remarks: 'Auto-marked Absent: Casual Leave expired without timely approval.',
        statusHistory: [
          {
            event: 'AUTO_ABSENT_MIDNIGHT',
            previousStatus: 'PENDING',
            newStatus: 'REJECTED',
            changedBy: null,
            changedAt: new Date(d.getTime() + 24 * 3600 * 1000),
            reason: 'Automated midnight rollover: pending leave was not reviewed.',
            snapshot: { approvalStatus: 'REJECTED' }
          }
        ]
      }
    },
    { upsert: true, new: true }
  );
}

console.log('Seeded test records successfully:');
console.log('1. Recent Attendance (<5m):', recentSubmission._id);
console.log('2. Late Attendance (>5m):', lateSubmission._id);
console.log('3. Pending Leave Request:', pendingLeave._id);
console.log('4. Superseded Leave (Late Correction eligible):', supersededLeave._id);

await mongoose.disconnect();
