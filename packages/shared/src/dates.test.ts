import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  ageFromDob,
  ageMessage,
  compareDates,
  daysBetween,
  estimateDob,
  formatCalendarDate,
  formatDate,
  formatDateTime,
  isValidCalendarDate,
  istToday,
  parseAgeInput,
  parseIsoDate,
  toIsoDate,
} from './dates';

const d = (s: string) => parseIsoDate(s);

describe('display formats (IST)', () => {
  it('formats 23-Oct-2026 and 23-Oct-2026 10:42', () => {
    const at = new Date('2026-10-23T05:12:00Z'); // 10:42 IST
    expect(formatDate(at)).toBe('23-Oct-2026');
    expect(formatDateTime(at)).toBe('23-Oct-2026 10:42');
  });

  it('uses the IST day, not the UTC day', () => {
    expect(formatDate(new Date('2026-10-23T20:00:00Z'))).toBe('24-Oct-2026');
    expect(formatDateTime(new Date('2026-12-31T18:30:00Z'))).toBe('01-Jan-2027 00:00');
    expect(formatDateTime(new Date('2026-10-23T18:29:00Z'))).toBe('23-Oct-2026 23:59');
  });

  it('uses a 24-hour clock with zero padding', () => {
    expect(formatDateTime(new Date('2026-03-05T03:35:00Z'))).toBe('05-Mar-2026 09:05');
    expect(formatDateTime(new Date('2026-03-05T12:00:00Z'))).toBe('05-Mar-2026 17:30');
  });

  it('shows clinical date strings as written, with no zone shift', () => {
    expect(formatDate('2026-10-23')).toBe('23-Oct-2026');
    expect(formatDate('2027-01-01')).toBe('01-Jan-2027');
    expect(formatCalendarDate({ year: 2026, month: 2, day: 9 })).toBe('09-Feb-2026');
  });

  it('rejects invalid input', () => {
    expect(() => formatDate(new Date('x'))).toThrow(RangeError);
    expect(() => formatDateTime(new Date('x'))).toThrow(RangeError);
    expect(() => formatDate('2026-02-30')).toThrow(RangeError);
  });

  it('names all twelve months', () => {
    const names = Array.from({ length: 12 }, (_, i) =>
      formatCalendarDate({ year: 2026, month: i + 1, day: 1 }),
    );
    expect(names.map((n) => n.slice(3, 6))).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });
});

describe('calendar arithmetic', () => {
  it('validates dates including leap years', () => {
    expect(isValidCalendarDate(d('2028-02-29'))).toBe(true);
    expect(() => parseIsoDate('2027-02-29')).toThrow(RangeError);
    expect(() => parseIsoDate('2026-13-01')).toThrow(RangeError);
    expect(() => parseIsoDate('26-10-23')).toThrow(RangeError);
    expect(isValidCalendarDate({ year: 2026, month: 0, day: 1 })).toBe(false);
  });

  it('adds days and months with end-of-month clamping', () => {
    expect(toIsoDate(addDays(d('2026-12-31'), 1))).toBe('2027-01-01');
    expect(toIsoDate(addDays(d('2026-03-01'), -1))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(d('2027-12-31'), 2))).toBe('2028-02-29');
    expect(toIsoDate(addMonths(d('2026-03-15'), -4))).toBe('2025-11-15');
    expect(toIsoDate(addMonths(d('2026-01-15'), -1))).toBe('2025-12-15');
  });

  it('counts days between dates', () => {
    expect(daysBetween(d('2026-10-01'), d('2026-10-23'))).toBe(22);
    expect(daysBetween(d('2026-10-23'), d('2026-10-01'))).toBe(-22);
    expect(daysBetween(d('2028-02-28'), d('2028-03-01'))).toBe(2);
    expect(compareDates(d('2026-10-01'), d('2026-10-02'))).toBeLessThan(0);
  });

  it('istToday follows the IST calendar', () => {
    expect(toIsoDate(istToday(new Date('2026-10-23T19:00:00Z')))).toBe('2026-10-24');
  });
});

describe('ageFromDob (docs/02 §3)', () => {
  const today = d('2026-10-23');
  it.each([
    ['2026-10-23', 'days', 0],
    ['2026-10-22', 'days', 1],
    ['2026-10-01', 'days', 22],
    ['2026-09-24', 'days', 29],
    ['2026-09-23', 'months', 1],
    ['2026-04-23', 'months', 6],
    ['2025-10-23', 'months', 12],
    ['2024-10-24', 'months', 23],
    ['2024-10-23', 'years', 2],
    ['2024-10-24', 'months', 23],
    ['2001-07-01', 'years', 25],
    ['2001-10-24', 'years', 24],
    ['1926-10-23', 'years', 100],
  ] as const)('dob %s → %i %s', (dob, unit, value) => {
    expect(ageFromDob(dob, today)).toEqual({ unit, value });
  });

  it('switches from days to months on the calendar month boundary, not at 30 days', () => {
    expect(ageFromDob('2026-01-31', d('2026-02-28'))).toEqual({ unit: 'days', value: 28 });
    expect(ageFromDob('2026-01-30', d('2026-03-01'))).toEqual({ unit: 'months', value: 1 });
    expect(ageFromDob('2026-01-01', d('2026-01-31'))).toEqual({ unit: 'days', value: 30 });
  });

  it('accepts an instant as today (IST day)', () => {
    expect(ageFromDob('2026-10-24', new Date('2026-10-23T19:00:00Z'))).toEqual({
      unit: 'days',
      value: 0,
    });
  });

  it('rejects a DOB in the future', () => {
    expect(() => ageFromDob('2026-10-24', today)).toThrow(RangeError);
  });

  it('exposes i18n message keys for ICU plurals', () => {
    expect(ageMessage({ unit: 'months', value: 8 })).toEqual({ key: 'age.months', count: 8 });
  });
});

describe('parseAgeInput', () => {
  it.each([
    ['25', { unit: 'years', value: 25 }],
    ['25y', { unit: 'years', value: 25 }],
    ['25Y', { unit: 'years', value: 25 }],
    [' 6m ', { unit: 'months', value: 6 }],
    ['15d', { unit: 'days', value: 15 }],
    ['6 m', { unit: 'months', value: 6 }],
    ['0d', { unit: 'days', value: 0 }],
  ] as const)('%j', (input, expected) => {
    expect(parseAgeInput(input)).toEqual(expected);
  });

  it.each(['', 'abc', '-5', '2.5', '25x', '121', '1441m', '4000d', 'y'])('rejects %j', (input) => {
    expect(parseAgeInput(input)).toBeNull();
  });
});

describe('estimateDob', () => {
  const today = d('2026-10-23');

  it('years ≥ 2 → 1 July of the birth year', () => {
    expect(toIsoDate(estimateDob({ unit: 'years', value: 25 }, today))).toBe('2001-07-01');
    expect(toIsoDate(estimateDob({ unit: 'years', value: 2 }, today))).toBe('2024-07-01');
  });

  it('chooses the birth year so the entered age is shown back (before 1 July)', () => {
    const early = d('2026-03-10');
    const dob = estimateDob({ unit: 'years', value: 25 }, early);
    expect(toIsoDate(dob)).toBe('2000-07-01');
    expect(ageFromDob(dob, early)).toEqual({ unit: 'years', value: 25 });
  });

  it('flips exactly on 1 July', () => {
    expect(toIsoDate(estimateDob({ unit: 'years', value: 30 }, d('2026-06-30')))).toBe(
      '1995-07-01',
    );
    expect(toIsoDate(estimateDob({ unit: 'years', value: 30 }, d('2026-07-01')))).toBe(
      '1996-07-01',
    );
  });

  it('infants: today minus months or days', () => {
    expect(toIsoDate(estimateDob({ unit: 'months', value: 6 }, today))).toBe('2026-04-23');
    expect(toIsoDate(estimateDob({ unit: 'days', value: 15 }, today))).toBe('2026-10-08');
    expect(toIsoDate(estimateDob({ unit: 'days', value: 0 }, today))).toBe('2026-10-23');
    expect(toIsoDate(estimateDob({ unit: 'months', value: 18 }, d('2026-08-31')))).toBe(
      '2025-02-28',
    );
  });

  it('0 and 1 year use today minus months so the age shows in months', () => {
    expect(toIsoDate(estimateDob({ unit: 'years', value: 1 }, today))).toBe('2025-10-23');
    expect(ageFromDob(estimateDob({ unit: 'years', value: 1 }, today), today)).toEqual({
      unit: 'months',
      value: 12,
    });
    expect(toIsoDate(estimateDob({ unit: 'years', value: 0 }, today))).toBe('2026-10-23');
  });

  it('rejects invalid ages', () => {
    expect(() => estimateDob({ unit: 'years', value: -1 }, today)).toThrow(RangeError);
    expect(() => estimateDob({ unit: 'days', value: 1.5 }, today)).toThrow(RangeError);
  });

  it('property: ageFromDob(estimateDob(age)) returns the entered age (≥ 2 years, ≥ 1 month, < 2 years)', () => {
    const dayArb = fc
      .record({
        year: fc.integer({ min: 2000, max: 2100 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
      })
      .map((x) => x);
    fc.assert(
      fc.property(dayArb, fc.integer({ min: 2, max: 110 }), (t, years) => {
        const dob = estimateDob({ unit: 'years', value: years }, t);
        expect(ageFromDob(dob, t)).toEqual({ unit: 'years', value: years });
        expect(dob.month).toBe(7);
        expect(dob.day).toBe(1);
      }),
    );
    fc.assert(
      fc.property(dayArb, fc.integer({ min: 1, max: 23 }), (t, months) => {
        expect(ageFromDob(estimateDob({ unit: 'months', value: months }, t), t)).toEqual({
          unit: 'months',
          value: months,
        });
      }),
    );
    fc.assert(
      fc.property(dayArb, fc.integer({ min: 0, max: 27 }), (t, days) => {
        expect(ageFromDob(estimateDob({ unit: 'days', value: days }, t), t)).toEqual({
          unit: 'days',
          value: days,
        });
      }),
    );
  });
});
