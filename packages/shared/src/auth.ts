import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { USER_LOCALES } from './enums';
import { mobileSchema } from './primitives';

/**
 * Auth input schemas shared by the login/PIN/user-management forms and the tRPC procedures
 * (FND-02/03, docs/01 §5, docs/03). Messages are i18n keys under `validation.*`.
 */

/** Same rule as the `app_user_username_format` CHECK; stored as typed, compared lowercase. */
export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,40}$/, 'validation.username');

/** OWASP ASVS 2.1.1: at least 12 characters, no composition rules (2.1.9). */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Passwords everyone tries first (ASVS 2.1.7, a short built-in list: the server has no internet
 * to check a breach corpus). Compared lowercase, ignoring spaces, dashes and underscores.
 */
const COMMON_PASSWORDS = [
  'password1234',
  'password12345',
  'passw0rd1234',
  'qwerty123456',
  'qwertyuiop12',
  '123456789012',
  '1234567890123',
  'iloveyou1234',
  'admin1234567',
  'administrator',
  'welcome12345',
  'changeme1234',
  'letmein12345',
  'hospital1234',
  'hospital12345',
  'hmis12345678',
  'abcd12345678',
  'india1234567',
  'india@123456',
  'password@123',
  'password@1234',
  'admin@123456',
  'welcome@1234',
] as const;

/** True for a password on the built-in common list, or one that is a single repeated character. */
export function isCommonPassword(password: string): boolean {
  const norm = password.toLowerCase().replace(/[\s_-]/g, '');
  return (COMMON_PASSWORDS as readonly string[]).includes(norm) || /^(.)\1+$/.test(norm);
}

/** Length is what matters for staff passwords; argon2 input is capped to bound hashing cost. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, 'validation.passwordShort')
  .max(128, 'validation.passwordLong')
  .refine((p) => !isCommonPassword(p), 'validation.passwordCommon');

/** Login accepts whatever was typed (old/legacy passwords); only the length cap applies. */
export const loginPasswordSchema = z.string().min(1, 'validation.required').max(128);

/**
 * PINs too easy to guess on a shared counter: one repeated digit (`0000`) or a straight run
 * (`1234`, `98765`). The PIN also approves discounts and refunds (docs/03 §4).
 */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

/** 4–6 digit PIN for quick unlock (AGENTS.md §2). */
export const pinSchema = z
  .string()
  .regex(/^\d{4,6}$/, 'validation.pinFormat')
  .refine((p) => !isWeakPin(p), 'validation.pinWeak');

/** Entered PIN at the lock screen: format only (weak PINs set before a rule change still work). */
export const pinEntrySchema = z.string().regex(/^\d{4,6}$/, 'validation.pinFormat');

export const totpCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'validation.totpFormat'));

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'validation.required')
  .max(120)
  .refine(...noForbiddenTerms('always'));

export const userLocaleSchema = z.enum(USER_LOCALES);

/** Admin-entered reason for deactivations and revocations (AGENTS.md rule 4). */
export const reasonSchema = z
  .string()
  .trim()
  .min(3, 'validation.reason')
  .max(500)
  .refine(...noForbiddenTerms('always'));

export const optionalMobileSchema = z
  .union([z.literal(''), mobileSchema])
  .optional()
  .transform((v) => (v ? v : null));
