import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Subject from '../src/models/Subject.js';

async function inspect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  const totalSchools = await School.countDocuments();
  const totalClasses = await Class.countDocuments();
  const totalSubjects = await Subject.countDocuments();

  console.log(`Total Schools: ${totalSchools}`);
  console.log(`Total Classes: ${totalClasses}`);
  console.log(`Total Subjects: ${totalSubjects}`);

  // Sample classes
  const sampleClasses = await Class.find().limit(15).select('name numericGrade schoolId').lean();
  console.log('\nSample Classes:');
  console.log(sampleClasses);

  // Group classes by school
  const classSchoolAgg = await Class.aggregate([
    { $group: { _id: '$schoolId', count: { $sum: 1 }, grades: { $push: '$numericGrade' } } }
  ]);
  console.log(`\nClasses distributed across ${classSchoolAgg.length} schools:`);
  for (const s of classSchoolAgg.slice(0, 5)) {
    console.log(`School ${s._id}: ${s.count} classes, grades: [${s.grades.sort((a,b)=>a-b).join(', ')}]`);
  }

  // Sample subjects
  const sampleSubjects = await Subject.find().limit(15).select('name code schoolId classId').lean();
  console.log('\nSample Subjects:');
  console.log(sampleSubjects);

  await mongoose.disconnect();
}

inspect().catch(console.error);
