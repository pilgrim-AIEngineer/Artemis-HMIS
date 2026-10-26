import { DISPLAY_NEXT_COUNT } from '@hmis/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, patient } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { seedFacility } from '../testing/platform';
import {
  displayFeed,
  facilityForDisplayKey,
  hasDisplayKey,
  hashDisplayKey,
  newDisplayKey,
  rotateDisplayKey,
} from './display';
import { callNext, recall, setPriority } from './queue';
import { writeSetting } from './settings';
import { withTx } from './tx';
import { issueToken } from './visits';

let fx: OpdFixture;
let day = 0;
beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

const nextDay = () => {
  day += 1;
  return (hh = '09') => IST(`2029-04-${String(day).padStart(2, '0')}T${hh}:00:00`);
};

/** `n` patients with tokens for the doctor; names are synthetic. */
async function queueUp(at: Date, n: number, doctorId = fx.doctorB) {
  const out: { tokenId: string; tokenNo: number; patientId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const patientId = await fx.newPatient();
    await fx.t.app
      .update(patient)
      .set({ firstName: `Radha${i}`, lastName: 'Kumari', mobile: '9876543210' })
      .where(eq(patient.id, patientId));
    const v = await fx.visit({ patientId, doctorId }, at);
    const t = await fx.run((tx) =>
      issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', at),
    );
    out.push({ tokenId: t.tokenId, tokenNo: t.tokenNo, patientId });
  }
  return out;
}

describe('display key (REG-05)', () => {
  it('stores only a hash and finds the facility by key', async () => {
    expect(await hasDisplayKey(fx.t.app, fx.f.facilityId)).toBe(false);
    const key = await fx.run((tx) => rotateDisplayKey(tx, fx.f.facilityId));
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hasDisplayKey(fx.t.app, fx.f.facilityId)).toBe(true);
    expect(await facilityForDisplayKey(fx.t.app, key)).toBe(fx.f.facilityId);

    // The database (setting and its audit trail) never holds the key itself.
    const dump = JSON.stringify(
      await fx.t.owner.execute(sql`select value from setting where key = 'queue.displayKey'`),
    );
    const audit = JSON.stringify(
      await fx.t.owner.select().from(auditLog).where(eq(auditLog.tableName, 'setting')),
    );
    expect(dump).toContain(hashDisplayKey(key));
    expect(dump + audit).not.toContain(key);
  });

  it('switches the old key off when a new one is made', async () => {
    const first = await fx.run((tx) => rotateDisplayKey(tx, fx.f.facilityId));
    const second = await fx.run((tx) => rotateDisplayKey(tx, fx.f.facilityId));
    expect(first).not.toBe(second);
    expect(await facilityForDisplayKey(fx.t.app, first)).toBeNull();
    expect(await facilityForDisplayKey(fx.t.app, second)).toBe(fx.f.facilityId);
  });

  it('rejects malformed, unknown and empty keys without touching the database', async () => {
    for (const bad of ['', 'short', 'A'.repeat(43), `${newDisplayKey()}x`, '%27 or 1=1']) {
      expect(await facilityForDisplayKey(fx.t.app, bad)).toBeNull();
    }
  });

  it('keeps facilities apart', async () => {
    const other = await seedFacility(fx.t.owner);
    const otherKey = await withTx(
      { db: fx.t.app, userId: other.userId, facilityId: other.facilityId },
      (tx) => rotateDisplayKey(tx, other.facilityId),
    );
    expect(await facilityForDisplayKey(fx.t.app, otherKey)).toBe(other.facilityId);
    expect(await displayFeed(fx.t.app, other.facilityId, new Date())).toMatchObject({
      doctors: [],
    });
  });
});

describe('display feed (tokens only)', () => {
  it('shows Now and Next per doctor, in queue order, and nothing about the patient', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 8);
    await fx.run((tx) => callNext(tx, fx.actor(), fx.doctorB, at('10')));
    const feed = await displayFeed(fx.t.app, fx.f.facilityId, at('10'));
    const d = feed.doctors.find((x) => x.name === 'Dr. B')!;
    expect(d.now).toEqual([{ no: toks[0]!.tokenNo, recall: 0 }]);
    expect(d.next.map((t) => t.no)).toEqual(
      toks.slice(1, 1 + DISPLAY_NEXT_COUNT).map((t) => t.tokenNo),
    );
    expect(d.waiting).toBe(7);

    // The whole payload is ids, numbers and doctor names: no patient field of any kind.
    const json = JSON.stringify(feed);
    for (const secret of ['Radha', 'Kumari', '9876', 'uhid', 'T-0', '1990']) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(d).sort()).toEqual(['id', 'name', 'nameHi', 'next', 'now', 'waiting']);
    expect(Object.keys(d.next[0]!).sort()).toEqual(['no', 'recall']);
  });

  it('puts urgent patients first and counts recalls', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 4);
    await fx.run((tx) => setPriority(tx, fx.actor(), toks[3]!.tokenId, 'emergency', at()));
    const before = await displayFeed(fx.t.app, fx.f.facilityId, at());
    expect(before.doctors.find((x) => x.name === 'Dr. B')!.next[0]!.no).toBe(toks[3]!.tokenNo);

    const called = await fx.run((tx) => callNext(tx, fx.actor(), fx.doctorB, at('10')));
    await fx.run((tx) => recall(tx, fx.actor(), called.id, at('10')));
    const after = await displayFeed(fx.t.app, fx.f.facilityId, at('10'));
    expect(after.doctors.find((x) => x.name === 'Dr. B')!.now).toEqual([
      { no: called.tokenNo, recall: 1 },
    ]);
  });

  it('shows first name + last initial only when the setting is on', async () => {
    const at = nextDay();
    await queueUp(at(), 2);
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'queue.showNameOnDisplay', true));
    try {
      const feed = await displayFeed(fx.t.app, fx.f.facilityId, at());
      const names = feed.doctors.find((x) => x.name === 'Dr. B')!.next.map((t) => t.name);
      expect(names).toEqual(['Radha0 K.', 'Radha1 K.']);
      const json = JSON.stringify(feed);
      expect(json).not.toContain('Kumari');
      expect(json).not.toContain('9876');
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'queue.showNameOnDisplay', false));
    }
  });

  it('lists only today’s waiting and called tokens', async () => {
    const yesterday = nextDay();
    await queueUp(yesterday(), 2, fx.doctorA);
    const today = nextDay();
    const feed = await displayFeed(fx.t.app, fx.f.facilityId, today());
    expect(feed.doctors.find((x) => x.name === 'Dr. A')).toBeUndefined();
  });

  it('carries the voice setting', async () => {
    const at = nextDay();
    expect((await displayFeed(fx.t.app, fx.f.facilityId, at())).voice).toBe(false);
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'queue.displayVoice', true));
    expect((await displayFeed(fx.t.app, fx.f.facilityId, at())).voice).toBe(true);
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'queue.displayVoice', false));
  });
});
