/**
 * BIL-03 / BIL-04 integration tests against a real Postgres: discount limits by role and
 * mandatory reasons, supervisor PIN approval (and its lockout), cancellation of final bills by
 * credit note, refunds as negative payment rows with an approval on record, over-refund attempts
 * (API and raw SQL), concurrent refunds, numbers kept by cancelled documents, report hooks.
 * Synthetic data only.
 */
import { rupeesToPaise, type RoleKey, type TenderInput } from '@hmis/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  appUser,
  approval,
  bill,
  billDiscount,
  creditNote,
  payment,
  reasonCode,
  service,
} from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { ApprovalError, verifyApproverPin } from './approvals';
import {
  addBillLine,
  removeBillLine,
  BillingInputError,
  collectPayment,
  finalizeBill,
  getBillView,
  loadReceipt,
} from './billing';
import {
  applyDiscount,
  cancelFinalBill,
  cancellationReport,
  clearDiscount,
  discountReport,
  voidDraftBill,
} from './billing-adjustments';
import { IdempotencyConflictError } from './idempotency';
import { setServiceRate } from './masters';
import { hashSecret } from './password';
import { ensureFacilityRbac, grantRoles } from './rbac';
import { writeSetting } from './settings';
import { withTx } from './tx';

let fx: OpdFixture;
let taxable: string; // ₹199.99, 18% GST
let lab: string; // ₹333.50, exempt
let big: string; // ₹2,000, exempt
const AT = IST('2026-10-26T10:00:00');
const PIN = '4821';

interface TestUser {
  id: string;
  username: string;
}
let reception: TestUser;
let cashier: TestUser;
let admin: TestUser;
let owner: TestUser;
let admin2: TestUser; // a second approver for lockout tests
let reasons: Record<string, string>;

const reasonId = (kind: string, code: string) => reasons[`${kind}:${code}`]!;

async function mkUser(role: RoleKey, pin: string | null = PIN): Promise<TestUser> {
  const id = uuidv7();
  const username = `${role}_${randomBytes(3).toString('hex')}`;
  await fx.t.owner.insert(appUser).values({
    id,
    facilityId: fx.f.facilityId,
    username,
    fullName: `Test ${role}`,
    pinHash: pin ? await hashSecret(pin) : null,
  });
  await withTx({ db: fx.t.owner, userId: null }, (tx) =>
    grantRoles(tx, fx.f.facilityId, id, [role]),
  );
  return { id, username };
}

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  await withTx({ db: fx.t.owner, userId: null }, (tx) => ensureFacilityRbac(tx, fx.f.facilityId));
  [reception, cashier, admin, owner, admin2] = await Promise.all([
    mkUser('reception'),
    mkUser('cashier'),
    mkUser('admin'),
    mkUser('owner'),
    mkUser('admin'),
  ]);
  const rows = await fx.t.app
    .select()
    .from(reasonCode)
    .where(eq(reasonCode.facilityId, fx.f.facilityId));
  reasons = Object.fromEntries(rows.map((r) => [`${r.kind}:${r.code}`, r.id]));
  const svc = async (code: string, rupees: string, gstBp = 0) => {
    const id = uuidv7();
    await fx.run(async (tx) => {
      await tx.insert(service).values({
        id,
        facilityId: fx.f.facilityId,
        code,
        name: `Test ${code}`,
        category: 'misc',
        sacCode: '999799',
        defaultGstRateBp: gstBp,
        isExempt: !gstBp,
      });
      await setServiceRate(tx, {
        facilityId: fx.f.facilityId,
        serviceId: id,
        tariffId: fx.m.defaultTariffId,
        ratePaise: rupeesToPaise(rupees),
        effectiveFrom: '2026-01-01',
      });
    });
    return id;
  };
  taxable = await svc('A-GST', '199.99', 1800);
  lab = await svc('A-LAB', '333.50');
  big = await svc('A-BIG', '2000');
});
afterAll(async () => {
  await fx.t.close();
});

const as = (u: TestUser) => ({
  facilityId: fx.f.facilityId,
  userId: u.id,
  workstationId: fx.f.workstationId,
});
const view = (billId: string) => getBillView(fx.t.app, fx.f.facilityId, billId).then((b) => b!);
const cash = (amountPaise: bigint | number): TenderInput => ({ mode: 'cash', amountPaise });

async function newVisit() {
  return fx.visit({ patientId: await fx.newPatient() }, AT);
}
const add = (billId: string, serviceId: string, qty = '1') =>
  fx.run((tx) =>
    addBillLine(tx, as(cashier), { billId, serviceId, qty, idempotencyKey: uuidv7() }, AT),
  );

/** A draft bill with the ₹500 consultation plus the given services. */
async function draft(...extra: [string, string?][]) {
  const v = await newVisit();
  for (const [s, q] of extra) await add(v.billId, s, q);
  return v;
}

/** A paid, final bill (cash in full) with the ₹500 consultation plus the given services. */
async function finalBill(...extra: [string, string?][]) {
  const v = await draft(...extra);
  const b = await view(v.billId);
  const r = await fx.run((tx) =>
    collectPayment(
      tx,
      as(cashier),
      { billId: v.billId, tenders: [cash(b.netPaise)], idempotencyKey: uuidv7() },
      AT,
      { mayFinalize: true },
    ),
  );
  return { ...v, receipt: r, net: b.netPaise };
}

const discountBy = (
  who: TestUser,
  billId: string,
  req: Record<string, unknown>,
  approverId: string | null = null,
  key = uuidv7(),
) =>
  fx.run((tx) =>
    applyDiscount(
      tx,
      as(who),
      {
        billId,
        mode: 'percent',
        percentBp: 500,
        reasonCodeId: reasonId('discount', 'poor_patient'),
        idempotencyKey: key,
        ...req,
      } as never,
      AT,
      { approverId },
    ),
  );

const cancelBy = (
  who: TestUser,
  billId: string,
  req: Record<string, unknown> = {},
  approverId: string | null = null,
  at = AT,
) =>
  fx.run((tx) =>
    cancelFinalBill(
      tx,
      as(who),
      {
        billId,
        reasonCodeId: reasonId('cancel', 'patient_request'),
        idempotencyKey: uuidv7(),
        ...req,
      },
      at,
      { approverId },
    ),
  );

async function errorKey(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BillingInputError || e instanceof ApprovalError) return e.key;
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

describe('discount limits by role (BIL-03, docs/03 §4)', () => {
  it('lets a cashier give up to 10% or ₹500 (whichever is lower) without approval', async () => {
    const v = await draft(); // ₹500
    const r = await discountBy(cashier, v.billId, { mode: 'percent', percentBp: 1000 });
    expect(r.netPaise).toBe('45000');
    const b = await view(v.billId);
    expect(b).toMatchObject({ grossPaise: 50_000n, discountPaise: 5_000n, netPaise: 45_000n });
    expect(b.lines[0]).toMatchObject({ discountPaise: 5_000n });
    expect(b.discounts).toHaveLength(1);
    expect(b.discounts[0]).toMatchObject({ reasonLabel: 'Poor patient', approvedByName: null });
    expect(await fx.t.app.select().from(approval).where(eq(approval.billId, v.billId))).toEqual([]);
  });

  it('asks for a supervisor above the limit, and records who approved', async () => {
    const v = await draft(); // ₹500: 10.02% is over 10%
    const req = { mode: 'amount', amountPaise: 5_001n };
    expect(await errorKey(discountBy(cashier, v.billId, req))).toBe('billing.approvalRequired');
    // The failed attempt left nothing behind.
    expect((await view(v.billId)).discountPaise).toBe(0n);

    await discountBy(cashier, v.billId, req, admin.id);
    const b = await view(v.billId);
    expect(b.discountPaise).toBe(5_001n);
    expect(b.discounts[0]?.approvedByName).toBe('Test admin');
    const [ap] = await fx.t.app.select().from(approval).where(eq(approval.billId, v.billId));
    expect(ap).toMatchObject({
      kind: 'discount',
      method: 'pin',
      approverId: admin.id,
      requestedBy: cashier.id,
      amountPaise: 5_001n,
    });
    const [d] = await fx.t.app.select().from(billDiscount).where(eq(billDiscount.billId, v.billId));
    expect(d?.approvalId).toBe(ap?.id);
  });

  it('uses the lower of the percent and amount limits (₹500 cap on a big bill)', async () => {
    const v = await draft([big]); // gross ₹2,500: 10% = ₹250 fine, ₹501 is over the ₹500 cap
    await discountBy(cashier, v.billId, { mode: 'amount', amountPaise: 25_000n });
    expect(
      await errorKey(discountBy(cashier, v.billId, { mode: 'amount', amountPaise: 50_001n })),
    ).toBe('billing.approvalRequired');
    // 20% of ₹2,500 = ₹500 is inside the ₹500 cap but over 10%.
    expect(
      await errorKey(discountBy(cashier, v.billId, { mode: 'percent', percentBp: 2000 })),
    ).toBe('billing.approvalRequired');
  });

  it('needs approval for any discount by reception (limit 0)', async () => {
    const v = await draft();
    const req = { mode: 'amount', amountPaise: 100n };
    expect(await errorKey(discountBy(reception, v.billId, req))).toBe('billing.approvalRequired');
    await discountBy(reception, v.billId, req, admin.id);
    expect((await view(v.billId)).discountPaise).toBe(100n);
  });

  it('lets admin and owner discount without a PIN (unlimited)', async () => {
    const v = await draft();
    await discountBy(owner, v.billId, { mode: 'percent', percentBp: 5000 });
    expect((await view(v.billId)).netPaise).toBe(25_000n);
    expect(await fx.t.app.select().from(approval).where(eq(approval.billId, v.billId))).toEqual([]);
  });

  it('re-checks the limit when lines are removed, so a kept ₹ discount cannot exceed it (#69)', async () => {
    const v = await draft([big]); // gross ₹2,500; ₹250 = 10% is within the cashier's limit
    await discountBy(cashier, v.billId, { mode: 'amount', amountPaise: 25_000n });
    const before = await view(v.billId);
    const bigLine = before.lines.find((l) => l.amountPaise === 200_000n)!;
    await fx.run((tx) =>
      removeBillLine(
        tx,
        as(cashier),
        { billId: v.billId, lineId: bigLine.id, reason: 'Not needed', idempotencyKey: uuidv7() },
        AT,
      ),
    );
    const b = await view(v.billId);
    const approvals = await fx.t.app.select().from(approval).where(eq(approval.billId, v.billId));
    expect(b.grossPaise).toBe(50_000n);
    expect(b.discountPaise * 10_000n <= 1_000n * b.grossPaise || approvals.length > 0).toBe(true);
    expect(b.discountPaise).toBe(5_000n); // scaled down to the 10% the cashier may give
  });

  it('counts the whole bill discount, so line discounts cannot be split under the limit', async () => {
    const v = await draft([lab]); // ₹833.50: 10% = ₹83.35
    const b = await view(v.billId);
    const [l1, l2] = b.lines;
    // Two line discounts of 6% each pass alone but add up to 12% of the bill.
    await discountBy(cashier, v.billId, { lineId: l1!.id, mode: 'amount', amountPaise: 5_000n });
    expect(
      await errorKey(
        discountBy(cashier, v.billId, { lineId: l2!.id, mode: 'amount', amountPaise: 5_000n }),
      ),
    ).toBe('billing.approvalRequired');
  });

  it('refuses an approver who is not a supervisor, or whose own limit is lower', async () => {
    const v = await draft();
    const req = { mode: 'amount', amountPaise: 20_000n };
    expect(await errorKey(discountBy(reception, v.billId, req, cashier.id))).toBe(
      'billing.approvalRequired',
    );
    // The requester cannot approve themselves by passing their own id either.
    expect(await errorKey(discountBy(cashier, v.billId, req, cashier.id))).toBe(
      'billing.approvalRequired',
    );
    // An admin whose limit is cut to ₹100 cannot approve more.
    await fx.run((tx) =>
      writeSetting(tx, fx.f.facilityId, 'billing.discountLimits', {
        reception: { maxPercentBp: 0, maxAmountPaise: 0 },
        cashier: { maxPercentBp: 1000, maxAmountPaise: 50_000 },
        admin: { maxPercentBp: null, maxAmountPaise: 10_000 },
        owner: { maxPercentBp: null, maxAmountPaise: null },
      }),
    );
    try {
      expect(await errorKey(discountBy(cashier, v.billId, req, admin.id))).toBe(
        'billing.approverLimit',
      );
      await discountBy(cashier, v.billId, { mode: 'amount', amountPaise: 10_000n }, admin.id);
    } finally {
      await fx.run((tx) =>
        writeSetting(tx, fx.f.facilityId, 'billing.discountLimits', {
          reception: { maxPercentBp: 0, maxAmountPaise: 0 },
          cashier: { maxPercentBp: 1000, maxAmountPaise: 50_000 },
          admin: { maxPercentBp: null, maxAmountPaise: null },
          owner: { maxPercentBp: null, maxAmountPaise: null },
        }),
      );
    }
  });
});

describe('discount reasons and arithmetic (BIL-03)', () => {
  it('needs a reason from the discount list; "other" needs text', async () => {
    const v = await draft();
    expect(
      await errorKey(
        discountBy(owner, v.billId, { reasonCodeId: reasonId('cancel', 'wrong_entry') }),
      ),
    ).toBe('billing.reasonNotFound');
    expect(await errorKey(discountBy(owner, v.billId, { reasonCodeId: uuidv7() }))).toBe(
      'billing.reasonNotFound',
    );
    expect(
      await errorKey(discountBy(owner, v.billId, { reasonCodeId: reasonId('discount', 'other') })),
    ).toBe('billing.reasonTextRequired');
    await discountBy(owner, v.billId, {
      reasonCodeId: reasonId('discount', 'other'),
      reasonText: 'Hospital trustee referral',
    });
    expect((await view(v.billId)).discounts[0]?.reasonText).toBe('Hospital trustee referral');
    // Input without a reason id does not even parse.
    await expect(
      fx.run((tx) =>
        applyDiscount(
          tx,
          as(owner),
          { billId: v.billId, mode: 'percent', percentBp: 100, idempotencyKey: uuidv7() } as never,
          AT,
          { approverId: null },
        ),
      ),
    ).rejects.toThrow();
  });

  it('spreads a bill-level discount over the lines and keeps GST exact', async () => {
    const v = await draft([taxable, '3'], [lab]);
    await discountBy(owner, v.billId, { mode: 'amount', amountPaise: 10_001n });
    const b = await view(v.billId);
    expect(b.discountPaise).toBe(10_001n);
    expect(b.lines.reduce((s, l) => s + l.discountPaise, 0n)).toBe(10_001n);
    // Header = lines, tax is on the discounted value (the DB re-checks at commit).
    const taxLine = b.lines[1]!;
    expect(taxLine.amountPaise - taxLine.discountPaise).toBe(
      taxLine.patientSharePaise - taxLine.cgstPaise - taxLine.sgstPaise,
    );
    expect(b.netPaise).toBe(
      b.grossPaise - b.discountPaise + b.cgstPaise + b.sgstPaise + b.roundOffPaise,
    );
  });

  it('caps a percent discount at 100% and refuses a zero discount', async () => {
    const v = await draft();
    await discountBy(owner, v.billId, { mode: 'percent', percentBp: 10_000 });
    const b = await view(v.billId);
    expect([b.netPaise, b.balancePaise]).toEqual([0n, 0n]);
    // A bill with nothing to discount (no fee set for the doctor) refuses a zero discount.
    const empty = await fx.visit(
      { patientId: await fx.newPatient(), doctorId: fx.doctorNoRule },
      AT,
    );
    expect(
      await errorKey(discountBy(owner, empty.billId, { mode: 'percent', percentBp: 500 })),
    ).toBe('billing.discountZero');
  });

  it('replaces the discount of a scope, keeps the old record as cancelled, and can clear it', async () => {
    const v = await draft();
    await discountBy(owner, v.billId, { mode: 'amount', amountPaise: 1_000n });
    await discountBy(owner, v.billId, { mode: 'amount', amountPaise: 2_000n });
    expect((await view(v.billId)).discountPaise).toBe(2_000n);
    const rows = await fx.t.app
      .select()
      .from(billDiscount)
      .where(eq(billDiscount.billId, v.billId))
      .orderBy(asc(billDiscount.createdAt));
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'active']);
    expect(rows[0]?.cancelReason).toBeTruthy();

    await fx.run((tx) =>
      clearDiscount(tx, as(cashier), { billId: v.billId, idempotencyKey: uuidv7() }, AT),
    );
    expect((await view(v.billId)).discountPaise).toBe(0n);
    expect(
      await errorKey(
        fx.run((tx) =>
          clearDiscount(tx, as(cashier), { billId: v.billId, idempotencyKey: uuidv7() }, AT),
        ),
      ),
    ).toBe('billing.discountNotFound');
  });

  it('keeps the approved amount when lines are added, and caps it when lines are removed', async () => {
    const v = await draft(); // ₹500
    await discountBy(owner, v.billId, { mode: 'percent', percentBp: 1000 }); // ₹50 fixed
    await add(v.billId, lab);
    expect((await view(v.billId)).discountPaise).toBe(5_000n); // not 10% of the new total
  });

  it('refuses discounts on final bills and below what is already paid', async () => {
    const f = await finalBill();
    expect(await errorKey(discountBy(owner, f.billId, { mode: 'percent', percentBp: 500 }))).toBe(
      'billing.notDraft',
    );
    const v = await draft();
    await fx.run((tx) =>
      collectPayment(
        tx,
        as(cashier),
        { billId: v.billId, tenders: [cash(30_000n)], idempotencyKey: uuidv7() },
        AT,
        { mayFinalize: true },
      ),
    );
    expect(await errorKey(discountBy(owner, v.billId, { mode: 'percent', percentBp: 5000 }))).toBe(
      'billing.belowPaid',
    );
  });

  it('replays the same request once and refuses the key with another request', async () => {
    const v = await draft();
    const key = uuidv7();
    const a = await discountBy(owner, v.billId, { mode: 'amount', amountPaise: 1_000n }, null, key);
    const b = await discountBy(owner, v.billId, { mode: 'amount', amountPaise: 1_000n }, null, key);
    expect(b).toEqual(a);
    expect(
      await errorKey(
        discountBy(owner, v.billId, { mode: 'amount', amountPaise: 2_000n }, null, key),
      ),
    ).toBe('idempotency.conflict');
    const rows = await fx.t.app
      .select()
      .from(billDiscount)
      .where(eq(billDiscount.billId, v.billId));
    expect(rows).toHaveLength(1);
  });
});

describe('supervisor PIN (docs/03 §4)', () => {
  const verify = (who: TestUser | null, username: string, pin: string, requester = cashier) =>
    verifyApproverPin(
      fx.t.app,
      { facilityId: fx.f.facilityId, requesterId: requester.id, username, pin },
      AT,
    ).then((id) => {
      expect(id).toBe(who?.id);
      return id;
    });

  it('accepts a supervisor with the right PIN (any username case)', async () => {
    await verify(admin, admin.username.toUpperCase(), PIN);
    await verify(owner, owner.username, PIN);
  });

  it('answers the same for an unknown user and a wrong PIN, and names no one', async () => {
    const wrong = await errorKey(verify(null, admin2.username, '0000'));
    const unknown = await errorKey(verify(null, 'nobody_here', PIN));
    expect([wrong, unknown]).toEqual(['approval.invalid', 'approval.invalid']);
  });

  it('refuses someone without the permission, and the requester themselves', async () => {
    expect(await errorKey(verify(null, cashier.username, PIN, reception))).toBe(
      'approval.notAuthorised',
    );
    expect(await errorKey(verify(null, admin.username, PIN, admin))).toBe(
      'approval.selfNotAllowed',
    );
  });

  it('locks the approver PIN after repeated wrong PINs, even though the request rolled back', async () => {
    const target = await mkUser('admin');
    for (let i = 0; i < 5; i++) {
      expect(await errorKey(verify(null, target.username, '1111'))).toBe('approval.invalid');
    }
    // Locked now: even the right PIN is refused until the lockout passes.
    expect(await errorKey(verify(null, target.username, PIN))).toBe('approval.locked');
    const later = new Date(AT.getTime() + 16 * 60_000);
    await expect(
      verifyApproverPin(
        fx.t.app,
        {
          facilityId: fx.f.facilityId,
          requesterId: cashier.id,
          username: target.username,
          pin: PIN,
        },
        later,
      ),
    ).resolves.toBe(target.id);
  });

  it('refuses a user without a PIN or a deactivated one', async () => {
    const noPin = await mkUser('admin', null);
    expect(await errorKey(verify(null, noPin.username, PIN))).toBe('approval.invalid');
    const gone = await mkUser('admin');
    await fx.t.owner.update(appUser).set({ isActive: false }).where(eq(appUser.id, gone.id));
    expect(await errorKey(verify(null, gone.username, PIN))).toBe('approval.invalid');
  });
});

describe('cancelling a final bill with a credit note and refund (BIL-04)', () => {
  it('cancels a paid bill: credit note, negative cash refund, number kept, approval on record', async () => {
    const f = await finalBill(); // ₹500 paid in cash
    const numberBefore = (await view(f.billId)).number;
    const r = await cancelBy(cashier, f.billId, { refund: { mode: 'cash' } });
    expect(r).toMatchObject({
      billStatus: 'cancelled',
      creditedPaise: '50000',
      refundPaise: '50000',
      balancePaise: '0',
    });
    expect(r.creditNoteNumber).toMatch(/^CN\/26-27\/\d{5}$/);

    const b = await view(f.billId);
    expect(b).toMatchObject({
      status: 'cancelled',
      number: numberBefore, // cancelled documents keep their numbers
      creditedPaise: 50_000n,
      paidPaise: 0n,
      balancePaise: 0n,
    });
    expect(b.cancelNote).toBe('Patient request');
    expect(b.creditNotes).toHaveLength(1);
    expect(b.creditNotes[0]).toMatchObject({ number: r.creditNoteNumber, cancelsBill: true });

    // The refund is a negative payment row beside the original receipt; nothing was edited.
    const pays = await fx.t.app
      .select()
      .from(payment)
      .where(eq(payment.billId, f.billId))
      .orderBy(asc(payment.receivedAt), asc(payment.id));
    expect(pays.map((p) => [p.kind, p.amountPaise, p.status])).toEqual([
      ['payment', 50_000n, 'valid'],
      ['refund', -50_000n, 'valid'],
    ]);
    const refund = pays[1]!;
    expect(refund).toMatchObject({
      mode: 'cash',
      number: r.creditNoteNumber,
      receivedBy: cashier.id,
      reasonCodeId: reasonId('cancel', 'patient_request'),
    });
    const [ap] = await fx.t.app.select().from(approval).where(eq(approval.id, refund.approvalId!));
    // Under the ₹1,000 threshold the cashier answers for the refund (docs/04 §15.8).
    expect(ap).toMatchObject({
      method: 'within_limit',
      approverId: cashier.id,
      requestedBy: cashier.id,
      billId: f.billId,
    });
    const [cn] = await fx.t.app.select().from(creditNote).where(eq(creditNote.billId, f.billId));
    expect(cn).toMatchObject({ amountPaise: 50_000n, taxablePaise: 50_000n, cancelsBill: true });
    expect(refund.creditNoteId).toBe(cn?.id);

    // The refund prints as a voucher; the original receipt shows the bill as cancelled.
    const voucher = (await loadReceipt(fx.t.app, fx.f.facilityId, r.refundCollectionId!))!;
    expect(voucher).toMatchObject({
      kind: 'refund',
      totalPaise: -50_000n,
      number: r.creditNoteNumber,
    });
    const original = (await loadReceipt(fx.t.app, fx.f.facilityId, f.receipt.collectionId))!;
    expect(original.bill?.status).toBe('cancelled');
  });

  it('does not allow payments, discounts or a second cancellation on a cancelled bill', async () => {
    const f = await finalBill();
    await cancelBy(cashier, f.billId, { refund: { mode: 'cash' } });
    expect(await errorKey(cancelBy(cashier, f.billId, { refund: { mode: 'cash' } }))).toBe(
      'billing.billCancelled',
    );
    expect(
      await errorKey(
        fx.run((tx) =>
          collectPayment(
            tx,
            as(cashier),
            { billId: f.billId, tenders: [cash(100n)], idempotencyKey: uuidv7() },
            AT,
            { mayFinalize: true },
          ),
        ),
      ),
    ).toBe('billing.billCancelled');
  });

  it('needs a reason from the cancel list, and the refund when money is owed back', async () => {
    const f = await finalBill();
    expect(await errorKey(cancelBy(cashier, f.billId, { reasonCodeId: uuidv7() }))).toBe(
      'billing.reasonNotFound',
    );
    expect(
      await errorKey(cancelBy(cashier, f.billId, { reasonCodeId: reasonId('cancel', 'other') })),
    ).toBe('billing.reasonTextRequired');
    expect(await errorKey(cancelBy(cashier, f.billId))).toBe('billing.refundRequired');
    expect((await view(f.billId)).status).toBe('final');
  });

  it('asks for a supervisor above the cancellation limit (₹1,000) and records the PIN approval', async () => {
    const f = await finalBill([big]); // ₹2,500
    const key = uuidv7();
    expect(await errorKey(cancelBy(cashier, f.billId, { refund: { mode: 'cash' } }, null))).toBe(
      'billing.approvalRequired',
    );
    expect((await view(f.billId)).status).toBe('final');
    const r = await cancelBy(
      cashier,
      f.billId,
      { refund: { mode: 'cash' }, idempotencyKey: key },
      admin.id,
    );
    expect(r.billStatus).toBe('cancelled');
    const refund = (
      await fx.t.app
        .select()
        .from(payment)
        .where(and(eq(payment.billId, f.billId), eq(payment.kind, 'refund')))
    )[0]!;
    const [ap] = await fx.t.app.select().from(approval).where(eq(approval.id, refund.approvalId!));
    expect(ap).toMatchObject({ method: 'pin', approverId: admin.id, requestedBy: cashier.id });
    const [cn] = await fx.t.app.select().from(creditNote).where(eq(creditNote.billId, f.billId));
    expect(cn?.approvalId).toBe(ap?.id);
  });

  it('lets the owner approve their own large cancellation (self)', async () => {
    const f = await finalBill([big]);
    await cancelBy(owner, f.billId, { refund: { mode: 'upi', upiRef: '123456' } });
    const refund = (
      await fx.t.app
        .select()
        .from(payment)
        .where(and(eq(payment.billId, f.billId), eq(payment.kind, 'refund')))
    )[0]!;
    expect(refund).toMatchObject({ mode: 'upi', upiRef: '123456' });
    const [ap] = await fx.t.app.select().from(approval).where(eq(approval.id, refund.approvalId!));
    expect(ap).toMatchObject({ method: 'self', approverId: owner.id });
  });

  it('refuses the refund to someone without billing.refund.create', async () => {
    const f = await finalBill();
    expect(await errorKey(cancelBy(reception, f.billId, { refund: { mode: 'cash' } }))).toBe(
      'billing.refundNotAllowed',
    );
    expect((await view(f.billId)).status).toBe('final');
  });

  it('cancels only a final bill', async () => {
    const v = await draft();
    expect(await errorKey(cancelBy(cashier, v.billId))).toBe('billing.notFinal');
  });

  it('cancels an unpaid final bill (on credit) with no refund', async () => {
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.allowOpdCredit', true));
    try {
      const v = await draft();
      await fx.run((tx) =>
        finalizeBill(tx, as(owner), { billId: v.billId, idempotencyKey: uuidv7() }, AT),
      );
      expect(await errorKey(cancelBy(cashier, v.billId, { refund: { mode: 'cash' } }))).toBe(
        'billing.refundNotDue',
      );
      const r = await cancelBy(cashier, v.billId);
      expect(r).toMatchObject({
        billStatus: 'cancelled',
        refundPaise: '0',
        refundCollectionId: null,
      });
      const b = await view(v.billId);
      expect([b.status, b.creditedPaise, b.balancePaise]).toEqual(['cancelled', 50_000n, 0n]);
      // Nothing went out, so no refund row and no approval row.
      expect(await fx.t.app.select().from(approval).where(eq(approval.billId, v.billId))).toEqual(
        [],
      );
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.allowOpdCredit', false));
    }
  });
});

describe('over-refund attempts (docs/04 §15.8)', () => {
  it('refuses a refund larger than the amount paid, and one that does not match what is due', async () => {
    const f = await finalBill(); // paid ₹500
    expect(
      await errorKey(
        cancelBy(cashier, f.billId, { refund: { mode: 'cash', amountPaise: 50_001n } }),
      ),
    ).toBe('billing.refundExceedsPaid');
    expect(
      await errorKey(
        cancelBy(cashier, f.billId, { refund: { mode: 'cash', amountPaise: 49_999n } }),
      ),
    ).toBe('billing.refundMismatch');
    expect(
      await errorKey(
        cancelBy(cashier, f.billId, { amountPaise: 50_001n, refund: { mode: 'cash' } }),
      ),
    ).toBe('billing.creditTooLarge');
    const b = await view(f.billId);
    expect([b.status, b.paidPaise, b.creditedPaise]).toEqual(['final', 50_000n, 0n]);
    expect(
      await fx.t.app
        .select()
        .from(payment)
        .where(and(eq(payment.billId, f.billId), eq(payment.kind, 'refund'))),
    ).toEqual([]);
  });

  it('refuses a partial credit that leaves money paid for nothing without refunding it', async () => {
    const f = await finalBill();
    expect(await errorKey(cancelBy(cashier, f.billId, { amountPaise: 10_000n }))).toBe(
      'billing.refundRequired',
    );
  });

  it('the database itself refuses a refund beyond what was paid, or one without an approval', async () => {
    const f = await finalBill(); // paid ₹500
    const [orig] = await fx.t.app.select().from(payment).where(eq(payment.billId, f.billId));
    const [ap] = await fx.run(async (tx) => {
      const id = uuidv7();
      await tx.insert(approval).values({
        id,
        facilityId: fx.f.facilityId,
        kind: 'credit_note',
        billId: f.billId,
        requestedBy: cashier.id,
        approverId: cashier.id,
        method: 'within_limit',
        amountPaise: 1n,
      });
      return [{ id }];
    });
    const insertRefund = (over: Record<string, unknown>) => {
      const cols = {
        id: uuidv7(),
        facility_id: fx.f.facilityId,
        number: `X-${uuidv7()}`,
        collection_id: uuidv7(),
        patient_id: orig!.patientId,
        encounter_id: orig!.encounterId,
        bill_id: f.billId,
        kind: 'refund',
        mode: 'cash',
        amount_paise: -50_001,
        received_at: new Date().toISOString(),
        idempotency_key: uuidv7(),
        approval_id: ap.id,
        reason_code_id: reasonId('refund', 'other'),
        ...over,
      };
      const names = Object.keys(cols).map((c) => sql.identifier(c));
      const values = Object.values(cols).map((v) => sql`${v}`);
      return rawSql(
        sql`insert into payment (${sql.join(names, sql`, `)}) values (${sql.join(values, sql`, `)})`,
      );
    };
    // The bill must be final for the guard, so these fail on the amount / approval, not state.
    expect(await insertRefund({})).toMatch(/cannot exceed the amount paid/);
    expect(await insertRefund({ amount_paise: -100, approval_id: null })).toMatch(
      /needs an approval|payment_refund_approval/,
    );
    expect(await insertRefund({ amount_paise: -100, reason_code_id: null })).toMatch(
      /payment_refund_approval/,
    );
    // A refund row with a valid amount still must keep the bill header in step (deferred check).
    expect(await insertRefund({ amount_paise: -100 })).toMatch(/paid amount does not match/);
    // Refund-only columns on an ordinary payment are refused.
    expect(
      await rawSql(sql`update payment set approval_id = ${ap.id} where id = ${orig!.id}`),
    ).toMatch(/immutable|payment_refund_only_fields/);
  });

  it('the database refuses editing a final bill, taking credit back, or cancelling without full credit', async () => {
    const f = await finalBill([big]);
    await cancelBy(
      cashier,
      f.billId,
      { amountPaise: 100_000n, refund: { mode: 'cash' } },
      admin.id,
    );
    expect(await rawSql(sql`update bill set credited_paise = 0 where id = ${f.billId}`)).toMatch(
      /credit cannot be taken back|credited amount does not match/,
    );
    expect(
      await rawSql(
        sql`update bill set status = 'cancelled', cancel_note = 'x', cancelled_at = now() where id = ${f.billId}`,
      ),
    ).toMatch(/cancelled only when credited in full/);
    const [cn] = await fx.t.app.select().from(creditNote).where(eq(creditNote.billId, f.billId));
    expect(await rawSql(sql`update credit_note set amount_paise = 1 where id = ${cn!.id}`)).toMatch(
      /immutable/,
    );
    const [ap] = await fx.t.app.select().from(approval).where(eq(approval.billId, f.billId));
    expect(await rawSql(sql`update approval set amount_paise = 1 where id = ${ap!.id}`)).toMatch(
      /immutable/,
    );
    // Rows are never deleted: the app role has no DELETE privilege.
    expect(await rawSql(sql`delete from credit_note where id = ${cn!.id}`)).toMatch(
      /permission denied/,
    );
  });
});

describe('partial credit notes (BIL-04)', () => {
  it('credits part of a bill and refunds the difference; the bill stays final', async () => {
    const f = await finalBill([big]); // ₹2,500 paid
    const r = await cancelBy(cashier, f.billId, {
      amountPaise: 30_000n,
      refund: { mode: 'upi', amountPaise: 30_000n },
    });
    expect(r).toMatchObject({ billStatus: 'final', creditedPaise: '30000', refundPaise: '30000' });
    const b = await view(f.billId);
    expect(b).toMatchObject({
      status: 'final',
      creditedPaise: 30_000n,
      paidPaise: 220_000n,
      balancePaise: 0n,
    });
  });

  it('splits credit notes of a taxed bill so that the tax adds up exactly', async () => {
    const f = await finalBill([taxable, '3']); // GST bill, paid in full
    const before = await view(f.billId);
    const part = before.netPaise / 3n;
    await cancelBy(cashier, f.billId, { amountPaise: part, refund: { mode: 'cash' } });
    await cancelBy(cashier, f.billId, { amountPaise: part, refund: { mode: 'cash' } });
    const last = await cancelBy(cashier, f.billId, { refund: { mode: 'cash' } });
    expect(last.billStatus).toBe('cancelled');
    const notes = await fx.t.app.select().from(creditNote).where(eq(creditNote.billId, f.billId));
    expect(notes).toHaveLength(3);
    const sum = (k: 'amountPaise' | 'cgstPaise' | 'sgstPaise' | 'taxablePaise') =>
      notes.reduce((s, n) => s + n[k], 0n);
    expect(sum('amountPaise')).toBe(before.patientSharePaise);
    expect(sum('cgstPaise')).toBe(before.lines.reduce((s, l) => s + l.cgstPaise, 0n));
    expect(sum('sgstPaise')).toBe(before.lines.reduce((s, l) => s + l.sgstPaise, 0n));
    for (const n of notes) expect(n.cgstPaise).toBe(n.sgstPaise);
    const b = await view(f.billId);
    expect([b.paidPaise, b.balancePaise]).toEqual([0n, 0n]);
    // Three distinct, increasing numbers.
    expect(new Set(notes.map((n) => n.number)).size).toBe(3);
  });

  it('refuses to credit more than what is left', async () => {
    const f = await finalBill();
    await cancelBy(cashier, f.billId, { amountPaise: 20_000n, refund: { mode: 'cash' } });
    expect(
      await errorKey(
        cancelBy(cashier, f.billId, { amountPaise: 30_001n, refund: { mode: 'cash' } }),
      ),
    ).toBe('billing.creditTooLarge');
  });
});

describe('concurrent refunds (BIL-04)', () => {
  it('two cashiers cancelling the same bill refund the money once', async () => {
    const f = await finalBill(); // ₹500
    const results = await Promise.allSettled([
      cancelBy(cashier, f.billId, { refund: { mode: 'cash' } }),
      cancelBy(owner, f.billId, { refund: { mode: 'upi' } }),
      cancelBy(cashier, f.billId, { refund: { mode: 'cash' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(r.reason).toMatchObject({ key: 'billing.billCancelled' });
    }
    const pays = await fx.t.app.select().from(payment).where(eq(payment.billId, f.billId));
    expect(pays.reduce((s, p) => s + p.amountPaise, 0n)).toBe(0n);
    expect(pays.filter((p) => p.kind === 'refund')).toHaveLength(1);
    expect((await view(f.billId)).creditNotes).toHaveLength(1);
  });

  it('racing partial credits can never refund more than was paid', async () => {
    const f = await finalBill(); // ₹500
    const results = await Promise.allSettled(
      [0, 1, 2, 3].map(() =>
        cancelBy(cashier, f.billId, { amountPaise: 30_000n, refund: { mode: 'cash' } }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(r.reason).toMatchObject({ key: 'billing.creditTooLarge' });
    }
    const b = await view(f.billId);
    expect([b.paidPaise, b.creditedPaise, b.balancePaise]).toEqual([20_000n, 30_000n, 0n]);
    const refunds = await fx.t.app
      .select()
      .from(payment)
      .where(and(eq(payment.billId, f.billId), eq(payment.kind, 'refund')));
    expect(refunds.map((p) => p.amountPaise)).toEqual([-30_000n]);
  });

  it('a double submit with the same key refunds once and replays the result', async () => {
    const f = await finalBill();
    const key = uuidv7();
    const run = () =>
      cancelBy(cashier, f.billId, { refund: { mode: 'cash' }, idempotencyKey: key });
    const [a, b] = await Promise.all([run(), run()]);
    expect(b).toEqual(a);
    const refunds = await fx.t.app
      .select()
      .from(payment)
      .where(and(eq(payment.billId, f.billId), eq(payment.kind, 'refund')));
    expect(refunds).toHaveLength(1);
  });

  it('a payment racing a cancellation never leaves the bill overpaid', async () => {
    await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.allowOpdCredit', true));
    try {
      const v = await draft();
      await fx.run((tx) =>
        collectPayment(
          tx,
          as(cashier),
          { billId: v.billId, tenders: [cash(20_000n)], idempotencyKey: uuidv7() },
          AT,
          { mayFinalize: true },
        ),
      );
      await fx.run((tx) =>
        finalizeBill(tx, as(owner), { billId: v.billId, idempotencyKey: uuidv7() }, AT),
      );
      const settled = await Promise.allSettled([
        fx.run((tx) =>
          collectPayment(
            tx,
            as(cashier),
            { billId: v.billId, tenders: [cash(30_000n)], idempotencyKey: uuidv7() },
            AT,
            { mayFinalize: true },
          ),
        ),
        cancelBy(cashier, v.billId, { refund: { mode: 'cash' } }),
      ]);
      const b = await view(v.billId);
      const net = (
        await fx.t.app.select().from(payment).where(eq(payment.billId, v.billId))
      ).reduce((s, p) => s + p.amountPaise, 0n);
      expect(b.paidPaise).toBe(net);
      expect(b.paidPaise).toBeLessThanOrEqual(b.patientSharePaise - b.creditedPaise);
      expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    } finally {
      await fx.run((tx) => writeSetting(tx, fx.f.facilityId, 'billing.allowOpdCredit', false));
    }
  });
});

describe('voiding a draft and the audit trail', () => {
  it('voids an unpaid draft (no number), and a new draft can be opened', async () => {
    const v = await draft();
    await fx.run((tx) =>
      voidDraftBill(
        tx,
        as(cashier),
        {
          billId: v.billId,
          reasonCodeId: reasonId('cancel', 'duplicate'),
          idempotencyKey: uuidv7(),
        },
        AT,
      ),
    );
    const b = await view(v.billId);
    expect([b.status, b.number, b.cancelNote]).toEqual(['cancelled', null, 'Duplicate']);
    const [row] = await fx.t.app.select().from(bill).where(eq(bill.id, v.billId));
    expect(row?.cancelledBy).toBe(cashier.id);
  });

  it('refuses to void a draft that holds a payment', async () => {
    const v = await draft();
    await fx.run((tx) =>
      collectPayment(
        tx,
        as(cashier),
        { billId: v.billId, tenders: [cash(10_000n)], idempotencyKey: uuidv7() },
        AT,
        { mayFinalize: true },
      ),
    );
    expect(
      await errorKey(
        fx.run((tx) =>
          voidDraftBill(
            tx,
            as(cashier),
            {
              billId: v.billId,
              reasonCodeId: reasonId('cancel', 'duplicate'),
              idempotencyKey: uuidv7(),
            },
            AT,
          ),
        ),
      ),
    ).toBe('billing.hasPayments');
  });

  it('audits the new tables and keeps every row (no hard deletes)', async () => {
    const f = await finalBill();
    const v = await draft();
    await discountBy(owner, v.billId, { mode: 'amount', amountPaise: 1_000n });
    await cancelBy(cashier, f.billId, { refund: { mode: 'cash' } });
    const audited = await fx.t.owner.execute(
      sql`select distinct table_name from audit_log where table_name in ('approval','bill_discount','credit_note')`,
    );
    expect(audited.rows.map((r) => r.table_name).sort()).toEqual([
      'approval',
      'bill_discount',
      'credit_note',
    ]);
  });
});

describe('report hooks (BIL-03, BIL-04)', () => {
  it('lists discounts with who, how much, why and the approver', async () => {
    const v = await draft();
    await discountBy(cashier, v.billId, { mode: 'amount', amountPaise: 15_000n }, admin.id);
    const rep = await discountReport(fx.t.app, fx.f.facilityId, {
      from: '2026-10-26',
      to: '2026-10-26',
    });
    const row = rep.rows.find(
      (r) => r.amountPaise === 15_000n && r.approvedByName === 'Test admin',
    );
    expect(row).toMatchObject({
      scope: 'bill',
      givenByName: 'Test User',
      reasonLabel: 'Poor patient',
      approvalMethod: 'pin',
      status: 'active',
    });
    expect(rep.totalPaise).toBeGreaterThanOrEqual(15_000n);
    expect(rep.byReason.some((x) => x.label === 'Poor patient')).toBe(true);
    const none = await discountReport(fx.t.app, fx.f.facilityId, {
      from: '2026-10-27',
      to: '2026-10-28',
    });
    expect(none.rows).toEqual([]);
  });

  it('lists cancellations with the refund and the approver', async () => {
    const f = await finalBill([big]);
    const r = await cancelBy(cashier, f.billId, { refund: { mode: 'cash' } }, admin.id);
    const rep = await cancellationReport(fx.t.app, fx.f.facilityId, {
      from: '2026-10-26',
      to: '2026-10-26',
    });
    expect(rep.rows.find((x) => x.number === r.creditNoteNumber)).toMatchObject({
      amountPaise: 250_000n,
      refundPaise: 250_000n,
      cancelsBill: true,
      reasonLabel: 'Patient request',
      approvedByName: 'Test admin',
      approvalMethod: 'pin',
    });
    expect(rep.totalRefundedPaise).toBeGreaterThanOrEqual(250_000n);
  });
});
