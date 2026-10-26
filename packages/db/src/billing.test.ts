/**
 * BIL-01 / BIL-02 integration tests against a real Postgres: draft bill from the visit, lines,
 * GST and round-off, finalisation, payments (cash / UPI / card / split, partial), overpayment,
 * idempotency including concurrent duplicate submits, the DB invariants of docs/04 §15.1–2 and
 * receipt/bill numbering. Synthetic data only.
 */
import { rupeesToPaise, type TenderInput } from '@hmis/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLog, bill, billLine, opdToken, payment, service } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import {
  addBillLine,
  BillingInputError,
  collectPayment,
  createOpdBill,
  finalizeBill,
  getBillView,
  loadReceipt,
  removeBillLine,
} from './billing';
import { IdempotencyConflictError } from './idempotency';
import { setServiceRate } from './masters';
import { cancelVisit } from './queue';
import { writeSetting } from './settings';
import { withTx } from './tx';
import { VisitInputError } from './visits';

let fx: OpdFixture;
let taxable: string; // ₹199.99, 18% GST
let lab: string; // ₹333.50, exempt
let unpriced: string;
const AT = IST('2026-10-26T10:00:00');

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  const svc = async (code: string, opts: { gstBp?: number; rupees?: string }) => {
    const id = uuidv7();
    await fx.run(async (tx) => {
      await tx.insert(service).values({
        id,
        facilityId: fx.f.facilityId,
        code,
        name: `Test ${code}`,
        nameHi: `परीक्षण ${code}`,
        category: 'misc',
        sacCode: '999799',
        defaultGstRateBp: opts.gstBp ?? 0,
        isExempt: !opts.gstBp,
      });
      if (opts.rupees) {
        await setServiceRate(tx, {
          facilityId: fx.f.facilityId,
          serviceId: id,
          tariffId: fx.m.defaultTariffId,
          ratePaise: rupeesToPaise(opts.rupees),
          effectiveFrom: '2026-01-01',
        });
      }
    });
    return id;
  };
  taxable = await svc('T-GST', { gstBp: 1800, rupees: '199.99' });
  lab = await svc('T-LAB', { rupees: '333.50' });
  unpriced = await svc('T-NORATE', {});
});
afterAll(async () => {
  await fx.t.close();
});

const actor = () => ({ ...fx.actor(), workstationId: fx.f.workstationId });

/** A new patient's visit with Dr A (₹500 consultation) and its draft bill. */
async function newVisit(over: Record<string, unknown> = {}, at = AT) {
  return fx.visit({ patientId: await fx.newPatient(), ...over }, at);
}

const view = (billId: string) => getBillView(fx.t.app, fx.f.facilityId, billId).then((b) => b!);
const pay = (billId: string, tenders: TenderInput[], key = uuidv7(), at = AT, mayFinalize = true) =>
  fx.run((tx) =>
    collectPayment(tx, actor(), { billId, tenders, idempotencyKey: key }, at, { mayFinalize }),
  );
const add = (billId: string, serviceId: string, qty = '1', key = uuidv7()) =>
  fx.run((tx) => addBillLine(tx, actor(), { billId, serviceId, qty, idempotencyKey: key }, AT));
const cash = (amountPaise: bigint | number): TenderInput => ({ mode: 'cash', amountPaise });

async function errorKey(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BillingInputError || e instanceof VisitInputError) return e.key;
    if (e instanceof IdempotencyConflictError) return 'idempotency.conflict';
    throw e;
  }
  throw new Error('expected an error');
}

/** Raw SQL as the app role inside a transaction; resolves to the error message or 'ok'. */
async function rawSql(q: ReturnType<typeof sql>): Promise<string> {
  try {
    await withTx({ db: fx.t.app, userId: fx.f.userId }, (tx) => tx.execute(q));
    return 'ok';
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
}

describe('OPD bill from the visit (BIL-01)', () => {
  it('creates a draft with the consultation line, priced and snapshotted', async () => {
    const v = await newVisit();
    const b = await view(v.billId);
    expect(b).toMatchObject({
      status: 'draft',
      number: null,
      kind: 'opd',
      grossPaise: 50_000n,
      netPaise: 50_000n,
      balancePaise: 50_000n,
      paidPaise: 0n,
      tokenNo: null,
      encounterId: v.encounterId,
    });
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatchObject({
      seq: 1,
      qty: '1.000',
      unitRatePaise: 50_000n,
      amountPaise: 50_000n,
      gstRateBp: 0,
    });
    const [row] = await fx.t.app.select().from(billLine).where(eq(billLine.billId, v.billId));
    expect(row?.serviceRateId).not.toBeNull();
    expect(row?.performedByDoctorId).toBe(fx.doctorA);
  });

  it('keeps the old price on the line when the tariff changes later', async () => {
    const v = await newVisit();
    const [line] = await fx.t.app.select().from(billLine).where(eq(billLine.billId, v.billId));
    await fx.run((tx) =>
      setServiceRate(tx, {
        facilityId: fx.f.facilityId,
        serviceId: line!.serviceId!,
        tariffId: fx.m.defaultTariffId,
        ratePaise: 60_000n,
        effectiveFrom: '2027-01-01',
      }),
    );
    expect((await view(v.billId)).lines[0]?.unitRatePaise).toBe(50_000n);
  });

  it('opens an empty draft for a visit without a fee rule, and a ₹0 line for a free follow-up', async () => {
    const none = await newVisit({ doctorId: fx.doctorNoRule });
    const b = await view(none.billId);
    expect([b.lines.length, b.netPaise, b.status]).toEqual([0, 0n, 'draft']);

    const patientId = await fx.newPatient();
    await fx.visit({ patientId }, IST('2026-10-20T10:00:00'));
    const fu = await fx.visit({ patientId, visitType: 'follow_up' }, IST('2026-10-22T10:00:00'));
    expect(fu.tokenNo).not.toBeNull(); // ₹0 → token at once (REG-03)
    const fb = await view(fu.billId);
    expect(fb.lines).toHaveLength(1);
    expect(fb.netPaise).toBe(0n);
  });

  it('adds services with GST per line and rounds the bill to the rupee', async () => {
    const v = await newVisit();
    const r = await add(v.billId, taxable, '3');
    // 3 × ₹199.99 = 59,997; 9% of it = 5,399.73 → 5,400 CGST and 5,400 SGST.
    const b = await view(v.billId);
    expect(b.lines[1]).toMatchObject({
      amountPaise: 59_997n,
      gstRateBp: 1800,
      cgstPaise: 5_400n,
      sgstPaise: 5_400n,
      patientSharePaise: 70_797n,
    });
    expect(b).toMatchObject({
      grossPaise: 109_997n,
      taxablePaise: 109_997n,
      cgstPaise: 5_400n,
      sgstPaise: 5_400n,
      roundOffPaise: 3n,
      netPaise: 120_800n,
      balancePaise: 120_800n,
    });
    expect(r).toMatchObject({ netPaise: '120800', balancePaise: '120800' });

    await add(v.billId, lab, '1');
    const b2 = await view(v.billId);
    // 1,20,797 + 33,350 = 1,54,147 paise → nearest rupee 1,54,100 (round-off −47).
    expect([b2.roundOffPaise, b2.netPaise]).toEqual([-47n, 154_100n]);
  });

  it('respects billing.roundToRupee = false', async () => {
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.roundToRupee', false));
    try {
      const v = await newVisit();
      await add(v.billId, lab);
      const b = await view(v.billId);
      expect([b.roundOffPaise, b.netPaise]).toEqual([0n, 83_350n]);
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.roundToRupee', true));
    }
  });

  it('removes a draft line by cancelling it (never deleting) and recomputes', async () => {
    const v = await newVisit();
    const { lineId } = await add(v.billId, lab);
    const out = await fx.run((tx) =>
      removeBillLine(
        tx,
        actor(),
        { billId: v.billId, lineId: lineId!, reason: 'Added by mistake', idempotencyKey: uuidv7() },
        AT,
      ),
    );
    expect(out.netPaise).toBe('50000');
    const rows = await fx.t.app
      .select()
      .from(billLine)
      .where(eq(billLine.billId, v.billId))
      .orderBy(asc(billLine.seq));
    expect(rows.map((r) => r.status)).toEqual(['active', 'cancelled']);
    expect(rows[1]).toMatchObject({ cancelReason: 'Added by mistake', cancelledBy: fx.f.userId });
    expect(
      await errorKey(
        fx.run((tx) =>
          removeBillLine(
            tx,
            actor(),
            { billId: v.billId, lineId: lineId!, idempotencyKey: uuidv7() },
            AT,
          ),
        ),
      ),
    ).toBe('billing.lineNotFound');
    // A new line after a removal takes the next seq (seq is never reused).
    await add(v.billId, lab);
    expect((await view(v.billId)).lines.map((l) => l.seq)).toEqual([1, 3]);
  });

  it('refuses a service without a rate or not in the masters', async () => {
    const v = await newVisit();
    expect(await errorKey(add(v.billId, unpriced))).toBe('billing.noRate');
    expect(await errorKey(add(v.billId, uuidv7()))).toBe('billing.serviceNotFound');
    expect(await errorKey(add(uuidv7(), lab))).toBe('billing.billNotFound');
  });

  it('replays a double "add" and adds the line once', async () => {
    const v = await newVisit();
    const key = uuidv7();
    const [a, b] = await Promise.all([add(v.billId, lab, '1', key), add(v.billId, lab, '1', key)]);
    expect(b).toEqual(a);
    expect((await view(v.billId)).lines).toHaveLength(2);
    expect(await errorKey(add(v.billId, lab, '2', key))).toBe('idempotency.conflict');
  });

  it('opens a draft for an older visit without one, once', async () => {
    const v = await newVisit();
    await fx.t.owner.execute(
      sql`update bill set status = 'cancelled', cancel_note = 'test', cancelled_at = now() where id = ${v.billId}`,
    );
    const a = await fx.run((tx) =>
      createOpdBill(tx, actor(), { encounterId: v.encounterId, idempotencyKey: uuidv7() }),
    );
    const b = await fx.run((tx) =>
      createOpdBill(tx, actor(), { encounterId: v.encounterId, idempotencyKey: uuidv7() }),
    );
    expect(b.billId).toBe(a.billId);
    expect((await view(a.billId)).netPaise).toBe(50_000n);
  });
});

describe('payments (BIL-02)', () => {
  it('cash in full: receipt number, final bill with number, token released on payment', async () => {
    const v = await newVisit();
    expect(v.tokenNo).toBeNull();
    const r = await pay(v.billId, [cash(50_000n)]);
    expect(r).toMatchObject({
      billStatus: 'final',
      totalPaise: '50000',
      paidPaise: '50000',
      balancePaise: '0',
      encounterId: v.encounterId,
    });
    expect(r.receiptNumber).toMatch(/^RC\/26-27\/\d{6}$/);
    expect(r.billNumber).toMatch(/^OB\/26-27\/\d{6}$/);
    expect(r.tokenNo).toBeGreaterThan(0);
    const [tok] = await fx.t.app
      .select()
      .from(opdToken)
      .where(eq(opdToken.encounterId, v.encounterId));
    expect(tok?.issuedBasis).toBe('payment');
    const b = await view(v.billId);
    expect(b).toMatchObject({ status: 'final', paidPaise: 50_000n, balancePaise: 0n });
    expect(b.payments).toHaveLength(1);
    expect(b.payments[0]).toMatchObject({ mode: 'cash', amountPaise: 50_000n });
  });

  it('split across cash, UPI with UTR and card: one receipt, one row per mode', async () => {
    const v = await newVisit();
    await add(v.billId, lab); // ₹833.50 → ₹834
    const r = await pay(v.billId, [
      cash(30_000n),
      { mode: 'upi', amountPaise: 40_000n, upiRef: '123456789012', upiPayerName: 'R Devi' },
      { mode: 'card', amountPaise: 13_400n, cardLast4: '4242' },
    ]);
    expect(r.billStatus).toBe('final');
    const rows = await fx.t.app
      .select()
      .from(payment)
      .where(eq(payment.collectionId, r.collectionId));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((p) => p.number))).toEqual(new Set([r.receiptNumber]));
    expect(rows.find((p) => p.mode === 'upi')).toMatchObject({
      upiRef: '123456789012',
      upiPayerName: 'R Devi',
      cardLast4: null,
    });
    expect(rows.find((p) => p.mode === 'card')?.cardLast4).toBe('4242');
    const receipt = (await loadReceipt(fx.t.app, fx.f.facilityId, r.collectionId))!;
    expect(receipt.totalPaise).toBe(83_400n);
    expect(receipt.tenders.map((t) => t.mode).sort()).toEqual(['card', 'cash', 'upi']);
    expect(receipt.bill?.lines).toHaveLength(2);
  });

  it('partial payments keep the draft open; the last one finalises and gives the token', async () => {
    const v = await newVisit();
    const r1 = await pay(v.billId, [cash(20_000n)]);
    expect(r1).toMatchObject({ billStatus: 'draft', billNumber: null, balancePaise: '30000' });
    expect(r1.tokenNo).toBeNull();
    // A draft that holds money cannot drop below it.
    const b = await view(v.billId);
    expect(
      await errorKey(
        fx.run((tx) =>
          removeBillLine(
            tx,
            actor(),
            { billId: v.billId, lineId: b.lines[0]!.id, idempotencyKey: uuidv7() },
            AT,
          ),
        ),
      ),
    ).toBe('billing.belowPaid');
    const r2 = await pay(v.billId, [{ mode: 'upi', amountPaise: 30_000n }]);
    expect(r2).toMatchObject({ billStatus: 'final', balancePaise: '0' });
    expect(r2.receiptNumber).not.toBe(r1.receiptNumber);
    expect(r2.tokenNo).toBeGreaterThan(0);
  });

  it('rejects overpayment and payment of a settled bill, writing nothing', async () => {
    const v = await newVisit();
    expect(await errorKey(pay(v.billId, [cash(50_001n)]))).toBe('billing.overpayment');
    expect(
      await errorKey(pay(v.billId, [cash(30_000n), { mode: 'upi', amountPaise: 20_001n }])),
    ).toBe('billing.overpayment');
    expect(await fx.t.app.select().from(payment).where(eq(payment.billId, v.billId))).toHaveLength(
      0,
    );
    await pay(v.billId, [cash(50_000n)]);
    expect(await errorKey(pay(v.billId, [cash(1n)]))).toBe('billing.nothingDue');
    const free = await newVisit({ doctorId: fx.doctorNoRule });
    expect(await errorKey(pay(free.billId, [cash(100n)]))).toBe('billing.nothingDue');
  });

  it('needs the UTR above the configured amount when the setting says so', async () => {
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'billing.upiRefRequired', {
        mode: 'required_above_amount',
        abovePaise: 30_000,
      }),
    );
    try {
      const v = await newVisit();
      expect(await errorKey(pay(v.billId, [{ mode: 'upi', amountPaise: 50_000n }]))).toBe(
        'billing.upiRefRequired',
      );
      const ok = await pay(v.billId, [{ mode: 'upi', amountPaise: 50_000n, upiRef: '9876' }]);
      expect(ok.billStatus).toBe('final');
    } finally {
      await fx.run((tx) =>
        writeSetting(tx, fx.f.facilityId, 'billing.upiRefRequired', {
          mode: 'optional',
          abovePaise: 200_000,
        }),
      );
    }
  });

  it('drops UPI references when the setting is off', async () => {
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'billing.upiRefRequired', { mode: 'off', abovePaise: 0 }),
    );
    try {
      const v = await newVisit();
      const r = await pay(v.billId, [{ mode: 'upi', amountPaise: 50_000n, upiRef: '9876' }]);
      const [row] = await fx.t.app
        .select()
        .from(payment)
        .where(eq(payment.collectionId, r.collectionId));
      expect(row?.upiRef).toBeNull();
    } finally {
      await fx.run((tx) =>
        writeSetting(tx, fx.f.facilityId, 'billing.upiRefRequired', {
          mode: 'optional',
          abovePaise: 200_000,
        }),
      );
    }
  });

  it('will not settle a draft for someone who may not finalise bills', async () => {
    const v = await newVisit();
    expect(await errorKey(pay(v.billId, [cash(50_000n)], uuidv7(), AT, false))).toBe(
      'billing.finalizeNotAllowed',
    );
    // A part payment does not finalise, so it is allowed.
    expect((await pay(v.billId, [cash(10_000n)], uuidv7(), AT, false)).billStatus).toBe('draft');
  });

  it('gives consecutive receipt numbers in the FY series', async () => {
    const a = await newVisit();
    const b = await newVisit();
    const r1 = await pay(a.billId, [cash(50_000n)]);
    const r2 = await pay(b.billId, [cash(50_000n)]);
    const n = (s: string) => Number(s.split('/').at(-1));
    expect(n(r2.receiptNumber)).toBe(n(r1.receiptNumber) + 1);
    expect(n(r2.billNumber!)).toBe(n(r1.billNumber!) + 1);
    // 1 April starts a new FY series.
    const c = await newVisit({}, IST('2027-04-01T09:00:00'));
    // (an earlier test raised the consultation rate from 2027; pay whatever is due)
    const due = (await view(c.billId)).balancePaise;
    const r3 = await pay(c.billId, [cash(due)], uuidv7(), IST('2027-04-01T09:05:00'));
    expect(r3.receiptNumber).toBe('RC/27-28/000001');
    expect(r3.billNumber).toBe('OB/27-28/000001');
  });

  it('audits bill, line and payment writes with the actor', async () => {
    const v = await newVisit();
    const r = await pay(v.billId, [cash(50_000n)]);
    const rows = await fx.t.app
      .select({ table: auditLog.tableName, action: auditLog.action, by: auditLog.changedBy })
      .from(auditLog)
      .where(sql`${auditLog.rowId} in (${v.billId}, ${r.collectionId})`);
    expect(rows.some((x) => x.table === 'payment' && x.action === 'I')).toBe(true);
    expect(rows.filter((x) => x.table === 'bill').length).toBeGreaterThanOrEqual(3);
    expect(rows.every((x) => x.by === fx.f.userId)).toBe(true);
  });
});

describe('idempotency of payments (AGENTS.md rule 9)', () => {
  it('replays a duplicate submit with the original result and one receipt', async () => {
    const v = await newVisit();
    const key = uuidv7();
    const a = await pay(v.billId, [cash(50_000n)], key);
    const b = await pay(v.billId, [cash(50_000n)], key);
    expect(b).toEqual(a);
    expect(await fx.t.app.select().from(payment).where(eq(payment.billId, v.billId))).toHaveLength(
      1,
    );
    expect(await errorKey(pay(v.billId, [cash(40_000n)], key))).toBe('idempotency.conflict');
  });

  it('gives every concurrent duplicate the same result and creates one payment', async () => {
    const v = await newVisit();
    const key = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pay(v.billId, [cash(20_000n)], key)),
    );
    for (const r of results) expect(r).toEqual(results[0]);
    const rows = await fx.t.app.select().from(payment).where(eq(payment.billId, v.billId));
    expect(rows).toHaveLength(1);
    expect((await view(v.billId)).paidPaise).toBe(20_000n);
  });

  it('two cashiers paying the same bill at once cannot overpay it (row lock)', async () => {
    const v = await newVisit();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => pay(v.billId, [cash(50_000n)])),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        expect(o.reason).toBeInstanceOf(BillingInputError);
        expect((o.reason as BillingInputError).key).toBe('billing.nothingDue');
      }
    }
    const b = await view(v.billId);
    expect([b.paidPaise, b.balancePaise, b.payments.length]).toEqual([50_000n, 0n, 1]);
    const toks = await fx.t.app
      .select()
      .from(opdToken)
      .where(eq(opdToken.encounterId, v.encounterId));
    expect(toks).toHaveLength(1);
  });

  it('concurrent partial payments add up exactly and stop at the balance', async () => {
    const v = await newVisit();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 7 }, () => pay(v.billId, [cash(10_000n)])),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(5);
    const b = await view(v.billId);
    expect([b.paidPaise, b.status]).toEqual([50_000n, 'final']);
  });
});

describe('finalisation and the final bill (docs/04 §15.2)', () => {
  it('needs full payment unless OPD credit is allowed', async () => {
    const v = await newVisit();
    const fin = (key = uuidv7()) =>
      fx.run((tx) => finalizeBill(tx, actor(), { billId: v.billId, idempotencyKey: key }, AT));
    expect(await errorKey(fin())).toBe('billing.unpaid');
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.allowOpdCredit', true));
    try {
      const out = await fin();
      expect(out.billNumber).toMatch(/^OB\//);
      expect(out.tokenNo).toBeNull(); // nothing paid yet: the token still waits
      // Payment later on the final bill settles it and releases the token.
      const r = await pay(v.billId, [cash(50_000n)]);
      expect(r).toMatchObject({ billStatus: 'final', billNumber: out.billNumber });
      expect(r.tokenNo).toBeGreaterThan(0);
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.allowOpdCredit', false));
    }
  });

  it('refuses to finalise an empty draft and a bill twice', async () => {
    const none = await newVisit({ doctorId: fx.doctorNoRule });
    expect(
      await errorKey(
        fx.run((tx) =>
          finalizeBill(tx, actor(), { billId: none.billId, idempotencyKey: uuidv7() }, AT),
        ),
      ),
    ).toBe('billing.empty');
    const v = await newVisit();
    await pay(v.billId, [cash(50_000n)]);
    expect(
      await errorKey(
        fx.run((tx) =>
          finalizeBill(tx, actor(), { billId: v.billId, idempotencyKey: uuidv7() }, AT),
        ),
      ),
    ).toBe('billing.notDraft');
    expect(await errorKey(add(v.billId, lab))).toBe('billing.notDraft');
  });

  it('blocks any change to a final bill or its lines in the database itself', async () => {
    const v = await newVisit();
    await pay(v.billId, [cash(50_000n)]);
    const [line] = await fx.t.app.select().from(billLine).where(eq(billLine.billId, v.billId));
    expect(
      await rawSql(sql`update bill set net_paise = 1, gross_paise = 1, taxable_paise = 1,
        patient_share_paise = 1, paid_paise = 1, balance_paise = 0 where id = ${v.billId}`),
    ).toMatch(/final/);
    expect(await rawSql(sql`update bill set status = 'draft' where id = ${v.billId}`)).toMatch(
      /final/,
    );
    expect(
      await rawSql(sql`update bill set number = 'OB/26-27/999999' where id = ${v.billId}`),
    ).toMatch(/immutable/);
    expect(
      await rawSql(sql`update bill_line set description = 'x' where id = ${line!.id}`),
    ).toMatch(/not a draft/);
    expect(
      await rawSql(sql`insert into bill_line (id, facility_id, bill_id, seq, description, service_date)
        values (${uuidv7()}, ${fx.f.facilityId}, ${v.billId}, 9, 'x', '2026-10-26')`),
    ).toMatch(/not a draft/);
    expect(await rawSql(sql`delete from bill where id = ${v.billId}`)).toMatch(/permission/);
    expect(await rawSql(sql`delete from payment where bill_id = ${v.billId}`)).toMatch(
      /permission/,
    );
  });

  it('keeps payments immutable apart from a reversal', async () => {
    const v = await newVisit();
    const r = await pay(v.billId, [cash(50_000n)]);
    expect(
      await rawSql(sql`update payment set amount_paise = 1 where id = ${r.collectionId}`),
    ).toMatch(/immutable/);
    expect(await rawSql(sql`update payment set mode = 'upi' where id = ${r.collectionId}`)).toMatch(
      /immutable/,
    );
  });
});

describe('bill invariants in the database (docs/04 §15.1)', () => {
  it('rejects a header whose arithmetic is off', async () => {
    const v = await newVisit();
    expect(
      await rawSql(sql`update bill set net_paise = net_paise + 1 where id = ${v.billId}`),
    ).toMatch(/bill_net_math|bill_share_math|bill_balance_math/);
    expect(
      await rawSql(sql`update bill set round_off_paise = 60, net_paise = net_paise + 60,
        patient_share_paise = patient_share_paise + 60, balance_paise = balance_paise + 60
        where id = ${v.billId}`),
    ).toMatch(/bill_round_off_range/);
  });

  it('rejects a consistent header that does not match its lines (deferred check)', async () => {
    const v = await newVisit();
    expect(
      await rawSql(sql`update bill set gross_paise = gross_paise + 100, taxable_paise = taxable_paise + 100,
        net_paise = net_paise + 100, patient_share_paise = patient_share_paise + 100,
        balance_paise = balance_paise + 100 where id = ${v.billId}`),
    ).toMatch(/totals do not match/);
  });

  it('rejects line arithmetic errors', async () => {
    const v = await newVisit();
    const [line] = await fx.t.app.select().from(billLine).where(eq(billLine.billId, v.billId));
    expect(
      await rawSql(
        sql`update bill_line set amount_paise = amount_paise + 1 where id = ${line!.id}`,
      ),
    ).toMatch(/bill_line_amount_math/);
    expect(
      await rawSql(
        sql`update bill_line set gst_rate_bp = 500, is_exempt = false where id = ${line!.id}`,
      ),
    ).toMatch(/bill_line_gst_math/);
  });

  it('rejects a paid amount that does not match the payments, and overpayment', async () => {
    const v = await newVisit();
    await pay(v.billId, [cash(20_000n)]);
    expect(
      await rawSql(
        sql`update bill set paid_paise = 50000, balance_paise = 0 where id = ${v.billId}`,
      ),
    ).toMatch(/paid amount does not match/);
    expect(
      await rawSql(
        sql`update bill set paid_paise = 60000, balance_paise = -10000 where id = ${v.billId}`,
      ),
    ).toMatch(/bill_no_overpayment/);
  });

  it('rejects a payment row that bypasses the bill header', async () => {
    const v = await newVisit();
    const [b] = await fx.t.app.select().from(bill).where(eq(bill.id, v.billId));
    const id = uuidv7();
    expect(
      await rawSql(sql`insert into payment (id, facility_id, number, collection_id, patient_id, bill_id,
        mode, amount_paise, received_at, idempotency_key)
        values (${id}, ${fx.f.facilityId}, 'RC/X/1', ${id}, ${b!.patientId}, ${v.billId}, 'cash', 100, now(), ${uuidv7()})`),
    ).toMatch(/paid amount does not match/);
    expect(
      await rawSql(sql`insert into payment (id, facility_id, number, collection_id, patient_id, bill_id,
        mode, amount_paise, received_at, idempotency_key)
        values (${id}, ${fx.f.facilityId}, 'RC/X/1', ${id}, ${b!.patientId}, ${v.billId}, 'cash', -100, now(), ${uuidv7()})`),
    ).toMatch(/payment_amount_sign/);
  });
});

describe('visit cancellation and the bill', () => {
  it('cancels the draft with the visit', async () => {
    const v = await newVisit();
    await fx.run((tx) => cancelVisit(tx, fx.actor(), v.encounterId, 'Wrong doctor', AT));
    const b = await view(v.billId);
    expect(b.status).toBe('cancelled');
    const [row] = await fx.t.app.select().from(bill).where(eq(bill.id, v.billId));
    expect(row).toMatchObject({ cancelNote: 'Wrong doctor', cancelledBy: fx.f.userId });
    expect(await errorKey(pay(v.billId, [cash(100n)]))).toBe('billing.billCancelled');
  });

  it('refuses to cancel a visit whose bill holds money (credit note is BIL-04)', async () => {
    const v = await newVisit();
    await pay(v.billId, [cash(10_000n)]);
    expect(
      await errorKey(fx.run((tx) => cancelVisit(tx, fx.actor(), v.encounterId, 'Left', AT))),
    ).toBe('visit.billHasPayments');
    const [b] = await fx.t.app
      .select({ status: bill.status })
      .from(bill)
      .where(and(eq(bill.id, v.billId)));
    expect(b?.status).toBe('draft');
  });
});
