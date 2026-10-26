/**
 * Discounts, cancellation by credit note and refunds (BIL-03, BIL-04, docs/12 §4–5, docs/03 §4,
 * docs/04 §15.8). Same rules as `billing.ts`: every function runs in the caller's transaction,
 * the bill row (after its encounter) is locked first so two cashiers cannot refund the same money
 * twice, and money mutations go through `runIdempotent`.
 *
 * Approvals: the *router* verifies an approver's PIN (`verifyApproverPin`, its own transaction so
 * wrong PINs are counted) and hands the approver's id in as `approverId`; here it is re-checked
 * against the permission, the limits and the requester, and the approval is written in the same
 * transaction as what it allows. The approver's PIN never reaches this file.
 */
import {
  allocateDiscounts,
  APPROVER_PERMISSION,
  applyDiscountSchema,
  cancelBillSchema,
  clearDiscountSchema,
  creditableOf,
  discountWithinLimit,
  effectiveDiscountLimit,
  needsApprovalAbove,
  refundDue,
  resolveDiscount,
  ROLE_KEYS,
  splitCredit,
  sumPaise,
  voidDraftBillSchema,
  type ApplyDiscountInput,
  type ApprovalMethod,
  type BillStatus,
  type CancelBillInput,
  type ClearDiscountInput,
  type VoidDraftBillInput,
} from '@hmis/shared';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  appUser,
  approval,
  bill,
  billDiscount,
  billLine,
  creditNote,
  patient,
  payment,
  reasonCode,
} from '../schema';
import {
  BillingInputError,
  idemBase,
  lockBill,
  mutationResult,
  recomputeBill,
  releaseOrdersOfBill,
  requireDraft,
  type BillMutationResult,
  type BillRow,
  type Queryable,
} from './billing';
import { runIdempotent } from './idempotency';
import { allocateNumber } from './number-series';
import { loadUserAccess } from './rbac';
import { readSettings } from './settings';
import type { Tx } from './tx';

/** Discounts, credit notes and approvals are always by a signed-in user. */
export interface AdjustmentActor {
  facilityId: string;
  userId: string;
  workstationId?: string | null;
}

export interface ApprovalOptions {
  /** A supervisor whose PIN was just verified (`verifyApproverPin`); null = none given. */
  approverId: string | null;
}

// ---------------------------------------------------------------- shared helpers

interface LoadedReason {
  id: string;
  code: string;
  label: string;
}

async function loadReason(
  tx: Tx,
  facilityId: string,
  reasonCodeId: string,
  kind: 'discount' | 'cancel' | 'refund',
  text: string | undefined,
): Promise<LoadedReason> {
  const [r] = await tx
    .select({ id: reasonCode.id, code: reasonCode.code, label: reasonCode.label })
    .from(reasonCode)
    .where(
      and(
        eq(reasonCode.id, reasonCodeId),
        eq(reasonCode.facilityId, facilityId),
        eq(reasonCode.kind, kind),
        eq(reasonCode.status, 'active'),
        eq(reasonCode.isActive, true),
      ),
    );
  if (!r) throw new BillingInputError('billing.reasonNotFound');
  if (r.code === 'other' && !text) throw new BillingInputError('billing.reasonTextRequired');
  return r;
}

const roleKeys: readonly string[] = ROLE_KEYS;

/** The discount limit of a user: the most permissive one of their roles (docs/03 §4). */
async function discountLimitOf(tx: Tx, facilityId: string, userId: string) {
  const access = await loadUserAccess(tx, userId);
  const cfg = await readSettings(tx, facilityId, ['billing.discountLimits']);
  const limit = effectiveDiscountLimit(
    cfg['billing.discountLimits'],
    access.roles.filter((r): r is (typeof ROLE_KEYS)[number] => roleKeys.includes(r)),
  );
  return { access, limit };
}

/**
 * Who answers for an amount that needs a supervisor: the requester if they hold the approve
 * permission themselves (`self`), else the verified approver (`pin`). Re-checks the approver in
 * this transaction: active, same facility, holds the permission, is not the requester.
 */
async function resolveApprover(
  tx: Tx,
  actor: AdjustmentActor,
  requesterPermissions: readonly string[],
  opts: ApprovalOptions,
): Promise<{ approverId: string; method: ApprovalMethod }> {
  if (requesterPermissions.includes(APPROVER_PERMISSION)) {
    return { approverId: actor.userId, method: 'self' };
  }
  if (!opts.approverId || opts.approverId === actor.userId) {
    throw new BillingInputError('billing.approvalRequired');
  }
  const [u] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(
      and(
        eq(appUser.id, opts.approverId),
        eq(appUser.facilityId, actor.facilityId),
        eq(appUser.isActive, true),
      ),
    );
  const access = u ? await loadUserAccess(tx, u.id) : null;
  if (!u || !access?.permissions.includes(APPROVER_PERMISSION)) {
    throw new BillingInputError('billing.approvalRequired');
  }
  return { approverId: u.id, method: 'pin' };
}

async function insertApproval(
  tx: Tx,
  actor: AdjustmentActor,
  b: Pick<BillRow, 'id'>,
  kind: 'discount' | 'credit_note',
  who: { approverId: string; method: ApprovalMethod },
  amountPaise: bigint,
): Promise<string> {
  const id = uuidv7();
  await tx.insert(approval).values({
    id,
    facilityId: actor.facilityId,
    kind,
    billId: b.id,
    requestedBy: actor.userId,
    approverId: who.approverId,
    method: who.method,
    amountPaise,
  });
  return id;
}

// ---------------------------------------------------------------- discounts (BIL-03)

/**
 * Sets a discount on a draft bill, on one line or on the whole bill (spread over the lines),
 * replacing the discount already on that scope. The reason is mandatory. The bill's total discount
 * after the change is held against the requester's role limit (docs/03 §4); above it a supervisor
 * must approve — by PIN, or by being a supervisor themselves — and is stored on the discount.
 * The approver's own limit must cover it too.
 */
export async function applyDiscount(
  tx: Tx,
  actor: AdjustmentActor,
  raw: ApplyDiscountInput,
  now: Date,
  opts: ApprovalOptions,
): Promise<BillMutationResult> {
  const { idempotencyKey, ...input } = applyDiscountSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.applyDiscount', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      requireDraft(b);
      const reason = await loadReason(
        tx,
        actor.facilityId,
        input.reasonCodeId,
        'discount',
        input.reasonText,
      );
      const lines = await tx
        .select({ id: billLine.id, amountPaise: billLine.amountPaise })
        .from(billLine)
        .where(and(eq(billLine.billId, b.id), eq(billLine.status, 'active')));
      if (input.lineId && !lines.some((l) => l.id === input.lineId)) {
        throw new BillingInputError('billing.lineNotFound');
      }
      const active = await tx
        .select()
        .from(billDiscount)
        .where(and(eq(billDiscount.billId, b.id), eq(billDiscount.status, 'active')));

      // What the discount is taken from: the line, or what the lines have left after their own.
      const lineDiscounts = new Map<string, bigint>();
      let billLevel = 0n;
      for (const d of active) {
        if (d.billLineId) lineDiscounts.set(d.billLineId, d.amountPaise);
        else billLevel = d.amountPaise;
      }
      const before = allocateDiscounts(lines, lineDiscounts, 0n).perLine;
      const base = input.lineId
        ? (lines.find((l) => l.id === input.lineId)?.amountPaise ?? 0n)
        : sumPaise(lines.map((l) => l.amountPaise - (before.get(l.id) ?? 0n)));
      const amount = resolveDiscount(
        input.mode === 'percent'
          ? { mode: 'percent', percentBp: input.percentBp }
          : { mode: 'amount', amountPaise: input.amountPaise },
        base,
      );
      if (amount <= 0n) throw new BillingInputError('billing.discountZero');

      // The whole bill's discount after this change (the scope's old discount is replaced).
      if (input.lineId) lineDiscounts.set(input.lineId, amount);
      else billLevel = amount;
      const after = allocateDiscounts(lines, lineDiscounts, billLevel);
      const total = sumPaise([...after.perLine.values()]);
      const gross = sumPaise(lines.map((l) => l.amountPaise));

      const { access, limit } = await discountLimitOf(tx, actor.facilityId, actor.userId);
      let approvalId: string | null = null;
      if (!discountWithinLimit(limit, total, gross)) {
        const who = await resolveApprover(tx, actor, access.permissions, opts);
        if (who.approverId !== actor.userId) {
          const approverLimit = (await discountLimitOf(tx, actor.facilityId, who.approverId)).limit;
          if (!discountWithinLimit(approverLimit, total, gross)) {
            throw new BillingInputError('billing.approverLimit');
          }
        }
        approvalId = await insertApproval(tx, actor, b, 'discount', who, total);
      }

      await tx
        .update(billDiscount)
        .set({
          status: 'cancelled',
          cancelReason: 'Replaced by a new discount',
          cancelledBy: actor.userId,
          cancelledAt: now,
        })
        .where(
          and(
            eq(billDiscount.billId, b.id),
            eq(billDiscount.status, 'active'),
            input.lineId
              ? eq(billDiscount.billLineId, input.lineId)
              : sql`${billDiscount.billLineId} is null`,
          ),
        );
      await tx.insert(billDiscount).values({
        id: uuidv7(),
        facilityId: actor.facilityId,
        billId: b.id,
        billLineId: input.lineId ?? null,
        mode: input.mode,
        percentBp: input.mode === 'percent' ? input.percentBp : null,
        amountPaise: amount,
        reasonCodeId: reason.id,
        reasonText: input.reasonText ?? null,
        approvalId,
        // The grantor, whose limit recomputeBill re-applies when lines are removed later.
        createdBy: actor.userId,
      });
      return mutationResult(await recomputeBill(tx, b), input.lineId ?? null);
    },
  );
}

/** Takes a discount off (the record is cancelled, not deleted). No approval is needed to give less. */
export async function clearDiscount(
  tx: Tx,
  actor: AdjustmentActor,
  raw: ClearDiscountInput,
  now: Date,
): Promise<BillMutationResult> {
  const { idempotencyKey, ...input } = clearDiscountSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.clearDiscount', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      requireDraft(b);
      const cleared = await tx
        .update(billDiscount)
        .set({
          status: 'cancelled',
          cancelReason: 'Discount removed',
          cancelledBy: actor.userId,
          cancelledAt: now,
        })
        .where(
          and(
            eq(billDiscount.billId, b.id),
            eq(billDiscount.status, 'active'),
            input.lineId
              ? eq(billDiscount.billLineId, input.lineId)
              : sql`${billDiscount.billLineId} is null`,
          ),
        )
        .returning({ id: billDiscount.id });
      if (cleared.length === 0) throw new BillingInputError('billing.discountNotFound');
      return mutationResult(await recomputeBill(tx, b), input.lineId ?? null);
    },
  );
}

// ---------------------------------------------------------------- cancellation (BIL-04)

const reasonNote = (r: LoadedReason, text: string | undefined) =>
  text ? `${r.label}: ${text}` : r.label;

/** An unpaid draft is voided: status `cancelled` with a reason; it never had a number (docs/12 §5). */
export async function voidDraftBill(
  tx: Tx,
  actor: AdjustmentActor,
  raw: VoidDraftBillInput,
  now: Date,
): Promise<{ billId: string }> {
  const { idempotencyKey, ...input } = voidDraftBillSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.voidDraft', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      requireDraft(b);
      if (b.paidPaise > 0n) throw new BillingInputError('billing.hasPayments');
      const reason = await loadReason(
        tx,
        actor.facilityId,
        input.reasonCodeId,
        'cancel',
        input.reasonText,
      );
      await tx
        .update(bill)
        .set({
          status: 'cancelled',
          cancelNote: reasonNote(reason, input.reasonText),
          cancelledBy: actor.userId,
          cancelledAt: now,
        })
        .where(eq(bill.id, b.id));
      // OPD-04: the orders on the voided draft can go on the next one.
      await releaseOrdersOfBill(tx, b.id);
      return { billId: b.id };
    },
  );
}

export interface CancelBillResult {
  billId: string;
  billStatus: BillStatus;
  creditNoteId: string;
  creditNoteNumber: string;
  /** Integer paise as strings (the result is stored as JSON for replays). */
  creditedPaise: string;
  refundPaise: string;
  /** The refund's receipt/voucher (print by collection id); null when nothing went back. */
  refundCollectionId: string | null;
  balancePaise: string;
}

/**
 * Credit note against a final bill, in full (the bill is cancelled and keeps its number) or in
 * part, with the refund of the money that is no longer owed (docs/12 §5, docs/04 §15.8):
 *
 * - needs `billing.bill.cancel` (router) and a reason; refunding needs `billing.refund.create`;
 * - the refund is the amount paid beyond the bill's new value, in one counter mode, and can never
 *   exceed what was paid; a stale screen amount is refused;
 * - a credit above `billing.cancelApprovalAbovePaise` or a refund above
 *   `billing.refundApprovalAbovePaise` needs a supervisor (PIN or self);
 * - a refund always carries an approval row (docs/04 §15.8): under the threshold the requester
 *   answers for it (`within_limit`);
 * - credit note and refund voucher share one `credit_note` number, allocated in this transaction.
 */
export async function cancelFinalBill(
  tx: Tx,
  actor: AdjustmentActor,
  raw: CancelBillInput,
  now: Date,
  opts: ApprovalOptions,
): Promise<CancelBillResult> {
  const { idempotencyKey, ...input } = cancelBillSchema.parse(raw);
  return runIdempotent(
    tx,
    { ...idemBase(actor), procedure: 'billing.cancelBill', key: idempotencyKey, payload: input },
    async () => {
      const b = await lockBill(tx, actor.facilityId, input.billId);
      if (b.status === 'cancelled') throw new BillingInputError('billing.billCancelled');
      if (b.status !== 'final') throw new BillingInputError('billing.notFinal');
      const reason = await loadReason(
        tx,
        actor.facilityId,
        input.reasonCodeId,
        'cancel',
        input.reasonText,
      );
      const remaining = creditableOf(b);
      if (remaining <= 0n) throw new BillingInputError('billing.nothingToCredit');
      const amount = input.amountPaise ?? remaining;
      if (amount > remaining) throw new BillingInputError('billing.creditTooLarge');
      const full = amount === remaining;
      const due = refundDue(b, amount);

      if (due > 0n) {
        if (!input.refund) throw new BillingInputError('billing.refundRequired');
        if (input.refund.amountPaise !== undefined && input.refund.amountPaise !== due) {
          throw new BillingInputError(
            input.refund.amountPaise > b.paidPaise
              ? 'billing.refundExceedsPaid'
              : 'billing.refundMismatch',
          );
        }
      } else if (input.refund) {
        throw new BillingInputError('billing.refundNotDue');
      }

      const access = await loadUserAccess(tx, actor.userId);
      if (due > 0n && !access.permissions.includes('billing.refund.create')) {
        throw new BillingInputError('billing.refundNotAllowed');
      }
      const cfg = await readSettings(tx, actor.facilityId, [
        'billing.cancelApprovalAbovePaise',
        'billing.refundApprovalAbovePaise',
      ]);
      const needsSupervisor =
        needsApprovalAbove(amount, BigInt(cfg['billing.cancelApprovalAbovePaise'])) ||
        (due > 0n && needsApprovalAbove(due, BigInt(cfg['billing.refundApprovalAbovePaise'])));
      let approvalId: string | null = null;
      if (needsSupervisor) {
        const who = await resolveApprover(tx, actor, access.permissions, opts);
        approvalId = await insertApproval(tx, actor, b, 'credit_note', who, amount);
      } else if (due > 0n) {
        approvalId = await insertApproval(
          tx,
          actor,
          b,
          'credit_note',
          { approverId: actor.userId, method: 'within_limit' },
          due,
        );
      }

      const split = splitCredit(b, amount);
      const num = await allocateNumber(tx, actor.facilityId, 'credit_note', now);
      const creditNoteId = uuidv7();
      await tx.insert(creditNote).values({
        id: creditNoteId,
        facilityId: actor.facilityId,
        number: num.formatted,
        billId: b.id,
        patientId: b.patientId,
        encounterId: b.encounterId,
        amountPaise: amount,
        taxablePaise: split.taxablePaise,
        cgstPaise: split.cgstPaise,
        sgstPaise: split.sgstPaise,
        reasonCodeId: reason.id,
        reasonText: input.reasonText ?? null,
        approvalId,
        issuedBy: actor.userId,
        issuedAt: now,
        cancelsBill: full,
        idempotencyKey,
      });

      let refundCollectionId: string | null = null;
      if (due > 0n && input.refund) {
        refundCollectionId = uuidv7();
        await tx.insert(payment).values({
          id: refundCollectionId,
          facilityId: actor.facilityId,
          number: num.formatted,
          collectionId: refundCollectionId,
          patientId: b.patientId,
          encounterId: b.encounterId,
          billId: b.id,
          kind: 'refund',
          mode: input.refund.mode,
          amountPaise: -due,
          upiRef: input.refund.mode === 'upi' ? (input.refund.upiRef ?? null) : null,
          receivedBy: actor.userId,
          receivedAt: now,
          workstationId: actor.workstationId ?? null,
          status: 'valid',
          idempotencyKey,
          approvalId,
          creditNoteId,
          reasonCodeId: reason.id,
          reasonText: input.reasonText ?? null,
        });
      }

      const paid = b.paidPaise - due;
      const credited = b.creditedPaise + amount;
      const [after] = await tx
        .update(bill)
        .set({
          creditedPaise: credited,
          creditedCgstPaise: b.creditedCgstPaise + split.cgstPaise,
          creditedSgstPaise: b.creditedSgstPaise + split.sgstPaise,
          paidPaise: paid,
          balancePaise: b.patientSharePaise - credited - paid,
          ...(full
            ? {
                status: 'cancelled',
                cancelNote: reasonNote(reason, input.reasonText),
                cancelledBy: actor.userId,
                cancelledAt: now,
              }
            : {}),
        })
        .where(eq(bill.id, b.id))
        .returning();
      return {
        billId: b.id,
        billStatus: after!.status as BillStatus,
        creditNoteId,
        creditNoteNumber: num.formatted,
        creditedPaise: amount.toString(),
        refundPaise: due.toString(),
        refundCollectionId,
        balancePaise: after!.balancePaise.toString(),
      };
    },
  );
}

// ---------------------------------------------------------------- report hooks

const IST_OFFSET = '+05:30';
/** `[from 00:00, to+1 00:00)` in Asia/Kolkata, as instants. */
function istRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00${IST_OFFSET}`);
  const end = new Date(new Date(`${to}T00:00:00${IST_OFFSET}`).getTime() + 86_400_000);
  return { start, end };
}

export interface DiscountReportRow {
  id: string;
  at: Date;
  billNumber: string | null;
  billStatus: string;
  uhid: string;
  scope: 'bill' | 'line';
  lineDescription: string | null;
  mode: string;
  percentBp: number | null;
  amountPaise: bigint;
  reasonCode: string;
  reasonLabel: string;
  reasonText: string | null;
  givenByName: string | null;
  approvedByName: string | null;
  approvalMethod: string | null;
  status: string;
}

/**
 * Discount report for the owner (docs/12 §4): who gave how much and why, with the approver. Rows
 * of cancelled (replaced or cleared) discounts are included with their status so the owner sees
 * every discount that was ever given. Totals count the active ones only.
 */
export async function discountReport(
  q: Queryable,
  facilityId: string,
  range: { from: string; to: string },
) {
  const { start, end } = istRange(range.from, range.to);
  const rows = await q
    .select({
      id: billDiscount.id,
      at: billDiscount.createdAt,
      billNumber: bill.number,
      billStatus: bill.status,
      uhid: patient.uhid,
      lineId: billDiscount.billLineId,
      lineDescription: billLine.description,
      mode: billDiscount.mode,
      percentBp: billDiscount.percentBp,
      amountPaise: billDiscount.amountPaise,
      reasonCode: reasonCode.code,
      reasonLabel: reasonCode.label,
      reasonText: billDiscount.reasonText,
      givenByName: appUser.fullName,
      approvalMethod: approval.method,
      approverId: approval.approverId,
      status: billDiscount.status,
    })
    .from(billDiscount)
    .innerJoin(bill, eq(bill.id, billDiscount.billId))
    .innerJoin(patient, eq(patient.id, bill.patientId))
    .innerJoin(reasonCode, eq(reasonCode.id, billDiscount.reasonCodeId))
    .leftJoin(billLine, eq(billLine.id, billDiscount.billLineId))
    .leftJoin(appUser, eq(appUser.id, billDiscount.createdBy))
    .leftJoin(approval, eq(approval.id, billDiscount.approvalId))
    .where(
      and(
        eq(billDiscount.facilityId, facilityId),
        gte(billDiscount.createdAt, start),
        lt(billDiscount.createdAt, end),
      ),
    )
    .orderBy(desc(billDiscount.createdAt), asc(billDiscount.id));
  const approverIds = [...new Set(rows.flatMap((r) => (r.approverId ? [r.approverId] : [])))];
  const names = new Map<string, string>();
  for (const id of approverIds) {
    const [u] = await q.select({ n: appUser.fullName }).from(appUser).where(eq(appUser.id, id));
    if (u) names.set(id, u.n);
  }
  const out: DiscountReportRow[] = rows.map((r) => ({
    id: r.id,
    at: r.at,
    billNumber: r.billNumber,
    billStatus: r.billStatus,
    uhid: r.uhid,
    scope: r.lineId ? 'line' : 'bill',
    lineDescription: r.lineDescription,
    mode: r.mode,
    percentBp: r.percentBp,
    amountPaise: r.amountPaise,
    reasonCode: r.reasonCode,
    reasonLabel: r.reasonLabel,
    reasonText: r.reasonText,
    givenByName: r.givenByName,
    approvedByName: r.approverId ? (names.get(r.approverId) ?? null) : null,
    approvalMethod: r.approvalMethod,
    status: r.status,
  }));
  const active = out.filter((r) => r.status === 'active' && r.billStatus !== 'cancelled');
  const byReason = new Map<string, bigint>();
  const byUser = new Map<string, bigint>();
  for (const r of active) {
    byReason.set(r.reasonLabel, (byReason.get(r.reasonLabel) ?? 0n) + r.amountPaise);
    const u = r.givenByName ?? '—';
    byUser.set(u, (byUser.get(u) ?? 0n) + r.amountPaise);
  }
  return {
    rows: out,
    totalPaise: sumPaise(active.map((r) => r.amountPaise)),
    byReason: [...byReason].map(([label, amountPaise]) => ({ label, amountPaise })),
    byUser: [...byUser].map(([name, amountPaise]) => ({ name, amountPaise })),
  };
}

export interface CancellationReportRow {
  id: string;
  number: string;
  at: Date;
  billNumber: string | null;
  uhid: string;
  patientName: string;
  amountPaise: bigint;
  refundPaise: bigint;
  cancelsBill: boolean;
  reasonLabel: string;
  reasonText: string | null;
  issuedByName: string | null;
  approvedByName: string | null;
  approvalMethod: string | null;
}

/** Credit notes (cancellations) and the refunds paid out with them, for the owner. */
export async function cancellationReport(
  q: Queryable,
  facilityId: string,
  range: { from: string; to: string },
) {
  const { start, end } = istRange(range.from, range.to);
  const rows = await q
    .select({
      id: creditNote.id,
      number: creditNote.number,
      at: creditNote.issuedAt,
      billNumber: bill.number,
      uhid: patient.uhid,
      patientName: patient.fullName,
      amountPaise: creditNote.amountPaise,
      refundPaise: sql<bigint>`coalesce((select -sum(p.amount_paise) from payment p
        where p.credit_note_id = ${creditNote.id} and p.kind = 'refund' and p.status = 'valid'), 0)`,
      cancelsBill: creditNote.cancelsBill,
      reasonLabel: reasonCode.label,
      reasonText: creditNote.reasonText,
      issuedByName: appUser.fullName,
      approverId: approval.approverId,
      approvalMethod: approval.method,
    })
    .from(creditNote)
    .innerJoin(bill, eq(bill.id, creditNote.billId))
    .innerJoin(patient, eq(patient.id, creditNote.patientId))
    .innerJoin(reasonCode, eq(reasonCode.id, creditNote.reasonCodeId))
    .leftJoin(appUser, eq(appUser.id, creditNote.issuedBy))
    .leftJoin(approval, eq(approval.id, creditNote.approvalId))
    .where(
      and(
        eq(creditNote.facilityId, facilityId),
        gte(creditNote.issuedAt, start),
        lt(creditNote.issuedAt, end),
      ),
    )
    .orderBy(desc(creditNote.issuedAt), asc(creditNote.id));
  const names = new Map<string, string>();
  for (const id of new Set(rows.flatMap((r) => (r.approverId ? [r.approverId] : [])))) {
    const [u] = await q.select({ n: appUser.fullName }).from(appUser).where(eq(appUser.id, id));
    if (u) names.set(id, u.n);
  }
  const out: CancellationReportRow[] = rows.map((r) => ({
    id: r.id,
    number: r.number,
    at: r.at,
    billNumber: r.billNumber,
    uhid: r.uhid,
    patientName: r.patientName,
    amountPaise: r.amountPaise,
    refundPaise: BigInt(r.refundPaise),
    cancelsBill: r.cancelsBill,
    reasonLabel: r.reasonLabel,
    reasonText: r.reasonText,
    issuedByName: r.issuedByName,
    approvedByName: r.approverId ? (names.get(r.approverId) ?? null) : null,
    approvalMethod: r.approvalMethod,
  }));
  return {
    rows: out,
    totalCreditedPaise: sumPaise(out.map((r) => r.amountPaise)),
    totalRefundedPaise: sumPaise(out.map((r) => r.refundPaise)),
  };
}
