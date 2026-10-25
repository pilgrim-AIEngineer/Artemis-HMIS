import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 digits): what Google Authenticator, Microsoft
 * Authenticator and similar phone apps expect. Owner/admin remote access (docs/01 §5).
 */

export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New 160-bit secret, base32 (the form shown to the user for manual entry). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/** HOTP value (RFC 4226) for a time step. */
export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

/**
 * Accepts the current step ±1 (phone clocks drift) and returns the matched step, or null.
 * A step at or before `lastUsedStep` is refused, so a code cannot be replayed.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date,
  lastUsedStep: number | null,
): number | null {
  const now = totpStep(at);
  for (const step of [now, now - 1, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (totpCode(secretBase32, step) === code) return step;
  }
  return null;
}

/** `otpauth://` URI for the QR code (Key Uri Format). */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
