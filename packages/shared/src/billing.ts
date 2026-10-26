/**
 * OPD billing and payments domain (BIL-01, BIL-02, docs/12 §2–3, docs/04 §6 and §15). Enums
 * back the DB CHECK constraints; the pure functions here (totals, tender validation, UPI
 * reference rule, change to return) are what the db package applies inside transactions.
 * Money is bigint paise throughout (AGENTS.md rule 1).
 */
import { z } from 'zod';
import { noForbiddenTerms } from './compliance/forbidden-terms';
import { computeBill, type BillTotals, type GstLineInput } from './gst';
import { quantityToMilli, sumPaise, type Paise } from './money';
import {
  idempotencyKeySchema,
  positivePaiseSchema,
  quantitySchema,
  uuidSchema,
} from './primitives';
import type { SettingValue } from './settings';

export const BILL_KINDS = ['opd', 'ipd_interim', 'ipd_final', 'pharmacy', 'daycare'] as const;
export type BillKind = (typeof BILL_KINDS)[number];

export const BILL_STATUSES = ['draft', 'final', 'cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_LINE_SOURCES = [
  'service',
  'package',
  'pharmacy_sale_item',
  'bed_charge',
  'consumable',
  'implant',
] as const;
export type BillLineSource = (typeof BILL_LINE_SOURCES)[number];

export const PAYMENT_KINDS = [
  'payment',
  'deposit',
  'refund',
  'deposit_adjustment',
  'advance',
] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_MODES = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'payer_settlement',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Modes the counter offers in Phase 1 (docs/12 §3); card is optional hardware (Q12). */
export const COUNTER_PAYMENT_MODES = ['cash', 'upi', 'card'] as const;
export type CounterPaymentMode = (typeof COUNTER_PAYMENT_MODES)[number];

export const PAYMENT_STATUSES = ['valid', 'reversed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** D-6 (b): hard per-row ceiling of every money column, ₹1,000 crore in paise. */
export const MONEY_CEILING_PAISE = 1_000_000_000_000n;

/** OPD bill lines carry at most this many units (a typo guard; numeric(12,3) allows far more). */
export const MAX_LINE_QTY = '999';

// ---------------------------------------------------------------- inputs

const amountSchema = positivePaiseSchema.refine((p) => p <= MONEY_CEILING_PAISE, {
  message: 'paise.tooLarge',
});

/** Last 4–12 digits of the UPI transaction reference (UTR is 12 digits; staff often type 4–6). */
export const upiRefSchema = z
  .string()
  .trim()
  .regex(/^\d{4,12}$/, 'billing.upiRefInvalid');

export const cardLast4Schema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, 'billing.cardLast4Invalid');

const optional = <T extends z.ZodType>(s: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s.optional());

export const tenderSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('cash'), amountPaise: amountSchema }),
  z.object({
    mode: z.literal('upi'),
    amountPaise: amountSchema,
    upiRef: optional(upiRefSchema),
    upiPayerName: optional(
      z
        .string()
        .trim()
        .max(80)
        .refine(...noForbiddenTerms('always')),
    ),
  }),
  z.object({
    mode: z.literal('card'),
    amountPaise: amountSchema,
    cardLast4: optional(cardLast4Schema),
    cardAuthCode: optional(z.string().trim().max(20)),
  }),
]);
export type TenderInput = z.input<typeof tenderSchema>;
export type Tender = z.output<typeof tenderSchema>;

export const collectPaymentSchema = z.object({
  billId: uuidSchema,
  /** One entry per mode; two or three entries = a split payment (docs/12 §3). */
  tenders: z
    .array(tenderSchema)
    .min(1)
    .max(COUNTER_PAYMENT_MODES.length)
    .refine((ts) => new Set(ts.map((t) => t.mode)).size === ts.length, 'billing.duplicateMode'),
  idempotencyKey: idempotencyKeySchema,
});
export type CollectPaymentInput = z.input<typeof collectPaymentSchema>;

export const createOpdBillSchema = z.object({
  encounterId: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type CreateOpdBillInput = z.input<typeof createOpdBillSchema>;

export const addBillLineSchema = z.object({
  billId: uuidSchema,
  serviceId: uuidSchema,
  qty: quantitySchema
    .refine((q) => quantityToMilli(q) <= quantityToMilli(MAX_LINE_QTY), 'quantity.tooLarge')
    .default('1'),
  idempotencyKey: idempotencyKeySchema,
});
export type AddBillLineInput = z.input<typeof addBillLineSchema>;

export const removeBillLineSchema = z.object({
  billId: uuidSchema,
  lineId: uuidSchema,
  reason: optional(
    z
      .string()
      .trim()
      .min(3, 'validation.reason')
      .max(200)
      .refine(...noForbiddenTerms('always')),
  ),
  idempotencyKey: idempotencyKeySchema,
});
export type RemoveBillLineInput = z.input<typeof removeBillLineSchema>;

/** OPD-04: put orders from Rx transcription on the draft bill (docs/12 §2). */
export const addOrdersToBillSchema = z.object({
  billId: uuidSchema,
  orderIds: z
    .array(uuidSchema)
    .min(1)
    .max(40)
    .refine((a) => new Set(a).size === a.length, 'validation.invalid'),
  idempotencyKey: idempotencyKeySchema,
});
export type AddOrdersToBillInput = z.input<typeof addOrdersToBillSchema>;

export const finalizeBillSchema = z.object({
  billId: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type FinalizeBillInput = z.input<typeof finalizeBillSchema>;

export const billIdSchema = z.object({ billId: uuidSchema });

export const pendingBillsSchema = z.object({
  q: z.string().trim().max(60).optional(),
});

// ---------------------------------------------------------------- totals

/** A stored bill line as the totals need it. */
export interface StoredLine {
  unitRatePaise: Paise;
  /** `numeric(12,3)` text, e.g. `"1.000"`. */
  qty: string;
  discountPaise: Paise;
  gstRateBp: number;
  isExempt: boolean;
  sacHsn: string | null;
}

export const toGstInput = (l: StoredLine): GstLineInput => ({
  ratePaise: l.unitRatePaise,
  qtyMilli: quantityToMilli(l.qty),
  discountPaise: l.discountPaise,
  gstRateBp: l.gstRateBp,
  isExempt: l.isExempt,
  hsnSac: l.sacHsn,
});

/** Bill header totals from its active lines (docs/04 §15.1). Phase 1: patient pays everything. */
export interface BillHeaderTotals {
  grossPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  roundOffPaise: Paise;
  netPaise: Paise;
  payerSharePaise: Paise;
  patientSharePaise: Paise;
}

export function billHeaderTotals(
  lines: readonly StoredLine[],
  opts: { roundToRupee: boolean },
): BillHeaderTotals & { computed: BillTotals } {
  const computed = computeBill(lines.map(toGstInput), { roundToRupee: opts.roundToRupee });
  return {
    computed,
    grossPaise: computed.grossPaise,
    discountPaise: computed.discountPaise,
    taxablePaise: computed.taxablePaise,
    cgstPaise: computed.cgstPaise,
    sgstPaise: computed.sgstPaise,
    roundOffPaise: computed.roundOffPaise,
    netPaise: computed.netPaise,
    payerSharePaise: 0n,
    patientSharePaise: computed.netPaise,
  };
}

/** docs/04 §15.1, as the DB CHECK states it. */
export function billInvariantHolds(b: BillHeaderTotals): boolean {
  return (
    b.netPaise === b.grossPaise - b.discountPaise + b.cgstPaise + b.sgstPaise + b.roundOffPaise &&
    b.payerSharePaise + b.patientSharePaise === b.netPaise &&
    b.taxablePaise === b.grossPaise - b.discountPaise
  );
}

// ---------------------------------------------------------------- payments

export type TenderErrorKey =
  'billing.nothingDue' | 'billing.overpayment' | 'billing.upiRefRequired';

/**
 * Checks a collection against what is due: the tenders must add up to more than zero and never
 * exceed the balance (no overpayment, docs/12 §9: change is handed back in cash, not recorded),
 * and a UPI tender above the configured amount needs its reference. Returns the total.
 */
export function checkTenders(
  balancePaise: Paise,
  tenders: readonly Tender[],
  upiRule: SettingValue<'billing.upiRefRequired'>,
): { ok: true; totalPaise: Paise } | { ok: false; error: TenderErrorKey } {
  if (balancePaise <= 0n) return { ok: false, error: 'billing.nothingDue' };
  const total = sumPaise(tenders.map((t) => t.amountPaise));
  if (total > balancePaise) return { ok: false, error: 'billing.overpayment' };
  for (const t of tenders) {
    if (t.mode === 'upi' && upiRefNeeded(upiRule, t.amountPaise) && !t.upiRef) {
      return { ok: false, error: 'billing.upiRefRequired' };
    }
  }
  return { ok: true, totalPaise: total };
}

/** Setting `billing.upiRefRequired`: `off`, `optional` (default) or `required_above_amount`. */
export function upiRefNeeded(
  rule: SettingValue<'billing.upiRefRequired'>,
  amountPaise: Paise,
): boolean {
  return rule.mode === 'required_above_amount' && amountPaise > BigInt(rule.abovePaise);
}

/** Cash handed back: tendered − cash part of the payment; null while too little is tendered. */
export function cashChange(tenderedPaise: Paise, cashDuePaise: Paise): Paise | null {
  if (tenderedPaise < cashDuePaise) return null;
  return tenderedPaise - cashDuePaise;
}

/** Shown on receipts and the payment list: never more than the last digits of a UTR. */
export function maskRef(ref: string | null | undefined, keep = 4): string | null {
  if (!ref) return null;
  return ref.length <= keep ? ref : `…${ref.slice(-keep)}`;
}
