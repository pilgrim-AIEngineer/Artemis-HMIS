/**
 * Token queue (REG-04, docs/10 §5): the state machine, "call next", recall, skip, transfer, no-show
 * and the board read model. Every change is one transaction that updates the token and appends a
 * `queue_event`; the `opd_token` trigger (migration 0013) notifies listeners on commit.
 *
 * Concurrency: per-doctor, per-day advisory lock (`queue:` key) serialises call-next / skip so two
 * doctor-room tablets never pick the same patient; token numbers use the separate token lock.
 */
import {
  ACTIVE_STATES,
  canTransition,
  compareQueue,
  istDateString,
  orderAfterSkip,
  PENDING_STATES,
  QUEUE_ORDER_STEP,
  type PriorityClass,
  type QueuePriority,
  type QueueState,
  type VisitType,
} from '@hmis/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  consultationRule,
  doctorProfile,
  encounter,
  facility,
  opdToken,
  patient,
  queueEvent,
} from '../schema';
import { cancelBillsOfVisit } from './billing';
import type { Db } from './client';
import { allocateDailyToken } from './number-series';
import { readSetting } from './settings';
import { withTx, type Tx } from './tx';
import { VisitInputError, type Actor } from './visits';

type TokenRow = typeof opdToken.$inferSelect;

async function lockQueue(tx: Tx, facilityId: string, doctorId: string, date: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`queue:${facilityId}:${doctorId}:${date}`}, 0))`,
  );
}

/** Loads and row-locks a token of the actor's facility. */
async function loadToken(tx: Tx, facilityId: string, tokenId: string): Promise<TokenRow> {
  const [row] = await tx
    .select()
    .from(opdToken)
    .where(and(eq(opdToken.id, tokenId), eq(opdToken.facilityId, facilityId)))
    .for('update');
  if (!row) throw new VisitInputError('queue.tokenNotFound');
  return row;
}

async function priorityOrder(tx: Tx, facilityId: string): Promise<PriorityClass[]> {
  return (await readSetting(tx, facilityId, 'queue.priorityOrder')) as PriorityClass[];
}

interface Move {
  action: string;
  reason?: string | null;
  /** Extra columns to set with the state change. */
  set?: Partial<typeof opdToken.$inferInsert>;
}

const STAMP: Partial<Record<QueueState, 'vitalsAt' | 'calledAt' | 'seenAt' | 'doneAt'>> = {
  vitals_done: 'vitalsAt',
  with_doctor: 'calledAt',
  seen: 'seenAt',
  done: 'doneAt',
};

/** Applies a validated state change and records the event. */
async function move(
  tx: Tx,
  actor: Actor,
  token: TokenRow,
  to: QueueState,
  now: Date,
  m: Move,
): Promise<TokenRow> {
  const from = token.queueState as QueueState;
  if (!canTransition(from, to)) throw new VisitInputError('queue.invalidTransition');
  const stamp = STAMP[to];
  const [updated] = await tx
    .update(opdToken)
    .set({
      queueState: to,
      stateReason: to === 'no_show' || to === 'cancelled' ? (m.reason ?? null) : null,
      ...(stamp ? { [stamp]: now } : {}),
      ...m.set,
    })
    .where(eq(opdToken.id, token.id))
    .returning();
  await tx.insert(queueEvent).values({
    id: uuidv7(),
    facilityId: actor.facilityId,
    tokenId: token.id,
    fromState: from,
    toState: to,
    byUser: actor.userId,
    at: now,
    action: m.action,
  });
  return updated!;
}

/** Pending tokens of the doctor's day, in queue order. */
async function pendingQueue(tx: Tx, facilityId: string, doctorId: string, date: string) {
  const [order, rows] = await Promise.all([
    priorityOrder(tx, facilityId),
    tx
      .select()
      .from(opdToken)
      .where(
        and(
          eq(opdToken.facilityId, facilityId),
          eq(opdToken.doctorId, doctorId),
          eq(opdToken.tokenDate, date),
          inArray(opdToken.queueState, [...PENDING_STATES]),
        ),
      ),
  ]);
  return rows.sort((a, b) =>
    compareQueue(
      { ...a, priority: a.priority as QueuePriority },
      { ...b, priority: b.priority as QueuePriority },
      order,
    ),
  );
}

// ---------------------------------------------------------------- doctor-room actions

/** "Call next": the first pending token of the doctor's day goes to `with_doctor`. */
export async function callNext(tx: Tx, actor: Actor, doctorId: string, now: Date) {
  const date = istDateString(now);
  await lockQueue(tx, actor.facilityId, doctorId, date);
  const [next] = await pendingQueue(tx, actor.facilityId, doctorId, date);
  if (!next) throw new VisitInputError('queue.nothingWaiting');
  const locked = await loadToken(tx, actor.facilityId, next.id);
  return move(tx, actor, locked, 'with_doctor', now, { action: 'call' });
}

/** "Send in" a chosen token (not necessarily the first). */
export async function sendIn(tx: Tx, actor: Actor, tokenId: string, now: Date) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  return move(tx, actor, t, 'with_doctor', now, { action: 'call' });
}

/** Announce the called patient again (TV chime): count only, the state stays `with_doctor`. */
export async function recall(tx: Tx, actor: Actor, tokenId: string, now: Date) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  if (t.queueState !== 'with_doctor') throw new VisitInputError('queue.invalidTransition');
  const [updated] = await tx
    .update(opdToken)
    .set({ recallCount: sql`${opdToken.recallCount} + 1` })
    .where(eq(opdToken.id, t.id))
    .returning();
  await tx.insert(queueEvent).values({
    id: uuidv7(),
    facilityId: actor.facilityId,
    tokenId: t.id,
    fromState: 'with_doctor',
    toState: 'with_doctor',
    byUser: actor.userId,
    at: now,
    action: 'recall',
  });
  return updated!;
}

/**
 * Skip: the patient goes behind the next three waiting patients of the same priority class. A
 * called patient who did not come in returns to the queue (`vitals_done` if the vitals were taken).
 */
export async function skip(tx: Tx, actor: Actor, tokenId: string, now: Date) {
  const probe = await loadToken(tx, actor.facilityId, tokenId);
  await lockQueue(tx, actor.facilityId, probe.doctorId, probe.tokenDate);
  const t = await loadToken(tx, actor.facilityId, tokenId);
  const from = t.queueState as QueueState;
  if (from !== 'with_doctor' && !PENDING_STATES.includes(from)) {
    throw new VisitInputError('queue.invalidTransition');
  }
  const behind = (await pendingQueue(tx, actor.facilityId, t.doctorId, t.tokenDate))
    .filter((x) => x.id !== t.id && x.priority === t.priority && x.queueOrder > t.queueOrder)
    .map((x) => x.queueOrder);
  const queueOrder = orderAfterSkip(t.queueOrder, behind);
  const to: QueueState = from === 'with_doctor' ? (t.vitalsAt ? 'vitals_done' : 'waiting') : from;
  if (to === from) {
    const [u] = await tx
      .update(opdToken)
      .set({ queueOrder })
      .where(eq(opdToken.id, t.id))
      .returning();
    await tx.insert(queueEvent).values({
      id: uuidv7(),
      facilityId: actor.facilityId,
      tokenId: t.id,
      fromState: from,
      toState: to,
      byUser: actor.userId,
      at: now,
      action: 'skip',
    });
    return u!;
  }
  return move(tx, actor, t, to, now, { action: 'skip', set: { queueOrder } });
}

/** `seen`: the sheet came back or the assistant pressed "Seen". */
export async function markSeen(tx: Tx, actor: Actor, tokenId: string, now: Date) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  return move(tx, actor, t, 'seen', now, { action: 'seen' });
}

/** Manual `done` (the automatic rule joins with the Rx and billing PRs). */
export async function markDone(tx: Tx, actor: Actor, tokenId: string, now: Date) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  return move(tx, actor, t, 'done', now, { action: 'done' });
}

/**
 * Generic forward step for other modules (vitals desk → `vitals_done`, Rx transcription →
 * `rx_entered`, billing → `billed_orders`/`done`). Same state machine, same event log.
 */
export async function advanceToken(
  tx: Tx,
  actor: Actor,
  tokenId: string,
  to: QueueState,
  now: Date,
  action = 'advance',
) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  return move(tx, actor, t, to, now, { action });
}

// ---------------------------------------------------------------- reception actions

export async function markNoShow(tx: Tx, actor: Actor, tokenId: string, reason: string, now: Date) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  return move(tx, actor, t, 'no_show', now, { action: 'no_show', reason });
}

/** A late patient comes back on the same day: `no_show` → `waiting`, behind the others. */
export async function reinstate(tx: Tx, actor: Actor, tokenId: string, now: Date) {
  const probe = await loadToken(tx, actor.facilityId, tokenId);
  if (probe.tokenDate !== istDateString(now)) throw new VisitInputError('queue.notToday');
  return move(tx, actor, probe, 'waiting', now, { action: 'reinstate' });
}

export async function setPriority(
  tx: Tx,
  actor: Actor,
  tokenId: string,
  priority: QueuePriority,
  now: Date,
) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  const state = t.queueState as QueueState;
  if (!PENDING_STATES.includes(state)) throw new VisitInputError('queue.notPending');
  if (t.priority === priority) return t;
  const [updated] = await tx
    .update(opdToken)
    .set({ priority })
    .where(eq(opdToken.id, t.id))
    .returning();
  await tx.update(encounter).set({ priority }).where(eq(encounter.id, t.encounterId));
  await tx.insert(queueEvent).values({
    id: uuidv7(),
    facilityId: actor.facilityId,
    tokenId: t.id,
    fromState: state,
    toState: state,
    byUser: actor.userId,
    at: now,
    action: 'priority',
  });
  return updated!;
}

/**
 * Moves a waiting patient to another doctor's queue: a new number from that doctor's day counter,
 * placed by that number (behind everyone already there). The consultation fee is unchanged.
 */
export async function transfer(
  tx: Tx,
  actor: Actor,
  tokenId: string,
  newDoctorId: string,
  now: Date,
) {
  const t = await loadToken(tx, actor.facilityId, tokenId);
  const state = t.queueState as QueueState;
  if (!PENDING_STATES.includes(state) && state !== 'with_doctor') {
    throw new VisitInputError('queue.invalidTransition');
  }
  if (t.doctorId === newDoctorId) throw new VisitInputError('queue.sameDoctor');
  if (t.tokenDate !== istDateString(now)) throw new VisitInputError('queue.notToday');
  const [doctor] = await tx
    .select({ id: doctorProfile.id, departmentId: doctorProfile.departmentId })
    .from(doctorProfile)
    .where(
      and(
        eq(doctorProfile.id, newDoctorId),
        eq(doctorProfile.facilityId, actor.facilityId),
        eq(doctorProfile.status, 'active'),
        eq(doctorProfile.isActive, true),
      ),
    );
  if (!doctor) throw new VisitInputError('visit.doctorNotFound');

  const { tokenNo } = await allocateDailyToken(tx, {
    facilityId: actor.facilityId,
    doctorId: newDoctorId,
    at: now,
    currentMax: async (q, date) => {
      const [row] = await q
        .select({ max: sql<number | null>`max(${opdToken.tokenNo})` })
        .from(opdToken)
        .where(and(eq(opdToken.doctorId, newDoctorId), eq(opdToken.tokenDate, date)));
      return row?.max ?? null;
    },
  });
  const to: QueueState = state === 'with_doctor' ? (t.vitalsAt ? 'vitals_done' : 'waiting') : state;
  const [updated] = await tx
    .update(opdToken)
    .set({
      doctorId: newDoctorId,
      tokenNo,
      queueOrder: tokenNo * QUEUE_ORDER_STEP,
      queueState: to,
    })
    .where(eq(opdToken.id, t.id))
    .returning();
  await tx
    .update(encounter)
    .set({ doctorId: newDoctorId, departmentId: doctor.departmentId })
    .where(eq(encounter.id, t.encounterId));
  await tx.insert(queueEvent).values({
    id: uuidv7(),
    facilityId: actor.facilityId,
    tokenId: t.id,
    fromState: state,
    toState: to,
    byUser: actor.userId,
    at: now,
    action: 'transfer',
  });
  return updated!;
}

/**
 * Cancels a visit that has not been seen yet, with its token and its draft bill. A bill with
 * money on it blocks the cancellation until BIL-04 adds credit notes and refunds.
 */
export async function cancelVisit(
  tx: Tx,
  actor: Actor,
  encounterId: string,
  reason: string,
  now: Date,
) {
  const [enc] = await tx
    .select()
    .from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.facilityId, actor.facilityId)))
    .for('update');
  if (!enc) throw new VisitInputError('visit.notFound');
  if (enc.status !== 'open') throw new VisitInputError('visit.notOpen');
  const [token] = await tx.select().from(opdToken).where(eq(opdToken.encounterId, encounterId));
  if (token) {
    const locked = await loadToken(tx, actor.facilityId, token.id);
    await move(tx, actor, locked, 'cancelled', now, { action: 'cancel', reason }).catch((e) => {
      if (e instanceof VisitInputError && e.key === 'queue.invalidTransition') {
        throw new VisitInputError('visit.notCancellable');
      }
      throw e;
    });
  }
  if ((await cancelBillsOfVisit(tx, actor, encounterId, reason, now)) === 'has_money') {
    throw new VisitInputError('visit.billHasPayments');
  }
  await tx
    .update(encounter)
    .set({ status: 'cancelled', cancelReason: reason, cancelledBy: actor.userId, cancelledAt: now })
    .where(eq(encounter.id, encounterId));
}

/**
 * End of day: tokens of `date` that were never called become `no_show` with a reason (docs/10 §5).
 * System work, so `byUser` is the optional actor. Returns how many changed.
 */
export async function autoNoShow(tx: Tx, facilityId: string, date: string, now: Date) {
  const rows = await tx
    .select()
    .from(opdToken)
    .where(
      and(
        eq(opdToken.facilityId, facilityId),
        eq(opdToken.tokenDate, date),
        inArray(opdToken.queueState, [...PENDING_STATES]),
      ),
    )
    .orderBy(asc(opdToken.doctorId), asc(opdToken.tokenNo))
    .for('update');
  for (const t of rows) {
    await move(tx, { facilityId, userId: null }, t, 'no_show', now, {
      action: 'auto_no_show',
      reason: 'Not seen by end of day',
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------- read model

export interface BoardToken {
  tokenId: string;
  encounterId: string;
  tokenNo: number;
  priority: QueuePriority;
  queueState: QueueState;
  visitType: VisitType;
  visitNumber: string;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  dob: string;
  sex: string;
  issuedAt: Date;
  vitalsAt: Date | null;
  calledAt: Date | null;
  seenAt: Date | null;
  recallCount: number;
  stateReason: string | null;
}

export interface BoardColumn {
  doctor: { id: string; displayName: string; displayNameHi: string | null };
  /** Pending and in-progress tokens in queue order. */
  active: BoardToken[];
  /** Done / no-show / cancelled, latest first. */
  finished: BoardToken[];
}

export interface AwaitingToken {
  encounterId: string;
  visitNumber: string;
  doctorId: string;
  fullName: string;
  uhid: string;
  visitType: VisitType;
  feePaise: string;
  feeBasis: string;
  startedAt: Date;
}

export interface QueueBoard {
  date: string;
  columns: BoardColumn[];
  /** Visits made today whose token is not issued yet (fee to collect or to check). */
  awaitingToken: AwaitingToken[];
}

/**
 * The day's board: one column per OPD doctor (a doctor with a consultation rule, or with a token
 * today), optionally limited to `doctorIds`. Includes patient names, so the caller needs
 * `patient.view`.
 */
export async function queueBoard(
  tx: Tx,
  facilityId: string,
  q: { doctorIds?: string[] },
  now: Date,
): Promise<QueueBoard> {
  const date = istDateString(now);
  const order = await priorityOrder(tx, facilityId);

  const tokens = await tx
    .select({
      tokenId: opdToken.id,
      encounterId: opdToken.encounterId,
      doctorId: opdToken.doctorId,
      tokenNo: opdToken.tokenNo,
      priority: opdToken.priority,
      queueState: opdToken.queueState,
      queueOrder: opdToken.queueOrder,
      visitType: encounter.visitType,
      visitNumber: encounter.number,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      issuedAt: opdToken.issuedAt,
      vitalsAt: opdToken.vitalsAt,
      calledAt: opdToken.calledAt,
      seenAt: opdToken.seenAt,
      doneAt: opdToken.doneAt,
      recallCount: opdToken.recallCount,
      stateReason: opdToken.stateReason,
      updatedAt: opdToken.updatedAt,
    })
    .from(opdToken)
    .innerJoin(encounter, eq(encounter.id, opdToken.encounterId))
    .innerJoin(patient, eq(patient.id, encounter.patientId))
    .where(
      and(
        eq(opdToken.facilityId, facilityId),
        eq(opdToken.tokenDate, date),
        q.doctorIds?.length ? inArray(opdToken.doctorId, q.doctorIds) : undefined,
      ),
    );

  const opdDoctors = await tx
    .selectDistinct({
      id: doctorProfile.id,
      displayName: doctorProfile.displayName,
      displayNameHi: doctorProfile.displayNameHi,
    })
    .from(doctorProfile)
    .leftJoin(
      consultationRule,
      and(eq(consultationRule.doctorId, doctorProfile.id), eq(consultationRule.status, 'active')),
    )
    .where(
      and(
        eq(doctorProfile.facilityId, facilityId),
        eq(doctorProfile.status, 'active'),
        eq(doctorProfile.isActive, true),
        q.doctorIds?.length ? inArray(doctorProfile.id, q.doctorIds) : undefined,
        sql`(${consultationRule.id} is not null or ${doctorProfile.id} in (select doctor_id from opd_token where facility_id = ${facilityId} and token_date = ${date}))`,
      ),
    )
    .orderBy(asc(doctorProfile.displayName), asc(doctorProfile.id));

  const active = new Set<string>(ACTIVE_STATES);
  const columns: BoardColumn[] = opdDoctors.map((doctor) => {
    const mine = tokens.filter((t) => t.doctorId === doctor.id);
    const strip = ({
      doctorId: _d,
      queueOrder: _o,
      updatedAt: _u,
      doneAt: _n,
      ...t
    }: (typeof mine)[number]) => ({
      ...t,
      priority: t.priority as QueuePriority,
      queueState: t.queueState as QueueState,
      visitType: t.visitType as VisitType,
    });
    // `with_doctor` and later states sit above the pending queue so the current patient is first.
    const inFlow = mine
      .filter(
        (t) => active.has(t.queueState) && !PENDING_STATES.includes(t.queueState as QueueState),
      )
      .sort((a, b) => a.tokenNo - b.tokenNo);
    const pending = mine
      .filter((t) => PENDING_STATES.includes(t.queueState as QueueState))
      .sort((a, b) =>
        compareQueue(
          { ...a, priority: a.priority as QueuePriority },
          { ...b, priority: b.priority as QueuePriority },
          order,
        ),
      );
    const finished = mine
      .filter((t) => !active.has(t.queueState))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return {
      doctor,
      active: [...inFlow, ...pending].map(strip),
      finished: finished.map(strip),
    };
  });

  const awaiting = await tx
    .select({
      encounterId: encounter.id,
      visitNumber: encounter.number,
      doctorId: encounter.doctorId,
      fullName: patient.fullName,
      uhid: patient.uhid,
      visitType: encounter.visitType,
      feePaise: encounter.consultationFeePaise,
      feeBasis: encounter.feeBasis,
      startedAt: encounter.startedAt,
    })
    .from(encounter)
    .innerJoin(patient, eq(patient.id, encounter.patientId))
    .where(
      and(
        eq(encounter.facilityId, facilityId),
        eq(encounter.visitDate, date),
        eq(encounter.type, 'opd'),
        eq(encounter.status, 'open'),
        q.doctorIds?.length ? inArray(encounter.doctorId, q.doctorIds) : undefined,
        sql`not exists (select 1 from opd_token where opd_token.encounter_id = ${encounter.id})`,
      ),
    )
    .orderBy(asc(encounter.startedAt));

  return {
    date,
    columns,
    awaitingToken: awaiting.map((a) => ({
      ...a,
      visitType: a.visitType as VisitType,
      feePaise: a.feePaise.toString(),
    })),
  };
}

/**
 * Scheduled end-of-day run (worker job `queue.endOfDay`, 23:30 IST): every active facility's
 * unseen tokens of the day become `no_show`. One transaction per facility, so one failure does
 * not undo the others. Returns the number of tokens changed per facility.
 */
export async function runEndOfDayNoShow(db: Db, now: Date): Promise<Record<string, number>> {
  const facilities = await db
    .select({ id: facility.id })
    .from(facility)
    .where(eq(facility.isActive, true));
  const date = istDateString(now);
  const out: Record<string, number> = {};
  for (const f of facilities) {
    out[f.id] = await withTx({ db, userId: null, facilityId: f.id }, (tx) =>
      autoNoShow(tx, f.id, date, now),
    );
  }
  return out;
}
