/**
 * Day-end close and UPI reconciliation (BIL-06, docs/12 §3 and §6). Same rules as `billing.ts`:
 * every function runs in the caller's transaction and money mutations go through `runIdempotent`.
 *
 * A *user close* stamps every payment the cashier has taken since their previous close with the new
 * `day_close` row; from then on the DB refuses to change those payments. A *facility close* takes
 * the user closes of a business day in; payments entered after it belong to the next day (trigger
 * `hmis_payment_business_date`). Expected amounts always come from the payments that were stamped
 * in the same transaction, never from the client; the DB re-checks them at COMMIT.
 */
import {
  businessDateFor,
  closeFacilityDaySchema,
  closeOwnDaySchema,
  closeVariance,
  countedCashPaise,
  denominationsToJson,
  istDateString,
  modeTotals,
  saveUpiReconciliationSchema,
  ZERO_MODE_TOTALS,
  type CloseFacilityDayInput,
  type CloseOwnDayInput,
  type ModeTotals,
  type SaveUpiReconciliationInput,
  type UpiReconStatus,
} from '@hmis/shared';
import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  appUser,
  bill,
  dayClose,
  department,
  doctorProfile,
  encounter,
  payment,
  upiReconciliation,
  upiReconciliationItem,
} from '../schema';
import type { Db } from './client';
import { runIdempotent } from './idempotency';
import type { Tx } from './tx';
import type { Actor } from './visits';

type Queryable = Db | Tx;

export type DayCloseErrorKey =
  | 'dayClose.notFound'
  | 'dayClose.expectedChanged'
  | 'dayClose.reasonRequired'
  | 'dayClose.futureDate'
  | 'dayClose.alreadyClosed'
  | 'dayClose.pendingUsers'
  | 'dayClose.noteRequired'
  | 'upi.paymentNotFound'
  | 'upi.alreadyReconciled'
  | 'upi.reasonRequired'
  | 'upi.futureDate';

/** Input / state errors the router turns into i18n keys (docs/02 §7). */
export class DayCloseInputError extends Error {
  constructor(readonly key: DayCloseErrorKey) {
    super(key);
    this.name = 'DayCloseInputError';
  }
}

/** Payments that move money: everything but a deposit adjustment, and not a reversed one. */
const countable = and(eq(payment.status, 'valid'), ne(payment.kind, 'deposit_adjustment'));

const chunks = <T>(xs: readonly T[], n = 5000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** The last business day the facility has closed, or null. */
export async function lastFacilityCloseDate(q: Queryable, facilityId: string) {
  const [row] = await q
    .select({ d: sql<string | null>`max(${dayClose.closeDate})::text` })
    .from(dayClose)
    .where(and(eq(dayClose.facilityId, facilityId), eq(dayClose.kind, 'facility')));
  return row?.d ?? null;
}

/** The business day a close made at `now` belongs to (a closed day is not reopened). */
export async function openBusinessDate(q: Queryable, facilityId: string, now: Date) {
  return businessDateFor(istDateString(now), await lastFacilityCloseDate(q, facilityId));
}

// ---------------------------------------------------------------- user close

export interface OpenCounterView {
  /** When the cashier last closed their counter; the open period started then. */
  lastClosedAt: Date | null;
  paymentCount: number;
  totals: ModeTotals;
  /** The business day a close made now would carry. */
  closeDate: string;
}

/** What the cashier's counter holds since their last close (the "expected" column of the screen). */
export async function openCounter(
  q: Queryable,
  facilityId: string,
  userId: string,
  now: Date,
): Promise<OpenCounterView> {
  const rows = await q
    .select({ mode: payment.mode, amountPaise: payment.amountPaise })
    .from(payment)
    .where(
      and(
        eq(payment.facilityId, facilityId),
        eq(payment.receivedBy, userId),
        isNull(payment.dayCloseId),
        countable,
      ),
    );
  const [last] = await q
    .select({ closedAt: dayClose.closedAt })
    .from(dayClose)
    .where(
      and(
        eq(dayClose.facilityId, facilityId),
        eq(dayClose.kind, 'user'),
        eq(dayClose.userId, userId),
      ),
    )
    .orderBy(desc(dayClose.closedAt))
    .limit(1);
  return {
    lastClosedAt: last?.closedAt ?? null,
    paymentCount: rows.length,
    totals: modeTotals(rows),
    closeDate: await openBusinessDate(q, facilityId, now),
  };
}

export interface CloseResult {
  dayCloseId: string;
  closeDate: string;
  /** Integer paise as strings (the result is stored as JSON for replays). */
  cashExpectedPaise: string;
  cashCountedPaise: string;
  differencePaise: string;
  upiExpectedPaise: string;
  cardExpectedPaise: string;
  paymentCount: number;
}

/**
 * Closes the cashier's counter (BIL-06): counts the denominations, compares with the cash the
 * system expects, and locks the payments to the close. A variance needs a reason. If a payment
 * arrived while the cashier was counting, the expected cash on their screen is stale: the close is
 * refused (`dayClose.expectedChanged`) and the screen reloads with the new figure.
 */
export async function closeOwnDay(
  tx: Tx,
  actor: Actor & { userId: string },
  raw: CloseOwnDayInput,
  now: Date,
): Promise<CloseResult> {
  const { idempotencyKey, ...input } = closeOwnDaySchema.parse(raw);
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'billing.dayClose.closeOwn',
      key: idempotencyKey,
      payload: input,
    },
    async () => {
      const open = await tx
        .select({
          id: payment.id,
          mode: payment.mode,
          amountPaise: payment.amountPaise,
          status: payment.status,
          kind: payment.kind,
        })
        .from(payment)
        .where(
          and(
            eq(payment.facilityId, actor.facilityId),
            eq(payment.receivedBy, actor.userId),
            isNull(payment.dayCloseId),
          ),
        )
        .for('update');
      const counted = open.filter((p) => p.status === 'valid' && p.kind !== 'deposit_adjustment');
      const totals = modeTotals(counted);
      if (totals.cashPaise !== input.expectedCashPaise) {
        throw new DayCloseInputError('dayClose.expectedChanged');
      }
      const cashCounted = countedCashPaise(input.denominations);
      const variance = closeVariance(totals.cashPaise, cashCounted);
      if (variance.reasonRequired && !input.differenceReason) {
        throw new DayCloseInputError('dayClose.reasonRequired');
      }
      const id = uuidv7();
      const closeDate = await openBusinessDate(tx, actor.facilityId, now);
      await tx.insert(dayClose).values({
        id,
        facilityId: actor.facilityId,
        kind: 'user',
        userId: actor.userId,
        closeDate,
        closedAt: now,
        cashExpectedPaise: totals.cashPaise,
        upiExpectedPaise: totals.upiPaise,
        cardExpectedPaise: totals.cardPaise,
        otherExpectedPaise: totals.otherPaise,
        cashCountedPaise: cashCounted,
        differencePaise: variance.differencePaise,
        differenceReason: variance.reasonRequired ? (input.differenceReason ?? null) : null,
        denominations: denominationsToJson(input.denominations),
        paymentCount: counted.length,
      });
      for (const ids of chunks(open.map((p) => p.id))) {
        await tx
          .update(payment)
          .set({ dayCloseId: id })
          .where(and(inArray(payment.id, ids), isNull(payment.dayCloseId)));
      }
      return {
        dayCloseId: id,
        closeDate,
        cashExpectedPaise: totals.cashPaise.toString(),
        cashCountedPaise: cashCounted.toString(),
        differencePaise: variance.differencePaise.toString(),
        upiExpectedPaise: totals.upiPaise.toString(),
        cardExpectedPaise: totals.cardPaise.toString(),
        paymentCount: counted.length,
      };
    },
  );
}

// ---------------------------------------------------------------- facility close

export interface UserCloseRow {
  id: string;
  userId: string;
  userName: string;
  closeDate: string;
  closedAt: Date;
  totals: ModeTotals;
  cashCountedPaise: bigint;
  differencePaise: bigint;
  differenceReason: string | null;
  paymentCount: number;
  facilityCloseId: string | null;
}

export interface PendingUserRow {
  userId: string;
  userName: string;
  paymentCount: number;
  cashPaise: bigint;
  totalPaise: bigint;
}

export interface BreakdownRow {
  key: string;
  label: string;
  netPaise: bigint;
}

export interface FacilityCloseView {
  date: string;
  /** The facility close of this day, if made. */
  close: {
    id: string;
    closedAt: Date;
    closedByName: string | null;
    totals: ModeTotals;
    cashCountedPaise: bigint;
    differencePaise: bigint;
    differenceReason: string | null;
    paymentCount: number;
    pendingAcknowledged: boolean;
    note: string | null;
  } | null;
  /** User closes of this day that the facility close has taken in (or would take in). */
  userCloses: UserCloseRow[];
  /** Cashiers with payments not yet counted up to this day. */
  pending: PendingUserRow[];
  totals: ModeTotals;
  cashCountedPaise: bigint;
  differencePaise: bigint;
  byDoctor: BreakdownRow[];
  byDepartment: BreakdownRow[];
  /** UPI reconciliation of this business day: `none` until someone starts it. */
  upiStatus: UpiReconStatus | 'none';
  upiDifferencePaise: bigint | null;
  /** Latest day the facility closed before this one (the day this close would follow). */
  lastClosedDate: string | null;
}

const userCloseSelect = {
  id: dayClose.id,
  userId: dayClose.userId,
  userName: appUser.fullName,
  closeDate: dayClose.closeDate,
  closedAt: dayClose.closedAt,
  cash: dayClose.cashExpectedPaise,
  upi: dayClose.upiExpectedPaise,
  card: dayClose.cardExpectedPaise,
  other: dayClose.otherExpectedPaise,
  counted: dayClose.cashCountedPaise,
  difference: dayClose.differencePaise,
  reason: dayClose.differenceReason,
  count: dayClose.paymentCount,
  facilityCloseId: dayClose.facilityCloseId,
};

const toUserCloseRow = (r: {
  id: string;
  userId: string | null;
  userName: string;
  closeDate: string;
  closedAt: Date;
  cash: bigint;
  upi: bigint;
  card: bigint;
  other: bigint;
  counted: bigint;
  difference: bigint;
  reason: string | null;
  count: number;
  facilityCloseId: string | null;
}): UserCloseRow => ({
  id: r.id,
  userId: r.userId!,
  userName: r.userName,
  closeDate: r.closeDate,
  closedAt: r.closedAt,
  totals: {
    cashPaise: r.cash,
    upiPaise: r.upi,
    cardPaise: r.card,
    otherPaise: r.other,
  },
  cashCountedPaise: r.counted,
  differencePaise: r.difference,
  differenceReason: r.reason,
  paymentCount: r.count,
  facilityCloseId: r.facilityCloseId,
});

async function pendingUsers(
  q: Queryable,
  facilityId: string,
  upToDate: string,
): Promise<PendingUserRow[]> {
  const rows = await q
    .select({
      userId: payment.receivedBy,
      userName: appUser.fullName,
      mode: payment.mode,
      amountPaise: payment.amountPaise,
    })
    .from(payment)
    .innerJoin(appUser, eq(appUser.id, payment.receivedBy))
    .where(
      and(
        eq(payment.facilityId, facilityId),
        isNull(payment.dayCloseId),
        lte(payment.businessDate, upToDate),
        countable,
      ),
    );
  const by = new Map<string, PendingUserRow>();
  for (const r of rows) {
    const row = by.get(r.userId!) ?? {
      userId: r.userId!,
      userName: r.userName,
      paymentCount: 0,
      cashPaise: 0n,
      totalPaise: 0n,
    };
    row.paymentCount += 1;
    row.totalPaise += r.amountPaise;
    if (r.mode === 'cash') row.cashPaise += r.amountPaise;
    by.set(r.userId!, row);
  }
  return [...by.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}

async function breakdown(q: Queryable, closeIds: readonly string[]) {
  if (closeIds.length === 0) return { byDoctor: [], byDepartment: [] };
  const rows = await q
    .select({
      doctorId: encounter.doctorId,
      doctor: doctorProfile.displayName,
      departmentId: encounter.departmentId,
      department: department.name,
      net: sql<string>`sum(${payment.amountPaise})::text`,
    })
    .from(payment)
    .leftJoin(encounter, eq(encounter.id, payment.encounterId))
    .leftJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .leftJoin(department, eq(department.id, encounter.departmentId))
    .where(and(inArray(payment.dayCloseId, [...closeIds]), countable))
    .groupBy(
      encounter.doctorId,
      doctorProfile.displayName,
      encounter.departmentId,
      department.name,
    );
  const doc = new Map<string, BreakdownRow>();
  const dep = new Map<string, BreakdownRow>();
  for (const r of rows) {
    const net = BigInt(r.net);
    const dk = r.doctorId ?? 'none';
    const pk = r.departmentId ?? 'none';
    const d = doc.get(dk) ?? { key: dk, label: r.doctor ?? '', netPaise: 0n };
    d.netPaise += net;
    doc.set(dk, d);
    const p = dep.get(pk) ?? { key: pk, label: r.department ?? '', netPaise: 0n };
    p.netPaise += net;
    dep.set(pk, p);
  }
  const sort = (m: Map<string, BreakdownRow>) =>
    [...m.values()].sort((a, b) =>
      a.netPaise === b.netPaise ? 0 : a.netPaise > b.netPaise ? -1 : 1,
    );
  return { byDoctor: sort(doc), byDepartment: sort(dep) };
}

/**
 * The facility close screen / summary for one business day (docs/12 §6): the user closes that are
 * (or would be) part of it, who still has an open counter, totals by mode, department and doctor,
 * and where the UPI reconciliation stands.
 */
export async function facilityCloseView(
  q: Queryable,
  facilityId: string,
  date: string,
): Promise<FacilityCloseView> {
  const [fc] = await q
    .select({
      id: dayClose.id,
      closedAt: dayClose.closedAt,
      closedByName: appUser.fullName,
      cash: dayClose.cashExpectedPaise,
      upi: dayClose.upiExpectedPaise,
      card: dayClose.cardExpectedPaise,
      other: dayClose.otherExpectedPaise,
      counted: dayClose.cashCountedPaise,
      difference: dayClose.differencePaise,
      reason: dayClose.differenceReason,
      count: dayClose.paymentCount,
      pendingAcknowledged: dayClose.pendingAcknowledged,
      note: dayClose.note,
    })
    .from(dayClose)
    .leftJoin(appUser, eq(appUser.id, dayClose.createdBy))
    .where(
      and(
        eq(dayClose.facilityId, facilityId),
        eq(dayClose.kind, 'facility'),
        eq(dayClose.closeDate, date),
      ),
    );
  // A closed day shows the user closes it took in; an open day shows those waiting for it.
  const closes = await q
    .select(userCloseSelect)
    .from(dayClose)
    .innerJoin(appUser, eq(appUser.id, dayClose.userId))
    .where(
      and(
        eq(dayClose.facilityId, facilityId),
        eq(dayClose.kind, 'user'),
        fc
          ? eq(dayClose.facilityCloseId, fc.id)
          : and(isNull(dayClose.facilityCloseId), lte(dayClose.closeDate, date)),
      ),
    )
    .orderBy(asc(dayClose.closedAt));
  const userCloses = closes.map(toUserCloseRow);
  const totals = fc
    ? { cashPaise: fc.cash, upiPaise: fc.upi, cardPaise: fc.card, otherPaise: fc.other }
    : userCloses.reduce<ModeTotals>(
        (a, c) => ({
          cashPaise: a.cashPaise + c.totals.cashPaise,
          upiPaise: a.upiPaise + c.totals.upiPaise,
          cardPaise: a.cardPaise + c.totals.cardPaise,
          otherPaise: a.otherPaise + c.totals.otherPaise,
        }),
        ZERO_MODE_TOTALS,
      );
  const cashCountedPaise = userCloses.reduce((s, c) => s + c.cashCountedPaise, 0n);
  const [recon] = await q
    .select({ status: upiReconciliation.status, difference: upiReconciliation.differencePaise })
    .from(upiReconciliation)
    .where(
      and(eq(upiReconciliation.facilityId, facilityId), eq(upiReconciliation.reconDate, date)),
    );
  return {
    date,
    close: fc
      ? {
          id: fc.id,
          closedAt: fc.closedAt,
          closedByName: fc.closedByName,
          totals,
          cashCountedPaise: fc.counted,
          differencePaise: fc.difference,
          differenceReason: fc.reason,
          paymentCount: fc.count,
          pendingAcknowledged: fc.pendingAcknowledged,
          note: fc.note,
        }
      : null,
    userCloses,
    pending: await pendingUsers(q, facilityId, date),
    totals,
    cashCountedPaise,
    differencePaise: userCloses.reduce((s, c) => s + c.differencePaise, 0n),
    ...(await breakdown(
      q,
      userCloses.map((c) => c.id),
    )),
    upiStatus: recon ? (recon.status as UpiReconStatus) : 'none',
    upiDifferencePaise: recon?.difference ?? null,
    lastClosedDate: await lastFacilityCloseDate(q, facilityId),
  };
}

export interface FacilityCloseResult {
  dayCloseId: string;
  closeDate: string;
  userCloseCount: number;
  cashExpectedPaise: string;
  cashCountedPaise: string;
  differencePaise: string;
  paymentCount: number;
}

/**
 * Facility close (admin / owner): takes in every user close up to the date, sums them, and locks
 * the day. Cashiers who still have uncounted payments up to that day block the close unless it is
 * acknowledged with a note; their payments are counted by their own later close and belong to the
 * following day's report. After this, payments entered for a closed day get the next business day.
 */
export async function closeFacilityDay(
  tx: Tx,
  actor: Actor & { userId: string },
  raw: CloseFacilityDayInput,
  now: Date,
): Promise<FacilityCloseResult> {
  const { idempotencyKey, ...input } = closeFacilityDaySchema.parse(raw);
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'billing.dayClose.closeFacility',
      key: idempotencyKey,
      payload: input,
    },
    async () => {
      // Payments wait on this lock while the close is made, so they see it (migration 0019).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`dayclose:facility:${actor.facilityId}`}, 0))`,
      );
      if (input.closeDate > istDateString(now)) throw new DayCloseInputError('dayClose.futureDate');
      const last = await lastFacilityCloseDate(tx, actor.facilityId);
      if (last !== null && input.closeDate <= last) {
        throw new DayCloseInputError('dayClose.alreadyClosed');
      }
      const pending = await pendingUsers(tx, actor.facilityId, input.closeDate);
      if (pending.length > 0) {
        if (!input.acknowledgePending) throw new DayCloseInputError('dayClose.pendingUsers');
        if (!input.note) throw new DayCloseInputError('dayClose.noteRequired');
      }
      const children = await tx
        .select(userCloseSelect)
        .from(dayClose)
        .innerJoin(appUser, eq(appUser.id, dayClose.userId))
        .where(
          and(
            eq(dayClose.facilityId, actor.facilityId),
            eq(dayClose.kind, 'user'),
            isNull(dayClose.facilityCloseId),
            lte(dayClose.closeDate, input.closeDate),
          ),
        )
        .orderBy(asc(dayClose.closedAt))
        .for('update', { of: dayClose });
      const rows = children.map(toUserCloseRow);
      const sum = (f: (c: UserCloseRow) => bigint) => rows.reduce((s, c) => s + f(c), 0n);
      const expected = sum((c) => c.totals.cashPaise);
      const counted = sum((c) => c.cashCountedPaise);
      const difference = counted - expected;
      const reasons = rows.map((c) => c.differenceReason).filter((r): r is string => !!r);
      const id = uuidv7();
      await tx.insert(dayClose).values({
        id,
        facilityId: actor.facilityId,
        kind: 'facility',
        userId: null,
        closeDate: input.closeDate,
        closedAt: now,
        cashExpectedPaise: expected,
        upiExpectedPaise: sum((c) => c.totals.upiPaise),
        cardExpectedPaise: sum((c) => c.totals.cardPaise),
        otherExpectedPaise: sum((c) => c.totals.otherPaise),
        cashCountedPaise: counted,
        differencePaise: difference,
        differenceReason: difference === 0n ? null : reasons.join('; ').slice(0, 1000) || '-',
        paymentCount: rows.reduce((s, c) => s + c.paymentCount, 0),
        pendingAcknowledged: pending.length > 0,
        note: input.note ?? null,
      });
      if (rows.length > 0) {
        await tx
          .update(dayClose)
          .set({ facilityCloseId: id, verifiedBy: actor.userId, verifiedAt: now })
          .where(
            inArray(
              dayClose.id,
              rows.map((c) => c.id),
            ),
          );
      }
      return {
        dayCloseId: id,
        closeDate: input.closeDate,
        userCloseCount: rows.length,
        cashExpectedPaise: expected.toString(),
        cashCountedPaise: counted.toString(),
        differencePaise: difference.toString(),
        paymentCount: rows.reduce((s, c) => s + c.paymentCount, 0),
      };
    },
  );
}

// ---------------------------------------------------------------- reports and slips

export interface DayCloseReportRow extends UserCloseRow {
  /** The facility close that took it in, as its business date. */
  facilityCloseDate: string | null;
}

/** Day close summary report (docs/20): user closes in a date range with expected vs counted. */
export async function dayCloseReport(
  q: Queryable,
  facilityId: string,
  range: { from: string; to: string },
): Promise<DayCloseReportRow[]> {
  const fc = sql<
    string | null
  >`(select f.close_date::text from day_close f where f.id = ${dayClose.facilityCloseId})`;
  const rows = await q
    .select({ ...userCloseSelect, facilityCloseDate: fc })
    .from(dayClose)
    .innerJoin(appUser, eq(appUser.id, dayClose.userId))
    .where(
      and(
        eq(dayClose.facilityId, facilityId),
        eq(dayClose.kind, 'user'),
        sql`${dayClose.closeDate} between ${range.from} and ${range.to}`,
      ),
    )
    .orderBy(desc(dayClose.closedAt))
    .limit(500);
  return rows.map((r) => ({ ...toUserCloseRow(r), facilityCloseDate: r.facilityCloseDate }));
}

export interface DayCloseSlip {
  id: string;
  kind: 'user' | 'facility';
  closeDate: string;
  closedAt: Date;
  userName: string | null;
  totals: ModeTotals;
  cashCountedPaise: bigint;
  differencePaise: bigint;
  differenceReason: string | null;
  paymentCount: number;
  denominations: {
    n500: number;
    n200: number;
    n100: number;
    n50: number;
    n20: number;
    n10: number;
    coinsPaise: bigint;
  } | null;
  note: string | null;
  pendingAcknowledged: boolean;
}

/** One close for the printed slip (user close: thermal; facility close: A4 summary). */
export async function loadDayClose(
  q: Queryable,
  facilityId: string,
  id: string,
): Promise<DayCloseSlip | null> {
  const [r] = await q
    .select({ c: dayClose, userName: appUser.fullName })
    .from(dayClose)
    .leftJoin(appUser, eq(appUser.id, dayClose.userId))
    .where(and(eq(dayClose.id, id), eq(dayClose.facilityId, facilityId)));
  if (!r) return null;
  const d = r.c.denominations as Record<string, number | string> | null;
  return {
    id: r.c.id,
    kind: r.c.kind as 'user' | 'facility',
    closeDate: r.c.closeDate,
    closedAt: r.c.closedAt,
    userName: r.userName,
    totals: {
      cashPaise: r.c.cashExpectedPaise,
      upiPaise: r.c.upiExpectedPaise,
      cardPaise: r.c.cardExpectedPaise,
      otherPaise: r.c.otherExpectedPaise,
    },
    cashCountedPaise: r.c.cashCountedPaise,
    differencePaise: r.c.differencePaise,
    differenceReason: r.c.differenceReason,
    paymentCount: r.c.paymentCount,
    denominations: d
      ? {
          n500: Number(d.n500 ?? 0),
          n200: Number(d.n200 ?? 0),
          n100: Number(d.n100 ?? 0),
          n50: Number(d.n50 ?? 0),
          n20: Number(d.n20 ?? 0),
          n10: Number(d.n10 ?? 0),
          coinsPaise: BigInt(String(d.coinsPaise ?? 0)),
        }
      : null,
    note: r.c.note,
    pendingAcknowledged: r.c.pendingAcknowledged,
  };
}

// ---------------------------------------------------------------- UPI reconciliation

export interface UpiReceiptRow {
  paymentId: string;
  receiptNumber: string;
  receivedAt: Date;
  receivedByName: string | null;
  amountPaise: bigint;
  /** Last digits of the UTR as typed at the counter. */
  upiRef: string | null;
  upiPayerName: string | null;
  billNumber: string | null;
  kind: string;
  matched: boolean;
  statementUtr: string | null;
}

export interface UpiReconciliationView {
  date: string;
  status: UpiReconStatus | 'none';
  receipts: UpiReceiptRow[];
  systemTotalPaise: bigint;
  statementTotalPaise: bigint | null;
  differencePaise: bigint | null;
  differenceReason: string | null;
  reconciledByName: string | null;
  reconciledAt: Date | null;
  matchedTotalPaise: bigint;
}

async function upiReceipts(q: Queryable, facilityId: string, date: string) {
  return q
    .select({
      paymentId: payment.id,
      receiptNumber: payment.number,
      receivedAt: payment.receivedAt,
      receivedByName: appUser.fullName,
      amountPaise: payment.amountPaise,
      upiRef: payment.upiRef,
      upiPayerName: payment.upiPayerName,
      billNumber: bill.number,
      kind: payment.kind,
    })
    .from(payment)
    .leftJoin(appUser, eq(appUser.id, payment.receivedBy))
    .leftJoin(bill, eq(bill.id, payment.billId))
    .where(
      and(
        eq(payment.facilityId, facilityId),
        eq(payment.mode, 'upi'),
        eq(payment.businessDate, date),
        countable,
      ),
    )
    .orderBy(asc(payment.receivedAt), asc(payment.id));
}

/** The UPI receipts of a business day with their ticks, and the reconciliation so far. */
export async function upiReconciliationView(
  q: Queryable,
  facilityId: string,
  date: string,
): Promise<UpiReconciliationView> {
  const receipts = await upiReceipts(q, facilityId, date);
  const [rec] = await q
    .select({ r: upiReconciliation, reconciledByName: appUser.fullName })
    .from(upiReconciliation)
    .leftJoin(appUser, eq(appUser.id, upiReconciliation.reconciledBy))
    .where(
      and(eq(upiReconciliation.facilityId, facilityId), eq(upiReconciliation.reconDate, date)),
    );
  const items = rec
    ? await q
        .select({
          paymentId: upiReconciliationItem.paymentId,
          matched: upiReconciliationItem.matched,
          statementUtr: upiReconciliationItem.statementUtr,
        })
        .from(upiReconciliationItem)
        .where(eq(upiReconciliationItem.reconciliationId, rec.r.id))
    : [];
  const byPayment = new Map(items.map((i) => [i.paymentId, i]));
  const rows: UpiReceiptRow[] = receipts.map((r) => ({
    ...r,
    matched: byPayment.get(r.paymentId)?.matched ?? false,
    statementUtr: byPayment.get(r.paymentId)?.statementUtr ?? null,
  }));
  return {
    date,
    status: rec ? (rec.r.status as UpiReconStatus) : 'none',
    receipts: rows,
    systemTotalPaise: rows.reduce((s, r) => s + r.amountPaise, 0n),
    statementTotalPaise: rec?.r.statementTotalPaise ?? null,
    differencePaise: rec ? rec.r.differencePaise : null,
    differenceReason: rec?.r.differenceReason ?? null,
    reconciledByName: rec?.reconciledByName ?? null,
    reconciledAt: rec?.r.reconciledAt ?? null,
    matchedTotalPaise: rows.filter((r) => r.matched).reduce((s, r) => s + r.amountPaise, 0n),
  };
}

export interface SaveUpiResult {
  reconciliationId: string;
  status: UpiReconStatus;
  systemTotalPaise: string;
  statementTotalPaise: string;
  differencePaise: string;
}

/**
 * Saves the cashier's UPI reconciliation for a business day (docs/12 §3): the statement total,
 * which receipts were seen on the statement (with the statement UTR), and — when completing —
 * the reason for any difference. A completed reconciliation is frozen.
 */
export async function saveUpiReconciliation(
  tx: Tx,
  actor: Actor & { userId: string },
  raw: SaveUpiReconciliationInput,
  now: Date,
): Promise<SaveUpiResult> {
  const { idempotencyKey, ...input } = saveUpiReconciliationSchema.parse(raw);
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'billing.upiReconciliation.save',
      key: idempotencyKey,
      payload: input,
    },
    async () => {
      if (input.date > istDateString(now)) throw new DayCloseInputError('upi.futureDate');
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`upirecon:${actor.facilityId}:${input.date}`}, 0))`,
      );
      const receipts = await upiReceipts(tx, actor.facilityId, input.date);
      const valid = new Set(receipts.map((r) => r.paymentId));
      if (input.matches.some((m) => !valid.has(m.paymentId))) {
        throw new DayCloseInputError('upi.paymentNotFound');
      }
      const system = receipts.reduce((s, r) => s + r.amountPaise, 0n);
      const difference = input.statementTotalPaise - system;
      if (input.complete && difference !== 0n && !input.differenceReason) {
        throw new DayCloseInputError('upi.reasonRequired');
      }
      const [existing] = await tx
        .select({ id: upiReconciliation.id, status: upiReconciliation.status })
        .from(upiReconciliation)
        .where(
          and(
            eq(upiReconciliation.facilityId, actor.facilityId),
            eq(upiReconciliation.reconDate, input.date),
          ),
        )
        .for('update');
      if (existing?.status === 'reconciled') throw new DayCloseInputError('upi.alreadyReconciled');
      const values = {
        systemTotalPaise: system,
        statementTotalPaise: input.statementTotalPaise,
        differencePaise: difference,
        differenceReason: difference === 0n ? null : (input.differenceReason ?? null),
      };
      let id = existing?.id;
      if (id) {
        await tx.update(upiReconciliation).set(values).where(eq(upiReconciliation.id, id));
      } else {
        id = uuidv7();
        await tx
          .insert(upiReconciliation)
          .values({ id, facilityId: actor.facilityId, reconDate: input.date, ...values });
      }
      const ticked = new Map(input.matches.map((m) => [m.paymentId, m.statementUtr ?? null]));
      const items = await tx
        .select({ id: upiReconciliationItem.id, paymentId: upiReconciliationItem.paymentId })
        .from(upiReconciliationItem)
        .where(eq(upiReconciliationItem.reconciliationId, id));
      const have = new Map(items.map((i) => [i.paymentId, i.id]));
      for (const [paymentId, utr] of ticked) {
        const itemId = have.get(paymentId);
        if (itemId) {
          await tx
            .update(upiReconciliationItem)
            .set({ matched: true, statementUtr: utr })
            .where(eq(upiReconciliationItem.id, itemId));
        } else {
          await tx.insert(upiReconciliationItem).values({
            id: uuidv7(),
            facilityId: actor.facilityId,
            reconciliationId: id,
            paymentId,
            matched: true,
            statementUtr: utr,
          });
        }
      }
      for (const [paymentId, itemId] of have) {
        if (!ticked.has(paymentId)) {
          await tx
            .update(upiReconciliationItem)
            .set({ matched: false, statementUtr: null })
            .where(eq(upiReconciliationItem.id, itemId));
        }
      }
      // Frozen last: the item guard only lets an open reconciliation change.
      if (input.complete) {
        await tx
          .update(upiReconciliation)
          .set({ status: 'reconciled', reconciledBy: actor.userId, reconciledAt: now })
          .where(eq(upiReconciliation.id, id));
      }
      return {
        reconciliationId: id,
        status: input.complete ? 'reconciled' : 'open',
        systemTotalPaise: system.toString(),
        statementTotalPaise: input.statementTotalPaise.toString(),
        differencePaise: difference.toString(),
      };
    },
  );
}

/** Days with UPI receipts but no completed reconciliation (dashboard alert, docs/20). */
export async function pendingUpiReconciliations(
  q: Queryable,
  facilityId: string,
  before: string,
): Promise<string[]> {
  const rows = await q
    .select({ d: sql<string>`${payment.businessDate}::text` })
    .from(payment)
    .where(
      and(
        eq(payment.facilityId, facilityId),
        eq(payment.mode, 'upi'),
        countable,
        sql`${payment.businessDate} < ${before}`,
        sql`not exists (select 1 from upi_reconciliation r where r.facility_id = ${payment.facilityId}
          and r.recon_date = ${payment.businessDate} and r.status = 'reconciled')`,
      ),
    )
    .groupBy(payment.businessDate)
    .orderBy(asc(payment.businessDate));
  return rows.map((r) => r.d);
}
