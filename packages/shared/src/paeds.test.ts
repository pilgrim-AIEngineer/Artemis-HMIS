import { describe, expect, it } from 'vitest';
import {
  checkPaedsDose,
  paedsRuleInputSchema,
  parseTypedDose,
  recordGrowthSchema,
  strengthMg,
  type PaedsDoseRule,
} from './paeds';

// A made-up rule used only to exercise the arithmetic; real rules come from the paediatrician.
const rule: PaedsDoseRule = {
  genericName: 'testdrug',
  mgPerKgMin: 10,
  mgPerKgMax: 15,
  maxMgPerDose: 500,
  maxDosesPerDay: 4,
  concentrationMgPerMl: { syp: 25 },
};
const base = { rule, form: 'syp', mgPerUnit: null, dosesPerDay: 3 };

describe('parseTypedDose', () => {
  it.each([
    ['5 ml', { amount: 5, unit: 'ml' }],
    ['2.5ml', { amount: 2.5, unit: 'ml' }],
    ['250 mg', { amount: 250, unit: 'mg' }],
    ['1 tab', { amount: 1, unit: 'unit' }],
    ['½ tab', { amount: 0.5, unit: 'unit' }],
    ['1/2 tab', { amount: 0.5, unit: 'unit' }],
    ['0.5', { amount: 0.5, unit: 'unit' }],
    ['2 drops', { amount: 2, unit: 'unit' }],
  ])('reads %s', (text, out) => expect(parseTypedDose(text)).toEqual(out));
  it('is null with no number or a zero', () => {
    expect(parseTypedDose('')).toBeNull();
    expect(parseTypedDose(null)).toBeNull();
    expect(parseTypedDose('as directed')).toBeNull();
    expect(parseTypedDose('0 ml')).toBeNull();
  });
});

describe('strengthMg', () => {
  it('reads a plain mg strength only', () => {
    expect(strengthMg('500 mg')).toBe(500);
    expect(strengthMg('62.5mg')).toBe(62.5);
    expect(strengthMg('125mg/5ml')).toBeNull();
    expect(strengthMg(null)).toBeNull();
  });
});

describe('checkPaedsDose', () => {
  it('shows the range in ml for a 14 kg child: 140–210 mg at 25 mg/ml = 5.6–8.4 ml', () => {
    const r = checkPaedsDose({ ...base, weightKg: 14, dose: { amount: 6, unit: 'ml' } });
    expect(r.verdict).toBe('within');
    expect(r.expectedMin).toBe(5.6);
    expect(r.expectedMax).toBe(8.4);
    expect(r.expectedMgMin).toBe(140);
    expect(r.expectedMgMax).toBe(210);
    expect(r.enteredMg).toBe(150);
  });
  it('the ends of the range are within', () => {
    expect(
      checkPaedsDose({ ...base, weightKg: 14, dose: { amount: 5.6, unit: 'ml' } }).verdict,
    ).toBe('within');
    expect(
      checkPaedsDose({ ...base, weightKg: 14, dose: { amount: 8.4, unit: 'ml' } }).verdict,
    ).toBe('within');
  });
  it('below and above', () => {
    expect(checkPaedsDose({ ...base, weightKg: 14, dose: { amount: 5, unit: 'ml' } }).verdict).toBe(
      'below',
    );
    expect(checkPaedsDose({ ...base, weightKg: 14, dose: { amount: 9, unit: 'ml' } }).verdict).toBe(
      'above',
    );
  });
  it('caps the range at the maximum per dose', () => {
    const r = checkPaedsDose({ ...base, weightKg: 60, dose: { amount: 20, unit: 'ml' } });
    expect(r.expectedMgMax).toBe(500);
    expect(r.expectedMax).toBe(20);
    expect(r.verdict).toBe('within');
    expect(
      checkPaedsDose({ ...base, weightKg: 60, dose: { amount: 21, unit: 'ml' } }).verdict,
    ).toBe('over_max_dose');
  });
  it('mg typed directly needs no concentration', () => {
    const r = checkPaedsDose({
      ...base,
      form: null,
      weightKg: 10,
      dose: { amount: 125, unit: 'mg' },
    });
    expect(r.verdict).toBe('within');
    expect(r.expectedMin).toBe(100);
  });
  it('tablets use the strength of the drug', () => {
    const t = { ...base, form: 'tab', mgPerUnit: 250 };
    expect(checkPaedsDose({ ...t, weightKg: 20, dose: { amount: 1, unit: 'unit' } }).verdict).toBe(
      'within',
    );
    expect(checkPaedsDose({ ...t, weightKg: 20, dose: { amount: 2, unit: 'unit' } }).verdict).toBe(
      'above',
    );
    expect(
      checkPaedsDose({ ...t, weightKg: 20, dose: { amount: 0.5, unit: 'unit' } }).verdict,
    ).toBe('below');
  });
  it('cannot check a liquid without a concentration or a tablet without a strength', () => {
    expect(
      checkPaedsDose({ ...base, form: 'drops', weightKg: 10, dose: { amount: 1, unit: 'ml' } })
        .verdict,
    ).toBe('cannot_check');
    expect(
      checkPaedsDose({ ...base, form: 'tab', weightKg: 10, dose: { amount: 1, unit: 'unit' } })
        .verdict,
    ).toBe('cannot_check');
  });
  it('flags too many doses a day when the dose itself is fine', () => {
    const ok = { ...base, weightKg: 14, dose: { amount: 6, unit: 'ml' as const } };
    expect(checkPaedsDose({ ...ok, dosesPerDay: 4 }).verdict).toBe('within');
    expect(checkPaedsDose({ ...ok, dosesPerDay: 5 }).verdict).toBe('too_many_doses');
    expect(checkPaedsDose({ ...ok, dosesPerDay: null }).verdict).toBe('within');
    expect(
      checkPaedsDose({ ...ok, rule: { ...rule, maxDosesPerDay: null }, dosesPerDay: 9 }).verdict,
    ).toBe('within');
  });
  it('a dose outside the range is reported before too many doses', () => {
    expect(
      checkPaedsDose({ ...base, weightKg: 14, dose: { amount: 9, unit: 'ml' }, dosesPerDay: 6 })
        .verdict,
    ).toBe('above');
  });
  it('scales with weight', () => {
    const a = checkPaedsDose({ ...base, weightKg: 5, dose: { amount: 2, unit: 'ml' } });
    const b = checkPaedsDose({ ...base, weightKg: 10, dose: { amount: 2, unit: 'ml' } });
    expect(b.expectedMax!).toBeCloseTo(a.expectedMax! * 2, 1);
  });
});

describe('inputs', () => {
  it('a rule needs min <= max', () => {
    const ok = { genericName: 'x drug', mgPerKgMin: 5, mgPerKgMax: 10 };
    expect(paedsRuleInputSchema.safeParse(ok).success).toBe(true);
    expect(paedsRuleInputSchema.safeParse({ ...ok, mgPerKgMin: 11 }).success).toBe(false);
  });
  it('growth needs at least one measurement and refuses implausible ones', () => {
    const b = {
      idempotencyKey: '0190a7a0-0000-7000-8000-000000000001',
      patientId: '0190a7a0-0000-7000-8000-000000000002',
      measuredOn: '2026-02-01',
      weightKg: null,
      lengthHeightCm: null,
      headCircCm: null,
    };
    expect(recordGrowthSchema.safeParse(b).success).toBe(false);
    expect(recordGrowthSchema.safeParse({ ...b, weightKg: 7.25 }).success).toBe(true);
    expect(recordGrowthSchema.safeParse({ ...b, weightKg: 650 }).success).toBe(false);
    expect(recordGrowthSchema.safeParse({ ...b, headCircCm: 5 }).success).toBe(false);
  });
});
