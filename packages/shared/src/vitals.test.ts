import { describe, expect, it } from 'vitest';
import {
  allowedVitalsGroups,
  bmi,
  celsiusToFahrenheit,
  DEFAULT_VITALS_THRESHOLDS,
  defaultVitalsGroup,
  evaluateVitals,
  fahrenheitToCelsius,
  flagLevelByField,
  heightDue,
  normaliseVitals,
  parseVitalsFlags,
  recordVitalsSchema,
  validateVitals,
  vitalsFieldsFor,
  type StoredVitals,
  type VitalsPatient,
  type VitalsGroup,
} from './vitals';

const adult: VitalsPatient = { age: { unit: 'years', value: 30 } as const, sex: 'F' };
const child: VitalsPatient = { age: { unit: 'years', value: 6 } as const, sex: 'M' };
const infant: VitalsPatient = { age: { unit: 'months', value: 8 } as const, sex: 'F' };

const read = (o: Partial<StoredVitals> = {}) => ({
  bpSys: null,
  bpDia: null,
  pulse: null,
  tempC: null,
  spo2: null,
  rbsMgdl: null,
  ...o,
});
const flags = (group: VitalsGroup, o: Partial<StoredVitals>) =>
  evaluateVitals(group, read(o)).map((f) => `${f.code}:${f.level}`);

describe('out-of-range flags (docs/11 §1 defaults)', () => {
  it('BP: amber from 140 or 90, red from 160 or 110, either number counts', () => {
    expect(flags('adult', { bpSys: 139, bpDia: 89 })).toEqual([]);
    expect(flags('adult', { bpSys: 140, bpDia: 80 })).toEqual(['bp_high:amber']);
    expect(flags('adult', { bpSys: 120, bpDia: 90 })).toEqual(['bp_high:amber']);
    expect(flags('adult', { bpSys: 159, bpDia: 109 })).toEqual(['bp_high:amber']);
    expect(flags('adult', { bpSys: 160, bpDia: 80 })).toEqual(['bp_high:red']);
    expect(flags('adult', { bpSys: 130, bpDia: 110 })).toEqual(['bp_high:red']);
  });

  it('SpO2: amber below 94, red below 90 (94 and 90 themselves are not flagged at that band)', () => {
    expect(flags('adult', { spo2: 94 })).toEqual([]);
    expect(flags('adult', { spo2: 93 })).toEqual(['spo2_low:amber']);
    expect(flags('adult', { spo2: 90 })).toEqual(['spo2_low:amber']);
    expect(flags('adult', { spo2: 89 })).toEqual(['spo2_low:red']);
  });

  it('temperature: amber from 38.0 °C', () => {
    expect(flags('adult', { tempC: 37.9 })).toEqual([]);
    expect(flags('adult', { tempC: 38.0 })).toEqual(['temp_high:amber']);
    expect(flags('adult', { tempC: 40.2 })).toEqual(['temp_high:amber']);
  });

  it('pulse: amber below 50 or above 120', () => {
    expect(flags('adult', { pulse: 50 })).toEqual([]);
    expect(flags('adult', { pulse: 49 })).toEqual(['pulse_low:amber']);
    expect(flags('adult', { pulse: 120 })).toEqual([]);
    expect(flags('adult', { pulse: 121 })).toEqual(['pulse_high:amber']);
  });

  it('random sugar: amber above 200', () => {
    expect(flags('adult', { rbsMgdl: 200 })).toEqual([]);
    expect(flags('adult', { rbsMgdl: 201 })).toEqual(['rbs_high:amber']);
  });

  it('several flags at once keep their own bands', () => {
    expect(
      flags('adult', { bpSys: 170, bpDia: 100, spo2: 92, tempC: 38.5, pulse: 130, rbsMgdl: 250 }),
    ).toEqual([
      'bp_high:red',
      'pulse_high:amber',
      'rbs_high:amber',
      'spo2_low:amber',
      'temp_high:amber',
    ]);
  });

  it('pregnant + BP at 140/90 adds the "Raised BP in pregnancy" alert; not-pregnant does not', () => {
    expect(flags('pregnant', { bpSys: 140, bpDia: 80 })).toEqual([
      'bp_high:amber',
      'raised_bp_pregnancy:alert',
    ]);
    expect(flags('pregnant', { bpSys: 170, bpDia: 115 })).toEqual([
      'bp_high:red',
      'raised_bp_pregnancy:alert',
    ]);
    expect(flags('pregnant', { bpSys: 130, bpDia: 85 })).toEqual([]);
    expect(flags('adult', { bpSys: 150, bpDia: 95 })).toEqual(['bp_high:amber']);
  });

  it('a child is judged on temperature and SpO2 only (no paediatric BP / pulse bands are invented)', () => {
    expect(flags('child', { tempC: 39, spo2: 88, pulse: 200, bpSys: 200, bpDia: 100 })).toEqual([
      'spo2_low:red',
      'temp_high:amber',
    ]);
  });

  it('uses the facility thresholds when given', () => {
    const t = { ...DEFAULT_VITALS_THRESHOLDS, bpAmber: { sys: 130, dia: 85 } };
    expect(evaluateVitals('adult', read({ bpSys: 132, bpDia: 80 }), t).map((f) => f.level)).toEqual(
      ['amber'],
    );
  });

  it('ignores a half-entered BP and missing readings', () => {
    expect(flags('adult', { bpSys: 200, bpDia: null })).toEqual([]);
    expect(flags('adult', {})).toEqual([]);
  });

  it('flagLevelByField gives the stronger band and skips alerts', () => {
    const f = evaluateVitals('pregnant', read({ bpSys: 165, bpDia: 100, tempC: 38.4 }));
    expect(flagLevelByField(f)).toEqual({ bp: 'red', temp: 'amber' });
  });

  it('reads stored flags defensively', () => {
    expect(parseVitalsFlags([{ code: 'bp_high', field: 'bp', level: 'red' }])).toHaveLength(1);
    expect(parseVitalsFlags('junk')).toEqual([]);
    expect(parseVitalsFlags([{ code: 'nope', field: 'bp', level: 'red' }])).toEqual([]);
  });
});

describe('implausible values are blocked', () => {
  const bad = (group: VitalsGroup, v: Parameters<typeof validateVitals>[1]) =>
    validateVitals(group, v).map((i) => `${i.field}:${i.key.split('.').at(-1)}`);

  it('weight 650 kg, impossible BP, pulse, temperature, SpO2', () => {
    expect(bad('adult', { weightKg: 650 })).toEqual(['weightKg:implausible']);
    expect(bad('adult', { bpSys: 400, bpDia: 80 })).toEqual(['bpSys:implausible']);
    expect(bad('adult', { pulse: 5 })).toEqual(['pulse:implausible']);
    expect(bad('adult', { tempF: 120 })).toEqual(['tempF:implausible']);
    expect(bad('adult', { tempF: 70 })).toEqual(['tempF:implausible']);
    expect(bad('adult', { spo2: 101 })).toEqual(['spo2:implausible']);
  });

  it('diastolic must be below systolic, and both are needed', () => {
    expect(bad('adult', { bpSys: 120, bpDia: 120 })).toEqual(['bpDia:bpOrder']);
    expect(bad('adult', { bpSys: 90, bpDia: 110 })).toEqual(['bpDia:bpOrder']);
    expect(bad('adult', { bpSys: 120 })).toEqual(['bpDia:bpBoth']);
    expect(bad('adult', { bpDia: 80 })).toEqual(['bpSys:bpBoth']);
    expect(bad('adult', { bpSys: 120, bpDia: 80 })).toEqual([]);
  });

  it('limits depend on the group: 5 kg is a baby, not an adult', () => {
    expect(bad('adult', { weightKg: 5 })).toEqual(['weightKg:implausible']);
    expect(bad('child', { weightKg: 5 })).toEqual([]);
    expect(bad('child', { weightKg: 250 })).toEqual(['weightKg:implausible']);
    expect(bad('adult', { heightCm: 60 })).toEqual(['heightCm:implausible']);
    expect(bad('child', { heightCm: 60 })).toEqual([]);
  });

  it('boundaries are inclusive', () => {
    expect(bad('adult', { weightKg: 300, heightCm: 250, spo2: 100, pulse: 250 })).toEqual([]);
    expect(bad('adult', { weightKg: 20, heightCm: 100, spo2: 50, pulse: 20 })).toEqual([]);
  });

  it('refuses fields the group does not take', () => {
    expect(bad('adult', { fhr: 140 })).toEqual(['fhr:notForGroup']);
    expect(bad('child', { bpSys: 100, bpDia: 60 })).toEqual([
      'bpSys:notForGroup',
      'bpDia:notForGroup',
    ]);
    expect(bad('pregnant', { fhr: 140, fundalHeightCm: 28 })).toEqual([]);
  });

  it('head circumference only under 2 years (needs the patient)', () => {
    const issues = (p: VitalsPatient) =>
      validateVitals('child', { headCircCm: 45 }, p).map((i) => i.key.split('.').at(-1));
    expect(issues(infant)).toEqual([]);
    expect(issues(child)).toEqual(['notForGroup']);
  });

  it('the save schema carries the same messages and needs at least one reading', () => {
    const tokenId = '0190a000-0000-7000-8000-000000000001';
    const msgs = (r: ReturnType<typeof recordVitalsSchema.safeParse>) =>
      r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`);
    expect(msgs(recordVitalsSchema.safeParse({ tokenId, group: 'adult', values: {} }))).toEqual([
      'values:validation.vitals.atLeastOne',
    ]);
    expect(
      msgs(recordVitalsSchema.safeParse({ tokenId, group: 'adult', values: { weightKg: 650 } })),
    ).toEqual(['values.weightKg:validation.vitals.implausible']);
    expect(
      recordVitalsSchema.safeParse({ tokenId, group: 'adult', values: { pulse: 80 } }).success,
    ).toBe(true);
    // Unknown fields (e.g. anything not on the form) are refused, not ignored.
    expect(
      recordVitalsSchema.safeParse({ tokenId, group: 'adult', values: { pulse: 80, foo: 1 } })
        .success,
    ).toBe(false);
  });
});

describe('units and calculations', () => {
  it('°F in, °C out with two decimals, and back to the same °F', () => {
    expect(fahrenheitToCelsius(98.6)).toBe(37);
    expect(fahrenheitToCelsius(100.4)).toBe(38);
    expect(fahrenheitToCelsius(100.3)).toBe(37.94);
    expect(fahrenheitToCelsius(101)).toBe(38.33);
    for (let tenths = 860; tenths <= 1130; tenths++) {
      const f = tenths / 10;
      expect(celsiusToFahrenheit(fahrenheitToCelsius(f))).toBe(f);
    }
    expect(celsiusToFahrenheit(38)).toBe(100.4);
    expect(celsiusToFahrenheit(37)).toBe(98.6);
  });

  it('100.4 °F is the fever line: flagged; 100.3 °F is not', () => {
    const f = (tempF: number) =>
      evaluateVitals('adult', normaliseVitals('adult', { tempF })).map((x) => x.code);
    expect(f(100.4)).toEqual(['temp_high']);
    expect(f(100.3)).toEqual([]);
  });

  it('BMI to one decimal; only for adult and pregnant forms', () => {
    expect(bmi(60, 160)).toBe(23.4);
    expect(normaliseVitals('adult', { weightKg: 60, heightCm: 160 }).bmi).toBe(23.4);
    expect(normaliseVitals('pregnant', { weightKg: 80, heightCm: 150 }).bmi).toBe(35.6);
    expect(normaliseVitals('child', { weightKg: 14, heightCm: 95 }).bmi).toBeNull();
    expect(normaliseVitals('adult', { weightKg: 60 }).bmi).toBeNull();
  });

  it('rounds to the stored precision', () => {
    const s = normaliseVitals('child', { weightKg: 3.456, heightCm: 51.26, headCircCm: 34.04 });
    expect([s.weightKg, s.heightCm, s.headCircCm]).toEqual([3.46, 51.3, 34]);
  });
});

describe('which form a patient gets', () => {
  it('adult from 18 years, child below; babies and children get the child form', () => {
    expect(allowedVitalsGroups(adult)).toEqual(['adult', 'pregnant']);
    expect(allowedVitalsGroups({ age: { unit: 'years', value: 17 }, sex: 'M' })).toEqual(['child']);
    expect(allowedVitalsGroups({ age: { unit: 'years', value: 18 }, sex: 'M' })).toEqual(['adult']);
    expect(allowedVitalsGroups(infant)).toEqual(['child']);
    expect(allowedVitalsGroups({ age: { unit: 'days', value: 3 }, sex: 'F' })).toEqual(['child']);
  });

  it('the pregnant form is for non-male patients of 10 years or more, including minors', () => {
    expect(allowedVitalsGroups({ age: { unit: 'years', value: 16 }, sex: 'F' })).toEqual([
      'child',
      'pregnant',
    ]);
    expect(allowedVitalsGroups({ age: { unit: 'years', value: 9 }, sex: 'F' })).toEqual(['child']);
    expect(allowedVitalsGroups({ age: { unit: 'years', value: 30 }, sex: 'M' })).toEqual(['adult']);
  });

  it('defaults to pregnant only when asked and allowed', () => {
    expect(defaultVitalsGroup(adult, true)).toBe('pregnant');
    expect(defaultVitalsGroup(adult, false)).toBe('adult');
    expect(defaultVitalsGroup(child, true)).toBe('child');
  });

  it('field sets follow docs/11 §1', () => {
    expect(vitalsFieldsFor('adult', adult)).toEqual([
      'bpSys',
      'bpDia',
      'pulse',
      'tempF',
      'spo2',
      'weightKg',
      'heightCm',
      'rbsMgdl',
    ]);
    expect(vitalsFieldsFor('pregnant', adult)).toEqual(
      expect.arrayContaining(['fundalHeightCm', 'fhr', 'oedema', 'urineAlbumin', 'urineSugar']),
    );
    expect(vitalsFieldsFor('child', child)).toEqual([
      'weightKg',
      'heightCm',
      'tempF',
      'spo2',
      'rr',
      'muacCm',
    ]);
    expect(vitalsFieldsFor('child', infant)).toContain('headCircCm');
  });
});

describe('height prompt', () => {
  it('asks when never measured or a year old', () => {
    expect(heightDue(null, '2026-10-26', 365)).toBe(true);
    expect(heightDue('2025-10-26', '2026-10-26', 365)).toBe(true);
    expect(heightDue('2025-10-27', '2026-10-26', 365)).toBe(false);
    expect(heightDue('2026-10-01', '2026-10-26', 30)).toBe(false);
  });
});
