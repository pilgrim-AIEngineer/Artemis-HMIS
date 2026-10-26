import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './permissions';
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  TIMELINE_ITEM_TYPES,
  TIMELINE_TYPE_PERMISSIONS,
  timelineInputSchema,
  visibleTimelineTypes,
} from './timeline';

const AT = '2028-06-05T05:30:00.123456Z';
const ID = '01a1770d-81b3-783e-a6bb-f26c0227cd0d';

describe('timeline cursor', () => {
  it('round-trips an instant with microseconds and an id', () => {
    const c = encodeTimelineCursor({ at: AT, id: ID });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTimelineCursor(c)).toEqual({ at: AT, id: ID });
  });
  it.each([
    '',
    'abc',
    '!!!',
    btoa('x|y'),
    btoa(`${AT}|nope`),
    btoa(`2028-06-05|${ID}`),
    btoa(`${AT}|${ID}|x`),
  ])('rejects %j', (raw) => expect(decodeTimelineCursor(raw)).toBeNull());
});

describe('timeline permissions', () => {
  it('only names real permission keys, and never a restricted one', () => {
    for (const t of TIMELINE_ITEM_TYPES) {
      for (const p of TIMELINE_TYPE_PERMISSIONS[t]) {
        expect(PERMISSIONS).toContain(p);
        expect(p.startsWith('mtp.')).toBe(false);
        expect(p).not.toBe('patient.view.restricted');
      }
    }
  });
  it('shows visits to anyone and the other kinds by permission', () => {
    expect(visibleTimelineTypes(new Set())).toEqual(['visit']);
    expect(visibleTimelineTypes(new Set(['rx.view']))).toEqual(['visit', 'rx', 'document']);
    expect(visibleTimelineTypes(new Set(['billing.payment.collect']))).toEqual(['visit', 'bill']);
    expect(visibleTimelineTypes(new Set(['patient.view.restricted', 'mtp.register.view']))).toEqual(
      ['visit'],
    );
  });
});

describe('timeline input', () => {
  it('defaults the page size and bounds it', () => {
    const base = { patientId: ID };
    expect(timelineInputSchema.parse(base).limit).toBe(20);
    expect(timelineInputSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(timelineInputSchema.safeParse({ ...base, limit: 51 }).success).toBe(false);
    expect(timelineInputSchema.safeParse({ ...base, types: ['mtp'] }).success).toBe(false);
  });
});
