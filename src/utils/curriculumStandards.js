import Class from '../models/Class.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';

/**
 * Standard DMC Liaquatabad Town Centre & Sindh Education Board Curriculum Standards
 *
 * Grade-wise Curriculum Matrix Rules:
 * - English (ENG), Urdu (URD), Mathematics (MATH): Classes 1 to 10
 * - General Knowledge (GK): Classes 1 to 3 (Integrated Science, Social Studies & Ethics)
 * - Islamiat (ISL): Classes 3 to 9 (Separate starting in Class 3)
 * - Pakistan Studies (PST): Class 10 (Compulsory in Matric)
 * - General Science (SCI): Classes 4 to 8 (Separated from GK in Class 4)
 * - Social Studies (SST): Classes 4 to 8
 * - Sindhi (SND): Classes 4 to 10
 * - Drawing & Art (ART): Classes 4 to 8
 * - Computer Studies (CS): Classes 6 to 8 (Middle level)
 * - Home Economics (HEC): Classes 6 to 8 (Middle elective)
 * - Physics (PHY): Classes 9 & 10 (Secondary Science)
 * - Chemistry (CHEM): Classes 9 & 10 (Secondary Science)
 * - Biology (BIO): Classes 9 & 10 (Secondary Science Elective)
 * - Computer Science (CS-SEC): Classes 9 & 10 (Secondary Science/Tech Elective)
 */
export const STANDARD_CURRICULUM_SUBJECTS = [
  {
    name: 'English',
    code: 'ENG',
    gradeLevels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Urdu',
    code: 'URD',
    gradeLevels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Mathematics',
    code: 'MATH',
    gradeLevels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'General Knowledge',
    code: 'GK',
    gradeLevels: [1, 2, 3],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Islamiat',
    code: 'ISL',
    gradeLevels: [3, 4, 5, 6, 7, 8, 9],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Pakistan Studies',
    code: 'PST',
    gradeLevels: [10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'General Science',
    code: 'SCI',
    gradeLevels: [4, 5, 6, 7, 8],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Social Studies',
    code: 'SST',
    gradeLevels: [4, 5, 6, 7, 8],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Sindhi',
    code: 'SND',
    gradeLevels: [4, 5, 6, 7, 8, 9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Drawing & Art',
    code: 'ART',
    gradeLevels: [4, 5, 6, 7, 8],
    totalMarks: 50,
    passingMarks: 17,
    isElective: true,
  },
  {
    name: 'Computer Studies',
    code: 'CS',
    gradeLevels: [6, 7, 8],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Home Economics',
    code: 'HEC',
    gradeLevels: [6, 7, 8],
    totalMarks: 50,
    passingMarks: 17,
    isElective: true,
  },
  {
    name: 'Physics',
    code: 'PHY',
    gradeLevels: [9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Chemistry',
    code: 'CHEM',
    gradeLevels: [9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: false,
  },
  {
    name: 'Biology',
    code: 'BIO',
    gradeLevels: [9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: true,
  },
  {
    name: 'Computer Science',
    code: 'CS-SEC',
    gradeLevels: [9, 10],
    totalMarks: 100,
    passingMarks: 33,
    isElective: true,
  },
];

/**
 * Returns the list of standard curriculum subjects that apply to a specific grade.
 * @param {number} numericGrade - e.g. 1, 3, 5, 9, 10
 */
export const getSubjectsForGrade = (numericGrade) => {
  const grade = Number(numericGrade);
  return STANDARD_CURRICULUM_SUBJECTS.filter((sub) => sub.gradeLevels.includes(grade));
};

/**
 * Automatically provisions classes and standard curriculum subjects for a school based on its grade range.
 * @param {string|ObjectId} schoolId - School MongoDB ObjectId
 * @param {number} lowestGrade - Lowest class (default 1)
 * @param {number} highestGrade - Highest class (default 5 for Primary, 8 for Middle, 10 for Secondary)
 */
export const provisionSchoolClassesAndCurriculum = async (schoolId, lowestGrade = 1, highestGrade = 5) => {
  const minGrade = Math.max(1, Number(lowestGrade) || 1);
  const maxGrade = Math.min(12, Math.max(minGrade, Number(highestGrade) || 5));

  // 1. Provision Classes for the Grade Range (e.g. Class 1 to Class 5)
  const createdClasses = [];
  for (let grade = minGrade; grade <= maxGrade; grade++) {
    let existingClass = await Class.findOne({ schoolId, numericGrade: grade });
    if (!existingClass) {
      existingClass = await Class.create({
        schoolId,
        name: `Class ${grade}`,
        code: `CL-${grade}`,
        numericGrade: grade,
        status: 'ACTIVE',
      });
    }
    createdClasses.push(existingClass);

    // In DMC Liaquatabad government schools, there are NO multiple sections (A/B/C).
    // Ensure exactly one primary section exists per class for database foreign keys.
    const existingSection = await Section.findOne({ classId: existingClass._id, schoolId });
    if (!existingSection) {
      await Section.create({
        schoolId,
        classId: existingClass._id,
        name: 'General',
        capacity: 50,
        status: 'ACTIVE',
      });
    }
  }

  // 2. Provision Standard Subjects with Grade Levels matching this school's range
  const schoolGrades = [];
  for (let g = minGrade; g <= maxGrade; g++) schoolGrades.push(g);

  const relevantSubjects = STANDARD_CURRICULUM_SUBJECTS.filter((sub) =>
    sub.gradeLevels.some((grade) => schoolGrades.includes(grade))
  );

  const createdSubjects = [];
  for (const subjectDef of relevantSubjects) {
    // Subject code is clean standard code e.g. 'ENG', 'MATH', 'GK'
    let subjectDoc = await Subject.findOne({ schoolId, name: subjectDef.name });
    if (!subjectDoc) {
      subjectDoc = await Subject.create({
        schoolId,
        name: subjectDef.name,
        code: subjectDef.code,
        gradeLevels: subjectDef.gradeLevels,
        totalMarks: subjectDef.totalMarks,
        passingMarks: subjectDef.passingMarks,
        isElective: subjectDef.isElective,
        status: 'ACTIVE',
      });
      createdSubjects.push(subjectDoc);
    } else {
      // Update gradeLevels and clean code if missing
      subjectDoc.gradeLevels = subjectDef.gradeLevels;
      if (!subjectDoc.code || subjectDoc.code.includes('-')) {
        subjectDoc.code = subjectDef.code;
      }
      await subjectDoc.save();
      createdSubjects.push(subjectDoc);
    }
  }

  return {
    classes: createdClasses,
    subjects: createdSubjects,
    gradeRange: { lowestGrade: minGrade, highestGrade: maxGrade },
  };
};
