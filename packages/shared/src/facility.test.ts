import { describe, expect, it } from 'vitest';
import { facilityProfileSchema } from './facility';
import { getSettingDefault, parseSettingValue } from './settings';

describe('facility profile', () => {
  it('needs only a name; blanks become null', () => {
    const p = facilityProfileSchema.parse({ name: ' City Hospital ', address: '  ', gstin: '' });
    expect(p).toMatchObject({
      name: 'City Hospital',
      address: null,
      gstin: null,
      drugLicenceNos: [],
    });
  });

  it('validates pincode, GSTIN (uppercased), phone and email like the DB checks', () => {
    const ok = facilityProfileSchema.parse({
      name: 'City Hospital',
      pincode: '226001',
      gstin: '09abcde1234f1z5',
      phone: '+91 522 123456',
      email: 'office@example.org',
      drugLicenceNos: ['UP-123'],
    });
    expect(ok).toMatchObject({ gstin: '09ABCDE1234F1Z5', pincode: '226001' });
    const issues = (v: object) =>
      facilityProfileSchema.safeParse({ name: 'X1', ...v }).error?.issues.map((i) => i.message);
    expect(issues({ pincode: '026001' })).toEqual(['validation.pincode']);
    expect(issues({ gstin: '123' })).toEqual(['validation.gstin']);
    expect(issues({ phone: 'abc' })).toEqual(['validation.phone']);
    expect(issues({ email: 'nope' })).toEqual(['validation.email']);
    expect(issues({ name: '' })).toEqual(['validation.required']);
  });
});

describe('print header and accent settings', () => {
  it('default to an empty bilingual header and the neutral accent (Q20)', () => {
    expect(getSettingDefault('print.header')).toMatchObject({
      nameHi: '',
      showRegistrationNos: true,
    });
    expect(getSettingDefault('ui.accentColor')).toBeNull();
    expect(parseSettingValue('ui.accentColor', '#0b6e4f')).toBe('#0b6e4f');
    expect(() => parseSettingValue('ui.accentColor', 'green')).toThrow();
  });
});
