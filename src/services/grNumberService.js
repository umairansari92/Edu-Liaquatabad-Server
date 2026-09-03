/**
 * GR Number & Global Student ID Service
 * Education Department — DMC Liaquatabad
 *
 * Dual Student Numbering Architecture:
 *
 * 1. GR No (grNumber)
 *    - School-scoped sequential integer (e.g. 127)
 *    - Unique within one school (enforced by DB compound index)
 *    - NEW_ADMISSION: auto-increment via atomic $inc on School.lastGrNumber
 *    - EXISTING_ENTRY: HM provides the original GR from school records, validated for uniqueness
 *
 * 2. Global Student ID (globalStudentId)
 *    - Platform-wide unique, system-generated, NEVER editable
 *    - Format: {schoolCode}-{NNNN} → e.g. MMHA-0001, MMHA-0127
 *    - schoolCode is set by authorized roles only (HM, Supervisor, Admin+)
 *    - If schoolCode not yet configured, globalStudentId is deferred (null) until set
 */

import School from '../models/School.js';
import StudentProfile from '../models/StudentProfile.js';

// ─── GR Number Logic ──────────────────────────────────────────────────────────

/**
 * Auto-generate the next GR No for a school (NEW_ADMISSION).
 * Uses atomic MongoDB $inc to prevent race conditions in concurrent requests.
 *
 * @param {string} schoolId - MongoDB ObjectId of the school
 * @returns {Promise<number>} - The next GR number (e.g. 127)
 */
export const generateNextGrNumber = async (schoolId) => {
  const updated = await School.findByIdAndUpdate(
    schoolId,
    { $inc: { lastGrNumber: 1 } },
    { new: true, runValidators: false, select: 'lastGrNumber' }
  );

  if (!updated) {
    throw new Error('School not found — cannot generate GR number.');
  }

  return updated.lastGrNumber;
};

/**
 * Preview the next GR No without actually committing it.
 * Used by the HM enrollment form to show a suggested GR number.
 *
 * @param {string} schoolId
 * @returns {Promise<number>} - The suggested next GR number (lastGrNumber + 1)
 */
export const previewNextGrNumber = async (schoolId) => {
  const school = await School.findById(schoolId).select('lastGrNumber');
  if (!school) throw new Error('School not found.');
  return school.lastGrNumber + 1;
};

/**
 * Validate a manually provided GR No (EXISTING_ENTRY flow).
 * Checks that no other student in the same school already holds this GR number.
 *
 * @param {string} schoolId
 * @param {number} grNumber
 * @returns {Promise<void>}
 * @throws Error if GR number is already taken in this school
 */
export const validateManualGrNumber = async (schoolId, grNumber) => {
  const existing = await StudentProfile.findOne({ schoolId, grNumber });
  if (existing) {
    throw new Error(
      `GR No ${grNumber} is already assigned to another student in this school. Each school student must have a unique GR number.`
    );
  }
};

/**
 * After manually inserting an old student with a GR number higher than the current
 * school counter, sync the counter so auto-generation stays ahead of manual entries.
 *
 * @param {string} schoolId
 * @param {number} manualGrNumber - The GR number that was just manually entered
 * @returns {Promise<void>}
 */
export const syncGrCounterIfNeeded = async (schoolId, manualGrNumber) => {
  await School.findByIdAndUpdate(schoolId, [
    {
      $set: {
        lastGrNumber: {
          $cond: {
            if: { $gt: [manualGrNumber, '$lastGrNumber'] },
            then: manualGrNumber,
            else: '$lastGrNumber',
          },
        },
      },
    },
  ]);
};

// ─── Global Student ID Logic ──────────────────────────────────────────────────

/**
 * Generate the next Global Student ID for a school.
 * Format: {SCHOOL_CODE}-{NNNN} e.g. MMHA-0001
 *
 * Uses atomic $inc on School.lastGlobalSequence to prevent race conditions.
 * Returns null if the school has no schoolCode assigned yet (deferred until configured).
 *
 * @param {string} schoolId
 * @returns {Promise<string|null>} - e.g. 'MMHA-0127' or null if schoolCode not set
 */
export const generateGlobalStudentId = async (schoolId) => {
  const school = await School.findById(schoolId).select('schoolCode lastGlobalSequence');
  if (!school) throw new Error('School not found.');

  // Defer if school code hasn't been configured yet
  if (!school.schoolCode) return null;

  const updated = await School.findByIdAndUpdate(
    schoolId,
    { $inc: { lastGlobalSequence: 1 } },
    { new: true, runValidators: false, select: 'schoolCode lastGlobalSequence' }
  );

  const paddedSeq = String(updated.lastGlobalSequence).padStart(4, '0');
  return `${updated.schoolCode}-${paddedSeq}`;
};

/**
 * Backfill Global Student IDs for all students in a school that don't have one yet.
 * Run this AFTER a school code is first assigned by an admin.
 *
 * @param {string} schoolId
 * @returns {Promise<number>} - count of students updated
 */
export const backfillGlobalStudentIds = async (schoolId) => {
  const school = await School.findById(schoolId).select('schoolCode');
  if (!school?.schoolCode) {
    throw new Error('Cannot backfill: school has no schoolCode assigned.');
  }

  // Find all students in school with no globalStudentId, sorted by grNumber (oldest first)
  const students = await StudentProfile.find(
    { schoolId, globalStudentId: { $in: [null, undefined, ''] } },
    '_id grNumber'
  ).sort({ grNumber: 1 });

  let updatedCount = 0;
  for (const student of students) {
    const globalId = await generateGlobalStudentId(schoolId);
    await StudentProfile.findByIdAndUpdate(student._id, { globalStudentId: globalId });
    updatedCount++;
  }

  return updatedCount;
};
