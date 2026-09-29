import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import User from '../src/models/User.js';
import ClassModel from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import Subject from '../src/models/Subject.js';
import School from '../src/models/School.js';

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const hms = await User.find({ role: 'HM' }).lean();
  console.log('Total HMs:', hms.length);
  for (const hm of hms.slice(0, 10)) {
    const school = await School.findById(hm.schoolId).lean();
    const classCount = await ClassModel.countDocuments({ schoolId: hm.schoolId });
    const sectionCount = await Section.countDocuments({ schoolId: hm.schoolId });
    const subjectCount = await Subject.countDocuments({ schoolId: hm.schoolId });
    console.log(`HM: ${hm.fullName} (${hm.email}) | School: ${school?.name} (${hm.schoolId}) | Classes: ${classCount} | Sections: ${sectionCount} | Subjects: ${subjectCount}`);
  }

  // Also check Abdul Qadir Memon from screenshot
  const memon = await User.findOne({ fullName: /Abdul Qadir Memon/i }).lean();
  if (memon) {
    console.log('\nFaculty Member in screenshot:', memon.fullName, memon.schoolId);
    const memonSchool = await School.findById(memon.schoolId).lean();
    const mClasses = await ClassModel.find({ schoolId: memon.schoolId }).lean();
    const mSections = await Section.find({ schoolId: memon.schoolId }).lean();
    const mSubjects = await Subject.find({ schoolId: memon.schoolId }).lean();
    console.log('School:', memonSchool?.name);
    console.log('Classes found:', mClasses.length, mClasses.map(c => c.name));
    console.log('Sections found:', mSections.length, mSections.map(s => s.name));
    console.log('Subjects found:', mSubjects.length, mSubjects.map(s => s.name));
  }

  await mongoose.disconnect();
}
check();
