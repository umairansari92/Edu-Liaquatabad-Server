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
import ParentStudentLink from '../src/models/ParentStudentLink.js';
import { hashPassword } from '../src/utils/passwordUtils.js';
import {
  ROLES,
  BASE_ROLES,
  SCOPES,
  USER_STATUS,
  STUDENT_STATUS,
  TEACHER_STATUS,
  PARENT_STUDENT_LINK_STATUS,
  PARENT_RELATIONSHIP,
} from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const DEFAULT_PASSWORD = 'Liaquatabad2026!';

// Authentic names pool for Pakistani student & parent generation
const BOY_FIRST_NAMES = [
  'Muhammad', 'Ahmed', 'Ali', 'Hamza', 'Bilal', 'Umar', 'Usman', 'Hassan',
  'Hussain', 'Zayd', 'Abdullah', 'Mustafa', 'Ibrahim', 'Daniyal', 'Farhan',
  'Shahzaib', 'Taha', 'Rehan', 'Arham', 'Ayan', 'Fahad', 'Saad', 'Owais',
  'Zubair', 'Tariq', 'Shoaib', 'Huzaifa', 'Rohaan', 'Sameer', 'Waleed',
];

const GIRL_FIRST_NAMES = [
  'Fatima', 'Ayesha', 'Maryam', 'Khadija', 'Hafsa', 'Sara', 'Anum', 'Mahnoor',
  'Hania', 'Zoya', 'Dua', 'Iqra', 'Bushra', 'Noor', 'Sadia', 'Rabia',
  'Nimra', 'Laiba', 'Kinza', 'Bisma', 'Aliza', 'Manahil', 'Amna', 'Rimsha',
  'Hiba', 'Sidra', 'Areeba', 'Mehak', 'Sumayya', 'Eshaal',
];

const SURNAMES = [
  'Khan', 'Qureshi', 'Siddiqui', 'Ansari', 'Memon', 'Rajput', 'Lodhi', 'Sheikh',
  'Mehmood', 'Shah', 'Baloch', 'Bhatti', 'Farooqi', 'Usmani', 'Kazmi', 'Abbasi',
  'Hashmi', 'Alvi', 'Malik', 'Javed', 'Niazi', 'Chaudhry',
];

const FATHER_FIRST_NAMES = [
  'Tariq', 'Farooq', 'Rashid', 'Jamil', 'Naveed', 'Kamran', 'Shakeel', 'Imran',
  'Zahid', 'Nadeem', 'Saeed', 'Waqar', 'Asim', 'Rizwan', 'Salman', 'Khalid',
  'Nasir', 'Babar', 'Munir', 'Zulfiqar', 'Irfan', 'Adnan', 'Masood', 'Pervez',
];

const MOTHER_FIRST_NAMES = [
  'Parveen', 'Nasreen', 'Shamim', 'Farzana', 'Shazia', 'Yasmeen', 'Kausar',
  'Shaheen', 'Rukhsana', 'Bilqees', 'Razia', 'Nargis', 'Suraiya', 'Shahnaz',
  'Samina', 'Uzma', 'Tahira', 'Gulshan', 'Nusrat', 'Sabira',
];

// 7 New Teachers for Baba-e-Urdu School (to reach exactly 10 teachers)
const NEW_TEACHERS = [
  {
    fullName: 'Syed Mansoor Ali',
    fatherName: 'Syed Ali Asghar',
    gender: 'MALE',
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.Sc Chemistry, B.Ed',
    specializationSubjects: ['General Science', 'Chemistry'],
    bankName: 'National Bank of Pakistan',
    branchName: 'Liaquatabad Branch, Karachi',
  },
  {
    fullName: 'Nida Yasmeen',
    fatherName: 'Muhammad Akram Khan',
    gender: 'FEMALE',
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'M.A English Literature, B.Ed',
    specializationSubjects: ['English', 'General Knowledge'],
    bankName: 'Sindh Bank',
    branchName: 'Liaquatabad Town Branch, Karachi',
  },
  {
    fullName: 'Rashid Mehmood',
    fatherName: 'Sultan Mehmood',
    gender: 'MALE',
    designation: 'Primary School Teacher (BPS-14)',
    qualification: 'B.Sc Mathematics, B.Ed',
    specializationSubjects: ['Mathematics', 'Sindhi'],
    bankName: 'Habib Bank Limited',
    branchName: 'Liaquatabad No. 4, Karachi',
  },
  {
    fullName: 'Hina Kausar',
    fatherName: 'Kausar Hussain Shah',
    gender: 'FEMALE',
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.A Urdu Literature, M.Ed',
    specializationSubjects: ['Urdu', 'Islamiat', 'Social Studies'],
    bankName: 'United Bank Limited',
    branchName: 'Dak Khana Branch, Karachi',
  },
  {
    fullName: 'Muhammad Waqas Abbasi',
    fatherName: 'Abdul Hameed Abbasi',
    gender: 'MALE',
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'BS Computer Science, B.Ed',
    specializationSubjects: ['Computer Science', 'Mathematics'],
    bankName: 'Meezan Bank',
    branchName: 'Liaquatabad Branch, Karachi',
  },
  {
    fullName: 'Saima Farooqi',
    fatherName: 'Ahmed Saeed Farooqi',
    gender: 'FEMALE',
    designation: 'Primary School Teacher (BPS-14)',
    qualification: 'B.Sc Zoology, B.Ed',
    specializationSubjects: ['General Science', 'Social Studies'],
    bankName: 'Sindh Bank',
    branchName: 'Liaquatabad Branch, Karachi',
  },
  {
    fullName: 'Farhan Akhtar Usmani',
    fatherName: 'Akhtar Hussain Usmani',
    gender: 'MALE',
    designation: 'Primary School Teacher / Physical Instructor (BPS-14)',
    qualification: 'B.A, B.P.Ed (Physical Education)',
    specializationSubjects: ['Physical Education', 'Urdu', 'Art & Craft'],
    bankName: 'National Bank of Pakistan',
    branchName: 'Liaquatabad Branch, Karachi',
  },
];

export async function seedBabaEUrdu() {
  console.log('==============================================================================');
  console.log('🏛️ SEEDING BABA-E-URDU SCHOOL: TEACHERS, BALANCED STUDENTS & PARENTS');
  console.log('==============================================================================\n');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  console.log(' Connected to MongoDB.');

  const school = await School.findOne({ name: /Baba E Urdu/i });
  if (!school) {
    throw new Error('Baba E Urdu school not found!');
  }

  const hmUser = await User.findOne({ schoolId: school._id, role: ROLES.HM }).lean();
  if (!hmUser) {
    throw new Error('Baba E Urdu Head Master user not found!');
  }

  console.log(` Target School: ${school.name} (Code: ${school.schoolCode})`);
  console.log(` Head Master:   ${hmUser.fullName} (${hmUser.email})\n`);

  const commonPasswordHash = await hashPassword(DEFAULT_PASSWORD);

  // ───────────────────────────────────────────────────────────────────────────
  // PART 1: SCALE TEACHING FACULTY TO EXACTLY 10 TEACHERS
  // ───────────────────────────────────────────────────────────────────────────
  const existingTeachers = await User.find({ schoolId: school._id, role: ROLES.TEACHER }).lean();
  console.log(` Current Teachers count in Baba-e-Urdu: ${existingTeachers.length}`);

  const targetNewTeacherCount = 10 - existingTeachers.length;
  console.log(` Needed new teachers to reach 10: ${targetNewTeacherCount}`);

  if (targetNewTeacherCount > 0) {
    // Find next available staffXX number
    const allStaffUsers = await User.find({ email: /staff\d+\.liaquatabad@dmc\.gov\.pk/ }).lean();
    const existingStaffNums = allStaffUsers
      .map((u) => {
        const m = u.email.match(/staff(\d+)\.liaquatabad/);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter((n) => n > 0);

    let nextStaffNum = existingStaffNums.length > 0 ? Math.max(...existingStaffNums) + 1 : 61;

    for (let i = 0; i < targetNewTeacherCount; i++) {
      const teacherMeta = NEW_TEACHERS[i % NEW_TEACHERS.length];
      const staffNum = nextStaffNum++;
      const email = `staff${staffNum}.liaquatabad@dmc.gov.pk`;
      const phoneNumber = `0300-111${String(staffNum).padStart(4, '0')}`;
      const employeeId = `EMP-LQT-${1000 + staffNum}`;
      const cnic = `42101-10${staffNum}887-${(staffNum % 9) + 1}`;

      const teacherUser = await User.findOneAndUpdate(
        { email },
        {
          $set: {
            organizationId: school.organizationId,
            townId: school.townId,
            schoolId: school._id,
            fullName: teacherMeta.fullName,
            email,
            passwordHash: commonPasswordHash,
            phoneNumber,
            designation: teacherMeta.designation,
            baseRole: BASE_ROLES.TEACHER,
            role: ROLES.TEACHER,
            scope: SCOPES.CLASS_SECTION,
            status: USER_STATUS.ACTIVE,
            tokenVersion: 0,
          },
        },
        { upsert: true, new: true }
      );

      await TeacherProfile.findOneAndUpdate(
        { userId: teacherUser._id },
        {
          $set: {
            currentSchoolId: school._id,
            employeeId,
            fatherName: teacherMeta.fatherName,
            designation: teacherMeta.designation,
            qualification: teacherMeta.qualification,
            cnic,
            isTeachingStaff: true,
            lifecycleStatus: TEACHER_STATUS.ACTIVE,
            specializationSubjects: teacherMeta.specializationSubjects,
            bankName: teacherMeta.bankName,
            branchName: teacherMeta.branchName,
            accountNumber: `0128001000${staffNum}91`,
            accountTitle: teacherMeta.fullName,
            joiningDate: new Date(2024, 0, 15),
            appointmentDate: new Date(2018, 5, 1),
            privacySettings: {
              fieldVisibility: {
                profilePhoto: 'PUBLIC',
                designation: 'PUBLIC',
                qualification: 'PUBLIC',
                phoneNumber: 'SCHOOL',
                email: 'SCHOOL',
                cnic: 'AUTHORIZED_ROLE',
                bankDetails: 'AUTHORIZED_ROLE',
                residentialAddress: 'AUTHORIZED_ROLE',
              },
              allowAuthorizedPdfDownload: false,
              updatedAt: new Date(),
            },
          },
        },
        { upsert: true, new: true }
      );

      console.log(`   + Added Teacher [${i + 1}/${targetNewTeacherCount}]: ${teacherMeta.fullName} (${email}) - ${teacherMeta.designation}`);
    }
  }

  const finalTeacherCount = await User.countDocuments({ schoolId: school._id, role: ROLES.TEACHER });
  console.log(`\n Total Teachers in Baba-e-Urdu is now: ${finalTeacherCount} (Target: 10 reached)\n`);

  // ───────────────────────────────────────────────────────────────────────────
  // PART 2: LINK EXISTING BABA-E-URDU STUDENTS WITH VERIFIED PARENT LINKS
  // ───────────────────────────────────────────────────────────────────────────
  const existingProfiles = await StudentProfile.find({ schoolId: school._id }).lean();
  console.log(` Authorizing existing ${existingProfiles.length} students with verified parent links...`);

  for (const profile of existingProfiles) {
    if (profile.parentUserId) {
      await ParentStudentLink.findOneAndUpdate(
        { parentId: profile.parentUserId, studentProfileId: profile._id },
        {
          $set: {
            schoolId: school._id,
            relationship: profile.relationshipWithStudent || PARENT_RELATIONSHIP.FATHER,
            verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
            contactOtpVerified: true,
            contactVerifiedAt: new Date(),
            verifiedBy: hmUser._id,
            verifiedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    }
  }
  console.log(` Verified parent links configured for existing student records.\n`);

  // ───────────────────────────────────────────────────────────────────────────
  // PART 3: BALANCE EVERY CLASS TO 18 STUDENTS (9 BOYS, 9 GIRLS)
  // ───────────────────────────────────────────────────────────────────────────
  const classes = await ClassModel.find({ schoolId: school._id }).sort({ numericGrade: 1 }).lean();
  console.log(` Processing ${classes.length} Classes for balanced enrollment (Target: 18 students per class = 9 Boys, 9 Girls):`);

  // Global sequence counters
  const allStudentUsers = await User.find({ email: /student\d+\.liaquatabad@dmc\.gov\.pk/ }).lean();
  const existingStudentNums = allStudentUsers
    .map((u) => {
      const m = u.email.match(/student(\d+)\.liaquatabad/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((n) => n > 0);

  let nextStudentNum = existingStudentNums.length > 0 ? Math.max(...existingStudentNums) + 1 : 101;

  const allParentUsers = await User.find({ email: /parent\d+\.liaquatabad@dmc\.gov\.pk/ }).lean();
  const existingParentNums = allParentUsers
    .map((u) => {
      const m = u.email.match(/parent(\d+)\.liaquatabad/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((n) => n > 0);

  let nextParentNum = existingParentNums.length > 0 ? Math.max(...existingParentNums) + 1 : 25;

  let currentGr = school.lastGrNumber || 107;
  let currentSeq = school.lastGlobalSequence || 7;
  let totalNewStudentsAdded = 0;
  let totalNewParentsAdded = 0;

  for (const c of classes) {
    const sections = await Section.find({ classId: c._id }).lean();
    const primarySection = sections.length > 0 ? sections[0] : null;

    const existingInClass = await StudentProfile.find({ classId: c._id }).lean();
    const existingMales = existingInClass.filter((s) => s.gender === 'MALE');
    const existingFemales = existingInClass.filter((s) => s.gender === 'FEMALE');

    const targetMales = 9;
    const targetFemales = 9;

    const neededMales = Math.max(0, targetMales - existingMales.length);
    const neededFemales = Math.max(0, targetFemales - existingFemales.length);

    console.log(`\n ▶ Class ${c.name} (Grade ${c.numericGrade}): Currently ${existingInClass.length} students (${existingMales.length} M, ${existingFemales.length} F). Need: ${neededMales} Boys, ${neededFemales} Girls.`);

    const studentsToAdd = [];
    for (let m = 0; m < neededMales; m++) {
      studentsToAdd.push({ gender: 'MALE' });
    }
    for (let f = 0; f < neededFemales; f++) {
      studentsToAdd.push({ gender: 'FEMALE' });
    }

    // Alternate genders in insertion
    studentsToAdd.sort(() => Math.random() - 0.5);

    let rollNumberCounter = existingInClass.length + 1;

    for (const studentSlot of studentsToAdd) {
      const gender = studentSlot.gender;
      const firstName = gender === 'MALE'
        ? BOY_FIRST_NAMES[Math.floor(Math.random() * BOY_FIRST_NAMES.length)]
        : GIRL_FIRST_NAMES[Math.floor(Math.random() * GIRL_FIRST_NAMES.length)];
      const surname = SURNAMES[Math.floor(Math.random() * SURNAMES.length)];
      const studentFullName = `${firstName} ${surname}`;

      const fatherFirstName = FATHER_FIRST_NAMES[Math.floor(Math.random() * FATHER_FIRST_NAMES.length)];
      const fatherFullName = `${fatherFirstName} ${surname}`;
      const motherFirstName = MOTHER_FIRST_NAMES[Math.floor(Math.random() * MOTHER_FIRST_NAMES.length)];
      const motherFullName = `Mst. ${motherFirstName} ${surname}`;

      currentGr += 1;
      currentSeq += 1;
      const grNumber = currentGr;
      const seqStr = String(grNumber).padStart(4, '0');
      const globalStudentId = `${school.schoolCode}-${seqStr}`;
      const admissionRegisterNumber = `${school.schoolCode}-2026-${seqStr}`;
      const bFormNumber = `42101-${String(4000000 + grNumber * 137).slice(0, 7)}-${(grNumber % 9) + 1}`;

      // Appropriate age by grade: Grade 1 ~ 6yo (born 2020), Grade 8 ~ 13yo (born 2013)
      const birthYear = 2021 - c.numericGrade;
      const birthMonth = (grNumber * 3) % 12;
      const birthDay = ((grNumber * 7) % 27) + 1;
      const dateOfBirth = new Date(birthYear, birthMonth, birthDay);

      // Student User
      const sNum = nextStudentNum++;
      const studentEmail = `student${String(sNum).padStart(3, '0')}.liaquatabad@dmc.gov.pk`;

      // Parent User
      const pNum = nextParentNum++;
      const parentEmail = `parent${String(pNum).padStart(2, '0')}.liaquatabad@dmc.gov.pk`;
      const parentPhone = `0321-222${String(pNum).padStart(4, '0')}`;
      const parentCnic = `42101-${String(7000000 + pNum * 311).slice(0, 7)}-${(pNum % 9) + 1}`;
      const houseNumber = 10 + (grNumber % 90);
      const streetNumber = (grNumber % 12) + 1;
      const blockNumber = (grNumber % 10) + 1;
      const address = `House #${houseNumber}, Street ${streetNumber}, Block ${blockNumber}, Liaquatabad, Karachi`;

      const parentUser = await User.findOneAndUpdate(
        { email: parentEmail },
        {
          $set: {
            organizationId: school.organizationId,
            townId: school.townId,
            schoolId: school._id,
            fullName: fatherFullName,
            email: parentEmail,
            passwordHash: commonPasswordHash,
            phoneNumber: parentPhone,
            designation: 'Parent / Guardian',
            baseRole: BASE_ROLES.PARENT,
            role: ROLES.PARENT,
            scope: SCOPES.SELF,
            status: USER_STATUS.ACTIVE,
            tokenVersion: 0,
          },
        },
        { upsert: true, new: true }
      );
      totalNewParentsAdded++;

      const studentUser = await User.findOneAndUpdate(
        { email: studentEmail },
        {
          $set: {
            organizationId: school.organizationId,
            townId: school.townId,
            schoolId: school._id,
            fullName: studentFullName,
            email: studentEmail,
            passwordHash: commonPasswordHash,
            phoneNumber: parentPhone,
            designation: 'Student',
            baseRole: BASE_ROLES.STUDENT,
            role: ROLES.STUDENT,
            scope: SCOPES.SELF,
            status: USER_STATUS.ACTIVE,
            tokenVersion: 0,
          },
        },
        { upsert: true, new: true }
      );

      const studentProfile = await StudentProfile.findOneAndUpdate(
        { userId: studentUser._id },
        {
          $set: {
            schoolId: school._id,
            classId: c._id,
            sectionId: primarySection ? primarySection._id : undefined,
            rollNumber: String(rollNumberCounter++),
            grNumber,
            admissionRegisterNumber,
            globalStudentId,
            admissionType: 'NEW_ADMISSION',
            studentFullName,
            bFormNumber,
            dateOfBirth,
            dateOfBirthInWords: dateOfBirth.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            gender,
            religion: 'ISLAM',
            placeOfBirth: 'Karachi',
            fatherFullName,
            motherFullName,
            relationshipWithStudent: PARENT_RELATIONSHIP.FATHER,
            guardianCnicNumber: parentCnic,
            parentUserId: parentUser._id,
            permanentResidentialAddress: address,
            residentialAddress: address,
            guardianContactNumber: parentPhone,
            guardianCellNumber: parentPhone,
            guardianEmail: parentEmail,
            admissionClassRequested: c.name,
            mediumOfInstruction: 'ENGLISH',
            admissionDate: new Date(2026, 2, 1),
            lifecycleStatus: STUDENT_STATUS.ACTIVE,
            enrolledBy: hmUser._id,
            enrolledAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      // Verified Parent-Student Link
      await ParentStudentLink.findOneAndUpdate(
        { parentId: parentUser._id, studentProfileId: studentProfile._id },
        {
          $set: {
            schoolId: school._id,
            relationship: PARENT_RELATIONSHIP.FATHER,
            verificationStatus: PARENT_STUDENT_LINK_STATUS.VERIFIED,
            contactOtpVerified: true,
            contactVerifiedAt: new Date(),
            verifiedBy: hmUser._id,
            verifiedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      totalNewStudentsAdded++;
    }

    const updatedStudents = await StudentProfile.find({ classId: c._id }).lean();
    const updatedM = updatedStudents.filter((s) => s.gender === 'MALE').length;
    const updatedF = updatedStudents.filter((s) => s.gender === 'FEMALE').length;
    console.log(`   ✔ Class ${c.name} is now complete: ${updatedStudents.length} Students (${updatedM} Boys, ${updatedF} Girls).`);
  }

  // Update school GR numbers sequence
  await School.findByIdAndUpdate(school._id, {
    $set: {
      lastGrNumber: currentGr,
      lastGlobalSequence: currentSeq,
    },
  });

  console.log('\n==============================================================================');
  console.log('🎉 BABA-E-URDU ENROLLMENT & FACULTY SEED COMPLETED!');
  console.log('==============================================================================');
  console.log(` • New Teachers Added: ${targetNewTeacherCount} (Total Faculty in School: ${finalTeacherCount})`);
  console.log(` • New Students Added: ${totalNewStudentsAdded}`);
  console.log(` • New Parents Created:${totalNewParentsAdded}`);
  console.log(` • Updated lastGrNumber: ${currentGr}`);
  console.log(` • Total Baba-e-Urdu Students: ${await StudentProfile.countDocuments({ schoolId: school._id })}`);
  console.log(` • All 8 Classes now have exactly 18 students (9 Boys, 9 Girls each).`);
  console.log(` • Verified ParentStudentLinks in DB: ${await ParentStudentLink.countDocuments({ schoolId: school._id })}`);
  console.log('==============================================================================\n');

  await mongoose.disconnect();
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('seed_baba_e_urdu_students_and_teachers.js')) {
  seedBabaEUrdu()
    .then(() => {
      console.log('✅ Seed script finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Seeding failed:', err);
      process.exit(1);
    });
}
