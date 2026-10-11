import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import School from '../src/models/School.js';
import Section from '../src/models/Section.js';
import ClassModel from '../src/models/Class.js';
import User from '../src/models/User.js';

async function reconcileUniqueClassTeachers() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('🔗 Connected to MongoDB for Class Teacher Uniqueness Reconciliation...\n');

  const schools = await School.find({ status: 'ACTIVE' }).lean();
  let totalDuplicatesResolved = 0;

  for (const school of schools) {
    const sections = await Section.find({ schoolId: school._id })
      .populate('classId', 'name numericGrade')
      .populate('classTeacherId', 'fullName')
      .sort({ 'classId.numericGrade': 1, createdAt: 1 });

    const seenTeachers = new Set();
    let schoolDuplicates = 0;

    for (const section of sections) {
      if (!section.classTeacherId) continue;

      const teacherIdStr = String(section.classTeacherId._id || section.classTeacherId);
      const teacherName = section.classTeacherId.fullName || 'Teacher';
      const className = section.classId?.name || 'Class';

      if (seenTeachers.has(teacherIdStr)) {
        // DUPLICATE DETECTED!
        console.log(`⚠️ Duplicate Class Teacher detected in "${school.name}":`);
        console.log(`   - Teacher: ${teacherName} (${teacherIdStr})`);
        console.log(`   - Redundant Section: ${className} — Section ${section.name}`);
        console.log(`   👉 Clearing duplicate designation to null (Unassigned)...`);

        await Section.findByIdAndUpdate(section._id, { $set: { classTeacherId: null } });
        schoolDuplicates++;
        totalDuplicatesResolved++;
      } else {
        seenTeachers.add(teacherIdStr);
        console.log(`✅ [${school.name}] Legitimate Class Teacher: ${teacherName} for ${className} — Section ${section.name}`);
      }
    }

    if (schoolDuplicates > 0) {
      console.log(`✨ Resolved ${schoolDuplicates} duplicate class teacher assignments in "${school.name}".\n`);
    }
  }

  console.log(`\n🎉 RECONCILIATION COMPLETE!`);
  console.log(`Total duplicate Class Teacher assignments resolved across all municipal schools: ${totalDuplicatesResolved}`);

  await mongoose.disconnect();
}

reconcileUniqueClassTeachers().catch((err) => {
  console.error('Reconciliation error:', err);
  process.exit(1);
});
