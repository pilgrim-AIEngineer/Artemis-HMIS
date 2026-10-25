import { z } from 'zod';
import { isValidCalendarDate, parseIsoDate } from './dates';

/** Shared zod primitives; every tRPC input and form schema builds on these (docs/02 §7–8). */

/** Largest value of a Postgres `bigint`. */
export const MAX_PAISE = 9_223_372_036_854_775_807n;

const toPaise = (v: bigint | number | string): bigint | null => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
  return /^-?\d{1,19}$/.test(v) ? BigInt(v) : null;
};

/**
 * An amount in integer paise, parsed to `bigint`. Accepts a bigint, a safe integer, or a base-10
 * integer string (JSON has no bigint); fractions and floats are rejected.
 */
export const paiseSchema = z.union([z.bigint(), z.number(), z.string()]).transform((v, ctx) => {
  const p = toPaise(v);
  if (p === null || p > MAX_PAISE || p < -MAX_PAISE) {
    ctx.addIssue({ code: 'custom', message: 'paise.invalid' });
    return z.NEVER;
  }
  return p;
});

/** Paise ≥ 0 (rates, balances, tendered amounts). */
export const nonNegativePaiseSchema = paiseSchema.refine((p) => p >= 0n, {
  message: 'paise.negative',
});

/** Paise > 0 (payments, deposits; refunds are modelled as `kind = 'refund'`, not a negative input). */
export const positivePaiseSchema = paiseSchema.refine((p) => p > 0n, {
  message: 'paise.notPositive',
});

/** GST rate in basis points: integer 0…10000 (500 = 5%). */
export const gstRateBpSchema = z.number().int().min(0).max(10_000);

/** HSN (4–8 digits) or SAC (6 digits) code. */
export const hsnSacSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'hsnSac.invalid');

/** Client-generated key for payment/deposit/refund mutations (AGENTS.md rule 9). */
export const idempotencyKeySchema = z.uuid();

export const uuidSchema = z.uuid();

/**
 * Indian mobile number. Accepts `98765 43210`, `+91-9876543210`, `919876543210`, `09876543210`;
 * outputs the 10 digits. Numbers start with 6–9.
 */
export const mobileSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s\-().]/g, ''))
  .transform((s) => {
    if (/^\+91\d{10}$/.test(s)) return s.slice(3);
    if (/^91\d{10}$/.test(s)) return s.slice(2);
    if (/^0\d{10}$/.test(s)) return s.slice(1);
    return s;
  })
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'mobile.invalid'));

/** UHID such as `UH-000123` (prefix configurable per facility, docs/02 §4). Output is uppercase. */
export const uhidSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9]{1,12}-\d{4,12}$/, 'uhid.invalid'));

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'pincode.invalid');

/** `YYYY-MM-DD` that is a real calendar date (clinical `date` columns). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date.invalid')
  .refine((s) => {
    try {
      return isValidCalendarDate(parseIsoDate(s));
    } catch {
      return false;
    }
  }, 'date.invalid');

/** Quantity as `numeric(12,3)`: up to 9 integer digits and 3 decimals, > 0. */
export const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'quantity.invalid')
  .refine((s) => Number(s) > 0, 'quantity.notPositive');
