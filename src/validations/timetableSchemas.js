import { z } from 'zod';
import { TIMETABLE_SLOT_TYPE, TIMETABLE_STATUS, TIMETABLE_DAYS } from '../../config/constants.js';

const SCRIPT_INJECTION_REGEX = /<[^>]*>|javascript:|on\w+\s*=|\$where|\$expr/i;

const safeString = (maximumLength = 200, minimumLength = 0, minimumMessage = '') => {
  let schema = z.string().trim().max(maximumLength, `Must be ${maximumLength} characters or fewer.`);
  if (minimumLength > 0) {
    schema = schema.min(minimumLength, minimumMessage || `Must be at least ${minimumLength} characters.`);
  }
  return schema.refine((inputValue) => !SCRIPT_INJECTION_REGEX.test(inputValue), {
    message: 'Input contains disallowed characters or script tags.',
  });
};

export const periodSlotSchema = z.object({
  periodNumber: z.number().int().min(0, 'Period number must be 0 or greater.').max(25, 'Maximum period number is 25.'),
  slotType: z.enum(Object.values(TIMETABLE_SLOT_TYPE), {
    errorMap: () => ({ message: 'Invalid slotType. Must be TEACHING, ASSEMBLY, RECESS, ZERO_PERIOD, or SPECIAL_ACTIVITY.' }),
  }),
  label: safeString(60, 2, 'Period label must be at least 2 characters.'),
  startTime: z.string().trim().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Start time must be in HH:mm 24-hour format (e.g., 08:00).'),
  endTime: z.string().trim().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'End time must be in HH:mm 24-hour format (e.g., 08:45).'),
}).strict().refine((slot) => slot.startTime < slot.endTime, {
  message: 'Slot endTime must be strictly after startTime.',
  path: ['endTime'],
});

export const scheduleEntrySchema = z.object({
  dayOfWeek: z.enum(TIMETABLE_DAYS, {
    errorMap: () => ({ message: 'Invalid dayOfWeek. Must be MONDAY through SATURDAY.' }),
  }),
  periodNumber: z.number().int().min(0).max(25),
  classId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid classId format.'),
  sectionId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid sectionId format.'),
  subjectId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid subjectId format.').optional().nullable(),
  teacherId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid teacherId format.').optional().nullable(),
  roomNumber: safeString(30).optional().default(''),
}).strict();

export const manageTimetableSchema = z.object({
  schoolId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid schoolId format.'),
  academicYear: safeString(20, 4, 'academicYear is required (e.g. 2025-2026).'),
  status: z.enum(Object.values(TIMETABLE_STATUS)).optional().default(TIMETABLE_STATUS.ACTIVE),
  version: z.number().int().min(1).optional(),
  periodSlots: z.array(periodSlotSchema).min(1, 'At least one period slot is required.'),
  schedule: z.array(scheduleEntrySchema).default([]),
}).strict().superRefine((data, refinementContext) => {
  // 1. Verify periodSlots uniqueness by periodNumber
  const registeredPeriodNumbers = new Set();
  for (const slot of data.periodSlots) {
    if (registeredPeriodNumbers.has(slot.periodNumber)) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate periodNumber (${slot.periodNumber}) found in periodSlots.`,
        path: ['periodSlots'],
      });
      return;
    }
    registeredPeriodNumbers.add(slot.periodNumber);
  }

  // 2. Verify periodSlots do not overlap in time
  const chronologicallySortedSlots = [...data.periodSlots].sort((slotA, slotB) =>
    slotA.startTime.localeCompare(slotB.startTime)
  );
  for (let index = 0; index < chronologicallySortedSlots.length - 1; index++) {
    const currentSlot = chronologicallySortedSlots[index];
    const nextSlot = chronologicallySortedSlots[index + 1];
    if (currentSlot.endTime > nextSlot.startTime) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Period slot '${currentSlot.label}' (${currentSlot.startTime}-${currentSlot.endTime}) overlaps with '${nextSlot.label}' (${nextSlot.startTime}-${nextSlot.endTime}).`,
        path: ['periodSlots'],
      });
      return;
    }
  }

  // 3. Verify every schedule entry periodNumber exists in periodSlots
  const slotMapByNumber = new Map(data.periodSlots.map((slot) => [slot.periodNumber, slot]));
  for (let entryIndex = 0; entryIndex < data.schedule.length; entryIndex++) {
    const entry = data.schedule[entryIndex];
    const correspondingSlot = slotMapByNumber.get(entry.periodNumber);

    if (!correspondingSlot) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Schedule entry references non-existent periodNumber ${entry.periodNumber}.`,
        path: ['schedule', entryIndex, 'periodNumber'],
      });
      return;
    }

    // 4. Verify TEACHING entries cannot target non-teaching slots (ASSEMBLY, RECESS)
    if (['ASSEMBLY', 'RECESS'].includes(correspondingSlot.slotType)) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot schedule subject class entry during non-teaching slot '${correspondingSlot.label}' (${correspondingSlot.slotType}).`,
        path: ['schedule', entryIndex, 'periodNumber'],
      });
      return;
    }
  }
});
