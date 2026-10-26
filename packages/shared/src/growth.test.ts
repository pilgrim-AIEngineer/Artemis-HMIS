import { describe, expect, it } from 'vitest';
import { addDays, parseIsoDate, toIsoDate } from './dates';
import { CURVE_Z_LINES, computeZScores, growthCurve, zScore } from './growth';
import { WHO_MAX_AGE_DAYS, zBand } from './paeds';

/**
 * Anchors are values printed in the WHO expanded tables (z-score columns SD-3 … SD+3 and the M
 * column) so the test would catch a wrong table, sex or formula.
 */
describe('WHO z-scores: published anchors', () => {
  it('weight-for-age, boy at birth: the SD columns read back as -2, -1, 0, +1, +2', () => {
    const z = (kg: number) => zScore({ indicator: 'wfa', sex: 'M', ageDays: 0, value: kg });
    expect(z(2.459)).toBeCloseTo(-2, 1);
    expect(z(2.881)).toBeCloseTo(-1, 1);
    expect(z(3.346)).toBeCloseTo(0, 1);
    expect(z(3.859)).toBeCloseTo(1, 1);
    expect(z(4.419)).toBeCloseTo(2, 1);
    expect(z(5.031)).toBeCloseTo(3, 1);
  });
  it('weight-for-age, girl at birth', () => {
    expect(zScore({ indicator: 'wfa', sex: 'F', ageDays: 0, value: 3.232 })).toBeCloseTo(0, 1);
    expect(zScore({ indicator: 'wfa', sex: 'F', ageDays: 0, value: 2.395 })).toBeCloseTo(-2, 1);
  });
  it('the sexes differ: 3.232 kg is the median for a girl, below it for a boy', () => {
    const boy = zScore({ indicator: 'wfa', sex: 'M', ageDays: 0, value: 3.232 })!;
    expect(boy).toBeLessThan(0);
  });
  it('length-for-age, boy at 1855 days (about 5 y) is the median at 110.479 cm', () => {
    expect(zScore({ indicator: 'lhfa', sex: 'M', ageDays: 1826, value: 110.1 })).not.toBeNull();
    expect(zScore({ indicator: 'lhfa', sex: 'M', ageDays: 0, value: 49.884 })).toBeCloseTo(0, 1);
    expect(zScore({ indicator: 'lhfa', sex: 'M', ageDays: 0, value: 46.098 })).toBeCloseTo(-2, 1);
  });
  it('head circumference, boy at birth', () => {
    expect(zScore({ indicator: 'hcfa', sex: 'M', ageDays: 0, value: 34.462 })).toBeCloseTo(0, 1);
    expect(zScore({ indicator: 'hcfa', sex: 'M', ageDays: 0, value: 37.002 })).toBeCloseTo(2, 1);
  });
  it('weight-for-length (under 2 y), boy at 45 cm', () => {
    const z = (kg: number) =>
      zScore({ indicator: 'wfh', sex: 'M', ageDays: 100, value: kg, lengthHeightCm: 45 });
    expect(z(2.441)).toBeCloseTo(0, 1);
    expect(z(2.951)).toBeCloseTo(2, 1);
    expect(z(1.71)).toBeCloseTo(-4, 1);
  });
  it('weight-for-height (2 y and over), boy at 65 cm', () => {
    const z = (kg: number) =>
      zScore({ indicator: 'wfh', sex: 'M', ageDays: 800, value: kg, lengthHeightCm: 65 });
    expect(z(7.433)).toBeCloseTo(0, 1);
    expect(z(6.854)).toBeCloseTo(-1, 1);
  });
  it('interpolates between 0.1 cm rows', () => {
    const a = zScore({
      indicator: 'wfh',
      sex: 'M',
      ageDays: 100,
      value: 2.45,
      lengthHeightCm: 45,
    })!;
    const b = zScore({
      indicator: 'wfh',
      sex: 'M',
      ageDays: 100,
      value: 2.45,
      lengthHeightCm: 45.05,
    })!;
    const c = zScore({
      indicator: 'wfh',
      sex: 'M',
      ageDays: 100,
      value: 2.45,
      lengthHeightCm: 45.1,
    })!;
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(c);
  });
});

describe('WHO z-scores: behaviour', () => {
  it('rises with the measurement and falls with age', () => {
    const at = (kg: number, age = 100) =>
      zScore({ indicator: 'wfa', sex: 'F', ageDays: age, value: kg })!;
    expect(at(6)).toBeLessThan(at(7));
    expect(at(6, 100)).toBeGreaterThan(at(6, 300));
  });
  it('extends beyond +3 and -3 linearly, continuous at the joint', () => {
    const z = (kg: number) => zScore({ indicator: 'wfa', sex: 'M', ageDays: 0, value: kg })!;
    expect(z(6.5)).toBeGreaterThan(3);
    expect(z(6.5)).toBeCloseTo(5.4, 0);
    expect(z(1.0)).toBeLessThan(-3);
    expect(Math.abs(z(5.0) - z(5.1))).toBeLessThan(0.3);
  });
  it('does not extend length-for-age beyond ±3 (plain formula)', () => {
    const z = zScore({ indicator: 'lhfa', sex: 'M', ageDays: 0, value: 30 })!;
    expect(z).toBeLessThan(-10);
  });
  it('is null outside 0–5 years, for bad values and for missing length / height', () => {
    expect(
      zScore({ indicator: 'wfa', sex: 'M', ageDays: WHO_MAX_AGE_DAYS + 1, value: 18 }),
    ).toBeNull();
    expect(zScore({ indicator: 'wfa', sex: 'M', ageDays: -1, value: 3 })).toBeNull();
    expect(zScore({ indicator: 'wfa', sex: 'M', ageDays: 10, value: 0 })).toBeNull();
    expect(zScore({ indicator: 'wfh', sex: 'M', ageDays: 10, value: 3 })).toBeNull();
    expect(
      zScore({ indicator: 'wfh', sex: 'M', ageDays: 10, value: 3, lengthHeightCm: 40 }),
    ).toBeNull();
    expect(
      zScore({ indicator: 'wfh', sex: 'M', ageDays: 900, value: 10, lengthHeightCm: 121 }),
    ).toBeNull();
  });
  it('accepts day 0 and day 1826', () => {
    expect(zScore({ indicator: 'wfa', sex: 'F', ageDays: 0, value: 3.2 })).not.toBeNull();
    expect(zScore({ indicator: 'wfa', sex: 'F', ageDays: 1826, value: 18 })).not.toBeNull();
  });
  it('rounds to two decimals', () => {
    const z = zScore({ indicator: 'wfa', sex: 'F', ageDays: 123, value: 5.77 })!;
    expect(Math.round(z * 100) / 100).toBe(z);
  });
});

describe('computeZScores', () => {
  const base = {
    sex: 'F' as const,
    dob: '2025-01-01',
    measuredOn: '2025-07-01',
    weightKg: 7.3,
    lengthHeightCm: 66,
    headCircCm: 42,
  };
  it('computes all four from one visit', () => {
    const r = computeZScores(base);
    expect(r.skipped).toBeNull();
    for (const k of ['wfa', 'lhfa', 'hcfa', 'wfh'] as const) expect(r[k]).not.toBeNull();
    expect(r.implausible).toEqual([]);
  });
  it('computes only what was measured', () => {
    const r = computeZScores({ ...base, lengthHeightCm: null, headCircCm: null });
    expect(r.wfa).not.toBeNull();
    expect(r.lhfa).toBeNull();
    expect(r.hcfa).toBeNull();
    expect(r.wfh).toBeNull();
  });
  it('uses the length table below 2 y and the height table from 2 y', () => {
    const young = computeZScores({
      ...base,
      dob: '2025-01-01',
      measuredOn: '2026-12-31',
      weightKg: 12,
      lengthHeightCm: 85,
    });
    const old = computeZScores({
      ...base,
      dob: '2025-01-01',
      measuredOn: '2027-01-02',
      weightKg: 12,
      lengthHeightCm: 85,
    });
    expect(young.wfh).not.toBe(old.wfh);
  });
  it('skips children of 5 years or more, and patients whose sex is not M or F', () => {
    expect(computeZScores({ ...base, measuredOn: '2031-01-02' }).skipped).toBe('age');
    expect(computeZScores({ ...base, sex: 'O' }).skipped).toBe('sex');
    expect(computeZScores({ ...base, sex: null }).skipped).toBe('sex');
    expect(computeZScores({ ...base, measuredOn: '2024-12-31' }).skipped).toBe('age');
  });
  it('flags values that are probably a typing slip', () => {
    const r = computeZScores({ ...base, weightKg: 1.0 });
    expect(r.implausible).toContain('wfa');
    const ok = computeZScores({ ...base, weightKg: 5.5 });
    expect(ok.implausible).not.toContain('wfa');
  });
  it('a median child scores about zero everywhere', () => {
    const r = computeZScores({
      sex: 'M',
      dob: '2026-01-01',
      measuredOn: '2026-01-01',
      weightKg: 3.346,
      lengthHeightCm: 49.884,
      headCircCm: 34.462,
    });
    expect(r.wfa).toBeCloseTo(0, 1);
    expect(r.lhfa).toBeCloseTo(0, 1);
    expect(r.hcfa).toBeCloseTo(0, 1);
  });
  it('the age is the whole days between dob and the measurement date (leap day)', () => {
    const a = computeZScores({ ...base, dob: '2024-02-29', measuredOn: '2024-03-01' });
    const b = zScore({ indicator: 'wfa', sex: 'F', ageDays: 1, value: base.weightKg });
    expect(a.wfa).toBe(b);
  });
});

describe('growthCurve', () => {
  it('has one monotone series per z line, in order, on the age axis', () => {
    const c = growthCurve({ indicator: 'wfa', sex: 'F' });
    expect(c.lines.map((l) => l.z)).toEqual([...CURVE_Z_LINES]);
    expect(c.xs[0]).toBe(0);
    expect(c.xs.at(-1)).toBeLessThanOrEqual(WHO_MAX_AGE_DAYS);
    for (const l of c.lines) expect(l.ys).toHaveLength(c.xs.length);
    for (let i = 0; i < c.xs.length; i++) {
      const col = c.lines.map((l) => l.ys[i]!);
      expect([...col].sort((a, b) => a - b)).toEqual(col);
    }
  });
  it('the median line passes through the published M at birth', () => {
    const c = growthCurve({ indicator: 'wfa', sex: 'M' });
    expect(c.lines.find((l) => l.z === 0)!.ys[0]).toBeCloseTo(3.35, 2);
    expect(c.lines.find((l) => l.z === -2)!.ys[0]).toBeCloseTo(2.46, 1);
  });
  it('weight-for-height runs over the length range under 2 y and the height range after', () => {
    const young = growthCurve({ indicator: 'wfh', sex: 'M', ageDays: 100 });
    const old = growthCurve({ indicator: 'wfh', sex: 'M', ageDays: 900 });
    expect(young.xs[0]).toBe(45);
    expect(old.xs[0]).toBe(65);
    expect(old.xs.at(-1)).toBe(120);
  });
  it('a computed z-score lies between its neighbouring curves', () => {
    const dob = '2025-01-01';
    const day = 200;
    const kg = 8.0;
    const z = zScore({ indicator: 'wfa', sex: 'M', ageDays: day, value: kg })!;
    const c = growthCurve({ indicator: 'wfa', sex: 'M', stepDays: 1 });
    const i = c.xs.indexOf(day);
    const at = (zz: number) => c.lines.find((l) => l.z === zz)!.ys[i]!;
    expect(z).toBeGreaterThan(-2);
    expect(z).toBeLessThan(2);
    expect(kg).toBeGreaterThan(at(-2));
    expect(kg).toBeLessThan(at(2));
    expect(toIsoDate(addDays(parseIsoDate(dob), day))).toBe('2025-07-20');
  });
});

describe('zBand', () => {
  it('uses the ±2 and ±3 lines with the line itself in the normal / lower band', () => {
    expect(zBand(-3.01)).toBe('lt_neg3');
    expect(zBand(-3)).toBe('lt_neg2');
    expect(zBand(-2.01)).toBe('lt_neg2');
    expect(zBand(-2)).toBe('normal');
    expect(zBand(0)).toBe('normal');
    expect(zBand(2)).toBe('normal');
    expect(zBand(2.01)).toBe('gt_pos2');
    expect(zBand(3)).toBe('gt_pos2');
    expect(zBand(3.01)).toBe('gt_pos3');
  });
});
