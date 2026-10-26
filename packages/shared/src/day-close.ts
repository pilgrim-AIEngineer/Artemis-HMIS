/**
 * Day-end close and UPI reconciliation (BIL-06, docs/12 §3 and §6). The pure rules live here —
 * the denomination counter, the variance, which business day a payment belongs to once a day is
 * closed, and the matching of bank-statement UTRs to the UPI receipts — and the db package applies
 * them inside transactions. Money is bigint paise throughout (AGENTS.md rule 1).
 */
import { z } from 'zod';
import { reasonTextSchema } from './billing-adjustments';
import { MONEY_CEILING_PAISE } from './billing';
import { addDays, compareDates, parseIsoDate, toIsoDate } from './dates';
import { cleanRupeeText, rupeesToPaise, sumPaise, type Paise } from './money';
import { idempotencyKeySchema, nonNegativePaiseSchema, uuidSchema } from './primitives';

// ---------------------------------------------------------------- denomination counter

/** Notes counted at the counter, largest first (docs/12 §6). Coins are entered as one amount. */
export const NOTE_DENOMINATIONS = [500, 200, 100, 50, 20, 10] as const;
export type NoteDenomination = (typeof NOTE_DENOMINATIONS)[number];

/** Most notes of one value a drawer can plausibly hold; a typo guard, not a business rule. */
export const MAX_NOTE_COUNT = 100_000;

const noteCount = z.number().int().min(0).max(MAX_NOTE_COUNT);

export const denominationsSchema = z.object({
  n500: noteCount,
  n200: noteCount,
  n100: noteCount,
  n50: noteCount,
  n20: noteCount,
  n10: noteCount,
  /** Total value of all coins (₹1, 2, 5, 10 mixed), in paise. */
  coinsPaise: nonNegativePaiseSchema.refine((p) => p <= MONEY_CEILING_PAISE, 'paise.tooLarge'),
});
export type DenominationsInput = z.input<typeof denominationsSchema>;
export type Denominations = z.output<typeof denominationsSchema>;

export const EMPTY_DENOMINATIONS: Denominations = {
  n500: 0,
  n200: 0,
  n100: 0,
  n50: 0,
  n20: 0,
  n10: 0,
  coinsPaise: 0n,
};

const noteKey = (d: NoteDenomination) => `n${d}` as const;

/** Cash counted: the notes at face value plus the coins. */
export function countedCashPaise(d: Denominations): Paise {
  const notes = NOTE_DENOMINATIONS.map((v) => BigInt(d[noteKey(v)]) * BigInt(v) * 100n);
  return sumPaise(notes) + d.coinsPaise;
}

/** The JSON that is stored with a close (coins as a string: JSON has no bigint). */
export function denominationsToJson(d: Denominations): Record<string, number | string> {
  return {
    n500: d.n500,
    n200: d.n200,
    n100: d.n100,
    n50: d.n50,
    n20: d.n20,
    n10: d.n10,
    coinsPaise: d.coinsPaise.toString(),
  };
}

// ---------------------------------------------------------------- variance

export interface CloseVariance {
  /** Counted − expected: negative = cash short, positive = cash over. */
  differencePaise: Paise;
  reasonRequired: boolean;
}

export function closeVariance(expectedCashPaise: Paise, countedPaise: Paise): CloseVariance {
  const differencePaise = countedPaise - expectedCashPaise;
  return { differencePaise, reasonRequired: differencePaise !== 0n };
}

/** What each mode of payment adds up to; refunds are negative amounts and reduce the total. */
export interface ModeTotals {
  cashPaise: Paise;
  upiPaise: Paise;
  cardPaise: Paise;
  /** Cheque, bank transfer, payer settlement: not counted at the counter. */
  otherPaise: Paise;
}

export const ZERO_MODE_TOTALS: ModeTotals = {
  cashPaise: 0n,
  upiPaise: 0n,
  cardPaise: 0n,
  otherPaise: 0n,
};

export function totalOfModes(t: ModeTotals): Paise {
  return t.cashPaise + t.upiPaise + t.cardPaise + t.otherPaise;
}

export function addModeTotals(a: ModeTotals, b: ModeTotals): ModeTotals {
  return {
    cashPaise: a.cashPaise + b.cashPaise,
    upiPaise: a.upiPaise + b.upiPaise,
    cardPaise: a.cardPaise + b.cardPaise,
    otherPaise: a.otherPaise + b.otherPaise,
  };
}

/** Sums signed payment amounts by mode (a payment of another kind than cash/UPI/card is "other"). */
export function modeTotals(rows: Iterable<{ mode: string; amountPaise: Paise }>): ModeTotals {
  let t = ZERO_MODE_TOTALS;
  for (const r of rows) {
    const add: ModeTotals =
      r.mode === 'cash'
        ? { ...ZERO_MODE_TOTALS, cashPaise: r.amountPaise }
        : r.mode === 'upi'
          ? { ...ZERO_MODE_TOTALS, upiPaise: r.amountPaise }
          : r.mode === 'card'
            ? { ...ZERO_MODE_TOTALS, cardPaise: r.amountPaise }
            : { ...ZERO_MODE_TOTALS, otherPaise: r.amountPaise };
    t = addModeTotals(t, add);
  }
  return t;
}

// ---------------------------------------------------------------- closed periods

/**
 * Business day of a payment taken at `istDate` (docs/12 §6, "payments after close go to the next
 * day"): its own IST day, unless the facility has already been closed up to that day, in which
 * case the day after the last facility close. The db trigger (migration 0019) applies the same
 * rule to every insert; this is the executable specification the tests pin it to.
 */
export function businessDateFor(istDate: string, lastFacilityCloseDate: string | null): string {
  if (lastFacilityCloseDate === null) return istDate;
  const last = parseIsoDate(lastFacilityCloseDate);
  if (compareDates(parseIsoDate(istDate), last) > 0) return istDate;
  return toIsoDate(addDays(last, 1));
}

// ---------------------------------------------------------------- inputs

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date');

/** User close (own counter). `expectedCashPaise` is what the screen showed: see `dayClose.expectedChanged`. */
export const closeOwnDaySchema = z.object({
  denominations: denominationsSchema,
  expectedCashPaise: z.union([z.bigint(), z.string(), z.number()]).transform((v) => BigInt(v)),
  differenceReason: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    reasonTextSchema.optional(),
  ),
  idempotencyKey: idempotencyKeySchema,
});
export type CloseOwnDayInput = z.input<typeof closeOwnDaySchema>;

export const closeFacilityDaySchema = z.object({
  closeDate: isoDate,
  /** The owner closes although some user has not closed their counter; their payments roll over. */
  acknowledgePending: z.boolean().default(false),
  note: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    reasonTextSchema.optional(),
  ),
  idempotencyKey: idempotencyKeySchema,
});
export type CloseFacilityDayInput = z.input<typeof closeFacilityDaySchema>;

export const dayCloseIdSchema = z.object({ dayCloseId: uuidSchema });
export const dayCloseDateSchema = z.object({ date: isoDate });

export const dayCloseListSchema = z.object({
  from: isoDate,
  to: isoDate,
});

// ---------------------------------------------------------------- UPI reconciliation

export const upiStatementLineSchema = z.object({
  utr: z.string().regex(/^[0-9]{6,22}$/, 'validation.utr'),
  /** Signed: money in is positive, a UPI refund paid out is negative. */
  amountPaise: z.union([z.bigint(), z.string(), z.number()]).transform((v) => BigInt(v)),
});
export type UpiStatementLine = z.output<typeof upiStatementLineSchema>;

/** What the reconciliation screen sends when the cashier saves their work. */
export const saveUpiReconciliationSchema = z.object({
  date: isoDate,
  /** Total of the UPI credits for the day according to the bank / UPI app statement. */
  statementTotalPaise: z.union([z.bigint(), z.string(), z.number()]).transform((v) => BigInt(v)),
  /** Payments ticked off as seen on the statement, with the statement's UTR when it was typed. */
  matches: z
    .array(
      z.object({
        paymentId: uuidSchema,
        statementUtr: z.string().regex(/^[0-9]{6,22}$/, 'validation.utr').optional(),
      }),
    )
    .max(2000),
  differenceReason: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    reasonTextSchema.optional(),
  ),
  /** Complete the reconciliation; false = save a draft to continue later. */
  complete: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema,
});
export type SaveUpiReconciliationInput = z.input<typeof saveUpiReconciliationSchema>;

export interface UpiSystemPayment {
  id: string;
  amountPaise: Paise;
  /** Last 4–12 digits of the UTR as the cashier typed them, or null. */
  upiRef: string | null;
}

export interface UpiMatch {
  paymentId: string;
  /** Index into the statement lines. */
  lineIndex: number;
  utr: string;
}

export interface UpiMatchResult {
  matches: UpiMatch[];
  unmatchedPaymentIds: string[];
  unmatchedLineIndexes: number[];
}

/**
 * UTR matching (docs/12 §3): a receipt matches a statement line when the amounts are equal and
 * the statement UTR ends with the digits typed at the counter. A receipt without a reference, or
 * one that fits two statement lines (same amount, same ending), is left for the cashier to tick:
 * the system never guesses between candidates.
 */
export function matchUpiStatement(
  payments: readonly UpiSystemPayment[],
  lines: readonly UpiStatementLine[],
): UpiMatchResult {
  const used = new Set<number>();
  const matches: UpiMatch[] = [];
  const matched = new Set<string>();
  for (const p of payments) {
    if (!p.upiRef) continue;
    const candidates = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => !used.has(i) && l.amountPaise === p.amountPaise && l.utr.endsWith(p.upiRef!));
    if (candidates.length !== 1) continue;
    // Another receipt with the same ending and amount would claim the same line: ambiguous.
    const rivals = payments.filter(
      (q) =>
        q.id !== p.id &&
        q.upiRef &&
        q.amountPaise === p.amountPaise &&
        (candidates[0]!.l.utr.endsWith(q.upiRef) || q.upiRef.endsWith(p.upiRef!)),
    );
    if (rivals.length > 0) continue;
    const { l, i } = candidates[0]!;
    used.add(i);
    matched.add(p.id);
    matches.push({ paymentId: p.id, lineIndex: i, utr: l.utr });
  }
  return {
    matches,
    unmatchedPaymentIds: payments.filter((p) => !matched.has(p.id)).map((p) => p.id),
    unmatchedLineIndexes: lines.map((_, i) => i).filter((i) => !used.has(i)),
  };
}

export interface ParsedStatement {
  lines: UpiStatementLine[];
  /** 1-based line numbers of the text that could not be read. */
  badLines: number[];
}

/**
 * Reads pasted statement lines: one per row, a UTR (6–22 digits) and an amount in rupees,
 * separated by commas, tabs or spaces; any other columns are ignored. A leading `-` or a `Dr`
 * marker makes the amount a debit (negative).
 */
export function parseUpiStatement(text: string): ParsedStatement {
  const lines: UpiStatementLine[] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const row = raw.trim();
    if (row === '') return;
    // "1,250" and "12,50,000" are amounts; a comma after a long digit run separates columns.
    const ungrouped = row.replace(/(?<![\d,])\d{1,3}(?:,\d{2,3})+(?=\D|$)/g, (m) =>
      m.replace(/,/g, ''),
    );
    const tokens = ungrouped.split(/[\s,;|]+/).filter(Boolean);
    const utr = tokens.find((t) => /^\d{6,22}$/.test(t) && !t.includes('.'));
    const debit = tokens.some((t) => /^(dr|debit)$/i.test(t));
    const amountToken = [...tokens]
      .reverse()
      .find((t) => t !== utr && /^[-−]?[₹]?\d[\d,]*(\.\d{1,2})?$/.test(t));
    if (!utr || !amountToken) {
      badLines.push(idx + 1);
      return;
    }
    const negative = amountToken.startsWith('-') || amountToken.startsWith('−') || debit;
    const clean = cleanRupeeText(amountToken.replace(/^[-−]/, ''));
    if (clean === null || clean === '') {
      badLines.push(idx + 1);
      return;
    }
    const paise = rupeesToPaise(clean);
    lines.push({ utr, amountPaise: negative ? -paise : paise });
  });
  return { lines, badLines };
}

/** System UPI total vs the statement total entered by the cashier (docs/12 §3). */
export function upiDifference(systemPaise: Paise, statementPaise: Paise): Paise {
  return statementPaise - systemPaise;
}

export const DAY_CLOSE_KINDS = ['user', 'facility'] as const;
export type DayCloseKind = (typeof DAY_CLOSE_KINDS)[number];

export const UPI_RECON_STATUSES = ['open', 'reconciled'] as const;
export type UpiReconStatus = (typeof UPI_RECON_STATUSES)[number];
