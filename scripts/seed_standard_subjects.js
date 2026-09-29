/**
 * Seed Standard Sindh DMC Curriculum Subjects for All Municipal Schools
 * Education Department Liaquatabad Town Centre (DMC)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import School from '../src/models/School.js';
import Subject from '../src/models/Subject.js';

const STANDARD_CURRICULUM_SUBJECTS = [
  { name: 'English', code: 'ENG', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Urdu', code: 'URD', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Mathematics', code: 'MATH', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'General Science', code: 'SCI', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Social Studies', code: 'SST', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Islamiat', code: 'ISL', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Computer Studies', code: 'CS', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Sindhi', code: 'SND', totalMarks: 100, passingMarks: 33, isElective: false },
  { name: 'Drawing & Art', code: 'ART', totalMarks: 50, passingMarks: 17, isElective: true },
  { name: 'Physical Education', code: 'PE', totalMarks: 50, passingMarks: 17, isElective: true },
];

async function seedSubjects() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(' Connected to MongoDB Atlas.');

  const schools = await School.find({}).lean();
  console.log(`Found ${schools.length} municipal schools.`);

  let totalInserted = 0;

  for (const school of schools) {
    const existingCount = await Subject.countDocuments({ schoolId: school._id });
    if (existingCount === 0) {
      const subjectsToInsert = STANDARD_CURRICULUM_SUBJECTS.map((sub) => ({
        schoolId: school._id,
        name: sub.name,
        code: `${sub.code}-${school.schoolCode || 'SCH'}`,
        totalMarks: sub.totalMarks,
        passingMarks: sub.passingMarks,
        isElective: sub.isElective,
        status: 'ACTIVE',
      }));

      await Subject.insertMany(subjectsToInsert);
      totalInserted += subjectsToInsert.length;
      console.log(`✅ Seeded ${subjectsToInsert.length} standard subjects for: ${school.name}`);
    } else {
      console.log(`ℹ️ School ${school.name} already has ${existingCount} subjects. Skipped.`);
    }
  }

  console.log(`\n🎉 Successfully seeded ${totalInserted} curriculum subjects across DMC Liaquatabad Town schools!`);
  await mongoose.disconnect();
}

seedSubjects().catch((err) => {
  console.error('Seeding error:', err);
  process.exit(1);
});
