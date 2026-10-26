import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERMS } from './compliance/forbidden-terms';
import {
  fitWithin,
  followUpDateAfter,
  isValidFollowUpDate,
  needsVerification,
  patternSum,
  rxDraftPayloadSchema,
  rxItemSchema,
  rxQuantity,
  rxWarnings,
  saveRxSchema,
  type WarnableItem,
} from './rx';

const IST = (iso: string) => new Date(`${iso}+05:30`);
const item = (over: Partial<WarnableItem> = {}): WarnableItem => ({
  drugId: '0190a000-0000-7000-8000-000000000001',
  drugName: 'Paracetamol 650',
  genericName: 'Paracetamol',
  form: 'tab',
  pattern: '1-0-1',
  frequencyCode: null,
  durationValue: 5,
  durationUnit: 'd',
  quantity: 10,
  ...over,
});

describe('patterns and quantity (docs/11 §2.3)', () => {
  it('sums patterns, including halves', () => {
    expect(patternSum('1-0-1')).toBe(2);
    expect(patternSum('1-1-1-1')).toBe(4);
    expect(patternSum('½-0-½')).toBe(1);
    expect(patternSum('2-0-2')).toBe(4);
    expect(patternSum('1-0')).toBeNull();
    expect(patternSum('a-b-c')).toBeNull();
  });

  it('counts solids only; liquids, creams and injections stay blank', () => {
    const base = {
      pattern: '1-0-1',
      frequencyCode: null,
      durationValue: 5,
      durationUnit: 'd',
    } as const;
    expect(rxQuantity({ ...base, form: 'tab' })).toBe(10);
    expect(rxQuantity({ ...base, form: 'cap' })).toBe(10);
    expect(rxQuantity({ ...base, form: 'syp' })).toBeNull();
    expect(rxQuantity({ ...base, form: 'cream' })).toBeNull();
    expect(rxQuantity({ ...base, form: 'inj' })).toBeNull();
    expect(rxQuantity({ ...base, form: null })).toBeNull();
    expect(rxQuantity({ ...base, form: 'tab', durationUnit: 'w', durationValue: 2 })).toBe(28);
    expect(rxQuantity({ ...base, form: 'tab', durationUnit: 'm', durationValue: 1 })).toBe(60);
    expect(rxQuantity({ ...base, form: 'tab', pattern: '½-0-½', durationValue: 3 })).toBe(3);
    // Rounds a fraction of a tablet up.
    expect(rxQuantity({ ...base, form: 'tab', pattern: '½-0-0', durationValue: 3 })).toBe(2);
  });

  it('handles codes without a pattern', () => {
    const q = (frequencyCode: 'WEEKLY' | 'ALT' | 'STAT' | 'SOS', durationValue: number | null) =>
      rxQuantity({
        form: 'tab',
        pattern: null,
        frequencyCode,
        durationValue,
        durationUnit: durationValue === null ? null : 'd',
      });
    expect(q('WEEKLY', 56)).toBe(8);
    expect(q('WEEKLY', 10)).toBe(2);
    expect(q('ALT', 30)).toBe(15);
    expect(q('ALT', 5)).toBe(3);
    expect(q('STAT', null)).toBe(1);
    expect(q('SOS', 5)).toBeNull();
  });
});

describe('dose sanity warnings (docs/11 §2.3, non-blocking)', () => {
  it('passes a normal Rx', () => {
    expect(
      rxWarnings([
        item(),
        item({
          drugId: '0190a000-0000-7000-8000-000000000002',
          genericName: 'Folic acid',
          drugName: 'Folvite',
        }),
      ]),
    ).toEqual([]);
  });

  it('flags duplicates, odd doses, missing parts, long courses and free text', () => {
    const w = rxWarnings([
      item(),
      item(), // same drug again
      item({ drugId: '0190a000-0000-7000-8000-000000000003', drugName: 'Dolo 650' }), // same generic
      item({
        drugId: null,
        drugName: 'Unknown syrup',
        genericName: null,
        form: 'syp',
        quantity: null,
      }),
      item({
        drugId: '0190a000-0000-7000-8000-000000000004',
        genericName: 'Iron',
        pattern: '5-0-5',
      }),
      item({
        drugId: '0190a000-0000-7000-8000-000000000005',
        genericName: 'B',
        pattern: '2-2-2-2',
      }),
      item({ drugId: '0190a000-0000-7000-8000-000000000006', genericName: 'C', pattern: null }),
      item({
        drugId: '0190a000-0000-7000-8000-000000000007',
        genericName: 'D',
        durationValue: null,
        durationUnit: null,
      }),
      item({
        drugId: '0190a000-0000-7000-8000-000000000008',
        genericName: 'E',
        durationValue: 7,
        durationUnit: 'm',
        quantity: 420,
      }),
      item({
        drugId: '0190a000-0000-7000-8000-000000000009',
        genericName: 'F',
        frequencyCode: 'SOS',
        pattern: null,
        durationValue: null,
        durationUnit: null,
      }),
    ]);
    expect(w).toEqual([
      { code: 'duplicate_drug', row: 1 },
      { code: 'duplicate_generic', row: 2 },
      { code: 'free_text_drug', row: 3 },
      { code: 'many_units_per_dose', row: 4 },
      { code: 'many_doses_per_day', row: 4 },
      { code: 'many_doses_per_day', row: 5 },
      { code: 'no_frequency', row: 6 },
      { code: 'no_duration', row: 7 },
      { code: 'long_duration', row: 8 },
      { code: 'large_quantity', row: 8 },
    ]);
  });
});

describe('verification sampling (Q15, docs/11 §2.7)', () => {
  it('follows the mode', () => {
    expect(needsVerification('off', 100, true, 0)).toBe(false);
    expect(needsVerification('all', 0, false, 0.99)).toBe(true);
    expect(needsVerification('sample', 10, true, 0.99)).toBe(true);
    expect(needsVerification('sample', 10, false, 0.05)).toBe(true);
    expect(needsVerification('sample', 10, false, 0.1)).toBe(false);
    expect(needsVerification('sample', 10, false, 0.5)).toBe(false);
  });

  it('samples about the configured share', () => {
    let n = 0;
    for (let i = 0; i < 1000; i++) if (needsVerification('sample', 10, false, i / 1000)) n++;
    expect(n).toBe(100);
  });
});

describe('follow-up dates (docs/11 §2.6)', () => {
  const now = IST('2026-10-26T23:30:00');
  it('counts IST days', () => {
    expect(followUpDateAfter(now, 7)).toBe('2026-11-02');
    expect(followUpDateAfter(IST('2026-12-28T10:00:00'), 7)).toBe('2027-01-04');
    expect(followUpDateAfter(IST('2028-02-25T10:00:00'), 7)).toBe('2028-03-03');
  });
  it('refuses past, today and far-future dates', () => {
    expect(isValidFollowUpDate('2026-10-25', now)).toBe(false);
    expect(isValidFollowUpDate('2026-10-26', now)).toBe(false);
    expect(isValidFollowUpDate('2026-10-27', now)).toBe(true);
    expect(isValidFollowUpDate('2027-10-26', now)).toBe(true);
    expect(isValidFollowUpDate('2027-10-27', now)).toBe(false);
  });
});

describe('image fit (docs/01 §2: ≤ 1600 px)', () => {
  it('scales the long side down and never enlarges', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(fitWithin(16000, 10)).toEqual({ width: 1600, height: 1 });
  });
});

describe('Rx inputs', () => {
  const row = {
    drugId: null,
    drugName: 'Dolo 650',
    form: 'tab',
    doseText: null,
    frequencyCode: null,
    pattern: '1-0-1',
    timing: 'af',
    route: null,
    durationValue: 5,
    durationUnit: 'd',
    quantity: 10,
    instructionsEn: '1-0-1, after food, 5 days',
    instructionsHi: '1-0-1, खाने के बाद, 5 दिन',
    sourceLine: 'dolo 650 1-0-1 af 5d',
  } as const;

  it('accepts a row and refuses half a duration or a bad pattern', () => {
    expect(rxItemSchema.safeParse(row).success).toBe(true);
    expect(rxItemSchema.safeParse({ ...row, durationUnit: null }).success).toBe(false);
    expect(rxItemSchema.safeParse({ ...row, pattern: '1-0' }).success).toBe(false);
    expect(rxItemSchema.safeParse({ ...row, quantity: 1.25 }).success).toBe(false);
    expect(rxItemSchema.safeParse({ ...row, drugName: '  ' }).success).toBe(false);
  });

  it('guards every free-text field (D-10)', () => {
    const bad = FORBIDDEN_TERMS.find((t) => t.tier === 'always')!.examples[0]!;
    for (const k of [
      'drugName',
      'doseText',
      'instructionsEn',
      'instructionsHi',
      'sourceLine',
    ] as const) {
      const r = rxItemSchema.safeParse({ ...row, [k]: bad });
      expect(r.success, k).toBe(false);
    }
    const save = saveRxSchema.safeParse({
      encounterId: '0190a000-0000-7000-8000-000000000001',
      idempotencyKey: '0190a000-0000-7000-8000-000000000002',
      items: [],
      orders: [],
      note: { complaints: [bad], advice: [] },
    });
    expect(save.success).toBe(false);
    const draft = rxDraftPayloadSchema.safeParse({
      items: [],
      line: bad,
      orders: [],
      admission: { advised: false },
      note: { complaints: [], advice: [] },
    });
    expect(draft.success).toBe(false);
  });

  it('refuses the same order twice', () => {
    const id = '0190a000-0000-7000-8000-000000000009';
    const r = saveRxSchema.safeParse({
      encounterId: id,
      idempotencyKey: id,
      items: [],
      orders: [{ serviceId: id }, { serviceId: id }],
    });
    expect(r.success).toBe(false);
  });
});

describe('paediatric dose warnings in the grid (docs/11 §4.4)', () => {
  // Invented numbers for exercising the code; the real list comes from the paediatrician.
  const rule = {
    genericName: 'testdrug',
    mgPerKgMin: 10,
    mgPerKgMax: 15,
    maxMgPerDose: 500,
    maxDosesPerDay: 4,
    concentrationMgPerMl: { syp: 25 },
  };
  const syrup = (over: Partial<WarnableItem> = {}) =>
    item({
      drugName: 'Testdrug syrup',
      genericName: 'Testdrug',
      form: 'syp',
      doseText: '6 ml',
      pattern: '1-1-1',
      quantity: null,
      ...over,
    });
  const codes = (w: ReturnType<typeof rxWarnings>) => w.map((x) => x.code);

  it('adds nothing without a child context, or for a drug with no rule', () => {
    expect(codes(rxWarnings([syrup()]))).not.toContain('paeds_dose');
    expect(codes(rxWarnings([syrup()], { weightKg: 14, rules: [] }))).toEqual([]);
    expect(
      codes(rxWarnings([syrup({ genericName: 'Other' })], { weightKg: 14, rules: [rule] })),
    ).toEqual([]);
  });
  it('is silent when the dose is in the range for the weight', () => {
    expect(codes(rxWarnings([syrup()], { weightKg: 14, rules: [rule] }))).toEqual([]);
  });
  it('warns, with the expected range, when the dose is outside it; the dose is untouched', () => {
    const items = [syrup({ doseText: '10 ml' })];
    const w = rxWarnings(items, { weightKg: 14, rules: [rule] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      code: 'paeds_dose',
      row: 0,
      paeds: { verdict: 'above', expectedMin: 5.6, expectedMax: 8.4, unit: 'ml', weightKg: 14 },
    });
    expect(items[0]!.doseText).toBe('10 ml');
    expect(
      rxWarnings([syrup({ doseText: '4 ml' })], { weightKg: 14, rules: [rule] })[0]!.paeds!.verdict,
    ).toBe('below');
  });
  it('flags too many doses a day from the pattern or the code', () => {
    const w = rxWarnings([syrup({ pattern: '1-1-1-1-1' })], {
      weightKg: 14,
      rules: [rule],
    });
    expect(w).toEqual([]); // not a valid pattern: no doses per day to judge
    const five = rxWarnings([syrup({ pattern: '2-2-2', doseText: '6 ml' })], {
      weightKg: 14,
      rules: [{ ...rule, maxDosesPerDay: 4 }],
    });
    expect(five.map((x) => x.paeds?.verdict)).toEqual(['too_many_doses']);
    const qid = rxWarnings([syrup({ pattern: null, frequencyCode: 'QID' })], {
      weightKg: 14,
      rules: [{ ...rule, maxDosesPerDay: 3 }],
    });
    expect(qid.map((x) => x.paeds?.verdict)).toEqual(['too_many_doses']);
    expect(
      rxWarnings([syrup({ pattern: null, frequencyCode: 'SOS' })], { weightKg: 14, rules: [rule] }),
    ).toEqual([]);
  });
  it('tablets are judged on the strength of the drug', () => {
    const tab = (doseText: string) =>
      syrup({ form: 'tab', strength: '250 mg', doseText, pattern: '1-0-1' });
    const ctx = { weightKg: 20, rules: [rule] };
    expect(rxWarnings([tab('1 tab')], ctx)).toEqual([]);
    expect(rxWarnings([tab('2 tab')], ctx)[0]!.paeds!.verdict).toBe('above');
    // No strength known: cannot check, so no false alarm.
    expect(rxWarnings([syrup({ form: 'tab', strength: null, doseText: '3 tab' })], ctx)).toEqual(
      [],
    );
  });
  it('says so when the weight of today is missing, only for a drug that has a rule', () => {
    expect(codes(rxWarnings([syrup()], { weightKg: null, rules: [rule] }))).toEqual([
      'paeds_no_weight',
    ]);
    expect(
      codes(rxWarnings([syrup({ genericName: 'Other' })], { weightKg: null, rules: [rule] })),
    ).toEqual([]);
  });
  it('keeps the other warnings alongside', () => {
    const w = rxWarnings([syrup({ doseText: '10 ml', durationValue: null, durationUnit: null })], {
      weightKg: 14,
      rules: [rule],
    });
    expect(codes(w)).toContain('paeds_dose');
  });
});
