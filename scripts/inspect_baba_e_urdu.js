import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import School from '../src/models/School.js';
import ClassModel from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import User from '../src/models/User.js';
import StudentProfile from '../src/models/StudentProfile.js';
import TeacherProfile from '../src/models/TeacherProfile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function inspect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.\n');

  const school = await School.findOne({ name: /Baba E Urdu/i }).lean();
  if (!school) {
    console.error('Baba E Urdu school not found!');
    process.exit(1);
  }

  console.log(`=== SCHOOL: ${school.name} ===`);
  console.log(`ID: ${school._id}`);
  console.log(`Town ID: ${school.townId}`);
  console.log(`Organization ID: ${school.organizationId}`);
  console.log(`Last GR Number: ${school.lastGrNumber}`);
  console.log(`Last Global Sequence: ${school.lastGlobalSequence}\n`);

  const classes = await ClassModel.find({ schoolId: school._id }).sort({ numericGrade: 1 }).lean();
  console.log(`Found ${classes.length} classes:`);
  for (const c of classes) {
    const studentCount = await StudentProfile.countDocuments({ classId: c._id });
    const sections = await Section.find({ classId: c._id }).lean();
    console.log(`- ${c.name} (Grade ${c.numericGrade}, ID: ${c._id}): ${studentCount} students, ${sections.length} sections`);
  }

  const teachers = await User.find({ schoolId: school._id, role: 'TEACHER' }).lean();
  console.log(`\nFound ${teachers.length} teachers:`);
  teachers.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.fullName} (${t.email}) - ${t.designation}`);
  });

  const hms = await User.find({ schoolId: school._id, role: 'HM' }).lean();
  console.log(`\nFound ${hms.length} Head Masters:`);
  hms.forEach((h, i) => {
    console.log(`  ${i + 1}. ${h.fullName} (${h.email})`);
  });

  await mongoose.disconnect();
}

inspect();
