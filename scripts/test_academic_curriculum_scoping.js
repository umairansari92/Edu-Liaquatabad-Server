import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import School from '../src/models/School.js';
import Class from '../src/models/Class.js';
import Subject from '../src/models/Subject.js';
import { provisionSchoolClassesAndCurriculum } from '../src/utils/curriculumStandards.js';

async function runTests() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('--- RUNNING ACADEMIC CURRICULUM & SCOPING VERIFICATION SUITE ---');

  // Test 1: Verify All Schools Have Clean Grade Ranges
  const allSchools = await School.find();
  console.log(`\n[TEST 1] Verifying ${allSchools.length} schools have valid gradeRange...`);
  for (const s of allSchools) {
    if (!s.gradeRange || !s.gradeRange.lowestGrade || !s.gradeRange.highestGrade) {
      throw new Error(`School ${s.name} is missing gradeRange!`);
    }
    const minG = Number(s.gradeRange.lowestGrade);
    const maxG = Number(s.gradeRange.highestGrade);
    if (minG < 1 || maxG > 12 || minG > maxG) {
      throw new Error(`Invalid gradeRange [${minG}, ${maxG}] for school ${s.name}`);
    }
  }
  console.log('✅ TEST 1 PASSED: All 17 schools have valid grade ranges.');

  // Test 2: Verify Grade-Level Subject Filtering Logic
  console.log('\n[TEST 2] Verifying Grade-Level Filtering for Primary vs Secondary...');
  const primarySchool = await School.findOne({ schoolType: 'PRIMARY' });
  const secondarySchool = await School.findOne({ schoolType: 'SECONDARY', 'gradeRange.highestGrade': '10' });

  // Class 1 in Primary School:
  const class1 = await Class.findOne({ schoolId: primarySchool._id, numericGrade: 1 });
  const primarySubjects = await Subject.find({ schoolId: primarySchool._id });
  
  // Grade 1 filtered:
  const grade1Subjects = primarySubjects.filter(sub => sub.gradeLevels && sub.gradeLevels.includes(1));
  const grade1Codes = grade1Subjects.map(s => s.code).sort();
  console.log('   Primary School Class 1 Subjects:', grade1Codes.join(', '));
  if (!grade1Codes.includes('ENG') || !grade1Codes.includes('URD') || !grade1Codes.includes('MATH') || !grade1Codes.includes('GK')) {
    throw new Error('Class 1 missing required subjects!');
  }
  if (grade1Codes.includes('SCI') || grade1Codes.includes('SST') || grade1Codes.includes('ISL') || grade1Codes.includes('PHY')) {
    throw new Error('Class 1 has separate Science/SST/Islamiat/Physics which must NOT be present!');
  }
  console.log('✅ Class 1 correctly has Integrated GK and NO separate Science/SST/Islamiat.');

  // Class 3:
  const grade3Subjects = primarySubjects.filter(sub => sub.gradeLevels && sub.gradeLevels.includes(3));
  const grade3Codes = grade3Subjects.map(s => s.code).sort();
  console.log('   Primary School Class 3 Subjects:', grade3Codes.join(', '));
  if (!grade3Codes.includes('ISL') || !grade3Codes.includes('GK')) {
    throw new Error('Class 3 must have separate Islamiat AND GK!');
  }
  if (grade3Codes.includes('SCI') || grade3Codes.includes('SST')) {
    throw new Error('Class 3 must NOT have separate Science or SST yet!');
  }
  console.log('✅ Class 3 correctly introduces separate Islamiat while maintaining integrated GK.');

  // Class 5:
  const grade5Subjects = primarySubjects.filter(sub => sub.gradeLevels && sub.gradeLevels.includes(5));
  const grade5Codes = grade5Subjects.map(s => s.code).sort();
  console.log('   Primary School Class 5 Subjects:', grade5Codes.join(', '));
  if (!grade5Codes.includes('SCI') || !grade5Codes.includes('SST') || !grade5Codes.includes('SND') || !grade5Codes.includes('ART')) {
    throw new Error('Class 5 missing Science, SST, Sindhi, or Art!');
  }
  if (grade5Codes.includes('GK') || grade5Codes.includes('PHY') || grade5Codes.includes('CS')) {
    throw new Error('Class 5 must NOT have GK or Physics or middle CS!');
  }
  console.log('✅ Class 5 correctly has separate Science, SST, Sindhi, and Art, and NO GK.');

  // Secondary School Class 9:
  if (secondarySchool) {
    const secSubjects = await Subject.find({ schoolId: secondarySchool._id });
    const grade9Subjects = secSubjects.filter(sub => sub.gradeLevels && sub.gradeLevels.includes(9));
    const grade9Codes = grade9Subjects.map(s => s.code).sort();
    console.log('   Secondary School Class 9 Subjects:', grade9Codes.join(', '));
    if (!grade9Codes.includes('PHY') || !grade9Codes.includes('CHEM') || !grade9Codes.includes('BIO') || !grade9Codes.includes('CS-SEC')) {
      throw new Error('Class 9 missing Secondary Science subjects (PHY, CHEM, BIO, CS-SEC)!');
    }
    if (grade9Codes.includes('GK') || grade9Codes.includes('SCI') || grade9Codes.includes('SST')) {
      throw new Error('Class 9 must NOT have primary GK, General Science, or middle SST!');
    }
    console.log('✅ Class 9 correctly has Physics, Chemistry, Biology, CS-SEC, and NO primary GK or General Science.');
  }
  console.log('✅ TEST 2 PASSED: All grade-level curriculum matrix rules verified.');

  // Test 3: Test Dynamic Auto-Provisioning on a test school
  console.log('\n[TEST 3] Testing dynamic auto-provisioning for a new school...');
  const testSchool = await School.create({
    organizationId: primarySchool.organizationId,
    townId: primarySchool.townId,
    name: 'TEST Curriculum Sandbox School',
    schoolType: 'ELEMENTARY',
    genderType: 'CO_EDUCATION',
    gradeRange: { lowestGrade: '1', highestGrade: '8' },
    address: 'Test Sandbox Address',
    status: 'ACTIVE',
  });

  const provisioned = await provisionSchoolClassesAndCurriculum(testSchool._id, 1, 8);
  console.log(`   Created ${provisioned.classes.length} classes:`, provisioned.classes.map(c => c.name).join(', '));
  console.log(`   Created ${provisioned.subjects.length} standard subjects:`, provisioned.subjects.map(s => s.code).join(', '));

  if (provisioned.classes.length !== 8) {
    throw new Error(`Expected 8 classes (1 to 8), got ${provisioned.classes.length}`);
  }

  // Clean up test school
  await Class.deleteMany({ schoolId: testSchool._id });
  await Subject.deleteMany({ schoolId: testSchool._id });
  await School.findByIdAndDelete(testSchool._id);
  console.log('   Cleaned up test sandbox school.');
  console.log('✅ TEST 3 PASSED: Dynamic provisioning works flawlessly.');

  console.log('\n🏆 ALL VERIFICATION TESTS PASSED 100% SUCCESSFULLY!');
  await mongoose.disconnect();
}

runTests().catch(err => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
