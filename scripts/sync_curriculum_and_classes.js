import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Subject from '../src/models/Subject.js';
import { provisionSchoolClassesAndCurriculum, STANDARD_CURRICULUM_SUBJECTS } from '../src/utils/curriculumStandards.js';

async function syncAllSchools() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB database...');

  const schools = await School.find();
  console.log(`Found ${schools.length} municipal schools. Starting curriculum & class synchronization...\n`);

  for (const school of schools) {
    // 1. Determine Grade Range
    const existingClasses = await Class.find({ schoolId: school._id }).sort({ numericGrade: 1 });
    let minGrade = 1;
    let maxGrade = 5;

    if (existingClasses.length > 0) {
      const grades = existingClasses.map((c) => Number(c.numericGrade)).filter((g) => !isNaN(g) && g > 0);
      if (grades.length > 0) {
        minGrade = Math.min(...grades);
        maxGrade = Math.max(...grades);
      }
    } else {
      if (school.schoolType === 'PRIMARY') {
        minGrade = 1;
        maxGrade = 5;
      } else if (school.schoolType === 'ELEMENTARY') {
        minGrade = 1;
        maxGrade = 8;
      } else if (school.schoolType === 'SECONDARY') {
        minGrade = 6;
        maxGrade = 10;
      } else if (school.schoolType === 'ECE') {
        minGrade = 1;
        maxGrade = 2;
      }
    }

    // Update School Model gradeRange
    school.gradeRange = {
      lowestGrade: String(minGrade),
      highestGrade: String(maxGrade),
    };
    await school.save();

    // 2. Provision Classes & Standard DMC Liaquatabad Curriculum Subjects
    const result = await provisionSchoolClassesAndCurriculum(school._id, minGrade, maxGrade);

    console.log(`[Synced] ${school.name} (${school.schoolCode || 'NO-CODE'})`);
    console.log(`   Type: ${school.schoolType} | Grade Range: Class ${minGrade} to Class ${maxGrade}`);
    console.log(`   Classes: ${result.classes.map((c) => c.name).join(', ')}`);
    console.log(`   Standard Subjects: ${result.subjects.map((s) => `${s.name} (${s.code})`).join(', ')}\n`);
  }

  // 3. Global Subject Code & Grade Level Standardization
  console.log('Standardizing all subject codes and grade levels across the municipal database...');
  for (const std of STANDARD_CURRICULUM_SUBJECTS) {
    const updateResult = await Subject.updateMany(
      { name: std.name },
      {
        $set: {
          code: std.code,
          gradeLevels: std.gradeLevels,
          totalMarks: std.totalMarks,
          passingMarks: std.passingMarks,
        },
      }
    );
    console.log(`Standardized ${std.name} (${std.code}) -> ${updateResult.modifiedCount} records updated`);
  }

  console.log('✅ Synchronization completed successfully across all municipal schools.');
  await mongoose.disconnect();
}

syncAllSchools().catch((err) => {
  console.error('Error during synchronization:', err);
  process.exit(1);
});
