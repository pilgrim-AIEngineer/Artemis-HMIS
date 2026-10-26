/**
 * BIL-01 / BIL-02 through tRPC: who may bill and collect (AGENTS.md rule 6), error keys instead
 * of SQL (docs/02 §7), the visit → bill → payment → token flow, and idempotent replays over the
 * API. The money math and races are covered against the db layer (packages/db billing.test.ts).
 */
import { billLine, creditNote, opdToken, payment, reasonCode, service } from '@hmis/db/schema';
import { seedOpdData, type OpdFixture } from '@hmis/db/testing/opd';
import { withTx, writeSetting } from '@hmis/db';
import { insertUser } from '@hmis/db/auth';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PASSWORD,
  PIN,
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
let nurse: TestBrowser;
let admin: TestBrowser;
let noRoles: TestBrowser;
let adminB: TestBrowser;

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
  [reception, cashier, doctor, nurse, admin, noRoles, adminB] = await Promise.all([
    login(f.users.reception),
    login(f.users.cashier),
    login(f.users.doctor),
    login(f.users.nurse),
    login(f.users.admin),
    login(f.users.noRoles),
    login(f.users.adminB),
  ]);
});
afterAll(async () => {
  await f.close();
});

const book = (b: TestBrowser = reception) =>
  b.call(async (c) =>
    c.visit.create({
      patientId: await opd.newPatient(),
      doctorId: opd.doctorA,
      idempotencyKey: uuidv7(),
    }),
  );

const collect = (b: TestBrowser, billId: string, tenders: unknown[], key = uuidv7()) =>
  b.call((c) => c.billing.collect({ billId, tenders: tenders as never, idempotencyKey: key }));

describe('visit → bill → payment → token (flow 1 server side)', () => {
  it('collects cash in full, finalises the bill and releases the token', async () => {
    const v = await book();
    expect(v.tokenNo).toBeNull();
    const bill = await reception.call((c) => c.billing.get({ billId: v.billId }));
    expect(bill).toMatchObject({ status: 'draft', netPaise: 50_000n, balancePaise: 50_000n });
    expect(bill.lines.map((l) => l.description)).toHaveLength(1);

    const r = await collect(reception, v.billId, [{ mode: 'cash', amountPaise: '50000' }]);
    expect(r).toMatchObject({ billStatus: 'final', balancePaise: '0', printSheet: false });
    expect(r.tokenNo).toBeGreaterThan(0);
    const after = await reception.call((c) => c.billing.get({ billId: v.billId }));
    expect(after).toMatchObject({ status: 'final', tokenNo: r.tokenNo });
    expect(after.payments[0]?.receivedByName).toBe('Test reception');
    const [row] = await f.db.select().from(payment).where(eq(payment.billId, v.billId));
    expect(row).toMatchObject({
      receivedBy: f.users.reception.id,
      workstationId: null, // this test session is not on a paired workstation
    });
  });

  it('prints the OPD sheet with the token when the sheet prints at reception', async () => {
    await opd.run((tx) => writeSetting(tx, f.a.facilityId, 'opd.sheetPrintAt', 'reception'));
    try {
      const v = await book();
      const r = await collect(reception, v.billId, [{ mode: 'upi', amountPaise: 50_000 }]);
      expect(r.printSheet).toBe(true);
    } finally {
      await opd.run((tx) => writeSetting(tx, f.a.facilityId, 'opd.sheetPrintAt', 'vitals'));
    }
  });

  it('replays a double submit and maps a reused key to a conflict', async () => {
    const v = await book();
    const key = uuidv7();
    const [a, b] = await Promise.all([
      collect(cashier, v.billId, [{ mode: 'cash', amountPaise: 20_000 }], key),
      collect(cashier, v.billId, [{ mode: 'cash', amountPaise: 20_000 }], key),
    ]);
    expect(b).toEqual(a);
    const e = await trpcError(
      collect(cashier, v.billId, [{ mode: 'cash', amountPaise: 30_000 }], key),
    );
    expect([e.code, e.message]).toEqual(['CONFLICT', 'errors.idempotency.conflict']);
    expect(await f.db.select().from(payment).where(eq(payment.billId, v.billId))).toHaveLength(1);
  });

  it('adds and removes services on the draft and lists billable services with rates', async () => {
    const v = await book();
    const list = await reception.call((c) => c.billing.services({ billId: v.billId, q: 'cons' }));
    const anc = list.find((s) => s.code === 'CONS-ANC');
    expect(anc?.ratePaise).toBe(40_000n);
    const added = await reception.call((c) =>
      c.billing.addLine({ billId: v.billId, serviceId: anc!.id, idempotencyKey: uuidv7() }),
    );
    expect(added.netPaise).toBe('90000');
    const removed = await reception.call((c) =>
      c.billing.removeLine({ billId: v.billId, lineId: added.lineId!, idempotencyKey: uuidv7() }),
    );
    expect(removed.netPaise).toBe('50000');
    const lines = await f.db.select().from(billLine).where(eq(billLine.billId, v.billId));
    expect(lines.map((l) => l.status).sort()).toEqual(['active', 'cancelled']);
  });
});

describe('billing permissions (AGENTS.md rule 6)', () => {
  it('refuses roles without billing permissions on every procedure', async () => {
    const v = await book();
    for (const who of [doctor, nurse, admin, noRoles]) {
      const calls = [
        () => who.call((c) => c.billing.pending({})),
        () => who.call((c) => c.billing.get({ billId: v.billId })),
        () => who.call((c) => c.billing.forEncounter({ encounterId: v.encounterId })),
        () => who.call((c) => c.billing.services({ billId: v.billId, q: '' })),
        () =>
          who.call((c) =>
            c.billing.createOpdBill({ encounterId: v.encounterId, idempotencyKey: uuidv7() }),
          ),
        () =>
          who.call((c) =>
            c.billing.addLine({ billId: v.billId, serviceId: uuidv7(), idempotencyKey: uuidv7() }),
          ),
        () =>
          who.call((c) =>
            c.billing.removeLine({ billId: v.billId, lineId: uuidv7(), idempotencyKey: uuidv7() }),
          ),
        () => who.call((c) => c.billing.finalize({ billId: v.billId, idempotencyKey: uuidv7() })),
        () => who.call((c) => c.billing.paymentSettings()),
        () => collect(who, v.billId, [{ mode: 'cash', amountPaise: 100 }]),
      ];
      for (const call of calls) expect((await trpcError(call())).code).toBe('FORBIDDEN');
    }
    expect(await f.db.select().from(payment).where(eq(payment.billId, v.billId))).toHaveLength(0);
  });

  it('lets the cashier work the desk', async () => {
    const v = await book();
    const pending = await cashier.call((c) => c.billing.pending({ q: v.number }));
    expect(pending.map((p) => p.id)).toEqual([v.billId]);
    expect(await cashier.call((c) => c.billing.paymentSettings())).toMatchObject({
      upiRef: { mode: 'optional' },
      allowOpdCredit: false,
    });
    const r = await collect(cashier, v.billId, [
      { mode: 'cash', amountPaise: 25_000 },
      { mode: 'card', amountPaise: 25_000, cardLast4: '1234' },
    ]);
    expect(r.billStatus).toBe('final');
    const [tok] = await f.db.select().from(opdToken).where(eq(opdToken.encounterId, v.encounterId));
    expect(tok?.issuedBasis).toBe('payment');
  });

  it('never shows or takes money on another facility’s bill', async () => {
    const v = await book();
    const username = `cashierb_${uuidv7().slice(-8)}`;
    await withTx({ db: f.db, userId: null }, (tx) =>
      insertUser(tx, {
        facilityId: f.b.facilityId,
        username,
        fullName: 'Cashier B',
        password: PASSWORD,
        pin: PIN,
        roles: ['cashier'],
      }),
    );
    const cashierB = f.browser();
    await cashierB.login(username);
    const e1 = await trpcError(cashierB.call((c) => c.billing.get({ billId: v.billId })));
    expect([e1.code, e1.message]).toEqual(['NOT_FOUND', 'errors.billing.billNotFound']);
    const e2 = await trpcError(collect(cashierB, v.billId, [{ mode: 'cash', amountPaise: 100 }]));
    expect(e2.code).toBe('NOT_FOUND');
    expect(await cashierB.call((c) => c.billing.pending({}))).toEqual([]);
    expect((await trpcError(adminB.call((c) => c.billing.pending({})))).code).toBe('FORBIDDEN');
  });
});

describe('billing errors are i18n keys', () => {
  it('maps overpayment, missing bill, missing rate and a settled bill', async () => {
    const v = await book();
    const e1 = await trpcError(
      collect(reception, v.billId, [{ mode: 'cash', amountPaise: 50_001 }]),
    );
    expect([e1.code, e1.message]).toEqual(['BAD_REQUEST', 'errors.billing.overpayment']);
    const e2 = await trpcError(reception.call((c) => c.billing.get({ billId: uuidv7() })));
    expect([e2.code, e2.message]).toEqual(['NOT_FOUND', 'errors.billing.billNotFound']);
    const [unpriced] = await f.db
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.facilityId, f.a.facilityId), eq(service.code, 'CONS-PAED-NEW')));
    const e3 = await trpcError(
      reception.call((c) =>
        c.billing.addLine({ billId: v.billId, serviceId: unpriced!.id, idempotencyKey: uuidv7() }),
      ),
    );
    expect([e3.code, e3.message]).toEqual(['BAD_REQUEST', 'errors.billing.noRate']);
    await collect(reception, v.billId, [{ mode: 'cash', amountPaise: 50_000 }]);
    const e4 = await trpcError(collect(reception, v.billId, [{ mode: 'cash', amountPaise: 1 }]));
    expect([e4.code, e4.message]).toEqual(['CONFLICT', 'errors.billing.nothingDue']);
    const e5 = await trpcError(
      reception.call((c) => c.billing.finalize({ billId: v.billId, idempotencyKey: uuidv7() })),
    );
    expect([e5.code, e5.message]).toEqual(['CONFLICT', 'errors.billing.notDraft']);
  });

  it('rejects malformed money input before it reaches the database', async () => {
    const v = await book();
    for (const tenders of [
      [{ mode: 'cash', amountPaise: 12.5 }],
      [{ mode: 'cash', amountPaise: -100 }],
      [{ mode: 'cheque', amountPaise: 100 }],
      [
        { mode: 'cash', amountPaise: 1 },
        { mode: 'cash', amountPaise: 1 },
      ],
    ]) {
      expect((await trpcError(collect(reception, v.billId, tenders))).code).toBe('BAD_REQUEST');
    }
  });

  it('refuses to cancel a visit whose bill holds money', async () => {
    const owner = f.browser();
    await owner.login(f.users.owner.username);
    const v = await book();
    await collect(reception, v.billId, [{ mode: 'cash', amountPaise: 10_000 }]);
    const e = await trpcError(
      owner.call((c) => c.visit.cancel({ encounterId: v.encounterId, reason: 'Patient left' })),
    );
    expect([e.code, e.message]).toEqual(['CONFLICT', 'errors.visit.billHasPayments']);
  });
});

describe('discounts, cancellation and refunds through the API (BIL-03, BIL-04)', () => {
  let owner: TestBrowser;
  let reasons: Record<string, string>;
  beforeAll(async () => {
    owner = f.browser();
    await owner.login(f.users.owner.username);
    const rows = await f.db
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.facilityId, f.a.facilityId));
    reasons = Object.fromEntries(rows.map((r) => [`${r.kind}:${r.code}`, r.id]));
  });

  const paidBill = async (rupees = 500) => {
    const v = await book();
    await collect(cashier, v.billId, [{ mode: 'cash', amountPaise: rupees * 100 }]);
    return v;
  };
  const discount = (
    b: TestBrowser,
    billId: string,
    over: Record<string, unknown> = {},
    key = uuidv7(),
  ) =>
    b.call((c) =>
      c.billing.applyDiscount({
        billId,
        mode: 'amount',
        amountPaise: 5_001,
        reasonCodeId: reasons['discount:poor_patient']!,
        idempotencyKey: key,
        ...over,
      } as never),
    );
  const cancel = (b: TestBrowser, billId: string, over: Record<string, unknown> = {}) =>
    b.call((c) =>
      c.billing.cancelBill({
        billId,
        reasonCodeId: reasons['cancel:patient_request']!,
        refund: { mode: 'cash' },
        idempotencyKey: uuidv7(),
        ...over,
      } as never),
    );

  it('checks the permission of every new procedure on the server', async () => {
    const v = await paidBill();
    const d = await book();
    for (const who of [doctor, nurse, admin, noRoles]) {
      const calls = [
        () => who.call((c) => c.billing.adjustmentSettings()),
        () => who.call((c) => c.billing.reasons({ kind: 'discount' })),
        () => discount(who, d.billId),
        () =>
          who.call((c) => c.billing.clearDiscount({ billId: d.billId, idempotencyKey: uuidv7() })),
        () => cancel(who, v.billId),
        () =>
          who.call((c) =>
            c.billing.voidDraft({
              billId: d.billId,
              reasonCodeId: reasons['cancel:duplicate']!,
              idempotencyKey: uuidv7(),
            }),
          ),
      ];
      for (const call of calls) expect((await trpcError(call())).code).toBe('FORBIDDEN');
    }
    // Reception may discount (with approval) but can neither cancel nor void.
    expect((await trpcError(cancel(reception, v.billId))).code).toBe('FORBIDDEN');
    const e = await trpcError(
      reception.call((c) =>
        c.billing.voidDraft({
          billId: d.billId,
          reasonCodeId: reasons['cancel:duplicate']!,
          idempotencyKey: uuidv7(),
        }),
      ),
    );
    expect(e.code).toBe('FORBIDDEN');
    // Reports are for reports.financial holders only.
    for (const who of [reception, cashier, doctor]) {
      const range = { from: '2026-01-01', to: '2030-01-01' };
      expect((await trpcError(who.call((c) => c.billing.discountReport(range)))).code).toBe(
        'FORBIDDEN',
      );
      expect((await trpcError(who.call((c) => c.billing.cancellationReport(range)))).code).toBe(
        'FORBIDDEN',
      );
    }
    expect(await f.db.select().from(creditNote).where(eq(creditNote.billId, v.billId))).toEqual([]);
  });

  it('asks reception for a supervisor, refuses a wrong PIN, and keeps the PIN out of every record', async () => {
    const v = await book();
    const e1 = await trpcError(discount(reception, v.billId));
    expect([e1.code, e1.message]).toEqual(['FORBIDDEN', 'errors.billing.approvalRequired']);

    const e2 = await trpcError(
      discount(reception, v.billId, {
        approver: { username: f.users.admin.username, pin: '0000' },
      }),
    );
    expect([e2.code, e2.message]).toEqual(['BAD_REQUEST', 'errors.approval.invalid']);

    // A cashier is not a supervisor: the right PIN of the wrong person does not approve.
    const e3 = await trpcError(
      discount(reception, v.billId, {
        approver: { username: f.users.cashier.username, pin: PIN },
      }),
    );
    expect([e3.code, e3.message]).toEqual(['FORBIDDEN', 'errors.approval.notAuthorised']);

    const key = uuidv7();
    const approver = { username: f.users.admin.username, pin: PIN };
    const r = await discount(reception, v.billId, { approver }, key);
    expect(r.netPaise).toBe('45000'); // ₹449.99 rounded to the rupee
    // Replaying the request with the PIN typed again returns the same result.
    expect(await discount(reception, v.billId, { approver }, key)).toEqual(r);

    const view = await reception.call((c) => c.billing.get({ billId: v.billId }));
    expect(view.discounts[0]).toMatchObject({ approvedByName: 'Test admin', amountPaise: 5_001n });
    // Neither the username nor the PIN reached audit, idempotency or any approval/discount row.
    const dump = await f.t.owner.execute(
      sql`select (select string_agg(a::text, ' ') from audit_log a where a.table_name in ('approval','bill_discount','bill'))
          || ' ' || (select coalesce(string_agg(i::text, ' '), '') from idempotency i) as txt`,
    );
    const txt = String(dump.rows[0]?.txt);
    expect(txt).not.toContain(`"${PIN}"`);
    expect(txt).not.toContain(f.users.admin.username);
  });

  it('cancels with a credit note: the cashier alone under the limit, with a supervisor above it', async () => {
    const small = await paidBill(500);
    const done = await cancel(cashier, small.billId);
    expect(done).toMatchObject({ billStatus: 'cancelled', refundPaise: '50000' });
    expect(done.creditNoteNumber).toMatch(/^CN\/\d\d-\d\d\/\d{5}$/);
    const view = await cashier.call((c) => c.billing.get({ billId: small.billId }));
    expect(view).toMatchObject({ status: 'cancelled', paidPaise: 0n, creditedPaise: 50_000n });
    expect(view.payments.map((p) => [p.kind, p.amountPaise])).toEqual([
      ['payment', 50_000n],
      ['refund', -50_000n],
    ]);

    // Lower the cancellation limit to ₹100: now a PIN is needed.
    await opd.run((tx) =>
      writeSetting(tx, f.a.facilityId, 'billing.cancelApprovalAbovePaise', 10_000),
    );
    try {
      const v = await paidBill(500);
      const e = await trpcError(cancel(cashier, v.billId));
      expect([e.code, e.message]).toEqual(['FORBIDDEN', 'errors.billing.approvalRequired']);
      const r = await cancel(cashier, v.billId, {
        approver: { username: f.users.admin.username, pin: PIN },
      });
      expect(r.billStatus).toBe('cancelled');
      // The owner holds the approve permission and needs no one else.
      const w = await paidBill(500);
      expect((await cancel(owner, w.billId)).billStatus).toBe('cancelled');
    } finally {
      await opd.run((tx) =>
        writeSetting(tx, f.a.facilityId, 'billing.cancelApprovalAbovePaise', 100_000),
      );
    }
  });

  it('refuses over-refunds and stale refund amounts with i18n keys', async () => {
    const v = await paidBill(500);
    const over = await trpcError(
      cancel(cashier, v.billId, { refund: { mode: 'cash', amountPaise: 50_001 } }),
    );
    expect([over.code, over.message]).toEqual(['BAD_REQUEST', 'errors.billing.refundExceedsPaid']);
    const less = await trpcError(
      cancel(cashier, v.billId, { refund: { mode: 'cash', amountPaise: 100 } }),
    );
    expect(less.message).toBe('errors.billing.refundMismatch');
    const none = await trpcError(cancel(cashier, v.billId, { refund: undefined }));
    expect(none.message).toBe('errors.billing.refundRequired');
    const draft = await book();
    expect((await trpcError(cancel(cashier, draft.billId))).message).toBe(
      'errors.billing.notFinal',
    );
    expect(
      await f.db
        .select()
        .from(payment)
        .where(and(eq(payment.billId, v.billId), eq(payment.kind, 'refund'))),
    ).toEqual([]);
  });

  it('locks the supervisor PIN after repeated wrong tries (429 with minutes)', async () => {
    const v = await book();
    const attempt = () =>
      trpcError(
        discount(reception, v.billId, {
          approver: { username: f.users.admin.username, pin: '1111' },
        }),
      );
    for (let i = 0; i < 4; i++) expect((await attempt()).message).toBe('errors.approval.invalid');
    expect((await attempt()).message).toBe('errors.approval.invalid');
    const locked = await attempt();
    expect([locked.code, locked.message]).toEqual(['TOO_MANY_REQUESTS', 'errors.approval.locked']);
    // Not even the right PIN works while locked.
    const right = await trpcError(
      discount(reception, v.billId, { approver: { username: f.users.admin.username, pin: PIN } }),
    );
    expect(right.message).toBe('errors.approval.locked');
  });

  it('shows the owner the discount and cancellation reports', async () => {
    // Reports take at most a year; the rows of this file were all written today.
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });
    const range = { from: day(-30), to: day(1) };
    const d = await owner.call((c) => c.billing.discountReport(range));
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.rows.some((r) => r.approvedByName === 'Test admin')).toBe(true);
    const x = await admin.call((c) => c.billing.cancellationReport(range));
    expect(x.rows.length).toBeGreaterThan(0);
    expect(x.totalRefundedPaise).toBeGreaterThan(0n);
  });
});
