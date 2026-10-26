import { describe, expect, it } from 'vitest';
import {
  isWeakPin,
  optionalMobileSchema,
  isCommonPassword,
  passwordSchema,
  pinEntrySchema,
  pinSchema,
  totpCodeSchema,
  usernameSchema,
} from './auth';

describe('auth schemas', () => {
  it('usernames follow the DB check', () => {
    expect(usernameSchema.parse(' reception1 ')).toBe('reception1');
    for (const bad of ['ab', 'with space', 'हिंदी', 'a'.repeat(41)]) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('passwords need 12–128 characters and are not on the common list (ASVS 2.1.1, 2.1.7)', () => {
    expect(passwordSchema.safeParse('a1b2c3d4e5f').success).toBe(false); // 11
    expect(passwordSchema.safeParse('a1b2c3d4e5f6').success).toBe(true); // 12
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    for (const common of ['Password1234', 'PASSWORD-1234', 'qwerty 123456', 'aaaaaaaaaaaa']) {
      expect(passwordSchema.safeParse(common).success, common).toBe(false);
    }
    expect(isCommonPassword('hospital-1234')).toBe(true);
  });

  it('PINs are 4–6 digits and not trivially guessable', () => {
    for (const ok of ['2580', '73914', '640213', '1357']) {
      expect(pinSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['123', '1234567', '12a4', '0000', '111111', '1234', '98765', '456789']) {
      expect(pinSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(pinSchema.safeParse('1111').error?.issues[0]?.message).toBe('validation.pinWeak');
    // Entry at the lock screen checks format only.
    expect(pinEntrySchema.safeParse('1234').success).toBe(true);
  });

  it('isWeakPin', () => {
    expect(isWeakPin('0123')).toBe(true);
    expect(isWeakPin('3210')).toBe(true);
    expect(isWeakPin('1235')).toBe(false);
    expect(isWeakPin('9012')).toBe(false);
  });

  it('TOTP codes are 6 digits, spaces allowed', () => {
    expect(totpCodeSchema.parse('123 456')).toBe('123456');
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
  });

  it('optional mobile normalises or becomes null', () => {
    expect(optionalMobileSchema.parse('')).toBeNull();
    expect(optionalMobileSchema.parse(undefined)).toBeNull();
    expect(optionalMobileSchema.parse('+91 98765 43210')).toBe('9876543210');
    expect(optionalMobileSchema.safeParse('12345').success).toBe(false);
  });
});
