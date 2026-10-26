/**
 * Discounts, cancellation by credit note and refunds (BIL-03, BIL-04, docs/12 §4–5, docs/03 §4,
 * docs/04 §15.8). The pure rules live here — limits, how a discount spreads over lines, how a
 * credit note splits its tax, what may be refunded — and the db package applies them inside
 * transactions. Money is bigint paise throughout (AGENTS.md rule 1).
 */
import { z } from 'zod';
import { findForbiddenTerms } from './compliance/forbidden-terms';
import { allocatePaise, applyPercentBp, divRound, sumPaise, type Paise } from './money';
import { idempotencyKeySchema, uuidSchema, positivePaiseSchema } from './primitives';
import type { DiscountLimit } from './settings';
import { MONEY_CEILING_PAISE } from './billing';
import { reportRangeSchema } from './reports';

export const DISCOUNT_MODES = ['percent', 'amount'] as const;
export type DiscountMode = (typeof DISCOUNT_MODES)[number];

export const APPROVAL_KINDS = ['discount', 'credit_note'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/**
 * How an approval came about: another user's PIN (`pin`), the actor holds the approve permission
 * themselves (`self`), or the amount is inside the actor's own limit (`within_limit`; only
 * recorded for refunds, which always carry an approval row, docs/04 §15.8).
 */
export const APPROVAL_METHODS = ['pin', 'self', 'within_limit'] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

/** Permission an approver must hold, for discounts, credit notes and refunds alike. */
export const APPROVER_PERMISSION = 'billing.discount.approve' as const;

/** Refunds are returned in a counter mode (docs/12 §5); the payment dialog's modes. */
export const REFUND_MODES = ['cash', 'upi', 'card'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

/** D-10: free text carries no forbidden term (`always` tier outside USG/ANC/MTP contexts). */
export const reasonTextSchema = z
  .string()
  .trim()
  .min(3, 'validation.reason')
  .max(200)
  .refine((s) => findForbiddenTerms(s).length === 0, 'validation.forbiddenText');

const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  reasonTextSchema.optional(),
);

const amountSchema = positivePaiseSchema.refine((p) => p <= MONEY_CEILING_PAISE, {
  message: 'paise.tooLarge',
});

/** Approver credentials typed on the same screen; never part of an idempotency payload. */
export const approverSchema = z.object({
  username: z.string().trim().min(3).max(40),
  pin: z.string().regex(/^\d{4,6}$/, 'validation.pinFormat'),
});
export type ApproverInput = z.input<typeof approverSchema>;

// ---------------------------------------------------------------- discounts

const discountBase = {
  billId: uuidSchema,
  /** Omitted = the whole bill (spread over its lines). */
  lineId: uuidSchema.optional(),
  reasonCodeId: uuidSchema,
  /** Required when the reason is `other` (checked in the db layer, which knows the code). */
  reasonText: optionalText,
  idempotencyKey: idempotencyKeySchema,
};

export const applyDiscountSchema = z.discriminatedUnion('mode', [
  z.object({
    ...discountBase,
    mode: z.literal('percent'),
    /** 1..10000 basis points (100 = 1%). */
    percentBp: z.number().int().min(1).max(10_000),
  }),
  z.object({ ...discountBase, mode: z.literal('amount'), amountPaise: amountSchema }),
]);
export type ApplyDiscountInput = z.input<typeof applyDiscountSchema>;

export const clearDiscountSchema = z.object({
  billId: uuidSchema,
  lineId: uuidSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type ClearDiscountInput = z.input<typeof clearDiscountSchema>;

/** The discount a percent / amount request comes to against `basePaise`, never above it. */
export function resolveDiscount(
  req: { mode: 'percent'; percentBp: number } | { mode: 'amount'; amountPaise: Paise },
  basePaise: Paise,
): Paise {
  const d = req.mode === 'percent' ? applyPercentBp(basePaise, req.percentBp) : req.amountPaise;
  return d > basePaise ? basePaise : d;
}

/**
 * docs/03 §4: a discount is within a role's limit when it is at most `maxPercentBp` of the bill's
 * gross *and* at most `maxAmountPaise` ("10% or ₹500, whichever is lower"); `null` = unlimited.
 * `totalDiscountPaise` is the bill's whole discount after the change, so splitting one discount
 * over several lines cannot get around the limit.
 */
export function discountWithinLimit(
  limit: DiscountLimit,
  totalDiscountPaise: Paise,
  grossPaise: Paise,
): boolean {
  if (totalDiscountPaise <= 0n) return true;
  if (limit.maxAmountPaise !== null && totalDiscountPaise > BigInt(limit.maxAmountPaise)) {
    return false;
  }
  if (limit.maxPercentBp !== null) {
    // d / gross <= bp / 10000  <=>  d * 10000 <= bp * gross (exact, no rounding)
    return totalDiscountPaise * 10_000n <= BigInt(limit.maxPercentBp) * grossPaise;
  }
  return true;
}

export interface DiscountableLine {
  id: string;
  amountPaise: Paise;
}

/**
 * Per-line discount from the active discount records of a draft: each line's own discount (capped
 * at its amount), then the bill-level discount spread over what is left of every line in
 * proportion (largest remainder, so the shares add up exactly). A bill-level discount larger than
 * what is left is capped at it. Returns the discount per line id and the capped bill-level part.
 */
export function allocateDiscounts(
  lines: readonly DiscountableLine[],
  lineDiscounts: ReadonlyMap<string, Paise>,
  billDiscountPaise: Paise,
): { perLine: Map<string, Paise>; billLevelPaise: Paise } {
  const own = lines.map((l) => {
    const d = lineDiscounts.get(l.id) ?? 0n;
    return d > l.amountPaise ? l.amountPaise : d;
  });
  const left = lines.map((l, i) => l.amountPaise - own[i]!);
  const leftTotal = sumPaise(left);
  const billLevel = billDiscountPaise > leftTotal ? leftTotal : billDiscountPaise;
  const shares = allocatePaise(billLevel, left);
  const perLine = new Map<string, Paise>();
  lines.forEach((l, i) => perLine.set(l.id, own[i]! + shares[i]!));
  return { perLine, billLevelPaise: billLevel };
}

// ---------------------------------------------------------------- credit notes and refunds

export const refundInputSchema = z.object({
  mode: z.enum(REFUND_MODES),
  /** The amount the screen showed; must equal what the bill needs refunded (stale-screen guard). */
  amountPaise: amountSchema.optional(),
  /** Reference of the refund transfer (last digits), optional like for receipts. */
  upiRef: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        .trim()
        .regex(/^\d{4,12}$/, 'billing.upiRefInvalid')
        .optional(),
    )
    .optional(),
});
export type RefundInput = z.input<typeof refundInputSchema>;

export const cancelBillSchema = z.object({
  billId: uuidSchema,
  reasonCodeId: uuidSchema,
  reasonText: optionalText,
  /** Credit note amount; omitted = everything still creditable, which cancels the bill. */
  amountPaise: amountSchema.optional(),
  /** Required when money has to go back to the patient. */
  refund: refundInputSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type CancelBillInput = z.input<typeof cancelBillSchema>;

export const voidDraftBillSchema = z.object({
  billId: uuidSchema,
  reasonCodeId: uuidSchema,
  reasonText: optionalText,
  idempotencyKey: idempotencyKeySchema,
});
export type VoidDraftBillInput = z.input<typeof voidDraftBillSchema>;

/** Discount and cancellation reports take the common bounded report range (docs/20 §1). */
export const adjustmentReportSchema = reportRangeSchema;

/** What the bill still allows to be credited: patient share − credited so far. */
export const creditableOf = (b: { patientSharePaise: Paise; creditedPaise: Paise }): Paise =>
  b.patientSharePaise - b.creditedPaise;

/**
 * Money that has to go back after crediting `creditPaise`: what was paid beyond the bill's new
 * value. Never negative, never above what was paid (docs/04 §15.8: a refund cannot exceed the
 * amount paid, because the bill's value cannot drop below zero).
 */
export function refundDue(
  b: { patientSharePaise: Paise; creditedPaise: Paise; paidPaise: Paise },
  creditPaise: Paise,
): Paise {
  const due = b.paidPaise - (b.patientSharePaise - b.creditedPaise - creditPaise);
  return due < 0n ? 0n : due;
}

export interface CreditSplit {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
}

/**
 * Splits a credit note into value and tax. The bill's tax not yet credited is taken pro rata to
 * the amount against what is still creditable (CGST = SGST, GST rule of docs/02 §2); the last
 * credit, which takes everything left, takes all the remaining tax so the credit notes add up to
 * the bill exactly. Round-off and odd paise stay in the taxable part, so
 * `amount = taxable + cgst + sgst` always holds.
 */
export function splitCredit(
  bill: {
    cgstPaise: Paise;
    sgstPaise: Paise;
    patientSharePaise: Paise;
    creditedPaise: Paise;
    creditedCgstPaise: Paise;
    creditedSgstPaise: Paise;
  },
  amountPaise: Paise,
): CreditSplit {
  const remaining = creditableOf(bill);
  if (amountPaise <= 0n || amountPaise > remaining) {
    throw new RangeError('Credit must be between 1 paisa and what is still creditable');
  }
  const cgstLeft = bill.cgstPaise - bill.creditedCgstPaise;
  const sgstLeft = bill.sgstPaise - bill.creditedSgstPaise;
  if (amountPaise === remaining) {
    return {
      taxablePaise: amountPaise - cgstLeft - sgstLeft,
      cgstPaise: cgstLeft,
      sgstPaise: sgstLeft,
    };
  }
  let half = divRound(cgstLeft * amountPaise, remaining);
  if (half * 2n > amountPaise) half = amountPaise / 2n; // a fully taxed bill rounds up by a paisa
  return { taxablePaise: amountPaise - 2n * half, cgstPaise: half, sgstPaise: half };
}

/** A refund needs an approver's PIN above the threshold (docs/12 §5: ₹1,000 by default). */
export const needsApprovalAbove = (amountPaise: Paise, thresholdPaise: Paise): boolean =>
  amountPaise > thresholdPaise;
