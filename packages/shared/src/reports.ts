/**
 * Reports and the owner dashboard (RPT-01, RPT-02, docs/20): the date-range input every report
 * takes, the CSV writer behind "Export", and the small pure helpers the report queries share.
 * Reports are read-only; nothing here touches money or clinical state.
 */
import { z } from 'zod';
import { formatINR, type Paise } from './money';
import { addDays, daysBetween, parseIsoDate, toIsoDate } from './dates';

/** Longest range a report accepts, so one click cannot scan years of receipts at the counter. */
export const REPORT_MAX_DAYS = 366;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date');

/** `from` and `to` are IST calendar days, both inclusive. */
export const reportRangeSchema = z.object({ from: isoDate, to: isoDate }).superRefine((r, ctx) => {
  const span = daysBetween(parseIsoDate(r.from), parseIsoDate(r.to));
  if (span < 0) ctx.addIssue({ code: 'custom', message: 'validation.dateRange', path: ['to'] });
  else if (span >= REPORT_MAX_DAYS) {
    ctx.addIssue({ code: 'custom', message: 'validation.rangeTooLong', path: ['to'] });
  }
});
export type ReportRange = z.output<typeof reportRangeSchema>;

export const opdCensusInputSchema = z.object({
  from: isoDate,
  to: isoDate,
  doctorId: z.uuid().optional(),
});

export const ancRegisterInputSchema = z.object({
  /** Only pregnancies carrying this risk flag code (the high-risk list). */
  risk: z.string().min(1).max(40).optional(),
  /** EDDs from today to this many days ahead are listed separately. */
  eddWithinDays: z.number().int().min(1).max(120).default(30),
});

export const vaccinesDueInputSchema = z.object({
  aheadDays: z.number().int().min(0).max(60).default(7),
});

/** A visit this many days past its suggested date is "missed" and goes on the call list (docs/20 §2). */
export const ANC_MISSED_AFTER_DAYS = 7;

/** Days of history on the owner dashboard trend lines. */
export const DASHBOARD_TREND_DAYS = 30;

export const REPORT_KEYS = ['collection', 'opd', 'anc', 'vaccines', 'adjustments'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const isReportKey = (v: string): v is ReportKey =>
  (REPORT_KEYS as readonly string[]).includes(v);

/** Permission that opens each report (docs/03 §2): money reports vs clinical lists. */
export const REPORT_PERMISSION = {
  collection: 'reports.collection',
  opd: 'reports.clinical',
  anc: 'reports.clinical',
  vaccines: 'reports.clinical',
  adjustments: 'reports.financial',
} as const satisfies Record<ReportKey, string>;

/** First day of the month of `date`, and the same day-of-month (clamped) in the previous month. */
export function monthWindows(today: string): {
  monthStart: string;
  prevMonthStart: string;
  prevMonthEnd: string;
  prevSameDay: string;
} {
  const t = parseIsoDate(today);
  const monthStart = toIsoDate({ ...t, day: 1 });
  const prevEnd = addDays(parseIsoDate(monthStart), -1);
  const prevMonthStart = toIsoDate({ ...prevEnd, day: 1 });
  const sameDay = Math.min(t.day, prevEnd.day);
  return {
    monthStart,
    prevMonthStart,
    prevMonthEnd: toIsoDate(prevEnd),
    prevSameDay: toIsoDate({ ...prevEnd, day: sameDay }),
  };
}

/** Every day from `from` to `to` inclusive (trend lines show zero days too). */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = parseIsoDate(from); daysBetween(d, parseIsoDate(to)) >= 0; d = addDays(d, 1)) {
    out.push(toIsoDate(d));
  }
  return out;
}

// ---------------------------------------------------------------- CSV

export type CsvCell = string | number | bigint | boolean | null | undefined;

/**
 * One CSV field. Quotes when needed; a cell that a spreadsheet would run as a formula
 * (`=`, `+`, `-`, `@`, tab, CR at the start; plain numbers like `-5.00` are left alone) gets a leading apostrophe so a patient name
 * typed as `=HYPERLINK(...)` cannot execute when the owner opens the export.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && !PLAIN_NUMBER.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Plain rupee decimal for a spreadsheet: `1234.50`, no symbol, no grouping. */
export const csvRupees = (paise: Paise): string =>
  formatINR(paise, { symbol: false }).replaceAll(',', '');

/**
 * Rows → CSV text with CRLF line ends and a UTF-8 BOM (Excel then reads Hindi names right).
 * Numbers and bigints are written as is: only strings are guarded against formulas.
 */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${rows.map((r) => r.map((c) => csvField(c)).join(',')).join('\r\n')}\r\n`;
}
