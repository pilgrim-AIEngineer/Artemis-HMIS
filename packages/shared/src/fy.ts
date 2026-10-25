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

/** FY containing a calendar date (no time component). */
export function financialYearOfDate(d: CalendarDate): FinancialYear {
  return financialYearOfStart(d.month >= 4 ? d.year : d.year - 1);
}

/** Parses a stored FY label (`2026-27`); rejects labels whose end year is not start + 1. */
export function parseFinancialYearLabel(label: string): FinancialYear {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  const startYear = m ? Number(m[1]) : NaN;
  const fy = Number.isFinite(startYear) ? financialYearOfStart(startYear) : null;
  if (!fy || fy.label !== label) throw new RangeError(`Invalid financial year: ${label}`);
  return fy;
}

export interface FinancialYearBounds {
  fy: FinancialYear;
  /** `2026-04-01` */
  startDate: string;
  /** `2027-03-31` (inclusive) */
  endDate: string;
  /** 1 April 00:00 IST as an instant. */
  startsAt: Date;
  /** 1 April 00:00 IST of the next FY (exclusive upper bound for `timestamptz` ranges). */
  endsBefore: Date;
}

const IST_OFFSET_MINUTES = 330;
const istMidnightUtc = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MINUTES * 60_000);

export function financialYearBounds(fy: FinancialYear): FinancialYearBounds {
  const y = fy.startYear;
  return {
    fy,
    startDate: `${String(y).padStart(4, '0')}-04-01`,
    endDate: `${String(y + 1).padStart(4, '0')}-03-31`,
    startsAt: istMidnightUtc(y, 4, 1),
    endsBefore: istMidnightUtc(y + 1, 4, 1),
  };
}

/** The FY following `fy` (for rollover previews and series pre-creation). */
export function nextFinancialYear(fy: FinancialYear): FinancialYear {
  return financialYearOfStart(fy.startYear + 1);
}
