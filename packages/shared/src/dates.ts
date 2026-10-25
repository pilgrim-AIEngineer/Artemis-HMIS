import { BUSINESS_TIME_ZONE, istCalendarDate, type CalendarDate } from './fy';

/**
 * Date display and clinical-date arithmetic (docs/02 §3).
 *  - Instants (`timestamptz`) display in Asia/Kolkata; hindi uses the same Latin digits and month names.
 *  - Clinical dates (DOB, LMP, EDD, vaccine due) are plain `YYYY-MM-DD` with no time zone and are
 *    never shifted by a zone conversion.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const timeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const pad2 = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- calendar dates

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidCalendarDate(d: CalendarDate): boolean {
  return (
    Number.isInteger(d.year) &&
    Number.isInteger(d.month) &&
    Number.isInteger(d.day) &&
    d.year >= 1 &&
    d.year <= 9999 &&
    d.month >= 1 &&
    d.month <= 12 &&
    d.day >= 1 &&
    d.day <= daysInMonth(d.year, d.month)
  );
}

/** Parses `YYYY-MM-DD`; throws on anything else (including `2026-02-30`). */
export function parseIsoDate(s: string): CalendarDate {
  const m = ISO_DATE.exec(s);
  const d = m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
  if (!d || !isValidCalendarDate(d)) throw new RangeError(`Invalid date: ${JSON.stringify(s)}`);
  return d;
}

export function toIsoDate(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

const utcMs = (d: CalendarDate) => Date.UTC(d.year, d.month - 1, d.day);
const fromUtcMs = (ms: number): CalendarDate => {
  const x = new Date(ms);
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
};

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((utcMs(b) - utcMs(a)) / 86_400_000);
}

export function addDays(d: CalendarDate, days: number): CalendarDate {
  return fromUtcMs(utcMs(d) + days * 86_400_000);
}

/** Adds calendar months; the day clamps to the end of a shorter month (31-Jan + 1m = 28/29-Feb). */
export function addMonths(d: CalendarDate, months: number): CalendarDate {
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}

/** Today's date on the IST calendar (or the IST day of the given instant). */
export function istToday(now: Date = new Date()): CalendarDate {
  return istCalendarDate(now);
}

// ---------------------------------------------------------------- display

export function formatCalendarDate(d: CalendarDate): string {
  return `${pad2(d.day)}-${MONTHS[d.month - 1]}-${d.year}`;
}

/**
 * `23-Oct-2026`. An instant is shown on the IST day; a `YYYY-MM-DD` string (a `date` column) is
 * shown as written.
 */
export function formatDate(value: Date | string): string {
  return formatCalendarDate(
    typeof value === 'string' ? parseIsoDate(value) : istCalendarDate(value),
  );
}

/** `23-Oct-2026 10:42` (24-hour, IST). */
export function formatDateTime(at: Date): string {
  const time = timeParts.format(at); // throws RangeError on invalid dates
  return `${formatCalendarDate(istCalendarDate(at))} ${time}`;
}

// ---------------------------------------------------------------- age

export type AgeUnit = 'days' | 'months' | 'years';

export interface Age {
  unit: AgeUnit;
  value: number;
}

/**
 * docs/02 §3: under 1 month → days, under 2 years → months, otherwise years.
 * Completed units only (a 29-day-old is "29 days"; 23 months 29 days is "23 months").
 */
export function ageFromDob(
  dob: CalendarDate | string,
  today: CalendarDate | Date = new Date(),
): Age {
  const b = typeof dob === 'string' ? parseIsoDate(dob) : dob;
  const t = today instanceof Date ? istCalendarDate(today) : today;
  if (compareDates(b, t) > 0) throw new RangeError('Date of birth is in the future');
  const months = (t.year - b.year) * 12 + (t.month - b.month) - (t.day < b.day ? 1 : 0);
  if (months < 1) return { unit: 'days', value: daysBetween(b, t) };
  if (months < 24) return { unit: 'months', value: months };
  return { unit: 'years', value: Math.floor(months / 12) };
}

/** i18n message key for an age; the catalogue uses ICU plurals on `count` (en + hi). */
export function ageMessage(age: Age): { key: `age.${AgeUnit}`; count: number } {
  return { key: `age.${age.unit}`, count: age.value };
}

// ---------------------------------------------------------------- estimated DOB

export const MAX_AGE_YEARS = 120;

const AGE_INPUT = /^(\d{1,3})\s*([ymd]?)$/i;

/** Registration age field (docs/10 §3): `25`, `25y`, `6m`, `15d` (bare number = years). */
export function parseAgeInput(input: string): Age | null {
  const m = AGE_INPUT.exec(input.trim());
  if (!m) return null;
  const value = Number(m[1]);
  const letter = (m[2] ?? '').toLowerCase();
  const unit: AgeUnit = letter === 'm' ? 'months' : letter === 'd' ? 'days' : 'years';
  if (unit === 'years' && value > MAX_AGE_YEARS) return null;
  if (unit === 'months' && value > MAX_AGE_YEARS * 12) return null;
  if (unit === 'days' && value > 3660) return null;
  return { unit, value };
}

/**
 * Estimated DOB for age-only registrations (the caller stores `dob_is_estimated = true`).
 *  - Days / months, and years under 2 (where the age is displayed in months): today minus the age.
 *  - Years ≥ 2: 1 July of the birth year. The birth year is chosen so that `ageFromDob` shows the
 *    entered age again (before 1 July that means one year earlier than `today.year − n`).
 */
export function estimateDob(age: Age, today: CalendarDate | Date = new Date()): CalendarDate {
  const t = today instanceof Date ? istCalendarDate(today) : today;
  if (!Number.isInteger(age.value) || age.value < 0) throw new RangeError('Invalid age');
  switch (age.unit) {
    case 'days':
      return addDays(t, -age.value);
    case 'months':
      return addMonths(t, -age.value);
    case 'years': {
      if (age.value < 2) return addMonths(t, -12 * age.value);
      const julyFirstPassed = t.month > 7 || (t.month === 7 && t.day >= 1);
      const year = julyFirstPassed ? t.year - age.value : t.year - age.value - 1;
      return { year, month: 7, day: 1 };
    }
  }
}
