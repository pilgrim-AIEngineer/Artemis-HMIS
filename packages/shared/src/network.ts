import { z } from 'zod';

/**
 * IPv4/IPv6 CIDR matching for "is this request from the hospital LAN?" (docs/01 §5: owner/admin
 * remote access requires TOTP). Pure TypeScript so the settings schema can validate CIDRs anywhere.
 */

/** Private and loopback ranges. Tailscale (100.64.0.0/10) is deliberately absent: it is remote. */
export const DEFAULT_LAN_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

/** 128-bit value of an address; IPv4 (and IPv4-mapped IPv6) map into ::ffff:0:0/96. */
function parseIp(raw: string): bigint | null {
  const ip =
    raw
      .trim()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? '';
  const v4 = parseIpv4(ip);
  if (v4 !== null) return 0xffff00000000n | v4;
  if (!ip.includes(':')) return null;
  let tail4: bigint | null = null;
  let body = ip;
  const lastColon = ip.lastIndexOf(':');
  if (ip.slice(lastColon + 1).includes('.')) {
    tail4 = parseIpv4(ip.slice(lastColon + 1));
    if (tail4 === null) return null;
    body = `${ip.slice(0, lastColon)}:0:0`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail4 !== null) value = (value & ~0xffffffffn) | tail4;
  return value;
}

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    value = (value << 8n) | BigInt(p);
  }
  return value;
}

interface ParsedCidr {
  base: bigint;
  mask: bigint;
}

const ALL_ONES = (1n << 128n) - 1n;

function parseCidr(cidr: string): ParsedCidr | null {
  const [addr, len, extra] = cidr.trim().split('/');
  if (addr === undefined || extra !== undefined) return null;
  const base = parseIp(addr);
  if (base === null) return null;
  const isV4 = parseIpv4(addr) !== null;
  const max = isV4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const prefix = isV4 ? 96 + bits : bits;
  const mask = prefix === 0 ? 0n : (ALL_ONES << BigInt(128 - prefix)) & ALL_ONES;
  return { base: base & mask, mask };
}

export const isIpAddress = (v: string): boolean => parseIp(v) !== null;

export const isCidr = (v: string): boolean => parseCidr(v) !== null;

/** True when `ip` lies in any of `cidrs`. Invalid IPs never match (callers treat them as remote). */
export function ipInCidrs(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  const value = parseIp(ip);
  if (value === null) return false;
  return cidrs.some((c) => {
    const p = parseCidr(c);
    return p !== null && (value & p.mask) === p.base;
  });
}

export const cidrSchema = z.string().trim().refine(isCidr, 'cidr.invalid');
