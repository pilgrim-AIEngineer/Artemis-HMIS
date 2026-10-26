/**
 * OPD bills and payments (BIL-01, BIL-02, docs/12 §2–3). Every function runs inside the caller's
 * transaction (`withTx`); the money mutations take a client `idempotencyKey` and go through
 * `runIdempotent`, so a double click, a retry after a timeout or two racing submits of the same
 * key give one result (AGENTS.md rule 9).
 *
 * Concurrency: the encounter row is locked before the bill row (the same order as visit
 * cancellation), then the bill row is held `FOR UPDATE` for the rest of the transaction, so two
 * cashiers collecting on one bill are serialised and the second sees the reduced balance (no
 * overpayment, docs/12 §9). Totals are recomputed from the active lines with the shared
 * `computeBill`; the DB re-checks every invariant (migration 0015).
 */
import {
  billHeaderTotals,
  checkTenders,
  computeGstLine,
  istDateString,
  quantityToMilli,
  addBillLineSchema,
  collectPaymentSchema,
  createOpdBillSchema,
  finalizeBillSchema,
  removeBillLineSchema,
  type AddBillLineInput,
  type BillStatus,
  type CollectPaymentInput,
  type CreateOpdBillInput,
  type FinalizeBillInput,
  type PaymentMode,
  type RemoveBillLineInput,
  type Tender,
} from '@hmis/shared';
import { and, asc, desc, eq, ilike, max, ne, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  appUser,
  bill,
  billLine,
  doctorProfile,
  encounter,
  opdToken,
  patient,
  payment,
  service,
} from '../schema';
import type { Db } from './client';
import { runIdempotent } from './idempotency';
import { getRate } from './masters';
import { allocateNumber } from './number-series';
import { readSettings } from './settings';
import type { Tx } from './tx';
import { issueToken, type Actor } from './visits';

type Queryable = Db | Tx;
type BillRow = typeof bill.$inferSelect;

export type BillingErrorKey =
  | 'billing.billNotFound'
  | 'billing.lineNotFound'
  | 'billing.encounterNotFound'
  | 'billing.encounterNotOpen'
  | 'billing.serviceNotFound'
  | 'billing.noRate'
  | 'billing.notDraft'
  | 'billing.billCancelled'
  | 'billing.empty'
  | 'billing.unpaid'
  | 'billing.belowPaid'
  | 'billing.nothingDue'
  | 'billing.overpayment'
  | 'billing.upiRefRequired'
  | 'billing.finalizeNotAllowed';

/** Input / state errors the router turns into i18n keys (docs/02 §7). */
export class BillingInputError extends Error {
  constructor(readonly key: BillingErrorKey) {
    super(key);
    this.name = 'BillingInputError';
  }
}

// ---------------------------------------------------------------- locking and totals

async function lockEncounter(tx: Tx, facilityId: string, encounterId: string) {
  const [enc] = await tx
    .select({
      id: encounter.id,
      status: encounter.status,
      patientId: encounter.patientId,
      payerId: encounter.payerId,
      tariffId: encounter.tariffId,
      doctorId: encounter.doctorId,
      visitDate: encounter.visitDate,
      type: encounter.type,
    })
    .from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.facilityId, facilityId)))
    .for('update');
  return enc ?? null;
}

/** Locks encounter then bill (fixed order, see the file comment). */
async function lockBill(tx: Tx, facilityId: string, billId: string): Promise<BillRow> {
  const [peek] = await tx
    .select({ encounterId: bill.encounterId })
    .from(bill)
    .where(and(eq(bill.id, billId), eq(bill.facilityId, facilityId)));
  if (!peek) throw new BillingInputError('billing.billNotFound');
  await lockEncounter(tx, facilityId, peek.encounterId);
  const [row] = await tx.select().from(bill).where(eq(bill.id, billId)).for('update');
  if (!row) throw new BillingInputError('billing.billNotFound');
  return row;
}

const requireDraft = (b: BillRow) => {
  if (b.status === 'cancelled') throw new BillingInputError('billing.billCancelled');
  if (b.status !== 'draft') throw new BillingInputError('billing.notDraft');
};

/**
 * Rewrites the header of a draft from its active lines (docs/04 §15.1) and returns it. A draft
 * that already holds payments may not drop below them (refunds are BIL-04).
 */
async function recomputeBill(tx: Tx, b: BillRow): Promise<BillRow> {
  const lines = await tx
    .select({
      unitRatePaise: billLine.unitRatePaise,
      qty: billLine.qty,
      discountPaise: billLine.discountPaise,
      gstRateBp: billLine.gstRateBp,
      isExempt: billLine.isExempt,
      sacHsn: billLine.sacHsn,
    })
    .from(billLine)
    .where(and(eq(billLine.billId, b.id), eq(billLine.status, 'active')));
  const cfg = await readSettings(tx, b.facilityId, ['billing.roundToRupee']);
  const t = billHeaderTotals(lines, { roundToRupee: cfg['billing.roundToRupee'] });
  if (t.patientSharePaise < b.paidPaise) throw new BillingInputError('billing.belowPaid');
  const [updated] = await tx
    .update(bill)
    .set({
      grossPaise: t.grossPaise,
      discountPaise: t.discountPaise,
      taxablePaise: t.taxablePaise,
      cgstPaise: t.cgstPaise,
      sgstPaise: t.sgstPaise,
      roundOffPaise: t.roundOffPaise,
      netPaise: t.netPaise,
      payerSharePaise: t.payerSharePaise,
      patientSharePaise: t.patientSharePaise,
      balancePaise: t.patientSharePaise - b.paidPaise,
    })
    .where(eq(bill.id, b.id))
    .returning();
  return updated!;
}

// ---------------------------------------------------------------- lines

interface PricedService {
  id: string;
  name: string;
  nameHi: string | null;
  sacCode: string | null;
  gstRateBp: number;
  isExempt: boolean;
  rateId: string;
  ratePaise: bigint;
}

/** The service priced in the bill's tariff on `on` (docs/12 §1: missing rate → no line). */
async function priceService(
  tx: Tx,
  b: Pick<BillRow, 'facilityId' | 'tariffId'>,
  serviceId: string,
  on: string,
  /** The visit's consultation was already accepted by `consultationFee`; only `status` matters. */
  requireActiveFlag = true,
): Promise<PricedService> {
  const [svc] = await tx
    .select({
      id: service.id,
      name: service.name,
      nameHi: service.nameHi,
      sacCode: service.sacCode,
      gstRateBp: service.defaultGstRateBp,
      isExempt: service.isExempt,
    })
    .from(service)
    .where(
      and(
        eq(service.id, serviceId),
        eq(service.facilityId, b.facilityId),
        eq(service.status, 'active'),
        requireActiveFlag ? eq(service.isActive, true) : undefined,
      ),
    );
  if (!svc) throw new BillingInputError('billing.serviceNotFound');
  const rate = await getRate(tx, {
    facilityId: b.facilityId,
    serviceId,
    tariffId: b.tariffId,
    on,
  });
  if (!rate) throw new BillingInputError('billing.noRate');
  return { ...svc, rateId: rate.id, ratePaise: rate.ratePaise };
}

/** Inserts a priced line (rate snapshot on the line) at the next `seq`. */
async function insertLine(
  tx: Tx,
  b: BillRow,
  svc: PricedService,
  qty: string,
  serviceDate: string,
  performedByDoctorId: string | null,
): Promise<string> {
  const g = computeGstLine({
    ratePaise: svc.ratePaise,
    qtyMilli: quantityToMilli(qty),
    gstRateBp: svc.gstRateBp,
    isExempt: svc.isExempt,
    hsnSac: svc.sacCode,
  });
  const [last] = await tx
    .select({ seq: max(billLine.seq) })
    .from(billLine)
    .where(eq(billLine.billId, b.id));
  const id = uuidv7();
  await tx.insert(billLine).values({
    id,
    facilityId: b.facilityId,
    billId: b.id,
    seq: (last?.seq ?? 0) + 1,
    source: 'service',
    serviceId: svc.id,
    serviceRateId: svc.rateId,
    description: svc.name,
    descriptionHi: svc.nameHi,
    qty,
    unitRatePaise: svc.ratePaise,
    amountPaise: g.grossPaise,
    discountPaise: g.discountPaise,
    sacHsn: svc.sacCode,
    gstRateBp: g.gstRateBp,
    isExempt: svc.isExempt,
    taxablePaise: g.taxablePaise,
    cgstPaise: g.cgstPaise,
    sgstPaise: g.sgstPaise,
    payerSharePaise: 0n,
    patientSharePaise: g.totalPaise,
    serviceDate,
    performedByDoctorId,
  });
  return id;
}

// ---------------------------------------------------------------- create

/**
 * Draft OPD bill of a visit with its consultation line (docs/12 §2), inside the visit's own
 * transaction. `consultation` is null when the visit has no priced consultation (no rule, no rate):
 * the draft starts empty and the screen says the fee is not set.
 */
export async function createOpdBillForVisit(
  tx: Tx,
  actor: Actor,
  enc: {
    id: string;
    patientId: string;
    payerId: string;
    tariffId: string;
    doctorId: string;
    visitDate: string;
  },
  consultation: { serviceId: string } | null,
): Promise<string> {
  const billId = uuidv7();
  const [b] = await tx
    .insert(bill)
    .values({
      id: billId,
      facilityId: actor.facilityId,
      kind: 'opd',
      encounterId: enc.id,
      patientId: enc.patientId,
      payerId: enc.payerId,
      tariffId: enc.tariffId,
      status: 'draft',
      billDate: enc.visitDate,
    })
    .returning();
  if (consultation) {
    const svc = await priceService(tx, b!, consultation.serviceId, enc.visitDate, false);
    await insertLine(tx, b!, svc, '1', enc.visitDate, enc.doctorId);
    await recomputeBill(tx, b!);
  }
  return billId;
}

export interface BillRef {
  billId: string;
}

/**
 * Opens the draft OPD bill of a visit that has none (visits made before billing existed, or after
 * the previous draft was finalised and more services are needed). Returns the existing draft
 * otherwise. Idempotent by key and by state.
 */
export async function createOpdBill(
  tx: Tx,
  actor: Actor,
  raw: CreateOpdBillInput,
): Promise<BillRef> {
  const { idempotencyKey, ...input } = createOpdBillSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.createOpdBill', key: idempotencyKey, payload: input },
    async () => {
      const enc = await lockEncounter(tx, actor.facilityId, input.encounterId);
      if (!enc || enc.type !== 'opd') throw new BillingInputError('billing.encounterNotFound');
      if (enc.status !== 'open') throw new BillingInputError('billing.encounterNotOpen');
      const [draft] = await tx
        .select({ id: bill.id })
        .from(bill)
        .where(and(eq(bill.encounterId, enc.id), eq(bill.kind, 'opd'), eq(bill.status, 'draft')));
      if (draft) return { billId: draft.id };
      const [anyBill] = await tx
        .select({ id: bill.id })
        .from(bill)
        .where(and(eq(bill.encounterId, enc.id), ne(bill.status, 'cancelled')))
        .limit(1);
      const [e] = await tx
        .select({ serviceId: encounter.consultationServiceId, basis: encounter.feeBasis })
        .from(encounter)
        .where(eq(encounter.id, enc.id));
      // The consultation goes on the first bill of the visit only.
      const consultation =
        !anyBill && e?.serviceId && e.basis === 'tariff' ? { serviceId: e.serviceId } : null;
      return { billId: await createOpdBillForVisit(tx, actor, enc, consultation) };
    },
  );
}

const idemBase = (actor: Actor) => ({ facilityId: actor.facilityId, userId: actor.userId });

export interface BillMutationResult {
  billId: string;
  lineId: string | null;
  netPaise: string;
  balancePaise: string;
}

const mutationResult = (b: BillRow, lineId: string | null): BillMutationResult => ({
  billId: b.id,
  lineId,
  netPaise: b.netPaise.toString(),
  balancePaise: b.balancePaise.toString(),
});

/** Adds a service from the bill's tariff to a draft (docs/12 §2 "Add service"). */
export async function addBillLine(
  tx: Tx,
  actor: Actor,
  raw: AddBillLineInput,
  now: Date,
): Promise<BillMutationResult> {
  const { idempotencyKey, ...input } = addBillLineSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.addLine', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      requireDraft(b);
      const today = istDateString(now);
      const svc = await priceService(tx, b, input.serviceId, today);
      const lineId = await insertLine(tx, b, svc, input.qty, today, null);
      return mutationResult(await recomputeBill(tx, b), lineId);
    },
  );
}

/** Removes a line from a draft: the row is cancelled with a reason, never deleted (rule 4). */
export async function removeBillLine(
  tx: Tx,
  actor: Actor,
  raw: RemoveBillLineInput,
  now: Date,
): Promise<BillMutationResult> {
  const { idempotencyKey, ...input } = removeBillLineSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.removeLine', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      requireDraft(b);
      const updated = await tx
        .update(billLine)
        .set({
          status: 'cancelled',
          cancelReason: input.reason ?? 'Removed from draft bill',
          cancelledBy: actor.userId,
          cancelledAt: now,
        })
        .where(
          and(
            eq(billLine.id, input.lineId),
            eq(billLine.billId, b.id),
            eq(billLine.status, 'active'),
          ),
        )
        .returning({ id: billLine.id });
      if (updated.length === 0) throw new BillingInputError('billing.lineNotFound');
      return mutationResult(await recomputeBill(tx, b), input.lineId);
    },
  );
}

// ---------------------------------------------------------------- finalise

export interface FinalizeOutcome {
  billNumber: string;
  token: { tokenId: string; tokenNo: number; tokenDate: string } | null;
}

/**
 * Draft → final on the locked row: needs at least one line and, unless `billing.allowOpdCredit`
 * is on, nothing left to pay (docs/12 §2). The bill number comes from `opd_bill` in the same
 * transaction. A fully paid OPD bill releases the visit's token if it is still waiting for the
 * payment (docs/10 §4 step 3).
 */
async function finalizeLocked(
  tx: Tx,
  actor: Actor,
  b: BillRow,
  now: Date,
): Promise<FinalizeOutcome> {
  const [lines] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(billLine)
    .where(and(eq(billLine.billId, b.id), eq(billLine.status, 'active')));
  if (!lines?.n) throw new BillingInputError('billing.empty');
  if (b.balancePaise > 0n) {
    const cfg = await readSettings(tx, actor.facilityId, ['billing.allowOpdCredit']);
    if (!cfg['billing.allowOpdCredit']) throw new BillingInputError('billing.unpaid');
  }
  const num = await allocateNumber(tx, actor.facilityId, 'opd_bill', now);
  await tx
    .update(bill)
    .set({
      status: 'final',
      number: num.formatted,
      billDate: istDateString(now),
      finalizedBy: actor.userId,
      finalizedAt: now,
    })
    .where(eq(bill.id, b.id));
  const token = b.balancePaise === 0n ? await releaseToken(tx, actor, b.encounterId, now) : null;
  return { billNumber: num.formatted, token };
}

async function releaseToken(tx: Tx, actor: Actor, encounterId: string, now: Date) {
  const [enc] = await tx
    .select({ status: encounter.status, type: encounter.type })
    .from(encounter)
    .where(eq(encounter.id, encounterId));
  if (enc?.status !== 'open' || enc.type !== 'opd') return null;
  const [existing] = await tx
    .select({ id: opdToken.id })
    .from(opdToken)
    .where(eq(opdToken.encounterId, encounterId));
  if (existing) return null;
  return issueToken(tx, actor, encounterId, 'payment', now);
}

export interface FinalizeResult {
  billId: string;
  billNumber: string;
  tokenNo: number | null;
  tokenDate: string | null;
}

export async function finalizeBill(
  tx: Tx,
  actor: Actor,
  raw: FinalizeBillInput,
  now: Date,
): Promise<FinalizeResult> {
  const { idempotencyKey, ...input } = finalizeBillSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.finalize', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      requireDraft(b);
      const out = await finalizeLocked(tx, actor, b, now);
      return {
        billId: b.id,
        billNumber: out.billNumber,
        tokenNo: out.token?.tokenNo ?? null,
        tokenDate: out.token?.tokenDate ?? null,
      };
    },
  );
}

// ---------------------------------------------------------------- payments

export interface CollectResult {
  collectionId: string;
  receiptNumber: string;
  billId: string;
  billNumber: string | null;
  billStatus: BillStatus;
  /** Integer paise as strings (the result is stored as JSON for replays). */
  totalPaise: string;
  paidPaise: string;
  balancePaise: string;
  encounterId: string;
  tokenNo: number | null;
  tokenDate: string | null;
}

export interface CollectOptions {
  /** The caller holds `billing.bill.finalize`; needed when this payment settles a draft. */
  mayFinalize: boolean;
}

/**
 * Collects a payment on a bill (BIL-02): cash, UPI (optional UTR), card, or a split across them.
 * One receipt number (`receipt` series, same transaction) for the whole collection; one
 * `payment` row per mode. Partial payments leave a draft open; the payment that clears a draft
 * finalises it and releases the visit's token. Overpayment is refused under the bill row lock.
 */
export async function collectPayment(
  tx: Tx,
  actor: Actor & { workstationId?: string | null },
  raw: CollectPaymentInput,
  now: Date,
  opts: CollectOptions,
): Promise<CollectResult> {
  const { idempotencyKey, ...input } = collectPaymentSchema.parse(raw);
  return runIdempotent(
    tx,
    {
      ...idemBase(actor),
      procedure: 'billing.collectPayment',
      key: idempotencyKey,
      payload: input,
    },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      if (b.status === 'cancelled') throw new BillingInputError('billing.billCancelled');
      const cfg = await readSettings(tx, actor.facilityId, ['billing.upiRefRequired']);
      const rule = cfg['billing.upiRefRequired'];
      const tenders: Tender[] = input.tenders.map((t) =>
        t.mode === 'upi' && rule.mode === 'off' ? { mode: 'upi', amountPaise: t.amountPaise } : t,
      );
      const check = checkTenders(b.balancePaise, tenders, rule);
      if (!check.ok) throw new BillingInputError(check.error);
      const settles = check.totalPaise === b.balancePaise;
      if (settles && b.status === 'draft' && !opts.mayFinalize) {
        throw new BillingInputError('billing.finalizeNotAllowed');
      }

      const receipt = await allocateNumber(tx, actor.facilityId, 'receipt', now);
      const collectionId = uuidv7();
      await tx.insert(payment).values(
        tenders.map((t, i) => ({
          id: i === 0 ? collectionId : uuidv7(),
          facilityId: actor.facilityId,
          number: receipt.formatted,
          collectionId,
          patientId: b.patientId,
          encounterId: b.encounterId,
          billId: b.id,
          kind: 'payment' as const,
          mode: t.mode,
          amountPaise: t.amountPaise,
          upiRef: t.mode === 'upi' ? (t.upiRef ?? null) : null,
          upiPayerName: t.mode === 'upi' ? (t.upiPayerName ?? null) : null,
          cardLast4: t.mode === 'card' ? (t.cardLast4 ?? null) : null,
          cardAuthCode: t.mode === 'card' ? (t.cardAuthCode ?? null) : null,
          receivedBy: actor.userId,
          receivedAt: now,
          workstationId: actor.workstationId ?? null,
          status: 'valid',
          idempotencyKey,
        })),
      );
      const paid = b.paidPaise + check.totalPaise;
      const [after] = await tx
        .update(bill)
        .set({ paidPaise: paid, balancePaise: b.patientSharePaise - paid })
        .where(eq(bill.id, b.id))
        .returning();
      let billNumber = b.number;
      let billStatus = b.status as BillStatus;
      let token: FinalizeOutcome['token'] = null;
      if (b.status === 'draft' && settles) {
        const out = await finalizeLocked(tx, actor, after!, now);
        billNumber = out.billNumber;
        billStatus = 'final';
        token = out.token;
      } else if (settles) {
        token = await releaseToken(tx, actor, b.encounterId, now);
      }
      return {
        collectionId,
        receiptNumber: receipt.formatted,
        billId: b.id,
        billNumber,
        billStatus,
        totalPaise: check.totalPaise.toString(),
        paidPaise: paid.toString(),
        balancePaise: (b.patientSharePaise - paid).toString(),
        encounterId: b.encounterId,
        tokenNo: token?.tokenNo ?? null,
        tokenDate: token?.tokenDate ?? null,
      };
    },
  );
}

/**
 * Visit cancellation (REG-03) takes its draft bill with it. A bill with money on it (final or
 * partly paid) blocks the cancellation: that needs a credit note and refund (BIL-04).
 */
export async function cancelBillsOfVisit(
  tx: Tx,
  actor: Actor,
  encounterId: string,
  reason: string,
  now: Date,
): Promise<'ok' | 'has_money'> {
  const rows = await tx
    .select()
    .from(bill)
    .where(and(eq(bill.encounterId, encounterId), ne(bill.status, 'cancelled')))
    .for('update');
  if (rows.some((b) => b.status === 'final' || b.paidPaise > 0n)) return 'has_money';
  for (const b of rows) {
    await tx
      .update(bill)
      .set({ status: 'cancelled', cancelNote: reason, cancelledBy: actor.userId, cancelledAt: now })
      .where(eq(bill.id, b.id));
  }
  return 'ok';
}

// ---------------------------------------------------------------- read model

export interface BillLineView {
  id: string;
  seq: number;
  description: string;
  descriptionHi: string | null;
  qty: string;
  unitRatePaise: bigint;
  amountPaise: bigint;
  discountPaise: bigint;
  gstRateBp: number;
  cgstPaise: bigint;
  sgstPaise: bigint;
  patientSharePaise: bigint;
  sacHsn: string | null;
}

export interface PaymentView {
  id: string;
  collectionId: string;
  number: string;
  mode: PaymentMode;
  amountPaise: bigint;
  upiRef: string | null;
  cardLast4: string | null;
  receivedAt: Date;
  receivedByName: string | null;
  status: string;
}

export interface BillView {
  id: string;
  number: string | null;
  status: BillStatus;
  kind: string;
  billDate: string;
  encounterId: string;
  encounterNumber: string;
  encounterStatus: string;
  doctorName: string;
  doctorNameHi: string | null;
  patient: {
    id: string;
    uhid: string;
    fullName: string;
    nameHi: string | null;
    sex: string;
    dob: string;
    mobile: string | null;
  };
  tokenNo: number | null;
  grossPaise: bigint;
  discountPaise: bigint;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  roundOffPaise: bigint;
  netPaise: bigint;
  patientSharePaise: bigint;
  paidPaise: bigint;
  balancePaise: bigint;
  lines: BillLineView[];
  payments: PaymentView[];
}

export async function getBillView(
  q: Queryable,
  facilityId: string,
  billId: string,
): Promise<BillView | null> {
  const [row] = await q
    .select({
      b: bill,
      encounterNumber: encounter.number,
      encounterStatus: encounter.status,
      doctorName: doctorProfile.displayName,
      doctorNameHi: doctorProfile.displayNameHi,
      p: {
        id: patient.id,
        uhid: patient.uhid,
        fullName: patient.fullName,
        nameHi: patient.nameHi,
        sex: patient.sex,
        dob: patient.dob,
        mobile: patient.mobile,
      },
      tokenNo: opdToken.tokenNo,
    })
    .from(bill)
    .innerJoin(encounter, eq(encounter.id, bill.encounterId))
    .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .innerJoin(patient, eq(patient.id, bill.patientId))
    .leftJoin(opdToken, eq(opdToken.encounterId, encounter.id))
    .where(and(eq(bill.id, billId), eq(bill.facilityId, facilityId)));
  if (!row) return null;
  const lines = await q
    .select({
      id: billLine.id,
      seq: billLine.seq,
      description: billLine.description,
      descriptionHi: billLine.descriptionHi,
      qty: billLine.qty,
      unitRatePaise: billLine.unitRatePaise,
      amountPaise: billLine.amountPaise,
      discountPaise: billLine.discountPaise,
      gstRateBp: billLine.gstRateBp,
      cgstPaise: billLine.cgstPaise,
      sgstPaise: billLine.sgstPaise,
      patientSharePaise: billLine.patientSharePaise,
      sacHsn: billLine.sacHsn,
    })
    .from(billLine)
    .where(and(eq(billLine.billId, billId), eq(billLine.status, 'active')))
    .orderBy(asc(billLine.seq));
  const payments = await q
    .select({
      id: payment.id,
      collectionId: payment.collectionId,
      number: payment.number,
      mode: payment.mode,
      amountPaise: payment.amountPaise,
      upiRef: payment.upiRef,
      cardLast4: payment.cardLast4,
      receivedAt: payment.receivedAt,
      receivedByName: appUser.fullName,
      status: payment.status,
    })
    .from(payment)
    .leftJoin(appUser, eq(appUser.id, payment.receivedBy))
    .where(eq(payment.billId, billId))
    .orderBy(asc(payment.receivedAt), asc(payment.id));
  const b = row.b;
  return {
    id: b.id,
    number: b.number,
    status: b.status as BillStatus,
    kind: b.kind,
    billDate: b.billDate,
    encounterId: b.encounterId,
    encounterNumber: row.encounterNumber,
    encounterStatus: row.encounterStatus,
    doctorName: row.doctorName,
    doctorNameHi: row.doctorNameHi,
    patient: row.p,
    tokenNo: row.tokenNo,
    grossPaise: b.grossPaise,
    discountPaise: b.discountPaise,
    taxablePaise: b.taxablePaise,
    cgstPaise: b.cgstPaise,
    sgstPaise: b.sgstPaise,
    roundOffPaise: b.roundOffPaise,
    netPaise: b.netPaise,
    patientSharePaise: b.patientSharePaise,
    paidPaise: b.paidPaise,
    balancePaise: b.balancePaise,
    lines,
    payments: payments.map((p) => ({ ...p, mode: p.mode as PaymentMode })),
  };
}

/** Bills of a visit, newest first (the draft, if any, comes first). */
export async function billsForEncounter(q: Queryable, facilityId: string, encounterId: string) {
  return q
    .select({
      id: bill.id,
      number: bill.number,
      status: bill.status,
      netPaise: bill.netPaise,
      balancePaise: bill.balancePaise,
    })
    .from(bill)
    .where(and(eq(bill.facilityId, facilityId), eq(bill.encounterId, encounterId)))
    .orderBy(sql`${bill.status} = 'draft' desc`, desc(bill.createdAt));
}

/**
 * The billing desk worklist: drafts and bills with money still due, newest first. `q` narrows by
 * UHID, mobile or name (simple contains match; the full patient search lives in reception).
 */
export async function pendingBills(
  q: Queryable,
  facilityId: string,
  filter: { q?: string; limit?: number },
) {
  const term = filter.q?.trim();
  const like = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return q
    .select({
      id: bill.id,
      number: bill.number,
      status: bill.status,
      billDate: bill.billDate,
      netPaise: bill.netPaise,
      paidPaise: bill.paidPaise,
      balancePaise: bill.balancePaise,
      encounterNumber: encounter.number,
      patientName: patient.fullName,
      patientNameHi: patient.nameHi,
      uhid: patient.uhid,
      mobile: patient.mobile,
      doctorName: doctorProfile.displayName,
      tokenNo: opdToken.tokenNo,
    })
    .from(bill)
    .innerJoin(encounter, eq(encounter.id, bill.encounterId))
    .innerJoin(patient, eq(patient.id, bill.patientId))
    .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .leftJoin(opdToken, eq(opdToken.encounterId, encounter.id))
    .where(
      and(
        eq(bill.facilityId, facilityId),
        or(
          and(eq(bill.status, 'draft'), sql`${bill.netPaise} > 0`),
          and(eq(bill.status, 'final'), sql`${bill.balancePaise} > 0`),
        ),
        like
          ? or(
              ilike(patient.fullName, like),
              ilike(patient.uhid, like),
              ilike(patient.mobile, like),
              ilike(encounter.number, like),
            )
          : undefined,
      ),
    )
    .orderBy(desc(bill.createdAt))
    .limit(filter.limit ?? 50);
}

export interface ReceiptData {
  collectionId: string;
  number: string;
  receivedAt: Date;
  receivedByName: string | null;
  totalPaise: bigint;
  tenders: {
    mode: PaymentMode;
    amountPaise: bigint;
    upiRef: string | null;
    cardLast4: string | null;
  }[];
  status: 'valid' | 'reversed';
  bill: {
    number: string | null;
    status: BillStatus;
    netPaise: bigint;
    paidPaise: bigint;
    balancePaise: bigint;
    lines: {
      description: string;
      descriptionHi: string | null;
      qty: string;
      amountPaise: bigint;
    }[];
  } | null;
  patient: { uhid: string; fullName: string; nameHi: string | null; dob: string; sex: string };
  encounterNumber: string | null;
  doctorName: string | null;
}

/** One collection (receipt) with its bill, for the receipt print (BIL-02; full layouts BIL-05). */
export async function loadReceipt(
  q: Queryable,
  facilityId: string,
  collectionId: string,
): Promise<ReceiptData | null> {
  const rows = await q
    .select({
      p: payment,
      receivedByName: appUser.fullName,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      encounterNumber: encounter.number,
      doctorName: doctorProfile.displayName,
    })
    .from(payment)
    .innerJoin(patient, eq(patient.id, payment.patientId))
    .leftJoin(appUser, eq(appUser.id, payment.receivedBy))
    .leftJoin(encounter, eq(encounter.id, payment.encounterId))
    .leftJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .where(and(eq(payment.collectionId, collectionId), eq(payment.facilityId, facilityId)))
    .orderBy(asc(payment.id));
  const first = rows[0];
  if (!first) return null;
  let billData: ReceiptData['bill'] = null;
  if (first.p.billId) {
    const [b] = await q.select().from(bill).where(eq(bill.id, first.p.billId));
    const lines = await q
      .select({
        description: billLine.description,
        descriptionHi: billLine.descriptionHi,
        qty: billLine.qty,
        amountPaise: billLine.patientSharePaise,
      })
      .from(billLine)
      .where(and(eq(billLine.billId, first.p.billId), eq(billLine.status, 'active')))
      .orderBy(asc(billLine.seq));
    if (b) {
      billData = {
        number: b.number,
        status: b.status as BillStatus,
        netPaise: b.netPaise,
        paidPaise: b.paidPaise,
        balancePaise: b.balancePaise,
        lines,
      };
    }
  }
  return {
    collectionId,
    number: first.p.number,
    receivedAt: first.p.receivedAt,
    receivedByName: first.receivedByName,
    totalPaise: rows.reduce((s, r) => s + r.p.amountPaise, 0n),
    tenders: rows.map((r) => ({
      mode: r.p.mode as PaymentMode,
      amountPaise: r.p.amountPaise,
      upiRef: r.p.upiRef,
      cardLast4: r.p.cardLast4,
    })),
    status: rows.every((r) => r.p.status === 'reversed') ? 'reversed' : 'valid',
    bill: billData,
    patient: {
      uhid: first.uhid,
      fullName: first.fullName,
      nameHi: first.nameHi,
      dob: first.dob,
      sex: first.sex,
    },
    encounterNumber: first.encounterNumber,
    doctorName: first.doctorName,
  };
}

/** Services that can be added to a bill: active, priced in the bill's tariff today. */
export async function billableServices(
  q: Queryable,
  facilityId: string,
  filter: { billId: string; q: string; on: string },
) {
  const [b] = await q
    .select({ tariffId: bill.tariffId })
    .from(bill)
    .where(and(eq(bill.id, filter.billId), eq(bill.facilityId, facilityId)));
  if (!b) return null;
  const term = filter.q.trim().toLowerCase();
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const svcs = await q
    .select({
      id: service.id,
      code: service.code,
      name: service.name,
      nameHi: service.nameHi,
      category: service.category,
      gstRateBp: service.defaultGstRateBp,
      isExempt: service.isExempt,
    })
    .from(service)
    .where(
      and(
        eq(service.facilityId, facilityId),
        eq(service.status, 'active'),
        eq(service.isActive, true),
        term
          ? or(sql`${service.searchText} like ${like}`, sql`${term} <% ${service.searchText}`)
          : undefined,
      ),
    )
    .orderBy(asc(service.name))
    .limit(30);
  const out = [];
  for (const s of svcs) {
    const rate = await getRate(q, {
      facilityId,
      serviceId: s.id,
      tariffId: b.tariffId,
      on: filter.on,
    });
    out.push({ ...s, ratePaise: rate?.ratePaise ?? null });
  }
  return out;
}
