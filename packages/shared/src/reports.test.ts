import { describe, expect, it } from 'vitest';
import {
  csvField,
  csvRupees,
  eachDay,
  monthWindows,
  reportRangeSchema,
  REPORT_MAX_DAYS,
  toCsv,
} from './reports';

describe('reportRangeSchema', () => {
  it('accepts a day, a week and the longest range', () => {
    expect(reportRangeSchema.safeParse({ from: '2026-10-26', to: '2026-10-26' }).success).toBe(
      true,
    );
    expect(reportRangeSchema.safeParse({ from: '2026-10-20', to: '2026-10-26' }).success).toBe(
      true,
    );
    expect(reportRangeSchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
      true,
    );
  });
  it('rejects a reversed range, a range over a year and a malformed date', () => {
    const msg = (v: unknown) => {
      const r = reportRangeSchema.safeParse(v);
      return r.success ? null : r.error.issues[0]!.message;
    };
    expect(msg({ from: '2026-10-27', to: '2026-10-26' })).toBe('validation.dateRange');
    expect(msg({ from: '2025-10-25', to: '2026-10-26' })).toBe('validation.rangeTooLong');
    expect(msg({ from: '26-10-2026', to: '2026-10-26' })).toBe('validation.date');
    expect(REPORT_MAX_DAYS).toBe(366);
  });
});

describe('monthWindows', () => {
  it('gives this month, last month and the same day last month', () => {
    expect(monthWindows('2026-10-26')).toEqual({
      monthStart: '2026-10-01',
      prevMonthStart: '2026-09-01',
      prevMonthEnd: '2026-09-30',
      prevSameDay: '2026-09-26',
    });
  });
  it('clamps the day to a shorter previous month and crosses the year', () => {
    expect(monthWindows('2026-03-31').prevSameDay).toBe('2026-02-28');
    expect(monthWindows('2026-01-15')).toMatchObject({
      prevMonthStart: '2025-12-01',
      prevMonthEnd: '2025-12-31',
      prevSameDay: '2025-12-15',
    });
  });
});

describe('eachDay', () => {
  it('lists every day inclusive, across a month end', () => {
    expect(eachDay('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(eachDay('2026-10-26', '2026-10-26')).toEqual(['2026-10-26']);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('l1\nl2')).toBe('"l1\nl2"');
    expect(csvField(null)).toBe('');
    expect(csvField(12n)).toBe('12');
  });
  it('defuses spreadsheet formulas in text but not in numbers', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+91 98765')).toBe("'+91 98765");
    expect(csvField('@sum')).toBe("'@sum");
    expect(csvField('-5.00')).toBe('-5.00');
    expect(csvField(-5)).toBe('-5');
  });
  it('writes rupees as plain decimals', () => {
    expect(csvRupees(123_456_78n)).toBe('123456.78');
    expect(csvRupees(-50_000n)).toBe('-500.00');
    expect(csvRupees(5n)).toBe('0.05');
  });
  it('joins rows with CRLF behind a BOM', () => {
    expect(
      toCsv([
        ['a', 'b'],
        [1, 'x,y'],
      ]),
    ).toBe('﻿a,b\r\n1,"x,y"\r\n');
  });
});
