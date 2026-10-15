import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import User from '../src/models/User.js';
import StudentProfile from '../src/models/StudentProfile.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import School from '../src/models/School.js';
import ClassModel from '../src/models/Class.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/school_management_db';

async function countStats() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB.\n');

    // 1. User counts by role
    const usersByRole = await User.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    console.log('=== 1. USERS COLLECTION BY ROLE ===');
    let totalUsers = 0;
    usersByRole.forEach((r) => {
      console.log(`- ${r._id || 'NO_ROLE'}: ${r.count}`);
      totalUsers += r.count;
    });
    console.log(`TOTAL USERS: ${totalUsers}\n`);

    // 2. Student Profiles
    const totalStudentProfiles = await StudentProfile.countDocuments();
    const studentsByStatus = await StudentProfile.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    console.log('=== 2. STUDENT PROFILES ===');
    console.log(`TOTAL STUDENT PROFILES: ${totalStudentProfiles}`);
    studentsByStatus.forEach((s) => {
      console.log(`- Status "${s._id}": ${s.count}`);
    });
    console.log('');

    // 3. Teacher Profiles
    const totalTeacherProfiles = await TeacherProfile.countDocuments();
    const teachersByStatus = await TeacherProfile.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    console.log('=== 3. TEACHER PROFILES ===');
    console.log(`TOTAL TEACHER PROFILES: ${totalTeacherProfiles}`);
    teachersByStatus.forEach((t) => {
      console.log(`- Status "${t._id}": ${t.count}`);
    });
    console.log('');

    // 4. Breakdown per School
    const schools = await School.find({}).lean();
    console.log('=== 4. SCHOOL-WISE BREAKDOWN ===');
    for (const school of schools) {
      const studentCount = await StudentProfile.countDocuments({ schoolId: school._id });
      const teacherCount = await User.countDocuments({
        schoolId: school._id,
        role: { $in: ['TEACHER', 'HM'] },
      });
      const hmCount = await User.countDocuments({
        schoolId: school._id,
        role: 'HM',
      });
      const regularTeachers = await User.countDocuments({
        schoolId: school._id,
        role: 'TEACHER',
      });

      console.log(`School: ${school.name} (${school.bemisCode || 'No BEMIS'})`);
      console.log(`  - Students: ${studentCount}`);
      console.log(`  - Head Masters: ${hmCount}`);
      console.log(`  - Teachers: ${regularTeachers}`);
      console.log(`  - Total Faculty: ${teacherCount}\n`);
    }

    // 5. Detailed List of Students
    console.log('=== 5. DETAILED STUDENTS LIST ===');
    const students = await StudentProfile.find({})
      .populate('userId', 'fullName email')
      .populate('schoolId', 'name')
      .populate('classId', 'name numericGrade')
      .lean();

    students.forEach((st, idx) => {
      console.log(
        `${idx + 1}. [GR #${st.grNumber || 'N/A'}] ${st.fullName || st.userId?.fullName || 'Unnamed'} ` +
        `| Roll #${st.rollNumber || '—'} ` +
        `| Class: ${st.classId?.name || 'Class ' + st.classId?.numericGrade || '—'} ` +
        `| School: ${st.schoolId?.name || '—'} ` +
        `| Status: ${st.status}`
      );
    });

    // 6. Detailed List of Teachers & HMs
    console.log('\n=== 6. DETAILED TEACHERS & HEAD MASTERS LIST ===');
    const facultyUsers = await User.find({
      role: { $in: ['TEACHER', 'HM'] },
    })
      .populate('schoolId', 'name')
      .select('fullName email role designation schoolId status')
      .lean();

    facultyUsers.forEach((fc, idx) => {
      console.log(
        `${idx + 1}. ${fc.fullName} (${fc.email}) ` +
        `| Role: ${fc.role} ` +
        `| Designation: ${fc.designation || 'Teacher'} ` +
        `| School: ${fc.schoolId?.name || '—'} ` +
        `| Status: ${fc.status}`
      );
    });

  } catch (err) {
    console.error('Error querying counts:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

countStats();
