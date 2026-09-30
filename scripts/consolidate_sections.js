import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import Section from '../src/models/Section.js';
import ClassModel from '../src/models/Class.js';
import StudentProfile from '../src/models/StudentProfile.js';
import Attendance from '../src/models/Attendance.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import Homework from '../src/models/Homework.js';
import Result from '../src/models/Result.js';

async function consolidateSections() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB. Starting section consolidation...');

  const allClasses = await ClassModel.find().lean();
  console.log(`Found ${allClasses.length} classes across all schools.`);

  let migratedStudents = 0;
  let migratedAttendance = 0;
  let removedBSections = 0;

  for (const classDoc of allClasses) {
    const classId = classDoc._id;
    const sections = await Section.find({ classId }).sort({ createdAt: 1 }).lean();

    if (sections.length <= 1) {
      // 0 or 1 section, ensure it's named 'General' or keep clean
      continue;
    }

    // Keep the first section (usually 'A') as primary
    const primarySection = sections[0];
    const secondarySections = sections.slice(1);
    const secondaryIds = secondarySections.map(s => s._id);

    // Update StudentProfiles
    const studentUpdate = await StudentProfile.updateMany(
      { classId, sectionId: { $in: secondaryIds } },
      { $set: { sectionId: primarySection._id } }
    );
    migratedStudents += studentUpdate.modifiedCount;

    // Update Attendance
    const attendanceUpdate = await Attendance.updateMany(
      { classId, sectionId: { $in: secondaryIds } },
      { $set: { sectionId: primarySection._id } }
    );
    migratedAttendance += attendanceUpdate.modifiedCount;

    // Update TeachingAssignments
    await TeachingAssignment.updateMany(
      { classId, sectionId: { $in: secondaryIds } },
      { $set: { sectionId: primarySection._id } }
    );

    // Update Homework
    await Homework.updateMany(
      { classId, sectionId: { $in: secondaryIds } },
      { $set: { sectionId: primarySection._id } }
    );

    // Update Result
    if (Result) {
      await Result.updateMany(
        { classId, sectionId: { $in: secondaryIds } },
        { $set: { sectionId: primarySection._id } }
      );
    }

    // Delete secondary sections
    const delResult = await Section.deleteMany({ _id: { $in: secondaryIds } });
    removedBSections += delResult.deletedCount;
  }

  // Also rename remaining sections to remove 'A' if desired or keep single
  console.log(`Consolidation Complete:
  - Migrated Students: ${migratedStudents}
  - Migrated Attendance Records: ${migratedAttendance}
  - Removed Duplicate Sections: ${removedBSections}
  `);

  await mongoose.disconnect();
}

consolidateSections().catch((err) => {
  console.error('Error during consolidation:', err);
  process.exit(1);
});
