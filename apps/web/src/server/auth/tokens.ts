import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL/cookie safe. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are stored only as SHA-256 hex (a DB leak does not yield usable cookies). */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
