import { describe, expect, it } from 'vitest';
import {
  financialYearBounds,
  financialYearOf,
  financialYearOfDate,
  financialYearOfStart,
  istCalendarDate,
  istDateString,
  nextFinancialYear,
  parseFinancialYearLabel,
} from './fy';

describe('istCalendarDate / istDateString', () => {
  it('uses the Asia/Kolkata day (UTC+05:30)', () => {
    expect(istDateString(new Date('2026-10-24T18:29:59.999Z'))).toBe('2026-10-24');
    expect(istDateString(new Date('2026-10-24T18:30:00.000Z'))).toBe('2026-10-25');
    expect(istCalendarDate(new Date('2026-12-31T19:00:00Z'))).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  it('rejects invalid dates', () => {
    expect(() => istDateString(new Date('nope'))).toThrow(RangeError);
  });
});

describe('financialYearOf', () => {
  it('runs April to March', () => {
    expect(financialYearOf(new Date('2026-10-25T06:00:00Z')).label).toBe('2026-27');
    expect(financialYearOf(new Date('2027-02-15T06:00:00Z')).label).toBe('2026-27');
    expect(financialYearOf(new Date('2027-04-15T06:00:00Z')).label).toBe('2027-28');
  });

  it('rolls over at 1 April 00:00 IST, not UTC', () => {
    // 31-Mar-2027 23:59:59 IST
    expect(financialYearOf(new Date('2027-03-31T18:29:59Z')).short).toBe('26-27');
    // 01-Apr-2027 00:00:00 IST (still 31 March in UTC)
    expect(financialYearOf(new Date('2027-03-31T18:30:00Z')).short).toBe('27-28');
  });

  it('formats century boundaries', () => {
    expect(financialYearOfStart(2099)).toEqual({
      startYear: 2099,
      label: '2099-00',
      short: '99-00',
    });
    expect(() => financialYearOfStart(26.5)).toThrow(RangeError);
  });
});

describe('financial year helpers', () => {
  it('maps calendar dates to a FY', () => {
    expect(financialYearOfDate({ year: 2027, month: 3, day: 31 }).label).toBe('2026-27');
    expect(financialYearOfDate({ year: 2027, month: 4, day: 1 }).label).toBe('2027-28');
    expect(financialYearOfDate({ year: 2026, month: 12, day: 25 }).short).toBe('26-27');
  });

  it('parses stored labels and rejects inconsistent ones', () => {
    expect(parseFinancialYearLabel('2026-27').startYear).toBe(2026);
    expect(parseFinancialYearLabel('2099-00').startYear).toBe(2099);
    for (const bad of ['2026-28', '26-27', '2026', '2026-2027', '']) {
      expect(() => parseFinancialYearLabel(bad)).toThrow(RangeError);
    }
  });

  it('gives inclusive date bounds and exclusive IST instants', () => {
    const b = financialYearBounds(financialYearOfStart(2026));
    expect(b.startDate).toBe('2026-04-01');
    expect(b.endDate).toBe('2027-03-31');
    expect(b.startsAt.toISOString()).toBe('2026-03-31T18:30:00.000Z');
    expect(b.endsBefore.toISOString()).toBe('2027-03-31T18:30:00.000Z');
    expect(financialYearOf(b.startsAt).label).toBe('2026-27');
    expect(financialYearOf(new Date(b.endsBefore.getTime() - 1)).label).toBe('2026-27');
    expect(financialYearOf(b.endsBefore).label).toBe('2027-28');
  });

  it('computes the next FY', () => {
    expect(nextFinancialYear(financialYearOfStart(2026)).label).toBe('2027-28');
  });
});
