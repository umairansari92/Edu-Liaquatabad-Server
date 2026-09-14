const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteenth', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'
];

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'
];

const DAYS_ORDINAL = [
  '', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth',
  'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth',
  'Twenty-First', 'Twenty-Second', 'Twenty-Third', 'Twenty-Fourth', 'Twenty-Fifth', 'Twenty-Sixth', 'Twenty-Seventh', 'Twenty-Eighth', 'Twenty-Ninth', 'Thirtieth',
  'Thirty-First'
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const numberToWordsBelowThousand = (num) => {
  if (num === 0) return '';
  if (num < 20) return ONES[num];
  if (num < 100) {
    const ten = TENS[Math.floor(num / 10)];
    const remainder = num % 10;
    return remainder ? `${ten}-${ONES[remainder]}` : ten;
  }
  const hundred = `${ONES[Math.floor(num / 100)]} Hundred`;
  const remainder = num % 100;
  return remainder ? `${hundred} ${numberToWordsBelowThousand(remainder)}` : hundred;
};

const yearToWords = (year) => {
  if (year >= 2000 && year <= 2099) {
    const remainder = year - 2000;
    if (remainder === 0) return 'Two Thousand';
    return `Two Thousand ${numberToWordsBelowThousand(remainder)}`;
  }
  if (year >= 1900 && year <= 1999) {
    const firstTwo = Math.floor(year / 100);
    const lastTwo = year % 100;
    const firstPart = numberToWordsBelowThousand(firstTwo);
    const lastPart = lastTwo === 0 ? 'Hundred' : numberToWordsBelowThousand(lastTwo);
    return `${firstPart} ${lastPart}`;
  }
  return String(year);
};

/**
 * Converts a Date or YYYY-MM-DD string into official spoken English words.
 * Example: '2015-08-14' -> 'Fourteenth of August Two Thousand Fifteen'
 *
 * @param {Date|string} dateInput
 * @returns {string} Date in words or empty string if invalid
 */
export const convertDateToWords = (dateInput) => {
  if (!dateInput) return '';
  const parsed = new Date(dateInput);
  if (isNaN(parsed.getTime())) return '';

  const day = parsed.getUTCDate();
  const month = parsed.getUTCMonth();
  const year = parsed.getUTCFullYear();

  const dayWord = DAYS_ORDINAL[day] || `${day}th`;
  const monthWord = MONTHS[month] || '';
  const yearWord = yearToWords(year);

  return `${dayWord} of ${monthWord} ${yearWord}`.trim();
};

export default convertDateToWords;
