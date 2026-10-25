import { describe, expect, it } from 'vitest';
import { financialYearOf, financialYearOfStart, istCalendarDate, istDateString } from './fy';

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
