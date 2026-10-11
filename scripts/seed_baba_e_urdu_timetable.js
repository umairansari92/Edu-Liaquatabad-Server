import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import School from '../src/models/School.js';
import User from '../src/models/User.js';
import Subject from '../src/models/Subject.js';
import ClassModel from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import TeachingAssignment from '../src/models/TeachingAssignment.js';
import Timetable from '../src/models/Timetable.js';
import { TIMETABLE_SLOT_TYPE, TIMETABLE_STATUS, TEACHING_ASSIGNMENT_STATUS } from '../config/constants.js';

async function seedBabaEUrduTimetable() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('🔗 Connected to MongoDB to seed Baba E Urdu Timetable & Subject Duties...\n');

  const school = await School.findOne({ name: /Baba E Urdu/i });
  if (!school) {
    console.error('School not found!');
    process.exit(1);
  }

  const teachers = await User.find({ schoolId: school._id, role: 'TEACHER' }).lean();
  console.log(`Found ${teachers.length} teachers in ${school.name}`);
  const memon = teachers.find(t => /Memon/i.test(t.fullName)) || teachers[0];
  const zehra = teachers.find(t => /Zehra/i.test(t.fullName)) || teachers[1];
  const umair = teachers.find(t => /Umair/i.test(t.fullName)) || teachers[2];

  const classes = await ClassModel.find({ schoolId: school._id }).sort({ numericGrade: 1 }).lean();
  const sections = await Section.find({ schoolId: school._id }).lean();
  const subjects = await Subject.find({ schoolId: school._id }).lean();

  const engSub = subjects.find(s => s.code === 'ENG') || subjects[0];
  const urdSub = subjects.find(s => s.code === 'URD') || subjects[1];
  const mathSub = subjects.find(s => s.code === 'MATH') || subjects[2];
  const sciSub = subjects.find(s => s.code === 'SCI') || subjects[3];
  const sstSub = subjects.find(s => s.code === 'SST') || subjects[4];
  const islSub = subjects.find(s => s.code === 'ISL') || subjects[5];
  const sndSub = subjects.find(s => s.code === 'SND') || subjects[7] || subjects[0];
  const artSub = subjects.find(s => s.code === 'ART') || subjects[8] || subjects[1];

  const academicSession = '2025-2026';
  const hmUser = await User.findOne({ schoolId: school._id, role: 'HM' }).lean();

  // 1. Seed Active Teaching Assignments
  console.log('🔹 Seeding active Teaching Assignments...');
  const assignmentConfigs = [
    // Class 1 (Abdul Qadir Memon is Class Teacher)
    { teacher: memon, cls: classes[0], sub: engSub, note: 'Primary English Teacher' },
    { teacher: zehra, cls: classes[0], sub: urdSub, note: 'Urdu Specialist' },
    { teacher: umair, cls: classes[0], sub: mathSub, note: 'Mathematics Fundamentals' },
    { teacher: zehra, cls: classes[0], sub: artSub, note: 'Creative Drawing' },
    { teacher: memon, cls: classes[0], sub: sndSub, note: 'Sindhi Language' },

    // Class 2 (Afsheen Zehra is Class Teacher)
    { teacher: zehra, cls: classes[1], sub: urdSub, note: 'Primary Urdu In-charge' },
    { teacher: memon, cls: classes[1], sub: engSub, note: 'English Foundation' },
    { teacher: umair, cls: classes[1], sub: mathSub, note: 'Basic Arithmetic' },
    { teacher: umair, cls: classes[1], sub: sciSub, note: 'Elementary Science' },

    // Class 3 (Umair Ahmed is Class Teacher)
    { teacher: umair, cls: classes[2], sub: mathSub, note: 'Mathematics In-charge' },
    { teacher: memon, cls: classes[2], sub: engSub, note: 'English Grammar' },
    { teacher: zehra, cls: classes[2], sub: urdSub, note: 'Urdu Reader' },
    { teacher: umair, cls: classes[2], sub: sciSub, note: 'General Science' },
    { teacher: zehra, cls: classes[2], sub: islSub, note: 'Islamic Studies' },
  ];

  for (const cfg of assignmentConfigs) {
    if (!cfg.cls || !cfg.teacher || !cfg.sub) continue;
    const sec = sections.find(s => String(s.classId) === String(cfg.cls._id));

    await TeachingAssignment.findOneAndUpdate(
      {
        teacherId: cfg.teacher._id,
        schoolId: school._id,
        classId: cfg.cls._id,
        subjectId: cfg.sub._id,
        academicSession,
      },
      {
        $set: {
          sectionId: sec ? sec._id : null,
          effectiveFrom: new Date('2025-08-01'),
          status: TEACHING_ASSIGNMENT_STATUS.ACTIVE,
          assignedBy: hmUser?._id || cfg.teacher._id,
          remarks: cfg.note,
        },
      },
      { upsert: true, new: true }
    );
  }
  console.log(`   ✅ Seeded ${assignmentConfigs.length} Teaching Assignments.`);

  // 2. Configure Master Timetable
  console.log('🔹 Configuring 7-Period Timetable Matrix with Schedule Entries...');
  const periodSlots = [
    { periodNumber: 1, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '1st', startTime: '08:00', endTime: '08:35' },
    { periodNumber: 2, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '2nd', startTime: '08:35', endTime: '09:10' },
    { periodNumber: 3, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '3rd', startTime: '09:10', endTime: '09:45' },
    { periodNumber: 4, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '4th', startTime: '09:45', endTime: '10:15' },
    { periodNumber: 0, slotType: TIMETABLE_SLOT_TYPE.RECESS, label: 'BREAK', startTime: '10:15', endTime: '10:35' },
    { periodNumber: 5, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '5th', startTime: '10:35', endTime: '11:10' },
    { periodNumber: 6, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '6th', startTime: '11:10', endTime: '11:45' },
    { periodNumber: 7, slotType: TIMETABLE_SLOT_TYPE.TEACHING, label: '7th', startTime: '11:45', endTime: '12:20' },
  ];

  const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const scheduleEntries = [];

  for (const day of days) {
    // Class 1
    const sec1 = sections.find(s => String(s.classId) === String(classes[0]?._id));
    scheduleEntries.push(
      { dayOfWeek: day, periodNumber: 1, classId: classes[0]._id, sectionId: sec1?._id, subjectId: engSub._id, teacherId: memon._id, roomNumber: 'R-101' },
      { dayOfWeek: day, periodNumber: 2, classId: classes[0]._id, sectionId: sec1?._id, subjectId: urdSub._id, teacherId: zehra._id, roomNumber: 'R-101' },
      { dayOfWeek: day, periodNumber: 3, classId: classes[0]._id, sectionId: sec1?._id, subjectId: mathSub._id, teacherId: umair._id, roomNumber: 'R-101' },
      { dayOfWeek: day, periodNumber: 4, classId: classes[0]._id, sectionId: sec1?._id, subjectId: sndSub._id, teacherId: memon._id, roomNumber: 'R-101' },
      { dayOfWeek: day, periodNumber: 5, classId: classes[0]._id, sectionId: sec1?._id, subjectId: artSub._id, teacherId: zehra._id, roomNumber: 'R-101' },
      { dayOfWeek: day, periodNumber: 6, classId: classes[0]._id, sectionId: sec1?._id, subjectId: islSub._id, teacherId: umair._id, roomNumber: 'R-101' },
      { dayOfWeek: day, periodNumber: 7, classId: classes[0]._id, sectionId: sec1?._id, subjectId: engSub._id, teacherId: memon._id, roomNumber: 'R-101' }
    );

    // Class 2
    if (classes[1]) {
      const sec2 = sections.find(s => String(s.classId) === String(classes[1]._id));
      scheduleEntries.push(
        { dayOfWeek: day, periodNumber: 1, classId: classes[1]._id, sectionId: sec2?._id, subjectId: urdSub._id, teacherId: zehra._id, roomNumber: 'R-201' },
        { dayOfWeek: day, periodNumber: 2, classId: classes[1]._id, sectionId: sec2?._id, subjectId: engSub._id, teacherId: memon._id, roomNumber: 'R-201' },
        { dayOfWeek: day, periodNumber: 3, classId: classes[1]._id, sectionId: sec2?._id, subjectId: sciSub._id, teacherId: umair._id, roomNumber: 'R-201' },
        { dayOfWeek: day, periodNumber: 4, classId: classes[1]._id, sectionId: sec2?._id, subjectId: urdSub._id, teacherId: zehra._id, roomNumber: 'R-201' },
        { dayOfWeek: day, periodNumber: 5, classId: classes[1]._id, sectionId: sec2?._id, subjectId: mathSub._id, teacherId: umair._id, roomNumber: 'R-201' },
        { dayOfWeek: day, periodNumber: 6, classId: classes[1]._id, sectionId: sec2?._id, subjectId: engSub._id, teacherId: memon._id, roomNumber: 'R-201' },
        { dayOfWeek: day, periodNumber: 7, classId: classes[1]._id, sectionId: sec2?._id, subjectId: artSub._id, teacherId: zehra._id, roomNumber: 'R-201' }
      );
    }

    // Class 3
    if (classes[2]) {
      const sec3 = sections.find(s => String(s.classId) === String(classes[2]._id));
      scheduleEntries.push(
        { dayOfWeek: day, periodNumber: 1, classId: classes[2]._id, sectionId: sec3?._id, subjectId: mathSub._id, teacherId: umair._id, roomNumber: 'R-301' },
        { dayOfWeek: day, periodNumber: 2, classId: classes[2]._id, sectionId: sec3?._id, subjectId: sciSub._id, teacherId: umair._id, roomNumber: 'R-301' },
        { dayOfWeek: day, periodNumber: 3, classId: classes[2]._id, sectionId: sec3?._id, subjectId: engSub._id, teacherId: memon._id, roomNumber: 'R-301' },
        { dayOfWeek: day, periodNumber: 4, classId: classes[2]._id, sectionId: sec3?._id, subjectId: islSub._id, teacherId: zehra._id, roomNumber: 'R-301' },
        { dayOfWeek: day, periodNumber: 5, classId: classes[2]._id, sectionId: sec3?._id, subjectId: sstSub._id, teacherId: memon._id, roomNumber: 'R-301' },
        { dayOfWeek: day, periodNumber: 6, classId: classes[2]._id, sectionId: sec3?._id, subjectId: urdSub._id, teacherId: zehra._id, roomNumber: 'R-301' },
        { dayOfWeek: day, periodNumber: 7, classId: classes[2]._id, sectionId: sec3?._id, subjectId: mathSub._id, teacherId: umair._id, roomNumber: 'R-301' }
      );
    }
  }

  const updatedTimetable = await Timetable.findOneAndUpdate(
    { schoolId: school._id, academicYear: academicSession },
    {
      $set: {
        periodSlots,
        schedule: scheduleEntries,
        status: TIMETABLE_STATUS.ACTIVE,
        effectiveFrom: new Date('2025-08-01'),
        lastModifiedBy: hmUser?._id || memon._id,
      },
    },
    { upsert: true, new: true }
  );

  console.log(`   ✅ Timetable updated with ${updatedTimetable.schedule.length} schedule entries across Monday-Saturday!`);
  console.log('\n🎉 SEEDING COMPLETE FOR BABA E URDU SCHOOL!');
  await mongoose.disconnect();
}

seedBabaEUrduTimetable().catch((err) => {
  console.error('Error seeding timetable:', err);
  process.exit(1);
});
