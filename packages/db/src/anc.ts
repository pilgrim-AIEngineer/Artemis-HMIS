/**
 * Antenatal care (OPD-05, docs/11 §3): the pregnancy record with its dating, G P A L, ANC visits,
 * risk flags, the schedule with its due / overdue marks, the next-visit suggestion and the
 * closing outcome. Every write is one transaction and is audited by the table triggers; creating
 * a pregnancy is idempotent (AGENTS.md rule 9). Only one pregnancy per patient is `active`
 * (docs/04 §15.4, a partial unique index backs the check made here).
 *
 * MTP (docs/11 §3.1, docs/14): closing a pregnancy as `mtp` needs `mtp.register.edit`; everyone
 * without `mtp.register.view` sees such a pregnancy as plain "closed" with no date or reason, and
 * a permitted read is written to `access_log`. The earlier-pregnancy row an MTP leaves behind is an
 * ordinary `abortion`, indistinguishable from a spontaneous one.
 */
import {
  ageFromDob,
  assessRedating,
  bmi as bmiOf,
  checkLmp,
  computeGpal,
  DEFAULT_ANC_SCHEDULE,
  eddFromLmp,
  eddFromScan,
  evaluateRisks,
  formatGa,
  gaDaysOnDate,
  gpalConsistent,
  isHighRisk,
  istDateString,
  MASKED_PREGNANCY_STATUS,
  nextVisit,
  scheduleStates,
  splitGa,
  trimesterOf,
  type AncScheduleDef,
  type AncScheduleKind,
  type CreatePregnancyInput,
  type DatingBasis,
  type Gpal,
  type NextVisit,
  type ObOutcome,
  type ObHistoryEntry,
  type Plurality,
  type PregnancyStatus,
  type RedatingAssessment,
  type RiskFlag,
  type RiskInput,
  type ScheduleMark,
  type SaveAncVisitInput,
  type ManualRiskCode,
  addDays,
  parseIsoDate,
  toIsoDate,
  type ClosePregnancyInput,
  type ConfirmDatingInput,
  type MarkScheduleInput,
  type SaveHistoryInput,
  type SetGpalInput,
  type UpdatePregnancyInput,
} from '@hmis/shared';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  accessLog,
  ancScheduleItem,
  ancScheduleStatus,
  ancVisit,
  clinicalOrder,
  encounter,
  obstetricHistory,
  patient,
  patientAlert,
  pregnancy,
  service,
  vitals,
} from '../schema';
import type { Db } from './client';
import { runIdempotent } from './idempotency';
import { readSettings } from './settings';
import type { Tx } from './tx';

type Queryable = Db | Tx;
type PregnancyRow = typeof pregnancy.$inferSelect;
type VisitRow = typeof ancVisit.$inferSelect;

export type AncErrorKey =
  | 'anc.patientNotFound'
  | 'anc.notFemale'
  | 'anc.pregnancyNotFound'
  | 'anc.activeExists'
  | 'anc.notActive'
  | 'anc.lmpFuture'
  | 'anc.lmpTooOld'
  | 'anc.dateInvalid'
  | 'anc.datingNeeded'
  | 'anc.scanInFuture'
  | 'anc.scanBeforeLmp'
  | 'anc.datingBasisMissing'
  | 'anc.gpalInconsistent'
  | 'anc.visitDateRange'
  | 'anc.encounterMismatch'
  | 'anc.scheduleItemNotFound'
  | 'anc.doneDateRange'
  | 'anc.mtpForbidden'
  | 'anc.deliveryOutcomeNeeded'
  | 'anc.outcomeDateRange';

/** Input / state errors the router turns into i18n keys (docs/02 §7). */
export class AncInputError extends Error {
  constructor(readonly key: AncErrorKey) {
    super(key);
    this.name = 'AncInputError';
  }
}

export interface AncActor {
  facilityId: string;
  userId: string;
  /** MTP permissions of the caller (docs/03): decide what a closed pregnancy shows. */
  mtp: { view: boolean; edit: boolean };
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const str = (n: number | null): string | null => (n === null ? null : String(n));
const plusDays = (d: string, n: number) => toIsoDate(addDays(parseIsoDate(d), n));

// ---------------------------------------------------------------- schedule master

const rowToDef = (r: typeof ancScheduleItem.$inferSelect): AncScheduleDef => ({
  code: r.code,
  label: r.label,
  labelHi: r.labelHi,
  kind: r.kind as AncScheduleKind,
  gaFromDays: r.gaFromDays,
  gaToDays: r.gaToDays,
  atBooking: r.atBooking,
  rhNegativeOnly: r.rhNegativeOnly,
  afterCode: r.afterCode,
  afterDays: r.afterDays,
  serviceCodes: r.serviceCodes,
  sortOrder: r.sortOrder,
});

/** Inserts the draft schedule of docs/33 §4 for codes the facility does not have yet (idempotent). */
export async function seedAncSchedule(tx: Tx, facilityId: string): Promise<number> {
  const have = new Set(
    (
      await tx
        .select({ code: ancScheduleItem.code })
        .from(ancScheduleItem)
        .where(eq(ancScheduleItem.facilityId, facilityId))
    ).map((r) => r.code),
  );
  const fresh = DEFAULT_ANC_SCHEDULE.filter((d) => !have.has(d.code));
  if (fresh.length > 0) {
    await tx.insert(ancScheduleItem).values(
      fresh.map((d) => ({
        id: uuidv7(),
        facilityId,
        code: d.code,
        label: d.label,
        labelHi: d.labelHi,
        kind: d.kind,
        gaFromDays: d.gaFromDays,
        gaToDays: d.gaToDays,
        atBooking: d.atBooking,
        rhNegativeOnly: d.rhNegativeOnly,
        afterCode: d.afterCode,
        afterDays: d.afterDays,
        serviceCodes: d.serviceCodes,
        sortOrder: d.sortOrder,
      })),
    );
  }
  return fresh.length;
}

/** The facility's active schedule items; the built-in draft until the master has been seeded. */
async function scheduleItems(
  q: Queryable,
  facilityId: string,
): Promise<{ id: string | null; def: AncScheduleDef }[]> {
  const rows = await q
    .select()
    .from(ancScheduleItem)
    .where(and(eq(ancScheduleItem.facilityId, facilityId), eq(ancScheduleItem.isActive, true)))
    .orderBy(asc(ancScheduleItem.sortOrder));
  return rows.length > 0
    ? rows.map((r) => ({ id: r.id, def: rowToDef(r) }))
    : DEFAULT_ANC_SCHEDULE.map((def) => ({ id: null, def }));
}

// ---------------------------------------------------------------- rules in force

export interface AncRules {
  /** The owner gynaecologist has reviewed and signed the rules off. */
  signedOff: boolean;
  redatingThresholds: { fromDays: number; thresholdDays: number }[];
  riskRules: Record<string, number>;
  visitIntervals: { uptoDays: number | null; everyDays: number }[];
  viabilityWeeks: number;
  bookingGraceDays: number;
  schedule: AncScheduleDef[];
}

/** The ANC rules a screen shows next to the "pending sign-off" notice (docs/11 intro, docs/33 §4). */
export async function ancRules(q: Queryable, facilityId: string): Promise<AncRules> {
  const s = await readSettings(q, facilityId, [
    'anc.rulesSignedOff',
    'anc.redatingThresholds',
    'anc.riskRules',
    'anc.visitIntervals',
    'anc.viabilityWeeks',
    'anc.bookingGraceDays',
  ]);
  return {
    signedOff: s['anc.rulesSignedOff'],
    redatingThresholds: s['anc.redatingThresholds'],
    riskRules: s['anc.riskRules'],
    visitIntervals: s['anc.visitIntervals'],
    viabilityWeeks: s['anc.viabilityWeeks'],
    bookingGraceDays: s['anc.bookingGraceDays'],
    schedule: (await scheduleItems(q, facilityId)).map((i) => i.def),
  };
}

// ---------------------------------------------------------------- views

export interface AncHistoryRow {
  id: string;
  pregnancyNo: number;
  year: number | null;
  outcome: ObOutcome;
  gestationWeeks: number | null;
  place: string | null;
  complications: string | null;
  babiesAlive: number;
  neonatalDeath: boolean;
}

export interface AncVisitRow {
  id: string;
  encounterId: string | null;
  visitDate: string;
  gaDays: number;
  gaLabel: string;
  weightKg: number | null;
  bpSys: number | null;
  bpDia: number | null;
  fundalHeightCm: number | null;
  fhr: number | null;
  presentation: string | null;
  oedema: string | null;
  urineProtein: string | null;
  urineSugar: string | null;
  hb: number | null;
  remarks: string | null;
}

export interface AncScheduleRow {
  code: string;
  label: string;
  labelHi: string;
  kind: AncScheduleKind;
  state: string;
  windowFrom: string | null;
  windowTo: string | null;
  doneDate: string | null;
  /** Who set `done`: a person ticked it, or a completed order did it by itself. */
  source: 'manual' | 'order' | null;
}

export interface PregnancyView {
  id: string;
  patient: {
    id: string;
    uhid: string;
    fullName: string;
    nameHi: string | null;
    dob: string;
    ageYears: number | null;
    mobileLast4: string | null;
  };
  /** `closed` for an MTP outcome seen without MTP permission. */
  status: PregnancyStatus | typeof MASKED_PREGNANCY_STATUS;
  active: boolean;
  bookingDate: string;
  dating: {
    lmp: string | null;
    eddByLmp: string | null;
    eddByScan: string | null;
    eddFinal: string;
    basis: DatingBasis;
    scanDate: string | null;
    scanGaDays: number | null;
    decision: 'kept_lmp' | 'switched_to_scan' | null;
    /** LMP and scan both known: how far apart they are and what the table suggests. */
    redating: RedatingAssessment | null;
    /** The table suggests the scan EDD and nobody has decided yet. */
    redatingPending: boolean;
  };
  /** GA today; null once the pregnancy is closed. */
  ga: {
    days: number;
    label: string;
    weeks: number;
    extraDays: number;
    trimester: 1 | 2 | 3;
  } | null;
  gpal: Gpal & { manual: boolean; text: string };
  plurality: Plurality;
  bloodGroupRh: string | null;
  manualRisks: { code: ManualRiskCode; text: string | null }[];
  risks: RiskFlag[];
  highRisk: boolean;
  history: AncHistoryRow[];
  visits: AncVisitRow[];
  weightSeries: { date: string; gaDays: number; weightKg: number }[];
  schedule: AncScheduleRow[];
  nextVisit: NextVisit | null;
  outcome: { date: string; reason: string | null; encounterId: string | null } | null;
  notes: string | null;
  /** Owner gynaecologist has signed the ANC rules off (setting `anc.rulesSignedOff`). */
  rulesSignedOff: boolean;
}

async function historyRows(q: Queryable, facilityId: string, patientId: string) {
  return q
    .select()
    .from(obstetricHistory)
    .where(
      and(
        eq(obstetricHistory.facilityId, facilityId),
        eq(obstetricHistory.patientId, patientId),
        eq(obstetricHistory.status, 'active'),
      ),
    )
    .orderBy(asc(obstetricHistory.pregnancyNo));
}

const toHistory = (r: typeof obstetricHistory.$inferSelect): AncHistoryRow => ({
  id: r.id,
  pregnancyNo: r.pregnancyNo,
  year: r.year,
  outcome: r.outcome as ObOutcome,
  gestationWeeks: r.gestationWeeks,
  place: r.place,
  complications: r.complications,
  babiesAlive: r.babiesAlive,
  neonatalDeath: r.neonatalDeath,
});

const toVisit = (r: VisitRow): AncVisitRow => ({
  id: r.id,
  encounterId: r.encounterId,
  visitDate: r.visitDate,
  gaDays: r.gaDays,
  gaLabel: formatGa(r.gaDays),
  weightKg: num(r.weightKg),
  bpSys: r.bpSys,
  bpDia: r.bpDia,
  fundalHeightCm: num(r.fundalHeightCm),
  fhr: r.fhr,
  presentation: r.presentation,
  oedema: r.oedema,
  urineProtein: r.urineProtein,
  urineSugar: r.urineSugar,
  hb: num(r.hb),
  remarks: r.remarks,
});

async function visitRows(q: Queryable, facilityId: string, pregnancyId: string) {
  return q
    .select()
    .from(ancVisit)
    .where(
      and(
        eq(ancVisit.facilityId, facilityId),
        eq(ancVisit.pregnancyId, pregnancyId),
        eq(ancVisit.status, 'active'),
      ),
    )
    .orderBy(asc(ancVisit.visitDate));
}

/** Latest height on record for the patient (cm), from any vitals reading. */
async function latestHeight(q: Queryable, patientId: string): Promise<number | null> {
  const [r] = await q
    .select({ cm: vitals.heightCm })
    .from(vitals)
    .where(and(eq(vitals.patientId, patientId), isNotNull(vitals.heightCm)))
    .orderBy(desc(vitals.recordedAt))
    .limit(1);
  return r ? num(r.cm) : null;
}

function riskInput(args: {
  ageYears: number | null;
  heightCm: number | null;
  row: PregnancyRow;
  history: AncHistoryRow[];
  visits: AncVisitRow[];
  gaDays: number | null;
}): RiskInput {
  const first = args.visits.find((v) => v.weightKg !== null);
  return {
    ageYears: args.ageYears,
    heightCm: args.heightCm,
    bookingBmi:
      first && args.heightCm !== null ? bmiOf(first.weightKg as number, args.heightCm) : null,
    bps: args.visits.map((v) => ({ sys: v.bpSys, dia: v.bpDia })),
    hbs: args.visits.map((v) => v.hb),
    gpal: { g: args.row.gravida, p: args.row.para, a: args.row.abortions, l: args.row.living },
    history: args.history.map((h) => ({ outcome: h.outcome, neonatalDeath: h.neonatalDeath })),
    bloodGroupRh: args.row.bloodGroupRh,
    plurality: args.row.plurality as Plurality,
    gaDays: args.gaDays,
    manual: args.row.manualRisks.map((m) => ({
      code: m.code as ManualRiskCode,
      text: m.text ?? undefined,
    })),
  };
}

/** Orders completed for the patient since conception that tick schedule items by themselves. */
async function completedOrders(
  q: Queryable,
  facilityId: string,
  patientId: string,
  since: string,
): Promise<{ serviceCode: string; date: string }[]> {
  return q
    .select({ serviceCode: service.code, date: encounter.visitDate })
    .from(clinicalOrder)
    .innerJoin(service, eq(service.id, clinicalOrder.serviceId))
    .innerJoin(encounter, eq(encounter.id, clinicalOrder.encounterId))
    .where(
      and(
        eq(clinicalOrder.facilityId, facilityId),
        eq(clinicalOrder.patientId, patientId),
        eq(clinicalOrder.status, 'completed'),
        sql`${encounter.visitDate} >= ${since}`,
      ),
    );
}

/** A completed order this many days outside an item's window still counts for it. */
const ORDER_SLACK_DAYS = 7;

export interface ViewContext {
  now: Date;
}

async function buildView(
  q: Queryable,
  actor: AncActor,
  row: PregnancyRow,
  now: Date,
): Promise<PregnancyView> {
  const f = actor.facilityId;
  const today = istDateString(now);
  const [pt] = await q.select().from(patient).where(eq(patient.id, row.patientId));
  const [hist, visitList, items, marks, settings, heightCm] = await Promise.all([
    historyRows(q, f, row.patientId),
    visitRows(q, f, row.id),
    scheduleItems(q, f),
    q.select().from(ancScheduleStatus).where(eq(ancScheduleStatus.pregnancyId, row.id)),
    readSettings(q, f, [
      'anc.rulesSignedOff',
      'anc.redatingThresholds',
      'anc.riskRules',
      'anc.visitIntervals',
      'anc.bookingGraceDays',
    ]),
    latestHeight(q, row.patientId),
  ]);
  const active = row.status === 'active';
  const history = hist.map(toHistory);
  const visits = visitList.map(toVisit);
  const gaToday = active ? gaDaysOnDate(row.eddFinal, today) : null;
  const ageYears = (() => {
    const a = ageFromDob(pt!.dob, now);
    return a.unit === 'years' ? a.value : 0;
  })();

  const risks = evaluateRisks(
    riskInput({ ageYears, heightCm, row, history, visits, gaDays: gaToday }),
    settings['anc.riskRules'],
  );

  // Schedule: stored marks first, then completed orders for items nobody has marked.
  const idToCode = new Map(items.filter((i) => i.id).map((i) => [i.id as string, i.def.code]));
  const markMap = new Map<string, ScheduleMark>();
  const sources = new Map<string, 'manual' | 'order'>();
  for (const m of marks) {
    const code = idToCode.get(m.scheduleItemId);
    if (!code || m.status === 'due') continue;
    markMap.set(code, { status: m.status as 'done' | 'skipped', doneDate: m.doneDate });
    sources.set(code, 'manual');
  }
  const conception = plusDays(row.eddFinal, -280);
  const orders = active ? await completedOrders(q, f, row.patientId, conception) : [];
  const grace = settings['anc.bookingGraceDays'];
  const defs = items.map((i) => i.def);
  const pending = scheduleStates(
    defs,
    markMap,
    {
      gaDays: gaToday ?? 0,
      today,
      bookingDate: row.bookingDate,
      rhNegative: risks.some((r) => r.code === 'rh_negative'),
      bookingGraceDays: grace,
    },
    row.eddFinal,
  );
  for (const v of pending) {
    if (markMap.has(v.def.code) || v.state === 'not_applicable') continue;
    const lo = v.windowFrom ? plusDays(v.windowFrom, -ORDER_SLACK_DAYS) : conception;
    const hi = v.windowTo ? plusDays(v.windowTo, ORDER_SLACK_DAYS) : null;
    const hit = orders
      .filter(
        (o) =>
          v.def.serviceCodes.includes(o.serviceCode) &&
          o.date >= lo &&
          (hi === null || o.date <= hi),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    if (hit) {
      markMap.set(v.def.code, { status: 'done', doneDate: hit.date });
      sources.set(v.def.code, 'order');
    }
  }
  const states = scheduleStates(
    defs,
    markMap,
    {
      gaDays: gaToday ?? 0,
      today,
      bookingDate: row.bookingDate,
      rhNegative: risks.some((r) => r.code === 'rh_negative'),
      bookingGraceDays: grace,
    },
    row.eddFinal,
  );

  const last = visits[visits.length - 1];
  const next = active
    ? nextVisit({
        lastVisitDate: last?.visitDate ?? row.bookingDate,
        gaAtLastVisit: last?.gaDays ?? gaDaysOnDate(row.eddFinal, row.bookingDate),
        edd: row.eddFinal,
        today,
        intervals: settings['anc.visitIntervals'],
      })
    : null;

  const redating =
    row.lmp && row.scanDate && row.scanGaDays !== null
      ? assessRedating({
          lmp: row.lmp,
          scanDate: row.scanDate,
          gaAtScanDays: row.scanGaDays,
          table: settings['anc.redatingThresholds'],
        })
      : null;

  const masked = row.status === 'mtp' && !actor.mtp.view;
  if (row.status === 'mtp' && actor.mtp.view) {
    await q.insert(accessLog).values({
      id: uuidv7(),
      facilityId: f,
      userId: actor.userId,
      entity: 'pregnancy',
      entityId: row.id,
      purpose: 'mtp_pregnancy_view',
    });
  }
  const g: Gpal = { g: row.gravida, p: row.para, a: row.abortions, l: row.living };
  const ga = gaToday === null ? null : { ...splitGa(gaToday) };
  return {
    id: row.id,
    patient: {
      id: pt!.id,
      uhid: pt!.uhid,
      fullName: pt!.fullName,
      nameHi: pt!.nameHi,
      dob: pt!.dob,
      ageYears,
      mobileLast4: pt!.mobile ? pt!.mobile.slice(-4) : null,
    },
    status: masked ? MASKED_PREGNANCY_STATUS : (row.status as PregnancyStatus),
    active,
    bookingDate: row.bookingDate,
    dating: {
      lmp: row.lmp,
      eddByLmp: row.eddByLmp,
      eddByScan: row.eddByScan,
      eddFinal: row.eddFinal,
      basis: row.datingBasis as DatingBasis,
      scanDate: row.scanDate,
      scanGaDays: row.scanGaDays,
      decision: row.redatingDecision as 'kept_lmp' | 'switched_to_scan' | null,
      redating,
      redatingPending: active && !!redating?.suggestScan && row.redatingDecision === null,
    },
    ga:
      gaToday === null
        ? null
        : {
            days: gaToday,
            label: formatGa(gaToday),
            weeks: ga!.weeks,
            extraDays: ga!.days,
            trimester: trimesterOf(gaToday),
          },
    gpal: { ...g, manual: row.gpalManual, text: `G${g.g} P${g.p} A${g.a} L${g.l}` },
    plurality: row.plurality as Plurality,
    bloodGroupRh: row.bloodGroupRh,
    manualRisks: row.manualRisks.map((m) => ({
      code: m.code as ManualRiskCode,
      text: m.text ?? null,
    })),
    risks,
    highRisk: active && isHighRisk(risks),
    history,
    visits,
    weightSeries: visits
      .filter((v) => v.weightKg !== null)
      .map((v) => ({ date: v.visitDate, gaDays: v.gaDays, weightKg: v.weightKg as number })),
    // A closed pregnancy keeps what was done or skipped; nothing is "due" any more.
    schedule: states
      .filter((s) => active || s.state === 'done' || s.state === 'skipped')
      .map((s) => ({
        code: s.def.code,
        label: s.def.label,
        labelHi: s.def.labelHi,
        kind: s.def.kind,
        state: s.state,
        windowFrom: s.windowFrom,
        windowTo: s.windowTo,
        doneDate: s.doneDate,
        source: sources.get(s.def.code) ?? null,
      })),
    nextVisit: next,
    outcome:
      row.outcomeDate && !masked
        ? { date: row.outcomeDate, reason: row.closeReason, encounterId: row.outcomeEncounterId }
        : null,
    notes: row.notes,
    rulesSignedOff: settings['anc.rulesSignedOff'],
  };
}

async function loadRow(
  q: Queryable,
  facilityId: string,
  pregnancyId: string,
  lock = false,
): Promise<PregnancyRow> {
  const base = q
    .select()
    .from(pregnancy)
    .where(and(eq(pregnancy.id, pregnancyId), eq(pregnancy.facilityId, facilityId)));
  const [row] = lock ? await base.for('update') : await base;
  if (!row) throw new AncInputError('anc.pregnancyNotFound');
  return row;
}

async function loadActiveRow(tx: Tx, facilityId: string, pregnancyId: string) {
  const row = await loadRow(tx, facilityId, pregnancyId, true);
  if (row.status !== 'active') throw new AncInputError('anc.notActive');
  return row;
}

export async function getPregnancyView(
  q: Queryable,
  actor: AncActor,
  pregnancyId: string,
  now: Date,
): Promise<PregnancyView> {
  return buildView(q, actor, await loadRow(q, actor.facilityId, pregnancyId), now);
}

export interface PatientAnc {
  patient: { id: string; uhid: string; fullName: string; nameHi: string | null; sex: string };
  /** The patient may be pregnant (not male). */
  eligible: boolean;
  active: PregnancyView | null;
  /** Earlier pregnancies of this patient, newest first (MTP outcomes shown as "closed"). */
  past: {
    id: string;
    status: PregnancyStatus | typeof MASKED_PREGNANCY_STATUS;
    outcomeDate: string | null;
    eddFinal: string;
  }[];
  /** Earlier pregnancies to pre-fill a new record with (docs/04 `obstetric_history`). */
  history: AncHistoryRow[];
}

export async function patientAnc(
  q: Queryable,
  actor: AncActor,
  patientId: string,
  now: Date,
): Promise<PatientAnc> {
  const [pt] = await q
    .select({
      id: patient.id,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      sex: patient.sex,
      status: patient.status,
    })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.facilityId, actor.facilityId)));
  if (!pt || pt.status === 'cancelled') throw new AncInputError('anc.patientNotFound');
  const rows = await q
    .select()
    .from(pregnancy)
    .where(and(eq(pregnancy.patientId, patientId), eq(pregnancy.facilityId, actor.facilityId)))
    .orderBy(desc(pregnancy.createdAt));
  const activeRow = rows.find((r) => r.status === 'active');
  return {
    patient: { id: pt.id, uhid: pt.uhid, fullName: pt.fullName, nameHi: pt.nameHi, sex: pt.sex },
    eligible: pt.sex !== 'M',
    active: activeRow ? await buildView(q, actor, activeRow, now) : null,
    past: rows
      .filter((r) => r.status !== 'active')
      .map((r) => {
        const masked = r.status === 'mtp' && !actor.mtp.view;
        return {
          id: r.id,
          status: masked ? MASKED_PREGNANCY_STATUS : (r.status as PregnancyStatus),
          outcomeDate: masked ? null : r.outcomeDate,
          eddFinal: r.eddFinal,
        };
      }),
    history: (await historyRows(q, actor.facilityId, patientId)).map(toHistory),
  };
}

/** The patient's active pregnancy id, or null. */
export async function activePregnancyId(
  q: Queryable,
  facilityId: string,
  patientId: string,
): Promise<string | null> {
  const [r] = await q
    .select({ id: pregnancy.id })
    .from(pregnancy)
    .where(
      and(
        eq(pregnancy.facilityId, facilityId),
        eq(pregnancy.patientId, patientId),
        eq(pregnancy.status, 'active'),
      ),
    );
  return r?.id ?? null;
}

export interface ActivePregnancyItem {
  id: string;
  patientId: string;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  gaLabel: string;
  gaDays: number;
  eddFinal: string;
  gpalText: string;
  risks: RiskFlag[];
  lastVisit: string | null;
  nextVisit: NextVisit | null;
}

/** All active pregnancies, soonest EDD first: the ANC desk list and the base of the ANC register. */
export async function activePregnancies(
  q: Queryable,
  actor: AncActor,
  now: Date,
): Promise<ActivePregnancyItem[]> {
  const rows = await q
    .select()
    .from(pregnancy)
    .where(and(eq(pregnancy.facilityId, actor.facilityId), eq(pregnancy.status, 'active')))
    .orderBy(asc(pregnancy.eddFinal));
  const out: ActivePregnancyItem[] = [];
  for (const r of rows) {
    const v = await buildView(q, actor, r, now);
    out.push({
      id: v.id,
      patientId: v.patient.id,
      uhid: v.patient.uhid,
      fullName: v.patient.fullName,
      nameHi: v.patient.nameHi,
      gaLabel: v.ga?.label ?? '',
      gaDays: v.ga?.days ?? 0,
      eddFinal: v.dating.eddFinal,
      gpalText: v.gpal.text,
      risks: v.risks,
      lastVisit: v.visits[v.visits.length - 1]?.visitDate ?? null,
      nextVisit: v.nextVisit,
    });
  }
  return out;
}

// ---------------------------------------------------------------- derived state

/** Recomputes G P A L (unless hand-edited) and keeps the patient's high-risk alert in step. */
async function refreshDerived(tx: Tx, actor: AncActor, pregnancyId: string, now: Date) {
  const f = actor.facilityId;
  let row = await loadRow(tx, f, pregnancyId);
  if (row.status === 'active' && !row.gpalManual) {
    const { 'anc.viabilityWeeks': weeks } = await readSettings(tx, f, ['anc.viabilityWeeks']);
    const hist = await historyRows(tx, f, row.patientId);
    const g = computeGpal(
      hist.map((h): ObHistoryEntry => ({
        outcome: h.outcome as ObOutcome,
        gestationWeeks: h.gestationWeeks,
        babiesAlive: h.babiesAlive,
      })),
      weeks,
    );
    if (g.g !== row.gravida || g.p !== row.para || g.a !== row.abortions || g.l !== row.living) {
      await tx
        .update(pregnancy)
        .set({ gravida: g.g, para: g.p, abortions: g.a, living: g.l })
        .where(eq(pregnancy.id, pregnancyId));
    }
  }
  row = await loadRow(tx, f, pregnancyId);
  const view = await buildView(tx, { ...actor, mtp: { view: false, edit: false } }, row, now);
  const codes = view.risks.map((r) => r.code as string);
  const [alert] = await tx
    .select()
    .from(patientAlert)
    .where(
      and(
        eq(patientAlert.pregnancyId, pregnancyId),
        eq(patientAlert.kind, 'high_risk_pregnancy'),
        eq(patientAlert.active, true),
      ),
    );
  if (view.highRisk) {
    if (!alert) {
      await tx.insert(patientAlert).values({
        id: uuidv7(),
        facilityId: f,
        patientId: row.patientId,
        kind: 'high_risk_pregnancy',
        text: 'High-risk pregnancy',
        details: codes,
        pregnancyId,
      });
    } else if (JSON.stringify(alert.details) !== JSON.stringify(codes)) {
      await tx.update(patientAlert).set({ details: codes }).where(eq(patientAlert.id, alert.id));
    }
  } else if (alert) {
    await tx
      .update(patientAlert)
      .set({ active: false, resolvedAt: now })
      .where(eq(patientAlert.id, alert.id));
  }
}

async function replaceHistory(
  tx: Tx,
  actor: AncActor,
  patientId: string,
  entries: SaveHistoryInput['history'],
  now: Date,
) {
  await tx
    .update(obstetricHistory)
    .set({
      status: 'cancelled',
      cancelReason: 'replaced',
      cancelledBy: actor.userId,
      cancelledAt: now,
    })
    .where(
      and(
        eq(obstetricHistory.facilityId, actor.facilityId),
        eq(obstetricHistory.patientId, patientId),
        eq(obstetricHistory.status, 'active'),
      ),
    );
  if (entries.length === 0) return;
  await tx.insert(obstetricHistory).values(
    entries.map((e, i) => ({
      id: uuidv7(),
      facilityId: actor.facilityId,
      patientId,
      pregnancyNo: i + 1,
      year: e.year,
      outcome: e.outcome,
      gestationWeeks: e.gestationWeeks,
      place: e.place,
      complications: e.complications,
      babiesAlive: e.babiesAlive,
      neonatalDeath: e.neonatalDeath,
    })),
  );
}

async function recomputeVisitGa(tx: Tx, pregnancyId: string, edd: string) {
  const visits = await tx
    .select({ id: ancVisit.id, visitDate: ancVisit.visitDate, gaDays: ancVisit.gaDays })
    .from(ancVisit)
    .where(eq(ancVisit.pregnancyId, pregnancyId));
  for (const v of visits) {
    const ga = gaDaysOnDate(edd, v.visitDate);
    if (ga !== v.gaDays) await tx.update(ancVisit).set({ gaDays: ga }).where(eq(ancVisit.id, v.id));
  }
}

// ---------------------------------------------------------------- create

export async function createPregnancy(
  tx: Tx,
  actor: AncActor,
  input: CreatePregnancyInput,
  now: Date,
): Promise<{ pregnancyId: string }> {
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'anc.createPregnancy',
      key: input.idempotencyKey,
      payload: { ...input, idempotencyKey: undefined },
    },
    async () => {
      const f = actor.facilityId;
      const today = istDateString(now);
      // Locking the patient row serialises two desks opening a record for the same woman.
      const [pt] = await tx
        .select({ id: patient.id, sex: patient.sex, status: patient.status })
        .from(patient)
        .where(and(eq(patient.id, input.patientId), eq(patient.facilityId, f)))
        .for('update');
      if (!pt || pt.status === 'cancelled') throw new AncInputError('anc.patientNotFound');
      if (pt.sex === 'M') throw new AncInputError('anc.notFemale');
      if (await activePregnancyId(tx, f, input.patientId)) {
        throw new AncInputError('anc.activeExists');
      }

      let eddByLmp: string | null = null;
      if (input.lmp !== null) {
        const c = checkLmp(input.lmp, today);
        if (!c.ok) throw new AncInputError(c.error as AncErrorKey);
        eddByLmp = eddFromLmp(input.lmp);
      }
      let eddByScan: string | null = null;
      if (input.scan) {
        if (input.scan.date > today) throw new AncInputError('anc.scanInFuture');
        if (input.lmp !== null && input.scan.date < input.lmp) {
          throw new AncInputError('anc.scanBeforeLmp');
        }
        eddByScan = eddFromScan(input.scan.date, input.scan.ga);
      }
      const basis: DatingBasis = input.lmp !== null ? 'lmp' : 'scan';
      const eddFinal = (basis === 'lmp' ? eddByLmp : eddByScan) as string;
      // A scan-only pregnancy never drops below the GA found at the scan.
      const ga = gaDaysOnDate(eddFinal, today);
      if (ga < 0 || ga > 308) throw new AncInputError('anc.dateInvalid');

      const id = uuidv7();
      if (input.history !== undefined) {
        await replaceHistory(tx, actor, input.patientId, input.history, now);
      }
      const hist = await historyRows(tx, f, input.patientId);
      const { 'anc.viabilityWeeks': weeks } = await readSettings(tx, f, ['anc.viabilityWeeks']);
      const g = computeGpal(
        hist.map((h) => ({
          outcome: h.outcome as ObOutcome,
          gestationWeeks: h.gestationWeeks,
          babiesAlive: h.babiesAlive,
        })),
        weeks,
      );
      await tx.insert(pregnancy).values({
        id,
        facilityId: f,
        patientId: input.patientId,
        lmp: input.lmp,
        eddByLmp,
        eddByScan,
        eddFinal,
        datingBasis: basis,
        scanDate: input.scan?.date ?? null,
        scanGaDays: input.scan?.ga ?? null,
        bookingDate: today,
        gravida: g.g,
        para: g.p,
        abortions: g.a,
        living: g.l,
        plurality: input.plurality,
        bloodGroupRh: input.bloodGroupRh,
        notes: input.notes,
      });
      await refreshDerived(tx, actor, id, now);
      return { pregnancyId: id };
    },
  );
}

// ---------------------------------------------------------------- dating

/** What the scan says against the LMP, without saving anything (shown before the person confirms). */
export async function assessScan(
  q: Queryable,
  facilityId: string,
  input: { pregnancyId: string; scanDate: string; ga: number },
): Promise<{ assessment: RedatingAssessment | null; eddByScan: string }> {
  const row = await loadRow(q, facilityId, input.pregnancyId);
  const { 'anc.redatingThresholds': table } = await readSettings(q, facilityId, [
    'anc.redatingThresholds',
  ]);
  return {
    eddByScan: eddFromScan(input.scanDate, input.ga),
    assessment: row.lmp
      ? assessRedating({ lmp: row.lmp, scanDate: input.scanDate, gaAtScanDays: input.ga, table })
      : null,
  };
}

/**
 * Records the dating scan and the decision: switch `edd_final` to the scan EDD, or keep the LMP.
 * The suggestion is the table's; this is the person confirming it, and the row change (old and new
 * EDD) lands in `audit_log` through the table trigger (docs/11 §3.1).
 */
export async function confirmDating(
  tx: Tx,
  actor: AncActor,
  input: ConfirmDatingInput,
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  const today = istDateString(now);
  if (input.scanDate > today) throw new AncInputError('anc.scanInFuture');
  if (row.lmp && input.scanDate < row.lmp) throw new AncInputError('anc.scanBeforeLmp');
  if (input.basis === 'lmp' && !row.lmp) throw new AncInputError('anc.datingBasisMissing');
  const eddByScan = eddFromScan(input.scanDate, input.ga);
  const eddFinal = input.basis === 'scan' ? eddByScan : (row.eddByLmp as string);
  const ga = gaDaysOnDate(eddFinal, today);
  if (ga < 0 || ga > 308) throw new AncInputError('anc.dateInvalid');
  await tx
    .update(pregnancy)
    .set({
      scanDate: input.scanDate,
      scanGaDays: input.ga,
      eddByScan,
      eddFinal,
      datingBasis: input.basis,
      redatingDecision: input.basis === 'scan' ? 'switched_to_scan' : 'kept_lmp',
    })
    .where(eq(pregnancy.id, row.id));
  await recomputeVisitGa(tx, row.id, eddFinal);
  await refreshDerived(tx, actor, row.id, now);
}

// ---------------------------------------------------------------- record edits

export async function updatePregnancy(
  tx: Tx,
  actor: AncActor,
  input: UpdatePregnancyInput,
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  await tx
    .update(pregnancy)
    .set({
      bloodGroupRh: input.bloodGroupRh,
      plurality: input.plurality,
      manualRisks: input.manualRisks.map((m) => ({ code: m.code, text: m.text })),
      notes: input.notes,
    })
    .where(eq(pregnancy.id, row.id));
  await refreshDerived(tx, actor, row.id, now);
}

export async function saveHistory(
  tx: Tx,
  actor: AncActor,
  input: SaveHistoryInput,
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  await replaceHistory(tx, actor, row.patientId, input.history, now);
  await refreshDerived(tx, actor, row.id, now);
}

export async function setGpal(
  tx: Tx,
  actor: AncActor,
  input: SetGpalInput,
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  if (!input.manual) {
    await tx.update(pregnancy).set({ gpalManual: false }).where(eq(pregnancy.id, row.id));
  } else {
    const g = { g: input.g, p: input.p, a: input.a, l: input.l };
    if (!gpalConsistent(g)) throw new AncInputError('anc.gpalInconsistent');
    await tx
      .update(pregnancy)
      .set({ gpalManual: true, gravida: g.g, para: g.p, abortions: g.a, living: g.l })
      .where(eq(pregnancy.id, row.id));
  }
  await refreshDerived(tx, actor, row.id, now);
}

// ---------------------------------------------------------------- visits

async function assertEncounter(tx: Tx, facilityId: string, encounterId: string, patientId: string) {
  const [e] = await tx
    .select({ patientId: encounter.patientId })
    .from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.facilityId, facilityId)));
  if (!e || e.patientId !== patientId) throw new AncInputError('anc.encounterMismatch');
}

/**
 * Saves the ANC visit of a date (one per pregnancy and day): a new row, or the fields of the
 * existing one when the assistant adds the rest after vitals (docs/11 §3.3).
 */
export async function saveAncVisit(
  tx: Tx,
  actor: AncActor,
  input: SaveAncVisitInput,
  now: Date,
): Promise<{ visitId: string }> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  const today = istDateString(now);
  const conception = plusDays(row.eddFinal, -280);
  if (input.visitDate > today || input.visitDate < conception) {
    throw new AncInputError('anc.visitDateRange');
  }
  if (input.encounterId) {
    await assertEncounter(tx, actor.facilityId, input.encounterId, row.patientId);
  }
  const values = {
    encounterId: input.encounterId,
    gaDays: gaDaysOnDate(row.eddFinal, input.visitDate),
    weightKg: str(input.weightKg),
    bpSys: input.bpSys,
    bpDia: input.bpDia,
    fundalHeightCm: str(input.fundalHeightCm),
    fhr: input.fhr,
    presentation: input.presentation,
    oedema: input.oedema,
    urineProtein: input.urineProtein,
    urineSugar: input.urineSugar,
    hb: str(input.hb),
    remarks: input.remarks,
  };
  const [existing] = await tx
    .select({ id: ancVisit.id, encounterId: ancVisit.encounterId })
    .from(ancVisit)
    .where(
      and(
        eq(ancVisit.pregnancyId, row.id),
        eq(ancVisit.visitDate, input.visitDate),
        eq(ancVisit.status, 'active'),
      ),
    );
  let visitId: string;
  if (existing) {
    visitId = existing.id;
    await tx
      .update(ancVisit)
      .set({ ...values, encounterId: input.encounterId ?? existing.encounterId })
      .where(eq(ancVisit.id, visitId));
  } else {
    visitId = uuidv7();
    await tx.insert(ancVisit).values({
      id: visitId,
      facilityId: actor.facilityId,
      pregnancyId: row.id,
      visitDate: input.visitDate,
      ...values,
    });
  }
  const eid = input.encounterId ?? existing?.encounterId ?? null;
  if (eid) {
    await tx.update(encounter).set({ pregnancyId: row.id }).where(eq(encounter.id, eid));
  }
  await refreshDerived(tx, actor, row.id, now);
  return { visitId };
}

export async function cancelAncVisit(
  tx: Tx,
  actor: AncActor,
  input: { pregnancyId: string; visitId: string; reason: string },
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  await tx
    .update(ancVisit)
    .set({
      status: 'cancelled',
      cancelReason: input.reason,
      cancelledBy: actor.userId,
      cancelledAt: now,
    })
    .where(
      and(
        eq(ancVisit.id, input.visitId),
        eq(ancVisit.pregnancyId, row.id),
        eq(ancVisit.status, 'active'),
      ),
    );
  await refreshDerived(tx, actor, row.id, now);
}

/**
 * Called when the vitals desk saves a reading: if the woman has an active pregnancy and the
 * pregnant form (or an ANC visit) was used, the readings flow into that day's ANC visit row, which
 * the assistant then completes (docs/11 §3.3). Does nothing for other patients.
 */
export async function syncAncVisitFromVitals(
  tx: Tx,
  actor: AncActor,
  args: { encounterId: string; patientId: string; formGroup: string; visitType: string },
  now: Date,
): Promise<string | null> {
  if (args.formGroup !== 'pregnant' && args.visitType !== 'anc') return null;
  const pregnancyId = await activePregnancyId(tx, actor.facilityId, args.patientId);
  if (!pregnancyId) return null;
  const [enc] = await tx
    .select({ visitDate: encounter.visitDate })
    .from(encounter)
    .where(eq(encounter.id, args.encounterId));
  const [v] = await tx
    .select()
    .from(vitals)
    .where(and(eq(vitals.encounterId, args.encounterId), eq(vitals.status, 'active')));
  if (!enc || !v) return null;
  const row = await loadRow(tx, actor.facilityId, pregnancyId, true);
  const own = {
    weightKg: v.weightKg,
    bpSys: v.bpSys,
    bpDia: v.bpDia,
    fundalHeightCm: v.fundalHeightCm,
    fhr: v.fhr,
    oedema: v.oedema,
    urineProtein: v.urineAlbumin,
    urineSugar: v.urineSugar,
  };
  const [existing] = await tx
    .select({ id: ancVisit.id })
    .from(ancVisit)
    .where(
      and(
        eq(ancVisit.pregnancyId, row.id),
        eq(ancVisit.visitDate, enc.visitDate),
        eq(ancVisit.status, 'active'),
      ),
    );
  if (existing) {
    await tx
      .update(ancVisit)
      .set({ ...own, encounterId: args.encounterId })
      .where(eq(ancVisit.id, existing.id));
  } else {
    await tx.insert(ancVisit).values({
      id: uuidv7(),
      facilityId: actor.facilityId,
      pregnancyId: row.id,
      encounterId: args.encounterId,
      visitDate: enc.visitDate,
      gaDays: gaDaysOnDate(row.eddFinal, enc.visitDate),
      ...own,
    });
  }
  await tx.update(encounter).set({ pregnancyId: row.id }).where(eq(encounter.id, args.encounterId));
  await refreshDerived(tx, actor, row.id, now);
  return row.id;
}

// ---------------------------------------------------------------- schedule marks

export async function markScheduleItem(
  tx: Tx,
  actor: AncActor,
  input: MarkScheduleInput,
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  const item = (await scheduleItems(tx, actor.facilityId)).find((i) => i.def.code === input.code);
  if (!item) throw new AncInputError('anc.scheduleItemNotFound');
  let itemId = item.id;
  if (!itemId) {
    // Master not seeded yet: seed it now so the mark has a row to point at.
    await seedAncSchedule(tx, actor.facilityId);
    const [r] = await tx
      .select({ id: ancScheduleItem.id })
      .from(ancScheduleItem)
      .where(
        and(eq(ancScheduleItem.facilityId, actor.facilityId), eq(ancScheduleItem.code, input.code)),
      );
    itemId = r!.id;
  }
  const today = istDateString(now);
  const doneDate = input.status === 'done' ? (input.doneDate ?? today) : null;
  if (doneDate && (doneDate > today || doneDate < plusDays(row.eddFinal, -280))) {
    throw new AncInputError('anc.doneDateRange');
  }
  await tx
    .insert(ancScheduleStatus)
    .values({
      id: uuidv7(),
      facilityId: actor.facilityId,
      pregnancyId: row.id,
      scheduleItemId: itemId,
      status: input.status,
      doneDate,
    })
    .onConflictDoUpdate({
      target: [ancScheduleStatus.pregnancyId, ancScheduleStatus.scheduleItemId],
      set: { status: input.status, doneDate },
    });
}

// ---------------------------------------------------------------- close

/**
 * Closes the active pregnancy with its outcome (docs/11 §3.1). A delivery, abortion, MTP or
 * ectopic leaves an `obstetric_history` row so the next pregnancy's G P A L is right; an MTP
 * needs MTP-edit permission and reads as "closed" to everyone else.
 */
export async function closePregnancy(
  tx: Tx,
  actor: AncActor,
  input: ClosePregnancyInput,
  now: Date,
): Promise<void> {
  const row = await loadActiveRow(tx, actor.facilityId, input.pregnancyId);
  if (input.outcome === 'mtp' && !actor.mtp.edit) throw new AncInputError('anc.mtpForbidden');
  const today = istDateString(now);
  if (input.outcomeDate > today || input.outcomeDate < plusDays(row.eddFinal, -280)) {
    throw new AncInputError('anc.outcomeDateRange');
  }
  const gaAtOutcome = gaDaysOnDate(row.eddFinal, input.outcomeDate);
  const gestationWeeks = Math.max(4, Math.min(45, Math.floor(gaAtOutcome / 7)));
  const year = Number(input.outcomeDate.slice(0, 4));

  let history: { outcome: ObOutcome; babiesAlive: number; neonatalDeath: boolean } | null = null;
  switch (input.outcome) {
    case 'delivered': {
      if (!input.obOutcome) throw new AncInputError('anc.deliveryOutcomeNeeded');
      const babies = row.plurality === 'single' ? 1 : row.plurality === 'twins' ? 2 : 3;
      history = {
        outcome: input.obOutcome,
        babiesAlive: input.babiesAlive ?? (input.obOutcome === 'stillbirth' ? 0 : babies),
        neonatalDeath: input.neonatalDeath,
      };
      break;
    }
    case 'aborted':
    case 'mtp':
      history = { outcome: 'abortion', babiesAlive: 0, neonatalDeath: false };
      break;
    case 'ectopic':
      history = { outcome: 'ectopic', babiesAlive: 0, neonatalDeath: false };
      break;
    default:
      break;
  }

  await tx
    .update(pregnancy)
    .set({
      status: input.outcome,
      outcomeDate: input.outcomeDate,
      closeReason: input.reason,
      closedBy: actor.userId,
      closedAt: now,
    })
    .where(eq(pregnancy.id, row.id));
  if (history) {
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${obstetricHistory.pregnancyNo}), 0)::int` })
      .from(obstetricHistory)
      .where(
        and(eq(obstetricHistory.patientId, row.patientId), eq(obstetricHistory.status, 'active')),
      );
    await tx.insert(obstetricHistory).values({
      id: uuidv7(),
      facilityId: actor.facilityId,
      patientId: row.patientId,
      pregnancyNo: (last?.n ?? 0) + 1,
      year,
      outcome: history.outcome,
      gestationWeeks,
      babiesAlive: history.babiesAlive,
      neonatalDeath: history.neonatalDeath,
    });
  }
  // The alert ends with the pregnancy.
  await tx
    .update(patientAlert)
    .set({ active: false, resolvedAt: now })
    .where(and(eq(patientAlert.pregnancyId, row.id), eq(patientAlert.active, true)));
}

// ---------------------------------------------------------------- summaries

export interface AncSummary {
  pregnancyId: string;
  gaLabel: string;
  gaDays: number;
  eddFinal: string;
  gpalText: string;
  risks: RiskFlag[];
  /** Last three visits, newest first: BP and weight (docs/10 §8). */
  lastVisits: { date: string; bp: string | null; weightKg: number | null }[];
  testsDue: { label: string; labelHi: string }[];
  testsOverdue: { label: string; labelHi: string }[];
  td: 'done' | 'due' | 'overdue' | 'upcoming' | 'skipped';
}

/** A short ANC line for the doctor's sheet and the patient header; null when no active pregnancy. */
export async function ancSummary(
  q: Queryable,
  actor: AncActor,
  patientId: string,
  now: Date,
): Promise<AncSummary | null> {
  const id = await activePregnancyId(q, actor.facilityId, patientId);
  if (!id) return null;
  const v = await getPregnancyView(q, actor, id, now);
  const open = (s: string) =>
    v.schedule
      .filter((i) => i.state === s && i.kind !== 'supplement')
      .map((i) => ({ label: i.label, labelHi: i.labelHi }));
  const td = v.schedule.find((i) => i.code === 'td_1');
  return {
    pregnancyId: v.id,
    gaLabel: v.ga?.label ?? '',
    gaDays: v.ga?.days ?? 0,
    eddFinal: v.dating.eddFinal,
    gpalText: v.gpal.text,
    risks: v.risks,
    lastVisits: [...v.visits]
      .reverse()
      .slice(0, 3)
      .map((x) => ({
        date: x.visitDate,
        bp: x.bpSys !== null ? `${x.bpSys}/${x.bpDia}` : null,
        weightKg: x.weightKg,
      })),
    testsDue: open('due'),
    testsOverdue: open('overdue'),
    td: (td?.state === 'not_applicable'
      ? 'upcoming'
      : (td?.state ?? 'upcoming')) as AncSummary['td'],
  };
}
