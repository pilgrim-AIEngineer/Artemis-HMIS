import { describe, expect, it } from 'vitest';
import {
  formatSeriesNumber,
  NUMBER_SERIES,
  numberSeriesConfigSchema,
  resolveSeriesDefinition,
  seriesPeriod,
} from './number-series';

describe('formatSeriesNumber (docs/02 §4 formats)', () => {
  it.each([
    ['UH', null, 123, 6, 'UH-000123'],
    ['GH', null, 123, 6, 'GH-000123'],
    ['OP', '26-27', 4512, 6, 'OP/26-27/004512'],
    ['IP', '26-27', 321, 5, 'IP/26-27/00321'],
    ['GRN', '26-27', 456, 5, 'GRN/26-27/00456'],
    ['FF', '2026', 1, 4, 'FF/2026/0001'],
    ['MTP', '2026', 1, 3, 'MTP/2026/001'],
  ])('%s %s %d → %s', (prefix, label, value, padding, expected) => {
    expect(formatSeriesNumber(prefix, label, value, padding)).toBe(expected);
  });

  it('grows past the padding instead of truncating', () => {
    expect(formatSeriesNumber('MTP', '2026', 1234, 3)).toBe('MTP/2026/1234');
  });

  it('rejects non-positive or fractional values', () => {
    expect(() => formatSeriesNumber('OP', '26-27', 0, 6)).toThrow(RangeError);
    expect(() => formatSeriesNumber('OP', '26-27', 1.5, 6)).toThrow(RangeError);
  });
});

describe('seriesPeriod', () => {
  const lastDayOfFy = new Date('2027-03-31T18:29:59Z'); // 31-Mar-2027 23:59:59 IST
  const firstDayOfFy = new Date('2027-03-31T18:30:00Z'); // 01-Apr-2027 00:00 IST
  const newYearIst = new Date('2026-12-31T18:30:00Z'); // 01-Jan-2027 00:00 IST

  it('never-reset series share one period', () => {
    expect(seriesPeriod('never', lastDayOfFy)).toEqual({ period: 'all', label: null });
  });

  it('FY series switch on 1 April IST', () => {
    expect(seriesPeriod('fy', lastDayOfFy)).toEqual({ period: '2026-27', label: '26-27' });
    expect(seriesPeriod('fy', firstDayOfFy)).toEqual({ period: '2027-28', label: '27-28' });
  });

  it('calendar series switch on 1 January IST', () => {
    expect(seriesPeriod('calendar', new Date('2026-12-31T18:29:59Z')).period).toBe('2026');
    expect(seriesPeriod('calendar', newYearIst)).toEqual({ period: '2027', label: '2027' });
  });
});

describe('numberSeriesConfigSchema / resolveSeriesDefinition', () => {
  it('defaults match docs/02 §4', () => {
    expect(NUMBER_SERIES.uhid.reset).toBe('never');
    expect(NUMBER_SERIES.opd_visit).toEqual({ reset: 'fy', prefix: 'OP', padding: 6 });
    expect(NUMBER_SERIES.form_f.reset).toBe('calendar');
    expect(resolveSeriesDefinition('opd_bill')).toEqual({ reset: 'fy', prefix: 'OB', padding: 6 });
  });

  it('applies per-key overrides from the setting', () => {
    const config = numberSeriesConfigSchema.parse({
      uhid: { prefix: 'GH' },
      form_f: { reset: 'fy' },
    });
    expect(resolveSeriesDefinition('uhid', config)).toEqual({
      reset: 'never',
      prefix: 'GH',
      padding: 6,
    });
    expect(resolveSeriesDefinition('form_f', config).reset).toBe('fy');
  });

  it('rejects unknown keys and unsafe prefixes', () => {
    expect(numberSeriesConfigSchema.safeParse({ token: { prefix: 'T' } }).success).toBe(false);
    expect(numberSeriesConfigSchema.safeParse({ uhid: { prefix: 'G/H' } }).success).toBe(false);
    expect(numberSeriesConfigSchema.safeParse({ uhid: { colour: 'red' } }).success).toBe(false);
    expect(numberSeriesConfigSchema.parse(undefined)).toEqual({});
  });
});
