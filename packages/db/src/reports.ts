/**
 * Reports and the owner dashboard (RPT-01, RPT-02, docs/20). Read-only queries: nothing here
 * writes, so there is no transaction, audit row or idempotency key. Every figure comes from the
 * same rows the counters write (payments, encounters, tokens, pregnancies), never from a copy, so
 * the totals reconcile with bills and payments by construction (tests check it).
 *
 * Money rules: a payment counts when it is `valid` and not a deposit adjustment (the rule of the
 * day close), on its `business_date` (the day it was counted into, see BIL-06). Restricted
 * (MTP) encounters are left out of every clinical count (AGENTS.md rule 8).
 */
import {
  ANC_MISSED_AFTER_DAYS,
  DASHBOARD_TREND_DAYS,
  addDays,
  ageFromDob,
  daysBetween,
  eachDay,
  istDateString,
  modeTotals,
  monthWindows,
  parseIsoDate,
  toIsoDate,
  ZERO_MODE_TOTALS,
  type Age,
  type ModeTotals,
  type RiskFlag,
  type VisitType,
} from '@hmis/shared';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import {
  appUser,
  bill,
  dayClose,
  department,
  doctorProfile,
  encounter,
  opdToken,
  patient,
  payment,
} from '../schema';
import { activePregnancies, type AncActor } from './anc';
import { cancellationReport, discountReport } from './billing-adjustments';
import type { Db } from './client';
import { pendingUpiReconciliations } from './day-close';
import { dueSoon } from './paeds';
import type { Tx } from './tx';

type Queryable = Db | Tx;

const countable = and(eq(payment.status, 'valid'), ne(payment.kind, 'deposit_adjustment'));

/** Most receipts one report carries; `truncated` says when there were more. */
export const RECEIPT_LIST_LIMIT = 3000;

// ---------------------------------------------------------------- daily collection

/**
 * Money per mode, signed net of refunds, plus the refunds on their own. `collectedPaise` is what
 * came in before refunds: `collected − refunded = net = Σ modes`.
 */
export interface CollectionRow extends ModeTotals {
  key: string;
  label: string;
  collectedPaise: bigint;
  refundedPaise: bigint;
  netPaise: bigint;
  count: number;
}

export interface ReceiptRow {
  id: string;
  number: string;
  at: Date;
  businessDate: string;
  kind: string;
  mode: string;
  amountPaise: bigint;
  uhid: string;
  patientName: string;
  billNumber: string | null;
  upiRef: string | null;
  receivedByName: string | null;
}

export interface CollectionReport {
  from: string;
  to: string;
  total: CollectionRow;
  byDay: CollectionRow[];
  byUser: CollectionRow[];
  byDoctor: CollectionRow[];
  byDepartment: CollectionRow[];
  /** Receipts that were reversed in the range: shown, never counted. */
  reversed: { count: number; paise: bigint };
  receipts: ReceiptRow[];
  truncated: boolean;
}

const emptyRow = (key: string, label: string): CollectionRow => ({
  ...ZERO_MODE_TOTALS,
  key,
  label,
  collectedPaise: 0n,
  refundedPaise: 0n,
  netPaise: 0n,
  count: 0,
});

function addTo(row: CollectionRow, mode: string, signed: bigint, isRefund: boolean, n: number) {
  const m = modeTotals([{ mode, amountPaise: signed }]);
  row.cashPaise += m.cashPaise;
  row.upiPaise += m.upiPaise;
  row.cardPaise += m.cardPaise;
  row.otherPaise += m.otherPaise;
  row.netPaise += signed;
  if (isRefund) row.refundedPaise += -signed;
  else row.collectedPaise += signed;
  row.count += n;
}

/**
 * Daily collection (docs/20 §2): by day, user, doctor and department, with every mode, the
 * refunds and the net, and the receipts list. Counted by business day like the day close, so
 * the figures match the facility close of the same day.
 */
export async function collectionReport(
  q: Queryable,
  facilityId: string,
  range: { from: string; to: string },
): Promise<CollectionReport> {
  const inRange = and(
    eq(payment.facilityId, facilityId),
    gte(payment.businessDate, range.from),
    lte(payment.businessDate, range.to),
  );
  const groups = await q
    .select({
      day: sql<string>`${payment.businessDate}::text`,
      userId: payment.receivedBy,
      userName: appUser.fullName,
      mode: payment.mode,
      isRefund: sql<boolean>`${payment.kind} = 'refund'`,
      doctorId: encounter.doctorId,
      doctor: doctorProfile.displayName,
      departmentId: encounter.departmentId,
      department: department.name,
      net: sql<string>`sum(${payment.amountPaise})::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(payment)
    .leftJoin(appUser, eq(appUser.id, payment.receivedBy))
    .leftJoin(encounter, eq(encounter.id, payment.encounterId))
    .leftJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .leftJoin(department, eq(department.id, encounter.departmentId))
    .where(and(inRange, countable))
    .groupBy(
      payment.businessDate,
      payment.receivedBy,
      appUser.fullName,
      payment.mode,
      sql`${payment.kind} = 'refund'`,
      encounter.doctorId,
      doctorProfile.displayName,
      encounter.departmentId,
      department.name,
    );

  const total = emptyRow('total', '');
  const day = new Map<string, CollectionRow>();
  const user = new Map<string, CollectionRow>();
  const doctor = new Map<string, CollectionRow>();
  const dept = new Map<string, CollectionRow>();
  const bucket = (m: Map<string, CollectionRow>, key: string, label: string) => {
    let r = m.get(key);
    if (!r) m.set(key, (r = emptyRow(key, label)));
    return r;
  };
  for (const g of groups) {
    const signed = BigInt(g.net);
    for (const r of [
      total,
      bucket(day, g.day, g.day),
      bucket(user, g.userId ?? 'none', g.userName ?? ''),
      bucket(doctor, g.doctorId ?? 'none', g.doctor ?? ''),
      bucket(dept, g.departmentId ?? 'none', g.department ?? ''),
    ]) {
      addTo(r, g.mode, signed, g.isRefund, g.n);
    }
  }
  const byNet = (a: CollectionRow, b: CollectionRow) =>
    a.netPaise === b.netPaise ? a.label.localeCompare(b.label) : a.netPaise > b.netPaise ? -1 : 1;

  const [rev] = await q
    .select({
      n: sql<number>`count(*)::int`,
      paise: sql<string>`coalesce(sum(${payment.amountPaise}), 0)::text`,
    })
    .from(payment)
    .where(and(inRange, eq(payment.status, 'reversed')));

  const receiptRows = await q
    .select({
      id: payment.id,
      number: payment.number,
      at: payment.receivedAt,
      businessDate: sql<string>`${payment.businessDate}::text`,
      kind: payment.kind,
      mode: payment.mode,
      amountPaise: payment.amountPaise,
      uhid: patient.uhid,
      patientName: patient.fullName,
      billNumber: bill.number,
      upiRef: payment.upiRef,
      receivedByName: appUser.fullName,
    })
    .from(payment)
    .innerJoin(patient, eq(patient.id, payment.patientId))
    .leftJoin(bill, eq(bill.id, payment.billId))
    .leftJoin(appUser, eq(appUser.id, payment.receivedBy))
    .where(and(inRange, countable))
    .orderBy(asc(payment.receivedAt), asc(payment.number), asc(payment.mode))
    .limit(RECEIPT_LIST_LIMIT + 1);

  return {
    from: range.from,
    to: range.to,
    total,
    byDay: [...day.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byUser: [...user.values()].sort(byNet),
    byDoctor: [...doctor.values()].sort(byNet),
    byDepartment: [...dept.values()].sort(byNet),
    reversed: { count: rev?.n ?? 0, paise: BigInt(rev?.paise ?? '0') },
    receipts: receiptRows.slice(0, RECEIPT_LIST_LIMIT),
    truncated: receiptRows.length > RECEIPT_LIST_LIMIT,
  };
}

// ---------------------------------------------------------------- OPD census

export interface OpdCensusRow {
  doctorId: string;
  doctor: string;
  /** Visits per visit type (all types present, zero when none). */
  byType: Record<VisitType, number>;
  total: number;
  /** Average minutes from token to "with doctor"; null when nobody was called yet. */
  avgWaitMinutes: number | null;
}

export interface OpdCensus {
  from: string;
  to: string;
  rows: OpdCensusRow[];
  totalsByType: Record<VisitType, number>;
  total: number;
  avgWaitMinutes: number | null;
  /** Cancelled visits in the range, listed apart (not in the counts). */
  cancelled: number;
  /** Visits by IST hour of arrival at the desk, 0–23 (every hour present). */
  byHour: { hour: number; count: number }[];
  byDay: { date: string; count: number }[];
}

const zeroTypes = (): Record<VisitType, number> => ({
  new: 0,
  follow_up: 0,
  emergency: 0,
  anc: 0,
  paeds_vaccination: 0,
});

/**
 * OPD census (docs/20 §2): visits by doctor and visit type, by hour of arrival and the average
 * wait. Cancelled visits are not counted (they are shown as a number); restricted visits never are.
 */
export async function opdCensus(
  q: Queryable,
  facilityId: string,
  range: { from: string; to: string; doctorId?: string },
): Promise<OpdCensus> {
  const live = and(
    eq(encounter.facilityId, facilityId),
    eq(encounter.type, 'opd'),
    eq(encounter.isRestricted, false),
    gte(encounter.visitDate, range.from),
    lte(encounter.visitDate, range.to),
    range.doctorId ? eq(encounter.doctorId, range.doctorId) : undefined,
  );

  const groups = await q
    .select({
      doctorId: encounter.doctorId,
      doctor: doctorProfile.displayName,
      visitType: encounter.visitType,
      status: encounter.status,
      n: sql<number>`count(*)::int`,
    })
    .from(encounter)
    .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .where(live)
    .groupBy(encounter.doctorId, doctorProfile.displayName, encounter.visitType, encounter.status);

  const waits = await q
    .select({
      doctorId: encounter.doctorId,
      seconds: sql<string>`sum(extract(epoch from (${opdToken.calledAt} - ${opdToken.issuedAt})))::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(opdToken)
    .innerJoin(encounter, eq(encounter.id, opdToken.encounterId))
    .where(and(live, ne(encounter.status, 'cancelled'), sql`${opdToken.calledAt} is not null`))
    .groupBy(encounter.doctorId);
  const wait = new Map(waits.map((w) => [w.doctorId, w]));

  const hours = await q
    .select({
      hour: sql<number>`extract(hour from ${encounter.startedAt} at time zone 'Asia/Kolkata')::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(encounter)
    .where(and(live, ne(encounter.status, 'cancelled')))
    .groupBy(sql`1`);

  const days = await q
    .select({ d: sql<string>`${encounter.visitDate}::text`, n: sql<number>`count(*)::int` })
    .from(encounter)
    .where(and(live, ne(encounter.status, 'cancelled')))
    .groupBy(encounter.visitDate)
    .orderBy(asc(encounter.visitDate));

  const byDoctor = new Map<string, OpdCensusRow>();
  const totalsByType = zeroTypes();
  let cancelled = 0;
  for (const g of groups) {
    if (g.status === 'cancelled') {
      cancelled += g.n;
      continue;
    }
    const w = wait.get(g.doctorId);
    const row = byDoctor.get(g.doctorId) ?? {
      doctorId: g.doctorId,
      doctor: g.doctor,
      byType: zeroTypes(),
      total: 0,
      avgWaitMinutes: w ? Math.round(Number(w.seconds) / w.n / 60) : null,
    };
    row.byType[g.visitType as VisitType] += g.n;
    row.total += g.n;
    totalsByType[g.visitType as VisitType] += g.n;
    byDoctor.set(g.doctorId, row);
  }
  const waitN = [...wait.values()].reduce((s, w) => s + w.n, 0);
  const waitSeconds = [...wait.values()].reduce((s, w) => s + Number(w.seconds), 0);
  const hourMap = new Map(hours.map((h) => [h.hour, h.n]));
  return {
    from: range.from,
    to: range.to,
    rows: [...byDoctor.values()].sort(
      (a, b) => b.total - a.total || a.doctor.localeCompare(b.doctor),
    ),
    totalsByType,
    total: Object.values(totalsByType).reduce((s, n) => s + n, 0),
    avgWaitMinutes: waitN ? Math.round(waitSeconds / waitN / 60) : null,
    cancelled,
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hourMap.get(hour) ?? 0 })),
    byDay: days.map((d) => ({ date: d.d, count: d.n })),
  };
}

// ---------------------------------------------------------------- ANC register

export interface AncRegisterRow {
  pregnancyId: string;
  patientId: string;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  age: Age;
  mobile: string | null;
  gaLabel: string;
  gaDays: number;
  eddFinal: string;
  daysToEdd: number;
  gpalText: string;
  risks: RiskFlag[];
  lastVisit: string | null;
  nextVisitDate: string | null;
  /** Days past the suggested next visit; 0 when not late. */
  daysLate: number;
}

export interface AncRegister {
  today: string;
  rows: AncRegisterRow[];
  /** EDD from today to `eddWithinDays` ahead, soonest first. */
  eddSoon: AncRegisterRow[];
  /** Missed the suggested visit by more than `ANC_MISSED_AFTER_DAYS`: the follow-up call list. */
  overdue: AncRegisterRow[];
  highRiskCount: number;
}

/**
 * ANC register (docs/20 §2): every active pregnancy with GA today, EDD, risk flags, last and next
 * visit, plus the EDDs coming up and the women who missed their visit. `risk` narrows it to one
 * flag (the high-risk list). Pregnancies closed as MTP are not active, so never listed.
 */
export async function ancRegister(
  q: Queryable,
  facilityId: string,
  now: Date,
  o: { risk?: string; eddWithinDays?: number } = {},
): Promise<AncRegister> {
  const today = istDateString(now);
  const actor: AncActor = { facilityId, userId: '', mtp: { view: false, edit: false } };
  const items = await activePregnancies(q, actor, now);
  const ids = items.map((i) => i.patientId);
  const people = ids.length
    ? await q
        .select({ id: patient.id, dob: patient.dob, mobile: patient.mobile })
        .from(patient)
        .where(inArray(patient.id, ids))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const rows: AncRegisterRow[] = items
    .filter((i) => !o.risk || i.risks.some((r) => r.code === o.risk))
    .map((i) => {
      const p = byId.get(i.patientId);
      const nextDate = i.nextVisit?.date ?? null;
      const late = nextDate ? daysBetween(parseIsoDate(nextDate), parseIsoDate(today)) : 0;
      return {
        pregnancyId: i.id,
        patientId: i.patientId,
        uhid: i.uhid,
        fullName: i.fullName,
        nameHi: i.nameHi,
        age: p ? ageFromDob(p.dob, parseIsoDate(today)) : { unit: 'years', value: 0 },
        mobile: p?.mobile ?? null,
        gaLabel: i.gaLabel,
        gaDays: i.gaDays,
        eddFinal: i.eddFinal,
        daysToEdd: daysBetween(parseIsoDate(today), parseIsoDate(i.eddFinal)),
        gpalText: i.gpalText,
        risks: i.risks,
        lastVisit: i.lastVisit,
        nextVisitDate: nextDate,
        daysLate: Math.max(0, late),
      };
    });
  const within = o.eddWithinDays ?? 30;
  return {
    today,
    rows,
    eddSoon: rows
      .filter((r) => r.daysToEdd >= 0 && r.daysToEdd <= within)
      .sort((a, b) => a.eddFinal.localeCompare(b.eddFinal)),
    overdue: rows
      .filter((r) => r.daysLate > ANC_MISSED_AFTER_DAYS)
      .sort((a, b) => b.daysLate - a.daysLate),
    highRiskCount: rows.filter((r) => r.risks.length > 0).length,
  };
}

// ---------------------------------------------------------------- vaccines due

export interface VaccineDueRow {
  patientId: string;
  uhid: string;
  name: string;
  dob: string;
  age: Age;
  mobile: string | null;
  nextDueDate: string;
  /** Negative = overdue by that many days. */
  daysFromToday: number;
}

export interface VaccinesDue {
  today: string;
  /** Due from today to `aheadDays` ahead, soonest first. */
  thisWeek: VaccineDueRow[];
  /** Past their due date, most overdue first, with the phone number for the call. */
  overdue: VaccineDueRow[];
}

/** Vaccines due this week and overdue (docs/20 §2); one list entry per child (the next dose). */
export async function vaccinesDue(
  q: Queryable,
  facilityId: string,
  now: Date,
  o: { aheadDays?: number } = {},
): Promise<VaccinesDue> {
  const today = istDateString(now);
  const items = await dueSoon(q, facilityId, now, {
    lookBackDays: 3650,
    aheadDays: o.aheadDays ?? 7,
    limit: 5000,
  });
  const rows: VaccineDueRow[] = items.map((i) => ({
    patientId: i.patientId,
    uhid: i.uhid,
    name: i.name,
    dob: i.dob,
    age: ageFromDob(i.dob, parseIsoDate(today)),
    mobile: i.mobile,
    nextDueDate: i.nextDueDate,
    daysFromToday: i.daysFromToday,
  }));
  return {
    today,
    thisWeek: rows.filter((r) => r.daysFromToday >= 0),
    overdue: rows.filter((r) => r.daysFromToday < 0),
  };
}

// ---------------------------------------------------------------- owner dashboard

export interface DashboardAlert {
  kind: 'dayCloseDifference' | 'upiPending';
  /** The business day (and the cashier for a close difference). */
  ref: string;
  paise?: bigint;
}

export interface OwnerDashboard {
  today: string;
  /** OPD visits today by doctor, and in all. */
  opdToday: { total: number; byDoctor: { doctor: string; count: number }[] };
  /** Tokens still waiting for the doctor (any doctor). */
  waiting: number;
  collectionToday: ModeTotals & { collectedPaise: bigint; refundedPaise: bigint; netPaise: bigint };
  discountsToday: { count: number; totalPaise: bigint };
  cancellationsToday: {
    number: string;
    uhid: string;
    patientName: string;
    amountPaise: bigint;
    reasonLabel: string;
    issuedByName: string | null;
  }[];
  trend: { date: string; opd: number; netPaise: bigint }[];
  month: {
    opd: number;
    netPaise: bigint;
    /** The same days of the previous month, and its full total. */
    prevSamePeriod: { opd: number; netPaise: bigint };
    prevFull: { opd: number; netPaise: bigint };
  };
  alerts: DashboardAlert[];
}

/** Net collection per business day in a range (the daily collection report's own grouping). */
async function netByDay(q: Queryable, facilityId: string, from: string, to: string) {
  const rows = await q
    .select({
      d: sql<string>`${payment.businessDate}::text`,
      net: sql<string>`sum(${payment.amountPaise})::text`,
    })
    .from(payment)
    .where(
      and(
        eq(payment.facilityId, facilityId),
        gte(payment.businessDate, from),
        lte(payment.businessDate, to),
        countable,
      ),
    )
    .groupBy(payment.businessDate);
  return new Map(rows.map((r) => [r.d, BigInt(r.net)]));
}

/**
 * The owner's phone page (docs/20 §3): today at a glance, 30-day trend, month against last
 * month, and what needs attention. Every number is a report query over one day or a range, so a
 * figure here always equals the same report on screen.
 */
export async function ownerDashboard(
  q: Queryable,
  facilityId: string,
  now: Date,
): Promise<OwnerDashboard> {
  const today = istDateString(now);
  const w = monthWindows(today);
  const trendFrom = toIsoDate(addDays(parseIsoDate(today), -(DASHBOARD_TREND_DAYS - 1)));
  const wide = [w.prevMonthStart, trendFrom, w.monthStart].sort()[0]!;

  const [census, collection, discounts, cancellations, money, opdDays, waiting] = await Promise.all(
    [
      opdCensus(q, facilityId, { from: today, to: today }),
      collectionReport(q, facilityId, { from: today, to: today }),
      discountReport(q, facilityId, { from: today, to: today }),
      cancellationReport(q, facilityId, { from: today, to: today }),
      netByDay(q, facilityId, wide, today),
      opdCensus(q, facilityId, { from: wide, to: today }),
      q
        .select({ n: sql<number>`count(*)::int` })
        .from(opdToken)
        .innerJoin(encounter, eq(encounter.id, opdToken.encounterId))
        .where(
          and(
            eq(opdToken.facilityId, facilityId),
            eq(opdToken.tokenDate, today),
            inArray(opdToken.queueState, ['waiting', 'vitals_done']),
            eq(encounter.isRestricted, false),
          ),
        ),
    ],
  );
  const opdByDay = new Map(opdDays.byDay.map((d) => [d.date, d.count]));
  const sumRange = (from: string, to: string) => {
    let opd = 0;
    let netPaise = 0n;
    for (const d of eachDay(from, to)) {
      opd += opdByDay.get(d) ?? 0;
      netPaise += money.get(d) ?? 0n;
    }
    return { opd, netPaise };
  };

  const closes = await q
    .select({
      closeDate: sql<string>`${dayClose.closeDate}::text`,
      userName: appUser.fullName,
      difference: dayClose.differencePaise,
    })
    .from(dayClose)
    .innerJoin(appUser, eq(appUser.id, dayClose.userId))
    .where(
      and(
        eq(dayClose.facilityId, facilityId),
        eq(dayClose.kind, 'user'),
        ne(dayClose.differencePaise, 0n),
        gte(dayClose.closeDate, toIsoDate(addDays(parseIsoDate(today), -7))),
      ),
    )
    .orderBy(desc(dayClose.closeDate));
  const alerts: DashboardAlert[] = [
    ...closes.map((c): DashboardAlert => ({
      kind: 'dayCloseDifference',
      ref: `${c.closeDate} · ${c.userName}`,
      paise: c.difference,
    })),
    ...(await pendingUpiReconciliations(q, facilityId, today)).map((d): DashboardAlert => ({
      kind: 'upiPending',
      ref: d,
    })),
  ];

  return {
    today,
    opdToday: {
      total: census.total,
      byDoctor: census.rows.map((r) => ({ doctor: r.doctor, count: r.total })),
    },
    waiting: waiting[0]?.n ?? 0,
    collectionToday: {
      cashPaise: collection.total.cashPaise,
      upiPaise: collection.total.upiPaise,
      cardPaise: collection.total.cardPaise,
      otherPaise: collection.total.otherPaise,
      collectedPaise: collection.total.collectedPaise,
      refundedPaise: collection.total.refundedPaise,
      netPaise: collection.total.netPaise,
    },
    discountsToday: {
      count: discounts.rows.filter((r) => r.status === 'active').length,
      totalPaise: discounts.totalPaise,
    },
    cancellationsToday: cancellations.rows.map((r) => ({
      number: r.number,
      uhid: r.uhid,
      patientName: r.patientName,
      amountPaise: r.amountPaise,
      reasonLabel: r.reasonLabel,
      issuedByName: r.issuedByName,
    })),
    trend: eachDay(trendFrom, today).map((date) => ({
      date,
      opd: opdByDay.get(date) ?? 0,
      netPaise: money.get(date) ?? 0n,
    })),
    month: {
      ...sumRange(w.monthStart, today),
      prevSamePeriod: sumRange(w.prevMonthStart, w.prevSameDay),
      prevFull: sumRange(w.prevMonthStart, w.prevMonthEnd),
    },
    alerts,
  };
}
