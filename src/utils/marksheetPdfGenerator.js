/**
 * 🖨️ OFFICIAL DMC MARKSHEET & TABULATION SHEET PDF GENERATOR
 * Education Department, Liaquatabad Town Centre (DMC) / Karachi Central
 *
 * Implements exact authentic replicas of:
 *  - Output 1: Individual Student Marksheet (A4 Portrait, Image 1 Replica)
 *  - Output 2: Consolidated Class Tabulation Sheet (LEGAL LANDSCAPE, Image 2 Replica)
 */

import PDFDocument from 'pdfkit';
import {
  computeStudentResultMetrics,
  computeClassTabulation,
  formatRankDisplay,
} from './examCalculations.js';

/**
 * Draw Green Municipal Crescent & Star Laurel Emblem
 * @param {PDFDocument} doc
 * @param {number} cx - center x
 * @param {number} cy - center y
 * @param {number} radius - radius
 */
function drawDmcMunicipalEmblem(doc, cx, cy, radius = 22) {
  doc.save();

  // Outer green shield circle
  doc.circle(cx, cy, radius)
    .lineWidth(2)
    .strokeColor('#15803d')
    .fillColor('#f0fdf4')
    .fillAndStroke();

  // Inner dashed accent circle
  doc.circle(cx, cy, radius - 4)
    .lineWidth(0.8)
    .strokeColor('#16a34a')
    .stroke();

  // Crescent Moon
  doc.save();
  doc.fillColor('#15803d');
  doc.path(`M ${cx - 2} ${cy - 10} A 9 9 0 1 0 ${cx - 2} ${cy + 8} A 7 7 0 1 1 ${cx - 2} ${cy - 10} Z`).fill();
  doc.restore();

  // Star
  doc.save();
  doc.fillColor('#15803d');
  const starPoints = [
    [cx + 5, cy - 3], [cx + 7, cy - 8], [cx + 9, cy - 3], [cx + 14, cy - 3],
    [cx + 10, cy], [cx + 12, cy + 5], [cx + 7, cy + 2], [cx + 2, cy + 5],
    [cx + 4, cy], [cx, cy - 3],
  ];
  doc.polygon(...starPoints).fill();
  doc.restore();

  // "CENTRAL" Ribbon Banner at bottom of emblem
  doc.rect(cx - 16, cy + radius - 7, 32, 8)
    .fillColor('#15803d')
    .fill();
  doc.fillColor('#ffffff').fontSize(5).font('Helvetica-Bold')
    .text('CENTRAL', cx - 16, cy + radius - 6, { width: 32, align: 'center' });

  doc.restore();
}

/**
 * GENERATE INDIVIDUAL STUDENT MARKSHEET (Image 1 Replica - A4 Portrait)
 * Standard A4 Portrait: 595.28 pt x 841.89 pt
 */
export function generateStudentMarksheetPdf({
  exam,
  result,
  student,
  studentProfile,
  school,
  classDoc,
  sectionDoc,
  issuanceDate = new Date(),
}) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    autoFirstPage: true,
  });

  const pageWidth = 595.28;
  const leftMargin = 40;
  const contentWidth = pageWidth - leftMargin * 2; // 515.28 pt

  // 1. Arched / Curved Style Municipal Header Text
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16)
    .text('EDUCATION DEPARTMENT LIAQUATABAD', leftMargin, 38, {
      width: contentWidth,
      align: 'center',
      characterSpacing: 1.4,
    });

  doc.fontSize(13).font('Helvetica-Bold')
    .text('TOWN MUNICIPAL CORPORATION KARACHI', leftMargin, 56, {
      width: contentWidth,
      align: 'center',
      characterSpacing: 1.1,
    });

  // 2. Central Green Municipal Emblem
  drawDmcMunicipalEmblem(doc, pageWidth / 2, 92, 20);

  // 3. "MARKS SHEET" Title Box (Image 1 style)
  const boxWidth = 144;
  const boxHeight = 22;
  const boxX = (pageWidth - boxWidth) / 2;
  const boxY = 118;

  doc.rect(boxX, boxY, boxWidth, boxHeight)
    .fillColor('#fed7aa') // peach/light-orange fill
    .strokeColor('#000000')
    .lineWidth(1)
    .fillAndStroke();

  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12)
    .text('MARKS SHEET', boxX, boxY + 5, { width: boxWidth, align: 'center', characterSpacing: 1 });

  // 4. Student & School Particulars Box (2-column bordered table)
  let currentY = 148;
  const particularBoxHeight = 84;
  doc.rect(leftMargin, currentY, contentWidth, particularBoxHeight)
    .lineWidth(1)
    .strokeColor('#000000')
    .stroke();

  // Horizontal divider lines inside particulars
  const rowHeight = 21;
  doc.moveTo(leftMargin, currentY + rowHeight).lineTo(leftMargin + contentWidth, currentY + rowHeight).stroke();
  doc.moveTo(leftMargin, currentY + rowHeight * 2).lineTo(leftMargin + contentWidth, currentY + rowHeight * 2).stroke();
  doc.moveTo(leftMargin, currentY + rowHeight * 3).lineTo(leftMargin + contentWidth, currentY + rowHeight * 3).stroke();

  // Vertical column dividers
  const col1Width = 110;
  doc.moveTo(leftMargin + col1Width, currentY).lineTo(leftMargin + col1Width, currentY + particularBoxHeight).stroke();

  // Row 1: School Name
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000')
    .text("SCHOOL'S NAME", leftMargin + 5, currentY + 6);
  const schoolNameStr = (school?.name || "BABA-E-URDU MOLVI ABDUL HAQ BOYS' ENGLISH MEDIUM SCHOOL").toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(schoolNameStr, leftMargin + col1Width + 6, currentY + 6, { width: contentWidth - col1Width - 10, ellipsis: true });

  // Row 2: Student Name & Exam Title
  const colExamSplit = 320;
  doc.moveTo(leftMargin + colExamSplit, currentY + rowHeight).lineTo(leftMargin + colExamSplit, currentY + rowHeight * 2).stroke();

  doc.font('Helvetica-Bold').fontSize(8.5)
    .text("STUDENT'S NAME", leftMargin + 5, currentY + rowHeight + 6);
  const studentNameStr = (studentProfile?.studentFullName || student?.fullName || 'STUDENT').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(studentNameStr, leftMargin + col1Width + 6, currentY + rowHeight + 6, { width: colExamSplit - col1Width - 10 });

  const examSessionStr = (exam?.title || `ANNUAL EXAMINATION ${exam?.academicYear || '2023-2024'}`).toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8)
    .text(examSessionStr, leftMargin + colExamSplit + 6, currentY + rowHeight + 6, { width: contentWidth - colExamSplit - 10, align: 'center' });

  // Row 3: Father's Name
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text("FATHER'S NAME", leftMargin + 5, currentY + rowHeight * 2 + 6);
  const fatherNameStr = (studentProfile?.fatherFullName || studentProfile?.fatherOrGuardianName || '-').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(fatherNameStr, leftMargin + col1Width + 6, currentY + rowHeight * 2 + 6);

  // Row 4: GR No | Class | Section
  const grWidth = 80;
  const classLabelWidth = 70;
  const classValWidth = 90;

  doc.moveTo(leftMargin + col1Width + grWidth, currentY + rowHeight * 3).lineTo(leftMargin + col1Width + grWidth, currentY + particularBoxHeight).stroke();
  doc.moveTo(leftMargin + col1Width + grWidth + classLabelWidth + classValWidth, currentY + rowHeight * 3).lineTo(leftMargin + col1Width + grWidth + classLabelWidth + classValWidth, currentY + particularBoxHeight).stroke();

  doc.font('Helvetica-Bold').fontSize(8.5)
    .text('G.R NO.', leftMargin + 5, currentY + rowHeight * 3 + 6);
  doc.font('Helvetica-Bold').fontSize(9)
    .text(String(studentProfile?.grNumber || studentProfile?.rollNumber || '-'), leftMargin + col1Width + 6, currentY + rowHeight * 3 + 6, { width: grWidth - 10, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(8.5)
    .text('CLASS :', leftMargin + col1Width + grWidth + 6, currentY + rowHeight * 3 + 6);
  const classNameStr = (classDoc?.name || 'IV').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(9)
    .text(classNameStr, leftMargin + col1Width + grWidth + 50, currentY + rowHeight * 3 + 6, { width: 40, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(8.5)
    .text('SECTION :', leftMargin + col1Width + grWidth + classLabelWidth + classValWidth + 6, currentY + rowHeight * 3 + 6);
  const sectionNameStr = (sectionDoc?.name || '-').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(9)
    .text(sectionNameStr, leftMargin + col1Width + grWidth + classLabelWidth + classValWidth + 70, currentY + rowHeight * 3 + 6, { width: 40, align: 'center' });

  // 5. Subjects & Marks Table (Image 1 replica)
  currentY += particularBoxHeight + 16;
  const tableTopY = currentY;

  // Table Column Widths: Subjects (235.28), Max Marks (110), Marks Secured (110), Remarks (60)
  const colSubjWidth = 235.28;
  const colMaxWidth = 110;
  const colSecuredWidth = 110;
  const colRemarksWidth = 60;

  // Table Header Box (peach fill)
  const tableHeaderHeight = 28;
  doc.rect(leftMargin, tableTopY, contentWidth, tableHeaderHeight)
    .fillColor('#fed7aa')
    .strokeColor('#000000')
    .lineWidth(1)
    .fillAndStroke();

  // Vertical dividers in header
  doc.moveTo(leftMargin + colSubjWidth, tableTopY).lineTo(leftMargin + colSubjWidth, tableTopY + tableHeaderHeight).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth, tableTopY).lineTo(leftMargin + colSubjWidth + colMaxWidth, tableTopY + tableHeaderHeight).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, tableTopY).lineTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, tableTopY + tableHeaderHeight).stroke();

  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.5)
    .text('SUBJECTS', leftMargin, tableTopY + 9, { width: colSubjWidth, align: 'center' });
  doc.text('MAX. MARKS\n700', leftMargin + colSubjWidth, tableTopY + 4, { width: colMaxWidth, align: 'center' });
  doc.text('MARKS\nSECURED', leftMargin + colSubjWidth + colMaxWidth, tableTopY + 4, { width: colSecuredWidth, align: 'center' });
  doc.text('REMARKS', leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, tableTopY + 9, { width: colRemarksWidth, align: 'center' });

  // Calculate metrics
  const metrics = computeStudentResultMetrics(result?.subjectMarks || []);
  const subjectRowHeight = 18;
  let rowY = tableTopY + tableHeaderHeight;

  // Helper to find subject marks by name
  const findMarks = (key) => {
    return metrics.subjectMarks.find((s) => (s.subjectName || '').toLowerCase().includes(key));
  };

  const islamiatDoc = findMarks('islamiat');
  const islamiatTotalSecured = islamiatDoc ? islamiatDoc.obtainedMarks : 0;
  const islamiatNazraSecured = islamiatDoc?.subComponents ? islamiatDoc.subComponents.nazra : Math.round(islamiatTotalSecured * 0.2);
  const islamiatWrittenSecured = islamiatDoc?.subComponents ? islamiatDoc.subComponents.written : (islamiatTotalSecured - islamiatNazraSecured);

  // 5a. ISLAMIAT Sub-Rows with Merged Total (Image 1 replica)
  // Two subrows (height 36 total): Nazra (20) & Written (80)
  const isIslamiatEven = true;
  doc.rect(leftMargin, rowY, contentWidth, subjectRowHeight * 2)
    .fillColor(isIslamiatEven ? '#ffffff' : '#f8fafc')
    .strokeColor('#000000')
    .lineWidth(0.8)
    .fillAndStroke();

  // Horizontal divider between Nazra and Written (inside Subjects, Max Marks left half, Marks Secured left half)
  doc.moveTo(leftMargin, rowY + subjectRowHeight)
    .lineTo(leftMargin + colSubjWidth + colMaxWidth / 2, rowY + subjectRowHeight).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth, rowY + subjectRowHeight)
    .lineTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth / 2, rowY + subjectRowHeight).stroke();

  // Vertical column lines for Islamiat block
  doc.moveTo(leftMargin + colSubjWidth, rowY).lineTo(leftMargin + colSubjWidth, rowY + subjectRowHeight * 2).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth / 2, rowY).lineTo(leftMargin + colSubjWidth + colMaxWidth / 2, rowY + subjectRowHeight * 2).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth, rowY).lineTo(leftMargin + colSubjWidth + colMaxWidth, rowY + subjectRowHeight * 2).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth / 2, rowY).lineTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth / 2, rowY + subjectRowHeight * 2).stroke();
  doc.moveTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, rowY).lineTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, rowY + subjectRowHeight * 2).stroke();

  // Islamiat Nazra (row 1)
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8)
    .text('ISLAMIAT (NAZRA)', leftMargin + 8, rowY + 5);
  doc.font('Helvetica').fontSize(8.5)
    .text('20', leftMargin + colSubjWidth, rowY + 5, { width: colMaxWidth / 2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(String(islamiatNazraSecured), leftMargin + colSubjWidth + colMaxWidth, rowY + 5, { width: colSecuredWidth / 2, align: 'center' });

  // Islamiat Written (row 2)
  doc.font('Helvetica-Bold').fontSize(8)
    .text('ISLAMIAT (WRITTEN)', leftMargin + 8, rowY + subjectRowHeight + 5);
  doc.font('Helvetica').fontSize(8.5)
    .text('80', leftMargin + colSubjWidth, rowY + subjectRowHeight + 5, { width: colMaxWidth / 2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(String(islamiatWrittenSecured), leftMargin + colSubjWidth + colMaxWidth, rowY + subjectRowHeight + 5, { width: colSecuredWidth / 2, align: 'center' });

  // Merged Total 100 & Merged Total Secured across both rows
  doc.font('Helvetica-Bold').fontSize(9)
    .text('100', leftMargin + colSubjWidth + colMaxWidth / 2, rowY + 13, { width: colMaxWidth / 2, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9)
    .text(String(islamiatTotalSecured), leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth / 2, rowY + 13, { width: colSecuredWidth / 2, align: 'center' });

  rowY += subjectRowHeight * 2;

  // 5b. Standard Subjects: English, Mathematics, Urdu, Sindhi, Science, Social Studies, Drawing
  const standardSubjectsDisplay = [
    { name: 'ENGLISH',        max: 100,     key: 'english' },
    { name: 'MATHEMATICS',    max: 100,     key: 'mathematics' },
    { name: 'URDU',           max: 100,     key: 'urdu' },
    { name: 'SINDHI',         max: 100,     key: 'sindhi' },
    { name: 'SCIENCE',        max: 100,     key: 'science' },
    { name: 'SOCIAL STUDIES', max: 100,     key: 'social studies' },
    { name: 'DRAWING',        max: 'GRADE', key: 'drawing', isGraded: true },
  ];

  standardSubjectsDisplay.forEach((subjItem, idx) => {
    const isEven = idx % 2 === 1;
    doc.rect(leftMargin, rowY, contentWidth, subjectRowHeight)
      .fillColor(isEven ? '#ffffff' : '#f8fafc')
      .strokeColor('#000000')
      .lineWidth(0.8)
      .fillAndStroke();

    // Column lines
    doc.moveTo(leftMargin + colSubjWidth, rowY).lineTo(leftMargin + colSubjWidth, rowY + subjectRowHeight).stroke();
    doc.moveTo(leftMargin + colSubjWidth + colMaxWidth, rowY).lineTo(leftMargin + colSubjWidth + colMaxWidth, rowY + subjectRowHeight).stroke();
    doc.moveTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, rowY).lineTo(leftMargin + colSubjWidth + colMaxWidth + colSecuredWidth, rowY + subjectRowHeight).stroke();

    // Subject Name
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8)
      .text(subjItem.name, leftMargin + 8, rowY + 5);

    // Max Marks & Obtained
    let securedVal = '-';
    let maxVal = String(subjItem.max);

    if (subjItem.isGraded) {
      const drawDoc = findMarks('drawing');
      securedVal = drawDoc ? drawDoc.letterGrade : 'A';
      maxVal = 'GRADE';
    } else {
      const matchSub = findMarks(subjItem.key);
      securedVal = matchSub ? String(matchSub.obtainedMarks) : '-';
    }

    doc.font('Helvetica').fontSize(8.5)
      .text(maxVal, leftMargin + colSubjWidth, rowY + 5, { width: colMaxWidth, align: 'center' });

    doc.font('Helvetica-Bold').fontSize(8.5)
      .text(securedVal, leftMargin + colSubjWidth + colMaxWidth, rowY + 5, { width: colSecuredWidth, align: 'center' });

    rowY += subjectRowHeight;
  });

  // 6. Bottom Grand Total & Summary Grid (Image 1 Replica)
  rowY += 14;
  const summaryBoxHeight = 38;
  doc.rect(leftMargin, rowY, contentWidth, summaryBoxHeight)
    .lineWidth(1)
    .strokeColor('#000000')
    .stroke();

  // Horizontal middle line for columns 1, 2, 5, 6
  const sCol1 = 110;
  const sCol2 = 80;
  const sColGradeLabel = 80;
  const sColGradeVal = 60;
  const sCol5 = 90;
  const sCol6 = contentWidth - sCol1 - sCol2 - sColGradeLabel - sColGradeVal - sCol5;

  const colGradeX = leftMargin + sCol1 + sCol2;
  const colGradeValX = colGradeX + sColGradeLabel;
  const colRightLabelX = colGradeValX + sColGradeVal;
  const colRightValX = colRightLabelX + sCol5;

  // Horizontal line in left columns
  doc.moveTo(leftMargin, rowY + 19).lineTo(colGradeX, rowY + 19).stroke();
  // Horizontal line in right columns
  doc.moveTo(colRightLabelX, rowY + 19).lineTo(leftMargin + contentWidth, rowY + 19).stroke();

  // Vertical split columns
  doc.moveTo(leftMargin + sCol1, rowY).lineTo(leftMargin + sCol1, rowY + summaryBoxHeight).stroke();
  doc.moveTo(colGradeX, rowY).lineTo(colGradeX, rowY + summaryBoxHeight).stroke();
  doc.moveTo(colGradeValX, rowY).lineTo(colGradeValX, rowY + summaryBoxHeight).stroke();
  doc.moveTo(colRightLabelX, rowY).lineTo(colRightLabelX, rowY + summaryBoxHeight).stroke();
  doc.moveTo(colRightValX, rowY).lineTo(colRightValX, rowY + summaryBoxHeight).stroke();

  // Top Left: GRAND TOTAL
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
    .text('GRAND TOTAL', leftMargin + 6, rowY + 5);
  doc.font('Helvetica-Bold').fontSize(9)
    .text(String(metrics.totalObtainedMarks), leftMargin + sCol1, rowY + 5, { width: sCol2, align: 'center' });

  // Bottom Left: RESULT
  const bRowY = rowY + 19;
  doc.font('Helvetica-Bold').fontSize(8)
    .text('RESULT', leftMargin + 6, bRowY + 5);
  doc.font('Helvetica-Bold').fontSize(9)
    .text(metrics.resultStatus, leftMargin + sCol1, bRowY + 5, { width: sCol2, align: 'center' });

  // Center Merged 2-Row Cell: OVERALL GRADE + Grade Value
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text('OVERALL\nGRADE', colGradeX, rowY + 10, { width: sColGradeLabel, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(16)
    .text(metrics.grade, colGradeValX, rowY + 10, { width: sColGradeVal, align: 'center' });

  // Top Right: % AGE
  doc.font('Helvetica-Bold').fontSize(8)
    .text('% AGE  :', colRightLabelX + 6, rowY + 5);
  doc.font('Helvetica-Bold').fontSize(10)
    .text(`${metrics.percentage}%`, colRightValX, rowY + 4, { width: sCol6, align: 'center' });

  // Bottom Right: RANK (Image 1 replica: green outlined box with green bold font!)
  doc.font('Helvetica-Bold').fontSize(8)
    .text('RANK  :', colRightLabelX + 6, bRowY + 5);

  const rankStr = result?.rankFormatted || formatRankDisplay(result?.position || result?.rank);
  const rankBoxW = sCol6 - 12;
  const rankBoxH = 15;
  const rankBoxX = colRightValX + 6;
  const rankBoxY = bRowY + 2;

  doc.rect(rankBoxX, rankBoxY, rankBoxW, rankBoxH)
    .lineWidth(1)
    .strokeColor('#15803d')
    .stroke();

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#15803d')
    .text(rankStr, rankBoxX, rankBoxY + 3, { width: rankBoxW, align: 'center' });

  // 7. Official Signatures Block (Image 1 Replica)
  rowY += summaryBoxHeight + 55;

  // Principal Signature line (Left)
  doc.moveTo(leftMargin, rowY).lineTo(leftMargin + 170, rowY).strokeColor('#000000').lineWidth(0.8).stroke();
  doc.font('Helvetica').fontSize(8).fillColor('#000000')
    .text("Principal's Stamp & Signature", leftMargin, rowY + 4, { width: 170, align: 'center' });

  // Admin Officer Signature line (Right)
  const rightSigX = leftMargin + contentWidth - 170;
  doc.moveTo(rightSigX, rowY).lineTo(rightSigX + 170, rowY).stroke();
  doc.text("Administrative Officer's Signature", rightSigX, rowY + 4, { width: 170, align: 'center' });

  // Issuance Date line (Bottom)
  rowY += 35;
  const dateFormatted = new Date(issuanceDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(`Issuance Date:  ${dateFormatted}`, leftMargin, rowY);
  doc.moveTo(leftMargin + 68, rowY + 11).lineTo(leftMargin + 180, rowY + 11).stroke();

  return doc;
}

/**
 * GENERATE CLASS TABULATION SHEET (Image 2 Replica - STRICTLY LEGAL LANDSCAPE)
 * Official Legal Landscape dimensions: 1008 pt (width) x 612 pt (height) / 14 x 8.5 inches
 */
export function generateTabulationSheetPdf({
  exam,
  rankedResults = [],
  classStatistics = {},
  school,
  classDoc,
  sectionDoc,
}) {
  const doc = new PDFDocument({
    size: 'legal',
    layout: 'landscape',
    margin: 28,
    autoFirstPage: true,
  });

  const pageWidth = 1008; // Legal Landscape width
  const leftMargin = 28;
  const contentWidth = pageWidth - leftMargin * 2; // 952 pt

  // 1. Header Block with Municipal Emblem on the Left (Image 2 replica)
  drawDmcMunicipalEmblem(doc, leftMargin + 36, 52, 22);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000')
    .text('ELEMENTARY BOARD DISTRICT MUNICIPAL CORPORATION', leftMargin, 38, {
      width: contentWidth,
      align: 'center',
      characterSpacing: 0.8,
    });

  doc.font('Helvetica-Bold').fontSize(10.5)
    .text('EDUCATION DEPARTMENT KARACHI (CENTRAL)', leftMargin, 53, {
      width: contentWidth,
      align: 'center',
      characterSpacing: 0.8,
    });

  const examTitleStr = `TABULATION SHEET OF ${(exam?.title || 'ANNUAL EXAMINATION').toUpperCase()} ${exam?.academicYear || '2023 - 2024'}`;
  doc.font('Helvetica-Bold').fontSize(9.5)
    .text(examTitleStr, leftMargin, 68, {
      width: contentWidth,
      align: 'center',
      characterSpacing: 0.5,
    });

  // 2. School Name & Class Ribbon (Image 2 style)
  let currentY = 88;
  const ribbonHeight = 18;
  doc.rect(leftMargin, currentY, contentWidth, ribbonHeight)
    .fillColor('#ffffff')
    .strokeColor('#000000')
    .lineWidth(0.8)
    .fillAndStroke();

  const schoolColWidth = 730;
  doc.moveTo(leftMargin + schoolColWidth, currentY).lineTo(leftMargin + schoolColWidth, currentY + ribbonHeight).stroke();

  const schoolFullName = (school?.name || "Baba-e-Urdu Molvi Abdul Haq Boys' English Medium School L.T 11E").toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000')
    .text(`SCHOOL NAME:   ${schoolFullName}`, leftMargin + 6, currentY + 5);

  const className = (classDoc?.name || 'IV').toUpperCase();
  const sectionName = sectionDoc?.name ? ` (${sectionDoc.name})` : '';
  doc.text(`CLASS:   ${className}${sectionName}`, leftMargin + schoolColWidth + 6, currentY + 5);

  // 3. Tabulation Columns Setup (Matching Image 2 exactly, totaling 952 pt)
  currentY += ribbonHeight + 2;
  const colDefs = [
    { key: 'sno',      label: 'S.N\nO.',    width: 26,  align: 'center' },
    { key: 'gr',       label: 'GR.\nNO.',   width: 40,  align: 'center' },
    { key: 'name',     label: 'NAME OF STUDENTS', width: 160, align: 'left' },
    { key: 'father',   label: "FATHER'S NAME",    width: 150, align: 'left' },
    // Islamiat subcolumns: 30 + 30 + 34 = 94 pt
    { key: 'is_naz',   label: 'Nazra\n20',   width: 30,  align: 'center' },
    { key: 'is_wri',   label: 'Written\n80', width: 30,  align: 'center' },
    { key: 'is_tot',   label: 'Total\n100',  width: 34,  align: 'center' },
    // Standard Subjects (100 each)
    { key: 'sst',      label: 'S.St\n100',    width: 38,  align: 'center' },
    { key: 'sindhi',   label: 'SINDHI\n100',  width: 42,  align: 'center' },
    { key: 'english',  label: 'ENGLISH\n100', width: 48,  align: 'center' },
    { key: 'science',  label: 'SCIENCE\n100', width: 48,  align: 'center' },
    { key: 'math',     label: 'MATH\n100',    width: 40,  align: 'center' },
    { key: 'urdu',     label: 'URDU\n100',    width: 40,  align: 'center' },
    { key: 'drawing',  label: 'DRAWING\nGRADE', width: 48, align: 'center' },
    // Summary columns
    { key: 'total',    label: 'Grand\nTotal\n700', width: 46, align: 'center' },
    { key: 'pct',      label: '%\nAGE',            width: 44, align: 'center' },
    { key: 'result',   label: 'Overall\nResult',   width: 50, align: 'center' },
    { key: 'grade',    label: 'GRADE',             width: 40, align: 'center' },
    { key: 'rank',     label: 'Rank',              width: 38, align: 'center' },
  ];

  // Header Table Box: 2-tier height = 30 pt
  const tableHeaderHeight = 30;
  doc.rect(leftMargin, currentY, contentWidth, tableHeaderHeight)
    .fillColor('#ffffff')
    .strokeColor('#000000')
    .lineWidth(0.8)
    .fillAndStroke();

  // Render headers with 2-tier for ISLAMIAT
  let headerX = leftMargin;
  const islamiatStartX = leftMargin + 26 + 40 + 160 + 150; // 376 pt
  const islamiatTotalWidth = 30 + 30 + 34; // 94 pt

  colDefs.forEach((col) => {
    // Check if column is one of Islamiat subcolumns
    const isIslamiatCol = ['is_naz', 'is_wri', 'is_tot'].includes(col.key);

    if (isIslamiatCol) {
      // Islamiat subcolumn divider (starts at y + 14)
      doc.moveTo(headerX + col.width, currentY + 14).lineTo(headerX + col.width, currentY + tableHeaderHeight).stroke();
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000000')
        .text(col.label, headerX + 1, currentY + 16, { width: col.width - 2, align: 'center' });
    } else {
      doc.moveTo(headerX + col.width, currentY).lineTo(headerX + col.width, currentY + tableHeaderHeight).stroke();
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000000')
        .text(col.label, headerX + 1, currentY + 4, { width: col.width - 2, align: 'center' });
    }

    headerX += col.width;
  });

  // Top-tier header for ISLAMIAT (spanning 94 pt)
  doc.moveTo(islamiatStartX, currentY + 14).lineTo(islamiatStartX + islamiatTotalWidth, currentY + 14).stroke();
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000')
    .text('ISLAMIAT', islamiatStartX, currentY + 3, { width: islamiatTotalWidth, align: 'center' });

  // 4. Tabulation Student Rows
  currentY += tableHeaderHeight;
  const rowHeight = 15;

  rankedResults.forEach((entry, idx) => {
    // Page break handling for large classes
    if (currentY + rowHeight > 490) {
      doc.addPage({ size: 'legal', layout: 'landscape', margin: 28 });
      currentY = 40;
    }

    const isPassed = entry.isOverallPassed;
    const isEven = idx % 2 === 0;

    doc.rect(leftMargin, currentY, contentWidth, rowHeight)
      .fillColor(isEven ? '#ffffff' : '#f8fafc')
      .strokeColor('#000000')
      .lineWidth(0.5)
      .fillAndStroke();

    let cellX = leftMargin;
    const drawCell = (text, width, align = 'center', font = 'Helvetica', color = '#000000', size = 7) => {
      doc.moveTo(cellX + width, currentY).lineTo(cellX + width, currentY + rowHeight).stroke();
      doc.font(font).fontSize(size).fillColor(color)
        .text(String(text !== undefined && text !== null ? text : '-'), cellX + 2, currentY + 4, {
          width: width - 4,
          align,
          ellipsis: true,
        });
      cellX += width;
    };

    // Find subjects
    const subjects = entry.subjectMarks || [];
    const findSubj = (name) => subjects.find((s) => (s.subjectName || '').toLowerCase().includes(name));

    const isl = findSubj('islamiat');
    const isNaz = isl?.subComponents ? isl.subComponents.nazra : Math.round((isl?.obtainedMarks || 0) * 0.2);
    const isWri = isl?.subComponents ? isl.subComponents.written : ((isl?.obtainedMarks || 0) - isNaz);
    const isTot = isl?.obtainedMarks || 0;

    const sst = findSubj('social') || findSubj('s.st');
    const sindhi = findSubj('sindhi');
    const eng = findSubj('english');
    const sci = findSubj('science');
    const math = findSubj('math');
    const urdu = findSubj('urdu');
    const draw = findSubj('drawing');

    const studentProfile = entry.studentProfile || {};
    const studentUser = entry.studentId || {};

    const studentName = (studentProfile.studentFullName || studentUser.fullName || 'STUDENT').toUpperCase();
    const fatherName = (studentProfile.fatherFullName || studentProfile.fatherOrGuardianName || '-').toUpperCase();
    const grNumber = studentProfile.grNumber || studentProfile.rollNumber || (idx + 1);

    // S.NO, GR, Name, Father
    drawCell(idx + 1, 26, 'center');
    drawCell(grNumber, 40, 'center');
    drawCell(studentName, 160, 'left', 'Helvetica-Bold');
    drawCell(fatherName, 150, 'left');

    // Islamiat Nazra (red if < 7), Written (red if < 27), Total (red if < 33)
    const redColor = '#dc2626';
    const nazraColor = isNaz < 7 ? redColor : '#000000';
    const writtenColor = isWri < 27 ? redColor : '#000000';
    const islTotalColor = isTot < 33 ? redColor : '#000000';

    drawCell(isNaz, 30, 'center', isNaz < 7 ? 'Helvetica-Bold' : 'Helvetica', nazraColor);
    drawCell(isWri, 30, 'center', isWri < 27 ? 'Helvetica-Bold' : 'Helvetica', writtenColor);
    drawCell(isTot, 34, 'center', 'Helvetica-Bold', islTotalColor);

    // Standard subjects (red if < 33)
    const checkSubjectCell = (subDoc, width) => {
      if (!subDoc || subDoc.obtainedMarks === undefined) {
        drawCell('-', width);
        return;
      }
      const val = subDoc.obtainedMarks;
      const isFail = val < 33;
      drawCell(val, width, 'center', isFail ? 'Helvetica-Bold' : 'Helvetica', isFail ? redColor : '#000000');
    };

    checkSubjectCell(sst, 38);
    checkSubjectCell(sindhi, 42);
    checkSubjectCell(eng, 48);
    checkSubjectCell(sci, 48);
    checkSubjectCell(math, 40);
    checkSubjectCell(urdu, 40);

    // Drawing (Grade)
    const drawGrade = draw ? (draw.letterGrade || 'A') : 'A';
    drawCell(drawGrade, 48, 'center', 'Helvetica-Bold');

    // Grand Total (red if < 231)
    const totalVal = entry.totalObtainedMarks || 0;
    const isTotalFail = totalVal < 231;
    drawCell(totalVal, 46, 'center', 'Helvetica-Bold', isTotalFail ? redColor : '#000000');

    // % AGE
    drawCell(`${entry.percentage || 0}%`, 44, 'center');

    // Overall Result (Image 2 replica: FAILED in red)
    const resultColor = isPassed ? '#15803d' : redColor;
    drawCell(isPassed ? 'PASSED' : 'FAILED', 50, 'center', 'Helvetica-Bold', resultColor);

    // GRADE
    const gradeColor = isPassed ? '#000000' : redColor;
    drawCell(entry.grade || (isPassed ? 'D' : 'FALSE'), 40, 'center', 'Helvetica-Bold', gradeColor);

    // Rank (e.g. 1st, 2nd, 3rd in green font; if failed, '-')
    const rankDisplay = isPassed ? (entry.rankFormatted || formatRankDisplay(entry.rank)) : '-';
    drawCell(rankDisplay, 38, 'center', 'Helvetica-Bold', isPassed ? '#15803d' : '#6b7280');

    currentY += rowHeight;
  });

  // 5. Bottom Municipal Statistics Box (Image 2 Replica)
  currentY += 15;
  const statsBoxWidth = 300;
  const statsRowHeight = 16;
  const statsBoxHeight = statsRowHeight * 3;

  doc.rect(leftMargin, currentY, statsBoxWidth, statsBoxHeight)
    .lineWidth(0.8)
    .strokeColor('#000000')
    .stroke();

  doc.moveTo(leftMargin, currentY + statsRowHeight).lineTo(leftMargin + statsBoxWidth, currentY + statsRowHeight).stroke();
  doc.moveTo(leftMargin, currentY + statsRowHeight * 2).lineTo(leftMargin + statsBoxWidth, currentY + statsRowHeight * 2).stroke();
  doc.moveTo(leftMargin + 150, currentY).lineTo(leftMargin + 150, currentY + statsBoxHeight).stroke();

  // Stats Row 1: No. of Students | No. of Students Appeared
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000000')
    .text('No. of Students:', leftMargin + 6, currentY + 4)
    .text(String(classStatistics.totalEnrolled || rankedResults.length), leftMargin + 105, currentY + 4)
    .text('No. of Students Appeared:', leftMargin + 156, currentY + 4)
    .text(String(classStatistics.appearedCount || rankedResults.length), leftMargin + 265, currentY + 4);

  // Stats Row 2: No. of Absentees | Passing %Age
  const statY2 = currentY + statsRowHeight;
  doc.text('No. of Absentees:', leftMargin + 6, statY2 + 4)
    .text(String(classStatistics.absenteesCount || 0), leftMargin + 105, statY2 + 4)
    .text('Passing %Age:', leftMargin + 156, statY2 + 4)
    .text(`${classStatistics.passingPercentage || 0}%`, leftMargin + 265, statY2 + 4);

  // Stats Row 3: No. of Students Passed | No. of Students Failed
  const statY3 = currentY + statsRowHeight * 2;
  doc.text('No. of Students Passed:', leftMargin + 6, statY3 + 4)
    .text(String(classStatistics.passedCount || 0), leftMargin + 105, statY3 + 4)
    .text('No. of Students Failed:', leftMargin + 156, statY3 + 4)
    .text(String(classStatistics.failedCount || 0), leftMargin + 265, statY3 + 4);

  // 6. 4 Official Authority Signatures (Image 2 Replica)
  const sigBoxStartX = leftMargin + statsBoxWidth + 40;
  const sigColWidth = 160;
  const sigY1 = currentY + 26;
  const sigY2 = currentY + statsBoxHeight + 10;

  // Signature 1: Signature of H.M / Principal
  doc.moveTo(sigBoxStartX, sigY1).lineTo(sigBoxStartX + sigColWidth, sigY1).stroke();
  doc.font('Helvetica-Bold').fontSize(7.5)
    .text('Signature of H.M / Principal', sigBoxStartX, sigY1 + 4, { width: sigColWidth, align: 'center' });

  // Signature 2: Signature of Deputy Controller
  doc.moveTo(sigBoxStartX + sigColWidth + 30, sigY1).lineTo(sigBoxStartX + sigColWidth * 2 + 30, sigY1).stroke();
  doc.text('Signature of Deputy Controller', sigBoxStartX + sigColWidth + 30, sigY1 + 4, { width: sigColWidth, align: 'center' });

  // Signature 3: Signature of Supervisor
  doc.moveTo(sigBoxStartX, sigY2).lineTo(sigBoxStartX + sigColWidth, sigY2).stroke();
  doc.text('Signature of Supervisor', sigBoxStartX, sigY2 + 4, { width: sigColWidth, align: 'center' });

  // Signature 4: Signature of Deputy Director Education
  doc.moveTo(sigBoxStartX + sigColWidth + 30, sigY2).lineTo(sigBoxStartX + sigColWidth * 2 + 30, sigY2).stroke();
  doc.text('Signature of Deputy Director Education', sigBoxStartX + sigColWidth + 30, sigY2 + 4, { width: sigColWidth, align: 'center' });

  return doc;
}
