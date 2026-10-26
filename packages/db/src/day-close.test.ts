/**
 * BIL-06 integration tests against a real Postgres: the user close (denomination counter,
 * variance and its reason, stale expected cash), the lock on counted payments, late entries after
 * a facility close going to the next business day, pending counters, the commit-time total checks
 * (docs/12 §9: the close equals the sum of the payments exactly) and the UPI reconciliation.
 * Each group works in its own facility, because a facility close is facility-wide and permanent.
 * Synthetic data only.
 */
import type { RoleKey, TenderInput } from '@hmis/shared';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { appUser, dayClose, payment, reasonCode, upiReconciliationItem } from '../schema';
import { IST, seedOpdData } from '../testing/opd';
import {
  seedFacility,
  setupPlatformDb,
  type PlatformTestDb,
  type SeededFacility,
} from '../testing/platform';
import { collectPayment } from './billing';
import { cancelFinalBill } from './billing-adjustments';
import {
  closeFacilityDay,
  closeOwnDay,
  DayCloseInputError,
  dayCloseReport,
  facilityCloseView,
  loadDayClose,
  openCounter,
  pendingUpiReconciliations,
  saveUpiReconciliation,
  upiReconciliationView,
} from './day-close';
import { IdempotencyConflictError } from './idempotency';
import { hashSecret } from './password';
import { ensureFacilityRbac, grantRoles } from './rbac';
import { withTx, type Tx } from './tx';

let t: PlatformTestDb;

interface World {
  f: SeededFacility;
  opd: Awaited<ReturnType<typeof seedOpdData>>;
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  cashier: TestUser;
  cashier2: TestUser;
  admin: TestUser;
}
interface TestUser {
  id: string;
  username: string;
}

async function mkUser(f: SeededFacility, role: RoleKey): Promise<TestUser> {
  const id = uuidv7();
  const username = `${role}_${randomBytes(3).toString('hex')}`;
  await t.owner.insert(appUser).values({
    id,
    facilityId: f.facilityId,
    username,
    fullName: `Test ${username}`,
    pinHash: await hashSecret('4821'),
  });
  await withTx({ db: t.owner, userId: null }, (tx) => grantRoles(tx, f.facilityId, id, [role]));
  return { id, username };
}

async function world(): Promise<World> {
  const f = await seedFacility(t.owner);
  await withTx({ db: t.owner, userId: null }, (tx) => ensureFacilityRbac(tx, f.facilityId));
  const opd = await seedOpdData(t, f);
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTx({ db: t.app, userId: f.userId, facilityId: f.facilityId }, fn);
  const [cashier, cashier2, admin] = await Promise.all([
    mkUser(f, 'cashier'),
    mkUser(f, 'cashier'),
    mkUser(f, 'admin'),
  ]);
  return { f, opd, run, cashier, cashier2, admin };
}

beforeAll(async () => {
  t = await setupPlatformDb(inject('testPgAdminUrl'));
});
afterAll(async () => {
  await t.close();
});

const DEN0 = { n500: 0, n200: 0, n100: 0, n50: 0, n20: 0, n10: 0, coinsPaise: 0 };
const cash = (amountPaise: bigint | number): TenderInput => ({ mode: 'cash', amountPaise });
const upi = (amountPaise: bigint | number, upiRef?: string): TenderInput => ({
  mode: 'upi',
  amountPaise,
  ...(upiRef ? { upiRef } : {}),
});

const as = (w: World, u: TestUser) => ({
  facilityId: w.f.facilityId,
  userId: u.id,
  workstationId: w.f.workstationId,
});

/** One ₹500 OPD visit paid in full with `tenders` (which must add up to ₹500) at `at`. */
async function pay(w: World, who: TestUser, tenders: TenderInput[], at: Date) {
  const v = await w.opd.visit({ patientId: await w.opd.newPatient() }, at);
  return w.run((tx) =>
    collectPayment(tx, as(w, who), { billId: v.billId, tenders, idempotencyKey: uuidv7() }, at, {
      mayFinalize: true,
    }),
  );
}

const closeOwn = (
  w: World,
  who: TestUser,
  req: Record<string, unknown>,
  at: Date,
  key = uuidv7(),
) =>
  w.run((tx) =>
    closeOwnDay(
      tx,
      as(w, who),
      { denominations: DEN0, expectedCashPaise: '0', idempotencyKey: key, ...req },
      at,
    ),
  );

const closeFacility = (
  w: World,
  who: TestUser,
  closeDate: string,
  at: Date,
  req: Record<string, unknown> = {},
) =>
  w.run((tx) =>
    closeFacilityDay(tx, as(w, who), { closeDate, idempotencyKey: uuidv7(), ...req }, at),
  );

async function errorKey(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DayCloseInputError) return e.key;
    if (e instanceof IdempotencyConflictError) return 'idempotency.conflict';
    throw e;
  }
  throw new Error('expected an error');
}

/** Raw SQL as the app role; resolves to the error message or 'ok'. */
async function rawSql(w: World, q: ReturnType<typeof sql>): Promise<string> {
  try {
    await withTx({ db: t.app, userId: w.f.userId, facilityId: w.f.facilityId }, (tx) =>
      tx.execute(q),
    );
    return 'ok';
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
}

const D1 = IST('2026-10-26T10:00:00');
const EVENING = IST('2026-10-26T18:30:00');

describe('user close: denomination counter and variance (BIL-06)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  // Every test counts its own, empty counter.
  beforeEach(async () => {
    w.cashier = await mkUser(w.f, 'cashier');
  });

  it('closes a counter that balances: cash, UPI and card expected, payments locked', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    await pay(w, w.cashier, [upi(20_000, '8901'), cash(30_000)], D1);
    await pay(w, w.cashier, [{ mode: 'card', amountPaise: 50_000, cardLast4: '4242' }], D1);
    // Someone else's takings are not on this counter.
    await pay(w, w.cashier2, [cash(50_000)], D1);

    const open = await openCounter(t.app, w.f.facilityId, w.cashier.id, EVENING);
    expect(open).toMatchObject({
      paymentCount: 4,
      closeDate: '2026-10-26',
      lastClosedAt: null,
      totals: { cashPaise: 80_000n, upiPaise: 20_000n, cardPaise: 50_000n, otherPaise: 0n },
    });

    const r = await closeOwn(
      w,
      w.cashier,
      {
        // 1 × 500 + 1 × 200 + 1 × 50 + 3 × 10 = 780, and ₹20 of coins
        denominations: { ...DEN0, n500: 1, n200: 1, n50: 1, n10: 3, coinsPaise: 2000 },
        expectedCashPaise: '80000',
      },
      EVENING,
    );
    expect(r).toMatchObject({
      closeDate: '2026-10-26',
      cashExpectedPaise: '80000',
      cashCountedPaise: '80000',
      differencePaise: '0',
      upiExpectedPaise: '20000',
      cardExpectedPaise: '50000',
      paymentCount: 4,
    });
    const locked = await t.app.select().from(payment).where(eq(payment.dayCloseId, r.dayCloseId));
    expect(locked).toHaveLength(4);
    // The next period starts empty; the other cashier's payment is still open.
    expect((await openCounter(t.app, w.f.facilityId, w.cashier.id, EVENING)).paymentCount).toBe(0);
    expect((await openCounter(t.app, w.f.facilityId, w.cashier2.id, EVENING)).paymentCount).toBe(1);
    const slip = await loadDayClose(t.app, w.f.facilityId, r.dayCloseId);
    expect(slip?.denominations).toMatchObject({
      n500: 1,
      n200: 1,
      n50: 1,
      n10: 3,
      coinsPaise: 2000n,
    });
  });

  it('a variance needs a reason and is recorded with its sign', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    const req = { denominations: { ...DEN0, n100: 4 }, expectedCashPaise: '50000' };
    expect(await errorKey(closeOwn(w, w.cashier, req, EVENING))).toBe('dayClose.reasonRequired');
    // The refused close left the payment open.
    expect((await openCounter(t.app, w.f.facilityId, w.cashier.id, EVENING)).paymentCount).toBe(1);
    const r = await closeOwn(
      w,
      w.cashier,
      { ...req, differenceReason: 'Change given by mistake' },
      EVENING,
    );
    expect(r.differencePaise).toBe('-10000');
    const [row] = await t.app.select().from(dayClose).where(eq(dayClose.id, r.dayCloseId));
    expect(row).toMatchObject({
      differencePaise: -10_000n,
      differenceReason: 'Change given by mistake',
    });
  });

  it('cash over is a variance too', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    const r = await closeOwn(
      w,
      w.cashier,
      {
        denominations: { ...DEN0, n500: 1, n10: 1 },
        expectedCashPaise: '50000',
        differenceReason: 'Patient left change as a donation',
      },
      EVENING,
    );
    expect(r.differencePaise).toBe('1000');
  });

  it('refuses a close whose expected cash is out of date', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    const req = { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' };
    await pay(w, w.cashier, [cash(50_000)], D1); // arrives while the counter was being counted
    expect(await errorKey(closeOwn(w, w.cashier, req, EVENING))).toBe('dayClose.expectedChanged');
    expect((await openCounter(t.app, w.f.facilityId, w.cashier.id, EVENING)).paymentCount).toBe(2);
  });

  it('replays the same request and rejects the same key with other numbers', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    const key = uuidv7();
    const req = { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' };
    const a = await closeOwn(w, w.cashier, req, EVENING, key);
    const b = await closeOwn(w, w.cashier, req, EVENING, key);
    expect(b).toEqual(a);
    expect(
      await errorKey(
        closeOwn(w, w.cashier, { ...req, denominations: { ...DEN0, n200: 2 } }, EVENING, key),
      ),
    ).toBe('idempotency.conflict');
  });

  it('two racing closes of one counter: one wins, the other finds nothing to count', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    const req = { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' };
    const results = await Promise.allSettled([
      closeOwn(w, w.cashier, req, EVENING),
      closeOwn(w, w.cashier, req, EVENING),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as DayCloseInputError).key).toBe('dayClose.expectedChanged');
  });

  it('a refund paid in cash lowers the cash the counter should hold', async () => {
    const paid = await pay(w, w.cashier, [cash(50_000)], D1);
    const reason = await t.app
      .select({ id: reasonCode.id })
      .from(reasonCode)
      .where(eq(reasonCode.facilityId, w.f.facilityId));
    const cancelReason = (
      await t.app.select().from(reasonCode).where(eq(reasonCode.facilityId, w.f.facilityId))
    ).find((r) => r.kind === 'cancel' && r.code === 'patient_request');
    expect(reason.length).toBeGreaterThan(0);
    await w.run((tx) =>
      cancelFinalBill(
        tx,
        as(w, w.cashier),
        {
          billId: paid.billId,
          reasonCodeId: cancelReason!.id,
          idempotencyKey: uuidv7(),
          refund: { mode: 'cash' },
        },
        EVENING,
        { approverId: null },
      ),
    );
    const open = await openCounter(t.app, w.f.facilityId, w.cashier.id, EVENING);
    expect(open.totals.cashPaise).toBe(0n); // +₹500 taken, −₹500 handed back
    expect(open.paymentCount).toBe(2);
    const r = await closeOwn(w, w.cashier, { expectedCashPaise: '0' }, EVENING);
    expect(r).toMatchObject({ cashExpectedPaise: '0', differencePaise: '0', paymentCount: 2 });
  });
});

describe('locked payments (BIL-06, rule 4)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  beforeEach(async () => {
    w.cashier = await mkUser(w.f, 'cashier');
  });

  it('a counted payment can no longer change; a payment cannot be counted by another cashier', async () => {
    const a = await pay(w, w.cashier, [cash(50_000)], D1);
    const b = await pay(w, w.cashier2, [cash(50_000)], D1);
    const closed = await closeOwn(
      w,
      w.cashier,
      { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' },
      EVENING,
    );
    const [counted] = await t.app
      .select()
      .from(payment)
      .where(eq(payment.dayCloseId, closed.dayCloseId));
    expect(
      await rawSql(w, sql`update payment set status = 'reversed' where id = ${counted!.id}`),
    ).toMatch(/closed day/);
    expect(
      await rawSql(w, sql`update payment set day_close_id = null where id = ${counted!.id}`),
    ).toMatch(/closed day/);
    expect(
      await rawSql(
        w,
        sql`update payment set business_date = '2020-01-01' where id = ${counted!.id}`,
      ),
    ).toMatch(/immutable/);
    // cashier2's open payment cannot be stamped with cashier's close
    const [theirs] = await t.app
      .select()
      .from(payment)
      .where(eq(payment.collectionId, b.collectionId));
    expect(
      await rawSql(
        w,
        sql`update payment set day_close_id = ${closed.dayCloseId} where id = ${theirs!.id}`,
      ),
    ).toMatch(/own cashier/);
    expect(a.receiptNumber).not.toBe(b.receiptNumber);
  });

  it('a new payment cannot be inserted already counted', async () => {
    const closed = await closeOwn(w, w.cashier, { expectedCashPaise: '0' }, EVENING);
    const [any] = await t.app
      .select()
      .from(payment)
      .where(eq(payment.facilityId, w.f.facilityId))
      .limit(1);
    const msg = await rawSql(
      w,
      sql`insert into payment (id, facility_id, number, collection_id, patient_id, encounter_id, bill_id, kind, mode,
          amount_paise, received_by, received_at, idempotency_key, day_close_id)
        values (${uuidv7()}, ${w.f.facilityId}, 'X/1', ${uuidv7()}, ${any!.patientId}, ${any!.encounterId}, ${any!.billId},
          'payment', 'cash', 100, ${w.cashier.id}, now(), ${uuidv7()}, ${closed.dayCloseId})`,
    );
    expect(msg).toMatch(/cannot belong to a day close/);
  });

  it('a day close cannot be edited or attached twice', async () => {
    const closed = await closeOwn(w, w.cashier, { expectedCashPaise: '0' }, EVENING);
    expect(
      await rawSql(
        w,
        sql`update day_close set cash_counted_paise = 5, difference_paise = 5, difference_reason = 'x' where id = ${closed.dayCloseId}`,
      ),
    ).toMatch(/cannot change/);
  });
});

describe('facility close and late entries (BIL-06)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('sums the user closes by mode, department and doctor; the day then locks', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    await pay(w, w.cashier2, [upi(50_000, '1234')], D1);
    await closeOwn(
      w,
      w.cashier,
      { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' },
      EVENING,
    );
    await closeOwn(w, w.cashier2, { expectedCashPaise: '0' }, EVENING);

    const before = await facilityCloseView(t.app, w.f.facilityId, '2026-10-26');
    expect(before.close).toBeNull();
    expect(before.userCloses).toHaveLength(2);
    expect(before.pending).toEqual([]);
    expect(before.totals).toMatchObject({ cashPaise: 50_000n, upiPaise: 50_000n });
    expect(before.byDoctor).toEqual([{ key: w.opd.doctorA, label: 'Dr. A', netPaise: 100_000n }]);
    expect(before.byDepartment).toHaveLength(1);

    const r = await closeFacility(w, w.admin, '2026-10-26', IST('2026-10-26T20:00:00'));
    expect(r).toMatchObject({
      userCloseCount: 2,
      cashExpectedPaise: '50000',
      cashCountedPaise: '50000',
      differencePaise: '0',
      paymentCount: 2,
    });
    const after = await facilityCloseView(t.app, w.f.facilityId, '2026-10-26');
    expect(after.close).toMatchObject({ paymentCount: 2, pendingAcknowledged: false });
    expect(after.userCloses.map((c) => c.facilityCloseId)).toEqual([r.dayCloseId, r.dayCloseId]);
    expect(
      await errorKey(closeFacility(w, w.admin, '2026-10-26', IST('2026-10-26T20:05:00'))),
    ).toBe('dayClose.alreadyClosed');
  });

  it('a payment taken after the close goes to the next business day and is counted there', async () => {
    const late = await pay(w, w.cashier, [upi(50_000, '7777')], IST('2026-10-26T21:30:00'));
    const [row] = await t.app
      .select()
      .from(payment)
      .where(eq(payment.collectionId, late.collectionId));
    expect(row!.businessDate).toBe('2026-10-27');
    // The user close of that evening is dated with the open day too.
    const r = await closeOwn(w, w.cashier, { expectedCashPaise: '0' }, IST('2026-10-26T21:45:00'));
    expect(r.closeDate).toBe('2026-10-27');
    // The closed day's report does not change.
    const day26 = await facilityCloseView(t.app, w.f.facilityId, '2026-10-26');
    expect(day26.totals.upiPaise).toBe(50_000n);
    // Tomorrow's facility close takes the late entry in.
    const next = await closeFacility(w, w.admin, '2026-10-27', IST('2026-10-27T20:00:00'));
    expect(next).toMatchObject({ userCloseCount: 1, paymentCount: 1 });
    const day27 = await facilityCloseView(t.app, w.f.facilityId, '2026-10-27');
    expect(day27.totals.upiPaise).toBe(50_000n);
  });

  it('a payment on the next calendar day keeps that day', async () => {
    const p = await pay(w, w.cashier, [cash(50_000)], IST('2026-10-28T09:00:00'));
    const [row] = await t.app
      .select()
      .from(payment)
      .where(eq(payment.collectionId, p.collectionId));
    expect(row!.businessDate).toBe('2026-10-28');
  });

  it('refuses a future date and a date before the last close', async () => {
    expect(
      await errorKey(closeFacility(w, w.admin, '2026-10-30', IST('2026-10-28T20:00:00'))),
    ).toBe('dayClose.futureDate');
    expect(
      await errorKey(closeFacility(w, w.admin, '2026-10-20', IST('2026-10-28T20:00:00'))),
    ).toBe('dayClose.alreadyClosed');
  });

  it('the database refuses a facility close dated at or before the last one', async () => {
    const msg = await rawSql(
      w,
      sql`insert into day_close (id, facility_id, kind, close_date, closed_at) values (${uuidv7()}, ${w.f.facilityId}, 'facility', '2026-10-27', now())`,
    );
    expect(msg).toMatch(/already closed up to/);
  });
});

describe('open counters at facility close (BIL-06)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('blocks the close while a cashier has uncounted payments, unless acknowledged with a note', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    await pay(w, w.cashier2, [cash(50_000)], D1);
    await closeOwn(
      w,
      w.cashier,
      { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' },
      EVENING,
    );

    const view = await facilityCloseView(t.app, w.f.facilityId, '2026-10-26');
    expect(view.pending).toMatchObject([
      { userId: w.cashier2.id, paymentCount: 1, cashPaise: 50_000n },
    ]);
    const at = IST('2026-10-26T20:00:00');
    expect(await errorKey(closeFacility(w, w.admin, '2026-10-26', at))).toBe(
      'dayClose.pendingUsers',
    );
    expect(
      await errorKey(closeFacility(w, w.admin, '2026-10-26', at, { acknowledgePending: true })),
    ).toBe('dayClose.noteRequired');
    const r = await closeFacility(w, w.admin, '2026-10-26', at, {
      acknowledgePending: true,
      note: 'Counter 2 cashier went home sick',
    });
    expect(r).toMatchObject({ userCloseCount: 1, paymentCount: 1 });
    // Their payment is still theirs to count, and lands on the next open day.
    const next = await closeOwn(
      w,
      w.cashier2,
      { denominations: { ...DEN0, n500: 1 }, expectedCashPaise: '50000' },
      IST('2026-10-26T22:00:00'),
    );
    expect(next.closeDate).toBe('2026-10-27');
  });
});

describe('totals are checked by the database at COMMIT (docs/12 §9)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('a user close that does not equal its payments cannot be committed', async () => {
    await pay(w, w.cashier, [cash(50_000)], D1);
    const id = uuidv7();
    let msg = 'ok';
    try {
      await withTx({ db: t.app, userId: w.f.userId, facilityId: w.f.facilityId }, async (tx) => {
        await tx.execute(
          sql`insert into day_close (id, facility_id, kind, user_id, close_date, closed_at, cash_expected_paise,
                cash_counted_paise, payment_count)
              values (${id}, ${w.f.facilityId}, 'user', ${w.cashier.id}, '2026-10-26', now(), 49999, 49999, 1)`,
        );
        await tx.execute(
          sql`update payment set day_close_id = ${id} where received_by = ${w.cashier.id} and day_close_id is null`,
        );
      });
    } catch (e) {
      const err = e as { cause?: { message?: string }; message: string };
      msg = err.cause?.message ?? err.message;
    }
    expect(msg).toMatch(/does not match its payments/);
    expect((await openCounter(t.app, w.f.facilityId, w.cashier.id, EVENING)).paymentCount).toBe(1);
  });

  it('the difference is always counted − expected and never silent', async () => {
    const msg = await rawSql(
      w,
      sql`insert into day_close (id, facility_id, kind, user_id, close_date, closed_at, cash_expected_paise,
            cash_counted_paise, difference_paise)
          values (${uuidv7()}, ${w.f.facilityId}, 'user', ${w.cashier.id}, '2026-10-26', now(), 1000, 900, -100)`,
    );
    expect(msg).toMatch(/day_close_difference_reason/);
  });
});

describe('day close report', () => {
  it('lists user closes in a range with their differences', async () => {
    const w = await world();
    await pay(w, w.cashier, [cash(50_000)], D1);
    await closeOwn(
      w,
      w.cashier,
      {
        denominations: { ...DEN0, n100: 4 },
        expectedCashPaise: '50000',
        differenceReason: 'Short',
      },
      EVENING,
    );
    const rows = await dayCloseReport(t.app, w.f.facilityId, {
      from: '2026-10-26',
      to: '2026-10-26',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: w.cashier.id,
      differencePaise: -10_000n,
      differenceReason: 'Short',
      facilityCloseDate: null,
    });
    expect(
      await dayCloseReport(t.app, w.f.facilityId, { from: '2026-10-27', to: '2026-10-28' }),
    ).toEqual([]);
  });
});

describe('UPI reconciliation (docs/12 §3)', () => {
  let w: World;
  let p1: string;
  let p2: string;
  beforeAll(async () => {
    w = await world();
    await pay(w, w.cashier, [upi(50_000, '8901')], D1);
    await pay(w, w.cashier, [upi(50_000)], D1);
    await pay(w, w.cashier, [cash(50_000)], D1); // cash is not on a UPI statement
    const v = await upiReconciliationView(t.app, w.f.facilityId, '2026-10-26');
    p1 = v.receipts[0]!.paymentId;
    p2 = v.receipts[1]!.paymentId;
  });

  const save = (req: Record<string, unknown>, at = EVENING) =>
    w.run((tx) =>
      saveUpiReconciliation(
        tx,
        as(w, w.admin),
        {
          date: '2026-10-26',
          statementTotalPaise: '100000',
          matches: [],
          idempotencyKey: uuidv7(),
          ...req,
        },
        at,
      ),
    );

  it('lists the UPI receipts of the day only, with the system total', async () => {
    const v = await upiReconciliationView(t.app, w.f.facilityId, '2026-10-26');
    expect(v.status).toBe('none');
    expect(v.receipts).toHaveLength(2);
    expect(v.systemTotalPaise).toBe(100_000n);
    expect(v.receipts[0]).toMatchObject({ upiRef: '8901', matched: false });
    expect(await pendingUpiReconciliations(t.app, w.f.facilityId, '2026-10-27')).toEqual([
      '2026-10-26',
    ]);
  });

  it('saves ticks and the statement total as a draft, and ticks can be undone', async () => {
    const r = await save({
      statementTotalPaise: '50000',
      matches: [{ paymentId: p1, statementUtr: '412345678901' }],
    });
    expect(r).toMatchObject({
      status: 'open',
      systemTotalPaise: '100000',
      differencePaise: '-50000',
    });
    let v = await upiReconciliationView(t.app, w.f.facilityId, '2026-10-26');
    expect(v.receipts.map((x) => x.matched)).toEqual([true, false]);
    expect(v.receipts[0]!.statementUtr).toBe('412345678901');
    expect(v.matchedTotalPaise).toBe(50_000n);

    await save({ statementTotalPaise: '100000', matches: [{ paymentId: p2 }] });
    v = await upiReconciliationView(t.app, w.f.facilityId, '2026-10-26');
    expect(v.receipts.map((x) => x.matched)).toEqual([false, true]);
    expect(v.receipts[0]!.statementUtr).toBeNull();
    const items = await t.app.select().from(upiReconciliationItem);
    expect(items.filter((i) => !i.matched)).toHaveLength(1); // unticked, not deleted
  });

  it('completing with a difference needs a reason; a completed day is frozen', async () => {
    expect(await errorKey(save({ statementTotalPaise: '99000', complete: true }))).toBe(
      'upi.reasonRequired',
    );
    const r = await save({
      statementTotalPaise: '99000',
      complete: true,
      matches: [{ paymentId: p1 }, { paymentId: p2 }],
      differenceReason: 'Bank charge deducted',
    });
    expect(r).toMatchObject({ status: 'reconciled', differencePaise: '-1000' });
    const v = await upiReconciliationView(t.app, w.f.facilityId, '2026-10-26');
    expect(v).toMatchObject({ status: 'reconciled', differenceReason: 'Bank charge deducted' });
    expect(await errorKey(save({ statementTotalPaise: '100000' }))).toBe('upi.alreadyReconciled');
    expect(await pendingUpiReconciliations(t.app, w.f.facilityId, '2026-10-27')).toEqual([]);
  });

  it('only UPI receipts of that day can be ticked', async () => {
    const w2 = await world();
    await pay(w2, w2.cashier, [cash(50_000)], D1);
    await pay(w2, w2.cashier, [upi(50_000)], IST('2026-10-27T10:00:00'));
    const [c] = await t.app.select().from(payment).where(eq(payment.mode, 'cash'));
    const other = (await upiReconciliationView(t.app, w2.f.facilityId, '2026-10-27')).receipts[0]!;
    const run = (paymentId: string) =>
      w2.run((tx) =>
        saveUpiReconciliation(
          tx,
          as(w2, w2.admin),
          {
            date: '2026-10-26',
            statementTotalPaise: '0',
            matches: [{ paymentId }],
            idempotencyKey: uuidv7(),
          },
          EVENING,
        ),
      );
    expect(await errorKey(run(c!.id))).toBe('upi.paymentNotFound');
    expect(await errorKey(run(other.paymentId))).toBe('upi.paymentNotFound');
  });

  it('refuses a future day', async () => {
    expect(await errorKey(save({ date: '2026-12-01' }))).toBe('upi.futureDate');
  });
});
