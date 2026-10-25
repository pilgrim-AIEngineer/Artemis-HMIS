import { describe, expect, it } from 'vitest';
import { cidrSchema, DEFAULT_LAN_CIDRS, ipInCidrs, isCidr, isIpAddress } from './network';

describe('ipInCidrs', () => {
  const lan = DEFAULT_LAN_CIDRS;

  it('treats private IPv4 and loopback as LAN', () => {
    for (const ip of ['192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.255', '127.0.0.1']) {
      expect(ipInCidrs(ip, lan), ip).toBe(true);
    }
  });

  it('treats public, Tailscale and edge-of-range IPv4 as remote', () => {
    for (const ip of ['8.8.8.8', '100.101.102.103', '172.32.0.1', '192.169.0.1', '11.0.0.1']) {
      expect(ipInCidrs(ip, lan), ip).toBe(false);
    }
  });

  it('handles IPv6, IPv4-mapped IPv6, brackets and zone ids', () => {
    expect(ipInCidrs('::1', lan)).toBe(true);
    expect(ipInCidrs('[::1]', lan)).toBe(true);
    expect(ipInCidrs('fd7a:115c:a1e0::1', lan)).toBe(true);
    expect(ipInCidrs('fe80::1%eth0', lan)).toBe(true);
    expect(ipInCidrs('::ffff:192.168.0.9', lan)).toBe(true);
    expect(ipInCidrs('::ffff:8.8.8.8', lan)).toBe(false);
    expect(ipInCidrs('2001:4860:4860::8888', lan)).toBe(false);
  });

  it('never matches missing or malformed addresses', () => {
    for (const ip of [null, undefined, '', 'localhost', '999.1.1.1', '1.2.3', '1::2::3', 'g::1']) {
      expect(ipInCidrs(ip, lan), String(ip)).toBe(false);
    }
  });

  it('supports host routes, /0 and odd prefixes', () => {
    expect(ipInCidrs('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipInCidrs('203.0.113.8', ['203.0.113.7/32'])).toBe(false);
    expect(ipInCidrs('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
    expect(ipInCidrs('192.168.7.130', ['192.168.7.128/25'])).toBe(true);
    expect(ipInCidrs('192.168.7.127', ['192.168.7.128/25'])).toBe(false);
  });

  it('validates addresses and CIDRs', () => {
    expect(isIpAddress('2001:db8::')).toBe(true);
    expect(isIpAddress('2001:db8:1:2:3:4:5:6:7')).toBe(false);
    expect(isCidr('10.0.0.0/33')).toBe(false);
    expect(isCidr('10.0.0.0/8/1')).toBe(false);
    expect(isCidr('fc00::/7')).toBe(true);
    expect(cidrSchema.safeParse(' 10.1.0.0/16 ').data).toBe('10.1.0.0/16');
    expect(cidrSchema.safeParse('lan').success).toBe(false);
    for (const c of DEFAULT_LAN_CIDRS) expect(isCidr(c), c).toBe(true);
  });
});
