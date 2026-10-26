import type { QueuePriority } from '@hmis/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { encounter, opdToken, queueEvent } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { seedFacility } from '../testing/platform';
import {
  advanceToken,
  autoNoShow,
  callNext,
  cancelVisit,
  markDone,
  markNoShow,
  markSeen,
  queueBoard,
  recall,
  reinstate,
  sendIn,
  setPriority,
  skip,
  transfer,
} from './queue';
import { writeSetting } from './settings';
import { issueToken } from './visits';

let fx: OpdFixture;
let day = 0;

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await fx.t.close();
});

/** A fresh business day per test keeps token numbers and boards independent. */
const nextDay = () => {
  day += 1;
  const d = String(day).padStart(2, '0');
  return (hh = '09', mm = '00') => IST(`2028-03-${d}T${hh}:${mm}:00`);
};

/** Visits for `n` new patients with the doctor, tokens issued in order. Returns token ids. */
async function queueUp(
  at: Date,
  n: number,
  opts: { doctorId?: string; priorities?: Record<number, QueuePriority> } = {},
) {
  const doctorId = opts.doctorId ?? fx.doctorB;
  const out: { tokenId: string; tokenNo: number; encounterId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const patientId = await fx.newPatient();
    const v = await fx.visit(
      { patientId, doctorId, priority: opts.priorities?.[i] ?? 'normal' },
      at,
    );
    const tok = await fx.run((tx) =>
      issueToken(tx, fx.actor(), v.encounterId, 'manual_fee_pending', at),
    );
    out.push({ tokenId: tok.tokenId, tokenNo: tok.tokenNo, encounterId: v.encounterId });
  }
  return out;
}

const state = async (tokenId: string) =>
  (await fx.t.app.select().from(opdToken).where(eq(opdToken.id, tokenId)))[0]!;
const act = <T>(fn: (tx: Parameters<Parameters<OpdFixture['run']>[0]>[0]) => Promise<T>) =>
  fx.run(fn);

describe('call next and priorities (REG-04)', () => {
  it('calls in token order, but emergency and labour jump ahead (red first)', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 5, { priorities: { 3: 'labour', 4: 'elderly' } });
    const called: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
      called.push(t.tokenNo);
      await act((tx) => markSeen(tx, fx.actor(), t.id, at()));
    }
    expect(called).toEqual([4, 5, 1, 2, 3]);
    expect(toks).toHaveLength(5);
    await expect(act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()))).rejects.toMatchObject({
      key: 'queue.nothingWaiting',
    });
  });

  it('follows the configured priority order', async () => {
    const at = nextDay();
    await queueUp(at(), 3, { priorities: { 1: 'staff', 2: 'elderly' } });
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'queue.priorityOrder', ['staff', 'elderly']),
    );
    const first = await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'queue.priorityOrder', [
        'emergency',
        'labour',
        'elderly',
        'staff',
        'vip',
      ]),
    );
    expect(first.tokenNo).toBe(2);
  });

  it('two doctor rooms pressing Call next together never get the same patient', async () => {
    const at = nextDay();
    await queueUp(at(), 6);
    const got = await Promise.all(
      Array.from({ length: 6 }, () => act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()))),
    );
    expect(new Set(got.map((g) => g.id)).size).toBe(6);
    expect(got.map((g) => g.tokenNo).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('changes priority of a waiting patient, not of one already with the doctor', async () => {
    const at = nextDay();
    const [a, b] = await queueUp(at(), 2);
    await act((tx) => setPriority(tx, fx.actor(), b!.tokenId, 'emergency', at()));
    const [enc] = await fx.t.app.select().from(encounter).where(eq(encounter.id, b!.encounterId));
    expect(enc?.priority).toBe('emergency');
    const next = await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
    expect(next.id).toBe(b!.tokenId);
    await expect(
      act((tx) => setPriority(tx, fx.actor(), b!.tokenId, 'normal', at())),
    ).rejects.toMatchObject({ key: 'queue.notPending' });
    expect(a).toBeDefined();
  });
});

describe('state machine (REG-04)', () => {
  it('walks waiting → vitals_done → with_doctor → seen → rx_entered → billed_orders → done and logs each step', async () => {
    const at = nextDay();
    const [a] = await queueUp(at(), 1);
    const id = a!.tokenId;
    await act((tx) => advanceToken(tx, fx.actor(), id, 'vitals_done', at('09', '05')));
    await act((tx) => sendIn(tx, fx.actor(), id, at('09', '10')));
    await act((tx) => markSeen(tx, fx.actor(), id, at('09', '20')));
    await act((tx) => advanceToken(tx, fx.actor(), id, 'rx_entered', at('09', '30')));
    await act((tx) => advanceToken(tx, fx.actor(), id, 'billed_orders', at('09', '35')));
    await act((tx) => markDone(tx, fx.actor(), id, at('09', '40')));
    const row = await state(id);
    expect(row).toMatchObject({ queueState: 'done' });
    expect(row.vitalsAt).toEqual(at('09', '05'));
    expect(row.calledAt).toEqual(at('09', '10'));
    expect(row.seenAt).toEqual(at('09', '20'));
    expect(row.doneAt).toEqual(at('09', '40'));
    const events = await fx.t.app
      .select()
      .from(queueEvent)
      .where(eq(queueEvent.tokenId, id))
      .orderBy(queueEvent.at);
    expect(events.map((e) => e.toState)).toEqual([
      'waiting',
      'vitals_done',
      'with_doctor',
      'seen',
      'rx_entered',
      'billed_orders',
      'done',
    ]);
    expect(events.every((e) => e.byUser === fx.f.userId)).toBe(true);
  });

  it('refuses backward and final-state moves', async () => {
    const at = nextDay();
    const [a] = await queueUp(at(), 1);
    const id = a!.tokenId;
    await act((tx) => markSeen(tx, fx.actor(), id, at()));
    for (const to of ['waiting', 'vitals_done', 'with_doctor'] as const) {
      await expect(act((tx) => advanceToken(tx, fx.actor(), id, to, at()))).rejects.toMatchObject({
        key: 'queue.invalidTransition',
      });
    }
    await expect(act((tx) => markNoShow(tx, fx.actor(), id, 'left', at()))).rejects.toMatchObject({
      key: 'queue.invalidTransition',
    });
    await act((tx) => markDone(tx, fx.actor(), id, at()));
    await expect(act((tx) => markSeen(tx, fx.actor(), id, at()))).rejects.toMatchObject({
      key: 'queue.invalidTransition',
    });
  });

  it('recall counts announcements and only works on the called patient', async () => {
    const at = nextDay();
    const [a, b] = await queueUp(at(), 2);
    await expect(act((tx) => recall(tx, fx.actor(), a!.tokenId, at()))).rejects.toMatchObject({
      key: 'queue.invalidTransition',
    });
    await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
    await act((tx) => recall(tx, fx.actor(), a!.tokenId, at()));
    await act((tx) => recall(tx, fx.actor(), a!.tokenId, at()));
    expect(await state(a!.tokenId)).toMatchObject({ queueState: 'with_doctor', recallCount: 2 });
    expect(b).toBeDefined();
  });

  it('skip puts a waiting patient behind the next three', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 6);
    await act((tx) => skip(tx, fx.actor(), toks[0]!.tokenId, at()));
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
      order.push(t.tokenNo);
      await act((tx) => markSeen(tx, fx.actor(), t.id, at()));
    }
    expect(order).toEqual([2, 3, 4, 1, 5, 6]);
  });

  it('a called patient who does not come in returns to the queue behind the next three', async () => {
    const at = nextDay();
    await queueUp(at(), 6);
    const first = await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
    expect(first.tokenNo).toBe(1);
    const back = await act((tx) => skip(tx, fx.actor(), first.id, at()));
    expect(back.queueState).toBe('waiting');
    const board = await fx.run((tx) =>
      queueBoard(tx, fx.f.facilityId, { doctorIds: [fx.doctorB] }, at()),
    );
    expect(board.columns[0]!.active.map((x) => x.tokenNo)).toEqual([2, 3, 4, 1, 5, 6]);
  });

  it('skip returns to vitals_done when vitals were taken', async () => {
    const at = nextDay();
    const [a] = await queueUp(at(), 2);
    await act((tx) => advanceToken(tx, fx.actor(), a!.tokenId, 'vitals_done', at()));
    await act((tx) => sendIn(tx, fx.actor(), a!.tokenId, at()));
    const back = await act((tx) => skip(tx, fx.actor(), a!.tokenId, at()));
    expect(back.queueState).toBe('vitals_done');
  });

  it('no-show needs a reason, can be reinstated the same day only', async () => {
    const at = nextDay();
    const [a] = await queueUp(at(), 1);
    await act((tx) => markNoShow(tx, fx.actor(), a!.tokenId, 'Went home', at()));
    expect(await state(a!.tokenId)).toMatchObject({
      queueState: 'no_show',
      stateReason: 'Went home',
    });
    await expect(
      fx.t.owner.execute(sql`update opd_token set state_reason = null where id = ${a!.tokenId}`),
    ).rejects.toThrow();
    const next = nextDay();
    await expect(act((tx) => reinstate(tx, fx.actor(), a!.tokenId, next()))).rejects.toMatchObject({
      key: 'queue.notToday',
    });
    const back = await act((tx) => reinstate(tx, fx.actor(), a!.tokenId, at('11')));
    expect(back).toMatchObject({ queueState: 'waiting', stateReason: null });
  });

  it('transfer gives a new number in the other doctor’s queue and moves the visit', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 2, { doctorId: fx.doctorB });
    await queueUp(at(), 3, { doctorId: fx.doctorA });
    const moved = await act((tx) => transfer(tx, fx.actor(), toks[0]!.tokenId, fx.doctorA, at()));
    expect(moved).toMatchObject({ doctorId: fx.doctorA, tokenNo: 4, queueState: 'waiting' });
    const [enc] = await fx.t.app
      .select()
      .from(encounter)
      .where(eq(encounter.id, toks[0]!.encounterId));
    expect(enc?.doctorId).toBe(fx.doctorA);
    await expect(
      act((tx) => transfer(tx, fx.actor(), toks[0]!.tokenId, fx.doctorA, at())),
    ).rejects.toMatchObject({ key: 'queue.sameDoctor' });
    await expect(
      act((tx) => transfer(tx, fx.actor(), toks[1]!.tokenId, fx.f.userId, at())),
    ).rejects.toMatchObject({ key: 'visit.doctorNotFound' });
  });

  it('cancelling a visit cancels its token with a reason; seen visits cannot be cancelled', async () => {
    const at = nextDay();
    const [a, b] = await queueUp(at(), 2);
    await act((tx) => cancelVisit(tx, fx.actor(), a!.encounterId, 'Wrong doctor', at()));
    expect(await state(a!.tokenId)).toMatchObject({
      queueState: 'cancelled',
      stateReason: 'Wrong doctor',
    });
    const [enc] = await fx.t.app.select().from(encounter).where(eq(encounter.id, a!.encounterId));
    expect(enc).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Wrong doctor',
      cancelledBy: fx.f.userId,
    });
    await expect(
      act((tx) => cancelVisit(tx, fx.actor(), a!.encounterId, 'again', at())),
    ).rejects.toMatchObject({
      key: 'visit.notOpen',
    });
    await act((tx) => markSeen(tx, fx.actor(), b!.tokenId, at()));
    await expect(
      act((tx) => cancelVisit(tx, fx.actor(), b!.encounterId, 'late', at())),
    ).rejects.toMatchObject({
      key: 'visit.notCancellable',
    });
    expect((await state(b!.tokenId)).queueState).toBe('seen');
  });

  it('end of day marks only unseen tokens no-show, with a reason and no actor', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 4);
    await act((tx) => advanceToken(tx, fx.actor(), toks[1]!.tokenId, 'vitals_done', at()));
    await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
    const n = await fx.run((tx) =>
      autoNoShow(tx, fx.f.facilityId, '2028-03-' + String(day).padStart(2, '0'), at('23', '30')),
    );
    expect(n).toBe(3);
    const states = await Promise.all(toks.map((x) => state(x.tokenId)));
    expect(states.map((s) => s.queueState)).toEqual([
      'with_doctor',
      'no_show',
      'no_show',
      'no_show',
    ]);
    expect(states[1]!.stateReason).toMatch(/end of day/i);
    const [ev] = await fx.t.app
      .select()
      .from(queueEvent)
      .where(eq(queueEvent.tokenId, toks[3]!.tokenId))
      .orderBy(sql`at desc`);
    expect(ev).toMatchObject({ action: 'auto_no_show', byUser: null });
  });
});

describe('board read model', () => {
  it('lists OPD doctors, current patient first, then the queue, finished last; and visits awaiting a token', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 4);
    await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at())); // 1 with doctor
    await act((tx) => markNoShow(tx, fx.actor(), toks[3]!.tokenId, 'left', at()));
    await fx.visit({ patientId: await fx.newPatient(), doctorId: fx.doctorA }, at()); // fee ₹500 → no token
    const board = await fx.run((tx) => queueBoard(tx, fx.f.facilityId, {}, at()));
    expect(board.date).toBe('2028-03-' + String(day).padStart(2, '0'));
    const names = board.columns.map((c) => c.doctor.displayName);
    expect(names).toContain('Dr. B');
    expect(names).not.toContain('Dr. C'); // no rule, no token: not an OPD doctor
    const b = board.columns.find((c) => c.doctor.displayName === 'Dr. B')!;
    expect(b.active.map((x) => [x.tokenNo, x.queueState])).toEqual([
      [1, 'with_doctor'],
      [2, 'waiting'],
      [3, 'waiting'],
    ]);
    expect(b.finished.map((x) => x.tokenNo)).toEqual([4]);
    expect(board.awaitingToken).toHaveLength(1);
    expect(board.awaitingToken[0]).toMatchObject({ feePaise: '50000', feeBasis: 'tariff' });
  });

  it('shows another hospital nothing and lets it touch nothing', async () => {
    const at = nextDay();
    const [a] = await queueUp(at(), 1);
    const other = await seedFacility(fx.t.owner, 'Other');
    const board = await fx.run((tx) => queueBoard(tx, other.facilityId, {}, at()));
    expect(board.columns).toEqual([]);
    await expect(
      fx.run((tx) =>
        markSeen(tx, { facilityId: other.facilityId, userId: other.userId }, a!.tokenId, at()),
      ),
    ).rejects.toMatchObject({ key: 'queue.tokenNotFound' });
  });
});

describe('change notification (docs/01 §2)', () => {
  it('notifies hmis_events with ids only, on commit', async () => {
    const at = nextDay();
    const listener = new (await import('pg')).default.Client({
      connectionString: fx.t.owner.$client.options.connectionString,
    });
    await listener.connect();
    const got: string[] = [];
    listener.on('notification', (n) => got.push(n.payload ?? ''));
    await listener.query('LISTEN hmis_events');
    await queueUp(at(), 1);
    await new Promise((r) => setTimeout(r, 300));
    await listener.end();
    expect(got.length).toBeGreaterThan(0);
    const payload = JSON.parse(got[0]!) as Record<string, string>;
    expect(Object.keys(payload).sort()).toEqual(['d', 'f', 't']);
    expect(payload).toMatchObject({ f: fx.f.facilityId, t: 'queue', d: fx.doctorB });
  });
});

describe('scheduled end of day', () => {
  it('runs for every active facility and leaves seen patients alone', async () => {
    const at = nextDay();
    const toks = await queueUp(at(), 3);
    await act((tx) => callNext(tx, fx.actor(), fx.doctorB, at()));
    const { runEndOfDayNoShow } = await import('./queue');
    const out = await runEndOfDayNoShow(fx.t.app, at('23', '30'));
    expect(out[fx.f.facilityId]).toBe(2);
    const states = await Promise.all(toks.map((x) => state(x.tokenId)));
    expect(states.map((s) => s.queueState)).toEqual(['with_doctor', 'no_show', 'no_show']);
    expect((await runEndOfDayNoShow(fx.t.app, at('23', '31')))[fx.f.facilityId]).toBe(0);
  });
});
