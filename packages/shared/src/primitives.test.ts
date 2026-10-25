import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  gstRateBpSchema,
  hsnSacSchema,
  idempotencyKeySchema,
  isoDateSchema,
  MAX_PAISE,
  mobileSchema,
  nonNegativePaiseSchema,
  paiseSchema,
  pincodeSchema,
  positivePaiseSchema,
  quantitySchema,
  uhidSchema,
} from './primitives';

describe('mobileSchema', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['98765 43210', '9876543210'],
    ['98765-43210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+919876543210', '9876543210'],
    ['919876543210', '9876543210'],
    ['09876543210', '9876543210'],
    [' 6000000000 ', '6000000000'],
  ])('accepts %j', (input, out) => {
    expect(mobileSchema.parse(input)).toBe(out);
  });

  it.each([
    '',
    '12345',
    '5876543210',
    '98765432101',
    '+1 9876543210',
    '98765x3210',
    '0000000000',
    '9876543210 ext',
    '+9198765432',
    '919876543210123',
  ])('rejects %j', (input) => {
    expect(mobileSchema.safeParse(input).success).toBe(false);
  });

  it('reports a translatable error key', () => {
    const r = mobileSchema.safeParse('123');
    expect(!r.success && r.error.issues[0]?.message).toBe('mobile.invalid');
  });

  it('property: output is always 10 digits starting 6-9', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (s) => {
        const r = mobileSchema.safeParse(s);
        if (r.success) expect(r.data).toMatch(/^[6-9]\d{9}$/);
      }),
    );
  });
});

describe('uhidSchema', () => {
  it('accepts configurable prefixes and uppercases', () => {
    expect(uhidSchema.parse('UH-000123')).toBe('UH-000123');
    expect(uhidSchema.parse(' gh-000123 ')).toBe('GH-000123');
    expect(uhidSchema.parse('HOSP1-1234567')).toBe('HOSP1-1234567');
  });
  it.each(['', 'UH000123', 'UH-12', 'UH-12ab34', '-000123', 'TOOLONGPREFIX1-000123', 'U H-000123'])(
    'rejects %j',
    (s) => {
      expect(uhidSchema.safeParse(s).success).toBe(false);
    },
  );
});

describe('paise schemas', () => {
  it('parse bigint, safe integers and integer strings to bigint', () => {
    expect(paiseSchema.parse(12345n)).toBe(12345n);
    expect(paiseSchema.parse(12345)).toBe(12345n);
    expect(paiseSchema.parse('12345')).toBe(12345n);
    expect(paiseSchema.parse('-5')).toBe(-5n);
    expect(paiseSchema.parse('9223372036854775807')).toBe(MAX_PAISE);
  });

  it.each([
    1.5,
    Number.NaN,
    Infinity,
    2 ** 60,
    '1.5',
    '1e3',
    '',
    'abc',
    ' 5',
    '9223372036854775808',
    null,
    true,
  ])('rejects %j', (v) => {
    expect(paiseSchema.safeParse(v).success).toBe(false);
  });

  it('rejects bigint beyond Postgres bigint', () => {
    expect(paiseSchema.safeParse(MAX_PAISE + 1n).success).toBe(false);
    expect(paiseSchema.safeParse(-MAX_PAISE - 1n).success).toBe(false);
  });

  it('non-negative and positive variants', () => {
    expect(nonNegativePaiseSchema.parse(0)).toBe(0n);
    expect(nonNegativePaiseSchema.safeParse(-1).success).toBe(false);
    expect(positivePaiseSchema.parse('1')).toBe(1n);
    expect(positivePaiseSchema.safeParse(0).success).toBe(false);
    const r = positivePaiseSchema.safeParse(-1);
    expect(!r.success && r.error.issues[0]?.message).toBe('paise.notPositive');
  });

  it('property: every safe integer round-trips through number and string forms', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        (n) => {
          expect(paiseSchema.parse(n)).toBe(BigInt(n));
          expect(paiseSchema.parse(String(n))).toBe(BigInt(n));
        },
      ),
    );
  });
});

describe('idempotencyKeySchema', () => {
  it('accepts UUIDs (v4 and v7) and rejects the rest', () => {
    expect(idempotencyKeySchema.safeParse('3f2b8c1e-9a4d-4c6b-8e1f-0a1b2c3d4e5f').success).toBe(
      true,
    );
    expect(idempotencyKeySchema.safeParse('0192f0a8-5b7c-7c3e-8a52-5b8f2d1c9e10').success).toBe(
      true,
    );
    for (const bad of ['', 'abc', '3f2b8c1e9a4d4c6b8e1f0a1b2c3d4e5f', 42, undefined]) {
      expect(idempotencyKeySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('other primitives', () => {
  it('gst rate bp', () => {
    expect(gstRateBpSchema.safeParse(500).success).toBe(true);
    for (const bad of [-1, 10_001, 2.5, '5'])
      expect(gstRateBpSchema.safeParse(bad).success).toBe(false);
  });

  it('hsn/sac', () => {
    expect(hsnSacSchema.parse(' 9993 ')).toBe('9993');
    expect(hsnSacSchema.safeParse('99').success).toBe(false);
    expect(hsnSacSchema.safeParse('99A3').success).toBe(false);
  });

  it('pincode', () => {
    expect(pincodeSchema.parse('226001')).toBe('226001');
    expect(pincodeSchema.safeParse('026001').success).toBe(false);
    expect(pincodeSchema.safeParse('22600').success).toBe(false);
  });

  it('iso date must be a real day', () => {
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const bad of ['2027-02-29', '2026-13-01', '23-10-2026', '2026-1-1', '']) {
      expect(isoDateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('quantity is numeric(12,3), positive', () => {
    for (const ok of ['1', '0.5', '12.125', '999999999.999'])
      expect(quantitySchema.safeParse(ok).success).toBe(true);
    for (const bad of ['0', '0.000', '-1', '1.0001', '1e2', '', '1000000000']) {
      expect(quantitySchema.safeParse(bad).success).toBe(false);
    }
  });
});
