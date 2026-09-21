/**
 * 📊 EXAM CALCULATIONS & TABULATION ENGINE
 * Education Department, Liaquatabad Town Centre (DMC) / Karachi Central
 *
 * Implements authoritative Elementary Board examination formulas (Grades IV to VIII):
 * 1. Islamiat split: Nazra (max 20) + Written (max 80) = Total (max 100)
 * 2. Standard 100-mark subjects: S.St, Sindhi, English, Science, Mathematics, Urdu
 * 3. Graded subject: Drawing evaluated by Letter Grade (A, B, C, D) without numeric marks
 * 4. Total Maximum Numeric Marks: 700
 * 5. Percentage: (Grand Total / 700) * 100
 * 6. Passing Rule: Minimum 33% in each numeric subject & overall >= 33%
 * 7. Sindh Board Grading: A-1 (>=80%), A (>=70%), B (>=60%), C (>=50%), D (>=40%), E (>=33%), FAIL (<33%)
 * 8. Class / Section Ranking: 1st, 2nd, 3rd, 4th... assigned to passed students by percentage descending
 */

/**
 * Official Grade Thresholds — Source of Truth:
 * DMC Liaquatabad Town Centre Elementary Board Tabulation Specification (Image 2 Artifact):
 * A-1 (>=80%), A (>=70%), B (>=60%), C (>=50%), D (>=40%), E (>=33%), FAIL (<33% or failed subject)
 */
export const ELEMENTARY_BOARD_GRADE_THRESHOLDS = Object.freeze([
  { grade: 'A-1', minPercentage: 80, label: 'Outstanding / Exceptional' },
  { grade: 'A',   minPercentage: 70, label: 'Excellent' },
  { grade: 'B',   minPercentage: 60, label: 'Very Good' },
  { grade: 'C',   minPercentage: 50, label: 'Good' },
  { grade: 'D',   minPercentage: 40, label: 'Fair' },
  { grade: 'E',   minPercentage: 33, label: 'Pass' },
  { grade: 'FAIL', minPercentage: 0, label: 'Needs Improvement / Fail' },
]);

// Backward-compatibility alias
export const SINDH_BOARD_GRADE_THRESHOLDS = ELEMENTARY_BOARD_GRADE_THRESHOLDS;

/**
 * Determine letter grade according to DMC Elementary Board examination formula
 * @param {number} percentage
 * @param {boolean} isOverallPassed
 * @returns {string}
 */
export function determineElementaryBoardGrade(percentage, isOverallPassed = true) {
  if (!isOverallPassed || percentage < 33) {
    return 'FAIL';
  }
  for (const tier of ELEMENTARY_BOARD_GRADE_THRESHOLDS) {
    if (tier.grade === 'FAIL') continue;
    if (percentage >= tier.minPercentage) {
      return tier.grade;
    }
  }
  return 'E';
}

// Backward-compatibility alias
export const determineSindhBoardGrade = determineElementaryBoardGrade;

/**
 * Format rank integer to human-readable string (e.g. 1 -> '1st', 2 -> '2nd', 3 -> '3rd')
 * @param {number} rankNumber
 * @returns {string}
 */
export function formatRankDisplay(rankNumber) {
  if (!rankNumber || rankNumber <= 0) return '-';
  const lastDigit = rankNumber % 10;
  const lastTwoDigits = rankNumber % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return `${rankNumber}th`;
  }
  if (lastDigit === 1) return `${rankNumber}st`;
  if (lastDigit === 2) return `${rankNumber}nd`;
  if (lastDigit === 3) return `${rankNumber}rd`;
  return `${rankNumber}th`;
}

/**
 * Compute student exam result metrics from raw subject marks
 * @param {Array} rawSubjectMarks
 * @returns {Object}
 */
export function computeStudentResultMetrics(rawSubjectMarks = []) {
  let grandTotalObtained = 0;
  let grandTotalMaxMarks = 0;
  let hasFailedSubject = false;
  const processedSubjectMarks = [];

  for (const subject of rawSubjectMarks) {
    const isDrawing = (subject.subjectName || '').toUpperCase().includes('DRAWING') || subject.isGradedOnly;

    if (isDrawing) {
      const letterGrade = subject.letterGrade || (subject.obtainedMarks >= 70 ? 'A' : subject.obtainedMarks >= 50 ? 'B' : 'C');
      processedSubjectMarks.push({
        subjectId:     subject.subjectId,
        subjectName:   subject.subjectName || 'DRAWING',
        isGradedOnly:  true,
        letterGrade,
        obtainedMarks: 0,
        maxMarks:      0,
        isPassed:      letterGrade !== 'FAIL' && letterGrade !== 'F',
      });
      continue;
    }

    // Check for Islamiat Nazra + Written subcomponents
    const hasSubComponents = subject.subComponents && (subject.subComponents.nazra !== undefined || subject.subComponents.written !== undefined);
    let obtainedMarks = 0;
    let maxMarks = Number(subject.maxMarks) || 100;

    if (hasSubComponents) {
      const nazraMarks = Number(subject.subComponents?.nazra) || 0;
      const writtenMarks = Number(subject.subComponents?.written) || 0;
      obtainedMarks = nazraMarks + writtenMarks;
      maxMarks = 100; // 20 + 80
    } else {
      obtainedMarks = Number(subject.obtainedMarks) || 0;
    }

    const passingThreshold = maxMarks * 0.33;
    const isPassed = obtainedMarks >= passingThreshold;
    if (!isPassed) {
      hasFailedSubject = true;
    }

    grandTotalObtained += obtainedMarks;
    grandTotalMaxMarks += maxMarks;

    processedSubjectMarks.push({
      subjectId:     subject.subjectId,
      subjectName:   subject.subjectName || 'Subject',
      isGradedOnly:  false,
      obtainedMarks,
      maxMarks,
      subComponents: hasSubComponents ? {
        nazra:   Number(subject.subComponents?.nazra) || 0,
        written: Number(subject.subComponents?.written) || 0,
      } : undefined,
      isPassed,
    });
  }

  // Handle absent / empty marks
  const isAbsent = rawSubjectMarks.length === 0;
  const effectiveMaxMarks = grandTotalMaxMarks > 0 ? grandTotalMaxMarks : (isAbsent ? 0 : 700);
  const percentage = effectiveMaxMarks > 0 ? Number(((grandTotalObtained / effectiveMaxMarks) * 100).toFixed(1)) : 0;
  const isOverallPassed = !isAbsent && !hasFailedSubject && percentage >= 33;
  const grade = isAbsent ? 'FAIL' : determineSindhBoardGrade(percentage, isOverallPassed);
  const resultStatus = isAbsent ? 'ABSENT' : (isOverallPassed ? 'PASSED' : 'FAILED');

  return {
    subjectMarks:       processedSubjectMarks,
    totalObtainedMarks: grandTotalObtained,
    totalMaxMarks:      effectiveMaxMarks,
    percentage,
    grade,
    resultStatus,
    isOverallPassed,
  };
}

/**
 * Process and rank a full class tabulation roster
 * Auto-calculates class ranking and class statistical summary
 * @param {Array} rawResultsList - array of student results with studentProfile / user populated
 * @returns {Object} { rankedResults, classStatistics }
 */
export function computeClassTabulation(rawResultsList = []) {
  const processedResults = rawResultsList.map((entry) => {
    const metrics = computeStudentResultMetrics(entry.subjectMarks || []);
    return {
      ...entry,
      ...metrics,
      rawStudentId: String(entry.studentId?._id || entry.studentId || ''),
    };
  });

  // Rank passed students by percentage descending (then grandTotalObtained descending)
  const passedStudents = processedResults
    .filter((item) => item.isOverallPassed)
    .sort((a, b) => b.percentage - a.percentage || b.totalObtainedMarks - a.totalObtainedMarks);

  // Assign dense/sequential ranks
  let currentRank = 1;
  for (let index = 0; index < passedStudents.length; index++) {
    if (index > 0) {
      const prev = passedStudents[index - 1];
      const curr = passedStudents[index];
      if (curr.percentage < prev.percentage) {
        currentRank = index + 1;
      }
    }
    passedStudents[index].rank = currentRank;
    passedStudents[index].rankFormatted = formatRankDisplay(currentRank);
  }

  // Map ranks back to full list
  const rankedResults = processedResults.map((item) => {
    if (!item.isOverallPassed) {
      return { ...item, rank: null, rankFormatted: '-' };
    }
    const matchedPassed = passedStudents.find((p) => p.rawStudentId === item.rawStudentId);
    return {
      ...item,
      rank:          matchedPassed ? matchedPassed.rank : null,
      rankFormatted: matchedPassed ? matchedPassed.rankFormatted : '-',
    };
  });

  // Calculate Municipal Statistics Box (matching Image 2 bottom table)
  const totalEnrolled = rankedResults.length;
  const appearedCount = rankedResults.filter((r) => r.resultStatus !== 'ABSENT' && (r.subjectMarks || []).length > 0).length;
  const absenteesCount = totalEnrolled - appearedCount;
  const passedCount = rankedResults.filter((r) => r.isOverallPassed).length;
  const failedCount = appearedCount - passedCount;
  const passingPercentage = appearedCount > 0 ? Number(((passedCount / appearedCount) * 100).toFixed(1)) : 0;

  const classStatistics = {
    totalEnrolled,
    appearedCount,
    absenteesCount,
    passedCount,
    failedCount,
    passingPercentage,
  };

  return {
    rankedResults,
    classStatistics,
  };
}
