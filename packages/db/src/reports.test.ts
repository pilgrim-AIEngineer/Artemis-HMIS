/**
 * RPT-01 / RPT-02 integration tests against a real Postgres. The point of the file is
 * reconciliation (docs/12 §9, docs/20): every report total must equal what the bills and the
 * payment rows say, however it is sliced (by day, user, mode, doctor, department, receipt).
 * Synthetic data only.
 */
import {
  createPregnancySchema,
  istDateString,
  recordDoseSchema,
  saveAncVisitSchema,
  type RoleKey,
  type TenderInput,
} from '@hmis/shared';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { appUser, bill, encounter, patient, payment, pregnancy, reasonCode } from '../schema';
import { IST, setupOpdFixture, type OpdFixture } from '../testing/opd';
import { createPregnancy, saveAncVisit } from './anc';
import { collectPayment } from './billing';
import {
  applyDiscount,
  cancelFinalBill,
  cancellationReport,
  discountReport,
} from './billing-adjustments';
import { closeOwnDay } from './day-close';
import { recordDose } from './paeds';
import { ensureFacilityRbac, grantRoles } from './rbac';
import { cancelVisit } from './queue';
import {
  ancRegister,
  collectionReport,
  opdCensus,
  ownerDashboard,
  RECEIPT_LIST_LIMIT,
  vaccinesDue,
} from './reports';
import { withTx, type Tx } from './tx';

let fx: OpdFixture;
const NOW = IST('2026-10-26T10:00:00');
const TODAY = '2026-10-26';

beforeAll(async () => {
  fx = await setupOpdFixture(inject('testPgAdminUrl'));
  await withTx({ db: fx.t.owner, userId: null }, (tx) => ensureFacilityRbac(tx, fx.f.facilityId));
});
afterAll(async () => {
  await fx.t.close();
});

const cash = (amountPaise: number): TenderInput => ({ mode: 'cash', amountPaise });
const upi = (amountPaise: number): TenderInput => ({ mode: 'upi', amountPaise, upiRef: '123456' });
const card = (amountPaise: number): TenderInput => ({
  mode: 'card',
  amountPaise,
  cardLast4: '4242',
});

async function mkUser(name: string, role: RoleKey = 'cashier') {
  const id = uuidv7();
  await fx.t.owner.insert(appUser).values({
    id,
    facilityId: fx.f.facilityId,
    username: `${name.split(' ')[0]!.toLowerCase()}_${randomBytes(3).toString('hex')}`,
    fullName: name,
  });
  await withTx({ db: fx.t.owner, userId: null }, (tx) =>
    grantRoles(tx, fx.f.facilityId, id, [role]),
  );
  return id;
}

const as = (userId: string) => ({
  facilityId: fx.f.facilityId,
  userId,
  workstationId: fx.f.workstationId,
});

/** One visit billed at the doctor's fee and paid in full with `tenders`. */
async function paidVisit(
  userId: string,
  tenders: (total: bigint) => TenderInput[],
  at: Date,
  over: { doctorId?: string; visitType?: 'new' | 'follow_up' } = {},
) {
  const v = await fx.visit(
    { patientId: await fx.newPatient(), ...(over.doctorId ? { doctorId: over.doctorId } : {}) },
    at,
  );
  const [b] = await fx.t.owner.select().from(bill).where(eq(bill.id, v.billId));
  const r = await fx.run((tx) =>
    collectPayment(
      tx,
      as(userId),
      { billId: v.billId, tenders: tenders(b!.patientSharePaise), idempotencyKey: uuidv7() },
      at,
      { mayFinalize: true },
    ),
  );
  return { ...v, ...r };
}

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** What the payment rows themselves say for a business-day range (independent of the report code). */
async function rawNet(from: string, to: string): Promise<bigint> {
  const {
    rows: [r],
  } = await fx.t.owner.execute<{ s: string }>(sql`
    select coalesce(sum(amount_paise), 0)::text as s from payment
    where facility_id = ${fx.f.facilityId} and status = 'valid' and kind <> 'deposit_adjustment'
      and business_date between ${from} and ${to}`);
  return BigInt(r!.s);
}

describe('daily collection reconciles with bills and payments (RPT-01)', () => {
  const D1 = IST('2026-09-01T10:00:00');
  const D2 = IST('2026-09-02T11:30:00');
  let ria: string;
  let sunil: string;
  let revenue: Awaited<ReturnType<typeof collectionReport>>;

  beforeAll(async () => {
    ria = await mkUser('Ria Cashier');
    sunil = await mkUser('Sunil Cashier');
    await paidVisit(ria, (t) => [cash(Number(t))], D1);
    await paidVisit(ria, (t) => [upi(Number(t) / 2), cash(Number(t) / 2)], D1);
    await paidVisit(sunil, (t) => [card(Number(t))], D1, { doctorId: fx.doctorB });
    await paidVisit(sunil, (t) => [upi(Number(t))], D2, { doctorId: fx.doctorB });
    // A paid bill is cancelled the same day: the refund is negative money, in cash.
    const cancelled = await paidVisit(ria, (t) => [cash(Number(t))], D2);
    const reason = (
      await fx.t.owner.select().from(reasonCode).where(eq(reasonCode.facilityId, fx.f.facilityId))
    ).find((r) => r.kind === 'cancel' && r.code === 'patient_request')!;
    await fx.run((tx) =>
      cancelFinalBill(
        tx,
        as(ria),
        {
          billId: cancelled.billId,
          reasonCodeId: reason.id,
          idempotencyKey: uuidv7(),
          refund: { mode: 'cash' },
        },
        D2,
        { approverId: null },
      ),
    );
    revenue = await collectionReport(fx.t.app, fx.f.facilityId, {
      from: '2026-09-01',
      to: '2026-09-02',
    });
  });

  it('the total equals the sum of the payment rows, and every slicing adds up to it', async () => {
    const raw = await rawNet('2026-09-01', '2026-09-02');
    expect(raw).toBeGreaterThan(0n);
    expect(revenue.total.netPaise).toBe(raw);
    for (const slice of [revenue.byDay, revenue.byUser, revenue.byDoctor, revenue.byDepartment]) {
      expect(sum(slice.map((r) => r.netPaise))).toBe(raw);
      expect(slice.reduce((n, r) => n + r.count, 0)).toBe(revenue.total.count);
    }
    expect(sum(revenue.receipts.map((r) => r.amountPaise))).toBe(raw);
    expect(revenue.receipts).toHaveLength(revenue.total.count);
    expect(revenue.truncated).toBe(false);
  });

  it('the modes add up to the net, and collected − refunded = net', () => {
    const t = revenue.total;
    expect(t.cashPaise + t.upiPaise + t.cardPaise + t.otherPaise).toBe(t.netPaise);
    expect(t.collectedPaise - t.refundedPaise).toBe(t.netPaise);
    expect(t.refundedPaise).toBeGreaterThan(0n);
    expect(t.cardPaise).toBeGreaterThan(0n);
    for (const r of [...revenue.byDay, ...revenue.byUser]) {
      expect(r.cashPaise + r.upiPaise + r.cardPaise + r.otherPaise).toBe(r.netPaise);
      expect(r.collectedPaise - r.refundedPaise).toBe(r.netPaise);
    }
  });

  it('equals what the bills say was paid (bill.paid_paise already nets refunds)', async () => {
    const {
      rows: [r],
    } = await fx.t.owner.execute<{ s: string }>(sql`
      select coalesce(sum(b.paid_paise), 0)::text as s from bill b
      where b.facility_id = ${fx.f.facilityId} and exists (
        select 1 from payment p where p.bill_id = b.id
          and p.business_date between '2026-09-01' and '2026-09-02')`);
    expect(revenue.total.netPaise).toBe(BigInt(r!.s));
  });

  it('splits by user and by day', () => {
    const byName = Object.fromEntries(revenue.byUser.map((u) => [u.label, u]));
    expect(byName['Sunil Cashier']!.cardPaise).toBeGreaterThan(0n);
    expect(byName['Ria Cashier']!.refundedPaise).toBeGreaterThan(0n);
    expect(revenue.byDay.map((d) => d.key)).toEqual(['2026-09-01', '2026-09-02']);
    expect(revenue.byDoctor.length).toBeGreaterThanOrEqual(2);
  });

  it('a single day equals its own slice; an empty range is all zero', async () => {
    const d1 = await collectionReport(fx.t.app, fx.f.facilityId, {
      from: '2026-09-01',
      to: '2026-09-01',
    });
    expect(d1.total.netPaise).toBe(revenue.byDay[0]!.netPaise);
    const none = await collectionReport(fx.t.app, fx.f.facilityId, {
      from: '2020-01-01',
      to: '2020-01-02',
    });
    expect(none.total).toMatchObject({ netPaise: 0n, count: 0 });
    expect(none.receipts).toEqual([]);
  });

  it('leaves out a reversed receipt but reports it', async () => {
    const extra = await paidVisit(ria, (t) => [cash(Number(t))], IST('2026-09-10T10:00:00'));
    const before = await collectionReport(fx.t.app, fx.f.facilityId, {
      from: '2026-09-10',
      to: '2026-09-10',
    });
    expect(before.total.netPaise).toBeGreaterThan(0n);
    await fx.t.owner.execute(sql`alter table payment disable trigger user`);
    try {
      await fx.t.owner
        .update(payment)
        .set({ status: 'reversed' })
        .where(eq(payment.billId, extra.billId));
    } finally {
      await fx.t.owner.execute(sql`alter table payment enable trigger user`);
    }
    const after = await collectionReport(fx.t.app, fx.f.facilityId, {
      from: '2026-09-10',
      to: '2026-09-10',
    });
    expect(after.total.netPaise).toBe(0n);
    expect(after.reversed.count).toBe(before.total.count);
    expect(after.reversed.paise).toBe(before.total.netPaise);
  });

  it('keeps one facility out of another’s report', async () => {
    const other = await collectionReport(fx.t.app, uuidv7(), {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    expect(other.total.netPaise).toBe(0n);
  });

  it('exposes the receipt cap', () => {
    expect(RECEIPT_LIST_LIMIT).toBeGreaterThanOrEqual(1000);
  });
});

describe('OPD census (RPT-01)', () => {
  const DAY = IST('2026-08-03T09:15:00');
  it('counts by doctor and visit type, leaves cancelled visits out, never counts restricted ones', async () => {
    const a1 = await fx.visit({ patientId: await fx.newPatient(), doctorId: fx.doctorA }, DAY);
    await fx.visit({ patientId: await fx.newPatient(), doctorId: fx.doctorA }, DAY);
    await fx.visit(
      { patientId: await fx.newPatient(), doctorId: fx.doctorB },
      IST('2026-08-03T13:40:00'),
    );
    const gone = await fx.visit({ patientId: await fx.newPatient(), doctorId: fx.doctorB }, DAY);
    await fx.run((tx) => cancelVisit(tx, fx.actor(), gone.encounterId, 'Wrong doctor', DAY));
    const hidden = await fx.visit({ patientId: await fx.newPatient(), doctorId: fx.doctorA }, DAY);
    await fx.t.owner
      .update(encounter)
      .set({ isRestricted: true })
      .where(eq(encounter.id, hidden.encounterId));

    const c = await opdCensus(fx.t.app, fx.f.facilityId, { from: '2026-08-03', to: '2026-08-03' });
    expect(c.total).toBe(3);
    expect(c.cancelled).toBe(1);
    expect(sum(c.rows.map((r) => BigInt(r.total)))).toBe(3n);
    expect(Object.values(c.totalsByType).reduce((a, b) => a + b, 0)).toBe(3);
    expect(c.rows.find((r) => r.doctorId === fx.doctorA)!.total).toBe(2);
    expect(c.rows.find((r) => r.doctorId === fx.doctorB)!.total).toBe(1);
    expect(c.byDay).toEqual([{ date: '2026-08-03', count: 3 }]);
    // arrival hours (IST): two at 09:xx, one at 13:xx
    expect(c.byHour).toHaveLength(24);
    expect(c.byHour[9]!.count).toBe(2);
    expect(c.byHour[13]!.count).toBe(1);
    expect(sum(c.byHour.map((h) => BigInt(h.count)))).toBe(3n);
    expect(a1.encounterId).toBeTruthy();

    const onlyB = await opdCensus(fx.t.app, fx.f.facilityId, {
      from: '2026-08-03',
      to: '2026-08-03',
      doctorId: fx.doctorB,
    });
    expect(onlyB.total).toBe(1);
  });

  it('matches the encounter rows for a range', async () => {
    const c = await opdCensus(fx.t.app, fx.f.facilityId, { from: '2026-08-01', to: '2026-12-31' });
    const {
      rows: [r],
    } = await fx.t.owner.execute<{ n: number }>(sql`
      select count(*)::int as n from encounter where facility_id = ${fx.f.facilityId}
        and type = 'opd' and status <> 'cancelled' and not is_restricted
        and visit_date between '2026-08-01' and '2026-12-31'`);
    expect(c.total).toBe(r!.n);
    expect(sum(c.byDay.map((d) => BigInt(d.count)))).toBe(BigInt(c.total));
  });
});

describe('ANC register (RPT-01)', () => {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => fx.run(fn);
  const actor = () => ({
    facilityId: fx.f.facilityId,
    userId: fx.f.userId,
    mtp: { view: false, edit: false },
  });

  async function pregnant(lmp: string, mobile: string, at = NOW) {
    const pid = await fx.newPatient();
    await fx.t.owner.update(patient).set({ dob: '1998-05-05', mobile }).where(eq(patient.id, pid));
    const r = await run((tx) =>
      createPregnancy(
        tx,
        actor(),
        createPregnancySchema.parse({ patientId: pid, idempotencyKey: uuidv7(), lmp }),
        at,
      ),
    );
    return { patientId: pid, pregnancyId: r.pregnancyId };
  }

  it('lists active pregnancies with GA, EDD, phone and next visit; picks out EDDs and missed visits', async () => {
    const far = await pregnant('2026-03-01', '9876500002'); // EDD 2026-12-06: 41 days ahead
    const soon = await pregnant('2026-01-25', '9876500001'); // EDD 2026-11-01: 6 days ahead
    // Booked in September, last seen 20 Sep at 18 weeks: the next visit is long past.
    const missed = await pregnant('2026-05-15', '9876500003', IST('2026-09-01T10:00:00'));
    await run((tx) =>
      saveAncVisit(
        tx,
        actor(),
        saveAncVisitSchema.parse({ pregnancyId: missed.pregnancyId, visitDate: '2026-09-20' }),
        IST('2026-09-20T10:00:00'),
      ),
    );

    const reg = await ancRegister(fx.t.app, fx.f.facilityId, NOW);
    const row = (id: string) => reg.rows.find((r) => r.patientId === id)!;
    expect(row(soon.patientId)).toMatchObject({
      eddFinal: '2026-11-01',
      daysToEdd: 6,
      mobile: '9876500001',
      age: { unit: 'years', value: 28 },
    });
    expect(row(soon.patientId).gaDays).toBeGreaterThan(250);
    expect(reg.eddSoon.map((r) => r.patientId)).toContain(soon.patientId);
    expect(reg.eddSoon.map((r) => r.patientId)).not.toContain(far.patientId);
    const edds = reg.eddSoon.map((r) => r.eddFinal);
    expect([...edds].sort()).toEqual(edds);

    const m = row(missed.patientId);
    expect(m.lastVisit).toBe('2026-09-20');
    expect(m.nextVisitDate).not.toBeNull();
    expect(m.daysLate).toBe(
      Math.round((Date.parse(TODAY) - Date.parse(m.nextVisitDate!)) / 86_400_000),
    );
    expect(m.daysLate).toBeGreaterThan(7);
    expect(reg.overdue.map((r) => r.patientId)).toContain(missed.patientId);
    expect(reg.overdue.every((r) => r.daysLate > 7)).toBe(true);
    expect(reg.overdue.map((r) => r.daysLate)).toEqual(
      [...reg.overdue.map((r) => r.daysLate)].sort((a, b) => b - a),
    );
    expect(reg.highRiskCount).toBe(reg.rows.filter((r) => r.risks.length > 0).length);
  });

  it('narrows to one risk flag', async () => {
    const reg = await ancRegister(fx.t.app, fx.f.facilityId, NOW, { risk: 'no-such-flag' });
    expect(reg.rows).toEqual([]);
    expect(reg.overdue).toEqual([]);
  });

  it('does not list a pregnancy once it is closed', async () => {
    const p = await pregnant('2026-08-01', '9876500004');
    expect(
      (await ancRegister(fx.t.app, fx.f.facilityId, NOW)).rows.map((r) => r.patientId),
    ).toContain(p.patientId);
    await fx.t.owner
      .update(pregnancy)
      .set({ status: 'delivered', outcomeDate: TODAY, closedAt: NOW, closeReason: 'delivered' })
      .where(eq(pregnancy.id, p.pregnancyId));
    expect(
      (await ancRegister(fx.t.app, fx.f.facilityId, NOW)).rows.map((r) => r.patientId),
    ).not.toContain(p.patientId);
  });
});

describe('vaccines due (RPT-01)', () => {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => fx.run(fn);
  async function child(dob: string, mobile: string) {
    const id = await fx.newPatient();
    await fx.t.owner.update(patient).set({ dob, mobile }).where(eq(patient.id, id));
    return id;
  }
  const give = (patientId: string, itemCode: string, givenOn: string) =>
    run((tx) =>
      recordDose(
        tx,
        { facilityId: fx.f.facilityId, userId: fx.f.userId },
        recordDoseSchema.parse({
          idempotencyKey: uuidv7(),
          patientId,
          itemCode,
          vaccineName: itemCode,
          batchNo: 'B-100',
          expiry: '2027-12-31',
          site: 'left_thigh',
          route: 'im',
          givenOn,
        }),
        NOW,
      ),
    );

  it('splits overdue from this week, carries the phone number, and counts each child once', async () => {
    // Birth doses on 2026-09-01 → next dose (6 weeks) fell due 2026-10-13: overdue by 13 days.
    const overdue = await child('2026-09-01', '9812345678');
    for (const c of ['BCG-1', 'OPV-1', 'HEPB-1']) await give(overdue, c, '2026-09-01');
    // Birth doses on 2026-09-20 → due 2026-11-01: 6 days ahead.
    const soon = await child('2026-09-20', '9812345679');
    for (const c of ['BCG-1', 'OPV-1', 'HEPB-1']) await give(soon, c, '2026-09-20');

    const v = await vaccinesDue(fx.t.app, fx.f.facilityId, NOW, { aheadDays: 7 });
    const o = v.overdue.find((r) => r.patientId === overdue)!;
    expect(o).toMatchObject({ mobile: '9812345678', daysFromToday: -13 });
    expect(v.overdue.every((r) => r.daysFromToday < 0)).toBe(true);
    expect(v.thisWeek.find((r) => r.patientId === soon)).toMatchObject({
      mobile: '9812345679',
      daysFromToday: 6,
    });
    expect(v.thisWeek.every((r) => r.daysFromToday >= 0 && r.daysFromToday <= 7)).toBe(true);
    const all = [...v.overdue, ...v.thisWeek].map((r) => r.patientId);
    expect(new Set(all).size).toBe(all.length);
    // Most overdue first.
    for (let i = 1; i < v.overdue.length; i++) {
      expect(v.overdue[i - 1]!.nextDueDate <= v.overdue[i]!.nextDueDate).toBe(true);
    }
    const narrow = await vaccinesDue(fx.t.app, fx.f.facilityId, NOW, { aheadDays: 3 });
    expect(narrow.thisWeek.some((r) => r.patientId === soon)).toBe(false);
  });
});

describe('discounts and cancellations reports reconcile (RPT-01)', () => {
  it('the discount report equals the discount on the bill; cancellations equal the credit notes', async () => {
    const owner = await mkUser('Disc Owner', 'owner');
    const at = IST('2026-07-14T10:00:00');
    const v = await fx.visit({ patientId: await fx.newPatient() }, at);
    const reasons = await fx.t.owner
      .select()
      .from(reasonCode)
      .where(eq(reasonCode.facilityId, fx.f.facilityId));
    await fx.run((tx) =>
      applyDiscount(
        tx,
        as(owner),
        {
          billId: v.billId,
          mode: 'amount',
          amountPaise: 10_000,
          reasonCodeId: reasons.find((r) => r.kind === 'discount')!.id,
          idempotencyKey: uuidv7(),
        },
        at,
        { approverId: null },
      ),
    );
    // The discount row is stamped by the database clock, so ask for the real today.
    const real = istDateString(new Date());
    const d = await discountReport(fx.t.app, fx.f.facilityId, { from: real, to: real });
    const [b] = await fx.t.owner.select().from(bill).where(eq(bill.id, v.billId));
    expect(d.rows).toHaveLength(1);
    expect(b!.discountPaise).toBe(10_000n);
    expect(d.totalPaise).toBe(b!.discountPaise);
    expect(d.byUser).toEqual([{ name: 'Disc Owner', amountPaise: 10_000n }]);

    const cn = await cancellationReport(fx.t.app, fx.f.facilityId, {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    const {
      rows: [rawCn],
    } = await fx.t.owner.execute<{ s: string }>(sql`
      select coalesce(sum(amount_paise), 0)::text as s from credit_note
      where facility_id = ${fx.f.facilityId}
        and issued_at >= '2026-08-31T18:30:00Z' and issued_at < '2026-09-02T18:30:00Z'`);
    expect(cn.rows.length).toBeGreaterThan(0);
    expect(cn.totalCreditedPaise).toBe(BigInt(rawCn!.s));
    expect(cn.rows[0]!.patientName.length).toBeGreaterThan(0);
    // The refund paid out with the credit note is the cash taken back in the collection report.
    const col = await collectionReport(fx.t.app, fx.f.facilityId, {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    expect(cn.totalRefundedPaise).toBe(col.total.refundedPaise);
  });
});

describe('owner dashboard (RPT-02)', () => {
  it('shows today’s figures equal to the reports of the same day, a gap-free trend and the month comparison', async () => {
    const cashier = await mkUser('Dash Cashier');
    const earlier = IST('2026-10-20T10:00:00');
    await paidVisit(cashier, (t) => [cash(Number(t))], earlier);
    await paidVisit(cashier, (t) => [upi(Number(t))], NOW);
    await fx.visit({ patientId: await fx.newPatient(), doctorId: fx.doctorA }, NOW); // waiting, unpaid

    const d = await ownerDashboard(fx.t.app, fx.f.facilityId, IST('2026-10-26T20:00:00'));
    const col = await collectionReport(fx.t.app, fx.f.facilityId, { from: TODAY, to: TODAY });
    const census = await opdCensus(fx.t.app, fx.f.facilityId, { from: TODAY, to: TODAY });
    expect(d.today).toBe(TODAY);
    expect(d.collectionToday.netPaise).toBe(col.total.netPaise);
    expect(d.collectionToday.upiPaise).toBe(col.total.upiPaise);
    expect(d.opdToday.total).toBe(census.total);
    expect(sum(d.opdToday.byDoctor.map((x) => BigInt(x.count)))).toBe(BigInt(census.total));
    expect(d.waiting).toBeGreaterThanOrEqual(1);

    expect(d.trend).toHaveLength(30);
    expect(d.trend.at(-1)!.date).toBe(TODAY);
    expect(d.trend.at(-1)!.netPaise).toBe(col.total.netPaise);
    expect(d.trend.find((x) => x.date === '2026-10-20')!.netPaise).toBeGreaterThan(0n);
    expect(d.month.netPaise).toBe(await rawNet('2026-10-01', TODAY));
    expect(d.month.prevFull.netPaise).toBe(await rawNet('2026-09-01', '2026-09-30'));
    expect(d.month.prevSamePeriod.netPaise).toBe(await rawNet('2026-09-01', '2026-09-26'));
  });

  it('alerts on a day-close difference and on a UPI day nobody reconciled', async () => {
    const cashier = await mkUser('Short Cashier');
    const at = IST('2026-10-25T10:00:00');
    await paidVisit(cashier, (t) => [upi(Number(t) / 2), cash(Number(t) / 2)], at);
    await fx.run((tx) =>
      closeOwnDay(
        tx,
        as(cashier),
        {
          denominations: { n500: 0, n200: 0, n100: 0, n50: 0, n20: 0, n10: 0, coinsPaise: 0 },
          expectedCashPaise: '25000',
          differenceReason: 'short change',
          idempotencyKey: uuidv7(),
        } as never,
        IST('2026-10-25T18:00:00'),
      ),
    );
    const d = await ownerDashboard(fx.t.app, fx.f.facilityId, NOW);
    expect(
      d.alerts.some(
        (a) =>
          a.kind === 'dayCloseDifference' &&
          a.ref.includes('Short Cashier') &&
          a.paise === -25_000n,
      ),
    ).toBe(true);
    expect(d.alerts.some((a) => a.kind === 'upiPending' && a.ref === '2026-10-25')).toBe(true);
  });
});
