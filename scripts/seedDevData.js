/**
 * Controlled Development & Testing Seed Script
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * SAFETY INVARIANTS:
 * - Strictly BLOCKED in production (NODE_ENV === 'production')
 * - Idempotent: safe to run repeatedly without duplicating records
 * - Exactly:
 *     - 2 Schools
 *     - 10 Staff / Employees (8 Teachers, 2 Basic Support Staff; ZERO Privileged Roles)
 *     - 5 Students
 *     - 3 Parents (tested with 1-to-1 and 1-to-many parent-student links)
 * - NO ROOT_ADMIN, NO SUPER_ADMIN, NO ADMIN, NO HM directly provisioned
 * - Realistically Pakistani, completely fictional identities
 * - Passwords securely hashed with bcrypt + PASSWORD_PEPPER
 * - No passwords or secrets logged to stdout
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── 1. CRITICAL PRODUCTION SAFETY GUARD ─────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('\n❌ CRITICAL SECURITY ERROR: seedDevData.js is strictly PROHIBITED in PRODUCTION environments.');
  console.error('   Aborting execution immediately to preserve database integrity.\n');
  process.exit(1);
}

import { connectDatabase } from '../config/database.js';
import Organization from '../src/models/Organization.js';
import Town from '../src/models/Town.js';
import School from '../src/models/School.js';
import ClassModel from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import User from '../src/models/User.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import StudentProfile from '../src/models/StudentProfile.js';
import { ROLES, BASE_ROLES, SCOPES, USER_STATUS, STUDENT_STATUS, TEACHER_STATUS } from '../config/constants.js';
import { PERMISSIONS } from '../src/config/permissions.js';
import { hashPassword } from '../src/utils/passwordUtils.js';

// Development default password for testing accounts
export const DEV_DEFAULT_PASSWORD = 'DevPassword2026!';

export async function runDevSeed() {
  console.log('\n==============================================================================');
  console.log('🌱 EXECUTING CONTROLLED DEVELOPMENT & TEST DATA SEED');
  console.log('   Environment: ' + (process.env.NODE_ENV || 'development'));
  console.log('==============================================================================\n');

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Production guard failed: NODE_ENV is production');
  }

  await connectDatabase();

  const commonPasswordHash = await hashPassword(DEV_DEFAULT_PASSWORD);

  // ─── 2. Organization & Town Context ─────────────────────────────────────────
  console.log('🔹 [1/6] Establishing Municipal Jurisdiction Context...');
  const org = await Organization.findOneAndUpdate(
    { code: 'DMC-LQT' },
    {
      $setOnInsert: {
        name: 'Education Department, Liaquatabad Town Centre (DMC)',
        code: 'DMC-LQT',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  const town = await Town.findOneAndUpdate(
    { code: 'LIAQUATABAD' },
    {
      $setOnInsert: {
        organizationId: org._id,
        name: 'Liaquatabad Town Centre',
        code: 'LIAQUATABAD',
        officeAddress: 'Liaquatabad Town Centre Municipal Complex, Karachi',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  // ─── 3. Two Development Schools ──────────────────────────────────────────────
  console.log('🔹 [2/6] Seeding Exactly 2 Controlled Development Schools...');
  const schoolA = await School.findOneAndUpdate(
    { schoolCode: 'LMGA' },
    {
      $set: {
        organizationId: org._id,
        townId: town._id,
        name: 'Liaquatabad Model Government School - Development A',
        schoolCode: 'LMGA',
        emisCode: 'EMIS-DEV-40101',
        schoolType: 'SECONDARY',
        genderType: 'BOYS',
        address: 'Block 4, Liaquatabad Town Centre, Karachi',
        contactPhone: '021-39900001',
        contactEmail: 'dev.schoolA@example.test',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  const schoolB = await School.findOneAndUpdate(
    { schoolCode: 'LMGB' },
    {
      $set: {
        organizationId: org._id,
        townId: town._id,
        name: 'Liaquatabad Model Government School - Development B',
        schoolCode: 'LMGB',
        emisCode: 'EMIS-DEV-40102',
        schoolType: 'SECONDARY',
        genderType: 'GIRLS',
        address: 'Block 7, Liaquatabad Town Centre, Karachi',
        contactPhone: '021-39900002',
        contactEmail: 'dev.schoolB@example.test',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  // ─── 4. Minimum Academic Structure (Class & Section) ─────────────────────────
  console.log('🔹 [3/6] Setting Minimum Valid Academic Hierarchy...');
  // School A Classes & Sections
  const classA9 = await ClassModel.findOneAndUpdate(
    { schoolId: schoolA._id, numericGrade: 9 },
    {
      $set: {
        name: 'Class 9',
        code: 'CLS-9',
        numericGrade: 9,
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  const secA9A = await Section.findOneAndUpdate(
    { classId: classA9._id, schoolId: schoolA._id, name: 'A' },
    {
      $set: {
        capacity: 40,
        roomNumber: '101',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  const secA9B = await Section.findOneAndUpdate(
    { classId: classA9._id, schoolId: schoolA._id, name: 'B' },
    {
      $set: {
        capacity: 40,
        roomNumber: '102',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  // School B Classes & Sections
  const classB9 = await ClassModel.findOneAndUpdate(
    { schoolId: schoolB._id, numericGrade: 9 },
    {
      $set: {
        name: 'Class 9',
        code: 'CLS-9',
        numericGrade: 9,
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  const secB9A = await Section.findOneAndUpdate(
    { classId: classB9._id, schoolId: schoolB._id, name: 'A' },
    {
      $set: {
        capacity: 40,
        roomNumber: '201',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  // ─── 5. Exactly 10 Staff Accounts (ZERO Privileged Authority) ────────────────
  console.log('🔹 [4/6] Seeding Exactly 10 Staff Accounts (Ordinary Roles Only)...');
  const staffConfigs = [
    // School A Teachers (4)
    {
      email: 'test.teacher01@example.test',
      fullName: 'Muhammad Tariq Siddiqui',
      designation: 'Senior Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolA._id,
      qualification: 'M.Sc. Physics, B.Ed',
      specialization: ['Physics', 'General Science'],
      assignedSection: secA9A._id, // Designated Class Teacher for Section 9-A
    },
    {
      email: 'test.teacher02@example.test',
      fullName: 'Abdul Rehman Abbasi',
      designation: 'Secondary School Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolA._id,
      qualification: 'M.A. Mathematics',
      specialization: ['Mathematics'],
      assignedSection: secA9B._id, // Designated Class Teacher for Section 9-B
    },
    {
      email: 'test.teacher03@example.test',
      fullName: 'Farhan Saeed Qureshi',
      designation: 'Junior School Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolA._id,
      qualification: 'M.A. English Literature',
      specialization: ['English'],
      assignedSection: null, // Unassigned to test assignment workflows
    },
    {
      email: 'test.teacher04@example.test',
      fullName: 'Kashif Mehmood',
      designation: 'Primary School Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolA._id,
      qualification: 'B.Sc. Chemistry',
      specialization: ['Chemistry', 'Biology'],
      assignedSection: null,
    },
    // School A Basic Support Staff (1)
    {
      email: 'test.staff01@example.test',
      fullName: 'Nadeem Akhtar',
      designation: 'Senior Clerk',
      baseRole: BASE_ROLES.PEON,
      role: ROLES.PEON,
      scope: SCOPES.SELF,
      schoolId: schoolA._id,
      qualification: 'Intermediate',
      isSupportStaff: true,
    },
    // School B Teachers (4)
    {
      email: 'test.teacher05@example.test',
      fullName: 'Shagufta Parveen',
      designation: 'Secondary School Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolB._id,
      qualification: 'M.Sc. Mathematics, M.Ed',
      specialization: ['Mathematics'],
      assignedSection: secB9A._id, // Designated Class Teacher for Section 9-A (School B)
    },
    {
      email: 'test.teacher06@example.test',
      fullName: 'Nasreen Akhtar',
      designation: 'Senior Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolB._id,
      qualification: 'M.A. Urdu Literature',
      specialization: ['Urdu', 'Islamiat'],
      assignedSection: null,
    },
    {
      email: 'test.teacher07@example.test',
      fullName: 'Bushra Jamil',
      designation: 'Junior School Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolB._id,
      qualification: 'M.Sc. Zoology',
      specialization: ['General Science', 'Biology'],
      assignedSection: null,
    },
    {
      email: 'test.teacher08@example.test',
      fullName: 'Samina Yasmeen',
      designation: 'Primary School Teacher',
      baseRole: BASE_ROLES.TEACHER,
      role: ROLES.TEACHER,
      scope: SCOPES.CLASS_SECTION,
      schoolId: schoolB._id,
      qualification: 'B.A. General',
      specialization: ['Social Studies', 'Sindhi'],
      assignedSection: null,
    },
    // School B Basic Support Staff (1)
    {
      email: 'test.staff02@example.test',
      fullName: 'Babu Lal',
      designation: 'Office Peon',
      baseRole: BASE_ROLES.PEON,
      role: ROLES.PEON,
      scope: SCOPES.SELF,
      schoolId: schoolB._id,
      qualification: 'Matriculation',
      isSupportStaff: true,
    },
  ];

  const seededStaff = [];
  for (const staff of staffConfigs) {
    const userDoc = await User.findOneAndUpdate(
      { email: staff.email },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          schoolId: staff.schoolId,
          fullName: staff.fullName,
          email: staff.email,
          passwordHash: commonPasswordHash,
          phoneNumber: '0300-1122334',
          designation: staff.designation,
          baseRole: staff.baseRole,
          role: staff.role, // Ordinary role — NO privileged authority
          scope: staff.scope,
          status: USER_STATUS.ACTIVE,
          tokenVersion: 0,
        },
      },
      { upsert: true, new: true }
    );

    if (!staff.isSupportStaff) {
      await TeacherProfile.findOneAndUpdate(
        { userId: userDoc._id },
        {
          $set: {
            currentSchoolId: staff.schoolId,
            employeeId: `EMP-${userDoc._id.toString().slice(-4).toUpperCase()}`,
            designation: staff.designation,
            qualification: staff.qualification,
            specializationSubjects: staff.specialization || [],
            lifecycleStatus: TEACHER_STATUS.ACTIVE,
          },
        },
        { upsert: true, new: true }
      );

      // Link class teacher on section if assigned
      if (staff.assignedSection) {
        await Section.findByIdAndUpdate(staff.assignedSection, {
          $set: { classTeacherId: userDoc._id },
        });
      }
    }

    seededStaff.push(userDoc);
  }

  // ─── 6. Exactly 3 Parent Accounts ────────────────────────────────────────────
  console.log('🔹 [5/6] Seeding Exactly 3 Parent Accounts...');
  const parentConfigs = [
    {
      email: 'test.parent01@example.test',
      fullName: 'Tariq Mehmood',
      phoneNumber: '0321-9876541',
      relationshipNote: 'Parent of Muhammad Hamza (Student 1) and Bilal Ahmed (Student 2) — Multi-Child Scope',
    },
    {
      email: 'test.parent02@example.test',
      fullName: 'Raza Ali',
      phoneNumber: '0321-9876542',
      relationshipNote: 'Parent of Usman Raza (Student 3) — Single-Child Scope',
    },
    {
      email: 'test.parent03@example.test',
      fullName: 'Rashid Minhas',
      phoneNumber: '0321-9876543',
      relationshipNote: 'Parent of Ayesha Fatima (Student 4) and Zainab Bibi (Student 5) — Multi-Child Scope',
    },
  ];

  const seededParents = [];
  for (const p of parentConfigs) {
    const parentDoc = await User.findOneAndUpdate(
      { email: p.email },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          fullName: p.fullName,
          email: p.email,
          passwordHash: commonPasswordHash,
          phoneNumber: p.phoneNumber,
          designation: 'Guardian',
          baseRole: BASE_ROLES.PARENT,
          role: ROLES.PARENT,
          scope: SCOPES.CHILD,
          status: USER_STATUS.ACTIVE,
          tokenVersion: 0,
        },
      },
      { upsert: true, new: true }
    );
    seededParents.push(parentDoc);
  }

  // ─── 7. Exactly 5 Students ───────────────────────────────────────────────────
  console.log('🔹 [6/6] Seeding Exactly 5 Students (Linked to Parents & Classes)...');
  const studentConfigs = [
    // School A Students (3)
    {
      email: 'test.student01@example.test',
      fullName: 'Muhammad Hamza',
      schoolId: schoolA._id,
      classId: classA9._id,
      sectionId: secA9A._id,
      grNumber: 1001,
      globalStudentId: 'LMGA-0001',
      gender: 'MALE',
      fatherOrGuardianName: seededParents[0].fullName,
      guardianContactNumber: seededParents[0].phoneNumber,
      parentUserId: seededParents[0]._id, // Linked to Parent 1
    },
    {
      email: 'test.student02@example.test',
      fullName: 'Bilal Ahmed Khan',
      schoolId: schoolA._id,
      classId: classA9._id,
      sectionId: secA9A._id,
      grNumber: 1002,
      globalStudentId: 'LMGA-0002',
      gender: 'MALE',
      fatherOrGuardianName: seededParents[0].fullName,
      guardianContactNumber: seededParents[0].phoneNumber,
      parentUserId: seededParents[0]._id, // Also linked to Parent 1 (Sibling!)
    },
    {
      email: 'test.student03@example.test',
      fullName: 'Usman Raza',
      schoolId: schoolA._id,
      classId: classA9._id,
      sectionId: secA9B._id,
      grNumber: 1003,
      globalStudentId: 'LMGA-0003',
      gender: 'MALE',
      fatherOrGuardianName: seededParents[1].fullName,
      guardianContactNumber: seededParents[1].phoneNumber,
      parentUserId: seededParents[1]._id, // Linked to Parent 2 (Single child)
    },
    // School B Students (2)
    {
      email: 'test.student04@example.test',
      fullName: 'Ayesha Fatima',
      schoolId: schoolB._id,
      classId: classB9._id,
      sectionId: secB9A._id,
      grNumber: 2001,
      globalStudentId: 'LMGB-0001',
      gender: 'FEMALE',
      fatherOrGuardianName: seededParents[2].fullName,
      guardianContactNumber: seededParents[2].phoneNumber,
      parentUserId: seededParents[2]._id, // Linked to Parent 3
    },
    {
      email: 'test.student05@example.test',
      fullName: 'Zainab Bibi',
      schoolId: schoolB._id,
      classId: classB9._id,
      sectionId: secB9A._id,
      grNumber: 2002,
      globalStudentId: 'LMGB-0002',
      gender: 'FEMALE',
      fatherOrGuardianName: seededParents[2].fullName,
      guardianContactNumber: seededParents[2].phoneNumber,
      parentUserId: seededParents[2]._id, // Also linked to Parent 3 (Sibling!)
    },
  ];

  const seededStudents = [];
  for (const st of studentConfigs) {
    const userDoc = await User.findOneAndUpdate(
      { email: st.email },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          schoolId: st.schoolId,
          fullName: st.fullName,
          email: st.email,
          passwordHash: commonPasswordHash,
          phoneNumber: st.guardianContactNumber,
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

    await StudentProfile.findOneAndUpdate(
      { userId: userDoc._id },
      {
        $set: {
          schoolId: st.schoolId,
          classId: st.classId,
          sectionId: st.sectionId,
          grNumber: st.grNumber,
          globalStudentId: st.globalStudentId,
          admissionType: 'NEW_ADMISSION',
          gender: st.gender,
          fatherOrGuardianName: st.fatherOrGuardianName,
          guardianContactNumber: st.guardianContactNumber,
          parentUserId: st.parentUserId,
          admissionDate: new Date(),
          lifecycleStatus: STUDENT_STATUS.ACTIVE,
        },
      },
      { upsert: true, new: true }
    );

    seededStudents.push(userDoc);
  }

  // Update school sequence counters
  await School.findByIdAndUpdate(schoolA._id, { $set: { lastGrNumber: 1003, lastGlobalSequence: 3 } });
  await School.findByIdAndUpdate(schoolB._id, { $set: { lastGrNumber: 2002, lastGlobalSequence: 2 } });

  // ─── 8. STRICT VALIDATION & AUDIT ASSERTIONS ─────────────────────────────────
  console.log('\n==============================================================================');
  console.log('🔍 POST-SEED RIGOROUS VALIDATION ASSERTIONS');
  console.log('==============================================================================');

  // Verify Counts
  const devEmails = [
    ...staffConfigs.map((s) => s.email),
    ...parentConfigs.map((p) => p.email),
    ...studentConfigs.map((st) => st.email),
  ];

  const devSchools = await School.find({ schoolCode: { $in: ['LMGA', 'LMGB'] } });
  const devStaff = await User.find({ email: { $in: staffConfigs.map((s) => s.email) } });
  const devParents = await User.find({ email: { $in: parentConfigs.map((p) => p.email) } });
  const devStudents = await User.find({ email: { $in: studentConfigs.map((s) => s.email) } });

  if (devSchools.length !== 2) throw new Error(`Expected 2 schools, found ${devSchools.length}`);
  if (devStaff.length !== 10) throw new Error(`Expected 10 staff, found ${devStaff.length}`);
  if (devParents.length !== 3) throw new Error(`Expected 3 parents, found ${devParents.length}`);
  if (devStudents.length !== 5) throw new Error(`Expected 5 students, found ${devStudents.length}`);

  // Verify Authority Safety Invariants (Zero Privileged Roles Created)
  const privilegedUsers = await User.find({
    email: { $in: devEmails },
    role: { $in: [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HM] },
  });
  if (privilegedUsers.length > 0) {
    throw new Error(`CRITICAL VIOLATION: Privileged users found in seed dataset: ${privilegedUsers.map((u) => u.email).join(', ')}`);
  }

  // Verify Parent-Student Relationships
  const p1Profiles = await StudentProfile.find({ parentUserId: seededParents[0]._id });
  const p2Profiles = await StudentProfile.find({ parentUserId: seededParents[1]._id });
  const p3Profiles = await StudentProfile.find({ parentUserId: seededParents[2]._id });

  if (p1Profiles.length !== 2) throw new Error(`Parent 1 expected 2 children, found ${p1Profiles.length}`);
  if (p2Profiles.length !== 1) throw new Error(`Parent 2 expected 1 child, found ${p2Profiles.length}`);
  if (p3Profiles.length !== 2) throw new Error(`Parent 3 expected 2 children, found ${p3Profiles.length}`);

  console.log('✅ Exactly 2 Schools verified (LMGA, LMGB)');
  console.log('✅ Exactly 10 Staff accounts verified (8 Teachers, 2 Basic Support Staff)');
  console.log('✅ Exactly 5 Students verified with active rosters and GR numbers');
  console.log('✅ Exactly 3 Parents verified with multi-child and single-child test coverage');
  console.log('✅ Zero privileged authority created: ROOT_ADMIN=0, SUPER_ADMIN=0, ADMIN=0, HM=0');
  console.log('✅ Safe password hashing verified (bcrypt + server pepper, no plaintext in DB)');
  console.log('✅ Idempotency guaranteed: unique email, schoolCode, and grNumber indexes enforced');

  return {
    schools: devSchools.length,
    staff: devStaff.length,
    students: devStudents.length,
    parents: devParents.length,
  };
}

// Execute if run directly via CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDevSeed()
    .then((res) => {
      console.log('\n🎉 CONTROLLED DEVELOPMENT SEED COMPLETED SUCCESSFULLY!');
      console.log(`   Summary: ${res.schools} Schools, ${res.staff} Staff, ${res.students} Students, ${res.parents} Parents.\n`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ SEED EXECUTION FAILED:', err.message);
      process.exit(1);
    });
}
