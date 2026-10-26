import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_ORDERS,
  displayKeySchema,
  displayName,
  newAnnouncements,
  parseVisitQr,
  printsSheetAt,
  visitQrPayload,
  type DisplayFeed,
} from './display';

const feed = (now: Record<string, [number, number][]>): DisplayFeed => ({
  date: '2026-10-26',
  voice: false,
  doctors: Object.entries(now).map(([id, toks]) => ({
    id,
    name: id,
    nameHi: null,
    now: toks.map(([no, recall]) => ({ no, recall })),
    next: [],
    waiting: 0,
  })),
});

describe('displayName (first name + last initial)', () => {
  it('keeps the first name and the initial of the last name', () => {
    expect(displayName('Radha', 'Kumari')).toBe('Radha K.');
    expect(displayName('  radha  devi', 'singh')).toBe('radha S.');
    expect(displayName('Sita', null)).toBe('Sita');
    expect(displayName('Sita', '  ')).toBe('Sita');
  });
  it('takes the initial of a Devanagari surname as one character', () => {
    expect(displayName('Sita', 'कुमारी')).toBe('Sita क.');
  });
});

describe('newAnnouncements', () => {
  it('announces nothing on the first load', () => {
    expect(newAnnouncements(null, feed({ d1: [[3, 0]] }))).toEqual([]);
  });
  it('announces a newly called token and a recalled one, not an unchanged one', () => {
    const before = feed({ d1: [[3, 0]], d2: [[7, 0]] });
    expect(newAnnouncements(before, before)).toEqual([]);
    expect(newAnnouncements(before, feed({ d1: [[4, 0]], d2: [[7, 0]] }))).toEqual([
      { doctorId: 'd1', tokenNo: 4 },
    ]);
    expect(newAnnouncements(before, feed({ d1: [[3, 1]], d2: [[7, 0]] }))).toEqual([
      { doctorId: 'd1', tokenNo: 3 },
    ]);
  });
  it('is silent when a token leaves "Now"', () => {
    expect(newAnnouncements(feed({ d1: [[3, 0]] }), feed({ d1: [] }))).toEqual([]);
  });
  it('treats the same token number of two doctors separately', () => {
    expect(
      newAnnouncements(feed({ d1: [[1, 0]], d2: [] }), feed({ d1: [[1, 0]], d2: [[1, 0]] })),
    ).toEqual([{ doctorId: 'd2', tokenNo: 1 }]);
  });
});

describe('visit QR payload', () => {
  const id = '0192f0a8-5b7c-7c3e-8a52-5b8f2d1c9e10';
  it('encodes the visit id and nothing else, and reads back', () => {
    expect(visitQrPayload(id)).toBe(`E:${id}`);
    expect(parseVisitQr(visitQrPayload(id))).toBe(id);
    expect(parseVisitQr(` E:${id}\n`)).toBe(id);
  });
  it('rejects anything that is not a visit QR', () => {
    for (const bad of ['', id, `X:${id}`, 'E:12345', `E:${id}:Radha`, `E:${id.toUpperCase()}`]) {
      expect(parseVisitQr(bad)).toBeNull();
    }
  });
});

describe('display key and sheet settings', () => {
  it('accepts only 43-character base64url keys', () => {
    expect(displayKeySchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(displayKeySchema.safeParse('A'.repeat(42)).success).toBe(false);
    expect(displayKeySchema.safeParse('A'.repeat(42) + '=').success).toBe(false);
  });
  it('prints the sheet at the configured moment only', () => {
    expect(printsSheetAt('vitals', 'vitals')).toBe(true);
    expect(printsSheetAt('vitals', 'reception')).toBe(false);
    expect(printsSheetAt('reception', 'reception')).toBe(true);
  });
  it('has quick orders that fit on the sheet', () => {
    expect(DEFAULT_QUICK_ORDERS.length).toBeLessThanOrEqual(20);
  });
});
