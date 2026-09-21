/**
 * 🧪 VISUAL & BOUNDARY TEST: DMC OFFICIAL MARKSHEET & LEGAL TABULATION SHEET
 * Education Department Liaquatabad Town Centre (DMC) / Karachi Central
 *
 * Tests rendering of:
 * 1. Realistic long names, father names, school names
 * 2. Failing marks (red font check)
 * 3. Absentees and incomplete subjects
 * 4. Multi-page Legal Landscape Tabulation Sheet
 * 5. Rank calculation edge cases
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateStudentMarksheetPdf,
  generateTabulationSheetPdf,
} from '../src/utils/marksheetPdfGenerator.js';
import {
  computeStudentResultMetrics,
  computeClassTabulation,
} from '../src/utils/examCalculations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.resolve(__dirname, '../../docs/audit_artifacts');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('Rendering visual verification PDF artifacts...\n');

// ─── 1. Generate Marksheet with Extreme Long Names ────────────────────────────
const longNameStudent = {
  fullName: 'SYED MUHAMMAD ABDULLAH KASHIF AL-HUSSAINI QURESHI',
};

const longNameProfile = {
  studentFullName: 'SYED MUHAMMAD ABDULLAH KASHIF AL-HUSSAINI QURESHI',
  fatherFullName: 'HAFIZ MUHAMMAD KASHIF NASEEM-UD-DIN SIDDIQUI',
  grNumber: 'GR-2024-415-KHI',
};

const longNameSchool = {
  name: "BABA-E-URDU MOLVI ABDUL HAQ BOYS' ENGLISH MEDIUM GOVERNMENT ELEMENTARY SCHOOL L.T 11E LIAQUATABAD KARACHI",
};

const marksheetDoc = generateStudentMarksheetPdf({
  exam: { title: 'CENTRALIZED ANNUAL EXAMINATION', academicYear: '2023 - 2024' },
  result: {
    totalObtainedMarks: 376,
    totalMaxMarks: 700,
    percentage: 53.7,
    grade: 'C',
    resultStatus: 'PASSED',
    rankFormatted: '3rd',
    subjectMarks: [
      { subjectName: 'ISLAMIAT', obtainedMarks: 52, subComponents: { nazra: 12, written: 40 }, maxMarks: 100 },
      { subjectName: 'ENGLISH', obtainedMarks: 57, maxMarks: 100 },
      { subjectName: 'MATHEMATICS', obtainedMarks: 49, maxMarks: 100 },
      { subjectName: 'URDU', obtainedMarks: 55, maxMarks: 100 },
      { subjectName: 'SINDHI', obtainedMarks: 55, maxMarks: 100 },
      { subjectName: 'SCIENCE', obtainedMarks: 48, maxMarks: 100 },
      { subjectName: 'SOCIAL STUDIES', obtainedMarks: 60, maxMarks: 100 },
      { subjectName: 'DRAWING', isGradedOnly: true, letterGrade: 'A' },
    ],
  },
  student: longNameStudent,
  studentProfile: longNameProfile,
  school: longNameSchool,
  classDoc: { name: 'IV' },
  sectionDoc: { name: 'A' },
  issuanceDate: new Date('2024-04-15'),
});

const marksheetPath = path.join(outputDir, 'sample_marksheet_a4_visual_test.pdf');
const marksheetStream = fs.createWriteStream(marksheetPath);
marksheetDoc.pipe(marksheetStream);
marksheetDoc.end();

// ─── 2. Generate Legal Landscape Tabulation Sheet with 35 Students (Multi-page) ───
const sampleStudents = [];
const firstNames = ['USMAN', 'ALI ALEEM', 'ABDUL REHMAN', 'ABDUL BASIT', 'ABUBAKAR', 'ABDULLAH', 'MUHAMMAD IMRAN', 'MUHAMMAD MUSTAFA', 'QASIM', 'MUHAMMAD HAMZA', 'MUHAMMAD SHEHARYAR', 'MUHAMMAD RAZA', 'ABDUL RAHEEM', 'ABDUL HASEEB', 'BILAL', 'HAMZA', 'ZAIN', 'FARHAN', 'TARIQ', 'KAMRAN'];
const fatherNames = ['NASEEB-UD-DIN', 'NOOR-UD-DIN', 'MUHAMMAD ZAHID', 'MUHAMMAD SAJID', 'ASIF', 'KASHIF', 'YAQOOB', 'JIBRAN', 'MUHAMMAD YAQOOB', 'ZULFIQAR', 'SHABBIR AHMED', 'MUHAMMAD AHMED KAMAL', 'BABAR ALI', 'ANWAR', 'SHAHID', 'MAQSOOD', 'KHALID', 'RASHEED', 'IQBAL', 'SALEEM'];

for (let i = 1; i <= 35; i++) {
  const fn = firstNames[(i - 1) % firstNames.length];
  const ln = fatherNames[(i - 1) % fatherNames.length];
  const isAbsent = i === 15 || i === 30;
  const isFail = i === 1 || i === 5 || i === 8 || i === 14;

  let subjects = [];
  if (!isAbsent) {
    const baseMark = isFail ? 15 : 45 + ((i * 7) % 45);
    subjects = [
      { subjectName: 'ISLAMIAT', obtainedMarks: isFail ? 7 : Math.min(95, baseMark + 5), subComponents: { nazra: isFail ? 3 : 15, written: isFail ? 4 : Math.min(80, baseMark - 10) }, maxMarks: 100 },
      { subjectName: 'S.St', obtainedMarks: isFail ? 8 : Math.min(95, baseMark), maxMarks: 100 },
      { subjectName: 'SINDHI', obtainedMarks: isFail ? 21 : Math.min(95, baseMark + 2), maxMarks: 100 },
      { subjectName: 'ENGLISH', obtainedMarks: isFail ? 7 : Math.min(95, baseMark - 2), maxMarks: 100 },
      { subjectName: 'SCIENCE', obtainedMarks: isFail ? 13 : Math.min(95, baseMark + 1), maxMarks: 100 },
      { subjectName: 'MATH', obtainedMarks: isFail ? 15 : Math.min(95, baseMark + 6), maxMarks: 100 },
      { subjectName: 'URDU', obtainedMarks: isFail ? 6 : Math.min(95, baseMark - 1), maxMarks: 100 },
      { subjectName: 'DRAWING', isGradedOnly: true, letterGrade: isFail ? 'C' : (i % 2 === 0 ? 'A' : 'B') },
    ];
  }

  sampleStudents.push({
    studentId: `STU_${i}`,
    studentProfile: {
      studentFullName: `${fn} ${i > 20 ? 'JR' : ''}`,
      fatherFullName: ln,
      grNumber: String(200 + i),
    },
    subjectMarks: subjects,
  });
}

const { rankedResults, classStatistics } = computeClassTabulation(sampleStudents);

const tabulationDoc = generateTabulationSheetPdf({
  exam: { title: 'CENTRALIZED ANNUAL EXAMINATION', academicYear: '2023 - 2024' },
  rankedResults,
  classStatistics,
  school: longNameSchool,
  classDoc: { name: 'IV' },
  sectionDoc: { name: 'A' },
});

const tabulationPath = path.join(outputDir, 'sample_tabulation_legal_landscape_visual_test.pdf');
const tabulationStream = fs.createWriteStream(tabulationPath);
tabulationDoc.pipe(tabulationStream);
tabulationDoc.end();

marksheetStream.on('finish', () => {
  console.log(`✅ Marksheet generated: ${marksheetPath} (${fs.statSync(marksheetPath).size} bytes)`);
});

tabulationStream.on('finish', () => {
  console.log(`✅ Legal Tabulation Sheet generated: ${tabulationPath} (${fs.statSync(tabulationPath).size} bytes)`);
  console.log('\nVisual generation test completed successfully.');
});
