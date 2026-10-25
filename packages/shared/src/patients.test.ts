import { describe, expect, it } from 'vitest';
import {
  classifySearchQuery,
  createPatientSchema,
  dobWithinYears,
  duplicateCheckSchema,
  formatUhid,
  joinName,
  resolveDob,
  titleCaseName,
} from './patients';

const TODAY = { year: 2026, month: 10, day: 26 };

describe('titleCaseName', () => {
  it('capitalises each word and removes extra spaces', () => {
    expect(titleCaseName('  sunita   DEVI ')).toBe('Sunita Devi');
    expect(titleCaseName("a.k. d'souza")).toBe("A.K. D'Souza");
    expect(titleCaseName('ram-lal')).toBe('Ram-Lal');
  });
  it('leaves Devanagari alone', () => {
    expect(titleCaseName('सुनीता  देवी')).toBe('सुनीता देवी');
  });
  it('joins name parts', () => {
    expect(joinName({ firstName: 'Sunita', middleName: null, lastName: 'Verma' })).toBe(
      'Sunita Verma',
    );
  });
});

describe('resolveDob (age-only registration, docs/10 §3)', () => {
  it('estimates from 25, 25y, 6m, 15d', () => {
    expect(resolveDob({ age: '25' }, TODAY)).toEqual({ dob: '2001-07-01', estimated: true });
    expect(resolveDob({ age: '25y' }, TODAY)).toEqual({ dob: '2001-07-01', estimated: true });
    expect(resolveDob({ age: '6m' }, TODAY)).toEqual({ dob: '2026-04-26', estimated: true });
    expect(resolveDob({ age: '15d' }, TODAY)).toEqual({ dob: '2026-10-11', estimated: true });
  });
  it('keeps an entered DOB exact', () => {
    expect(resolveDob({ dob: '1995-03-14' }, TODAY)).toEqual({
      dob: '1995-03-14',
      estimated: false,
    });
  });
  it('rejects the future, absurd ages and nothing', () => {
    expect(resolveDob({ dob: '2026-10-27' }, TODAY)).toBeNull();
    expect(resolveDob({ dob: '1850-01-01' }, TODAY)).toBeNull();
    expect(resolveDob({ age: '130' }, TODAY)).toBeNull();
    expect(resolveDob({ age: 'abc' }, TODAY)).toBeNull();
    expect(resolveDob({}, TODAY)).toBeNull();
  });
});

describe('classifySearchQuery (docs/10 §2)', () => {
  it('10 digits is an exact mobile, also with +91 / spaces', () => {
    expect(classifySearchQuery('9876543210')).toEqual({
      kind: 'mobile',
      digits: '9876543210',
      exact: true,
    });
    expect(classifySearchQuery('+91 98765 43210')).toMatchObject({ kind: 'mobile', exact: true });
  });
  it('up to 7 digits and prefixed forms are UHIDs', () => {
    expect(classifySearchQuery('123')).toEqual({ kind: 'uhid', number: 123 });
    expect(classifySearchQuery('UH-000123')).toEqual({ kind: 'uhid', number: 123 });
    expect(classifySearchQuery('uh123')).toEqual({ kind: 'uhid', number: 123 });
    expect(classifySearchQuery('GH 45', 'GH')).toEqual({ kind: 'uhid', number: 45 });
  });
  it('8–9 digits search by mobile prefix', () => {
    expect(classifySearchQuery('98765432')).toMatchObject({ kind: 'mobile', exact: false });
  });
  it('anything else is a name; extra words are kept', () => {
    expect(classifySearchQuery('  sunita   verma ')).toEqual({
      kind: 'name',
      text: 'sunita verma',
      extra: ['sunita', 'verma'],
    });
    expect(classifySearchQuery('sunita')).toEqual({ kind: 'name', text: 'sunita', extra: [] });
    expect(classifySearchQuery('   ')).toEqual({ kind: 'empty' });
  });
  it('formats UHIDs', () => {
    expect(formatUhid('UH', 42, 6)).toBe('UH-000042');
  });
});

describe('dobWithinYears', () => {
  it('is symmetric and inclusive of the tolerance', () => {
    expect(dobWithinYears('1998-07-01', '1996-07-02', 2)).toBe(true);
    expect(dobWithinYears('1996-07-02', '1998-07-01', 2)).toBe(true);
    expect(dobWithinYears('1998-07-01', '1990-07-01', 2)).toBe(false);
  });
});

describe('createPatientSchema', () => {
  const base = { firstName: ' sunita ', sex: 'F', age: '28', mobile: '98765 43210' };
  it('normalises names and mobile', () => {
    const v = createPatientSchema.parse({
      ...base,
      lastName: 'VERMA',
      guardianName: 'ramesh  verma',
    });
    expect(v).toMatchObject({
      firstName: 'Sunita',
      lastName: 'Verma',
      guardianName: 'Ramesh Verma',
      mobile: '9876543210',
    });
  });
  it('needs age or DOB, not both', () => {
    expect(createPatientSchema.safeParse({ ...base, age: undefined }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, dob: '1998-01-01' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, age: '12x' }).success).toBe(false);
  });
  it('needs a reason when there is no mobile and rejects a repeated alternate', () => {
    expect(createPatientSchema.safeParse({ ...base, mobile: undefined }).success).toBe(false);
    expect(
      createPatientSchema.safeParse({ ...base, mobile: undefined, noMobileReason: 'none' }).success,
    ).toBe(true);
    expect(createPatientSchema.safeParse({ ...base, altMobile: '9876543210' }).success).toBe(false);
  });
  it('has no field for anything but the patient’s own sex', () => {
    expect(createPatientSchema.safeParse({ ...base, sex: 'X' }).success).toBe(false);
  });
  it('requires exactly one of age / dob for the live duplicate check', () => {
    const d = { firstName: 'A', mobile: '9876543210' };
    expect(duplicateCheckSchema.safeParse({ ...d, age: '3' }).success).toBe(true);
    expect(duplicateCheckSchema.safeParse(d).success).toBe(false);
  });
});
