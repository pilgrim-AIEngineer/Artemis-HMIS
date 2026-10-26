/**
 * BIL-06 through tRPC: who may close a counter and the facility day (AGENTS.md rule 6), error keys
 * instead of SQL (docs/02 §7), idempotent closes, and the whole counter → facility → late entry
 * path. Money math and DB guards are covered in packages/db day-close.test.ts.
 */
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type TestBrowser,
} from '../../../../../test/auth-fixture';

let f: AuthFixture;
let opd: Omit<OpdFixture, 't' | 'f'>;
let reception: TestBrowser;
let cashier: TestBrowser;
let doctor: TestBrowser;
let admin: TestBrowser;
let owner: TestBrowser;

const DEN = { n500: 1, n200: 0, n100: 0, n50: 0, n20: 0, n10: 0, coinsPaise: 0 };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  opd = await seedOpdData(f.t, {
    facilityId: f.a.facilityId,
    userId: f.users.reception.id,
    workstationId: f.a.workstationId,
  });
  const login = async (u: { username: string }) => {
    const b = f.browser();
    await b.login(u.username);
    return b;
  };
  [reception, cashier, doctor, admin, owner] = await Promise.all([
    login(f.users.reception),
    login(f.users.cashier),
    login(f.users.doctor),
    login(f.users.admin),
    login(f.users.owner),
  ]);
});
afterAll(async () => {
  await f.close();
});

/** A visit paid at the counter by `who` with the given tenders (₹500 bill). */
async function takeMoney(who: TestBrowser, tenders: unknown[]) {
  // Reception books the visit (the cashier role cannot); `who` takes the money.
  const v = await reception.call(async (c) =>
    c.visit.create({
      patientId: await opd.newPatient(),
      doctorId: opd.doctorA,
      idempotencyKey: uuidv7(),
    }),
  );
  return who.call((c) =>
    c.billing.collect({ billId: v.billId, tenders: tenders as never, idempotencyKey: uuidv7() }),
  );
}

describe('permissions (rule 6)', () => {
  it('closing a counter needs billing.dayclose.own', async () => {
    for (const b of [doctor, admin]) {
      const e = await trpcError(b.call((c) => c.dayClose.counter()));
      expect(e.code).toBe('FORBIDDEN');
    }
    const e = await trpcError(
      doctor.call((c) =>
        c.dayClose.closeOwn({
          denominations: DEN,
          expectedCashPaise: '0',
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect(e.code).toBe('FORBIDDEN');
    await expect(reception.call((c) => c.dayClose.counter())).resolves.toBeDefined();
    await expect(cashier.call((c) => c.dayClose.counter())).resolves.toBeDefined();
  });

  it('the facility close, its summary and the UPI reconciliation need billing.dayclose.facility', async () => {
    const date = today();
    for (const b of [reception, cashier, doctor]) {
      expect((await trpcError(b.call((c) => c.dayClose.facility({ date })))).code).toBe(
        'FORBIDDEN',
      );
      expect(
        (
          await trpcError(
            b.call((c) => c.dayClose.closeFacility({ closeDate: date, idempotencyKey: uuidv7() })),
          )
        ).code,
      ).toBe('FORBIDDEN');
      expect((await trpcError(b.call((c) => c.dayClose.upi.view({ date })))).code).toBe(
        'FORBIDDEN',
      );
      expect(
        (
          await trpcError(
            b.call((c) =>
              c.dayClose.upi.save({
                date,
                statementTotalPaise: '0',
                matches: [],
                idempotencyKey: uuidv7(),
              }),
            ),
          )
        ).code,
      ).toBe('FORBIDDEN');
    }
    await expect(admin.call((c) => c.dayClose.facility({ date }))).resolves.toBeDefined();
  });

  it('the day close report is a collection report', async () => {
    const range = { from: today(), to: today() };
    expect((await trpcError(reception.call((c) => c.dayClose.report(range)))).code).toBe(
      'FORBIDDEN',
    );
    await expect(owner.call((c) => c.dayClose.report(range))).resolves.toEqual(expect.any(Array));
  });
});

describe('counter → facility close → late entry', () => {
  it('runs the whole path with stable error keys', async () => {
    await takeMoney(cashier, [{ mode: 'cash', amountPaise: 50_000 }]);
    const open = await cashier.call((c) => c.dayClose.counter());
    expect(open.open).toMatchObject({ paymentCount: 1, totals: { cashPaise: 50_000n } });

    // A stale expected amount is a conflict; the screen reloads and tries again.
    const stale = await trpcError(
      cashier.call((c) =>
        c.dayClose.closeOwn({
          denominations: DEN,
          expectedCashPaise: '40000',
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect([stale.code, stale.message]).toEqual(['CONFLICT', 'errors.dayClose.expectedChanged']);

    // A variance without a reason is a bad request.
    const noReason = await trpcError(
      cashier.call((c) =>
        c.dayClose.closeOwn({
          denominations: { ...DEN, n500: 0, n200: 2 },
          expectedCashPaise: '50000',
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect([noReason.code, noReason.message]).toEqual([
      'BAD_REQUEST',
      'errors.dayClose.reasonRequired',
    ]);

    const key = uuidv7();
    const close = () =>
      cashier.call((c) =>
        c.dayClose.closeOwn({
          denominations: DEN,
          expectedCashPaise: '50000',
          idempotencyKey: key,
        }),
      );
    const [a, b] = await Promise.all([close(), close()]);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ cashCountedPaise: '50000', differencePaise: '0', paymentCount: 1 });
    expect((await cashier.call((c) => c.dayClose.counter())).recent).toHaveLength(1);

    // Reception still has an open counter: the facility close asks for acknowledgement.
    await takeMoney(reception, [{ mode: 'upi', amountPaise: 50_000, upiRef: '4321' }]);
    const date = today();
    const view = await admin.call((c) => c.dayClose.facility({ date }));
    expect(view.pending.map((p) => p.userId)).toEqual([f.users.reception.id]);
    expect(view.userCloses).toHaveLength(1);
    const blocked = await trpcError(
      admin.call((c) => c.dayClose.closeFacility({ closeDate: date, idempotencyKey: uuidv7() })),
    );
    expect([blocked.code, blocked.message]).toEqual(['CONFLICT', 'errors.dayClose.pendingUsers']);
    const noNote = await trpcError(
      admin.call((c) =>
        c.dayClose.closeFacility({
          closeDate: date,
          acknowledgePending: true,
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect(noNote.message).toBe('errors.dayClose.noteRequired');

    // Reception closes too; now the facility can close.
    await reception.call((c) =>
      c.dayClose.closeOwn({
        denominations: { ...DEN, n500: 0 },
        expectedCashPaise: '0',
        idempotencyKey: uuidv7(),
      }),
    );
    const done = await admin.call((c) =>
      c.dayClose.closeFacility({ closeDate: date, idempotencyKey: uuidv7() }),
    );
    expect(done).toMatchObject({ userCloseCount: 2, paymentCount: 2, differencePaise: '0' });
    const again = await trpcError(
      admin.call((c) => c.dayClose.closeFacility({ closeDate: date, idempotencyKey: uuidv7() })),
    );
    expect(again.message).toBe('errors.dayClose.alreadyClosed');

    // A late payment goes to the next business day.
    await takeMoney(cashier, [{ mode: 'cash', amountPaise: 50_000 }]);
    const next = await cashier.call((c) => c.dayClose.counter());
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    expect(next.open.closeDate).toBe(d.toISOString().slice(0, 10));
    expect(next.open.paymentCount).toBe(1);
  });

  it('UPI reconciliation: the receipts of the day, saved and completed', async () => {
    const date = today();
    // The reception UPI receipt was taken today and then moved to the next day? No: it was before
    // the close, so it belongs to today.
    const v = await admin.call((c) => c.dayClose.upi.view({ date }));
    expect(v.receipts).toHaveLength(1);
    expect(v.systemTotalPaise).toBe(50_000n);
    const noReason = await trpcError(
      admin.call((c) =>
        c.dayClose.upi.save({
          date,
          statementTotalPaise: '49000',
          matches: [{ paymentId: v.receipts[0]!.paymentId }],
          complete: true,
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect(noReason.message).toBe('errors.upi.reasonRequired');
    const saved = await admin.call((c) =>
      c.dayClose.upi.save({
        date,
        statementTotalPaise: '49000',
        matches: [{ paymentId: v.receipts[0]!.paymentId, statementUtr: '412345674321' }],
        complete: true,
        differenceReason: 'Bank fee',
        idempotencyKey: uuidv7(),
      }),
    );
    expect(saved).toMatchObject({ status: 'reconciled', differencePaise: '-1000' });
    const frozen = await trpcError(
      admin.call((c) =>
        c.dayClose.upi.save({
          date,
          statementTotalPaise: '50000',
          matches: [],
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect([frozen.code, frozen.message]).toEqual(['CONFLICT', 'errors.upi.alreadyReconciled']);
  });

  it('rejects malformed input before it reaches the database', async () => {
    const e = await trpcError(
      cashier.call((c) =>
        c.dayClose.closeOwn({
          denominations: { ...DEN, n500: -1 },
          expectedCashPaise: '0',
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect(e.code).toBe('BAD_REQUEST');
  });
});
