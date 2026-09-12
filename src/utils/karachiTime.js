/**
 * Pakistan Standard Time (PKT / Asia/Karachi) Timezone Utilities
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Guaranteed immunity against host system / Docker / cloud UTC clock drift.
 * Uses native ECMAScript Internationalization API (Intl).
 */

const TIMEZONE = 'Asia/Karachi';

/**
 * Returns current time in Karachi as "HH:mm" in 24-hour format
 * @param {Date} [date=new Date()]
 * @returns {string} e.g. "08:15"
 */
export const getKarachiTimeString = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
};

/**
 * Returns current date in Karachi as "YYYY-MM-DD"
 * @param {Date} [date=new Date()]
 * @returns {string} e.g. "2026-09-13"
 */
export const getKarachiDateString = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
};

/**
 * Returns current day of week in Karachi (0 = Sunday, 5 = Friday, 6 = Saturday)
 * @param {Date} [date=new Date()]
 * @returns {number}
 */
export const getKarachiDayOfWeek = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  });
  const weekday = formatter.format(date);
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return days[weekday] !== undefined ? days[weekday] : 1;
};

/**
 * Parses a "YYYY-MM-DD" string or Date object into a normalized PKT date string
 * @param {string|Date} val
 * @returns {string} e.g. "2026-09-13"
 */
export const normalizeToKarachiDate = (val) => {
  if (!val) return getKarachiDateString();
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return val;
  }
  return getKarachiDateString(new Date(val));
};
