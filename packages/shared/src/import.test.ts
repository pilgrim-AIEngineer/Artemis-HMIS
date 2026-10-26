import { describe, expect, it } from 'vitest';
import {
  autoMap,
  buildErrorReport,
  decodeCsvBytes,
  ImportFileError,
  mappedRow,
  parseAgeCell,
  parseBloodGroup,
  parseCsv,
  parseDateCell,
  parseGstPercentCell,
  parseGuardianCell,
  parseMobileCell,
  parseRupeesCell,
  parseSexCell,
  stageGrid,
  validatePatientRow,
  validateRateRow,
  DEFAULT_PATIENT_OPTIONS,
  DEFAULT_RATE_OPTIONS,
} from './import';

const TODAY = { year: 2026, month: 10, day: 26 };
const patient = (cells: Record<string, string>, allowMissingMobile = false) =>
  validatePatientRow(cells, { allowMissingMobile }, TODAY);
const issueCodes = (r: { ok: boolean } & Record<string, unknown>) =>
  [...((r.errors as { code: string }[] | undefined) ?? [])].map((i) => i.code);

describe('CSV reading', () => {
  it('handles quotes, embedded newlines, doubled quotes and CRLF', () => {
    expect(parseCsv('a,b,c\r\n"x, y","line1\nline2","he said ""hi"""\r\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'line1\nline2', 'he said "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('sniffs semicolon and tab delimiters', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a\tb\n1\t2')[1]).toEqual(['1', '2']);
  });

  it('decodes UTF-8 with BOM, UTF-16 and Windows-1252', () => {
    const utf8 = new TextEncoder().encode('﻿नाम,age');
    expect(decodeCsvBytes(utf8)).toBe('नाम,age');
    const u16 = new Uint8Array([0xff, 0xfe, ...[...'a,b'].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeCsvBytes(u16)).toBe('a,b');
    expect(decodeCsvBytes(new Uint8Array([0x52, 0xe9, 0x6d]))).toBe('Rém'); // é in cp1252
  });
});

describe('header detection and mapping', () => {
  const grid = [
    ['SHREE HOSPITAL - OLD OPD REGISTER', '', '', ''],
    ['', '', '', ''],
    ['Sr.', 'Patient Name', 'Age/Sex', 'Mob. No', 'W/o', 'Village'],
    ['1', 'Sunita Devi', '28 F', '98765 43210', 'Ramesh', 'Rampur'],
    ['', '', '', '', '', ''],
    ['2', 'Geeta', '30 F', '9123456780', '', ''],
  ];

  it('skips title and blank rows and keeps source row numbers', () => {
    const s = stageGrid('patients', grid);
    expect(s.headers[1]).toBe('Patient Name');
    expect(s.sourceRows).toEqual([4, 6]);
    expect(s.rows).toHaveLength(2);
    expect(s.mapping).toEqual([null, 'full_name', null, 'mobile', 'guardian_name', 'locality']);
  });

  it('maps a duplicate target only once', () => {
    expect(autoMap('patients', ['Name', 'Patient Name', 'Mobile'])).toEqual(['full_name', null, 'mobile']);
  });

  it('maps template keys and Hindi headers', () => {
    expect(autoMap('patients', ['first_name', 'sex', 'नाम', 'मोबाइल'])).toEqual([
      'first_name',
      'sex',
      'full_name',
      'mobile',
    ]);
    expect(autoMap('services_rates', ['service_code', 'Particulars', 'Rate (Rs)', 'W.E.F'])).toEqual([
      'service_code',
      'service_name',
      'rate_inr',
      'effective_from',
    ]);
  });

  it('refuses files without a recognisable header or without rows', () => {
    expect(() => stageGrid('patients', [['foo', 'bar'], ['1', '2']])).toThrow(ImportFileError);
    expect(() => stageGrid('patients', [['name', 'mobile']])).toThrow(/empty/);
    expect(() => stageGrid('patients', [])).toThrow(/empty/);
  });

  it('mappedRow drops blanks and placeholders', () => {
    expect(mappedRow(['Sunita', ' N/A ', '-', 'x'], ['first_name', 'mobile', 'district', 'state'])).toEqual({
      first_name: 'Sunita',
    });
  });
});

describe('cell parsers', () => {
  it('parses sex in English and Hindi', () => {
    expect(['F', 'female', ' Female ', 'महिला', 'M', 'Male', 'पुरुष', 'T'].map(parseSexCell)).toEqual([
      'F', 'F', 'F', 'F', 'M', 'M', 'M', 'O',
    ]);
    expect(parseSexCell('?')).toBeNull();
    expect(parseSexCell('')).toBeNull();
  });

  it('parses dates day-first, with month names, two-digit years and Excel serials', () => {
    const iso = (s: string) => {
      const d = parseDateCell(s, TODAY);
      return d && `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    };
    expect(iso('1994-07-01')).toBe('1994-07-01');
    expect(iso('01/07/1994')).toBe('1994-07-01');
    expect(iso('1-7-94')).toBe('1994-07-01');
    expect(iso('01.07.1994')).toBe('1994-07-01');
    expect(iso('1 Jul 1994')).toBe('1994-07-01');
    expect(iso('1-Jul-94')).toBe('1994-07-01');
    expect(iso('July 1, 1994')).toBe('1994-07-01');
    expect(iso('34516')).toBe('1994-07-01');
    expect(iso('15/03/12')).toBe('2012-03-15');
    expect(iso('15/03/27')).toBe('1927-03-15'); // would be in the future as 2027
    expect(iso('31/02/1994')).toBeNull();
    expect(iso('13/13/1994')).toBeNull();
    expect(iso('not a date')).toBeNull();
  });

  it('parses ages', () => {
    expect(['28', '28 yrs', '28Y', '28 Years 3 M', '28.5', '6 months', '6m', '15 days', '121', 'abc'].map(parseAgeCell)).toEqual([
      '28', '28', '28', '28', '28', '6m', '6m', '15d', null, null,
    ]);
  });

  it('parses mobiles: +91, spaces, floats, two numbers, landlines', () => {
    expect(parseMobileCell('+91 98765-43210')).toMatchObject({ mobile: '9876543210', bad: false });
    expect(parseMobileCell('098765 43210')).toMatchObject({ mobile: '9876543210' });
    expect(parseMobileCell('9876543210.0')).toMatchObject({ mobile: '9876543210' });
    expect(parseMobileCell('9876543210 / 9123456780')).toMatchObject({ mobile: '9876543210', alt: '9123456780' });
    expect(parseMobileCell('9876543210 9123456780')).toMatchObject({ mobile: '9876543210', alt: '9123456780' });
    expect(parseMobileCell('0522-2345678')).toMatchObject({ mobile: null, bad: true });
    expect(parseMobileCell('5876543210')).toMatchObject({ bad: true });
    expect(parseMobileCell('9.87654E+09')).toMatchObject({ bad: true });
    expect(parseMobileCell('')).toEqual({ mobile: null, alt: null, bad: false });
  });

  it('parses guardians written as W/o, D/o, S/o', () => {
    expect(parseGuardianCell('W/o ramesh verma')).toEqual({ name: 'Ramesh Verma', relation: 'husband' });
    expect(parseGuardianCell('w/o. Ramesh')).toEqual({ name: 'Ramesh', relation: 'husband' });
    expect(parseGuardianCell('D/o Shri Mohan Lal')).toEqual({ name: 'Mohan Lal', relation: 'father' });
    expect(parseGuardianCell('Ramesh')).toEqual({ name: 'Ramesh', relation: null });
  });

  it('normalises blood groups', () => {
    expect(['B+', 'b positive', 'O -ve', 'AB+ve', 'A neg', 'B', 'X+'].map(parseBloodGroup)).toEqual([
      'B+', 'B+', 'O-', 'AB+', 'A-', null, null,
    ]);
  });

  it('parses rupees exactly, never rounding real money', () => {
    expect(parseRupeesCell('500')).toBe(50000n);
    expect(parseRupeesCell('₹ 1,200/-')).toBe(120000n);
    expect(parseRupeesCell('Rs. 1,20,000.50')).toBe(12000050n);
    expect(parseRupeesCell('499.5')).toBe(49950n);
    expect(parseRupeesCell('499.99999999999994')).toBe(50000n); // spreadsheet float noise
    expect(parseRupeesCell('499.456')).toBeNull();
    expect(parseRupeesCell('-5')).toBeNull();
    expect(parseRupeesCell('five hundred')).toBeNull();
    expect(parseRupeesCell('1e3')).toBeNull();
  });

  it('parses GST percent to basis points', () => {
    expect(['0', '5', '5%', '12.5', 'Exempt', 'nil', '101', 'x'].map(parseGstPercentCell)).toEqual([
      0, 500, 500, 1250, 0, 0, null, null,
    ]);
  });
});

describe('patient rows', () => {
  it('accepts a messy but complete row', () => {
    const r = patient({
      old_uhid: ' OLD-12 ',
      full_name: 'smt. SUNITA devi verma',
      sex: 'female',
      age_years: '28 yrs',
      mobile: '+91 98765 43210',
      guardian_name: 'W/o ramesh verma',
      locality: 'RAMPUR',
      pincode: '226001',
      blood_group: 'b positive',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.oldUhid).toBe('OLD-12');
    expect(r.value.input).toMatchObject({
      firstName: 'Sunita',
      middleName: 'Devi',
      lastName: 'Verma',
      sex: 'F',
      age: '28',
      mobile: '9876543210',
      guardianName: 'Ramesh Verma',
      guardianRelation: 'husband',
      localityName: 'Rampur',
      bloodGroup: 'B+',
    });
  });

  it('prefers DOB, and falls back to age when the DOB is unreadable', () => {
    const a = patient({ first_name: 'A', sex: 'F', dob: '01/07/1994', age_years: '99', mobile: '9876543210' });
    expect(a.ok && a.value.input.dob).toBe('1994-07-01');
    const b = patient({ first_name: 'A', sex: 'F', dob: '??/??', age_years: '30', mobile: '9876543210' });
    expect(b.ok && b.value.input.age).toBe('30');
    expect(b.ok && b.warnings.map((w) => w.code)).toEqual(['dobIgnored']);
  });

  it('collects every problem instead of stopping at the first', () => {
    const r = patient({ first_name: '', sex: 'X', mobile: '12345' });
    expect(r.ok).toBe(false);
    expect(issueCodes(r)).toEqual(['nameRequired', 'sexInvalid', 'ageRequired', 'mobileInvalid']);
  });

  it('rejects future and impossible dates of birth', () => {
    expect(issueCodes(patient({ first_name: 'A', sex: 'F', dob: '2030-01-01', mobile: '9876543210' }))).toEqual(['dobOutOfRange']);
    expect(issueCodes(patient({ first_name: 'A', sex: 'F', dob: '31/02/2000', mobile: '9876543210' }))).toEqual(['dobInvalid']);
  });

  it('needs a mobile unless the option allows importing without', () => {
    const base = { first_name: 'A', sex: 'F', age_years: '30' };
    expect(issueCodes(patient(base))).toEqual(['mobileRequired']);
    const ok = patient(base, true);
    expect(ok.ok && ok.value.input.noMobileReason).toBe('Not in old register');
    expect(ok.ok && ok.warnings.map((w) => w.code)).toEqual(['mobileMissing']);
  });

  it('drops optional junk with a warning instead of failing the row', () => {
    const r = patient({ first_name: 'A', sex: 'F', age_years: '30', mobile: '9876543210', pincode: '1234', blood_group: 'zz', guardian_relation: 'neighbour' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.map((w) => w.code).sort()).toEqual(['bloodGroupIgnored', 'pincodeIgnored', 'relationIgnored']);
  });

  it('keeps the second mobile as alternate', () => {
    const r = patient({ first_name: 'A', sex: 'F', age_years: '30', mobile: '9876543210 / 9123456780' });
    expect(r.ok && r.value.input.altMobile).toBe('9123456780');
  });

  it('title-cases a lone name column and respects separate name columns', () => {
    const r = patient({ first_name: 'RAJ', last_name: 'kumar singh', sex: 'M', age_years: '40', mobile: '9876543210' });
    expect(r.ok && [r.value.input.firstName, r.value.input.lastName]).toEqual(['Raj', 'Kumar Singh']);
  });
});

describe('rate rows', () => {
  const good = {
    service_code: ' cons gyn new ',
    service_name: 'Gynae   consultation – new',
    category: 'OPD consultation',
    tariff_name: 'Standard (Cash)',
    rate_inr: '₹ 500/-',
    effective_from: '01/04/2026',
    gst_rate_percent: 'Exempt',
  };

  it('accepts a messy row and converts to paise', () => {
    const r = validateRateRow(good, DEFAULT_RATE_OPTIONS, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      serviceCode: 'CONS-GYN-NEW',
      serviceName: 'Gynae consultation – new',
      category: 'consultation',
      ratePaise: 50000n,
      effectiveFrom: '2026-04-01',
      gstRateBp: 0,
      unit: null,
    });
  });

  it('reports all problems', () => {
    const r = validateRateRow({ service_code: '!', category: 'magic', rate_inr: '12.345', room_category: 'ICU' }, DEFAULT_RATE_OPTIONS, TODAY);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => e.code)).toEqual([
      'codeInvalid', 'serviceNameRequired', 'categoryInvalid', 'tariffRequired', 'roomCategoryUnsupported', 'rateInvalid', 'dateRequired',
    ]);
  });

  it('uses the default effective date only when the option is set, and says so', () => {
    const row = { ...good, effective_from: '' };
    expect(validateRateRow(row, DEFAULT_RATE_OPTIONS, TODAY).ok).toBe(false);
    const r = validateRateRow(row, { defaultEffectiveFrom: '2026-10-26' }, TODAY);
    expect(r.ok && r.value.effectiveFrom).toBe('2026-10-26');
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['dateDefaulted']);
  });

  it('rejects absurd effective dates and invalid SAC / GST', () => {
    expect(!validateRateRow({ ...good, effective_from: '01/04/1999' }, DEFAULT_RATE_OPTIONS, TODAY).ok).toBe(true);
    expect(!validateRateRow({ ...good, effective_from: '01/04/2028' }, DEFAULT_RATE_OPTIONS, TODAY).ok).toBe(true);
    const r = validateRateRow({ ...good, sac_code: '99', gst_rate_percent: 'abc' }, DEFAULT_RATE_OPTIONS, TODAY);
    expect(!r.ok && r.errors.map((e) => e.code)).toEqual(['sacInvalid', 'gstInvalid']);
  });

  it('is not tripped by the default patient options constant', () => {
    expect(DEFAULT_PATIENT_OPTIONS.allowMissingMobile).toBe(false);
  });
});

describe('error report', () => {
  it('keeps the original columns after the row number, status and problems', () => {
    const rows = buildErrorReport(
      ['Name', 'Mobile'],
      [{ sourceRow: 7, raw: ['Geeta', '123'], status: 'error', issues: [{ field: 'mobile', code: 'mobileInvalid' }] }],
      { row: 'Row', status: 'Status', problems: 'Problems', statuses: { error: 'Error' } },
      (i) => `${i.field}:${i.code}`,
    );
    expect(rows).toEqual([
      ['Row', 'Status', 'Problems', 'Name', 'Mobile'],
      [7, 'Error', 'mobile:mobileInvalid', 'Geeta', '123'],
    ]);
  });
});
