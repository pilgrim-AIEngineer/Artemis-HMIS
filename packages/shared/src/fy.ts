/**
 * Indian financial year (April–March, AGENTS.md rule 10) and IST calendar helpers.
 * Instants are stored as UTC `timestamptz`; business dates are the Asia/Kolkata calendar day.
 */

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

const istParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface CalendarDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

/** The Asia/Kolkata calendar day of an instant. */
export function istCalendarDate(at: Date): CalendarDate {
  if (Number.isNaN(at.getTime())) throw new RangeError('Invalid date');
  const parts = istParts.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** `YYYY-MM-DD` of the Asia/Kolkata calendar day (for `date` columns, e.g. `token_date`). */
export function istDateString(at: Date): string {
  const { year, month, day } = istCalendarDate(at);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface FinancialYear {
  /** Calendar year in which the FY starts (1 April). */
  startYear: number;
  /** `2026-27`: stored in `number_series.fy`. */
  label: string;
  /** `26-27`: used inside document numbers (`OP/26-27/004512`). */
  short: string;
}

export function financialYearOfStart(startYear: number): FinancialYear {
  if (!Number.isInteger(startYear) || startYear < 1000 || startYear > 9998) {
    throw new RangeError(`Invalid FY start year: ${startYear}`);
  }
  const end = startYear + 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return {
    startYear,
    label: `${startYear}-${yy(end)}`,
    short: `${yy(startYear)}-${yy(end)}`,
  };
}

/** FY of an instant, evaluated on the IST calendar (1 April 00:00 IST starts a new FY). */
export function financialYearOf(at: Date): FinancialYear {
  const { year, month } = istCalendarDate(at);
  return financialYearOfStart(month >= 4 ? year : year - 1);
}
